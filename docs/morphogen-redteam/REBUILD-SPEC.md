# Morphogen v2 — First-Principles Rebuild Spec (No WebGL)

**Status:** Draft for rebuild after red-team (static + Elliot + live UX)  
**Date:** 2026-09-17 (America/New_York)  
**Hard constraint:** Reconstruct Morphogen entirely on first principles. **Eliminate WebGL entirely.** No WebGPU in v1 of rebuild.  
**Companion brief:** `/workspace/morphogen-redteam/MASTER-BRIEF.md`  
**Scaffold:** `/workspace/morphogen-v2/`

---

## 1. Product intent

Morphogen is a **live AV instrument**: Gray–Scott reaction–diffusion field + Schumann Hum audio + optional Body sensors + Image inoculate + Sync to TouchDesigner / MIDI.  
v2 keeps the instrument; replaces the GPU sim/display stack with **CPU RD + Canvas 2D**.

Splash DNA (preserve): “EARTH CAVITY · 7.83 HZ”; first gesture unlocks audio (and motion if opted in).

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│  Main thread                                             │
│  UI panels · pointer/brushes · audio · MIDI · sensors    │
│  Canvas 2D display (putImageData / bitmap blit)          │
│  Sync client (WS / MIDI)                                 │
└────────────┬──────────────────────────▲─────────────────┘
             │ postMessage (params,      │ ImageBitmap /
             │ brushes, seeds, locks)    │ stats / field summary
┌────────────▼──────────────────────────┴─────────────────┐
│  Worker thread                                           │
│  Portable JS/TS Gray–Scott kernel                        │
│  Float32 (or Uint8) U/V buffers · ping-pong              │
│  Stats downsample 16×16 · lock masks (CPU)               │
└─────────────────────────────────────────────────────────┘
```

**Rules**
- Simulation: worker (or main-thread fallback if workers blocked).
- Render: Canvas 2D only — `getContext('2d')`, never `webgl` / `webgl2` / `webgpu`.
- Audio / input / Sync: main thread only.
- Teardown: dispose audio, disconnect Sync, terminate worker, clear RAF.

---

## 3. Rendering (no WebGL)

| Item | Spec |
|------|------|
| API | Canvas 2D `ImageData` or `OffscreenCanvas` in worker → `transferToImageBitmap` → main `drawImage` |
| Display | `putImageData` or bitmap blit each frame |
| Color | Map U/V → palette LUT (Uint8Clamped RGBA) |
| Resolution | Desktop maxSide ≤ 720–960 (CPU); mobile ≤ 480–640; adaptive shrink if frame time > 32 ms |
| DPR | Cap 2; draw buffer size = CSS size × min(dpr, 2) |
| Locks | Up to 4 CPU mask buffers composited in display pass (not GL FBOs) |
| History | ≤ 4–8 field snapshots; byte-budget cap (e.g. 32 MB) |
| Background | Pause when `document.hidden` |

**Forbidden in v1:** `getContext('webgl'|'webgl2'|'webgpu')`, Three.js, regl, twgl, any GLSL.

---

## 4. Simulation

Portable Gray–Scott kernel (JS/TS):

```
∂u/∂t = du ∇²u − u v² + feed (1 − u)
∂v/∂t = dv ∇²v + u v² − (kill + feed) v
```

- Buffers: `Float32Array` preferred (quality); optional `Uint8` quantized path for low-end.
- Laplacian: 5-point or 9-point; wrap or clamp edges (match v7 feel — prefer wrap).
- Steps per frame: 1–4 adaptive (v7 used up to 6 on GPU — lower for CPU).
- Seed: click/drag brushes ≤ 8; inoculate from downscaled image (U/V or V-only).
- Presets: exact feed/kill/du/dv from v7 (see MASTER-BRIEF table).
- Stats: 16×16 meanU/meanV/energy/cx/cy/edge for UI + Sync grid.

---

## 5. Audio

| Requirement | Detail |
|-------------|--------|
| Hum | Schumann-inspired pad; base **7.83 Hz** partials; waveform modes: sine (HUM), triangle, sawtooth, square, pulse, spectrum |
| Live voices | Touch → voices; cap concurrency; duck Hum when many lives |
| Unlock | Strictly inside user gesture (`ENTER` / first click); re-offer CTA if `ctx.state !== 'running'` |
| Limiter | Brick-wall limiter **after** compressor (fixes hearing/clip risk) |
| Dispose | **MUST** call `dispose()` on teardown: stop oscillators, disconnect graph, `AudioContext.close()`, stop mic tracks |
| Mic | Opt-in; echoCancellation; RMS for MIDI CC26 + Sync `audio.rms` |
| Tab sleep | Pause/suspend when hidden; copy: tap to wake (live UX noted this) |
| Record | Detect `MediaRecorder` support; prefer WebM; iOS mp4/audio-only fallback |

---

## 6. Sync — fix C1 / C2

### Supported paths (document all three; default must not be broken mixed-content)

| Path | When | How |
|------|------|-----|
| **(A) Cleartext companion** | Local show, TD WebSocket DAT on 9980 | Serve controller on `http://127.0.0.1` (same-origin or companion page) so `ws://127.0.0.1:9980` is allowed. **Preferred local happy path.** |
| **(B) MIDI-only** | Hosted HTTPS, no wss | Web MIDI CCs 20–29 → TD MIDI In CHOP. Chrome/desktop. No WS. |
| **(C) Authenticated wss** | Remote / phone → TD | Optional recipe: mkcert / reverse-proxy / tunnel with **shared secret**. Not the silent default. |

**Default UX on HTTPS origin:** do **not** auto-connect `ws://127.0.0.1:9980` as if it will work. Show path picker: Companion (A) · MIDI (B) · Advanced wss (C). Live UX confirmed Sync **Idle** on default ws URL from HTTPS.

### Protocol

**Hello (required auth field in v2):**
```json
{ "v": 1, "hello": "morphogen", "t": <epoch_ms>, "auth": "<shared-secret>" }
```
TD callbacks reject / ignore telemetry until auth OK (update Python stub accordingly).

**Telemetry pump (~50 ms / 20 Hz), Morphogen → TD:**
```json
{
  "v": 1,
  "t": <ms>,
  "params": { "feed", "kill", "du", "dv", "speed" },
  "sensors": { "alpha", "beta", "gamma", "ax", "ay", "az" },
  "audio": { "rms", "energy" },
  "field": { "meanU", "meanV", "energy", "cx", "cy", "edge" },
  "loop": { "count" },
  "touches": [ { "x", "y", "p" } ],
  "grid": [ /* 256 floats, optional */ ]
}
```

**Client hardening**
- Allowlist: `127.0.0.1`, `localhost`, `*.local`; warn + confirm for others.
- Scheme: on `https:` page, refuse `ws:` except documented companion exception messaging.
- Reconnect with exponential backoff + jitter; pause when hidden.
- Backpressure: skip pump if `bufferedAmount` high.
- `tdGrid` default **off** unless localhost.
- Sanitize persist `tdUrl`.

**Bidirectional (optional, design for later)**  
Reserve `onmessage` for TD→app: `{ v, cmd: "setParams"|"freeze"|"preset"|"ping", ... }`. Not required for first ship; architecture must not preclude it.

**MIDI CCs 20–29 (parity):** Feed, Kill, Energy, Mean V, Centroid X/Y, Mic RMS, Gyro γ, Gyro β, Edge.

**TD callbacks compatibility:** Keep `/morphogen/{params|field|sensors|audio|loop}/key` + 16×16 grid table shape; add auth gate before `table.clear()`.

---

## 7. Sensors / privacy

| Sensor | v2 policy |
|--------|-----------|
| Gyro / motion | **Opt-in** (not default on). Hard error banner if permission denied after user enables. |
| Mic + Sync | Consent modal when both active / on Connect with mic on. |
| Camera | Performance mode: ideal ≤ 640×480 (not 1080p); stop tracks when panel closes; LED indicator. |
| TD export | Sensors omitted until Body toggles on; never silent exfil. |

---

## 8. UX requirements

- Confirm dialogs: Reset field / Clear all loops when `lockCount > 0`; snapshot before reset.
- Loop lock: **explicit Lock loop / Release** is primary (live: works). Gesture double-tap-hold secondary + coach mark / progress ring (live: failed to discover).
- `?perform=1` — hide Grok Remix chrome, debug noise, non-essential banners.
- PWA manifest `name` / `short_name`: **Morphogen** (not “Grok App”).
- No Google Fonts dependency for core — system stack: `ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif`.
- ENTER splash unlock preserved.
- Destructive Defaults / Clear: confirm.
- Remove or hide multi-phone / `roomCode` promise unless multiplayer ships (Elliot H5).

---

## 9. Feature parity checklist vs Morphogen v7

| Area | v7 capability | v2 target |
|------|---------------|-----------|
| Field presets (10) | Mitosis…Skate | **Parity** |
| Palettes | abyss, spore, porcelain, ember, chlorophyll, … | **Parity** (CPU LUT) |
| Brush paint / colonies | ≤8 brushes, drag seed | **Parity** (live confirmed) |
| Loop locks | max 4; gesture + panel | Panel **required**; gesture best-effort + coach |
| Reseed / Reset / Record | yes | **Parity** + confirms; Record with capability detect |
| Image: add / camera / Inoculate / Develop / Resist / Palette only / mix / sample | yes | **Parity** + camera perf mode |
| Body: tilt, mic | gyro default on | Opt-in gyro; mic consent with Sync |
| Sound: Hum, level, mute, 6 waveforms, voice of field | yes | **Parity** + dispose + limiter |
| Sync WS JSON 20 Hz + grid + callbacks copy/download | yes | Paths A/B/C; auth hello; Idle default fixed |
| MIDI CC 20–29 | yes | **Parity** (path B); permission UX documented |
| Undo / history | GPU snapshots | CPU snapshots, tighter budget |
| Antenna hover | yes | Nice-to-have |
| `window.__morphogen` | always | `?debug=1` only |
| WebGL2 sim | yes | **Removed** |

---

## 10. Explicit NON-goals (first rebuild ship)

- WebGL / WebGPU / GLSL shaders  
- Full multiplayer / `roomCode` networking  
- Perfect float GPU parity at 2160px  
- Authenticated cloud Sync SaaS  
- Offline service worker perfection (optional later; system fonts + cacheable bundle enough)  
- Bidirectional TD control plane (design hooks only)  
- Binary WS grid path  
- Google Fonts / Grok extensions as hard dependencies  
- iOS WebMIDI claims  
- Replacing TouchDesigner itself  

---

## 11. Security / headers (ship checklist)

- CSP: `default-src 'self'`; tight `connect-src` for WS; no arbitrary script CDN  
- `Permissions-Policy`: camera/mic/gyroscope/midi self  
- `frame-ancestors 'none'`  
- Schema-validate persisted state  
- No production `__morphogen` dump  

---

## 12. Operator kill-list (document in README)

Unsupported / fragile matrices:
- iOS Safari + Sync over HTTPS cleartext WS  
- iOS + WebMIDI  
- Remote phone → cleartext TD without path A/C  
- Multi-client unauthenticated TD server  
- Offline venue with font CDN dependency (mitigated in v2 by system fonts)  

---

## 13. Acceptance criteria (rebuild)

1. `rg` finds **no** `webgl` / `WebGL` / `getContext('webgl` / `webgpu` in `/workspace/morphogen-v2`.  
2. Click seeds RD colonies on Canvas 2D; Hum unlocks on first gesture; `dispose()` exists and is called on teardown.  
3. Sync UI documents A/B/C; hello includes `auth`; default on HTTPS is not a silent broken `ws://` connect.  
4. Gyro opt-in; mic+Sync consent; camera perf mode present or stubbed with TODO.  
5. Parity checklist items marked required are implemented or stubbed with labeled UI.  
6. PWA name Morphogen; `?perform=1` supported or stubbed.  

---

*End of REBUILD-SPEC.*
