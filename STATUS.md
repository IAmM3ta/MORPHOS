# MORPHOS status log

RedBot daily cadence notes for `IAmM3ta/MORPHOS`. Newest first.

## 2026-10-17 (09:20 ET — daily commit)

**Landed:** Morphogen v2 Field presets — the Field panel button now cycles the 10 Gray–Scott presets instead of being a stub, plus its first tests.

- `morphogen-v2/src/ui/field.ts` (new): `PRESET_ORDER` spells out the cycle order (Mitosis, Solitons, Pulsing, Holes, Mazes, Fingerprint, Spirals, Worms, Coral, Skate) so adding a kernel preset is a deliberate UI choice; `isPresetId` narrows untrusted strings with an own-property check (no `toString` / `__proto__`); `nextPresetId(current, dir)` wraps both ways and starts from the top for an unknown id; `presetParams(id)` strips the `name` label and runs the numbers through `sanitizeParams`, returning a fresh object (unknown → Mitosis); `describePreset` builds the status text (`Field: Coral (9/10) · feed 0.0545 · kill 0.0620`); `presetFromQuery` reads `?preset=` case-insensitively, trimmed, ignoring junk and values over 32 chars; `createPresetCycler({initial, apply})` applies the initial preset at construction and only moves its `current()` after `apply` succeeded, so the label can't claim a preset the kernel refused.
- `morphogen-v2/src/main.ts`: builds the cycler with `apply: (p) => sim.setParams(p)` and the `?preset=` boot value; the Field panel click now calls `field.next()` and shows `describePreset(...)` instead of `panel field (stub)`; the field itself isn't cleared, so the current pattern morphs into the new regime; `?debug=1` snapshot includes `preset`.
- `morphogen-v2/index.html`: Field button gets a `title` hint. `package.json`: `npm test` bundles `ui/field.ts`.
- `morphogen-v2/tests/field.test.mjs`: 7 tests (order covers every kernel preset once, id narrowing incl. prototype keys, forward / back wrap and junk `dir`, exact table params within `PARAM_LIMITS`, status text, query parsing, cycler apply / ignore-junk / throwing-apply recovery).
- Checks: `npm test` 98/98, `tsc --noEmit` clean, `vite build` OK, `check:nowebgl` OK.

**Reviewed:** HUD (2026-10-16), frame loop, pointer seeding, keyboard shortcuts, panels, Hum, Canvas 2D renderer, Gray–Scott kernel and the Sync stack unchanged.

**Next focus candidates:** a key or Shift-click to step presets backwards, Field-panel feed / kill sliders and the MIDI CC map through the same `setParams` path, Sync `preset` command from TD (`{cmd: "preset"}` in REBUILD-SPEC), move the kernel into a Worker, seed-brush size control, compute `sim.stats()` only when the HUD or Hum needs it.

## 2026-10-16 (09:25 ET — daily commit)

**Landed:** Morphogen v2 HUD — NaN-safe formatting and a throttled, change-only writer for the footer read-out, plus its first tests.

- `morphogen-v2/src/ui/hud.ts` (new): pure `formatStat(value, digits = 3)` returns `—` (`HUD_MISSING`) for NaN / ±Infinity / non-numbers, clamps `digits` to an integer in [0, 6], and drops the sign when a value rounds to zero (`-0.0001` → `0.000`, so the HUD no longer flickers between `-0.000` and `0.000`). `formatLockCount` shows a non-negative integer (NaN / negative / non-numbers → 0). `formatHud(stats, lockCount)` builds the full line with `HUD_HINT` and tolerates a missing stats object. `createHudWriter(el, intervalMs = HUD_INTERVAL_MS)` writes at most once per 100 ms and only when the text differs from what's shown; `invalidate()` forces the next frame through; a backwards or non-finite rAF timestamp counts as "interval elapsed" so the HUD can't freeze on a bad clock.
- `morphogen-v2/src/main.ts`: the inline `hud.textContent = …` template built from raw `st.energy.toFixed(3)` / `st.meanV.toFixed(3)` (rewritten every frame, 60–240×/s) is replaced by `hud.update(st, lockCount, now)` using the loop's rAF timestamp; Lock loop and Reset call `hud.invalidate()` so the new count appears on the next frame. The static pre-ENTER hint in `index.html` is untouched until the first frame.
- `morphogen-v2/tests/hud.test.mjs`: 8 tests (fixed-point + bad values + negative-zero, digit clamp, lock-count clamp, full line + missing stats, ~10 writes per second at 240 Hz, unchanged text never rewritten, one-shot `invalidate`, backwards / NaN clocks and bad intervals). `npm test` bundles `ui/hud.ts`.
- Checks: `npm test` 91/91, `tsc --noEmit` clean, `vite build` OK, `check:nowebgl` OK.

**Reviewed:** Frame loop (2026-10-15), pointer seeding, keyboard shortcuts, panels, Hum, Canvas 2D renderer, Gray–Scott kernel and the Sync stack unchanged.

**Next focus candidates:** Field-panel sliders / MIDI CC through `setParams`, move the kernel into a Worker (the loop's `onFrame` is the seam), Sync path-picker UI, seed-brush size control, compute `sim.stats()` only when the HUD or Hum needs it.

## 2026-10-15 (09:20 ET — daily commit)

**Landed:** Morphogen v2 frame loop — display-rate-independent sim pacing and a single-flight, failure-tolerant start, plus the loop's first tests.

- `morphogen-v2/src/app/loop.ts` (new): pure `paceSteps(carryMs, elapsedMs)` is a fixed-timestep accumulator at `SIM_HZ` = 120 kernel steps/s (`SIM_STEP_MS` ≈ 8.33 ms), so 60 Hz still gets the old 2 steps per frame, 120 Hz gets 1 and 30 Hz gets 4 — the field evolves at the same speed on every display. Previously `main.ts` ran a fixed `STEPS = 2` per rAF, so a 120/144 Hz screen ran the sim 2–2.4× too fast. At most `MAX_STEPS_PER_FRAME` = 4 steps run per frame (each step is O(w·h), 65 536 cells at 256²); past that the backlog is dropped, so a tab return or debugger pause can't trigger a catch-up burst ("spiral of death"). Duplicate / backwards / non-finite timestamps run 0 steps and keep the carry; a corrupt carry resets to 0. `createFrameLoop({requestFrame, cancelFrame, onFrame})` keeps exactly one rAF chain (idempotent `start` / `stop`, stop-from-inside-a-frame honoured, clock reset on restart so stopped time is never replayed, a throwing frame still schedules the next one). `singleFlightUnlock(unlock)` shares one in-flight Hum unlock between ENTER and a first canvas press in the same gesture and resolves `false` (never rejects) when `AudioContext.resume()` throws — before, a rejection left the gate up and the sim frozen.
- `morphogen-v2/src/main.ts`: `running` / `raf` / `STEPS` replaced by `createFrameLoop(...)` + `singleFlightUnlock(() => hum.unlock())`; the frame body (step, draw, modulate Hum, HUD) is unchanged apart from using the paced step count; the pointer `onPress` checks `loop.isRunning()`; teardown calls `loop.stop()`.
- `morphogen-v2/tests/loop.test.mjs`: 7 tests (60 Hz = 2 steps and 1 s at 30/60/75/90/120/144/165/240 Hz ≈ 120 steps, cap + backlog drop incl. 20 Hz device, bad timestamps / corrupt carry / sub-step accumulation, fake-rAF loop pacing + idempotent start/stop, restart clock reset, stop-inside-frame + throwing frame, single-flight unlock sharing / rejection / sync throw / retry after settle). `npm test` bundles `app/loop.ts`.
- Checks: `npm test` 83/83, `tsc --noEmit` clean, `vite build` OK, `check:nowebgl` OK.

**Reviewed:** Pointer seeding (2026-10-14), keyboard shortcuts, panels, Hum, Canvas 2D renderer, Gray–Scott kernel and the Sync stack unchanged.

**Next focus candidates:** Field-panel sliders / MIDI CC through `setParams`, move the kernel into a Worker (the loop's `onFrame` is the seam), Sync path-picker UI, seed-brush size control, NaN-safe HUD formatter.

## 2026-10-14 (09:12 ET — daily commit)

**Landed:** Morphogen v2 pointer seeding — a guarded, testable click/drag path for seeding the field, plus its first tests.

- `morphogen-v2/src/ui/pointer.ts` (new): pure `pointerToField(clientX, clientY, rect)` returns `{nx, ny}` in [0, 1] or null for a zero / negative-size rect, non-finite input or an off-canvas point. The old inline maths in `main.ts` divided by `rect.width`, so a collapsed canvas produced NaN, which slipped past the `< 0 || > 1` check into `sim.seed()`. Pure `strokePoints(prev, next)` fills fast drags with evenly spaced seeds (`STROKE_SPACING` 0.01 ≈ 2.5 cells at 256², capped at `STROKE_MAX_POINTS` = 24 per move because each seed is O(w·h)), so a quick swipe draws a line instead of dots. `isPaintButton` limits painting to the primary pointer's main button (no right-click, middle-click or second-finger painting). `mountPointerSeeding(surface, {onSeed, onPress})` follows exactly one pointer, ends the stroke on `pointerup` / `pointercancel` / `lostpointercapture`, restarts the stroke cleanly when the pointer leaves and re-enters the canvas, tolerates `setPointerCapture` throwing, and returns an unmount.
- `morphogen-v2/src/main.ts`: the four inline pointer listeners and the `painting` flag are replaced by one `mountPointerSeeding(canvas, …)` call; seed radius / strength unchanged (0.045 / 0.95); the first press still unlocks the Hum if ENTER was skipped; teardown now unmounts the pointer listeners.
- `morphogen-v2/tests/pointer.test.mjs`: 7 tests (coordinate mapping + bounds, zero-size / NaN rects, stroke spacing + endpoint, cap and bad-argument fallbacks, button / primary filter, mount dispatch with second-pointer and right-click ignored, off-canvas re-entry, lost capture). `npm test` bundles `pointer.ts`.
- Checks: `npm test` 76/76, `tsc --noEmit` clean, `vite build` OK, `check:nowebgl` OK.

**Verified:** the 2026-10-13 keyboard-shortcut commit (pushed through the GitHub API while the build box was offline, so not run at the time) passes on the box: 69/69 before today's tests, `tsc` and build clean.

**Reviewed:** Panels, Hum, Canvas 2D renderer, Gray–Scott kernel and the Sync stack unchanged.

**Next focus candidates:** Field-panel sliders / MIDI CC through `setParams`, move the kernel into a Worker, Sync path-picker UI, seed-brush size control.

## 2026-10-12 (09:35 ET — daily commit)

**Landed:** Morphogen v2 panel input hygiene and the Sound-panel mute toggle, plus the panels' first routing tests.

- `morphogen-v2/src/ui/panels.ts`: new pure `resolvePanelAction(target, root)` replaces the old "look only at `ev.target`" handler. It walks up to 4 ancestors (so a click on a `<span>`/icon inside a button still routes), stops at the panel root, ignores disabled controls, and validates `data-panel` through `isPanelId` (own-key check, so `toString` / `__proto__` / typos are dropped instead of rendering `panel: undefined`). The Lock-loop and Reset rules that lived inline in `main.ts` are now `LOOP_MAX` (4), `nextLockCount` (NaN / negative / fractional counts restart cleanly) and `resetNeedsConfirm`. New `mountMuteToggle(btn, hum)` + `describeMute` mirror `HumEngine.isMuted` into the label (**Hum on** / **Hum muted**) and `aria-pressed`; mounting never touches the engine, and because HumEngine remembers mute across unlock, muting on the gate keeps the ramp-in from starting.
- `morphogen-v2/index.html` / `src/main.ts`: `#muteHum` button added to the panel bar and routed via `onMuteToggle`; Lock loop reports `(max)` at the cap.
- `morphogen-v2/tests/panels.test.mjs`: 9 tests (panel-id guard incl. prototype keys, loop cap + corrupt counts, reset-confirm rule, direct + child-element routing, unknown/disabled ignored, root boundary + bounded walk, `mountPanelStubs` dispatch/note/unmount, mute toggle label + `aria-pressed` + no engine call on mount). Checks: `npm test` 62/62, `tsc --noEmit` clean, `vite build` OK, `check:nowebgl` OK.

**Reviewed:** Canvas 2D renderer (2026-10-11), Hum audio safety (2026-10-10), Gray–Scott guards (2026-10-09) and the Sync stack unchanged; `mountSyncStatus` untouched.

**Next focus candidates:** Field-panel sliders / MIDI CC through `setParams`, an `m` keyboard shortcut for mute (ignoring text inputs), move the kernel into a Worker, Sync path-picker UI.

## 2026-10-11 (09:20 ET — daily commit)

**Landed:** Morphogen v2 Canvas 2D renderer hardening — a precomputed palette lookup table, NaN-safe per-pixel tone, bounded buffer fills and safe resize, plus the renderer's first tests.

- `morphogen-v2/src/render/canvas2d.ts`: new exports `PALETTE_LUT` / `PALETTE_STEPS` (256 opaque RGBA entries, same dark → cyan ramp; replaces three `Math.floor` calls per pixel per frame with one table lookup), pure `fieldTone(v, u)` (clamped to [0, 1]; non-finite → 0 so a NaN cell renders as background for that pixel only), DOM-free `fieldToRGBA(field, out)` (writes min(w·h, |u|, |v|, |out|/4) pixels and returns the count — never reads or writes past a short buffer) and `safeDim` (0 / negative / NaN / fractional sizes → integer ≥ 1, so `createImageData` can't throw mid-render). `draw()` now compares against the ImageData size rather than the canvas attributes and accepts any `{width, height, u, v}` field view.
- `morphogen-v2/tests/canvas2d.test.mjs`: 7 tests with a fake canvas (LUT endpoints + monotone channels, tone clamp/NaN, NaN cell isolation, short-buffer bounds, `safeDim`, opaque-2d context request + unavailable path, 0×0 canvas resize-once). `npm test` bundles `canvas2d.ts` too. Checks: `npm test` 53/53, `tsc --noEmit` clean, `check:nowebgl` OK.

**Reviewed:** Hum audio safety (2026-10-10), Gray–Scott guards (2026-10-09) and the Sync stack unchanged; `main.ts` call sites (`new Canvas2DRenderer(canvas)`, `renderer.draw(sim)`) work as-is.

**Next focus candidates:** Sound-panel mute toggle wired to `setMuted`, Field-panel sliders / MIDI CC through `setParams`, move the kernel into a Worker, Sync path-picker UI.

## 2026-10-10 (09:10 ET — daily commit)

**Landed:** Morphogen v2 Hum audio safety — NaN-safe, throttled modulation, remembered mute, anchored gain ramps with a hard ceiling, complete teardown, plus the audio engine's first tests.

- `morphogen-v2/src/audio/hum.ts`: new exports `HUM_PARTIALS` / `HUM_PARTIAL_LEVELS` / `HUM_LEVEL_ON|OFF` / `HUM_MAX_DETUNE` and pure `energyToDetune` (non-finite or negative energy → 0, clamped to 2 %, quantised to 0.05 %). `modulate()` now schedules a new `setTargetAtTime` only when the quantised detune changes — previously every 60 fps frame queued 4 automation events (~14k/min) and a NaN energy would have thrown inside `setTargetAtTime`. `setMuted()` is remembered across unlock (muting before ENTER no longer gets overwritten by the 0.8 s ramp-in) and every ramp is anchored with `setValueAtTime`, clamped to `HUM_LEVEL_ON`, so a cancel mid-ramp can't jump. `dispose()` now also disconnects the compressor node (it was leaked), and `unlock()` resolves false if `dispose()` ran during a pending `resume()`. The AudioContext is created through an injectable factory (default: `window.AudioContext` / webkit) so the engine is testable headless; `resume()` is a no-op once disposed.
- `morphogen-v2/tests/hum.test.mjs`: 8 tests against a fake AudioContext (detune mapping, graph build + anchored ramp-in, no-AudioContext inert path, mute-before-unlock, ceiling/anchor on setMuted, 600-frame flat-energy throttle + NaN, full dispose incl. compressor, dispose-during-resume). `npm test` bundles `hum.ts` too. Checks: `npm test` 46/46, `tsc --noEmit` clean, `check:nowebgl` OK.

**Reviewed:** Gray–Scott guards (2026-10-09) and the Sync stack unchanged; `main.ts` call sites (`modulate` per frame, `suspend`/`resume` on visibility, `dispose` on teardown) work as-is with the new behaviour.

**Next focus candidates:** wire a Sound-panel mute toggle to `setMuted`, Field-panel sliders / MIDI CC through `setParams`, move the kernel into a Worker, Sync path-picker UI.

## 2026-10-09 (09:30 ET — daily commit)

**Landed:** Morphogen v2 CPU Gray–Scott kernel guards — parameter sanitising, explicit-Euler dt stability clamp and NaN containment, plus the kernel's first tests.

- `morphogen-v2/src/sim/grayScott.ts`: new `PARAM_LIMITS` (feed/kill 0–0.1, du/dv 0–0.25), `sanitizeParams` (clamps range, ignores non-finite / non-number values such as a stringly MIDI or Sync payload) and `maxStableDt` (D·dt ≤ 1/4 on the 5-point Laplacian; presets allow dt ≤ 1.5625). Constructor and new `setParams` route through the sanitiser; `step(dt)` clamps dt to the stable bound and treats NaN / ≤0 dt as a no-op; the clamp-back loop now maps NaN to 0 so one bad cell can't spread through the Laplacian (previously `Math.max(0, NaN)` kept it NaN forever — black canvas until Reset).
- `morphogen-v2/tests/grayScott.test.mjs`: 9 tests (presets in range and stable, sanitiser, setParams merge, dt clamp under dt=50, NaN/0/negative dt no-op, NaN cell scrubbed, mitosis growth + centred centroid, grid16 block means); `npm test` bundles `grayScott.ts` too. Checks: `npm test` 38/38, `tsc --noEmit` clean.

**Reviewed:** Sync URL hygiene (2026-10-08), status chip, backoff and handshake remain intact; no Sync, TD-side or codec changes this pass.

**Next focus candidates:** wire Field-panel sliders / MIDI CC through `setParams`, move the kernel into a Worker, Sync path-picker UI, pause the Sync pump while `document.hidden`.

## 2026-10-08 (09:00 ET — daily commit)

**Landed:** Morphogen v2 Sync URL hygiene — host allowlist with remote confirm + sanitised, schema-checked persisted Sync settings (REBUILD-SPEC §6 client hardening; red-team H-WS, M-PERSIST, static #2/#8).

- New `morphogen-v2/src/sync/syncUrl.ts` (pure): `classifyTdHost` (loopback / `*.local` mdns / remote — LAN IPs and look-alikes like `localhost.evil.com` are remote), `sanitizeTdUrl` (ws/wss only, ≤512 chars, rejects whitespace/control chars and `user:pass@`, drops fragment, canonical form; reasons never echo input), `tdUrlNeedsConfirm`, `remoteConfirmMessage`, `defaultTdGrid` (on only for loopback), and `loadSyncSettings` / `saveSyncSettings` for `localStorage` key `morphogen-v2.sync` → `{ v:1, url, path, grid }` only: corrupt/tampered records wiped with a `dropped` reason, stray keys inert, a stored `auth` scrubbed, remote hosts always rehydrate `needsConfirm:true` (confirms are never persisted).
- `morphogen-v2/src/sync/tdClient.ts`: `validateTdUrl(url, path, { confirmRemote })` now sanitises first and returns the canonical `url` + `hostClass`; companion accepts loopback **and `*.local`** over ws but refuses remote hosts even with a confirm; wss remote hosts return `needsConfirm` until confirmed. `connect(url, path, getPayload, opts)` opens the canonical URL, never the raw paste. `main.ts` loads the persisted record at start-up (`?debug=1` → `__morphogen().sync`).
- `morphogen-v2/tests/syncUrl.test.mjs`: 12 tests; `npm test` bundles `syncUrl.ts` too. Docs: SYNC-AUTH.md "Sync URL allowlist + persisted settings" section + refreshed "Still open", morphogen-v2 README, README Changelog. Checks: `npm test` 29/29, `tsc` clean, `npm run build` OK, `check:nowebgl` OK.

**Reviewed:** Sync status chip (2026-10-07), reconnect backoff (2026-10-06), hello→ack handshake + TD `SyncAuthGate` (2026-10-05) and the MRPH v1–v4 codec stack remain intact; no codec or TD-side changes this pass.

**Next focus candidates:** Sync path-picker UI (URL / path / secret entry + remote confirm + `saveSyncSettings`), pause the Sync pump while `document.hidden`, wire real VAE latents into the sketch, spatial hyperprior once the code is a feature map.

## 2026-10-07 (09:00 ET — daily commit)

**Landed:** Morphogen v2 Sync status chip — the reconnect state from 2026-10-06 is now visible and actionable in the UI (REBUILD-SPEC §6 client hardening).

- `morphogen-v2/src/sync/tdClient.ts`: new pure `describeTdStatus(snapshot, now)` → `{ label, tone, countdownMs, canRetryNow }` (one tone per status; countdown from `nextRetryAt`, rounded up, clamped at 0; strings never carry the token). New `TdClient.snapshot()` (plain-data state incl. retry budget) and `TdClient.retryNow()` — skips the remaining backoff with a fresh socket + hello, only while `reconnecting`, never resets the budget, no-op after terminal failures.
- `morphogen-v2/src/ui/panels.ts`: `mountSyncStatus(chip, retryBtn, td)` renders on every `onStatus` (chaining any existing handler), runs a 250 ms countdown tick only while reconnecting, shows **Retry now** only when it applies, and unmounts cleanly. `index.html` gains `#syncStatus` (`role=status`, `aria-live=polite`, tone colours) + `#syncRetry`; `main.ts` mounts/unmounts it and `?debug=1` exposes `td.snapshot()`.
- `morphogen-v2/tests/syncStatus.test.mjs`: 6 tests (labels/tones, countdown rounding/clamp, snapshot w/o token, retryNow budget + terminal no-op, chip render/tick/button/unmount with a DOM stub). `npm test` now bundles `tdClient.ts` + `panels.ts`. Docs: SYNC-AUTH.md "Sync status chip" section, morphogen-v2 README, README Changelog. Checks: `npm test` 17/17, `tsc` clean, `npm run build` OK, `check:nowebgl` OK.

**Reviewed:** Sync reconnect backoff (2026-10-06), hello→ack handshake + TD `SyncAuthGate` (2026-10-05), MRPH header describe/peek/dispatch (2026-10-03–04) and MRPH v1–v4 remain intact; no codec or TD-side changes this pass.

**Next focus candidates:** Sync path-picker UI (URL / path / secret entry feeding `connect()`), `*.local` allowlist with confirm, persisted `tdUrl` sanitising, wire real VAE latents into the sketch, spatial hyperprior once the code is a feature map.

## 2026-10-06 (09:00 ET — daily commit)

**Landed:** Morphogen v2 Sync reconnect backoff + jitter (REBUILD-SPEC §6 client hardening) and the first committed tests for the browser Sync client.

- `morphogen-v2/src/sync/tdClient.ts`: failures are now classified. *Transient* (socket never opened, authed session dropped) → new `reconnecting` status and a retry after `reconnectDelayMs(n)` — capped exponential backoff with equal jitter, ceiling min(15 s, 500 ms·2ⁿ), delay in [ceiling/2, ceiling), 8 consecutive tries then `error`. *Terminal* (URL/token validation, `new WebSocket` throw, TD `ok:false`, 2 s ack timeout, close mid-handshake) never retry, so a wrong secret can't burn TD's 3-bad-hello budget or keep being re-sent to an un-gated server. Successful ack resets the budget; every retry is a fresh socket + fresh hello; `disconnect()` cancels a pending retry. Refactor: `connect()` (user-initiated, resets budget) now delegates to private `openSocket()`; `onerror` only records the reason and `onclose` decides; new `TdStatus` type, `TdClientOptions { autoReconnect, maxReconnectAttempts, rand }`, public `reconnectAttempt` / `nextRetryAt` for the UI.
- `morphogen-v2/tests/tdClient.test.mjs` + `npm test` (esbuild bundles `tdClient.ts`, then `node --test` with a fake WebSocket and mocked timers): 11 tests — delay bounds/cap/bad-input clamping, hello-only-until-ack, reject / timeout / mid-handshake close are terminal, retry timing doubles then resets on success, authed-drop retry, budget exhaustion, disconnect cancels retry, `autoReconnect:false`, stale-socket guard, bad token opens no socket. `esbuild` pinned as a direct devDependency (was only transitive via vite); `.test-build/` git-ignored.
- `docs/morphogen-redteam/SYNC-AUTH.md` gains a "Reconnect backoff" section (retry/no-retry table + defaults); morphogen-v2 README Sync line + `npm test`; README Changelog. Checks: `npm test` 11/11, `tsc` clean, `npm run build` OK, `check:nowebgl` OK.

**Reviewed:** Sync hello→ack handshake + TD `SyncAuthGate` (2026-10-05), MRPH header describe/peek/dispatch (2026-10-03–04), v1–v4 flag guide (2026-10-02) and MRPH v4 (2026-10-01) remain intact; no codec or TD-side changes this pass.

**Next focus candidates:** surface `reconnecting` + retry countdown in the Sync panel, path-picker UI, `*.local` allowlist with confirm, persisted `tdUrl` sanitising, wire real VAE latents into the sketch, spatial hyperprior once the code is a feature map.

## 2026-10-05 (09:00 ET — daily commit)

**Landed:** Morphogen v2 Sync auth hello hardening (red-team C2) — client handshake + reference TD-side gate.

- `morphogen-v2/src/sync/tdClient.ts`: telemetry pump now starts only after TD replies `{ v:1, ack:'morphogen', ok:true }` (previously it pumped on socket open, so an un-gated server still received sensor data). New `authenticating` state, 2 s `HELLO_ACK_TIMEOUT_MS`, sticky `error` on reject/timeout, `validateAuthToken` (≥16 chars, no whitespace) and `parseHelloAck`; handlers ignore events from superseded sockets.
- `morphogen-v2/td/morphogen_sync_auth.py`: pure-Python `SyncAuthGate` (constant-time compare, ±30 s hello window, 64 KB frame cap, drop after 3 bad hellos, per-client state, reason codes that never echo the secret). `morphogen-v2/td/morphogen_sync_callbacks.py`: WebSocket DAT glue that writes `morphogen_table` / `morphogen_grid` only for authed clients; secret from parent par `Syncsecret`, fails closed if unset.
- `tests/test_td_sync_auth.py` (gate + table flattening); new `docs/morphogen-redteam/SYNC-AUTH.md` documents the ack, reason codes and client state machine (extends REBUILD-SPEC §6); morphogen-v2 README gains a TD section and repo-relative doc links. Full suite: 110 passed; `tsc` clean; client handshake exercised against a fake WebSocket (hello-only → ack → pump, reject, timeout).

**Reviewed:** MRPH header describe/peek/dispatch (2026-10-03–04), v1–v4 flag guide (2026-10-02) and MRPH v4 (2026-10-01) remain intact; no codec changes this pass.

**Next focus candidates:** wire real VAE latents into the sketch, spatial hyperprior once the code is a feature map, Sync reconnect backoff + path picker UI, `*.local` allowlist with confirm.

## 2026-10-04 (09:00 ET — daily commit)

**Landed:** MRPH header describe + train-sketch peek/dispatch wire-up (docs/tests; no wire-format bump).

- Added `mrph_describe_header()` in `generative_codec.py` (human-readable one-liner from bytes or a peek dict: version / mode / geometry → unpack_fn / needs / CLI flag).
- Wired pack checks in `bottleneck_train_sketch.ans_check_one_code` to `mrph_peek_header` + `mrph_unpack_indices`; CLI prints `MRPH header: …` after ANS pack demos.
- Tests cover describe (v1/v4), truncated common/hyper headers, unsupported-version peek, and TypeError on bad input; ENTROPY/TRAINING/STATUS/Changelog notes.

**Reviewed:** MRPH header peek + version-dispatch unpack from 2026-10-03, v1–v4 flag guide + v4 edge hardening from 2026-10-02, and ANS-coded hyper indices (MRPH v4) from 2026-10-01 remain intact. Morphogen v2 / red-team brief unchanged this pass.

**Next focus candidates:** wire real VAE latents into the sketch, spatial hyperprior once the code is a feature map, Morphogen Sync auth hello hardening.

## 2026-10-03 (09:00 ET — daily commit)

**Landed:** MRPH header peek + version-dispatching unpack (docs/tests; no wire-format bump).

- Added `mrph_peek_header()` in `generative_codec.py` (common magic/version/geometry/sideinfo_mode; hyper_dim/levels for v2+; `unpack_fn` / `unpack_needs` / `cli_flag` from the version guide).
- Added `mrph_unpack_indices()` — routes v1–v4 packs to the matching unpacker; clear errors when `hyper=` / `hyper_prior=` are missing.
- Tests cover peek + round-trip dispatch across v1–v4 and missing-model guards; ENTROPY/TRAINING/STATUS/Changelog notes.

**Reviewed:** MRPH v1–v4 flag guide + v4 edge hardening from 2026-10-02 and ANS-coded hyper indices (MRPH v4) from 2026-10-01 remain intact. Morphogen v2 / red-team brief unchanged this pass.

**Next focus candidates:** wire real VAE latents into the sketch, spatial hyperprior once the code is a feature map, Morphogen Sync auth hello hardening.

## 2026-10-02 (09:00 ET — daily commit)

**Landed:** MRPH v1–v4 architecture clarity + v4 pack edge hardening (docs/tests; no wire-format bump).

- Added `mrph_pack_version_guide()` in `generative_codec.py` (structured cheat-sheet: version → `sideinfo_mode` → CLI flag → decode needs → when to use).
- Extended `hyperprior_hier_prior_pack_stats` to report `sideinfo_saving_vs_v3_raw` when measured `sideinfo_bytes` is known; peaked-prior round-trip test now asserts positive savings vs raw H×u8.
- Added unpack edge tests (bad magic, prior geometry mismatch) + guide coverage test; new "MRPH pack versions (v1–v4)" section in `docs/ENTROPY-CODING-NOTES.md` and a TRAINING-SKETCH pointer; README Changelog.

**Reviewed:** ANS-coded hyper indices under learned prior (MRPH v4) + learned categorical prior on z_h + hierarchical hyperprior ANS pack (MRPH v3) paths from 2026-09-29–10-01 remain intact. Morphogen v2 / red-team brief unchanged this pass.

**Next focus candidates:** wire real VAE latents into the sketch, spatial hyperprior once the code is a feature map, Morphogen Sync auth hello hardening.

## 2026-10-01 (09:00 ET — daily commit)

**Landed:** ANS-coded hyper indices under the learned categorical prior (MRPH v4) for the IMAGE_8 hierarchical hyperprior pack.

- Added `ans_hyper_hier_prior_pack_indices` / `ans_hyper_hier_prior_unpack_indices` / `hyperprior_hier_prior_pack_stats` in `generative_codec.py` (MRPH v4; replaces raw `H × u8` hyper side-info with tabled rANS under `CategoricalEntropyModel(H, L_h)`; meta reports `hyper_measured_bits` + savings vs v3).
- Wired `--ans-hyper-hier-prior` into `bottleneck_train_sketch` (exclusive with other `--ans-*` packs; pairs with `--hyper-rate --learned-hyper-prior`).
- Extended shape + train-sketch tests; updated `docs/ENTROPY-CODING-NOTES.md` and `docs/TRAINING-SKETCH.md`; README Changelog.

**Reviewed:** Learned categorical prior on z_h + hierarchical hyperprior ANS pack (MRPH v3) + hierarchical rate + hyperprior ANS pack paths from 2026-09-27–30 remain intact. Morphogen v2 / red-team brief unchanged this pass.

**Next focus candidates:** wire real VAE latents into the sketch, spatial hyperprior once the code is a feature map, Morphogen Sync auth hello hardening.

## 2026-09-30 (09:00 ET — daily commit)

**Landed:** Learned categorical prior on quantized z_h for the IMAGE_8 hierarchical hyperprior rate path (replaces uniform side-info).

- Extended `hyperprior_hierarchical_bits` / `hyperprior_hierarchical_rate_bpp` with optional `hyper_prior=CategoricalEntropyModel(H, L_h)` so R(z_h) is a trainable factorized categorical NLL over STE hyper indices instead of detached `H · log2(L_h)`.
- Wired `--learned-hyper-prior` into `bottleneck_train_sketch` (requires `--hyper-rate`; trains the prior jointly; metrics flag `used_learned_hyper_prior`).
- Extended shape + train-sketch tests; updated `docs/ENTROPY-CODING-NOTES.md` and `docs/TRAINING-SKETCH.md`; README Changelog. MRPH v3 wire format unchanged (raw `H × u8` hyper indices).

**Reviewed:** Hierarchical hyperprior ANS pack (MRPH v3) + hierarchical rate + hyperprior ANS pack + self-describing ANS pack + tabled rANS paths from 2026-09-24–29 remain intact. Morphogen v2 / red-team brief unchanged this pass.

**Next focus candidates:** ANS-encode hyper indices under the learned prior, wire real VAE latents into the sketch, spatial hyperprior once the code is a feature map, Morphogen Sync auth hello hardening.

## 2026-09-29 (09:00 ET — daily commit)

**Landed:** Hierarchical hyperprior ANS pack (MRPH v3) for the IMAGE_8 bottleneck bitstream.

- Added `ans_hyper_hier_pack_indices` / `ans_hyper_hier_unpack_indices` / `hyperprior_hier_pack_stats` in `generative_codec.py` (MRPH v3; quantized z_h side-info + STE indices under synthesis(z_hat) tables; meta reports hierarchical R(z_h)+R(indices|z_hat) vs measured pack bits).
- Wired `--ans-hyper-hier` into `bottleneck_train_sketch` (exclusive with `--ans-pack` / `--ans-hyper`; pairs with `--hyper-rate` at `fit_steps=0`).
- Extended shape + train-sketch tests; updated `docs/ENTROPY-CODING-NOTES.md` and `docs/TRAINING-SKETCH.md`; README Changelog.

**Reviewed:** Hierarchical hyperprior rate + hyperprior ANS pack + self-describing ANS pack + tabled rANS + CategoricalEntropyModel paths from 2026-09-24–28 remain intact. Morphogen v2 / red-team brief unchanged this pass.

**Next focus candidates:** wire real VAE latents into the sketch, spatial hyperprior once the code is a feature map, Morphogen Sync auth hello hardening.

## 2026-09-28 (09:00 ET — daily commit)

**Landed:** Hierarchical hyperprior rate term for the IMAGE_8 bottleneck (Ballé-style R(z_h)+R(indices|z_hat)).

- Added `straight_through_quantize_hyperlatent`, `hyperprior_conditional_nll_bits`, `hyperprior_hierarchical_bits` / `hyperprior_hierarchical_rate_bpp` / `hyperprior_hierarchical_rate_stats` in `generative_codec.py` (uniform side-info alphabet + conditional categorical under synthesized logits).
- Wired `--hyper-rate` into `bottleneck_train_sketch` (implies STE; trains `HyperpriorTableModel` jointly; exclusive with `--categorical-rate` / `--entropy-rate`). Meta flags `used_hyper_rate`.
- Extended shape + train-sketch tests; updated `docs/ENTROPY-CODING-NOTES.md` and `docs/TRAINING-SKETCH.md`; README Changelog.

**Reviewed:** Hyperprior ANS pack + self-describing ANS pack + tabled rANS + CategoricalEntropyModel paths from 2026-09-24–27 remain intact. Morphogen v2 / red-team brief unchanged this pass.

**Next focus candidates:** wire real VAE latents into the sketch, spatial hyperprior once the code is a feature map, Morphogen Sync auth hello hardening.

## 2026-09-27 (09:00 ET — daily commit)

**Landed:** Hyperprior table side-info pack for the IMAGE_8 bottleneck bitstream (replaces raw freq tables).

- Added `HyperpriorTableModel` + `quantize_hyperlatent` + `ans_hyper_pack_indices` / `ans_hyper_unpack_indices` / `hyperprior_pack_stats` in `generative_codec.py` (MRPH v2 wire format; shared analysis/synthesis weights; H≪D·L side-info).
- Wired `--ans-hyper` / `--hyper-dim` / `--hyper-levels` into `bottleneck_train_sketch` (exclusive with `--ans-pack`; implies `--ans-check` / categorical). Meta reports `sideinfo_saving_vs_per_dim`.
- Extended shape + train-sketch tests; updated `docs/ENTROPY-CODING-NOTES.md` and `docs/TRAINING-SKETCH.md`; README Changelog.

**Reviewed:** Self-describing ANS pack + tabled rANS + CategoricalEntropyModel paths from 2026-09-24–26 remain intact. Morphogen v2 / red-team brief unchanged this pass.

**Next focus candidates:** wire real VAE latents into the sketch, spatial hyperprior once the code is a feature map, Morphogen Sync auth hello hardening.

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
