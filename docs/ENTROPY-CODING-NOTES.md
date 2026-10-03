# Entropy / coding notes (IMAGE_8)

Companion to [`rate_stats()`](../generative_codec.py) and the
[bottleneck training sketch](./TRAINING-SKETCH.md).

## What we measure today

`rate_stats()` and the train-sketch rate hinge treat the compact code as **raw
FP32 floats**:

| Symbol | Meaning |
|--------|---------|
| `compact_dim` | Number of floats in the mock code |
| `compact_code_bytes` | `compact_dim × 4` |
| `bits_per_pixel` | `(compact_code_bytes × 8) / image_side²` |

That is a **shape/demo upper bound**, not a bitstream length. Real codecs
quantize, then entropy-code, so transmitted bits can be far below FP32.

## Ladder toward a coded rate

```text
continuous compact floats
        ↓  uniform / learned quantizer
discrete symbols (L levels per dim)
        ↓  entropy model p(z)
expected −log₂ p(z) bits  (or ANS/arithmetic bitstream)
        ↓
bits-per-pixel on the wire
```

| Stage | Scaffold today | Production upgrade |
|-------|----------------|--------------------|
| Continuous code | Mock MLP output | Same, or VQ / residual |
| Quantization | `quantize_uniform()` + STE + **`LearnedQuantAffine`** | Soft / residual / VQ refinements |
| Rate proxy | FP32 bpp, `log2(L)` × dim, factorized Laplace, **categorical** `-log2 p(index)`, or **hierarchical hyperprior** R(z_h)+R(index\|z) (+ optional **learned categorical prior on z_h**) | Spatial hyperprior / autoregressive entropy model |
| Bitstream | **tabled rANS** + **self-describing pack** + **hyperprior pack** (z_h side-info) + **hierarchical hyperprior pack** (MRPH v3) + **hier+prior pack** (MRPH v4; ANS-coded hyper indices) + **peek/dispatch** (`mrph_peek_header` / `mrph_unpack_indices`) | Multi-speed ANS, arithmetic, bits-back, spatial hyperprior |

## Uniform quantization sketch

`quantize_uniform(code, levels=L)` maps each float into one of `L` bins over a
range (data min/max or explicit bounds) and returns **dequantized** floats plus
meta (`levels`, `bits_per_symbol = log2(L)`).

`quantized_rate_stats(compact_dim, levels, image_side)` reports an illustrative
rate assuming every symbol costs exactly `log2(levels)` bits — still **not**
entropy coding, but closer to a discrete alphabet than raw FP32.

Example at 512² with `compact_dim=256`, `levels=256` (8-bit symbols):

- FP32 path: 1024 B → **0.03125 bpp**
- Uniform 8-bit symbols: 256 B → **0.0078125 bpp** (if every symbol used full 8 bits)

A learned entropy model that assigns fewer bits to likely symbols can go lower;
a poorly matched model can go higher than the uniform bound.

## STE in the train sketch

`straight_through_quantize(code, levels=L)` hard-quantizes in the forward pass
(same bins as `quantize_uniform`) and uses the identity STE so compressor
gradients still flow: `code + (q - code).detach()`.

`bottleneck_train_sketch.train_step(..., use_ste_quant=True)` inserts that
between compress and expand, and swaps the rate hinge to
`quantized_rate_penalty_bpp` (uniform `log2(L)` × dim) unless a factorized
entropy rate is also enabled. CLI: `--ste-quant` `--quant-levels`.

## Factorized Laplace entropy model

`FactorizedEntropyModel(compact_dim)` is a **fully factorized** Laplace prior
(independent learnable `loc` / `scale` per compact dimension) — a Ballé-style
sketch without a hyperprior.

- Per-dim NLL: `-log2 Laplace(z_i; μ_i, b_i) = log2(2b_i) + |z_i − μ_i| / (b_i ln 2)`
- `rate_bpp(code)` = mean batch sum of NLL bits / `image_side²`
- `factorized_rate_stats(...)` reports the untrained-init mode cost for docs/CLI

Wire-in: `bottleneck_train_sketch` `--entropy-rate` (optional `--entropy-hinge`)
trains the prior jointly with the bottleneck. Can combine with `--ste-quant`
(STE still runs in the forward path; the rate term becomes expected `-log2 p`
instead of the uniform hinge).

This is still **not** ANS — it is a differentiable expected-codelength proxy.

## Learned per-dim quant scales

`LearnedQuantAffine(compact_dim)` replaces fixed `[code_min, code_max]` with a
trainable per-dimension affine:

```text
y = (x − μ) / b          # b = softplus(log_scale) + eps
y_q = STE_uniform(y)     # fixed grid on [-1, 1], L levels
x̂ = y_q · b + μ
```

Identity STE on `y` lets gradients reach both the compressor and `(μ, b)`.
Alphabet size is unchanged (`log2(L)` × dim for the uniform rate hinge). CLI:
`bottleneck_train_sketch.py --learned-quant-scales` (implies STE). Combines with
`--entropy-rate` the same way fixed-bound STE does.

## Factorized categorical prior (STE indices)

`CategoricalEntropyModel(compact_dim, levels=L)` is a **fully factorized**
categorical prior over the discrete STE bin indices — closer to a real alphabet
than continuous Laplace-on-floats.

- Learnable `logits` shaped `(compact_dim, levels)` → per-dim `log_softmax`
- Rate: `-log2 Categorical(logits_i)[index_i]` summed / `image_side²`
- Untrained init is uniform → `log2(L)` bits/dim (matches `quantized_rate_stats`)
- `quantize_uniform` / STE meta expose `indices` (long tensor, same shape as code)
- Gradients update logits only; indices stay hard symbols from the STE forward

Wire-in: `bottleneck_train_sketch` `--categorical-rate` (implies STE; mutually
exclusive with `--entropy-rate`). Combines with `--learned-quant-scales` (indices
are on the normalized `y`-grid). Optional `--entropy-hinge` applies the same
hinge shape as the Laplace path.

This is still an **expected** discrete codelength under the categorical — see
the rANS section below for an actual bitstream.

## Tabled rANS bitstream (categorical indices)

`ans_encode_indices` / `ans_decode_indices` implement **byte-oriented tabled
rANS** (Fabian Giesen `ryg_rans` / `rans_byte.h` semantics) over the
factorized categorical PMFs:

1. Softmax logits → float PMF per compact dim.
2. Quantize each PMF to integer frequencies summing to `M = 2^12`.
3. Encode STE `indices` last→first; payload = LE 4-byte state + renorm bytes.
4. Decode forward; round-trip must match the index vector exactly.

Meta reports `measured_bits` (payload × 8) vs `expected_nll_bits` (`-log2 p`).
Under a flat prior the gap is mostly the 4-byte state flush (~32 bits). A peaked
prior shrinks both NLL and the bitstream together.

`ans_bitstream_stats(...)` documents expected vs measured bpp. CLI:
`bottleneck_train_sketch.py --ans-check` (implies `--categorical-rate`) runs one
encode/decode after the sketch and prints the meta line.

## Self-describing ANS pack (freq side-info)

`ans_pack_indices` / `ans_unpack_indices` wrap the rANS payload so decode does
**not** need a live `CategoricalEntropyModel`:

```text
MRPH | ver | scale_bits | D | L | mode | freqs… | payload_len | payload
```

- `mode=shared` when every dim shares one frequency row (uniform init, or a
  fully tied prior) — side-info is one `L × u16` table.
- `mode=per_dim` otherwise — `D × L × u16` tables travel with the bitstream.
- Meta reports `sideinfo_bytes`, `payload_bytes`, `measured_pack_bits`.

Honest rate = payload + side-info. A hyperprior pack (below) replaces raw freq
tables with a cheap quantized latent. CLI: `--ans-pack` (implies `--ans-check`).

## Hyperprior table side-info (flat-code sketch)

`HyperpriorTableModel` is a tiny analysis/synthesis bridge:

```text
categorical logits (D, L)
        ↓  analysis Linear
hyperlatent z_h ∈ R^H          (H ≪ D·L)
        ↓  uniform quant (L_h levels)
wire side-info: H × u8 (+ range)
        ↓  synthesis Linear (shared weights)
reconstructed logits → freq tables → rANS payload
```

`ans_hyper_pack_indices` / `ans_hyper_unpack_indices` use MRPH **v2** with
`sideinfo_mode=hyper`. Decode needs the shared `HyperpriorTableModel` (unlike
v1 raw freq packs). Meta reports `sideinfo_saving_vs_per_dim` against a v1
per-dim table of equal geometry. `hyperprior_pack_stats` documents the
illustrative comparison. CLI: `bottleneck_train_sketch.py --ans-hyper`
(implies `--ans-check` / categorical; exclusive with `--ans-pack`).

This is still a **factorized** table hyperprior for a flat vector — not a
spatial Ballé hyperprior over a latent feature map. Spatial structure lands
when real VAE latents replace `MockLatentBatch`.

## Hierarchical hyperprior rate (train-time)

Packing alone does not train the bridge. `hyperprior_hierarchical_rate_bpp`
is the differentiable Ballé-style sketch:

```text
categorical logits (D, L)
        ↓  analysis
z_h ∈ R^H
        ↓  STE uniform quant (L_h)
z_hat   →  side-info rate = H · log2(L_h)   (uniform alphabet; detached)
        ↓  synthesis
logits_hat → conditional rate = Σ -log2 p(index | z_hat)
```

Total expected bits ≈ side-info + conditional. Gradients update
`HyperpriorTableModel` and `CategoricalEntropyModel.logits` (via analysis).
CLI: `bottleneck_train_sketch.py --hyper-rate` (exclusive with
`--categorical-rate` / `--entropy-rate`; implies STE). Combine with
`--ans-hyper` after training to measure the pack under the same weights.

`hyperprior_hierarchical_rate_stats` documents the untrained-init cost
(uniform conditional + uniform side-info). A peaked synthesis lowers the
conditional term; pass `hyper_prior=` (CLI `--learned-hyper-prior`) to replace
uniform side-info with a trainable categorical prior on the hyper indices.

## Hierarchical hyperprior ANS pack (MRPH v3)

`ans_hyper_hier_pack_indices` / `ans_hyper_hier_unpack_indices` turn the
hierarchical rate path into a measured bitstream:

```text
categorical logits (D, L)
        ↓  analysis
z_h ∈ R^H
        ↓  uniform quant (L_h)
wire: H × u8 (+ range)          ← side-info
        ↓  synthesis
logits_hat → freq tables → rANS payload of STE indices
```

MRPH **v3** uses `sideinfo_mode=hyper_hier`. Unlike v2 (optional
`fit_to_logits` then pack), v3 follows analysis→quantize→synthesis so the
payload is conditioned on `z_hat` the same way as
`hyperprior_hierarchical_bits`. Meta reports hierarchical expected bits
(`R(z_h)+R(indices|z_hat)`) vs measured pack bits. Decode needs the shared
`HyperpriorTableModel`. CLI: `bottleneck_train_sketch.py --ans-hyper-hier`
(exclusive with `--ans-pack` / `--ans-hyper`; pairs cleanly with
`--hyper-rate` using `fit_steps=0`).

## Learned prior on quantized z_h (side-info rate)

By default `hyperprior_hierarchical_bits` charges a **uniform** side-info cost
`H · log2(L_h)` (detached). That matches an uninformative alphabet for the
quantized hyper indices and does not train anything about `p(z_h)`.

Pass `hyper_prior=CategoricalEntropyModel(hyper_dim, hyper_levels)` to replace
that constant with a **factorized categorical** NLL over the STE hyper indices:

```text
h_idx = STE_quantize(analysis(logits))   # alphabet size L_h
R(z_h) = Σ_i -log2 Categorical(hyper_prior.logits_i)[h_idx_i]
R = R(z_h) + R(indices | z_hat)
```

- Untrained init is flat → same expected cost as uniform `H · log2(L_h)`.
- Gradients update `hyper_prior.logits` only (hard hyper indices); analysis
  still gets gradients through the conditional term via STE on `z_hat`.
- Wire format for the **rate path** stays conceptual until packed; MRPH v3 still
  ships raw `H × u8` hyper indices. MRPH v4 (below) ANS-codes those indices
  under the learned prior.

CLI: `bottleneck_train_sketch.py --hyper-rate --learned-hyper-prior`
(requires `--hyper-rate`; trains `CategoricalEntropyModel(H, L_h)` jointly).

## Hierarchical + learned-prior ANS pack (MRPH v4)

`ans_hyper_hier_prior_pack_indices` / `ans_hyper_hier_prior_unpack_indices`
keep the hierarchical analysis→quantize→synthesis path from MRPH v3, but
replace raw `H × u8` hyper side-info with a **tabled rANS bitstream of the
hyper indices** under a shared `CategoricalEntropyModel(H, L_h)`:

```text
categorical logits (D, L)
        ↓  analysis
z_h ∈ R^H
        ↓  uniform quant (L_h)
h_idx → rANS under hyper_prior    ← ANS-coded side-info (not raw H×u8)
        ↓  synthesis
logits_hat → freq tables → rANS payload of STE indices
```

MRPH **v4** uses `sideinfo_mode=hyper_hier_prior`. Decode needs shared
`HyperpriorTableModel` **and** `hyper_prior` weights. Meta reports
`hyper_measured_bits` / `hyper_expected_nll_bits` alongside hierarchical
expected bits and savings vs v3 raw side-info. A flat prior ≈ uniform
`H · log2(L_h)` (+ small ANS state overhead); a peaked prior shrinks
measured hyper side-info below raw `H` bytes.

CLI: `bottleneck_train_sketch.py --ans-hyper-hier-prior`
(implies a hyper prior; pairs with `--hyper-rate --learned-hyper-prior`;
exclusive with `--ans-pack` / `--ans-hyper` / `--ans-hyper-hier`).


## MRPH pack versions (v1–v4) — which flag when

Self-describing packs share magic `MRPH` and bump `version` / `sideinfo_mode`.
Train-sketch pack flags are **mutually exclusive**. Prefer the highest version
that matches what you trained. Code mirror: `mrph_pack_version_guide()`.

| Ver | `sideinfo_mode` | CLI flag | Hyper / side-info on wire | Decode needs | Prefer when |
|-----|-----------------|----------|---------------------------|--------------|-------------|
| **v1** | `shared` / `per_dim` | `--ans-pack` | Raw freq tables (u16) | Pack only (model-free) | Simplest bitstream; no shared weights |
| **v2** | `hyper` | `--ans-hyper` | Raw `H × u8` z_h (+ range) | `HyperpriorTableModel` | Replace fat freq tables; optional `fit_to_logits` |
| **v3** | `hyper_hier` | `--ans-hyper-hier` | Raw `H × u8` z_h (+ range) | `HyperpriorTableModel` | Measured pack matching `--hyper-rate` (analysis→synth) |
| **v4** | `hyper_hier_prior` | `--ans-hyper-hier-prior` | rANS of H indices under `CategoricalEntropyModel(H, L_h)` | `HyperpriorTableModel` **+** `hyper_prior` | After `--hyper-rate --learned-hyper-prior`; peaked prior beats raw H×u8 |

**v3 vs v4 in one line:** same hierarchical analysis→quantize→synthesis path;
v3 ships raw hyper indices, v4 ANS-codes them under the learned prior.
Flat prior ≈ uniform `H · log2(L_h)` side-info (+ small ANS state); only a
**peaked** prior shrinks measured hyper payload below raw `H` bytes
(`meta["hyper_measured_bits"]`; header-aware `sideinfo_saving_vs_v3_raw`
may tie at 0 for tiny `H`).

Rate-only flags (no pack bump): `--hyper-rate` trains the bridge;
`--learned-hyper-prior` replaces uniform R(z_h) in the differentiable rate
term (wire still v3 until you pack with `--ans-hyper-hier-prior`).

## Header peek + version-dispatch unpack

`mrph_peek_header(packed)` reads the **common** MRPH prefix without decoding:

```text
magic[4]="MRPH" | version u8 | scale_bits u8 | D u16 | L u16 | sideinfo_mode u8
[+ hyper_dim u16 | hyper_levels u16 for v2+]
```

It returns geometry, named `sideinfo_mode`, and guide-aligned `unpack_fn` /
`unpack_needs` / `cli_flag` so a decoder can decide which shared weights to load
before unpacking.

`mrph_unpack_indices(packed, hyper=..., hyper_prior=...)` peeks then routes:

| Ver | Dispatch target | Required kwargs |
|-----|-----------------|-----------------|
| v1 | `ans_unpack_indices` | none |
| v2 | `ans_hyper_unpack_indices` | `hyper=` |
| v3 | `ans_hyper_hier_unpack_indices` | `hyper=` |
| v4 | `ans_hyper_hier_prior_unpack_indices` | `hyper=` + `hyper_prior=` |

Missing models raise a clear `ValueError` (no silent fall-through). Meta includes
`dispatched_via="mrph_unpack_indices"`. **No wire-format change** — this is a
caller convenience on top of the existing v1–v4 unpackers.

## What to plug in next

1. **Wire real VAE latents** into the sketch (`MockLatentBatch` → encode).
2. **Spatial hyperprior** once the code is a feature map, not a flat vector.
3. Faster / multi-speed rANS on real latents; bits-back refinements.

## Out of scope (this note)

- Training an entropy model on image data
- Diffusers / CUDA weight download
- Production multi-speed / AVX ANS

Those stay for later cadence commits once the CPU sketch is on real latents.
