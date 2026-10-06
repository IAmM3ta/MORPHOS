# Morphogen v2

First-principles rebuild of the Morphogen live AV instrument.

**Hard rule: no GPU canvas contexts (2D only).** Simulation is CPU Gray–Scott; display is Canvas 2D `putImageData`.

## Architecture (10 lines)

1. **Sim** — `src/sim/grayScott.ts`: Float32 U/V buffers, portable JS kernel, worker-ready API (main-thread demo for now).
2. **Render** — `src/render/canvas2d.ts`: palette map → `ImageData` → `putImageData` only.
3. **Audio** — `src/audio/hum.ts`: Schumann-inspired Hum; unlock on gesture; limiter; **`dispose()` on teardown**.
4. **Sync** — `src/sync/tdClient.ts`: paths **A** companion `http://127.0.0.1` + `ws://`, **B** MIDI-only on HTTPS, **C** auth `wss`; hello includes `auth`, telemetry waits for TD's `{ack, ok:true}` (2 s timeout); transient drops reconnect with jittered exponential backoff (auth rejects never retry).
5. **UI** — panel stubs Field / Image / Body / Sound / Sync; explicit Lock loop; Reset confirm; `?perform=1`.
6. **Privacy** — gyro opt-in / mic+Sync consent / camera perf mode specified in REBUILD-SPEC (stubs here).
7. **Fonts** — system stack only (no Google Fonts).
8. **PWA** — `manifest.webmanifest` name **Morphogen**.
9. **Parity** — presets table + MIDI CC map + Sync JSON shape documented in [`docs/morphogen-redteam/REBUILD-SPEC.md`](../docs/morphogen-redteam/REBUILD-SPEC.md).
10. **Verify** — `npm run check:nowebgl` or `rg -i 'webgl|webgpu|getContext\(\x27webgl' src` must find nothing.

## Docs

- Master findings: [`docs/morphogen-redteam/MASTER-BRIEF.md`](../docs/morphogen-redteam/MASTER-BRIEF.md)
- Rebuild spec: [`docs/morphogen-redteam/REBUILD-SPEC.md`](../docs/morphogen-redteam/REBUILD-SPEC.md)
- Sync auth handshake: [`docs/morphogen-redteam/SYNC-AUTH.md`](../docs/morphogen-redteam/SYNC-AUTH.md)

## TouchDesigner side (Sync auth)

`td/` holds the TD half of the C2 fix:

- `td/morphogen_sync_auth.py` — pure-Python `SyncAuthGate` (no TD imports): first frame must be a valid hello, constant-time secret compare, ±30 s timestamp window, 64 KB frame cap, drop after 3 bad hellos, per-client state cleared on disconnect. Tests: `pytest tests/test_td_sync_auth.py` from the repo root.
- `td/morphogen_sync_callbacks.py` — WebSocket DAT callbacks that route every frame through the gate and only then write `morphogen_table` / `morphogen_grid`. Set the secret as a custom string par `Syncsecret` on the parent COMP; an unset or short secret fails closed (all clients refused).

Browser side: `td.setAuth('<same secret>')` before `connect()`.

## Develop

```bash
cd morphogen-v2
npm install
npm run dev
```

Open `http://127.0.0.1:5173` → ENTER → click/drag to seed colonies.

```bash
npm run build
npm run check:nowebgl
npm test            # Sync client: handshake + reconnect backoff (node:test, fake WebSocket)
```

## Operator kill-list

- iOS Safari + cleartext Sync from HTTPS page  
- iOS WebMIDI  
- Remote phone → cleartext TD without companion (A) or wss (C)  
- Unauthenticated multi-client TD server (fixed by `td/` gate — keep the secret out of git)  

## Non-goals (v1)

GPU canvas contexts, multiplayer rooms, 2160px CPU parity, cloud Sync SaaS, bidirectional TD control (hooks only).
