"""
Generative Compression Codec — RedBot / IMAGE_8 workflow

Conceptual pipeline:
  Image -> VAE encode (high-dim latent) -> learned extreme compression (tiny vector)
       -> transmit compact code -> learned decompress to VAE-shaped latent
       -> diffusion decoder (prompt-guided) -> reconstructed image

This module is a research/demo scaffold. The Linear "compression" / "decompression"
networks are UNTRAINED placeholders. A production system would train them
end-to-end (or replace with a learned codec) against a reconstruction + rate loss.
"""

from __future__ import annotations

import argparse
from io import BytesIO
from typing import Optional, Union

import numpy as np
import requests
import torch
import torch.nn as nn
from PIL import Image
from torchvision import transforms


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_rgb_image(source: Union[str, Image.Image], size: int = 512) -> Image.Image:
    """Load an RGB image from a local path, URL, or PIL Image; resize to square."""
    if isinstance(source, Image.Image):
        img = source
    elif source.startswith("http://") or source.startswith("https://"):
        resp = requests.get(source, timeout=30)
        resp.raise_for_status()
        img = Image.open(BytesIO(resp.content))
    else:
        img = Image.open(source)
    return img.convert("RGB").resize((size, size), Image.Resampling.LANCZOS)


def make_fallback_image(size: int = 512) -> Image.Image:
    """Synthetic flower-like blob when no sample image is available."""
    img = Image.new("RGB", (size, size), (255, 200, 200))
    from PIL import ImageDraw

    draw = ImageDraw.Draw(img)
    draw.ellipse((size // 5, size // 5, 4 * size // 5, 4 * size // 5), fill=(100, 255, 100), outline=(0, 0, 0))
    return img


def preprocess_for_vae(image: Image.Image, device: torch.device, dtype: torch.dtype) -> torch.Tensor:
    """
    Map PIL RGB [0,255] -> NCHW float in [-1, 1], batch dim 1.
    Stable Diffusion VAE expects this range (not a nonexistent vae.preprocess).
    """
    to_tensor = transforms.Compose(
        [
            transforms.ToTensor(),  # [0, 1]
            transforms.Normalize([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]),  # [-1, 1]
        ]
    )
    tensor = to_tensor(image).unsqueeze(0).to(device=device, dtype=dtype)
    return tensor


# ---------------------------------------------------------------------------
# Codec
# ---------------------------------------------------------------------------

class GenerativeCompressionCodec:
    """
    Extremely lossy 'generative codec': ship a tiny vector; reconstruct with a
    frozen diffusion prior + optional text prompt.

    Latent geometry (SD 1.5, 512px): VAE latent is (1, 4, 64, 64) = 16384 floats.
    Compact code size defaults to 256 floats (~1 KB FP32) — illustrative only.
    """

    LATENT_C, LATENT_H, LATENT_W = 4, 64, 64
    FLAT_DIM = LATENT_C * LATENT_H * LATENT_W  # 16384
    # SD VAE latent scaling factor used by Diffusers when decoding
    VAE_SCALING_FACTOR = 0.18215

    def __init__(
        self,
        model_id: str = "runwayml/stable-diffusion-v1-5",
        device: Optional[str] = None,
        compact_dim: int = 256,
        dtype: torch.dtype = torch.float16,
    ):
        if device is None:
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = torch.device(device)
        # FP16 on CPU is a footgun; force FP32 there
        if self.device.type == "cpu":
            dtype = torch.float32
        self.dtype = dtype
        self.compact_dim = compact_dim

        print(f"Loading generative prior: {model_id} on {self.device} ({dtype})...")
        # Lazy import so `python -c "import generative_codec"` docs don't need GPU deps at import time in tests
        from diffusers import StableDiffusionPipeline

        self.pipe = StableDiffusionPipeline.from_pretrained(
            model_id,
            torch_dtype=dtype,
            safety_checker=None,
            requires_safety_checker=False,
        ).to(self.device)
        self.vae = self.pipe.vae
        self.vae.eval()

        # CONCEPTUAL learned extreme compressor / expander (UNTRAINED mocks).
        # Real systems learn these end-to-end; random weights here only show shapes.
        self.compression_model = nn.Sequential(
            nn.Linear(self.FLAT_DIM, 1024),
            nn.Tanh(),
            nn.Linear(1024, compact_dim),
        ).to(self.device)

        self.decompression_model = nn.Sequential(
            nn.Linear(compact_dim, 1024),
            nn.Tanh(),
            nn.Linear(1024, self.FLAT_DIM),
        ).to(self.device)

        # Keep mocks in FP32 for numerical stability of Linear layers
        self.compression_model.float()
        self.decompression_model.float()

    @torch.no_grad()
    def encode(self, image_input: Image.Image) -> torch.Tensor:
        """Image -> VAE latent -> compact vector (mock learned compression)."""
        print("--- ENCODE ---")
        print("1. VAE encode -> (1, 4, 64, 64) latent")
        img_tensor = preprocess_for_vae(image_input, self.device, self.dtype)
        posterior = self.vae.encode(img_tensor).latent_dist
        # Sample; scale the way Diffusers expects for the UNet
        latent = posterior.sample() * self.VAE_SCALING_FACTOR
        full_latent_flat = latent.flatten().float()

        print(f"2. Mock extreme compression -> ({self.compact_dim},) vector (NOT RD-pattern)")
        latent_code = self.compression_model(full_latent_flat)
        print(f"Encoded compact code shape: {tuple(latent_code.shape)}")
        return latent_code

    @torch.no_grad()
    def decode(
        self,
        latent_code_vector: torch.Tensor,
        prompt: str = "a detailed photo of a flower, high fidelity",
        num_inference_steps: int = 50,
        guidance_scale: float = 7.5,
        strength: float = 0.75,
        seed: Optional[int] = None,
    ) -> Image.Image:
        """
        Compact vector -> reconstructed VAE latent -> img2img-style diffusion decode.

        IMPORTANT: Feeding a reconstructed latent as `latents=` to text2img without
        adding noise / scheduling is incorrect for SD. We decode the latent to pixels
        with the VAE, then run img2img so the diffusion prior can re-synthesize.
        """
        print("\n--- DECODE ---")
        print("1. Mock decompress compact vector -> VAE-shaped latent")
        code = latent_code_vector.float().to(self.device)
        if code.ndim == 1:
            code = code.unsqueeze(0)
        reconstructed_flat = self.decompression_model(code)
        full_latent = reconstructed_flat.view(1, self.LATENT_C, self.LATENT_H, self.LATENT_W)
        # Unscale for VAE decode
        latents_for_vae = (full_latent / self.VAE_SCALING_FACTOR).to(dtype=self.dtype)

        print("2. VAE decode intermediate pixels (scaffold for diffusion prior)")
        decoded = self.vae.decode(latents_for_vae).sample
        decoded = (decoded / 2 + 0.5).clamp(0, 1)
        intermediate = transforms.ToPILImage()(decoded.squeeze(0).float().cpu())

        print("3. Diffusion img2img guided by prompt (generative reassembly)")
        generator = None
        if seed is not None:
            generator = torch.Generator(device=self.device).manual_seed(seed)

        # Prefer img2img pipeline path if available on the loaded pipe
        try:
            from diffusers import StableDiffusionImg2ImgPipeline

            img2img = StableDiffusionImg2ImgPipeline(
                vae=self.pipe.vae,
                text_encoder=self.pipe.text_encoder,
                tokenizer=self.pipe.tokenizer,
                unet=self.pipe.unet,
                scheduler=self.pipe.scheduler,
                safety_checker=None,
                feature_extractor=getattr(self.pipe, "feature_extractor", None),
                requires_safety_checker=False,
            ).to(self.device)
            result = img2img(
                prompt=prompt,
                image=intermediate,
                strength=strength,
                num_inference_steps=num_inference_steps,
                guidance_scale=guidance_scale,
                generator=generator,
            ).images[0]
        except Exception as exc:
            print(f"img2img path failed ({exc}); falling back to text2img (ignores latent content).")
            result = self.pipe(
                prompt=prompt,
                num_inference_steps=num_inference_steps,
                guidance_scale=guidance_scale,
                generator=generator,
            ).images[0]

        print("Decoded.")
        return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

DEFAULT_SAMPLE_URL = (
    "https://huggingface.co/datasets/huggingface/documentation-images/"
    "resolve/main/diffusers/inpaint_original.png"
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generative Compression Codec demo (IMAGE_8 workflow)")
    parser.add_argument("--image", default=DEFAULT_SAMPLE_URL, help="Local path or URL")
    parser.add_argument("--prompt", default="a detailed photo of a flower, high fidelity")
    parser.add_argument("--out-dir", default=".", help="Directory for original_input.png / generative_reassembled_output.png")
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--model-id", default="runwayml/stable-diffusion-v1-5")
    args = parser.parse_args()

    try:
        input_image = load_rgb_image(args.image)
        print("Loaded input image.")
    except Exception as e:
        print(f"Could not load image ({e}); using synthetic fallback.")
        input_image = make_fallback_image()

    codec = GenerativeCompressionCodec(model_id=args.model_id)
    compact_code = codec.encode(input_image)
    print(f"\n[Data stream: compact vector {tuple(compact_code.shape)} floats]")

    reconstructed = codec.decode(
        compact_code,
        prompt=args.prompt,
        num_inference_steps=args.steps,
        seed=args.seed,
    )

    import os

    os.makedirs(args.out_dir, exist_ok=True)
    in_path = os.path.join(args.out_dir, "original_input.png")
    out_path = os.path.join(args.out_dir, "generative_reassembled_output.png")
    input_image.save(in_path)
    reconstructed.save(out_path)
    print(f"Saved {in_path}")
    print(f"Saved {out_path}")
    print("Compare input vs generative reassembly — this codec is intentionally lossy.")


if __name__ == "__main__":
    main()
