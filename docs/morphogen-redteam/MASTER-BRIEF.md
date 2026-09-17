# Morphogen — Master Red-Team Brief (post-findings)

**Prepared for:** Morphogen v2 rebuild (first principles, **no WebGL**)  
**Sources merged:**
- `/workspace/morphogen-redteam/static-findings.md` (static asset / protocol analysis)
- `/workspace/morphogen-redteam/elliot-protocol-findings.md` (Elliot protocol / incentives / show conditions)
- `/workspace/morphogen-redteam/live-ux-findings.md` + screenshots `shot-drag.webp`, `shot-field.webp`, `shot-midi-prompt.webp`
- `/workspace/morphogen-assets/morphogen_ws_callbacks.py` (TD server callbacks)
- Feature skim of `morphogen-app.js` (presets, waveforms, panels, MIDI, Sync payload)

**Date:** 2026-09-17 (America/New_York)  
**Hard constraint (Metta / R3DB0T):** Reconstruct the entirety of Morphogen on first principles. **Eliminate WebGL entirely.**

---

## Merge status

| Source | Status |
|--------|--------|
| Static findings | Merged |
| Elliot protocol findings | Merged |
| Live UX findings | Merged (`live-ux-findings.md` + `shot-*.webp`) |
| TD callbacks | Reviewed (unauthenticated, cleartext-friendly, unidirectional) |

---

## Severity-sorted findings (deduped)

Columns: **ID** | **Sev** | **Finding** | **Sources** | **Design implications for rebuild**

### Critical / show-killers

| ID | Sev | Finding | Sources | Design implications for rebuild |
|----|-----|---------|---------|----------------------------------|
| C1 | Critical | HTTPS hosted app defaults to `ws://127.0.0.1:9980`; mixed content blocks Sync from the real URL (LAN `ws://` also fails). Stock TD WebSocket DAT has no wss. **Live confirm:** Sync stayed Idle on default `ws://127.0.0.1:9980`. | Elliot C1, Static §4 High, Live UX | **Documented Sync paths only:** (A) same-origin or companion `http://127.0.0.1` controller for cleartext WS; (B) MIDI-only on HTTPS; (C) optional authenticated `wss` recipe. Default must not be broken mixed-content. Auto-scheme / wizard; never ship a default that fails on the hosted URL. |
| C2 | Critical | TD callbacks accept any client; `json.loads` → wipe tables; no token/origin/schema auth. Tunnel/expose = open control of live tables. | Elliot C2, Static §4 High | Hello must carry **auth token**; reject until authed; do not `table.clear()` pre-auth. Client: allowlist hosts; confirm remote URLs; optional shared secret in Sync panel. |
| C3 | Critical | Distribution (Grok HTTPS) fights integration (local cleartext WS). Remote phone performance path underspecified. | Elliot C3 | Treat Sync as **three products** with explicit kill-list. Ship companion local page + MIDI path as first-class. Do not market “phone → TD” without a working recipe. |

### High

| ID | Sev | Finding | Sources | Design implications for rebuild |
|----|-----|---------|---------|----------------------------------|
| H-GL | High → **eliminated by rebuild** | WebGL2 hard-required; no fallback; no context-loss recovery; unused float extensions; mobile thermal + camera concurrent. | Static §2, Elliot H2 | **No WebGL / WebGPU in v1.** CPU Gray–Scott on Canvas 2D ImageData / OffscreenCanvas worker. Context-loss class of bugs gone. Performance mode = lower sim resolution, not GPU recovery. |
| H-AUD | High | `xa.dispose()` never called on unmount; Hum / delay / voices leak after navigate. | Static §3 | Audio engine **must** dispose on teardown (stop oscillators, close AudioContext). Wire into React/vanilla unmount and `beforeunload`. Limiter after compressor. |
| H-WS | High | TD client accepts any URL; streams sensors/gyro/mic RMS/touches/field/grid @ 20 Hz; no allowlist/auth/reconnect; unidirectional (no `onmessage`). | Static §4, Elliot H3/H4 | Allowlist + auth hello; consent when mic/gyro + Sync; exponential backoff reconnect; design optional TD→app control plane later. Pause pump when `document.hidden`. |
| H-SEC | High | No CSP; third-party `extensions.js` + Google Fonts; `window.__morphogen` exposes live state. | Static §6 | Strict CSP; no Google Fonts for core; gate debug API behind `?debug=1`; `?perform=1` hides Grok chrome. Permissions-Policy for camera/mic/gyro/midi. |
| H-GYRO | High | `gyroOn: true` by default; iOS permission fails silently → “broken instrument”. | Elliot H1, Static §5 | Gyro **opt-in**; hard error toast + Body-panel banner if permission denied; do not pretend tilt is live. |
| H-MIC | High | Mic RMS exported over Sync without hard consent frame. | Elliot H3 | Explicit consent modal when enabling mic **and** Sync (or when connecting with mic already on). |
| H-CAM | High | Camera ideal 1080p + RD + audio → thermal cliff on phones. | Elliot H2, Static §5 | **Performance mode:** lower camera res (e.g. 640×480), lower sim maxSide, pause inoculate when hidden. |
| H-CHROME | High | Grok Remix banner + manifest name “Grok App”; wrong branding / touch-target noise mid-set. | Elliot H6, Static §7 | PWA name **Morphogen**; `?perform=1` hides builder chrome/noise. |
| H-OFFLINE | High | Google Fonts + hosted-only + no SW → venue wifi death soft-bricks the instrument. | Elliot H7, Static §7 | System font stack; optional SW later; core function offline-capable once assets cached. |
| H-ROOM | High | `roomCode` / `role:solo` / “another phone” copy without multiplayer protocol. | Elliot H5, Static §5 | Ship multi-device or **remove the promise** in v2 UI. Non-goal for first rebuild ship unless scoped. |

### Medium

| ID | Sev | Finding | Sources | Design implications for rebuild |
|----|-----|---------|---------|----------------------------------|
| M-BG | Medium | RAF continues when tab hidden; only audio resume on visibility — thermal + desync. | Static §2 | Pause sim + audio when `document.hidden`; optional low-rate TD keepalive. |
| M-UX | Medium | Reset / Clear all loops / unlock without confirm; double-tap+hold loop lock poorly discoverable. **Live confirm:** double-tap-hold did **not** visibly lock; explicit **Lock loop** → “LOOP 1” worked. | Static §5, Live UX | Confirm destructive actions when locks>0; coach mark / progress ring for gesture lock; keep explicit Lock/Release as primary; treat gesture as secondary/enhanced. |
| M-PERSIST | Medium | Zustand `morphogen-v7` persists `tdUrl` without sanitize; merge may accept hostile keys. | Static §6, Elliot M3 | Schema-validate rehydrate (zod/allowlist); sanitize `tdUrl`; confirm before remote hosts. |
| M-CLOCK | Medium | WS @ 50ms vs MIDI @ ~40ms phase desync; TD table full-rewrite each message. | Elliot M1 | Align pump rates or document sampling; consider delta updates later. |
| M-GRID | Medium | `tdGrid` default true → 256 floats every pump; costly on tunnels. | Elliot M2 | Default grid off on non-localhost; UI cost hint. |
| M-MIDI | Medium | WebMIDI Chrome-centric; Safari/iOS weak → no machine path when Sync HTTPS broken. **Live:** Chrome MIDI permission “Control and reprogram your MIDI devices” prompted (`shot-midi-prompt.webp`); blocked during probe. | Elliot M4, Live UX | Document MIDI as Chrome/desktop path (B); explain permission copy; do not claim iOS MIDI; Sync Idle when MIDI blocked + WS broken. |
| M-NAME | Medium | Morphogen vs MORPHOS naming collision. | Elliot M5 | README / package name clarify “Morphogen synth UI ≠ MORPHOS codec”. |
| M-HUM | Medium | Schumann 7.83 narrative vs sample-rate drift pedantry. | Elliot M6 | Document base Hz; lock oscillator to absolute Hz; avoid overclaiming “resonance science”. |
| M-META | Medium | OG/`x:game` frames as toy not AV instrument. | Elliot M7 | Meta/description as AV instrument; perform mode. |
| M-GESTURE | Medium | First-gesture audio unlock vs projector click-track shows. | Elliot M8 | Visible unlock CTA; optional click-track docs for operators. |
| M-REC | Medium | MediaRecorder format gaps (iOS); no preflight. | Static §3 | Detect support before Record UI; audio-only fallback. |
| M-MEM | Medium | History×8 + 4 locks + high maxSide + preserveDrawingBuffer OOM risk. | Static §2 | CPU buffers: cap history by byte budget; mobile maxSide ≤960; locks as CPU masks (max 4). |

### Low / Info

| ID | Sev | Finding | Sources | Design implications for rebuild |
|----|-----|---------|---------|----------------------------------|
| L-FLOAT | Low | Float GL extensions requested but RGBA8 used. | Static §2 | N/A for CPU Float32 path — use Float32 sim buffers, display via Uint8 ImageData. |
| L-TDKEY | Low | TD path concat `str(k)`; grid len unchecked. | Static §4 | Sanitize keys `[A-Za-z0-9_]`; require `grid.length===256`. |
| L-HTML | Low | App avoids unsafe HTML; keep it that way. | Static §6 | No `innerHTML` of TD JSON. |
| L-DEPS | Low | Opaque minified deps / no SBOM. | Static §6 | Pin Vite deps; generate SBOM when shipping. |
| I-HELLO | Info | Hello `{v:1,hello,t}`; no heartbeat beyond pump. | Elliot I1 | Keep hello; add auth; optional ping. |
| I-BIN | Info | `onReceiveBinary` no-op. | Elliot I2 | Reserve for future binary grid; not v1. |
| I-BP | Info | No WS backpressure / adaptive downsample. | Elliot I3 | Drop frames if `bufferedAmount` high. |
| I-PHOTO | Info | Photo inoculate holds bitmaps → memory. | Elliot I4 | Downscale inoculate images; revokeObjectURL. |
| I-KILL | Info | Operator kill-list undocumented. | Elliot I5 | Publish unsupported matrices in README. |

---

## Features to preserve (from v7 skim + live panel list)

**Panels:** Field · Image · Body (sense) · Sound · Sync  

**Presets (Gray–Scott species):**

| id | name | feed | kill | du | dv |
|----|------|------|------|----|----|
| mitosis | Mitosis | 0.0367 | 0.0649 | 0.16 | 0.08 |
| solitons | Solitons | 0.0353 | 0.0653 | 0.16 | 0.08 |
| pulsing | Pulsing | 0.025 | 0.06 | 0.14 | 0.07 |
| holes | Holes | 0.039 | 0.058 | 0.16 | 0.08 |
| mazes | Mazes | 0.029 | 0.057 | 0.16 | 0.08 |
| fingerprint | Fingerprint | 0.026 | 0.061 | 0.16 | 0.08 |
| spirals | Spirals | 0.018 | 0.051 | 0.16 | 0.08 |
| worms | Worms | 0.046 | 0.063 | 0.16 | 0.08 |
| coral | Coral | 0.0545 | 0.062 | 0.16 | 0.08 |
| uskate | Skate (U-skate) | 0.062 | 0.0609 | 0.16 | 0.08 |

**Waveforms:** sine (HUM / Schumann 7.83 Hz) · triangle · sawtooth · square · pulse · spectrum  

**Brushes / locks:** ≤8 brushes; double-tap+hold (~260ms) → lock loop; max 4 locks; panel Lock/Release  

**Sync JSON (v1, Morphogen→TD, ~50 ms):**  
`{ v, t, params{feed,kill,du,dv,speed}, sensors{alpha,beta,gamma,ax,ay,az}, audio{rms,energy}, field{meanU,meanV,energy,cx,cy,edge}, loop{count}, touches[{x,y,p}], grid?[256] }`  
Hello: `{ v:1, hello:"morphogen", t, auth? }`  

**MIDI CCs 20–29:** Feed, Kill, Energy, Mean V, Centroid X, Centroid Y, Mic RMS, Gyro γ, Gyro β, Edge  

**TD callbacks:** write `/morphogen/{params|field|sensors|audio|loop}/key` + optional 16×16 `morphogen_grid`  

**Other:** Record (canvas stream); Enter/unlock gesture; antenna hover; undo/history; palettes  

---

## Live UX confirmations (2026-09-17)

| Observation | Implication |
|-------------|-------------|
| ENTER unlock → animated field + controls immediately | Keep first-gesture unlock; splash copy “First gesture unlocks audio and motion” works |
| Drag → bright expanding cyan colonies; stats change | Preserve brush/seed paint as core interaction |
| Explicit **Lock loop** → “LOOP 1” | Keep panel Lock as primary; gesture secondary |
| Double-tap-hold did **not** visibly lock | Confirms static discoverability gap — coach or demote |
| Chrome MIDI permission prompt; blocked in probe | Expect friction; document; Sync+MIDI both may fail mid-show |
| Sync Idle on `ws://127.0.0.1:9980` | Live proof of C1 on hosted HTTPS |
| TD callbacks download started | Keep Copy/Download callbacks in Sync panel |
| Image/camera not exercised | Still need perf-mode + consent from static/Elliot |
| Screenshots: `shot-drag.webp`, `shot-field.webp`, `shot-midi-prompt.webp` | Evidence pack for rebuild brief |

### Full panel feature list (parity baseline from live + static)

- **Field:** presets Mitosis, Solitons, Pulsing, Holes, Mazes, Fingerprint, Spirals, Worms, Coral, Skate; palettes; reseed/reset/record; field stats.
- **Image:** Add image, camera, Inoculate / Develop / Resist / Palette only, Image mix, Sample colors.
- **Body:** Tilt & motion (default on in v7 — opt-in in v2); Microphone.
- **Sound:** Voice of the field, Hum/Schumann, Level (~70%), Mute, waveforms Sine/Triangle/Saw/Square/Pulse/Spectrum; sleeping-tab wake note.
- **Sync:** TD WebSocket JSON @ 20 Hz, optional 16×16 grid, Copy/Download TD callbacks; MIDI-to-TD CCs 20–29.

**Works (preserve):** splash EARTH CAVITY · 7.83 HZ; ENTER unlock; continuous field; drag colonies; explicit Lock loop; HUM frequency readouts; TD callback download.

**Friction (fix in rebuild):** MIDI permission UX; double-tap-hold lock; Sync Idle default; sleeping-tab audio wake copy.

---

## Engineering priority for rebuild (not patch order)

1. CPU RD + Canvas 2D display (no WebGL).  
2. Audio dispose + gesture unlock + limiter.  
3. Sync paths A/B/C with auth hello; fix C1/C2 by design.  
4. Privacy: gyro opt-in, mic+Sync consent, camera perf mode.  
5. UX: confirm destructive, explicit Lock primary + coach for gesture, `?perform=1`, PWA name Morphogen.  
6. System fonts; CSP; no `__morphogen` in prod.  
7. Feature parity checklist (see REBUILD-SPEC) against live panel list above.  

---

## Assumed invariant (carry forward)

“Ship on HTTPS + default localhost cleartext WebSocket + phone sensors” is **three products**. v2 must pick explicit supported paths and refuse to pretend the broken default works. Live probe confirmed Sync Idle on the hosted URL.

---

*End of MASTER-BRIEF. Sources: static + Elliot + live UX (merged).*
