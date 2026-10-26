# Morphogen v2

First-principles rebuild of the Morphogen live AV instrument.

**Hard rule: no GPU canvas contexts (2D only).** Simulation is CPU Gray–Scott; display is Canvas 2D `putImageData`.

## Architecture (11 lines)

1. **Sim** — `src/sim/grayScott.ts`: Float32 U/V buffers, portable JS kernel, worker-ready API (main-thread demo for now). Every param update goes through `sanitizeParams` (`PARAM_LIMITS`), `step(dt)` clamps dt to `maxStableDt` (D·dt ≤ 1/4) and NaN cells are scrubbed to 0.
2. **Render** — `src/render/canvas2d.ts`: precomputed 256-step `PALETTE_LUT` → `ImageData` → `putImageData` only; `fieldTone` maps NaN cells to background, `fieldToRGBA` never reads past short buffers, `resize` coerces sizes to integers ≥ 1.
3. **Audio** — `src/audio/hum.ts`: Schumann-inspired Hum; unlock on gesture; compressor + limiter; master gain capped at `HUM_LEVEL_ON` with anchored ramps; mute remembered across unlock; `modulate()` NaN-safe and only schedules on a real detune change; **`dispose()` on teardown** disconnects every node.
4. **Sync** — `src/sync/tdClient.ts`: paths **A** companion `http://127.0.0.1` + `ws://`, **B** MIDI-only on HTTPS, **C** auth `wss`; hello includes `auth`, telemetry waits for TD's `{ack, ok:true}` (2 s timeout); transient drops reconnect with jittered exponential backoff (auth rejects never retry); footer Sync chip shows state + live retry countdown with a budget-respecting **Retry now**. `src/sync/syncUrl.ts` sanitises every URL, enforces the `127.0.0.1` / `localhost` / `*.local` allowlist (other wss hosts need a per-session confirm) and schema-checks the persisted Sync record (no secret stored). `src/sync/tdCommand.ts`: the TD → app control plane — once TD has acked the authed hello, it can send `{v:1, cmd:"preset", id:"coral"}` to switch the Field preset (same `createPresetCycler().set` path as the button; unknown ids are a no-op; status line adds `· from TD`) or `{v:1, cmd:"ping", t}` to get `{v:1, pong:"morphogen", t}` back for latency checks. Frames are size-capped (512 B), shape-checked and rate-limited (10/s, burst 5); `setParams` / `freeze` are reserved and refused until they get their own limits review; junk or over-rate frames are dropped without touching the session. Since 2026-10-24 each drop is still silent but counted: `td.commandStats()` tallies applied / pings / refused / paced frames (plus handler errors) per authed session, and `describeCommandStats` turns that into one line, shown in the `?debug=1` snapshot as `tdCommands`. Since 2026-10-26 the same line is on screen: `mountSyncCommandLine` (`src/ui/panels.ts`) shows a `#syncCmds` chip next to the Sync chip only while the session is authed (hidden when off, connecting or dropped, so a stale tally never looks live), refreshes it once a second (no timer when Sync is off) and turns it amber when any frame was refused, paced or threw — read it beside TD's `send_stats_line()` without opening devtools.
5. **UI** — `src/ui/field.ts`: the **Field** panel button steps through the 10 Gray–Scott presets (Shift-click or **[** steps back, **]** steps forward; `presetStepDir` maps the click) (Mitosis → Solitons → Pulsing → Holes → Mazes → Fingerprint → Spirals → Worms → Coral → Skate, wrapping) in a fixed `PRESET_ORDER`; each preset goes through `GrayScott.setParams` (so `sanitizeParams` still guards it) without clearing the field, and the status line shows e.g. `Field: Coral (9/10) · feed 0.0545 · kill 0.0620`. `?preset=<id>` picks the boot preset (case-insensitive; unknown ids fall back to Mitosis); `createPresetCycler` only updates its label after the kernel accepted the params. `src/ui/panels.ts`: panel stubs Image / Body / Sound / Sync routed by `resolvePanelAction` (clicks on a button's children still land, unknown `data-panel` ids and disabled controls are ignored); explicit Lock loop capped at `LOOP_MAX` = 4 (`nextLockCount`); Reset asks to confirm only when loops are locked (`resetNeedsConfirm`); **Hum on / Hum muted** button (`#muteHum`, `aria-pressed`) wired to `HumEngine.setMuted`, safe before ENTER; `?perform=1`. `src/ui/keys.ts`: keyboard shortcuts **M** = mute, **L** = lock loop, **]** / **[** = next / previous Field preset (same code path as the buttons, advertised via `aria-keyshortcuts`); ignored while typing in a text field, on Ctrl / Cmd / Alt chords, on auto-repeat and during IME composition; Reset stays click-only. `src/ui/pointer.ts`: click/drag seeding with primary-pointer-only capture, zero-size-rect guard (no NaN into `sim.seed`), continuous stroke interpolation (`strokePoints`, capped at `STROKE_MAX_POINTS`) and `lostpointercapture` teardown so a stolen capture can't leave painting stuck. `src/ui/hud.ts`: the footer HUD (energy · meanV · loops) is formatted NaN-safely (`formatStat` shows `—` instead of NaN / Infinity and never prints `-0.000`; `formatLockCount` clamps junk counts to 0) and written by `createHudWriter` at most every `HUD_INTERVAL_MS` = 100 ms and only when the text changed; Lock loop / Reset call `invalidate()` so the new count shows on the next frame.
6. **Loop** — `src/app/loop.ts`: the sim runs at a fixed `SIM_HZ` = 120 kernel steps/s whatever the display rate (`paceSteps` fixed-timestep accumulator; 2 steps per frame at 60 Hz, 1 at 120 Hz), capped at `MAX_STEPS_PER_FRAME` = 4 so a slow device or a tab return slows the field instead of bursting (backlog dropped, never replayed); duplicate / backwards rAF timestamps run 0 steps. `createFrameLoop` keeps one rAF chain (idempotent start/stop, clock reset on restart, a throwing frame doesn't freeze the loop). `singleFlightUnlock` shares one Hum unlock between ENTER and a first canvas press, and a rejecting `AudioContext.resume()` resolves false so the sim still starts silently.
7. **Privacy** — gyro opt-in / mic+Sync consent / camera perf mode specified in REBUILD-SPEC (stubs here).
8. **Fonts** — system stack only (no Google Fonts).
9. **PWA** — `manifest.webmanifest` name **Morphogen**.
10. **Parity** — presets table + MIDI CC map + Sync JSON shape documented in [`docs/morphogen-redteam/REBUILD-SPEC.md`](../docs/morphogen-redteam/REBUILD-SPEC.md).
11. **Verify** — `npm run check:nowebgl` or `rg -i 'webgl|webgpu|getContext\(\x27webgl' src` must find nothing.

## Docs

- Master findings: [`docs/morphogen-redteam/MASTER-BRIEF.md`](../docs/morphogen-redteam/MASTER-BRIEF.md)
- Rebuild spec: [`docs/morphogen-redteam/REBUILD-SPEC.md`](../docs/morphogen-redteam/REBUILD-SPEC.md)
- Sync auth handshake: [`docs/morphogen-redteam/SYNC-AUTH.md`](../docs/morphogen-redteam/SYNC-AUTH.md)

## TouchDesigner side (Sync auth)

`td/` holds the TD half of the C2 fix:

- `td/morphogen_sync_auth.py` — pure-Python `SyncAuthGate` (no TD imports): first frame must be a valid hello, constant-time secret compare, ±30 s timestamp window, 64 KB frame cap, drop after 3 bad hellos, per-client state cleared on disconnect. Tests: `pytest tests/test_td_sync_auth.py` from the repo root.
- `td/morphogen_sync_callbacks.py` — WebSocket DAT callbacks that route every frame through the gate and only then write `morphogen_table` / `morphogen_grid`. Set the secret as a custom string par `Syncsecret` on the parent COMP; an unset or short secret fails closed (all clients refused). Since 2026-10-22 it also exposes `send_preset(dat, id)` / `send_ping(dat)` for TD → app cues and routes returning pongs to an optional `morphogen_rtt` Table DAT (`last_ms`, `median_ms`, `samples`) instead of the telemetry table. Since 2026-10-25 every send attempt is tallied (`SendStats`: sent presets / pings, paced out, no authed client) into an optional `morphogen_cmds` Table DAT, `send_stats_line()` gives a one-liner (`TD sent: 5 presets · 1 paced`) to read beside the browser's `tdCommands` debug line, and a paced-out ping is no longer left pending in the RTT tracker.
- `td/morphogen_sync_commands.py` — pure-Python twin of `src/sync/tdCommand.ts`: `make_preset_command` / `make_ping_command` (same id normalisation and 512-byte cap as the browser), `PRESET_IDS` (test-checked against `PRESET_ORDER`), `CommandPacer` (same 10/s, burst-5 token bucket so TD never sends frames the browser would drop), `RttTracker` (only pongs echoing a ping this TD sent count), `classify_inbound`. Tests: `pytest tests/test_td_sync_commands.py`.
- `tests/fixtures/td-commands.v1.json` — golden **TD ↔ browser contract** (since 2026-10-23): the exact bytes the TD builders emit, what the browser must parse them to, frames the browser must refuse, the pong reply shape, and a shared clock script for the 10/s burst-5 rate bucket. Both `tests/tdContract.test.mjs` (`npm test`) and `../tests/test_td_sync_contract.py` (`pytest`) read it, so if either twin changes its rules without the other, a test fails instead of frames silently being dropped live. Change the fixture first, then make both suites pass.

Browser side: `td.setAuth('<same secret>')` before `connect()`.

## Develop

```bash
cd morphogen-v2
npm install
npm run dev
```

Open `http://127.0.0.1:5173` → ENTER → click/drag to seed colonies (fast drags are stroked continuously; only the primary pointer paints). Press **M** to mute / unmute the Hum and **L** to lock a loop. Click **Field** (or press **]**) to step to the next preset, Shift-click it (or press **[**) to step back, or boot straight into one with `?preset=coral` (ids: `mitosis`, `solitons`, `pulsing`, `holes`, `mazes`, `fingerprint`, `spirals`, `worms`, `coral`, `uskate`).

```bash
npm run build
npm run check:nowebgl
npm test            # Field presets (order / wrap, Shift-click back-step, sanitised params, ?preset= parsing, apply-then-commit cycler) + HUD (NaN-safe formatting, 10 Hz change-only writer) + Frame loop (display-rate-independent pacing, step cap, single-flight unlock) + Pointer seeding (rect guard, stroke interp, primary-only) + Keyboard shortcuts incl. ] / [ preset keys (text-field / chord / repeat guards) + Panel routing + Sound mute toggle (loop cap, reset confirm, ancestor walk) + Canvas 2D renderer (palette LUT, NaN-safe tone, bounded fill, safe resize) + Hum audio safety (fake AudioContext) + Gray–Scott kernel guards (param clamp, dt stability, NaN containment) + Sync client, status chip + URL hygiene: handshake, backoff, countdown/retry-now, allowlist, persisted settings (node:test, fake WebSocket)
```

## Operator kill-list

- iOS Safari + cleartext Sync from HTTPS page  
- iOS WebMIDI  
- Remote phone → cleartext TD without companion (A) or wss (C)  
- Unauthenticated multi-client TD server (fixed by `td/` gate — keep the secret out of git)  

## Non-goals (v1)

GPU canvas contexts, multiplayer rooms, 2160px CPU parity, cloud Sync SaaS, bidirectional TD control (hooks only).
