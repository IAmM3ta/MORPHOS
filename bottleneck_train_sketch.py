"""
Bottleneck training loop sketch — IMAGE_8 / MORPHOS

The production path trains (or replaces) the mock compression / decompression
MLPs end-to-end against a reconstruction + rate objective while the VAE and
diffusion prior stay frozen. This module is a *shape-faithful sketch*:

  - No Stable Diffusion weight download
  - Mock latents stand in for VAE encode output
  - Rate term uses FP32 byte accounting by default, uniform log2(L) bpp with
    STE quantization, or a differentiable factorized Laplace prior via
    `--entropy-rate` (still not ANS / bitstream plumbing)

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
    FactorizedEntropyModel,
    GenerativeCompressionCodec,
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
) -> tuple[torch.Tensor, TrainStepMetrics]:
    """Reconstruction MSE + FP32 / uniform / factorized-Laplace rate term."""
    recon = reconstruction_mse(pred_flat, target_flat)
    if use_entropy_rate:
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
) -> TrainStepMetrics:
    """
    One optimizer step: compress → (optional STE quant) → decompress → loss.

    Expects batch_flat shaped (B, FLAT_DIM). Does not touch diffusion weights.
    When use_ste_quant is True, inserts straight_through_quantize between the
    MLPs and uses the uniform-symbol rate hinge (unless use_entropy_rate).
    When use_entropy_rate is True, the rate term is the factorized Laplace
    expected bpp (optionally hinged); entropy_model params must be in optimizer.
    """
    compression.train()
    decompression.train()
    if entropy_model is not None:
        entropy_model.train()
    optimizer.zero_grad(set_to_none=True)

    code = compression(batch_flat)
    assert code.shape[-1] == compact_dim
    if use_ste_quant:
        code, _ = straight_through_quantize(
            code,
            levels=quant_levels,
            code_min=quant_code_min,
            code_max=quant_code_max,
        )
    recon_flat = decompression(code)
    loss, metrics = combined_loss(
        recon_flat,
        batch_flat,
        compact_dim,
        image_side=image_side,
        target_bpp=target_bpp,
        rate_weight=rate_weight,
        recon_weight=recon_weight,
        use_ste_quant=use_ste_quant and not use_entropy_rate,
        quant_levels=quant_levels,
        use_entropy_rate=use_entropy_rate,
        code=code,
        entropy_model=entropy_model,
        entropy_hinge=entropy_hinge,
    )
    # Report STE if it was applied in the forward path (even when entropy owns the rate term)
    metrics.used_ste_quant = use_ste_quant
    metrics.quant_levels = quant_levels if use_ste_quant else None
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
) -> list[TrainStepMetrics]:
    """Tiny CPU-only dry run proving the loop closes (for demos / CI)."""
    g = torch.Generator().manual_seed(seed)
    torch.manual_seed(seed)
    compression, decompression = make_bottleneck_pair(compact_dim=compact_dim)
    entropy_model: Optional[FactorizedEntropyModel] = None
    params = list(compression.parameters()) + list(decompression.parameters())
    if use_entropy_rate:
        entropy_model = FactorizedEntropyModel(compact_dim)
        params = params + list(entropy_model.parameters())
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
        )
        history.append(metrics)
    return history


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
    args = parser.parse_args()

    print("MORPHOS bottleneck training sketch (mock latents, frozen-prior path not loaded)")
    print(f"rate_stats @ compact_dim={args.compact_dim}: {rate_stats(compact_dim=args.compact_dim)}")
    if args.ste_quant:
        print(
            f"STE quant levels={args.quant_levels}: "
            f"{quantized_rate_stats(compact_dim=args.compact_dim, levels=args.quant_levels)}"
        )
    if args.entropy_rate:
        print(
            f"factorized Laplace init: "
            f"{factorized_rate_stats(compact_dim=args.compact_dim)}"
        )
    history = run_sketch_epochs(
        steps=args.steps,
        batch_size=args.batch_size,
        compact_dim=args.compact_dim,
        lr=args.lr,
        seed=args.seed,
        use_ste_quant=args.ste_quant,
        quant_levels=args.quant_levels,
        use_entropy_rate=args.entropy_rate,
        entropy_hinge=args.entropy_hinge,
    )
    first, last = history[0], history[-1]
    tags = []
    if first.used_ste_quant:
        tags.append(f"ste=True L={first.quant_levels}")
    if first.used_entropy_rate:
        tags.append("entropy=True")
    tag_s = (" " + " ".join(tags)) if tags else ""
    print(
        f"step 0: recon_mse={first.recon_mse:.6f} bpp={first.rate_bpp:.5f} "
        f"rate_penalty={first.rate_penalty:.6f} total={first.total_loss:.6f}{tag_s}"
    )
    print(
        f"step {len(history) - 1}: recon_mse={last.recon_mse:.6f} bpp={last.rate_bpp:.5f} "
        f"rate_penalty={last.rate_penalty:.6f} total={last.total_loss:.6f}"
    )
    print("Sketch complete — learned quant scales / real VAE latents / ANS next.")


if __name__ == "__main__":
    main()
