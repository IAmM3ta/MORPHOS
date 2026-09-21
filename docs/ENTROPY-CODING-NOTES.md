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
| Quantization | `quantize_uniform()` + `straight_through_quantize()` STE | Learned scales / soft quantization |
| Rate proxy | FP32 bpp or `log2(L)` × dim | Factorized / hyperprior entropy model |
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
`quantized_rate_penalty_bpp` (uniform `log2(L)` × dim). CLI: `--ste-quant`
`--quant-levels`.

## What to plug in next

1. **Factorized entropy model** (small MLP or histogram) → rate term ≈ mean
   `−log p(ẑ)` instead of the FP32 / uniform hinge.
2. **Hyperprior** (Ballé-style) if spatial structure returns (today's code is a
   flat vector).
3. **ANS encode/decode** only after the rate term is calibrated — bitstream
   plumbing is orthogonal to learning the bottleneck geometry.
4. **Learned quant scales** (per-channel) instead of fixed `[code_min, code_max]`.

## Out of scope (this note)

- Shipping a real ANS encoder
- Training an entropy model on image data
- Diffusers / CUDA weight download

Those stay for later cadence commits once quantization + rate geometry are
stabile in the CPU sketch.
