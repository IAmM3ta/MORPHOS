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
| Rate proxy | FP32 bpp, `log2(L)` × dim, factorized Laplace, or **categorical** `-log2 p(index)` | Hyperprior / autoregressive entropy model |
| Bitstream | None | ANS, arithmetic, or bits-back |

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

This is still **not** ANS — expected discrete codelength under the categorical.

## What to plug in next

1. **Hyperprior** (Ballé-style) if spatial structure returns (today's code is a
   flat vector).
2. **ANS encode/decode** only after the rate term is calibrated — bitstream
   plumbing is orthogonal to learning the bottleneck geometry.
3. **Wire real VAE latents** into the sketch (`MockLatentBatch` → encode).

## Out of scope (this note)

- Shipping a real ANS encoder
- Training an entropy model on image data
- Diffusers / CUDA weight download

Those stay for later cadence commits once quantization + rate geometry are
stabile in the CPU sketch.
