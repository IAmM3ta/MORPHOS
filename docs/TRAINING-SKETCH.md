# Bottleneck training sketch

Companion to [`bottleneck_train_sketch.py`](../bottleneck_train_sketch.py).

## Goal

Today's `GenerativeCompressionCodec` ships **untrained** Linear mocks for
`16384 → compact_dim → 16384`. A production IMAGE_8 path keeps the SD VAE and
UNet **frozen** and learns only the bottleneck (or replaces it with a proper
learned codec) against reconstruction + rate.

## Sketch loop

```text
VAE encode (frozen) → flat latent
       ↓
  compression MLP   ← trainable
       ↓
  compact code (rate term)
       ↓
  decompression MLP ← trainable
       ↓
recon latent ──MSE──► target latent
       ↓ (later)
VAE decode / LPIPS / diffusion score term
```

| Term | Sketch | Production upgrade |
|------|--------|--------------------|
| Reconstruction | Latent MSE on flat codes | VAE-decoded L1/L2 + LPIPS; optional diffusion denoising score |
| Rate | FP32 bpp hinge, STE + uniform `log2(L)` (+ optional **`LearnedQuantAffine`**), factorized Laplace `--entropy-rate`, or **categorical** `--categorical-rate` | Hyperprior / ANS / bits-back — see [ENTROPY-CODING-NOTES.md](./ENTROPY-CODING-NOTES.md) |
| Data | `MockLatentBatch` Gaussian | Real `vae.encode` latents from image datasets |

## Run (CPU, no HF download)

```bash
pip install torch  # or full requirements.txt
PYTHONPATH=. python bottleneck_train_sketch.py --steps 8 --compact-dim 256
PYTHONPATH=. python bottleneck_train_sketch.py --steps 8 --ste-quant --quant-levels 256
PYTHONPATH=. python bottleneck_train_sketch.py --steps 8 --learned-quant-scales
PYTHONPATH=. python bottleneck_train_sketch.py --steps 8 --entropy-rate
PYTHONPATH=. python bottleneck_train_sketch.py --steps 8 --learned-quant-scales --entropy-rate
PYTHONPATH=. python bottleneck_train_sketch.py --steps 8 --categorical-rate --quant-levels 256
PYTHONPATH=. python bottleneck_train_sketch.py --steps 8 --categorical-rate --learned-quant-scales
PYTHONPATH=. pytest tests/test_train_sketch.py -q
```

## Out of scope (this sketch)

- Loading Diffusers / CUDA
- End-to-end img2img fine-tuning of the UNet
- ANS bitstream encode/decode (Laplace + categorical expected `-log2 p` landed; ANS later)

Those land in later cadence commits once the loop geometry is stable.
