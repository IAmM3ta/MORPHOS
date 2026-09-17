# Morphogen v2

First-principles rebuild of the Morphogen live AV instrument.

**Hard rule: no GPU canvas contexts (2D only).** Simulation is CPU Gray–Scott; display is Canvas 2D `putImageData`.

## Architecture (10 lines)

1. **Sim** — `src/sim/grayScott.ts`: Float32 U/V buffers, portable JS kernel, worker-ready API (main-thread demo for now).
2. **Render** — `src/render/canvas2d.ts`: palette map → `ImageData` → `putImageData` only.
3. **Audio** — `src/audio/hum.ts`: Schumann-inspired Hum; unlock on gesture; limiter; **`dispose()` on teardown**.
4. **Sync** — `src/sync/tdClient.ts`: paths **A** companion `http://127.0.0.1` + `ws://`, **B** MIDI-only on HTTPS, **C** auth `wss`; hello includes `auth`.
5. **UI** — panel stubs Field / Image / Body / Sound / Sync; explicit Lock loop; Reset confirm; `?perform=1`.
6. **Privacy** — gyro opt-in / mic+Sync consent / camera perf mode specified in REBUILD-SPEC (stubs here).
7. **Fonts** — system stack only (no Google Fonts).
8. **PWA** — `manifest.webmanifest` name **Morphogen**.
9. **Parity** — presets table + MIDI CC map + Sync JSON shape documented in `/workspace/morphogen-redteam/REBUILD-SPEC.md`.
10. **Verify** — `npm run check:nowebgl` or `rg -i 'webgl|webgpu|getContext\(\x27webgl' src` must find nothing.

## Docs

- Master findings: `/workspace/morphogen-redteam/MASTER-BRIEF.md`
- Rebuild spec: `/workspace/morphogen-redteam/REBUILD-SPEC.md`

## Develop

```bash
cd /workspace/morphogen-v2
npm install
npm run dev
```

Open `http://127.0.0.1:5173` → ENTER → click/drag to seed colonies.

```bash
npm run build
npm run check:nowebgl
```

## Operator kill-list

- iOS Safari + cleartext Sync from HTTPS page  
- iOS WebMIDI  
- Remote phone → cleartext TD without companion (A) or wss (C)  
- Unauthenticated multi-client TD server  

## Non-goals (v1)

GPU canvas contexts, multiplayer rooms, 2160px CPU parity, cloud Sync SaaS, bidirectional TD control (hooks only).
