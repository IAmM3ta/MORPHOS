"""
Generative Compression Codec — RedBot / IMAGE_8 workflow

Conceptual pipeline:
  Image -> VAE encode (high-dim latent) -> learned extreme compression (tiny vector)
       -> transmit compact code -> learned decompress to VAE-shaped latent
       -> diffusion decoder (prompt-guided) -> reconstructed image

This module is a research/demo scaffold. The Linear "compression" / "decompression"
networks are UNTRAINED placeholders. A production system would train them
end-to-end (or replace with a learned codec) against a reconstruction + rate loss.

Rate note (illustrative FP32, no entropy coding):
  VAE flat latent 16384 floats ≈ 64 KiB; default compact code 256 floats ≈ 1 KiB.
  That is ~0.031 bpp at 512² RGB before generative decode — not a trained RD curve.
  See also quantize_uniform / straight_through_quantize / quantized_rate_stats,
  FactorizedEntropyModel, CategoricalEntropyModel, LearnedQuantAffine,
  tabled rANS (`ans_encode_indices` / `ans_decode_indices`),
  self-describing ANS packs (`ans_pack_indices` / `ans_unpack_indices`), and
  docs/ENTROPY-CODING-NOTES.md.
"""

from __future__ import annotations

import argparse
import math
from io import BytesIO
from typing import Optional, Union

import numpy as np
import requests
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image
from torchvision import transforms


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_rgb_image(source: Union[str, Image.Image], size: int = 512) -> Image.Image:
    """Load an RGB image from a local path, URL, or PIL Image; resize to square."""
    if isinstance(source, Image.Image):
        img = source
    elif source.startswith("http://") or source.startswith("https://"):
        resp = requests.get(source, timeout=30)
        resp.raise_for_status()
        img = Image.open(BytesIO(resp.content))
    else:
        img = Image.open(source)
    return img.convert("RGB").resize((size, size), Image.Resampling.LANCZOS)


def make_fallback_image(size: int = 512) -> Image.Image:
    """Synthetic flower-like blob when no sample image is available."""
    img = Image.new("RGB", (size, size), (255, 200, 200))
    from PIL import ImageDraw

    draw = ImageDraw.Draw(img)
    draw.ellipse((size // 5, size // 5, 4 * size // 5, 4 * size // 5), fill=(100, 255, 100), outline=(0, 0, 0))
    return img


def preprocess_for_vae(image: Image.Image, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
    """
    Map PIL RGB [0,255] -> NCHW float in [-1, 1], batch dim 1.
    Stable Diffusion VAE expects this range (not a nonexistent vae.preprocess).
    """
    to_tensor = transforms.Compose(
        [
            transforms.ToTensor(),  # [0, 1]
            transforms.Normalize([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]),  # [-1, 1]
        ]
    )
    tensor = to_tensor(image).unsqueeze(0).to(device=device, dtype=dtype)
    return tensor


def rate_stats(
    compact_dim: int = 256,
    image_side: int = 512,
    bytes_per_float: int = 4,
) -> dict:
    """
    Illustrative transmission accounting for the mock compact vector (FP32, no entropy).

    Returns byte counts and bits-per-pixel relative to an RGB square of `image_side`.
    Not a trained rate–distortion operating point — shape/demo only.
    """
    flat_dim = GenerativeCompressionCodec.FLAT_DIM
    full_bytes = flat_dim * bytes_per_float
    compact_bytes = compact_dim * bytes_per_float
    pixels = image_side * image_side
    bpp = (compact_bytes * 8) / float(pixels)
    return {
        "flat_dim": flat_dim,
        "compact_dim": compact_dim,
        "full_latent_bytes": full_bytes,
        "compact_code_bytes": compact_bytes,
        "image_side": image_side,
        "bits_per_pixel": bpp,
        "compression_ratio_vs_flat": full_bytes / float(compact_bytes) if compact_bytes else float("inf"),
    }


def quantize_uniform(
    code: torch.Tensor,
    levels: int = 256,
    *,
    code_min: Optional[float] = None,
    code_max: Optional[float] = None,
) -> tuple[torch.Tensor, dict]:
    """
    Uniform scalar quantization sketch for compact codes (no entropy coder).

    Maps each float into one of `levels` bins over [lo, hi] (explicit bounds or
    data min/max), then dequantizes to bin centers. Returns (dequantized, meta).
    `meta["indices"]` holds integer bin ids in `[0, levels-1]` (same shape as
    `code`) for discrete / categorical rate terms. See
    docs/ENTROPY-CODING-NOTES.md for the FP32 → discrete → ANS ladder.
    """
    if levels < 2:
        raise ValueError("levels must be >= 2")
    x = code.float()
    lo = float(x.min()) if code_min is None else float(code_min)
    hi = float(x.max()) if code_max is None else float(code_max)
    if hi <= lo:
        # Degenerate range: emit mid-level constant; index 0
        mid = torch.full_like(x, lo)
        indices = torch.zeros_like(x, dtype=torch.long)
        meta = {
            "levels": levels,
            "code_min": lo,
            "code_max": hi,
            "bits_per_symbol": math.log2(levels),
            "degenerate_range": True,
            "indices": indices,
        }
        return mid, meta
    # Map to [0, levels-1], round, clamp, then back to [lo, hi]
    scaled = (x - lo) / (hi - lo) * (levels - 1)
    indices = scaled.round().clamp(0, levels - 1)
    dequant = lo + indices / (levels - 1) * (hi - lo)
    meta = {
        "levels": levels,
        "code_min": lo,
        "code_max": hi,
        "bits_per_symbol": math.log2(levels),
        "degenerate_range": False,
        "indices": indices.long(),
    }
    return dequant, meta


def quantized_rate_stats(
    compact_dim: int = 256,
    levels: int = 256,
    image_side: int = 512,
) -> dict:
    """
    Illustrative rate if each compact symbol costs exactly log2(levels) bits.

    Uniform codebook bound — still not ANS / learned entropy. Compare to
    rate_stats() FP32 accounting; see docs/ENTROPY-CODING-NOTES.md.
    """
    if levels < 2:
        raise ValueError("levels must be >= 2")
    bits_per_symbol = math.log2(levels)
    total_bits = compact_dim * bits_per_symbol
    pixels = image_side * image_side
    bpp = total_bits / float(pixels)
    fp32 = rate_stats(compact_dim=compact_dim, image_side=image_side)
    return {
        "compact_dim": compact_dim,
        "levels": levels,
        "bits_per_symbol": bits_per_symbol,
        "total_bits": total_bits,
        "coded_bytes_uniform": total_bits / 8.0,
        "image_side": image_side,
        "bits_per_pixel": bpp,
        "fp32_bits_per_pixel": fp32["bits_per_pixel"],
        "ratio_vs_fp32": fp32["bits_per_pixel"] / bpp if bpp else float("inf"),
    }


def straight_through_quantize(
    code: torch.Tensor,
    levels: int = 256,
    *,
    code_min: Optional[float] = None,
    code_max: Optional[float] = None,
) -> tuple[torch.Tensor, dict]:
    """
    Uniform hard quantize in forward; identity STE so gradients flow to `code`.

    Forward matches `quantize_uniform` bin centers. Backward treats the op as
    identity: `code + (q - code).detach()`. Used by the bottleneck train sketch
    (`--ste-quant`) so compressor MLPs still train through a discrete bottleneck.
    See docs/ENTROPY-CODING-NOTES.md.
    """
    q, meta = quantize_uniform(code, levels=levels, code_min=code_min, code_max=code_max)
    # Ensure q is on same dtype/device; STE identity
    ste = code + (q.to(dtype=code.dtype, device=code.device) - code).detach()
    meta = dict(meta)
    meta["ste"] = True
    return ste, meta


class FactorizedEntropyModel(nn.Module):
    """
    Fully factorized Laplace prior over compact codes (Ballé-style sketch).

    Independent loc / scale per dimension. Differentiable rate:
      R = E[ sum_i -log2 Laplace(z_i; μ_i, b_i) ] / image_side²  (bpp)

    Not ANS — expected codelength under this prior. Train jointly with the
    bottleneck so the prior tracks the code distribution. See
    docs/ENTROPY-CODING-NOTES.md.
    """

    def __init__(self, compact_dim: int):
        super().__init__()
        if compact_dim < 1:
            raise ValueError("compact_dim must be >= 1")
        self.compact_dim = compact_dim
        self.loc = nn.Parameter(torch.zeros(compact_dim))
        self.log_scale = nn.Parameter(torch.zeros(compact_dim))

    def scale(self) -> torch.Tensor:
        """Positive scale b = softplus(log_scale) + eps."""
        return F.softplus(self.log_scale) + 1e-6

    def nll_bits(self, code: torch.Tensor) -> torch.Tensor:
        """Per-element -log2 p(code); broadcasts loc/scale over leading dims."""
        if code.shape[-1] != self.compact_dim:
            raise ValueError(
                f"code last dim {code.shape[-1]} != compact_dim {self.compact_dim}"
            )
        loc = self.loc.to(device=code.device, dtype=code.dtype)
        scale = self.scale().to(device=code.device, dtype=code.dtype)
        # Laplace: -log2 p(x) = log2(2b) + |x-μ| / (b ln 2)
        ln2 = math.log(2.0)
        return torch.log2(2.0 * scale) + (code - loc).abs() / (scale * ln2)

    def total_bits(self, code: torch.Tensor) -> torch.Tensor:
        """Mean over batch of summed per-dim NLL bits. Accepts (D,) or (B, D)."""
        nll = self.nll_bits(code)
        if nll.ndim == 1:
            return nll.sum()
        return nll.reshape(nll.shape[0], -1).sum(dim=-1).mean()

    def rate_bpp(self, code: torch.Tensor, image_side: int = 512) -> torch.Tensor:
        """Expected bits-per-pixel under this prior for an RGB square."""
        pixels = float(image_side * image_side)
        return self.total_bits(code) / pixels


def factorized_rate_stats(
    compact_dim: int = 256,
    image_side: int = 512,
    *,
    mean_bits_per_dim: Optional[float] = None,
) -> dict:
    """
    Illustrative bpp if each compact dim costs `mean_bits_per_dim` under a
    factorized Laplace prior.

    Default mean_bits_per_dim is the untrained-init mode cost
    (-log2 Laplace at x=μ with b=softplus(0)+eps) — not a measured bitstream.
    Compare to rate_stats / quantized_rate_stats; see ENTROPY-CODING-NOTES.
    """
    if mean_bits_per_dim is None:
        b = math.log1p(math.e) + 1e-6  # softplus(0) + eps
        mean_bits_per_dim = math.log2(2.0 * b)
    total_bits = compact_dim * float(mean_bits_per_dim)
    pixels = image_side * image_side
    bpp = total_bits / float(pixels)
    fp32 = rate_stats(compact_dim=compact_dim, image_side=image_side)
    uni = quantized_rate_stats(compact_dim=compact_dim, levels=256, image_side=image_side)
    return {
        "compact_dim": compact_dim,
        "mean_bits_per_dim": float(mean_bits_per_dim),
        "total_bits": total_bits,
        "image_side": image_side,
        "bits_per_pixel": bpp,
        "fp32_bits_per_pixel": fp32["bits_per_pixel"],
        "uniform8_bits_per_pixel": uni["bits_per_pixel"],
        "note": "expected -log2 p under factorized Laplace sketch; not ANS",
    }


class CategoricalEntropyModel(nn.Module):
    """
    Fully factorized categorical prior over discrete STE bin indices.

    Learnable logits shaped `(compact_dim, levels)` → per-dimension Categorical.
    Differentiable rate (w.r.t. logits; indices are hard STE symbols):

      R = E[ sum_i -log2 Categorical(logits_i)[index_i] ] / image_side²  (bpp)

    Closer to a real alphabet than a continuous Laplace-on-floats prior. Still
    not ANS — expected codelength under this discrete prior. Train jointly with
    the bottleneck (and optional LearnedQuantAffine). See
    docs/ENTROPY-CODING-NOTES.md.
    """

    def __init__(self, compact_dim: int, levels: int = 256):
        super().__init__()
        if compact_dim < 1:
            raise ValueError("compact_dim must be >= 1")
        if levels < 2:
            raise ValueError("levels must be >= 2")
        self.compact_dim = compact_dim
        self.levels = levels
        # Untrained init ≈ uniform over L symbols → log2(L) bits/dim
        self.logits = nn.Parameter(torch.zeros(compact_dim, levels))

    def log_probs(self) -> torch.Tensor:
        """Per-dim log-softmax over the categorical alphabet: (D, L)."""
        return F.log_softmax(self.logits, dim=-1)

    def nll_bits(self, indices: torch.Tensor) -> torch.Tensor:
        """
        Per-element -log2 p(index); `indices` long tensor shaped (..., D).

        Gradients flow to `logits` only (hard indices are discrete symbols).
        """
        if indices.shape[-1] != self.compact_dim:
            raise ValueError(
                f"indices last dim {indices.shape[-1]} != compact_dim {self.compact_dim}"
            )
        idx = indices.long()
        # Clamp defensively so a bad STE path cannot index OOB
        idx = idx.clamp(0, self.levels - 1)
        log_p = self.log_probs().to(device=idx.device, dtype=torch.float32)  # (D, L)
        # Gather log-prob of the chosen symbol per dim
        # Expand log_p over batch dims: (..., D, L)
        expand_shape = idx.shape + (self.levels,)
        log_p_exp = log_p.expand(expand_shape[:-2] + log_p.shape) if idx.ndim > 1 else log_p
        if idx.ndim == 1:
            chosen = log_p[torch.arange(self.compact_dim, device=idx.device), idx]
        else:
            # idx (B, D) → gather along last dim of log_p_exp (B, D, L)
            chosen = torch.gather(log_p_exp, dim=-1, index=idx.unsqueeze(-1)).squeeze(-1)
        ln2 = math.log(2.0)
        return -chosen / ln2

    def total_bits(self, indices: torch.Tensor) -> torch.Tensor:
        """Mean over batch of summed per-dim NLL bits. Accepts (D,) or (B, D)."""
        nll = self.nll_bits(indices)
        if nll.ndim == 1:
            return nll.sum()
        return nll.reshape(nll.shape[0], -1).sum(dim=-1).mean()

    def rate_bpp(self, indices: torch.Tensor, image_side: int = 512) -> torch.Tensor:
        """Expected bits-per-pixel under this categorical prior for an RGB square."""
        pixels = float(image_side * image_side)
        return self.total_bits(indices) / pixels


def categorical_rate_stats(
    compact_dim: int = 256,
    levels: int = 256,
    image_side: int = 512,
    *,
    mean_bits_per_dim: Optional[float] = None,
) -> dict:
    """
    Illustrative bpp if each compact dim costs `mean_bits_per_dim` under a
    factorized categorical prior over `levels` symbols.

    Default is the untrained-init uniform cost `log2(levels)` — matches
    `quantized_rate_stats` when the prior is flat. A peaked prior goes lower.
    Compare to rate_stats / factorized_rate_stats; see ENTROPY-CODING-NOTES.
    """
    if levels < 2:
        raise ValueError("levels must be >= 2")
    if mean_bits_per_dim is None:
        mean_bits_per_dim = math.log2(levels)
    total_bits = compact_dim * float(mean_bits_per_dim)
    pixels = image_side * image_side
    bpp = total_bits / float(pixels)
    fp32 = rate_stats(compact_dim=compact_dim, image_side=image_side)
    uni = quantized_rate_stats(compact_dim=compact_dim, levels=levels, image_side=image_side)
    return {
        "compact_dim": compact_dim,
        "levels": levels,
        "mean_bits_per_dim": float(mean_bits_per_dim),
        "total_bits": total_bits,
        "image_side": image_side,
        "bits_per_pixel": bpp,
        "fp32_bits_per_pixel": fp32["bits_per_pixel"],
        "uniform_bits_per_pixel": uni["bits_per_pixel"],
        "note": "expected -log2 p under factorized categorical sketch; not ANS",
    }



# ---------------------------------------------------------------------------
# Tabled rANS (Asymmetric Numeral Systems) — categorical STE indices
# ---------------------------------------------------------------------------
# Byte-oriented rANS following Fabian Giesen's ryg_rans (rans_byte.h) semantics:
# encode symbols last→first; bitstream is LE 4-byte state + renorm bytes.

ANS_SCALE_BITS = 12  # frequency table mass M = 2^scale_bits
ANS_L = 1 << 23  # RANS_BYTE_L — lower bound of the normalization interval


def _pmf_to_freqs(pmf: torch.Tensor, scale_bits: int = ANS_SCALE_BITS) -> torch.Tensor:
    """
    Map a probability simplex (..., L) to integer frequencies summing to M=2^scale_bits.

    Guarantees every symbol with pmf > 0 gets at least frequency 1 when possible;
    zeros stay zero. Rounding residue is absorbed into the largest-mass bin.
    """
    if scale_bits < 4 or scale_bits > 16:
        raise ValueError("scale_bits must be in [4, 16]")
    M = 1 << scale_bits
    p = pmf.float().clamp(min=0.0)
    s = p.sum(dim=-1, keepdim=True).clamp(min=1e-12)
    p = p / s
    raw = p * float(M)
    freqs = raw.floor().to(torch.long)
    positive = p > 0
    freqs = torch.where(positive & (freqs == 0), torch.ones_like(freqs), freqs)
    total = freqs.sum(dim=-1, keepdim=True)
    diff = M - total.squeeze(-1)
    L = freqs.shape[-1]
    freqs_flat = freqs.reshape(-1, L)
    diff_flat = diff.reshape(-1)
    raw_flat = raw.reshape(-1, L)
    pos_flat = positive.reshape(-1, L)
    for i in range(freqs_flat.shape[0]):
        d = int(diff_flat[i].item())
        if d == 0:
            continue
        order = torch.argsort(raw_flat[i], descending=True)
        if d > 0:
            j = int(order[0].item())
            freqs_flat[i, j] = freqs_flat[i, j] + d
        else:
            remain = -d
            for j in order.tolist():
                if remain <= 0:
                    break
                cur = int(freqs_flat[i, j].item())
                min_keep = 1 if bool(pos_flat[i, j]) else 0
                take = min(remain, max(0, cur - min_keep))
                freqs_flat[i, j] = cur - take
                remain -= take
            if remain > 0:
                for j in order.tolist():
                    if remain <= 0:
                        break
                    cur = int(freqs_flat[i, j].item())
                    take = min(remain, cur)
                    freqs_flat[i, j] = cur - take
                    remain -= take
    freqs = freqs_flat.reshape(freqs.shape)
    sums = freqs.sum(dim=-1)
    if int(sums.min()) != M or int(sums.max()) != M:
        raise RuntimeError("frequency table failed to sum to M")
    return freqs


def freqs_to_cdf(freqs: torch.Tensor) -> torch.Tensor:
    """Exclusive prefix sums; shape (..., L+1) with cdf[..., 0]=0, cdf[..., -1]=M."""
    zeros = torch.zeros(*freqs.shape[:-1], 1, dtype=freqs.dtype, device=freqs.device)
    return torch.cat([zeros, freqs.cumsum(dim=-1)], dim=-1)


def ans_encode_symbols(
    symbols: list[int],
    freqs_rows: list[list[int]],
    *,
    scale_bits: int = ANS_SCALE_BITS,
) -> bytes:
    """
    Byte-oriented tabled rANS encode (last symbol encoded first).

    `symbols[i]` is drawn under frequency row `freqs_rows[i]` (length L, sum M).
    Returns a bitstream whose length approximates sum_i -log2(freq[s]/M),
    plus a fixed 4-byte state flush.
    """
    M = 1 << scale_bits
    if len(symbols) != len(freqs_rows):
        raise ValueError("symbols and freqs_rows length mismatch")
    renorm: list[int] = []
    state = ANS_L
    for i in range(len(symbols) - 1, -1, -1):
        s = int(symbols[i])
        freqs = freqs_rows[i]
        if s < 0 or s >= len(freqs):
            raise ValueError(f"symbol {s} out of range at position {i}")
        freq = int(freqs[s])
        if freq <= 0:
            raise ValueError(f"symbol {s} has zero frequency at position {i}")
        start = 0
        for j in range(s):
            start += int(freqs[j])
        # ryg_rans: x_max = ((L >> scale_bits) << 8) * freq
        x_max = ((ANS_L >> scale_bits) << 8) * freq
        while state >= x_max:
            renorm.append(state & 0xFF)
            state >>= 8
        state = ((state // freq) << scale_bits) + (state % freq) + start
    # LE 4-byte state + renorm bytes in reverse flush order (decode-forward)
    return int(state).to_bytes(4, "little") + bytes(reversed(renorm))


def ans_decode_symbols(
    payload: bytes,
    freqs_rows: list[list[int]],
    *,
    scale_bits: int = ANS_SCALE_BITS,
) -> list[int]:
    """Inverse of `ans_encode_symbols` for the same frequency schedule."""
    M = 1 << scale_bits
    mask = M - 1
    if len(payload) < 4:
        raise ValueError("ANS payload too short")
    state = int.from_bytes(payload[0:4], "little")
    pos = 4
    symbols: list[int] = []
    for i, freqs in enumerate(freqs_rows):
        if sum(int(f) for f in freqs) != M:
            raise ValueError(f"freq row {i} does not sum to M")
        cf = state & mask
        acc = 0
        s = start = freq = None
        for j, f in enumerate(freqs):
            f = int(f)
            if acc <= cf < acc + f:
                s, start, freq = j, acc, f
                break
            acc += f
        if s is None:
            raise ValueError(f"slot {cf} outside cdf at position {i}")
        state = freq * (state >> scale_bits) + (state & mask) - start
        while state < ANS_L:
            if pos >= len(payload):
                raise ValueError("ANS stream underrun")
            state = (state << 8) | payload[pos]
            pos += 1
        symbols.append(s)
    if pos != len(payload):
        raise ValueError(f"ANS trailing bytes unread ({len(payload) - pos})")
    return symbols


def categorical_pmfs(model: "CategoricalEntropyModel") -> torch.Tensor:
    """Softmax PMFs from a CategoricalEntropyModel: (D, L)."""
    return torch.softmax(model.logits.detach().float(), dim=-1)


def ans_encode_indices(
    indices: torch.Tensor,
    model: "CategoricalEntropyModel",
    *,
    scale_bits: int = ANS_SCALE_BITS,
) -> tuple[bytes, dict]:
    """
    Encode a single compact-code index vector under the model's factorized prior.

    `indices` shaped (D,) long. Builds per-dim frequency tables from the
    categorical PMFs, then tabled rANS. Returns (payload, meta) where meta
    includes expected NLL bits and measured bitstream bits.
    """
    if indices.ndim != 1:
        raise ValueError("ans_encode_indices expects a 1-D index vector (D,)")
    if indices.shape[0] != model.compact_dim:
        raise ValueError(
            f"indices length {indices.shape[0]} != compact_dim {model.compact_dim}"
        )
    pmf = categorical_pmfs(model)  # (D, L)
    freqs = _pmf_to_freqs(pmf, scale_bits=scale_bits)  # (D, L)
    idx = indices.long().clamp(0, model.levels - 1).tolist()
    freqs_rows = [[int(x) for x in row] for row in freqs.tolist()]
    payload = ans_encode_symbols(idx, freqs_rows, scale_bits=scale_bits)
    with torch.no_grad():
        expected_bits = float(model.total_bits(indices.long()).cpu())
    measured_bits = len(payload) * 8.0
    meta = {
        "scale_bits": scale_bits,
        "compact_dim": model.compact_dim,
        "levels": model.levels,
        "payload_bytes": len(payload),
        "measured_bits": measured_bits,
        "expected_nll_bits": expected_bits,
        "overhead_bits": measured_bits - expected_bits,
        "note": "tabled rANS (ryg_rans byte) over factorized categorical PMFs",
    }
    return payload, meta


def ans_decode_indices(
    payload: bytes,
    model: "CategoricalEntropyModel",
    *,
    scale_bits: int = ANS_SCALE_BITS,
) -> torch.Tensor:
    """Decode payload produced by `ans_encode_indices` with the same model PMFs."""
    pmf = categorical_pmfs(model)
    freqs = _pmf_to_freqs(pmf, scale_bits=scale_bits)
    freqs_rows = [[int(x) for x in row] for row in freqs.tolist()]
    symbols = ans_decode_symbols(payload, freqs_rows, scale_bits=scale_bits)
    if len(symbols) != model.compact_dim:
        raise ValueError(
            f"decoded length {len(symbols)} != compact_dim {model.compact_dim}"
        )
    return torch.tensor(symbols, dtype=torch.long)


def ans_bitstream_stats(
    compact_dim: int = 256,
    levels: int = 256,
    image_side: int = 512,
    *,
    measured_bits: Optional[float] = None,
    expected_nll_bits: Optional[float] = None,
) -> dict:
    """
    Illustrative bpp for an ANS payload vs categorical NLL.

    When measured/expected are omitted, reports the uniform-init categorical
    expected cost (same as categorical_rate_stats) and notes that measured
    bitstream length is only available after `ans_encode_indices`.
    """
    cat = categorical_rate_stats(
        compact_dim=compact_dim, levels=levels, image_side=image_side
    )
    pixels = float(image_side * image_side)
    if expected_nll_bits is None:
        expected_nll_bits = float(cat["total_bits"])
    expected_bpp = expected_nll_bits / pixels
    out = {
        "compact_dim": compact_dim,
        "levels": levels,
        "image_side": image_side,
        "expected_nll_bits": expected_nll_bits,
        "expected_bits_per_pixel": expected_bpp,
        "fp32_bits_per_pixel": cat["fp32_bits_per_pixel"],
        "uniform_bits_per_pixel": cat["uniform_bits_per_pixel"],
        "note": "ANS measured bits fill in after ans_encode_indices; expected is -log2 p",
    }
    if measured_bits is not None:
        out["measured_bits"] = float(measured_bits)
        out["measured_bits_per_pixel"] = float(measured_bits) / pixels
        out["overhead_bits"] = float(measured_bits) - expected_nll_bits
    return out



# ---------------------------------------------------------------------------
# Self-describing ANS pack (freq side-info + rANS payload)
# ---------------------------------------------------------------------------
# Wire format v1 (little-endian):
#   magic[4]="MRPH" | version u8=1 | scale_bits u8
#   compact_dim u16 | levels u16 | sideinfo_mode u8
#     0 = shared freqs (one row, identical across dims)
#     1 = per-dim freqs (D rows)
#   freqs: (1 or D) × L × u16
#   payload_len u32 | payload bytes
#
# Decode needs only the pack — not a live CategoricalEntropyModel. Side-info
# is paid bits on the wire (honest rate); production would replace raw tables
# with a hyperprior / shared codebook.

ANS_PACK_MAGIC = b"MRPH"
ANS_PACK_VERSION = 1
ANS_SIDEINFO_SHARED = 0
ANS_SIDEINFO_PER_DIM = 1


def _freqs_rows_identical(freqs: torch.Tensor) -> bool:
    """True when every compact-dim frequency row equals the first."""
    if freqs.ndim != 2 or freqs.shape[0] < 1:
        return False
    return bool(torch.all(freqs == freqs[0:1]).item())


def _pack_freq_rows(freqs_rows: list[list[int]]) -> bytes:
    """Serialize frequency rows as little-endian uint16 (values fit in 2^scale_bits ≤ 2^16)."""
    out = bytearray()
    for row in freqs_rows:
        for f in row:
            fi = int(f)
            if fi < 0 or fi > 0xFFFF:
                raise ValueError(f"frequency {fi} out of uint16 range")
            out.extend(fi.to_bytes(2, "little"))
    return bytes(out)


def _unpack_freq_rows(blob: bytes, n_rows: int, levels: int) -> list[list[int]]:
    need = n_rows * levels * 2
    if len(blob) < need:
        raise ValueError("frequency side-info truncated")
    rows: list[list[int]] = []
    pos = 0
    for _ in range(n_rows):
        row = []
        for _ in range(levels):
            row.append(int.from_bytes(blob[pos : pos + 2], "little"))
            pos += 2
        rows.append(row)
    return rows


def ans_pack_indices(
    indices: torch.Tensor,
    model: "CategoricalEntropyModel",
    *,
    scale_bits: int = ANS_SCALE_BITS,
) -> tuple[bytes, dict]:
    """
    Self-describing ANS bitstream: embedded frequency side-info + rANS payload.

    Encode STE indices under the model's factorized PMFs, then wrap the payload
    so a decoder can recover indices without the live logits. Meta reports
    payload bits, side-info bytes, and total measured wire bits.
    """
    payload, enc_meta = ans_encode_indices(indices, model, scale_bits=scale_bits)
    pmf = categorical_pmfs(model)
    freqs = _pmf_to_freqs(pmf, scale_bits=scale_bits)
    shared = _freqs_rows_identical(freqs)
    if shared:
        mode = ANS_SIDEINFO_SHARED
        freqs_rows = [[int(x) for x in freqs[0].tolist()]]
    else:
        mode = ANS_SIDEINFO_PER_DIM
        freqs_rows = [[int(x) for x in row] for row in freqs.tolist()]
    freq_blob = _pack_freq_rows(freqs_rows)
    header = bytearray()
    header.extend(ANS_PACK_MAGIC)
    header.append(ANS_PACK_VERSION)
    header.append(int(scale_bits))
    header.extend(int(model.compact_dim).to_bytes(2, "little"))
    header.extend(int(model.levels).to_bytes(2, "little"))
    header.append(mode)
    header.extend(freq_blob)
    header.extend(len(payload).to_bytes(4, "little"))
    packed = bytes(header) + payload
    sideinfo_bytes = len(packed) - len(payload)
    meta = dict(enc_meta)
    meta.update(
        {
            "pack_version": ANS_PACK_VERSION,
            "sideinfo_mode": "shared" if shared else "per_dim",
            "sideinfo_bytes": sideinfo_bytes,
            "pack_bytes": len(packed),
            "measured_pack_bits": len(packed) * 8.0,
            "payload_bytes": len(payload),
            "note": "self-describing ANS pack (freq side-info + ryg_rans payload)",
        }
    )
    return packed, meta


def ans_unpack_indices(packed: bytes) -> tuple[torch.Tensor, dict]:
    """
    Decode a pack from `ans_pack_indices` without a CategoricalEntropyModel.

    Returns (indices long (D,), meta) including geometry and side-info mode.
    """
    if len(packed) < 4 + 1 + 1 + 2 + 2 + 1 + 4:
        raise ValueError("ANS pack too short")
    if packed[0:4] != ANS_PACK_MAGIC:
        raise ValueError(f"bad ANS pack magic {packed[0:4]!r}")
    version = packed[4]
    if version != ANS_PACK_VERSION:
        raise ValueError(f"unsupported ANS pack version {version}")
    scale_bits = packed[5]
    compact_dim = int.from_bytes(packed[6:8], "little")
    levels = int.from_bytes(packed[8:10], "little")
    mode = packed[10]
    pos = 11
    if mode == ANS_SIDEINFO_SHARED:
        n_rows = 1
    elif mode == ANS_SIDEINFO_PER_DIM:
        n_rows = compact_dim
    else:
        raise ValueError(f"unknown sideinfo_mode {mode}")
    need = n_rows * levels * 2
    freq_blob = packed[pos : pos + need]
    if len(freq_blob) < need:
        raise ValueError("frequency side-info truncated")
    pos += need
    if pos + 4 > len(packed):
        raise ValueError("ANS pack missing payload length")
    payload_len = int.from_bytes(packed[pos : pos + 4], "little")
    pos += 4
    payload = packed[pos : pos + payload_len]
    if len(payload) != payload_len:
        raise ValueError("ANS pack payload truncated")
    if pos + payload_len != len(packed):
        raise ValueError("ANS pack has trailing junk")
    freqs_one = _unpack_freq_rows(freq_blob, n_rows, levels)
    if mode == ANS_SIDEINFO_SHARED:
        freqs_rows = [list(freqs_one[0]) for _ in range(compact_dim)]
    else:
        freqs_rows = freqs_one
    symbols = ans_decode_symbols(payload, freqs_rows, scale_bits=scale_bits)
    if len(symbols) != compact_dim:
        raise ValueError(f"decoded length {len(symbols)} != compact_dim {compact_dim}")
    indices = torch.tensor(symbols, dtype=torch.long)
    meta = {
        "pack_version": version,
        "scale_bits": scale_bits,
        "compact_dim": compact_dim,
        "levels": levels,
        "sideinfo_mode": "shared" if mode == ANS_SIDEINFO_SHARED else "per_dim",
        "sideinfo_bytes": pos - payload_len,  # header through payload_len field
        "payload_bytes": payload_len,
        "pack_bytes": len(packed),
        "measured_pack_bits": len(packed) * 8.0,
    }
    # Correct sideinfo: everything except payload
    meta["sideinfo_bytes"] = len(packed) - payload_len
    return indices, meta


def ans_pack_stats(
    compact_dim: int = 256,
    levels: int = 256,
    image_side: int = 512,
    *,
    measured_pack_bits: Optional[float] = None,
    payload_bits: Optional[float] = None,
    sideinfo_bytes: Optional[int] = None,
    sideinfo_mode: str = "shared",
) -> dict:
    """
    Illustrative bpp for a self-describing ANS pack (payload + freq side-info).

    Without measurements, reports categorical expected NLL and notes that
    side-info size depends on shared vs per-dim tables after `ans_pack_indices`.
    """
    base = ans_bitstream_stats(
        compact_dim=compact_dim,
        levels=levels,
        image_side=image_side,
        measured_bits=payload_bits,
    )
    pixels = float(image_side * image_side)
    out = dict(base)
    out["sideinfo_mode"] = sideinfo_mode
    out["note"] = (
        "ANS pack = freq side-info + rANS payload; measured_pack_bits after ans_pack_indices"
    )
    if sideinfo_bytes is not None:
        out["sideinfo_bytes"] = int(sideinfo_bytes)
        out["sideinfo_bits"] = float(sideinfo_bytes) * 8.0
    if measured_pack_bits is not None:
        out["measured_pack_bits"] = float(measured_pack_bits)
        out["measured_pack_bits_per_pixel"] = float(measured_pack_bits) / pixels
    return out


class LearnedQuantAffine(nn.Module):
    """
    Per-dimension learned affine before uniform STE quantization.

    Maps code → y = (x − μ) / b, STE-quantizes y on a fixed [-1, 1] grid, then
    inverse-maps x̂ = y_q · b + μ. Learnable `loc` (μ) and `log_scale` (→ b via
    softplus) replace fixed `[code_min, code_max]` so each compact dim can adapt
    its effective dynamic range. Gradients flow to compressor and affine params
    through the identity STE on y.

    Rate accounting stays uniform `log2(L)` × dim (or factorized Laplace if that
    path is enabled) — the affine does not change alphabet size. See
    docs/ENTROPY-CODING-NOTES.md.
    """

    def __init__(self, compact_dim: int):
        super().__init__()
        if compact_dim < 1:
            raise ValueError("compact_dim must be >= 1")
        self.compact_dim = compact_dim
        self.loc = nn.Parameter(torch.zeros(compact_dim))
        self.log_scale = nn.Parameter(torch.zeros(compact_dim))

    def scale(self) -> torch.Tensor:
        """Positive half-range b = softplus(log_scale) + eps."""
        return F.softplus(self.log_scale) + 1e-3

    def ste_quantize(self, code: torch.Tensor, levels: int = 256) -> tuple[torch.Tensor, dict]:
        """Affine → STE uniform quant on [-1, 1] → inverse affine.

        `meta["indices"]` are the discrete bin ids on the normalized y-grid
        (for CategoricalEntropyModel rate terms).
        """
        if code.shape[-1] != self.compact_dim:
            raise ValueError(
                f"code last dim {code.shape[-1]} != compact_dim {self.compact_dim}"
            )
        loc = self.loc.to(device=code.device, dtype=code.dtype)
        scale = self.scale().to(device=code.device, dtype=code.dtype)
        y = (code - loc) / scale
        y_q, meta = straight_through_quantize(
            y, levels=levels, code_min=-1.0, code_max=1.0
        )
        x_hat = y_q * scale + loc
        meta = dict(meta)
        meta["learned_affine"] = True
        meta["affine_scale_mean"] = float(scale.detach().mean().cpu())
        # indices already present from quantize_uniform via straight_through_quantize
        return x_hat, meta


# ---------------------------------------------------------------------------
# Codec
# ---------------------------------------------------------------------------

class GenerativeCompressionCodec:
    """
    Extremely lossy 'generative codec': ship a tiny vector; reconstruct with a
    frozen diffusion prior + optional text prompt.

    Latent geometry (SD 1.5, 512px): VAE latent is (1, 4, 64, 64) = 16384 floats.
    Compact code size defaults to 256 floats (~1 KB FP32) — illustrative only.
    """

    LATENT_C, LATENT_H, LATENT_W = 4, 64, 64
    FLAT_DIM = LATENT_C * LATENT_H * LATENT_W  # 16384
    # SD VAE latent scaling factor used by Diffusers when decoding
    VAE_SCALING_FACTOR = 0.18215

    def __init__(
        self,
        model_id: str = "runwayml/stable-diffusion-v1-5",
        device: Optional[str] = None,
        compact_dim: int = 256,
        dtype: torch.dtype = torch.float16,
    ):
        if device is None:
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = torch.device(device)
        # FP16 on CPU is a footgun; force FP32 there
        if self.device.type == "cpu":
            dtype = torch.float32
        self.dtype = dtype
        self.compact_dim = compact_dim

        print(f"Loading generative prior: {model_id} on {self.device} ({dtype})...")
        # Lazy import so `python -c "import generative_codec"` docs don't need GPU deps at import time in tests
        from diffusers import StableDiffusionPipeline

        self.pipe = StableDiffusionPipeline.from_pretrained(
            model_id,
            torch_dtype=dtype,
            safety_checker=None,
            requires_safety_checker=False,
        ).to(self.device)
        self.vae = self.pipe.vae
        self.vae.eval()

        # CONCEPTUAL learned extreme compressor / expander (UNTRAINED mocks).
        # Real systems learn these end-to-end; random weights here only show shapes.
        self.compression_model = nn.Sequential(
            nn.Linear(self.FLAT_DIM, 1024),
            nn.Tanh(),
            nn.Linear(1024, compact_dim),
        ).to(self.device)

        self.decompression_model = nn.Sequential(
            nn.Linear(compact_dim, 1024),
            nn.Tanh(),
            nn.Linear(1024, self.FLAT_DIM),
        ).to(self.device)

        # Keep mocks in FP32 for numerical stability of Linear layers
        self.compression_model.float()
        self.decompression_model.float()

    def describe_rate(self, image_side: int = 512) -> dict:
        """Instance wrapper around module-level rate_stats for the active compact_dim."""
        return rate_stats(compact_dim=self.compact_dim, image_side=image_side)

    def describe_quantized_rate(self, levels: int = 256, image_side: int = 512) -> dict:
        """Uniform-codebook rate sketch for the active compact_dim (see quantized_rate_stats)."""
        return quantized_rate_stats(
            compact_dim=self.compact_dim, levels=levels, image_side=image_side
        )

    def describe_factorized_rate(self, image_side: int = 512) -> dict:
        """Untrained-init factorized Laplace bpp sketch for the active compact_dim."""
        return factorized_rate_stats(compact_dim=self.compact_dim, image_side=image_side)

    def describe_categorical_rate(self, levels: int = 256, image_side: int = 512) -> dict:
        """Untrained-init factorized categorical bpp sketch (uniform over `levels`)."""
        return categorical_rate_stats(
            compact_dim=self.compact_dim, levels=levels, image_side=image_side
        )

    def describe_ans_rate(self, levels: int = 256, image_side: int = 512) -> dict:
        """Expected categorical NLL bpp sketch (ANS measured bits need encode)."""
        return ans_bitstream_stats(
            compact_dim=self.compact_dim, levels=levels, image_side=image_side
        )

    def describe_ans_pack_rate(self, levels: int = 256, image_side: int = 512) -> dict:
        """Expected NLL + pack side-info note (measured pack bits need ans_pack_indices)."""
        return ans_pack_stats(
            compact_dim=self.compact_dim, levels=levels, image_side=image_side
        )

    @torch.no_grad()
    def encode(self, image_input: Image.Image) -> torch.Tensor:
        """Image -> VAE latent -> compact vector (mock learned compression)."""
        print("--- ENCODE ---")
        print("1. VAE encode -> (1, 4, 64, 64) latent")
        img_tensor = preprocess_for_vae(image_input, self.device, self.dtype)
        posterior = self.vae.encode(img_tensor).latent_dist
        # Sample; scale the way Diffusers expects for the UNet
        latent = posterior.sample() * self.VAE_SCALING_FACTOR
        full_latent_flat = latent.flatten().float()

        print(f"2. Mock extreme compression -> ({self.compact_dim},) vector (NOT RD-pattern)")
        latent_code = self.compression_model(full_latent_flat)
        stats = self.describe_rate()
        print(
            f"Encoded compact code shape: {tuple(latent_code.shape)} "
            f"(~{stats['compact_code_bytes']} B FP32, ~{stats['bits_per_pixel']:.4f} bpp @ {stats['image_side']}²)"
        )
        return latent_code

    @torch.no_grad()
    def decode(
        self,
        latent_code_vector: torch.Tensor,
        prompt: str = "a detailed photo of a flower, high fidelity",
        num_inference_steps: int = 50,
        guidance_scale: float = 7.5,
        strength: float = 0.75,
        seed: Optional[int] = None,
    ) -> Image.Image:
        """
        Compact vector -> reconstructed VAE latent -> img2img-style diffusion decode.

        IMPORTANT: Feeding a reconstructed latent as `latents=` to text2img without
        adding noise / scheduling is incorrect for SD. We decode the latent to pixels
        with the VAE, then run img2img so the diffusion prior can re-synthesize.
        """
        print("\n--- DECODE ---")
        print("1. Mock decompress compact vector -> VAE-shaped latent")
        code = latent_code_vector.float().to(self.device)
        if code.ndim == 1:
            code = code.unsqueeze(0)
        reconstructed_flat = self.decompression_model(code)
        full_latent = reconstructed_flat.view(1, self.LATENT_C, self.LATENT_H, self.LATENT_W)
        # Unscale for VAE decode
        latents_for_vae = (full_latent / self.VAE_SCALING_FACTOR).to(dtype=self.dtype)

        print("2. VAE decode intermediate pixels (scaffold for diffusion prior)")
        decoded = self.vae.decode(latents_for_vae).sample
        decoded = (decoded / 2 + 0.5).clamp(0, 1)
        intermediate = transforms.ToPILImage()(decoded.squeeze(0).float().cpu())

        print("3. Diffusion img2img guided by prompt (generative reassembly)")
        generator = None
        if seed is not None:
            generator = torch.Generator(device=self.device).manual_seed(seed)

        # Prefer img2img pipeline path if available on the loaded pipe
        try:
            from diffusers import StableDiffusionImg2ImgPipeline

            img2img = StableDiffusionImg2ImgPipeline(
                vae=self.pipe.vae,
                text_encoder=self.pipe.text_encoder,
                tokenizer=self.pipe.tokenizer,
                unet=self.pipe.unet,
                scheduler=self.pipe.scheduler,
                safety_checker=None,
                feature_extractor=getattr(self.pipe, "feature_extractor", None),
                requires_safety_checker=False,
            ).to(self.device)
            result = img2img(
                prompt=prompt,
                image=intermediate,
                strength=strength,
                num_inference_steps=num_inference_steps,
                guidance_scale=guidance_scale,
                generator=generator,
            ).images[0]
        except Exception as exc:
            print(f"img2img path failed ({exc}); falling back to text2img (ignores latent content).")
            result = self.pipe(
                prompt=prompt,
                num_inference_steps=num_inference_steps,
                guidance_scale=guidance_scale,
                generator=generator,
            ).images[0]

        print("Decoded.")
        return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

DEFAULT_SAMPLE_URL = (
    "https://huggingface.co/datasets/huggingface/documentation-images/"
    "resolve/main/diffusers/inpaint_original.png"
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generative Compression Codec demo (IMAGE_8 workflow)")
    parser.add_argument("--image", default=DEFAULT_SAMPLE_URL, help="Local path or URL")
    parser.add_argument("--prompt", default="a detailed photo of a flower, high fidelity")
    parser.add_argument("--out-dir", default=".", help="Directory for original_input.png / generative_reassembled_output.png")
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--model-id", default="runwayml/stable-diffusion-v1-5")
    parser.add_argument(
        "--compact-dim",
        type=int,
        default=256,
        help="Mock compact code length (floats). Rate stats use FP32 bytes; no entropy coding.",
    )
    parser.add_argument(
        "--quant-levels",
        type=int,
        default=256,
        help="Uniform codebook size for quantized_rate_stats print (illustrative; not ANS).",
    )
    args = parser.parse_args()

    try:
        input_image = load_rgb_image(args.image)
        print("Loaded input image.")
    except Exception as e:
        print(f"Could not load image ({e}); using synthetic fallback.")
        input_image = make_fallback_image()

    codec = GenerativeCompressionCodec(model_id=args.model_id, compact_dim=args.compact_dim)
    print(f"Rate (illustrative FP32): {codec.describe_rate()}")
    print(f"Rate (uniform {args.quant_levels}-level sketch): {codec.describe_quantized_rate(levels=args.quant_levels)}")
    print(f"Rate (factorized Laplace init sketch): {codec.describe_factorized_rate()}")
    print(
        f"Rate (categorical {args.quant_levels}-level init sketch): "
        f"{codec.describe_categorical_rate(levels=args.quant_levels)}"
    )
    print(
        f"Rate (ANS expected-NLL sketch @ L={args.quant_levels}): "
        f"{codec.describe_ans_rate(levels=args.quant_levels)}"
    )
    print(
        f"Rate (ANS pack sketch @ L={args.quant_levels}): "
        f"{codec.describe_ans_pack_rate(levels=args.quant_levels)}"
    )
    compact_code = codec.encode(input_image)
    print(f"\n[Data stream: compact vector {tuple(compact_code.shape)} floats]")

    reconstructed = codec.decode(
        compact_code,
        prompt=args.prompt,
        num_inference_steps=args.steps,
        seed=args.seed,
    )

    import os

    os.makedirs(args.out_dir, exist_ok=True)
    in_path = os.path.join(args.out_dir, "original_input.png")
    out_path = os.path.join(args.out_dir, "generative_reassembled_output.png")
    input_image.save(in_path)
    reconstructed.save(out_path)
    print(f"Saved {in_path}")
    print(f"Saved {out_path}")
    print("Compare input vs generative reassembly — this codec is intentionally lossy.")


if __name__ == "__main__":
    main()
