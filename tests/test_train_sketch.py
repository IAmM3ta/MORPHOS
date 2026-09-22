"""Tests for bottleneck_train_sketch — no Stable Diffusion weights."""

import torch

from bottleneck_train_sketch import (
    MockLatentBatch,
    combined_loss,
    factorized_rate_penalty_bpp,
    make_bottleneck_pair,
    quantized_rate_penalty_bpp,
    rate_penalty_bpp,
    reconstruction_mse,
    run_sketch_epochs,
    train_step,
)
from generative_codec import FactorizedEntropyModel, GenerativeCompressionCodec


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
    assert float(pen.detach()) > 0.0


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


def test_quantized_rate_penalty_under_budget_is_zero():
    # 256-dim × 8-bit @ 512² ≈ 0.0078125 bpp < 0.05
    pen = quantized_rate_penalty_bpp(compact_dim=256, levels=256, image_side=512, target_bpp=0.05)
    assert float(pen) == 0.0


def test_quantized_rate_penalty_over_budget_positive():
    pen = quantized_rate_penalty_bpp(compact_dim=16384, levels=256, image_side=512, target_bpp=0.01)
    assert float(pen.detach()) > 0.0


def test_train_step_ste_quant_closes_and_flags():
    compact = 64
    comp, decomp = make_bottleneck_pair(compact_dim=compact)
    opt = torch.optim.Adam(list(comp.parameters()) + list(decomp.parameters()), lr=1e-3)
    batch = torch.randn(2, GenerativeCompressionCodec.FLAT_DIM)
    metrics = train_step(
        comp, decomp, opt, batch, compact, use_ste_quant=True, quant_levels=16
    )
    assert metrics.used_ste_quant is True
    assert metrics.quant_levels == 16
    assert metrics.recon_mse >= 0.0
    assert metrics.total_loss == metrics.total_loss  # not NaN


def test_run_sketch_epochs_ste_finite():
    history = run_sketch_epochs(
        steps=3, batch_size=2, compact_dim=64, seed=2, use_ste_quant=True, quant_levels=32
    )
    assert len(history) == 3
    assert all(m.used_ste_quant for m in history)
    assert all(m.total_loss == m.total_loss for m in history)


def test_factorized_rate_penalty_is_positive():
    model = FactorizedEntropyModel(32)
    code = torch.randn(2, 32)
    pen = factorized_rate_penalty_bpp(code, model, image_side=512, weight=1.0)
    assert float(pen.detach()) > 0.0


def test_factorized_rate_hinge_under_budget_can_be_zero():
    model = FactorizedEntropyModel(8)
    # Tiny codes near loc → low bpp; huge target → hinge off
    code = model.loc.detach().unsqueeze(0).expand(2, -1).clone()
    pen = factorized_rate_penalty_bpp(
        code, model, image_side=512, target_bpp=10.0, weight=1.0, hinge=True
    )
    assert float(pen) == 0.0


def test_train_step_entropy_rate_closes_and_flags():
    compact = 64
    comp, decomp = make_bottleneck_pair(compact_dim=compact)
    ent = FactorizedEntropyModel(compact)
    opt = torch.optim.Adam(
        list(comp.parameters()) + list(decomp.parameters()) + list(ent.parameters()),
        lr=1e-3,
    )
    batch = torch.randn(2, GenerativeCompressionCodec.FLAT_DIM)
    metrics = train_step(
        comp, decomp, opt, batch, compact, use_entropy_rate=True, entropy_model=ent
    )
    assert metrics.used_entropy_rate is True
    assert metrics.rate_bpp > 0.0
    assert metrics.total_loss == metrics.total_loss  # not NaN


def test_run_sketch_epochs_entropy_finite():
    history = run_sketch_epochs(
        steps=3, batch_size=2, compact_dim=64, seed=3, use_entropy_rate=True
    )
    assert len(history) == 3
    assert all(m.used_entropy_rate for m in history)
    assert all(m.total_loss == m.total_loss for m in history)


def test_train_step_ste_plus_entropy_uses_entropy_flag():
    compact = 32
    comp, decomp = make_bottleneck_pair(compact_dim=compact)
    ent = FactorizedEntropyModel(compact)
    opt = torch.optim.Adam(
        list(comp.parameters()) + list(decomp.parameters()) + list(ent.parameters()),
        lr=1e-3,
    )
    batch = torch.randn(2, GenerativeCompressionCodec.FLAT_DIM)
    metrics = train_step(
        comp,
        decomp,
        opt,
        batch,
        compact,
        use_ste_quant=True,
        quant_levels=16,
        use_entropy_rate=True,
        entropy_model=ent,
    )
    assert metrics.used_entropy_rate is True
    assert metrics.used_ste_quant is True  # STE in forward; entropy owns the rate term
    assert metrics.quant_levels == 16
