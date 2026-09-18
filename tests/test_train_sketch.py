"""Tests for bottleneck_train_sketch — no Stable Diffusion weights."""

import torch

from bottleneck_train_sketch import (
    MockLatentBatch,
    combined_loss,
    make_bottleneck_pair,
    rate_penalty_bpp,
    reconstruction_mse,
    run_sketch_epochs,
    train_step,
)
from generative_codec import GenerativeCompressionCodec


def test_make_bottleneck_pair_shapes():
    compact = 128
    comp, decomp = make_bottleneck_pair(compact_dim=compact)
    x = torch.randn(GenerativeCompressionCodec.FLAT_DIM)
    code = comp(x)
    assert code.shape == (compact,)
    y = decomp(code)
    assert y.shape == (GenerativeCompressionCodec.FLAT_DIM,)


def test_mock_latent_batch_shape():
    batch = MockLatentBatch(batch_size=3).sample()
    assert batch.shape == (3, GenerativeCompressionCodec.FLAT_DIM)


def test_reconstruction_mse_zero_on_identity():
    x = torch.randn(2, 64)
    assert float(reconstruction_mse(x, x)) < 1e-8


def test_rate_penalty_under_budget_is_zero():
    # Default 256-dim @ 512² ≈ 0.03125 bpp < 0.05 target → no hinge
    pen = rate_penalty_bpp(compact_dim=256, image_side=512, target_bpp=0.05)
    assert float(pen) == 0.0


def test_rate_penalty_over_budget_positive():
    # Huge compact_dim forces bpp well above 0.05
    pen = rate_penalty_bpp(compact_dim=16384, image_side=512, target_bpp=0.05)
    assert float(pen) > 0.0


def test_combined_loss_and_train_step_closes():
    compact = 64
    comp, decomp = make_bottleneck_pair(compact_dim=compact)
    opt = torch.optim.Adam(list(comp.parameters()) + list(decomp.parameters()), lr=1e-3)
    batch = torch.randn(2, GenerativeCompressionCodec.FLAT_DIM)
    metrics = train_step(comp, decomp, opt, batch, compact)
    assert metrics.compact_dim == compact
    assert metrics.recon_mse >= 0.0
    assert metrics.total_loss >= 0.0


def test_run_sketch_epochs_reduces_or_finite():
    history = run_sketch_epochs(steps=4, batch_size=2, compact_dim=64, seed=1)
    assert len(history) == 4
    assert all(m.total_loss == m.total_loss for m in history)  # not NaN
