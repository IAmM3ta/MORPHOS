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
