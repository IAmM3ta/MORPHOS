# Morphogen — Elliot protocol / system / incentives findings
**Target:** https://morphogen-synth.grok.me (morphogen-v7)  
**Date:** 2026-09-17  
**Scope:** product & integration surface (TD operators, performers, mobile, HTTPS/wss, open WS, show conditions). Not a line-by-line shader/audio pass.  
**Evidence:** `/workspace/morphogen-assets/{morphogen-app.js,morphogen_ws_callbacks.py,page.html,manifest.webmanifest,extensions-head.js}` + live page fetch.

---

## Critical

### C1 — HTTPS origin vs default `ws://127.0.0.1:9980` (show-killer)
Live app is served over **HTTPS**. Default Sync URL and TD docs push **`ws://127.0.0.1:9980`**. Browsers treat `ws://` from a secure context as **mixed content**. Even LAN `ws://192.168.x.x` from `https://morphogen-synth.grok.me` fails the same way.  
UI already hints: *"if this page is HTTPS, TouchDesigner must serve wss://"*, but the happy path (copy callbacks → connect) does **not** ship a working wss bridge.  
**Show failure:** Phone/tablet on the live URL cannot talk to a stock TD WebSocket DAT server. Same-machine desktop browser may appear to work only under special localhost exceptions — unreliable across Chrome/Safari/Firefox.  
**Fix direction:** Ship a documented local reverse-proxy / TD `wss` recipe (mkcert), or a companion local page on `http://127.0.0.1` for Sync, or WebMIDI-only as the supported HTTPS path.

### C2 — TouchDesigner server is unauthenticated and trusting
`morphogen_ws_callbacks.py`: on any text message → `json.loads` → wipe `morphogen_json` / write rows; optional grid overwrite. No token, no origin check, no client allowlist, no schema version enforcement beyond `dict`.  
If an operator exposes the port (or a wss tunnel) so a phone can connect, **any** client that connects can inject params/sensors/audio/field/loop/grid into the live TD tables.  
**Show failure:** Hostile or accidental second client desyncs the set; malicious grid/params → visual/audio automation abuse.  
**Fix direction:** Shared secret in first hello (`{v:1,hello,auth}`), reject until authed; don’t `table.clear()` without auth; optional bind to localhost-only + SSH/wss sidecar.

### C3 — Remote performance path is architecturally underspecified
Product promise: photographs, phone sensors, TouchDesigner. Incentives push performers to use the **hosted** URL (shareable, OG cards, Remix). Hosted URL makes C1 worse. Local `file://` or http static build isn’t the distributed artifact.  
**System bug:** Distribution channel (Grok-hosted HTTPS) fights integration channel (local cleartext WS).

---

## High

### H1 — Gyro default ON; iOS permission is easy to fail silently
Store default `gyroOn: true`. `Sa()` requests `DeviceOrientationEvent` / `DeviceMotionEvent` permission; failure returns `false` with catch→false. Spatial-instrument marketing depends on this. First-gesture unlock may satisfy audio autoplay without successfully granting motion.  
**Show failure:** iPhone performer gets Hum + visuals, no tilt mapping, no obvious hard error — “broken instrument” feel mid-set.

### H2 — Camera + WebGL2 RD + audio on mobile thermal cliff
Camera path: `getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } })` concurrent with RD simulation.  
**Show failure:** Throttle, tab kill, overheating on mid-tier phones 10–20 minutes in. No visible “performance mode” (lower res / pause RD while sampling).

### H3 — Mic energy leaves the device over Sync without a hard consent frame
Mic RMS is included in WS payload via `getMic` / `audio.rms`. Enabling mic + Sync exports continuous audio-derived telemetry to whatever host is in `tdUrl` (persisted in localStorage).  
**Product/privacy failure:** Operator thinks “local synth”; actually streaming a live sensor channel. Especially bad if `tdUrl` was pointed at a remote tunnel.

### H4 — One-way Sync; TD cannot reliably drive Morphogen
Client pumps JSON ~every **50ms** (`setInterval(..., 50)`); MIDI CC pump ~**40ms**. No documented control plane TD→Morphogen (params, freeze, preset).  
**Integration failure:** TD operators expect bidirectional OSC-like control; they get a telemetry firehose. Incentives: they’ll abandon Sync for screen-capture of the canvas only — defeating the data path.

### H5 — `roomCode` / `role: solo` / “Open on another phone” half-surface
State includes `roomCode`, `role: 'solo'`, UI copy about opening on another phone, but no clear multiplayer protocol in the Sync path (WS is Morphogen→TD only).  
**Product failure:** Implies networked multi-device play; delivers URL open + local sensors. Expectation debt.

### H6 — Grok App Builder chrome vs performance viewport
`extensions-head.js` injects mobile “Created with Grok / Remix” banner (~44px + safe-area), mutates viewport shells, z-index max. Manifest name is **"Grok App"** not Morphogen.  
**Show failure:** Touch targets / fullscreen composition shift; installed PWA branded wrong; Remix click mid-performance is a foot-gun (banner is pointer-events limited but still cognitive noise).

### H7 — CDN / font / host dependency for a “live instrument”
Page pulls Google Fonts; app lives on `morphogen-synth.grok.me`. Venue wifi death = soft brick. No offline service worker story for the instrument itself (manifest exists, but it’s a generic Grok shell).  
**Show failure:** Classic AV — unplug the network, lose the set.

---

## Medium

### M1 — Dual telemetry clocks (WS 50ms vs MIDI 40ms) desync
TD may receive JSON and CC streams with different phase; callbacks fully rewrite tables each message → flicker/aliasing in downstream CHOPs if not sampled carefully.

### M2 — Grid attach multiplies payload cost
`tdGrid` default **true** sends 16×16 floats every pump. Fine on localhost; painful on tunnels; encourages operators to disable the most useful texture path under load.

### M3 — Persisted `tdUrl` in zustand `morphogen-v7` storage
Surprise reconnect to stale tunnel/host after reboot; multi-machine confusion.

### M4 — WebMIDI is Chrome-centric
Safari/iOS WebMIDI support is weak/absent depending on version. HTTPS Sync broken (C1) + MIDI unavailable on the phone you marketed = no machine path.

### M5 — Naming collision Morphogen vs MORPHOS
Sibling naming to a generative codec repo. Operators, search, and “open source” incentives will pull the wrong tree under time pressure.

### M6 — Schumann / 7.83 Hz as narrative vs control surface
Hum marketed as Schumann resonance sine pad. Fine as poetry; as a product claim it invites pedantic trust hits if the tuning isn’t actually locked to 7.83 under sample-rate drift. Incentive: science-branded AV audiences notice.

### M7 — OG / meta frames it as `x:game`
Discoverability as a toy/game, not an AV instrument. Wrong caller into the funnel (Remix tourists vs TD operators).

### M8 — First-gesture audio unlock vs click-track shows
Autoplay policy handled correctly for web, badly for “browser on projector must start with house cue” unless an operator physically taps the glass.

---

## Info

### I1 — Hello packet `{v:1,hello:'morphogen',t}` then telemetry; binary ignored
Fine; no heartbeat/ping beyond pump. TD won’t know silent client death until timeout.

### I2 — Callbacks `onReceiveBinary` no-op
Future binary grid path unused.

### I3 — No backpressure
If TD/WebSocket DAT stalls, browser WS buffer grows; no adaptive downsampling.

### I4 — Photo inoculate holds image bitmaps in client state
Memory pressure with multiple high-res drops + camera.

### I5 — Kill-list for operators (process)
Document unsupported matrices: iOS Safari + Sync HTTPS; iOS + WebMIDI; remote phone → cleartext TD; multi-client TD server; offline venue.

---

## Prioritized fixes (if Metta wants leverage order)

1. **Make one Sync path actually work on the hosted HTTPS app** (local wss sidecar or http companion). Until then, Sync is demo-ware on the real URL.  
2. **Auth the TD server** (shared secret) before any tunnel docs.  
3. **Performance profile** on iPhone: gyro permission UX, camera res cap, thermal mode.  
4. **Consent copy** when mic|gyro|camera + Sync are combined.  
5. **Either ship multi-phone rooms or remove the UI promise.**  
6. **Rename PWA manifest** to Morphogen; quiet Remix chrome in `?perform=1` mode.

---

## Assumed invariant (the bug)
“Ship on grok.me HTTPS + default localhost cleartext WebSocket + phone sensors” is treated as one product. It is three products colliding. The control surface that actually works today for a careful operator is likely: **desktop same-origin exception or MIDI-only**, not the story on the landing page.
