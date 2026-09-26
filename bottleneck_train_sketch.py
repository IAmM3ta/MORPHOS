"""
Bottleneck training loop sketch — IMAGE_8 / MORPHOS

The production path trains (or replaces) the mock compression / decompression
MLPs end-to-end against a reconstruction + rate objective while the VAE and
diffusion prior stay frozen. This module is a *shape-faithful sketch*:

  - No Stable Diffusion weight download
  - Mock latents stand in for VAE encode output
  - Rate term uses FP32 byte accounting by default, uniform log2(L) bpp with
    STE quantization (optional per-dim `LearnedQuantAffine` scales), a
    differentiable factorized Laplace prior via `--entropy-rate`, or a
    discrete factorized categorical prior over STE indices via
    `--categorical-rate`, plus optional tabled rANS bitstream check via
    `--ans-check` and self-describing pack via `--ans-pack` (freq side-info
    so decode needs no live CategoricalEntropyModel)

Swap `MockLatentBatch` for real `vae.encode(...).latent_dist.sample()` and
attach a perceptual / diffusion-aware reconstruction loss when moving off the
scaffold.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F

from generative_codec import (
    CategoricalEntropyModel,
    FactorizedEntropyModel,
    GenerativeCompressionCodec,
    LearnedQuantAffine,
    ans_decode_indices,
    ans_encode_indices,
    ans_pack_indices,
    ans_unpack_indices,
    categorical_rate_stats,
    factorized_rate_stats,
    quantized_rate_stats,
    rate_stats,
    straight_through_quantize,
)


# ---------------------------------------------------------------------------
# Models (same geometry as GenerativeCompressionCodec mocks)
# ---------------------------------------------------------------------------

def make_bottleneck_pair(
    compact_dim: int = 256,
    hidden: int = 1024,
    flat_dim: int = GenerativeCompressionCodec.FLAT_DIM,
) -> tuple[nn.Module, nn.Module]:
    """Untrained compressor / expander with IMAGE_8 latent geometry."""
    compression = nn.Sequential(
        nn.Linear(flat_dim, hidden),
        nn.Tanh(),
        nn.Linear(hidden, compact_dim),
    )
    decompression = nn.Sequential(
        nn.Linear(compact_dim, hidden),
        nn.Tanh(),
        nn.Linear(hidden, flat_dim),
    )
    return compression, decompression


# ---------------------------------------------------------------------------
# Losses
# ---------------------------------------------------------------------------

@dataclass
class TrainStepMetrics:
    """Scalars from one sketch train step (for logging / tests)."""

    recon_mse: float
    rate_bpp: float
    rate_penalty: float
    total_loss: float
    compact_dim: int
    used_ste_quant: bool = False
    quant_levels: Optional[int] = None
    used_entropy_rate: bool = False
    used_categorical_rate: bool = False
    used_learned_quant_scales: bool = False


def reconstruction_mse(pred_flat: torch.Tensor, target_flat: torch.Tensor) -> torch.Tensor:
    """
    Pixel-free latent MSE on flattened VAE codes.

    Production: replace with VAE-decoded L1/L2 + LPIPS, and/or a diffusion
    score-matching term so the bottleneck stays on-manifold for img2img.
    """
    return F.mse_loss(pred_flat, target_flat)


def rate_penalty_bpp(
    compact_dim: int,
    image_side: int = 512,
    target_bpp: float = 0.05,
    weight: float = 1.0,
) -> torch.Tensor:
    """
    Soft hinge on illustrative FP32 bpp (no entropy coder).

    Encourages keeping compact_dim small relative to a bpp budget. A real
    system would use a learned entropy model / quantization + bits-back or ANS.
    """
    stats = rate_stats(compact_dim=compact_dim, image_side=image_side)
    bpp = float(stats["bits_per_pixel"])
    # Hinge: penalize only when over budget (detached constant — dim is discrete here)
    over = max(0.0, bpp - target_bpp)
    return torch.tensor(weight * over, dtype=torch.float32)


def quantized_rate_penalty_bpp(
    compact_dim: int,
    levels: int = 256,
    image_side: int = 512,
    target_bpp: float = 0.05,
    weight: float = 1.0,
) -> torch.Tensor:
    """
    Soft hinge on illustrative uniform-symbol bpp (log2(levels) × dim).

    Used when STE quantization is on — closer to a discrete alphabet than FP32,
    still not an entropy model. See quantized_rate_stats / ENTROPY-CODING-NOTES.
    """
    stats = quantized_rate_stats(
        compact_dim=compact_dim, levels=levels, image_side=image_side
    )
    bpp = float(stats["bits_per_pixel"])
    over = max(0.0, bpp - target_bpp)
    return torch.tensor(weight * over, dtype=torch.float32)


def factorized_rate_penalty_bpp(
    code: torch.Tensor,
    entropy_model: FactorizedEntropyModel,
    image_side: int = 512,
    *,
    target_bpp: float = 0.05,
    weight: float = 1.0,
    hinge: bool = False,
) -> torch.Tensor:
    """
    Differentiable factorized-prior bpp (mean -log2 p(z) / pixels).

    Default is a soft rate weight on expected bpp (encourages matching the
    prior). With hinge=True, only penalize when bpp exceeds target_bpp —
    same shape as the FP32 / uniform hinges.
    """
    bpp = entropy_model.rate_bpp(code, image_side=image_side)
    if hinge:
        return weight * torch.relu(bpp - target_bpp)
    return weight * bpp


def categorical_rate_penalty_bpp(
    indices: torch.Tensor,
    categorical_model: CategoricalEntropyModel,
    image_side: int = 512,
    *,
    target_bpp: float = 0.05,
    weight: float = 1.0,
    hinge: bool = False,
) -> torch.Tensor:
    """
    Differentiable factorized-categorical bpp (mean -log2 p(index) / pixels).

    Gradients update the categorical logits; indices are hard STE symbols.
    Default soft rate weight; hinge=True mirrors the FP32 / uniform hinges.
    """
    bpp = categorical_model.rate_bpp(indices, image_side=image_side)
    if hinge:
        return weight * torch.relu(bpp - target_bpp)
    return weight * bpp


def combined_loss(
    pred_flat: torch.Tensor,
    target_flat: torch.Tensor,
    compact_dim: int,
    *,
    image_side: int = 512,
    target_bpp: float = 0.05,
    rate_weight: float = 1.0,
    recon_weight: float = 1.0,
    use_ste_quant: bool = False,
    quant_levels: int = 256,
    use_entropy_rate: bool = False,
    code: Optional[torch.Tensor] = None,
    entropy_model: Optional[FactorizedEntropyModel] = None,
    entropy_hinge: bool = False,
    use_categorical_rate: bool = False,
    indices: Optional[torch.Tensor] = None,
    categorical_model: Optional[CategoricalEntropyModel] = None,
) -> tuple[torch.Tensor, TrainStepMetrics]:
    """Reconstruction MSE + FP32 / uniform / Laplace / categorical rate term."""
    if use_entropy_rate and use_categorical_rate:
        raise ValueError("use_entropy_rate and use_categorical_rate are mutually exclusive")
    recon = reconstruction_mse(pred_flat, target_flat)
    if use_categorical_rate:
        if categorical_model is None or indices is None:
            raise ValueError("indices and categorical_model required when use_categorical_rate")
        rate = categorical_rate_penalty_bpp(
            indices,
            categorical_model,
            image_side=image_side,
            target_bpp=target_bpp,
            weight=rate_weight,
            hinge=entropy_hinge,
        )
        rate_bpp_val = float(
            categorical_model.rate_bpp(indices.detach(), image_side=image_side).cpu()
        )
    elif use_entropy_rate:
        if entropy_model is None or code is None:
            raise ValueError("code and entropy_model required when use_entropy_rate")
        rate = factorized_rate_penalty_bpp(
            code,
            entropy_model,
            image_side=image_side,
            target_bpp=target_bpp,
            weight=rate_weight,
            hinge=entropy_hinge,
        )
        rate_bpp_val = float(entropy_model.rate_bpp(code.detach(), image_side=image_side).cpu())
    elif use_ste_quant:
        rate = quantized_rate_penalty_bpp(
            compact_dim,
            levels=quant_levels,
            image_side=image_side,
            target_bpp=target_bpp,
            weight=rate_weight,
        )
        stats = quantized_rate_stats(
            compact_dim=compact_dim, levels=quant_levels, image_side=image_side
        )
        rate_bpp_val = float(stats["bits_per_pixel"])
    else:
        rate = rate_penalty_bpp(
            compact_dim,
            image_side=image_side,
            target_bpp=target_bpp,
            weight=rate_weight,
        )
        stats = rate_stats(compact_dim=compact_dim, image_side=image_side)
        rate_bpp_val = float(stats["bits_per_pixel"])
    # Keep rate on the same device as recon for the sum
    rate = rate.to(device=recon.device, dtype=recon.dtype)
    total = recon_weight * recon + rate
    metrics = TrainStepMetrics(
        recon_mse=float(recon.detach().cpu()),
        rate_bpp=rate_bpp_val,
        rate_penalty=float(rate.detach().cpu()),
        total_loss=float(total.detach().cpu()),
        compact_dim=compact_dim,
        used_ste_quant=use_ste_quant,
        quant_levels=quant_levels if use_ste_quant else None,
        used_entropy_rate=use_entropy_rate,
        used_categorical_rate=use_categorical_rate,
    )
    return total, metrics


# ---------------------------------------------------------------------------
# Batch + train step
# ---------------------------------------------------------------------------

class MockLatentBatch:
    """
    Stand-in for scaled VAE latents: (B, FLAT_DIM) float32.

    Real path: flatten(vae.encode(x).latent_dist.sample() * VAE_SCALING_FACTOR).
    """

    def __init__(self, batch_size: int = 4, flat_dim: int = GenerativeCompressionCodec.FLAT_DIM):
        self.batch_size = batch_size
        self.flat_dim = flat_dim

    def sample(self, generator: Optional[torch.Generator] = None) -> torch.Tensor:
        return torch.randn(self.batch_size, self.flat_dim, generator=generator)


def train_step(
    compression: nn.Module,
    decompression: nn.Module,
    optimizer: torch.optim.Optimizer,
    batch_flat: torch.Tensor,
    compact_dim: int,
    *,
    image_side: int = 512,
    target_bpp: float = 0.05,
    rate_weight: float = 1.0,
    recon_weight: float = 1.0,
    use_ste_quant: bool = False,
    quant_levels: int = 256,
    quant_code_min: float = -1.0,
    quant_code_max: float = 1.0,
    use_entropy_rate: bool = False,
    entropy_model: Optional[FactorizedEntropyModel] = None,
    entropy_hinge: bool = False,
    learned_quant: Optional[LearnedQuantAffine] = None,
    use_categorical_rate: bool = False,
    categorical_model: Optional[CategoricalEntropyModel] = None,
) -> TrainStepMetrics:
    """
    One optimizer step: compress → (optional STE quant) → decompress → loss.

    Expects batch_flat shaped (B, FLAT_DIM). Does not touch diffusion weights.
    When use_ste_quant is True, inserts straight_through_quantize between the
    MLPs and uses the uniform-symbol rate hinge (unless a learned entropy rate
    owns the term). When learned_quant is set, STE uses per-dim
    LearnedQuantAffine (implies STE); those params must be in the optimizer.
    When use_entropy_rate is True, the rate term is the factorized Laplace
    expected bpp (optionally hinged). When use_categorical_rate is True, STE
    is implied and the rate term is -log2 Categorical(logits)[index] (mutually
    exclusive with use_entropy_rate); categorical_model params must be in the
    optimizer.
    """
    if use_entropy_rate and use_categorical_rate:
        raise ValueError("use_entropy_rate and use_categorical_rate are mutually exclusive")
    if learned_quant is not None or use_categorical_rate:
        use_ste_quant = True
    compression.train()
    decompression.train()
    if entropy_model is not None:
        entropy_model.train()
    if categorical_model is not None:
        categorical_model.train()
    if learned_quant is not None:
        learned_quant.train()
    optimizer.zero_grad(set_to_none=True)

    code = compression(batch_flat)
    assert code.shape[-1] == compact_dim
    indices: Optional[torch.Tensor] = None
    if use_ste_quant:
        if learned_quant is not None:
            code, qmeta = learned_quant.ste_quantize(code, levels=quant_levels)
        else:
            code, qmeta = straight_through_quantize(
                code,
                levels=quant_levels,
                code_min=quant_code_min,
                code_max=quant_code_max,
            )
        indices = qmeta.get("indices")
    recon_flat = decompression(code)
    loss, metrics = combined_loss(
        recon_flat,
        batch_flat,
        compact_dim,
        image_side=image_side,
        target_bpp=target_bpp,
        rate_weight=rate_weight,
        recon_weight=recon_weight,
        use_ste_quant=use_ste_quant and not use_entropy_rate and not use_categorical_rate,
        quant_levels=quant_levels,
        use_entropy_rate=use_entropy_rate,
        code=code,
        entropy_model=entropy_model,
        entropy_hinge=entropy_hinge,
        use_categorical_rate=use_categorical_rate,
        indices=indices,
        categorical_model=categorical_model,
    )
    # Report STE if it was applied in the forward path (even when entropy owns the rate term)
    metrics.used_ste_quant = use_ste_quant
    metrics.quant_levels = quant_levels if use_ste_quant else None
    metrics.used_learned_quant_scales = learned_quant is not None
    metrics.used_categorical_rate = use_categorical_rate
    loss.backward()
    optimizer.step()
    return metrics


def run_sketch_epochs(
    *,
    steps: int = 8,
    batch_size: int = 4,
    compact_dim: int = 256,
    lr: float = 1e-3,
    seed: int = 0,
    use_ste_quant: bool = False,
    quant_levels: int = 256,
    use_entropy_rate: bool = False,
    entropy_hinge: bool = False,
    use_learned_quant_scales: bool = False,
    use_categorical_rate: bool = False,
) -> list[TrainStepMetrics]:
    """Tiny CPU-only dry run proving the loop closes (for demos / CI)."""
    if use_entropy_rate and use_categorical_rate:
        raise ValueError("use_entropy_rate and use_categorical_rate are mutually exclusive")
    if use_learned_quant_scales or use_categorical_rate:
        use_ste_quant = True
    g = torch.Generator().manual_seed(seed)
    torch.manual_seed(seed)
    compression, decompression = make_bottleneck_pair(compact_dim=compact_dim)
    entropy_model: Optional[FactorizedEntropyModel] = None
    categorical_model: Optional[CategoricalEntropyModel] = None
    learned_quant: Optional[LearnedQuantAffine] = None
    params = list(compression.parameters()) + list(decompression.parameters())
    if use_entropy_rate:
        entropy_model = FactorizedEntropyModel(compact_dim)
        params = params + list(entropy_model.parameters())
    if use_categorical_rate:
        categorical_model = CategoricalEntropyModel(compact_dim, levels=quant_levels)
        params = params + list(categorical_model.parameters())
    if use_learned_quant_scales:
        learned_quant = LearnedQuantAffine(compact_dim)
        params = params + list(learned_quant.parameters())
    opt = torch.optim.Adam(params, lr=lr)
    data = MockLatentBatch(batch_size=batch_size)
    history: list[TrainStepMetrics] = []
    for _ in range(steps):
        batch = data.sample(generator=g)
        metrics = train_step(
            compression,
            decompression,
            opt,
            batch,
            compact_dim,
            use_ste_quant=use_ste_quant,
            quant_levels=quant_levels,
            use_entropy_rate=use_entropy_rate,
            entropy_model=entropy_model,
            entropy_hinge=entropy_hinge,
            learned_quant=learned_quant,
            use_categorical_rate=use_categorical_rate,
            categorical_model=categorical_model,
        )
        history.append(metrics)
    return history



def ans_check_one_code(
    compression: nn.Module,
    batch_flat: torch.Tensor,
    *,
    quant_levels: int = 256,
    learned_quant: Optional[LearnedQuantAffine] = None,
    categorical_model: Optional[CategoricalEntropyModel] = None,
    use_pack: bool = False,
) -> dict:
    """
    Encode one STE index vector with tabled rANS under the categorical prior.

    Uses the first row of `batch_flat`. Requires a CategoricalEntropyModel (same
    geometry as `--categorical-rate`). When `use_pack` is True, wraps the
    payload in a self-describing pack (freq side-info) and decodes via
    `ans_unpack_indices` (no live model). Returns encode meta plus round-trip OK.
    """
    if categorical_model is None:
        raise ValueError("categorical_model required for ans_check_one_code")
    compression.eval()
    with torch.no_grad():
        code = compression(batch_flat[:1])
        if learned_quant is not None:
            _, qmeta = learned_quant.ste_quantize(code, levels=quant_levels)
        else:
            _, qmeta = straight_through_quantize(
                code, levels=quant_levels, code_min=-1.0, code_max=1.0
            )
        indices = qmeta["indices"].reshape(-1)
        if use_pack:
            packed, meta = ans_pack_indices(indices, categorical_model)
            decoded, umeta = ans_unpack_indices(packed)
            meta = dict(meta)
            meta["unpack_sideinfo_mode"] = umeta["sideinfo_mode"]
            meta["roundtrip_ok"] = bool(torch.equal(decoded, indices.long().cpu()))
            meta["used_pack"] = True
        else:
            payload, meta = ans_encode_indices(indices, categorical_model)
            decoded = ans_decode_indices(payload, categorical_model)
            meta = dict(meta)
            meta["roundtrip_ok"] = bool(torch.equal(decoded, indices.long().cpu()))
            meta["used_pack"] = False
    return meta


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="MORPHOS bottleneck train sketch (no SD weights; mock latents)"
    )
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--compact-dim", type=int, default=256)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument(
        "--ste-quant",
        action="store_true",
        help="Insert straight_through_quantize between compress/expand; use uniform bpp hinge.",
    )
    parser.add_argument(
        "--quant-levels",
        type=int,
        default=256,
        help="Uniform codebook size when --ste-quant is set (default 256 = 8-bit symbols).",
    )
    parser.add_argument(
        "--entropy-rate",
        action="store_true",
        help="Use FactorizedEntropyModel expected bpp as the rate term (train prior jointly).",
    )
    parser.add_argument(
        "--entropy-hinge",
        action="store_true",
        help="With --entropy-rate, hinge only when bpp exceeds the target (default: soft rate weight).",
    )
    parser.add_argument(
        "--learned-quant-scales",
        action="store_true",
        help="Per-dim LearnedQuantAffine before STE quant (implies STE; replaces fixed code_min/max).",
    )
    parser.add_argument(
        "--categorical-rate",
        action="store_true",
        help="Use CategoricalEntropyModel over STE indices as the rate term (implies STE; exclusive with --entropy-rate).",
    )
    parser.add_argument(
        "--ans-check",
        action="store_true",
        help="After the sketch, rANS-encode one STE index vector under the categorical prior and verify decode (implies --categorical-rate).",
    )
    parser.add_argument(
        "--ans-pack",
        action="store_true",
        help="Like --ans-check but use a self-describing pack (freq side-info + payload; decode without live model). Implies --ans-check.",
    )
    args = parser.parse_args()

    if args.ans_pack:
        args.ans_check = True
    if args.ans_check:
        args.categorical_rate = True
    if args.entropy_rate and args.categorical_rate:
        parser.error("--entropy-rate and --categorical-rate are mutually exclusive")

    print("MORPHOS bottleneck training sketch (mock latents, frozen-prior path not loaded)")
    print(f"rate_stats @ compact_dim={args.compact_dim}: {rate_stats(compact_dim=args.compact_dim)}")
    ste_on = args.ste_quant or args.learned_quant_scales or args.categorical_rate
    if ste_on:
        print(
            f"STE quant levels={args.quant_levels}: "
            f"{quantized_rate_stats(compact_dim=args.compact_dim, levels=args.quant_levels)}"
        )
    if args.learned_quant_scales:
        print("LearnedQuantAffine: per-dim loc/scale → STE on [-1,1] → inverse (trainable)")
    if args.entropy_rate:
        print(
            f"factorized Laplace init: "
            f"{factorized_rate_stats(compact_dim=args.compact_dim)}"
        )
    if args.categorical_rate:
        print(
            f"factorized categorical init (L={args.quant_levels}): "
            f"{categorical_rate_stats(compact_dim=args.compact_dim, levels=args.quant_levels)}"
        )
    # Inline sketch so --ans-check / --ans-pack can reuse the trained categorical prior
    g = torch.Generator().manual_seed(args.seed)
    torch.manual_seed(args.seed)
    compression, decompression = make_bottleneck_pair(compact_dim=args.compact_dim)
    entropy_model = None
    categorical_model = None
    learned_quant = None
    params = list(compression.parameters()) + list(decompression.parameters())
    if args.entropy_rate:
        entropy_model = FactorizedEntropyModel(args.compact_dim)
        params = params + list(entropy_model.parameters())
    if args.categorical_rate:
        categorical_model = CategoricalEntropyModel(args.compact_dim, levels=args.quant_levels)
        params = params + list(categorical_model.parameters())
    if args.learned_quant_scales:
        learned_quant = LearnedQuantAffine(args.compact_dim)
        params = params + list(learned_quant.parameters())
    opt = torch.optim.Adam(params, lr=args.lr)
    data = MockLatentBatch(batch_size=args.batch_size)
    history = []
    last_batch = None
    for _ in range(args.steps):
        last_batch = data.sample(generator=g)
        metrics = train_step(
            compression,
            decompression,
            opt,
            last_batch,
            args.compact_dim,
            use_ste_quant=ste_on,
            quant_levels=args.quant_levels,
            use_entropy_rate=args.entropy_rate,
            entropy_model=entropy_model,
            entropy_hinge=args.entropy_hinge,
            learned_quant=learned_quant,
            use_categorical_rate=args.categorical_rate,
            categorical_model=categorical_model,
        )
        history.append(metrics)
    first, last = history[0], history[-1]
    tags = []
    if first.used_ste_quant:
        tags.append(f"ste=True L={first.quant_levels}")
    if first.used_learned_quant_scales:
        tags.append("learned_affine=True")
    if first.used_entropy_rate:
        tags.append("entropy=True")
    if first.used_categorical_rate:
        tags.append("categorical=True")
    tag_s = (" " + " ".join(tags)) if tags else ""
    print(
        f"step 0: recon_mse={first.recon_mse:.6f} bpp={first.rate_bpp:.5f} "
        f"rate_penalty={first.rate_penalty:.6f} total={first.total_loss:.6f}{tag_s}"
    )
    print(
        f"step {len(history) - 1}: recon_mse={last.recon_mse:.6f} bpp={last.rate_bpp:.5f} "
        f"rate_penalty={last.rate_penalty:.6f} total={last.total_loss:.6f}"
    )
    if args.ans_check:
        assert last_batch is not None and categorical_model is not None
        meta = ans_check_one_code(
            compression,
            last_batch,
            quant_levels=args.quant_levels,
            learned_quant=learned_quant,
            categorical_model=categorical_model,
            use_pack=args.ans_pack,
        )
        mode = "pack" if args.ans_pack else "payload"
        print(
            f"ANS {mode} check: roundtrip_ok={meta['roundtrip_ok']} "
            f"measured_bits={meta.get('measured_pack_bits', meta.get('measured_bits'))} "
            f"expected_nll_bits={meta['expected_nll_bits']:.2f} "
            f"sideinfo_mode={meta.get('sideinfo_mode', meta.get('unpack_sideinfo_mode', 'n/a'))} "
            f"pack_bytes={meta.get('pack_bytes', meta.get('payload_bytes'))}"
        )
    print("Sketch complete — hyperprior notes / real VAE latents next.")


if __name__ == "__main__":
    main()
