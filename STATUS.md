# MORPHOS status log

RedBot daily cadence notes for `IAmM3ta/MORPHOS`. Newest first.

## 2026-09-26 (09:00 ET — daily commit)

**Landed:** Self-describing ANS pack (freq side-info + rANS payload) for the IMAGE_8 bottleneck bitstream.

- Added `ans_pack_indices` / `ans_unpack_indices` / `ans_pack_stats` in `generative_codec.py` (MRPH v1 wire format; shared vs per-dim frequency tables).
- Decode no longer needs a live `CategoricalEntropyModel` — tables travel with the pack; meta reports side-info vs payload bits.
- Wired `--ans-check` and `--ans-pack` into `bottleneck_train_sketch` CLI (pack implies check; both imply `--categorical-rate`).
- Extended shape + train-sketch tests; updated `docs/ENTROPY-CODING-NOTES.md` and `docs/TRAINING-SKETCH.md`; README Changelog.

**Reviewed:** Tabled rANS + CategoricalEntropyModel + LearnedQuantAffine paths from 2026-09-23–25 remain intact. Morphogen v2 / red-team brief unchanged this pass.

**Next focus candidates:** hyperprior notes (replace raw freq side-info), wire real VAE latents into the sketch, Morphogen Sync auth hello hardening.

## 2026-09-25 (09:00 ET — daily commit)

**Landed:** Tabled rANS encode/decode over categorical STE indices for the IMAGE_8 bottleneck (bitstream after NLL).

- Added byte-oriented rANS (`ans_encode_symbols` / `ans_decode_symbols`, ryg_rans semantics) plus `ans_encode_indices` / `ans_decode_indices` / `ans_bitstream_stats` in `generative_codec.py`.
- PMF→frequency tables (`_pmf_to_freqs`, `M=2^12`); measured bitstream bits vs categorical `-log2 p`.
- Wired `--ans-check` into `bottleneck_train_sketch` (implies `--categorical-rate`); round-trip demo after the sketch.
- Extended shape + train-sketch tests; updated `docs/ENTROPY-CODING-NOTES.md` and `docs/TRAINING-SKETCH.md`; README Changelog.

**Reviewed:** CategoricalEntropyModel + LearnedQuantAffine + factorized Laplace paths from 2026-09-22–24 remain intact. Morphogen v2 / red-team brief unchanged this pass.

**Next focus candidates:** hyperprior notes (if spatial structure returns), wire real VAE latents into the sketch, Morphogen Sync auth hello hardening.

## 2026-09-24 (09:00 ET — daily commit)

**Landed:** Discrete factorized categorical prior over STE indices (`CategoricalEntropyModel`) for the IMAGE_8 bottleneck rate path.

- Added `CategoricalEntropyModel` + `categorical_rate_stats` in `generative_codec.py` (logits `(D, L)` → `-log2 Categorical` bpp).
- `quantize_uniform` / STE meta now expose integer `indices` for the discrete alphabet.
- Wired `--categorical-rate` into `bottleneck_train_sketch` (implies STE; exclusive with `--entropy-rate`; works with `--learned-quant-scales`).
- Extended shape + train-sketch tests; updated `docs/ENTROPY-CODING-NOTES.md` and `docs/TRAINING-SKETCH.md`; README Changelog.

**Reviewed:** LearnedQuantAffine + factorized Laplace paths from 2026-09-22/23 remain intact. Morphogen v2 / red-team brief unchanged this pass.

**Next focus candidates:** hyperprior notes (if spatial structure returns), wire real VAE latents into the sketch, ANS encode/decode after rate calibration, Morphogen Sync auth hello hardening.

## 2026-09-23 (09:00 ET — daily commit)

**Landed:** Learned per-dimension quant scales (`LearnedQuantAffine`) for the IMAGE_8 bottleneck STE path.

- Added `LearnedQuantAffine` in `generative_codec.py`: per-dim loc / softplus scale → STE uniform on [-1, 1] → inverse affine (replaces fixed `[code_min, code_max]`).
- Wired `--learned-quant-scales` into `bottleneck_train_sketch` (implies STE; trainable affine params in the Adam set; works with `--entropy-rate`).
- Extended shape + train-sketch tests; updated `docs/ENTROPY-CODING-NOTES.md` and `docs/TRAINING-SKETCH.md`; README Changelog.

**Reviewed:** Factorized Laplace entropy path from 2026-09-22 remains intact. Morphogen v2 / red-team brief unchanged this pass.

**Next focus candidates:** discrete categorical prior over STE indices, hyperprior notes, wire real VAE latents into the sketch, Morphogen Sync auth hello hardening.

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
