"""
Bottleneck training loop sketch — IMAGE_8 / MORPHOS

The production path trains (or replaces) the mock compression / decompression
MLPs end-to-end against a reconstruction + rate objective while the VAE and
diffusion prior stay frozen. This module is a *shape-faithful sketch*:

  - No Stable Diffusion weight download
  - Mock latents stand in for VAE encode output
  - Rate term uses FP32 byte accounting (same spirit as rate_stats), not a
    learned entropy model yet

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

from generative_codec import GenerativeCompressionCodec, rate_stats


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


def combined_loss(
    pred_flat: torch.Tensor,
    target_flat: torch.Tensor,
    compact_dim: int,
    *,
    image_side: int = 512,
    target_bpp: float = 0.05,
    rate_weight: float = 1.0,
    recon_weight: float = 1.0,
) -> tuple[torch.Tensor, TrainStepMetrics]:
    """Reconstruction MSE + illustrative rate hinge."""
    recon = reconstruction_mse(pred_flat, target_flat)
    rate = rate_penalty_bpp(
        compact_dim,
        image_side=image_side,
        target_bpp=target_bpp,
        weight=rate_weight,
    )
    # Keep rate on the same device as recon for the sum
    rate = rate.to(device=recon.device, dtype=recon.dtype)
    total = recon_weight * recon + rate
    stats = rate_stats(compact_dim=compact_dim, image_side=image_side)
    metrics = TrainStepMetrics(
        recon_mse=float(recon.detach().cpu()),
        rate_bpp=float(stats["bits_per_pixel"]),
        rate_penalty=float(rate.detach().cpu()),
        total_loss=float(total.detach().cpu()),
        compact_dim=compact_dim,
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
) -> TrainStepMetrics:
    """
    One optimizer step: compress → decompress → recon+rate loss → backward.

    Expects batch_flat shaped (B, FLAT_DIM). Does not touch diffusion weights.
    """
    compression.train()
    decompression.train()
    optimizer.zero_grad(set_to_none=True)

    code = compression(batch_flat)
    assert code.shape[-1] == compact_dim
    recon_flat = decompression(code)
    loss, metrics = combined_loss(
        recon_flat,
        batch_flat,
        compact_dim,
        image_side=image_side,
        target_bpp=target_bpp,
        rate_weight=rate_weight,
        recon_weight=recon_weight,
    )
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
) -> list[TrainStepMetrics]:
    """Tiny CPU-only dry run proving the loop closes (for demos / CI)."""
    g = torch.Generator().manual_seed(seed)
    torch.manual_seed(seed)
    compression, decompression = make_bottleneck_pair(compact_dim=compact_dim)
    params = list(compression.parameters()) + list(decompression.parameters())
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
    args = parser.parse_args()

    print("MORPHOS bottleneck training sketch (mock latents, frozen-prior path not loaded)")
    print(f"rate_stats @ compact_dim={args.compact_dim}: {rate_stats(compact_dim=args.compact_dim)}")
    history = run_sketch_epochs(
        steps=args.steps,
        batch_size=args.batch_size,
        compact_dim=args.compact_dim,
        lr=args.lr,
        seed=args.seed,
    )
    first, last = history[0], history[-1]
    print(
        f"step 0: recon_mse={first.recon_mse:.6f} bpp={first.rate_bpp:.5f} "
        f"rate_penalty={first.rate_penalty:.6f} total={first.total_loss:.6f}"
    )
    print(
        f"step {len(history) - 1}: recon_mse={last.recon_mse:.6f} bpp={last.rate_bpp:.5f} "
        f"rate_penalty={last.rate_penalty:.6f} total={last.total_loss:.6f}"
    )
    print("Sketch complete — wire real VAE latents + perceptual/diffusion loss next.")


if __name__ == "__main__":
    main()
