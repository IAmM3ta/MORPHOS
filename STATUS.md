# MORPHOS status log

RedBot daily cadence notes for `IAmM3ta/MORPHOS`. Newest first.

## 2026-09-22 (09:00 ET — daily commit)

**Landed:** Factorized Laplace entropy-model rate term for the IMAGE_8 bottleneck sketch.

- Added `FactorizedEntropyModel` + `factorized_rate_stats()` in `generative_codec.py` (per-dim Laplace prior, differentiable `-log2 p` → bpp).
- Wired `--entropy-rate` / `--entropy-hinge` into `bottleneck_train_sketch` (joint train of prior + bottleneck; works with or without `--ste-quant`).
- Extended shape + train-sketch tests; updated `docs/ENTROPY-CODING-NOTES.md` and `docs/TRAINING-SKETCH.md`; README Changelog.

**Reviewed:** STE uniform quant path from 2026-09-21 remains intact. Morphogen v2 / red-team brief unchanged this pass.

**Next focus candidates:** learned quant scales, discrete categorical prior over STE indices, wire real VAE latents into the sketch, Morphogen Sync auth hello hardening.

## 2026-09-21 (09:00 ET — daily commit)

**Landed:** Straight-through estimator (STE) uniform quantization inside the bottleneck train sketch.

- Added `straight_through_quantize()` in `generative_codec.py` (hard forward = `quantize_uniform`, identity STE backward).
- Wired STE into `bottleneck_train_sketch.train_step` / `run_sketch_epochs` / CLI (`--ste-quant`, `--quant-levels`); rate hinge swaps to `quantized_rate_penalty_bpp`.
- Extended shape + train-sketch tests (STE forward match, grad pass-through, STE train step).
- Updated `docs/ENTROPY-CODING-NOTES.md` and `docs/TRAINING-SKETCH.md`; README Changelog.

**Reviewed:** Sep 20 cadence left STE drafts on the box but no GitHub commit landed (gap). Codified and pushed those changes today. Morphogen v2 / red-team brief unchanged this pass.

**Next focus candidates:** factorized entropy-model rate term, learned quant scales, wire real VAE latents into the sketch, Morphogen Sync auth hello hardening.

## 2026-09-20 (cadence gap)

Routine fired and reported success, but no commit reached `main`. STE/quant train-sketch work was staged locally and completed on 2026-09-21.

## 2026-09-19 (09:00 ET — daily commit)

**Landed:** Entropy / coding notes and a uniform-quantization rate sketch for IMAGE_8.

- Added `docs/ENTROPY-CODING-NOTES.md`: FP32 bpp vs discrete symbols vs ANS/bits-back ladder; how it plugs into the train sketch.
- Added `quantize_uniform()` and `quantized_rate_stats()` in `generative_codec.py` (plus `describe_quantized_rate` / CLI `--quant-levels`).
- Extended `tests/test_shapes.py` (quant round-trip, 8-bit uniform bpp math, levels guard).
- Linked entropy notes from `docs/TRAINING-SKETCH.md`; README Changelog updated.

**Reviewed (no change this pass):** Bottleneck train sketch + Morphogen v2 no-WebGL scaffold remain as previously landed.

**Next focus candidates:** STE/soft-quant inside `train_step`, factorized entropy-model rate term, wire real VAE latents into the sketch, Morphogen Sync auth hello hardening.

## 2026-09-18 (09:00 ET — daily commit)

**Landed:** Bottleneck training-loop sketch for the IMAGE_8 mock codec (no SD weight download).

- Added `bottleneck_train_sketch.py`: compressor/expander factory, latent MSE + illustrative FP32 bpp rate hinge, `MockLatentBatch`, `train_step` / `run_sketch_epochs`, and a CPU CLI dry-run.
- Added `docs/TRAINING-SKETCH.md` architecture notes (frozen VAE/prior; what to swap for production).
- Added `tests/test_train_sketch.py` (shapes, rate hinge under/over budget, closed train step).
- README Changelog + Quick start pointer updated.

**Reviewed (no change this pass):** Morphogen v2 no-WebGL scaffold and red-team brief; codec `rate_stats` / `--compact-dim` from 2026-09-17 remain the active rate demo.

**Next focus candidates:** wire real VAE latents into the sketch, entropy/coding notes, Morphogen Sync auth hello hardening.

## 2026-09-17 (09:00 ET — daily commit)

**Landed:** Illustrative rate accounting for the IMAGE_8 mock codec.

- Added `rate_stats()` and `GenerativeCompressionCodec.describe_rate()` documenting FP32 compact-code bytes and bits-per-pixel (no entropy coding — shape/demo only).
- Encode path now prints compact byte size and bpp alongside the vector shape.
- CLI gained `--compact-dim`; startup prints rate stats before encode.
- Expanded `tests/test_shapes.py` (PIL load path, latent constants, rate math) — still no SD weight download.

**Reviewed (no change this pass):** Morphogen v2 scaffold and red-team brief from earlier today remain the active RD / no-WebGL track; codec mocks stay untrained placeholders.

**Next focus candidates:** real bottleneck training loop sketch, entropy/coding notes, Morphogen Sync auth hello hardening.
