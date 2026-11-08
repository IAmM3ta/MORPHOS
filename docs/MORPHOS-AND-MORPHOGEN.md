# MORPHOS and Morphogen

This repo holds two separate projects that share a workflow and a name. Neither imports the other.

| Artifact | Role |
|----------|------|
| **MORPHOS** (repo root codec) | Generative compression — tiny latent vector + SD prior (**not** RD pattern) |
| **Morphogen v2** (`morphogen-v2/`) | Living RD audiovisual instrument — **CPU Gray–Scott + Canvas 2D**, no WebGL |
| **Red-team** (`docs/morphogen-redteam/`) | Static + protocol (Elliot) + live UX findings → rebuild spec |

Live reference (v1/WebGL): https://morphogen-synth.grok.me

```bash
cd morphogen-v2 && npm install && npm run dev
```

## Where things live

A reading map for someone arriving cold. Paths are relative to the repo root.

### MORPHOS codec (Python, repo root)

| Path | What it is |
|------|------------|
| `generative_codec.py` | The IMAGE_8 pipeline: VAE encode → mock compressor → compact code → mock decompressor → VAE decode → SD img2img. Also the rate helpers (`rate_stats`, `quantized_rate_stats`, entropy models, rANS, MRPH pack / unpack). |
| `bottleneck_train_sketch.py` | CPU dry-run of the training loop for the bottleneck (STE quant, learned scales, entropy / categorical / hyperprior rate, ANS checks). Needs torch; downloads no model. |
| `docs/TRAINING-SKETCH.md` | The frozen-prior training plan the sketch follows. |
| `docs/ENTROPY-CODING-NOTES.md` | The rate ladder beyond FP32 and the MRPH v1–v4 wire formats. |
| `tests/test_shapes.py`, `tests/test_train_sketch.py` | Torch suites. They skip (with an install hint) when torch is missing. |

### Morphogen v2 (TypeScript, `morphogen-v2/`)

| Path | What it is |
|------|------------|
| `src/sim/` | The CPU Gray–Scott kernel and its parameter limits. |
| `src/render/` | Canvas 2D renderer (no WebGL; `npm run check:nowebgl` enforces it). |
| `src/audio/` | The Hum audio engine. |
| `src/app/` | The fixed-timestep frame loop. |
| `src/ui/` | Panels, HUD, keyboard shortcuts, pointer seeding, Field feed / kill sliders. |
| `src/sync/` | The TouchDesigner (TD) Sync client, URL checks, the TD → app command parser, and `freezeLease.ts` (the not-yet-wired lease helper for a future `freeze` command). |
| `src/main.ts` | Wires all of the above together. |
| `td/` | Reference TouchDesigner-side Python: the auth gate, command builders and callbacks. |
| `tests/` | Node tests (`npm test`) and the shared `fixtures/td-commands.v1.json` contract file. |

### Red-team notes (`docs/morphogen-redteam/`)

| File | Read it for |
|------|-------------|
| `MASTER-BRIEF.md` | The summary of every finding. Start here. |
| `REBUILD-SPEC.md` | What the no-WebGL rebuild must do. |
| `static-findings.md`, `elliot-protocol-findings.md`, `live-ux-findings.md` | The three evidence streams behind the brief. |
| `SYNC-AUTH.md` | The hello → ack handshake, reconnect backoff, status chip and URL allowlist. |
| `TD-COMMANDS.md` | The TD → app command channel: frames, limits, troubleshooting. |
| `FREEZE-REVIEW.md` | Design review for the still-refused `freeze` command: lease rules, every exit path, and the fixture-first order of work. |

## Checking your work

One command reproduces everything CI runs, and installs nothing into your Python:

```bash
./scripts/ci_local.sh          # python + node steps
./scripts/ci_local.sh python   # bare root pytest only
./scripts/ci_local.sh node     # npm ci, npm test, tsc --noEmit, check:nowebgl
```

A bare `pytest` at the root works without torch; the codec suites are then reported as skipped. Install `requirements.txt` to run them.

## Two contracts that are easy to break

- **TD ↔ browser commands.** The browser parser (`morphogen-v2/src/sync/tdCommand.ts`) and the TD sender (`morphogen-v2/td/morphogen_sync_commands.py`) are hand-written twins. Both are checked against `morphogen-v2/tests/fixtures/td-commands.v1.json`, so change the fixture row first, then both sides.
- **No WebGL.** Morphogen v2 stays CPU + Canvas 2D on purpose. A new dependency or call that touches WebGL fails `npm run check:nowebgl`.

Daily progress is logged in [STATUS.md](../STATUS.md); the README changelog has the longer write-ups.
