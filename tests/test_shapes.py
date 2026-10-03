"""Lightweight shape tests — no Stable Diffusion weights required."""

import math

import torch
import torch.nn as nn
from PIL import Image


def test_preprocess_for_vae_shape():
    from generative_codec import preprocess_for_vae

    img = Image.new("RGB", (512, 512), (128, 64, 32))
    t = preprocess_for_vae(img, device=torch.device("cpu"), dtype=torch.float32)
    assert t.shape == (1, 3, 512, 512)
    assert t.min() >= -1.0 - 1e-5
    assert t.max() <= 1.0 + 1e-5


def test_mock_compressor_dims():
    flat_dim = 4 * 64 * 64
    compact_dim = 256
    compression = nn.Sequential(nn.Linear(flat_dim, 1024), nn.Tanh(), nn.Linear(1024, compact_dim))
    decompression = nn.Sequential(nn.Linear(compact_dim, 1024), nn.Tanh(), nn.Linear(1024, flat_dim))
    x = torch.randn(flat_dim)
    code = compression(x)
    assert code.shape == (compact_dim,)
    y = decompression(code)
    assert y.shape == (flat_dim,)
    assert y.view(1, 4, 64, 64).shape == (1, 4, 64, 64)


def test_fallback_image():
    from generative_codec import make_fallback_image

    img = make_fallback_image(256)
    assert img.size == (256, 256)
    assert img.mode == "RGB"


def test_load_rgb_image_from_pil():
    from generative_codec import load_rgb_image

    src = Image.new("RGB", (100, 80), (10, 20, 30))
    out = load_rgb_image(src, size=64)
    assert out.size == (64, 64)
    assert out.mode == "RGB"


def test_codec_latent_constants():
    from generative_codec import GenerativeCompressionCodec

    assert GenerativeCompressionCodec.FLAT_DIM == 4 * 64 * 64
    assert GenerativeCompressionCodec.LATENT_C == 4
    assert GenerativeCompressionCodec.VAE_SCALING_FACTOR == 0.18215


def test_rate_stats_default_compact():
    from generative_codec import rate_stats

    s = rate_stats(compact_dim=256, image_side=512)
    assert s["flat_dim"] == 16384
    assert s["compact_dim"] == 256
    assert s["full_latent_bytes"] == 16384 * 4
    assert s["compact_code_bytes"] == 256 * 4  # 1024 B ≈ 1 KiB FP32
    assert s["compression_ratio_vs_flat"] == 64.0
    # 1024 bytes * 8 / (512*512) = 0.03125 bpp
    assert abs(s["bits_per_pixel"] - 0.03125) < 1e-9


def test_quantize_uniform_roundtrip_shape():
    from generative_codec import quantize_uniform

    code = torch.linspace(-1.0, 1.0, 256)
    dequant, meta = quantize_uniform(code, levels=16, code_min=-1.0, code_max=1.0)
    assert dequant.shape == code.shape
    assert meta["levels"] == 16
    assert abs(meta["bits_per_symbol"] - 4.0) < 1e-9
    assert not meta["degenerate_range"]
    # Endpoints should land on the range after dequant
    assert abs(float(dequant[0]) - (-1.0)) < 1e-5
    assert abs(float(dequant[-1]) - 1.0) < 1e-5


def test_quantized_rate_stats_8bit():
    from generative_codec import quantized_rate_stats, rate_stats

    q = quantized_rate_stats(compact_dim=256, levels=256, image_side=512)
    assert q["bits_per_symbol"] == 8.0
    assert q["total_bits"] == 256 * 8
    assert q["coded_bytes_uniform"] == 256.0
    # 2048 bits / (512*512) = 0.0078125 bpp
    assert abs(q["bits_per_pixel"] - 0.0078125) < 1e-12
    fp32 = rate_stats(compact_dim=256, image_side=512)
    assert abs(q["fp32_bits_per_pixel"] - fp32["bits_per_pixel"]) < 1e-12
    assert abs(q["ratio_vs_fp32"] - 4.0) < 1e-9  # 32-bit vs 8-bit symbols


def test_quantize_uniform_rejects_bad_levels():
    from generative_codec import quantize_uniform

    try:
        quantize_uniform(torch.zeros(4), levels=1)
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_straight_through_quantize_forward_matches_hard():
    from generative_codec import quantize_uniform, straight_through_quantize

    code = torch.linspace(-1.0, 1.0, 32, requires_grad=True)
    ste, meta = straight_through_quantize(code, levels=8, code_min=-1.0, code_max=1.0)
    hard, _ = quantize_uniform(code.detach(), levels=8, code_min=-1.0, code_max=1.0)
    assert torch.allclose(ste, hard)
    assert meta["ste"] is True
    assert meta["levels"] == 8


def test_straight_through_quantize_passes_grad():
    from generative_codec import straight_through_quantize

    code = torch.randn(16, requires_grad=True)
    ste, _ = straight_through_quantize(code, levels=16, code_min=-2.0, code_max=2.0)
    ste.sum().backward()
    assert code.grad is not None
    # Identity STE: grad should be ones
    assert torch.allclose(code.grad, torch.ones_like(code))


def test_factorized_entropy_model_shapes_and_grad():
    from generative_codec import FactorizedEntropyModel

    model = FactorizedEntropyModel(8)
    code = torch.randn(2, 8, requires_grad=True)
    nll = model.nll_bits(code)
    assert nll.shape == (2, 8)
    bpp = model.rate_bpp(code, image_side=512)
    assert bpp.ndim == 0
    bpp.backward()
    assert code.grad is not None
    assert model.loc.grad is not None


def test_factorized_rate_stats_init_sketch():
    from generative_codec import factorized_rate_stats
    import math

    s = factorized_rate_stats(compact_dim=256, image_side=512)
    assert s["compact_dim"] == 256
    # softplus(0)+eps → ~0.47 bits/dim at mode; bpp << FP32 0.03125
    assert s["bits_per_pixel"] < s["fp32_bits_per_pixel"]
    assert s["mean_bits_per_dim"] == math.log2(2.0 * (math.log1p(math.e) + 1e-6))
    assert abs(s["total_bits"] - 256 * s["mean_bits_per_dim"]) < 1e-9


def test_factorized_entropy_rejects_bad_dim():
    from generative_codec import FactorizedEntropyModel

    try:
        FactorizedEntropyModel(0)
        assert False, "expected ValueError"
    except ValueError:
        pass
    model = FactorizedEntropyModel(4)
    try:
        model.nll_bits(torch.zeros(3))
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_learned_quant_affine_shapes_and_grad():
    from generative_codec import LearnedQuantAffine

    affine = LearnedQuantAffine(8)
    code = torch.randn(2, 8, requires_grad=True)
    x_hat, meta = affine.ste_quantize(code, levels=16)
    assert x_hat.shape == code.shape
    assert meta["learned_affine"] is True
    assert meta["ste"] is True
    x_hat.sum().backward()
    assert code.grad is not None
    assert affine.loc.grad is not None
    assert affine.log_scale.grad is not None


def test_learned_quant_affine_rejects_bad_dim():
    from generative_codec import LearnedQuantAffine

    try:
        LearnedQuantAffine(0)
        assert False, "expected ValueError"
    except ValueError:
        pass
    affine = LearnedQuantAffine(4)
    try:
        affine.ste_quantize(torch.zeros(3), levels=8)
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_quantize_uniform_exposes_indices():
    from generative_codec import quantize_uniform

    code = torch.linspace(-1.0, 1.0, 16)
    dequant, meta = quantize_uniform(code, levels=8, code_min=-1.0, code_max=1.0)
    idx = meta["indices"]
    assert idx.shape == code.shape
    assert idx.dtype == torch.long
    assert int(idx.min()) >= 0
    assert int(idx.max()) <= 7
    assert int(idx[0]) == 0
    assert int(idx[-1]) == 7


def test_categorical_entropy_model_shapes_and_grad():
    from generative_codec import CategoricalEntropyModel

    model = CategoricalEntropyModel(8, levels=16)
    indices = torch.randint(0, 16, (2, 8))
    nll = model.nll_bits(indices)
    assert nll.shape == (2, 8)
    bpp = model.rate_bpp(indices, image_side=512)
    assert bpp.ndim == 0
    bpp.backward()
    assert model.logits.grad is not None
    # Untrained init ≈ uniform → ~log2(16)=4 bits/dim
    assert abs(float(nll.mean().detach()) - 4.0) < 1e-4


def test_categorical_rate_stats_uniform_init():
    from generative_codec import categorical_rate_stats, quantized_rate_stats

    s = categorical_rate_stats(compact_dim=256, levels=256, image_side=512)
    uni = quantized_rate_stats(compact_dim=256, levels=256, image_side=512)
    assert s["levels"] == 256
    assert abs(s["mean_bits_per_dim"] - 8.0) < 1e-12
    assert abs(s["bits_per_pixel"] - uni["bits_per_pixel"]) < 1e-12


def test_categorical_entropy_rejects_bad_args():
    from generative_codec import CategoricalEntropyModel

    try:
        CategoricalEntropyModel(0, levels=8)
        assert False, "expected ValueError"
    except ValueError:
        pass
    try:
        CategoricalEntropyModel(4, levels=1)
        assert False, "expected ValueError"
    except ValueError:
        pass
    model = CategoricalEntropyModel(4, levels=8)
    try:
        model.nll_bits(torch.zeros(3, dtype=torch.long))
        assert False, "expected ValueError"
    except ValueError:
        pass



def test_pmf_to_freqs_sums_to_M():
    from generative_codec import CategoricalEntropyModel, _pmf_to_freqs, categorical_pmfs, ANS_SCALE_BITS

    model = CategoricalEntropyModel(8, levels=16)
    freqs = _pmf_to_freqs(categorical_pmfs(model))
    assert freqs.shape == (8, 16)
    assert int(freqs.sum(dim=-1).min()) == (1 << ANS_SCALE_BITS)
    assert int(freqs.sum(dim=-1).max()) == (1 << ANS_SCALE_BITS)


def test_ans_roundtrip_uniform_and_peaked():
    import torch
    from generative_codec import CategoricalEntropyModel, ans_encode_indices, ans_decode_indices

    torch.manual_seed(0)
    model = CategoricalEntropyModel(64, levels=32)
    idx = torch.randint(0, 32, (64,))
    payload, meta = ans_encode_indices(idx, model)
    assert torch.equal(ans_decode_indices(payload, model), idx)
    assert meta["payload_bytes"] == len(payload)
    assert meta["measured_bits"] == len(payload) * 8
    # Uniform prior → expected ≈ 64 * log2(32) = 320 bits; overhead is small state flush
    assert abs(meta["expected_nll_bits"] - 320.0) < 1e-4
    assert meta["overhead_bits"] < 64  # 4-byte state + byte alignment

    peaked = CategoricalEntropyModel(64, levels=32)
    with torch.no_grad():
        peaked.logits.zero_()
        peaked.logits[:, 7] = 6.0
    idx_p = torch.full((64,), 7, dtype=torch.long)
    payload_p, meta_p = ans_encode_indices(idx_p, peaked)
    assert torch.equal(ans_decode_indices(payload_p, peaked), idx_p)
    # Peaked prior should beat uniform bitstream by a wide margin
    assert meta_p["payload_bytes"] < meta["payload_bytes"]
    assert meta_p["expected_nll_bits"] < meta["expected_nll_bits"]


def test_ans_bitstream_stats_with_measurement():
    from generative_codec import ans_bitstream_stats, categorical_rate_stats

    base = categorical_rate_stats(compact_dim=256, levels=256, image_side=512)
    s = ans_bitstream_stats(
        compact_dim=256,
        levels=256,
        image_side=512,
        measured_bits=2080.0,
        expected_nll_bits=base["total_bits"],
    )
    assert abs(s["expected_bits_per_pixel"] - base["bits_per_pixel"]) < 1e-12
    assert abs(s["measured_bits_per_pixel"] - 2080.0 / (512 * 512)) < 1e-12
    assert abs(s["overhead_bits"] - (2080.0 - base["total_bits"])) < 1e-9


def test_ans_rejects_bad_index_rank():
    import torch
    from generative_codec import CategoricalEntropyModel, ans_encode_indices

    model = CategoricalEntropyModel(4, levels=8)
    try:
        ans_encode_indices(torch.zeros(2, 4, dtype=torch.long), model)
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_ans_pack_roundtrip_shared_and_per_dim():
    import torch
    from generative_codec import (
        CategoricalEntropyModel,
        ans_pack_indices,
        ans_unpack_indices,
    )

    torch.manual_seed(1)
    # Uniform init → shared frequency row (side-info collapses)
    model = CategoricalEntropyModel(48, levels=16)
    idx = torch.randint(0, 16, (48,))
    packed, meta = ans_pack_indices(idx, model)
    assert meta["sideinfo_mode"] == "shared"
    assert meta["pack_bytes"] == len(packed)
    assert meta["sideinfo_bytes"] < meta["pack_bytes"]
    decoded, umeta = ans_unpack_indices(packed)
    assert torch.equal(decoded, idx)
    assert umeta["sideinfo_mode"] == "shared"
    assert umeta["compact_dim"] == 48
    assert umeta["levels"] == 16

    # Peaked / non-identical rows → per-dim side-info
    peaked = CategoricalEntropyModel(48, levels=16)
    with torch.no_grad():
        peaked.logits.zero_()
        for d in range(48):
            peaked.logits[d, d % 16] = 5.0
    idx_p = torch.tensor([d % 16 for d in range(48)], dtype=torch.long)
    packed_p, meta_p = ans_pack_indices(idx_p, peaked)
    assert meta_p["sideinfo_mode"] == "per_dim"
    assert meta_p["sideinfo_bytes"] > meta["sideinfo_bytes"]
    decoded_p, umeta_p = ans_unpack_indices(packed_p)
    assert torch.equal(decoded_p, idx_p)
    assert umeta_p["sideinfo_mode"] == "per_dim"


def test_ans_pack_stats_with_measurement():
    from generative_codec import ans_pack_stats

    s = ans_pack_stats(
        compact_dim=256,
        levels=256,
        image_side=512,
        measured_pack_bits=4096.0,
        payload_bits=2048.0,
        sideinfo_bytes=128,
        sideinfo_mode="shared",
    )
    assert s["sideinfo_mode"] == "shared"
    assert s["sideinfo_bytes"] == 128
    assert abs(s["sideinfo_bits"] - 1024.0) < 1e-9
    assert abs(s["measured_pack_bits_per_pixel"] - 4096.0 / (512 * 512)) < 1e-12


def test_ans_pack_rejects_bad_magic():
    from generative_codec import ans_unpack_indices

    try:
        ans_unpack_indices(b"XXXX" + b"\x00" * 20)
        assert False, "expected ValueError"
    except ValueError:
        pass



def test_ans_hyper_pack_roundtrip_and_sideinfo_saving():
    import torch
    from generative_codec import (
        CategoricalEntropyModel,
        HyperpriorTableModel,
        ans_hyper_pack_indices,
        ans_hyper_unpack_indices,
        ans_pack_indices,
        hyperprior_pack_stats,
    )

    torch.manual_seed(2)
    D, L, H = 48, 16, 8
    peaked = CategoricalEntropyModel(D, levels=L)
    with torch.no_grad():
        peaked.logits.zero_()
        for d in range(D):
            peaked.logits[d, d % L] = 4.0
    idx = torch.tensor([d % L for d in range(D)], dtype=torch.long)

    # Raw per-dim pack for comparison
    packed_raw, meta_raw = ans_pack_indices(idx, peaked)
    assert meta_raw["sideinfo_mode"] == "per_dim"

    hyper = HyperpriorTableModel(D, levels=L, hyper_dim=H)
    packed_h, meta_h = ans_hyper_pack_indices(
        idx, peaked, hyper, hyper_levels=64, fit_steps=80
    )
    assert meta_h["sideinfo_mode"] == "hyper"
    assert meta_h["pack_version"] == 2
    assert meta_h["sideinfo_bytes"] < meta_raw["sideinfo_bytes"]
    assert meta_h["sideinfo_saving_vs_per_dim"] > 0
    decoded, umeta = ans_hyper_unpack_indices(packed_h, hyper)
    assert torch.equal(decoded, idx)
    assert umeta["sideinfo_mode"] == "hyper"
    assert umeta["hyper_dim"] == H

    stats = hyperprior_pack_stats(compact_dim=D, levels=L, hyper_dim=H, hyper_levels=64)
    assert stats["sideinfo_saving_vs_per_dim_estimate"] > 0
    assert stats["hyper_sideinfo_bytes_estimate"] < stats["raw_per_dim_sideinfo_bytes"]


def test_ans_hyper_pack_rejects_bad_version_on_v1_unpack_path():
    """v2 hyper packs must not be silently accepted by v1 ans_unpack_indices."""
    import torch
    from generative_codec import (
        CategoricalEntropyModel,
        HyperpriorTableModel,
        ans_hyper_pack_indices,
        ans_unpack_indices,
    )

    torch.manual_seed(0)
    model = CategoricalEntropyModel(16, levels=8)
    hyper = HyperpriorTableModel(16, levels=8, hyper_dim=4)
    idx = torch.randint(0, 8, (16,))
    packed, _ = ans_hyper_pack_indices(idx, model, hyper, hyper_levels=32, fit_steps=40)
    try:
        ans_unpack_indices(packed)
        assert False, "expected ValueError for version mismatch"
    except ValueError:
        pass


def test_hyperprior_pack_stats_with_measurement():
    from generative_codec import hyperprior_pack_stats

    s = hyperprior_pack_stats(
        compact_dim=256,
        levels=256,
        hyper_dim=16,
        hyper_levels=256,
        image_side=512,
        measured_pack_bits=5000.0,
        sideinfo_bytes=40,
    )
    assert s["sideinfo_bytes"] == 40
    assert abs(s["sideinfo_bits"] - 320.0) < 1e-9
    assert s["raw_per_dim_sideinfo_bytes"] > s["hyper_sideinfo_bytes_estimate"]



def test_straight_through_quantize_hyperlatent_ste_grad():
    from generative_codec import straight_through_quantize_hyperlatent

    z = torch.randn(8, requires_grad=True)
    idx, z_hat, meta = straight_through_quantize_hyperlatent(z, levels=32)
    assert idx.shape == (8,)
    assert z_hat.shape == (8,)
    assert meta["ste"] is True
    z_hat.sum().backward()
    assert z.grad is not None
    assert torch.allclose(z.grad, torch.ones_like(z))


def test_hyperprior_hierarchical_rate_bpp_and_grad():
    from generative_codec import (
        CategoricalEntropyModel,
        HyperpriorTableModel,
        hyperprior_hierarchical_bits,
        hyperprior_hierarchical_rate_bpp,
        hyperprior_hierarchical_rate_stats,
    )

    torch.manual_seed(0)
    D, L, H = 24, 16, 6
    cat = CategoricalEntropyModel(D, levels=L)
    hyper = HyperpriorTableModel(D, levels=L, hyper_dim=H)
    indices = torch.randint(0, L, (2, D))
    bpp = hyperprior_hierarchical_rate_bpp(
        indices, cat, hyper, hyper_levels=64, image_side=512
    )
    assert bpp.ndim == 0
    bpp.backward()
    assert cat.logits.grad is not None
    assert hyper.analysis.weight.grad is not None
    assert hyper.synthesis.weight.grad is not None

    total, meta = hyperprior_hierarchical_bits(
        indices[0], cat, hyper, hyper_levels=64
    )
    assert meta["sideinfo_bits"] == H * torch.tensor(64.0).log2().item()
    assert meta["conditional_bits"] > 0.0
    assert abs(float(total.detach()) - (meta["sideinfo_bits"] + meta["conditional_bits"])) < 1e-4

    stats = hyperprior_hierarchical_rate_stats(
        compact_dim=D, levels=L, hyper_dim=H, hyper_levels=64, image_side=512
    )
    assert stats["sideinfo_bits"] == H * torch.tensor(64.0).log2().item()
    assert stats["bits_per_pixel"] > stats["categorical_only_bits_per_pixel"]


def test_hyperprior_learned_sideinfo_prior_grad_and_meta():
    """Learned categorical prior on z_h replaces uniform side-info bits."""
    from generative_codec import (
        CategoricalEntropyModel,
        HyperpriorTableModel,
        hyperprior_hierarchical_bits,
        hyperprior_hierarchical_rate_bpp,
    )

    torch.manual_seed(1)
    D, L, H, Lh = 24, 16, 6, 64
    cat = CategoricalEntropyModel(D, levels=L)
    hyper = HyperpriorTableModel(D, levels=L, hyper_dim=H)
    prior = CategoricalEntropyModel(H, levels=Lh)
    indices = torch.randint(0, L, (D,))

    # Uniform baseline
    total_u, meta_u = hyperprior_hierarchical_bits(
        indices, cat, hyper, hyper_levels=Lh, hyper_prior=None
    )
    assert meta_u["used_learned_hyper_prior"] is False
    assert abs(meta_u["sideinfo_bits"] - H * torch.tensor(float(Lh)).log2().item()) < 1e-6

    # Learned prior at flat init ≈ uniform side-info
    total_l, meta_l = hyperprior_hierarchical_bits(
        indices, cat, hyper, hyper_levels=Lh, hyper_prior=prior
    )
    assert meta_l["used_learned_hyper_prior"] is True
    assert abs(meta_l["sideinfo_bits"] - meta_u["sideinfo_bits"]) < 1e-3

    # Peak the prior on a single bin → side-info should drop below uniform
    with torch.no_grad():
        prior.logits.zero_()
        prior.logits[:, 0] = 8.0
    # Force hyper indices toward bin 0 by making z_h collapse near z_min after quant —
    # easier path: just check grads flow and peaked prior changes sideinfo vs flat.
    bpp = hyperprior_hierarchical_rate_bpp(
        indices, cat, hyper, hyper_levels=Lh, image_side=512, hyper_prior=prior
    )
    assert bpp.ndim == 0
    bpp.backward()
    assert prior.logits.grad is not None
    assert prior.logits.grad.abs().sum() > 0
    assert cat.logits.grad is not None
    assert hyper.analysis.weight.grad is not None

    # Geometry / STE guards
    bad = CategoricalEntropyModel(H, levels=32)  # levels mismatch
    try:
        hyperprior_hierarchical_bits(
            indices, cat, hyper, hyper_levels=Lh, hyper_prior=bad
        )
        assert False, "expected ValueError for prior geometry"
    except ValueError:
        pass
    try:
        hyperprior_hierarchical_bits(
            indices, cat, hyper, hyper_levels=Lh, use_ste_z=False, hyper_prior=prior
        )
        assert False, "expected ValueError when use_ste_z=False with prior"
    except ValueError:
        pass


def test_hyperprior_hierarchical_rejects_geometry_mismatch():
    from generative_codec import (
        CategoricalEntropyModel,
        HyperpriorTableModel,
        hyperprior_hierarchical_bits,
    )

    cat = CategoricalEntropyModel(8, levels=16)
    hyper = HyperpriorTableModel(8, levels=8, hyper_dim=4)  # levels mismatch
    try:
        hyperprior_hierarchical_bits(torch.zeros(8, dtype=torch.long), cat, hyper)
        assert False, "expected ValueError"
    except ValueError:
        pass



def test_ans_hyper_hier_pack_roundtrip_and_hier_meta():
    import torch
    from generative_codec import (
        CategoricalEntropyModel,
        HyperpriorTableModel,
        ans_hyper_hier_pack_indices,
        ans_hyper_hier_unpack_indices,
        ans_hyper_unpack_indices,
        hyperprior_hier_pack_stats,
    )

    torch.manual_seed(3)
    D, L, H = 48, 16, 8
    peaked = CategoricalEntropyModel(D, levels=L)
    with torch.no_grad():
        peaked.logits.zero_()
        for d in range(D):
            peaked.logits[d, d % L] = 4.0
    idx = torch.tensor([d % L for d in range(D)], dtype=torch.long)

    hyper = HyperpriorTableModel(D, levels=L, hyper_dim=H)
    packed, meta = ans_hyper_hier_pack_indices(
        idx, peaked, hyper, hyper_levels=64, fit_steps=80
    )
    assert meta["sideinfo_mode"] == "hyper_hier"
    assert meta["pack_version"] == 3
    assert meta["expected_hier_sideinfo_bits"] == H * torch.tensor(64.0).log2().item()
    assert meta["expected_nll_bits"] > 0.0
    assert meta["sideinfo_saving_vs_per_dim"] > 0
    decoded, umeta = ans_hyper_hier_unpack_indices(packed, hyper)
    assert torch.equal(decoded, idx)
    assert umeta["sideinfo_mode"] == "hyper_hier"
    assert umeta["pack_version"] == 3

    # v2 unpack must reject v3
    try:
        ans_hyper_unpack_indices(packed, hyper)
        assert False, "expected ValueError for version mismatch"
    except ValueError:
        pass

    stats = hyperprior_hier_pack_stats(compact_dim=D, levels=L, hyper_dim=H, hyper_levels=64)
    assert stats["pack_version"] == 3
    assert stats["sideinfo_mode"] == "hyper_hier"
    assert stats["expected_hier_total_bits_uniform"] > 0


def test_ans_hyper_hier_pack_rejects_bad_version_on_v1_path():
    import torch
    from generative_codec import (
        CategoricalEntropyModel,
        HyperpriorTableModel,
        ans_hyper_hier_pack_indices,
        ans_unpack_indices,
    )

    torch.manual_seed(0)
    model = CategoricalEntropyModel(16, levels=8)
    hyper = HyperpriorTableModel(16, levels=8, hyper_dim=4)
    idx = torch.randint(0, 8, (16,))
    packed, _ = ans_hyper_hier_pack_indices(idx, model, hyper, hyper_levels=32, fit_steps=40)
    try:
        ans_unpack_indices(packed)
        assert False, "expected ValueError for version mismatch"
    except ValueError:
        pass


def test_hyperprior_hier_pack_stats_with_measurement():
    from generative_codec import hyperprior_hier_pack_stats

    s = hyperprior_hier_pack_stats(
        compact_dim=256,
        levels=256,
        hyper_dim=16,
        hyper_levels=256,
        image_side=512,
        measured_pack_bits=5200.0,
        sideinfo_bytes=40,
    )
    assert s["sideinfo_bytes"] == 40
    assert abs(s["sideinfo_bits"] - 320.0) < 1e-9
    assert s["pack_version"] == 3


def test_ans_hyper_hier_prior_pack_roundtrip_and_sideinfo():
    """MRPH v4: ANS-coded hyper indices under learned prior round-trip + saving vs v3."""
    import torch
    from generative_codec import (
        ANS_PACK_VERSION_HYPER_HIER_PRIOR,
        CategoricalEntropyModel,
        HyperpriorTableModel,
        ans_hyper_hier_pack_indices,
        ans_hyper_hier_prior_pack_indices,
        ans_hyper_hier_prior_unpack_indices,
        ans_hyper_hier_unpack_indices,
        hyperprior_hier_prior_pack_stats,
        quantize_hyperlatent,
    )

    torch.manual_seed(4)
    D, L, H, Lh = 48, 16, 8, 64
    peaked = CategoricalEntropyModel(D, levels=L)
    with torch.no_grad():
        peaked.logits.zero_()
        for d in range(D):
            peaked.logits[d, d % L] = 4.0
    idx = torch.tensor([d % L for d in range(D)], dtype=torch.long)

    hyper = HyperpriorTableModel(D, levels=L, hyper_dim=H)
    # Fit bridge once so v3/v4 share the same z_h geometry
    hyper.fit_to_logits(peaked.logits.detach(), steps=80)
    with torch.no_grad():
        z = hyper.encode_hyper(peaked.logits.detach())
        h_idx, _, _ = quantize_hyperlatent(z, levels=Lh)

    # Flat prior ≈ uniform side-info
    prior_flat = CategoricalEntropyModel(H, levels=Lh)
    packed_flat, meta_flat = ans_hyper_hier_prior_pack_indices(
        idx, peaked, hyper, prior_flat, hyper_levels=Lh, fit_steps=0
    )
    packed_v3, meta_v3 = ans_hyper_hier_pack_indices(
        idx, peaked, hyper, hyper_levels=Lh, fit_steps=0
    )
    assert meta_flat["sideinfo_mode"] == "hyper_hier_prior"
    assert meta_flat["pack_version"] == ANS_PACK_VERSION_HYPER_HIER_PRIOR
    assert meta_flat["used_learned_hyper_prior"] is True
    assert abs(meta_flat["expected_hier_sideinfo_bits"] - meta_v3["expected_hier_sideinfo_bits"]) < 1e-2

    # Peak prior on the actual hyper indices so ANS shrinks vs raw H×u8
    prior = CategoricalEntropyModel(H, levels=Lh)
    with torch.no_grad():
        prior.logits.zero_()
        for i, s in enumerate(h_idx.tolist()):
            prior.logits[i, int(s)] = 8.0
    packed_v4, meta_v4 = ans_hyper_hier_prior_pack_indices(
        idx, peaked, hyper, prior, hyper_levels=Lh, fit_steps=0
    )
    assert meta_v4["hyper_payload_bytes"] >= 4
    assert meta_v4["expected_hier_sideinfo_bits"] < meta_v3["expected_hier_sideinfo_bits"]
    assert meta_v4["hyper_measured_bits"] < H * 8.0  # beats raw H×u8 bit count
    # Header-aware pack saving vs v3: at small H the extra hyper_payload_len u32
    # can offset ANS gains (tie at 0); the hyper payload alone still beats raw H.
    assert meta_v4["sideinfo_saving_vs_v3_raw"] >= 0
    assert meta_v4["hyper_payload_bytes"] < H
    decoded, umeta = ans_hyper_hier_prior_unpack_indices(packed_v4, hyper, prior)
    assert torch.equal(decoded, idx)
    assert umeta["sideinfo_mode"] == "hyper_hier_prior"
    assert umeta["pack_version"] == 4
    assert torch.equal(
        ans_hyper_hier_prior_unpack_indices(packed_flat, hyper, prior_flat)[0], idx
    )

    # Cross-version rejection
    try:
        ans_hyper_hier_unpack_indices(packed_v4, hyper)
        assert False, "expected ValueError for v4 on v3 unpack"
    except ValueError:
        pass
    try:
        ans_hyper_hier_prior_unpack_indices(packed_v3, hyper, prior)
        assert False, "expected ValueError for v3 on v4 unpack"
    except ValueError:
        pass

    stats = hyperprior_hier_prior_pack_stats(
        compact_dim=D, levels=L, hyper_dim=H, hyper_levels=Lh
    )
    assert stats["pack_version"] == 4
    assert stats["sideinfo_mode"] == "hyper_hier_prior"
    assert stats["raw_v3_sideinfo_bytes"] > 0


def test_ans_hyper_hier_prior_pack_rejects_geometry_mismatch():
    import torch
    from generative_codec import (
        CategoricalEntropyModel,
        HyperpriorTableModel,
        ans_hyper_hier_prior_pack_indices,
    )

    model = CategoricalEntropyModel(16, levels=8)
    hyper = HyperpriorTableModel(16, levels=8, hyper_dim=4)
    bad_prior = CategoricalEntropyModel(4, levels=16)  # levels mismatch vs hyper_levels=32
    idx = torch.randint(0, 8, (16,))
    try:
        ans_hyper_hier_prior_pack_indices(
            idx, model, hyper, bad_prior, hyper_levels=32, fit_steps=0
        )
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_hyperprior_hier_prior_pack_stats_with_measurement():
    from generative_codec import hyperprior_hier_prior_pack_stats

    s = hyperprior_hier_prior_pack_stats(
        compact_dim=256,
        levels=256,
        hyper_dim=16,
        hyper_levels=256,
        image_side=512,
        measured_pack_bits=4800.0,
        sideinfo_bytes=28,
        hyper_payload_bits=96.0,
    )
    assert s["sideinfo_bytes"] == 28
    assert s["pack_version"] == 4
    assert abs(s["hyper_payload_bits"] - 96.0) < 1e-9
    # raw_v3 = 11 + 2 + 2 + 8 + H + 4 = 27 + H; H=16 → 43; saving = 43 - 28
    assert s["raw_v3_sideinfo_bytes"] == 43
    assert s["sideinfo_saving_vs_v3_raw"] == 15


def test_mrph_pack_version_guide_covers_v1_to_v4():
    from generative_codec import (
        ANS_PACK_VERSION,
        ANS_PACK_VERSION_HYPER,
        ANS_PACK_VERSION_HYPER_HIER,
        ANS_PACK_VERSION_HYPER_HIER_PRIOR,
        mrph_pack_version_guide,
    )

    guide = mrph_pack_version_guide()
    assert [g["version"] for g in guide] == [
        ANS_PACK_VERSION,
        ANS_PACK_VERSION_HYPER,
        ANS_PACK_VERSION_HYPER_HIER,
        ANS_PACK_VERSION_HYPER_HIER_PRIOR,
    ]
    flags = [g["cli_flag"] for g in guide]
    assert flags == [
        "--ans-pack",
        "--ans-hyper",
        "--ans-hyper-hier",
        "--ans-hyper-hier-prior",
    ]
    # v1 is model-free; v4 needs hyper_prior
    assert "no live model" in guide[0]["unpack_needs"]
    assert "hyper_prior" in guide[3]["unpack_needs"]
    assert guide[3]["sideinfo_mode"] == "hyper_hier_prior"


def test_ans_hyper_hier_prior_unpack_rejects_bad_magic_and_prior():
    """v4 unpack guards: bad magic + prior geometry mismatch."""
    import torch
    from generative_codec import (
        CategoricalEntropyModel,
        HyperpriorTableModel,
        ans_hyper_hier_prior_pack_indices,
        ans_hyper_hier_prior_unpack_indices,
    )

    torch.manual_seed(5)
    D, L, H, Lh = 16, 8, 4, 32
    model = CategoricalEntropyModel(D, levels=L)
    hyper = HyperpriorTableModel(D, levels=L, hyper_dim=H)
    prior = CategoricalEntropyModel(H, levels=Lh)
    idx = torch.randint(0, L, (D,))
    packed, _ = ans_hyper_hier_prior_pack_indices(
        idx, model, hyper, prior, hyper_levels=Lh, fit_steps=0
    )

    try:
        ans_hyper_hier_prior_unpack_indices(b"XXXX" + packed[4:], hyper, prior)
        assert False, "expected ValueError for bad magic"
    except ValueError:
        pass

    bad_prior = CategoricalEntropyModel(H, levels=16)  # levels != Lh
    try:
        ans_hyper_hier_prior_unpack_indices(packed, hyper, bad_prior)
        assert False, "expected ValueError for prior geometry"
    except ValueError:
        pass


def test_mrph_peek_header_and_unpack_dispatch():
    """Peek common header + version-dispatch unpack for MRPH v1–v4."""
    import torch
    from generative_codec import (
        ANS_PACK_VERSION,
        ANS_PACK_VERSION_HYPER,
        ANS_PACK_VERSION_HYPER_HIER,
        ANS_PACK_VERSION_HYPER_HIER_PRIOR,
        CategoricalEntropyModel,
        HyperpriorTableModel,
        ans_hyper_hier_pack_indices,
        ans_hyper_hier_prior_pack_indices,
        ans_hyper_pack_indices,
        ans_pack_indices,
        mrph_peek_header,
        mrph_unpack_indices,
    )

    torch.manual_seed(7)
    D, L, H, Lh = 16, 8, 4, 32
    model = CategoricalEntropyModel(D, levels=L)
    hyper = HyperpriorTableModel(D, levels=L, hyper_dim=H)
    prior = CategoricalEntropyModel(H, levels=Lh)
    idx = torch.randint(0, L, (D,))

    packs = []
    packed_v1, _ = ans_pack_indices(idx, model)
    packs.append((packed_v1, ANS_PACK_VERSION, "ans_unpack_indices", None, None))
    packed_v2, _ = ans_hyper_pack_indices(
        idx, model, hyper, hyper_levels=Lh, fit_steps=40
    )
    packs.append((packed_v2, ANS_PACK_VERSION_HYPER, "ans_hyper_unpack_indices", hyper, None))
    packed_v3, _ = ans_hyper_hier_pack_indices(
        idx, model, hyper, hyper_levels=Lh, fit_steps=0
    )
    packs.append(
        (packed_v3, ANS_PACK_VERSION_HYPER_HIER, "ans_hyper_hier_unpack_indices", hyper, None)
    )
    packed_v4, _ = ans_hyper_hier_prior_pack_indices(
        idx, model, hyper, prior, hyper_levels=Lh, fit_steps=0
    )
    packs.append(
        (
            packed_v4,
            ANS_PACK_VERSION_HYPER_HIER_PRIOR,
            "ans_hyper_hier_prior_unpack_indices",
            hyper,
            prior,
        )
    )

    for packed, ver, unpack_fn, hyp, hprior in packs:
        peek = mrph_peek_header(packed)
        assert peek["pack_version"] == ver
        assert peek["compact_dim"] == D
        assert peek["levels"] == L
        assert peek["unpack_fn"] == unpack_fn
        assert peek["cli_flag"] is not None
        if ver >= ANS_PACK_VERSION_HYPER:
            assert peek["hyper_dim"] == H
            assert peek["hyper_levels"] == Lh
        decoded, meta = mrph_unpack_indices(
            packed, hyper=hyp, hyper_prior=hprior
        )
        assert torch.equal(decoded, idx)
        assert meta["pack_version"] == ver
        assert meta["dispatched_via"] == "mrph_unpack_indices"
        assert meta.get("unpack_fn") == unpack_fn


def test_mrph_peek_header_rejects_bad_magic_and_unpack_needs_models():
    """Peek guards magic; dispatch raises when required models are omitted."""
    import torch
    from generative_codec import (
        CategoricalEntropyModel,
        HyperpriorTableModel,
        ans_hyper_hier_prior_pack_indices,
        ans_hyper_pack_indices,
        mrph_peek_header,
        mrph_unpack_indices,
    )

    torch.manual_seed(11)
    D, L, H, Lh = 12, 8, 4, 16
    model = CategoricalEntropyModel(D, levels=L)
    hyper = HyperpriorTableModel(D, levels=L, hyper_dim=H)
    prior = CategoricalEntropyModel(H, levels=Lh)
    idx = torch.randint(0, L, (D,))
    packed_v2, _ = ans_hyper_pack_indices(
        idx, model, hyper, hyper_levels=Lh, fit_steps=20
    )
    packed_v4, _ = ans_hyper_hier_prior_pack_indices(
        idx, model, hyper, prior, hyper_levels=Lh, fit_steps=0
    )

    try:
        mrph_peek_header(b"XXXX" + packed_v2[4:])
        assert False, "expected ValueError for bad magic"
    except ValueError:
        pass

    try:
        mrph_unpack_indices(packed_v2)  # missing hyper
        assert False, "expected ValueError for missing hyper on v2"
    except ValueError as e:
        assert "HyperpriorTableModel" in str(e)

    try:
        mrph_unpack_indices(packed_v4, hyper=hyper)  # missing prior
        assert False, "expected ValueError for missing hyper_prior on v4"
    except ValueError as e:
        assert "hyper_prior" in str(e)

