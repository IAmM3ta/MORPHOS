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
  FactorizedEntropyModel, LearnedQuantAffine, and docs/ENTROPY-CODING-NOTES.md.
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
    See docs/ENTROPY-CODING-NOTES.md for the FP32 → discrete → ANS ladder.
    """
    if levels < 2:
        raise ValueError("levels must be >= 2")
    x = code.float()
    lo = float(x.min()) if code_min is None else float(code_min)
    hi = float(x.max()) if code_max is None else float(code_max)
    if hi <= lo:
        # Degenerate range: emit mid-level constant
        mid = torch.full_like(x, lo)
        meta = {
            "levels": levels,
            "code_min": lo,
            "code_max": hi,
            "bits_per_symbol": math.log2(levels),
            "degenerate_range": True,
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
        """Affine → STE uniform quant on [-1, 1] → inverse affine."""
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
