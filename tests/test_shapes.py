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
