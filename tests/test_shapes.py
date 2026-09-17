"""Lightweight shape tests — no Stable Diffusion weights required."""

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
