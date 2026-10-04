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
| Rate | FP32 bpp hinge, STE + uniform `log2(L)` (+ optional **`LearnedQuantAffine`**), factorized Laplace `--entropy-rate`, **categorical** `--categorical-rate`, **hierarchical hyperprior** `--hyper-rate` (+ optional **`--learned-hyper-prior`** on z_h), **tabled rANS** `--ans-check`, **ANS pack** `--ans-pack`, **hyperprior pack** `--ans-hyper` / **hier pack** `--ans-hyper-hier` / **hier+prior pack** `--ans-hyper-hier-prior` (MRPH v4) | Spatial hyperprior / bits-back / faster ANS — see [ENTROPY-CODING-NOTES.md](./ENTROPY-CODING-NOTES.md) |
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
PYTHONPATH=. python bottleneck_train_sketch.py --steps 8 --ans-check --quant-levels 256
PYTHONPATH=. python bottleneck_train_sketch.py --steps 8 --ans-pack --quant-levels 256
PYTHONPATH=. python bottleneck_train_sketch.py --steps 8 --ans-hyper --hyper-dim 16 --quant-levels 256
PYTHONPATH=. python bottleneck_train_sketch.py --steps 8 --ans-hyper-hier --hyper-dim 16 --quant-levels 256
PYTHONPATH=. python bottleneck_train_sketch.py --steps 8 --hyper-rate --ans-hyper-hier --hyper-dim 16 --quant-levels 256
PYTHONPATH=. python bottleneck_train_sketch.py --steps 8 --hyper-rate --hyper-dim 16 --quant-levels 256
PYTHONPATH=. python bottleneck_train_sketch.py --steps 8 --hyper-rate --learned-hyper-prior --hyper-dim 16 --quant-levels 256
PYTHONPATH=. python bottleneck_train_sketch.py --steps 8 --hyper-rate --learned-hyper-prior --ans-hyper-hier-prior --hyper-dim 16 --quant-levels 256
PYTHONPATH=. pytest tests/test_train_sketch.py -q
```

## MRPH pack flag cheat-sheet

See [ENTROPY-CODING-NOTES.md — MRPH pack versions](./ENTROPY-CODING-NOTES.md#mrph-pack-versions-v1v4--which-flag-when)
and `mrph_pack_version_guide()` / `mrph_peek_header()` /
`mrph_describe_header()` / `mrph_unpack_indices()` in `generative_codec.py`
for when to pick `--ans-pack` / `--ans-hyper` / `--ans-hyper-hier` /
`--ans-hyper-hier-prior` (v1–v4) and how to peek/describe/dispatch unpack by
wire version. Pack flags are mutually exclusive; pair v4 with
`--hyper-rate --learned-hyper-prior`. Sketch pack checks print the describe
line after round-trip.

## Out of scope (this sketch)

- Loading Diffusers / CUDA
- End-to-end img2img fine-tuning of the UNet
- Production multi-speed ANS / bits-back on real image latents

Those land in later cadence commits once the loop geometry is stable.
