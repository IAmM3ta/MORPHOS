"""Tests for bottleneck_train_sketch — no Stable Diffusion weights."""

import torch

from bottleneck_train_sketch import (
    MockLatentBatch,
    categorical_rate_penalty_bpp,
    combined_loss,
    factorized_rate_penalty_bpp,
    make_bottleneck_pair,
    quantized_rate_penalty_bpp,
    rate_penalty_bpp,
    reconstruction_mse,
    run_sketch_epochs,
    train_step,
)
from generative_codec import (
    CategoricalEntropyModel,
    FactorizedEntropyModel,
    GenerativeCompressionCodec,
    LearnedQuantAffine,
)


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


def test_train_step_learned_quant_scales_closes_and_flags():
    compact = 64
    comp, decomp = make_bottleneck_pair(compact_dim=compact)
    affine = LearnedQuantAffine(compact)
    opt = torch.optim.Adam(
        list(comp.parameters()) + list(decomp.parameters()) + list(affine.parameters()),
        lr=1e-3,
    )
    batch = torch.randn(2, GenerativeCompressionCodec.FLAT_DIM)
    metrics = train_step(
        comp,
        decomp,
        opt,
        batch,
        compact,
        quant_levels=16,
        learned_quant=affine,
    )
    assert metrics.used_learned_quant_scales is True
    assert metrics.used_ste_quant is True
    assert metrics.quant_levels == 16
    assert metrics.total_loss == metrics.total_loss  # not NaN


def test_run_sketch_epochs_learned_quant_finite():
    history = run_sketch_epochs(
        steps=3,
        batch_size=2,
        compact_dim=64,
        seed=4,
        use_learned_quant_scales=True,
        quant_levels=32,
    )
    assert len(history) == 3
    assert all(m.used_learned_quant_scales for m in history)
    assert all(m.used_ste_quant for m in history)
    assert all(m.total_loss == m.total_loss for m in history)


def test_train_step_learned_plus_entropy_flags():
    compact = 32
    comp, decomp = make_bottleneck_pair(compact_dim=compact)
    ent = FactorizedEntropyModel(compact)
    affine = LearnedQuantAffine(compact)
    opt = torch.optim.Adam(
        list(comp.parameters())
        + list(decomp.parameters())
        + list(ent.parameters())
        + list(affine.parameters()),
        lr=1e-3,
    )
    batch = torch.randn(2, GenerativeCompressionCodec.FLAT_DIM)
    metrics = train_step(
        comp,
        decomp,
        opt,
        batch,
        compact,
        quant_levels=16,
        use_entropy_rate=True,
        entropy_model=ent,
        learned_quant=affine,
    )
    assert metrics.used_entropy_rate is True
    assert metrics.used_learned_quant_scales is True
    assert metrics.used_ste_quant is True


def test_categorical_rate_penalty_is_positive():
    model = CategoricalEntropyModel(32, levels=16)
    indices = torch.randint(0, 16, (2, 32))
    pen = categorical_rate_penalty_bpp(indices, model, image_side=512, weight=1.0)
    assert float(pen.detach()) > 0.0


def test_categorical_rate_hinge_under_budget_can_be_zero():
    model = CategoricalEntropyModel(8, levels=16)
    indices = torch.zeros(2, 8, dtype=torch.long)
    pen = categorical_rate_penalty_bpp(
        indices, model, image_side=512, target_bpp=10.0, weight=1.0, hinge=True
    )
    assert float(pen.detach()) == 0.0


def test_train_step_categorical_rate_closes_and_flags():
    compact = 64
    levels = 16
    comp, decomp = make_bottleneck_pair(compact_dim=compact)
    cat = CategoricalEntropyModel(compact, levels=levels)
    opt = torch.optim.Adam(
        list(comp.parameters()) + list(decomp.parameters()) + list(cat.parameters()),
        lr=1e-3,
    )
    batch = torch.randn(2, GenerativeCompressionCodec.FLAT_DIM)
    metrics = train_step(
        comp,
        decomp,
        opt,
        batch,
        compact,
        quant_levels=levels,
        use_categorical_rate=True,
        categorical_model=cat,
    )
    assert metrics.used_categorical_rate is True
    assert metrics.used_ste_quant is True
    assert metrics.quant_levels == levels
    assert metrics.rate_bpp > 0.0
    assert metrics.total_loss == metrics.total_loss  # not NaN


def test_run_sketch_epochs_categorical_finite():
    history = run_sketch_epochs(
        steps=3,
        batch_size=2,
        compact_dim=64,
        seed=5,
        use_categorical_rate=True,
        quant_levels=32,
    )
    assert len(history) == 3
    assert all(m.used_categorical_rate for m in history)
    assert all(m.used_ste_quant for m in history)
    assert all(m.total_loss == m.total_loss for m in history)


def test_train_step_categorical_plus_learned_flags():
    compact = 32
    levels = 16
    comp, decomp = make_bottleneck_pair(compact_dim=compact)
    cat = CategoricalEntropyModel(compact, levels=levels)
    affine = LearnedQuantAffine(compact)
    opt = torch.optim.Adam(
        list(comp.parameters())
        + list(decomp.parameters())
        + list(cat.parameters())
        + list(affine.parameters()),
        lr=1e-3,
    )
    batch = torch.randn(2, GenerativeCompressionCodec.FLAT_DIM)
    metrics = train_step(
        comp,
        decomp,
        opt,
        batch,
        compact,
        quant_levels=levels,
        use_categorical_rate=True,
        categorical_model=cat,
        learned_quant=affine,
    )
    assert metrics.used_categorical_rate is True
    assert metrics.used_learned_quant_scales is True
    assert metrics.used_ste_quant is True


def test_categorical_and_entropy_mutually_exclusive():
    compact = 16
    comp, decomp = make_bottleneck_pair(compact_dim=compact)
    ent = FactorizedEntropyModel(compact)
    cat = CategoricalEntropyModel(compact, levels=8)
    opt = torch.optim.Adam(list(comp.parameters()) + list(decomp.parameters()), lr=1e-3)
    batch = torch.randn(1, GenerativeCompressionCodec.FLAT_DIM)
    try:
        train_step(
            comp,
            decomp,
            opt,
            batch,
            compact,
            use_entropy_rate=True,
            entropy_model=ent,
            use_categorical_rate=True,
            categorical_model=cat,
            quant_levels=8,
        )
        assert False, "expected ValueError"
    except ValueError:
        pass



def test_ans_check_one_code_roundtrip():
    import torch
    from generative_codec import CategoricalEntropyModel
    from bottleneck_train_sketch import (
        MockLatentBatch,
        ans_check_one_code,
        make_bottleneck_pair,
        train_step,
    )

    torch.manual_seed(0)
    compact_dim = 32
    levels = 16
    compression, decompression = make_bottleneck_pair(compact_dim=compact_dim, hidden=64)
    cat = CategoricalEntropyModel(compact_dim, levels=levels)
    params = (
        list(compression.parameters())
        + list(decompression.parameters())
        + list(cat.parameters())
    )
    opt = torch.optim.Adam(params, lr=1e-3)
    batch = MockLatentBatch(batch_size=2, flat_dim=compression[0].in_features).sample()
    # flatten dim must match FLAT_DIM for make_bottleneck_pair default
    from generative_codec import GenerativeCompressionCodec

    batch = torch.randn(2, GenerativeCompressionCodec.FLAT_DIM)
    train_step(
        compression,
        decompression,
        opt,
        batch,
        compact_dim,
        use_ste_quant=True,
        quant_levels=levels,
        use_categorical_rate=True,
        categorical_model=cat,
    )
    meta = ans_check_one_code(
        compression, batch, quant_levels=levels, categorical_model=cat
    )
    assert meta["roundtrip_ok"] is True
    assert meta["payload_bytes"] >= 4
    assert meta["measured_bits"] >= meta["expected_nll_bits"]
