# Morphogen Web Client — Static Red-Team Report

**Target:** https://morphogen-synth.grok.me  
**Method:** Static analysis of shipped assets on box + public fetches (`/td/morphogen_ws_callbacks.py`, manifest, headers, `extensions.js`). No live browser GUI.  
**Assets analyzed:**
- `/workspace/morphogen-synth.html` (SSR shell)
- `/workspace/morphogen-assets/morphogen-app.js` (~154KB minified app bundle)
- `/workspace/morphogen-assets/index.js` (~435KB React/TanStack/vendor)
- `/workspace/morphogen-assets/routes.js` (thin route → app component)
- `/workspace/morphogen-assets/morphogen_ws_callbacks.py` (fetched live, 200)
- `/workspace/morphogen-assets/manifest.webmanifest`, styles, favicon

**Date:** 2026-09-17 (America/New_York)

---

## Executive summary (top findings)

| # | Sev | Finding |
|---|-----|---------|
| 1 | **High** | No Content-Security-Policy; third-party `extensions.js` from grok.com + Google Fonts; `window.__morphogen` debug API exposes live sim/audio state to any same-page script |
| 2 | **High** | TouchDesigner WebSocket client accepts **any** URL; streams sensors/gyro/mic RMS/touches/field/grid at **20 Hz** with no allowlist, auth, or reconnect hardening |
| 3 | **High** | HTTPS page defaults to `ws://127.0.0.1:9980`; remote TD requires `wss://` (documented) but URL field has no scheme validation — mixed-content / user footguns |
| 4 | **High** | Audio engine `xa.dispose()` exists but is **never called** on unmount; WebGL cleanup does not stop Hum oscillators / AudioContext → stuck audio nodes |
| 5 | **Medium** | No `webglcontextlost` / `webglcontextrestored` handlers; WebGL2 hard-required; float extensions requested but unused (RGBA8 sim) |
| 6 | **Medium** | Tab background: RAF continues without `document.hidden` pause; only `visibilitychange` resumes AudioContext — thermal/battery + desync risk |
| 7 | **Medium** | Destructive UX: Reset field / Clear all loops / unlock without confirm; double-tap+hold loop lock is poorly discoverable vs product copy |
| 8 | **Medium** | Privacy: camera (environment, 1080p ideal), mic, and deviceorientation/motion; TD export always includes sensor packet when connected; persist stores `tdUrl` in `localStorage` (`morphogen-v7`) |

---

## 1. Architecture map

```
morphogen-synth.html (SSR shell, canvas + hidden video, Enter gate)
        │
        ├─ /assets/index-*.js     TanStack Start/Router, React, Radix, sonner toasts
        ├─ /assets/routes-*.js    export component → Morphogen app
        └─ /assets/morphogen-app-*.js
                │
                ├─ Zustand store Z  name: "morphogen-v7" (persist: params, preset, waveform,
                │                   volume, tdUrl, tdGrid, gyroOn, audioOn)
                ├─ Runtime bus X    params, brushes, sense, stats (16×16 grid), morph, locks, waveform
                ├─ WebGL2 engine    constructor(canvas, maxSide≈oi()) — ping-pong RD sim
                │     shaders: Qi (vert), $i (sim Gray-Scott), ea (seed), ta (display+locks), na (stats)
                │     textures: simA/simB, 4 lock FBOs, stats 16×16, history≤8 GPU snapshots
                ├─ Audio xa         Schumann Hum pad (pa[] partials @ 7.83 Hz base), live voices,
                │                   noise, delay/echo feedback, compressor, mic analyser, MediaStream capture
                ├─ Sensors Ca/Sa    deviceorientation(+absolute), devicemotion; iOS requestPermission
                ├─ Pointer wa       brushes≤8, double-tap+hold(~260ms) → lock loop; antenna hover
                ├─ TD client ka     WebSocket client, hello + pump @ 50ms (20 Hz)
                ├─ MIDI Ea          Web MIDI out CC 20–29 @ ~25 Hz
                ├─ Recorder Na      canvas.captureStream(30) + optional audio tracks → WebM/MP4
                └─ window.__morphogen()  debug snapshot getter
```

**Panels (Zustand UI):** Field / Image / Body (sense) / Sound / Sync  
**Presets:** Gray-Scott species (e.g. Mitosis, Solitons, Pulsing, U-skate, …) via `feed/kill/du/dv`  
**Waveforms:** sine (HUM/Schumann), triangle, saw, square, pulse, spectrum  
**Related public artifact:** `/td/morphogen_ws_callbacks.py` — TouchDesigner WebSocket DAT server callbacks (JSON → Table DATs `morphogen_json` / `morphogen_grid`).

**Hosting signals:** Cloudflare + Vercel (`cf-ray`, `x-vercel-*`), HSTS, `x-robots-tag: noindex`, no app service worker (`/sw.js` → SPA 404 HTML).

---

## 2. WebGL / simulation failure modes

### [High] WebGL2 hard requirement — no fallback
**Evidence:** `getContext('webgl2',{…})`; throws `WebGL2 is required for Morphogen.` / UI string `WebGL2 unavailable`.  
**Impact:** Safari older iOS, some enterprise GPUs, remote desktop, and software GL fail closed with no 2D/canvas fallback.  
**Fix:** Feature-detect early on Enter screen; show recovery copy + reduced mode (CPU RD or static art) if product requires broader reach.

### [Medium] No context-loss recovery
**Evidence:** `rg` for `webglcontextlost` / `webglcontextrestored` → **0 matches**. Engine `destroy()` deletes GL objects but nothing rebinds after GPU reset (tab discard, driver TDR, mobile thermal).  
**Impact:** Black canvas / hard stall until full reload; recording/TD may keep “alive” while sim is dead.  
**Fix:** Listen for lost/restored; stop RAF on lost; rebuild programs/FBOs and re-seed on restored; surface toast.

### [Medium] Memory growth — history + locks + maxSide
**Evidence:**
- GPU history: `historyMax=8` full-res ping-pong targets (`checkpoint`/`undo`)
- App undo stack: `fi=8` snapshots via `hi.capture()` (params + lockCount) + `checkpointField`
- 4 lock textures at full `simW×simH`
- `maxSide` from `oi()`: desktop up to **2160**, mobile clamped ~960–1600; DPR capped at 3
- Adaptive shrink: if `slow>48` and `maxSide>800`, `maxSide *= 0.82` and `fitSim(!0)`
- `preserveDrawingBuffer: true` (needed for capture/record) increases memory bandwidth

**Impact:** Mid-tier mobile can OOM or thermally throttle after many undos/locks at high DPR.  
**Fix:** Lower mobile caps; prefer `preserveDrawingBuffer:false` when not recording; cap history by byte budget; dispose lock textures when unused.

### [Low] Float extensions requested but unused
**Evidence:** `getExtension('EXT_color_buffer_float'|'OES_texture_float_linear'|'EXT_float_blend')` then sim uses `RGBA` + `UNSIGNED_BYTE` + `NEAREST`.  
**Impact:** Precision quantization in Gray-Scott (feed/kill sensitive); extensions are dead weight / false confidence.  
**Fix:** Either use `RGBA16F` when extension present, or stop requesting unused extensions; document 8-bit limits.

### [Medium] Background tab throttling
**Evidence:** Continuous `requestAnimationFrame` loop; **no** `document.hidden` check. Only `visibilitychange` → `audio.resume()` when visible. Sim `acc`/`steps` (1–6) keep integrating when browser throttles RAF → irregular `uDt` / speed feel.  
**Fix:** Pause sim + audio when hidden; optional `setTimeout` low-power tick for TD keepalive only if desired.

### [Low] Mobile GPU / precision
**Evidence:** `precision highp float` in all FS shaders; steps loop up to 6 per frame; brush array `uBrush[8]`. Highp can fall back on some GPUs; expensive on tile-based mobile GPUs.  
**Fix:** Offer mediump path or auto-lower `steps`/`maxSide` after slow counter (already partially done).

---

## 3. Audio failure modes

### [High] Stuck nodes — `dispose()` never invoked
**Evidence:** `xa.dispose()` stops mic, live voices, Hum oscillators, LFO, noise, `ctx.close()`. Call-site count for `.dispose()` on audio path: **0**. Unmount cleanup: `delete window.__morphogen; … c.current.stop(); n.destroy();` — **no** `i.current.dispose()`.  
**Impact:** Navigating away / HMR / remount leaves Schumann Hum + delay feedback running; battery drain; “ghost” sound after UI gone.  
**Fix:** Always `i.current?.dispose()` in the same effect cleanup as WebGL `destroy()`; also disconnect TD (`s.current?.disconnect()`) and MIDI (`o.current?.dispose()`).

### [Medium] Autoplay / unlock policy
**Evidence:** Enter / first gesture calls `unlock()` → `AudioContext || webkitAudioContext` + `resume()` if suspended; toast `Audio could not start — tap again to retry`. Hum bus ramps to ~0.72.  
**Impact:** iOS Safari still fails if unlock not tied to direct user gesture chain; muted switch / `audioOn` interact with master gain squared (`volume*volume`).  
**Fix:** Keep unlock strictly inside click/touch handler; re-offer unlock CTA if `ctx.state !== 'running'`.

### [Medium] Schumann / HUM voice design risks
**Evidence:** Base `fa=7.83`; partials `pa=[{hz:7.83…250.56}]`; live voices use multiple oscillators + FM + delay feedback into tilt filter (`delayGain` 0.22, `echoGain` 0.1) then compressor (`threshold -18`, ratio 3.2).  
**Impact:** Feedback delay graph can build energy; compressor helps but sudden multi-touch + spectrum mode can still clip on laptop speakers / hearing fatigue at default volume 0.7.  
**Fix:** Hard brick-wall limiter after compressor; cap simultaneous live voices; duck Hum when many lives.

### [Low] Sample rate / iOS quirks
**Evidence:** Context created with `{latencyHint:'interactive'}` only — no `sampleRate` request. Noise buffer length `sampleRate*2`. Recording prefers WebM VP9/Opus; iOS often only `video/mp4` or unsupported → `Recording is not available` / empty.  
**Fix:** Detect `MediaRecorder` support before showing Record; use audio-only fallback; test 44.1 vs 48 kHz Hum beating.

### [Info] Mic path
**Evidence:** `getUserMedia({audio:{echoCancellation,noiseSuppression}})`; analyser fftSize 128; failure toast. Mic RMS exported to MIDI CC26 and TD `audio.rms` via `()=>X.mic`.

---

## 4. TouchDesigner path

### Protocol (client → server only)
**Evidence:** class `ka` in `morphogen-app.js`; embedded callback string `Ai` + public file `/td/morphogen_ws_callbacks.py`.

1. Client connects to user-supplied URL (default `ws://127.0.0.1:9980`).
2. On open: `{"v":1,"hello":"morphogen","t":<epoch_ms>}`
3. Every **50 ms**: JSON from `Da(includeGrid, getMic)`:

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
  "grid": [256 floats]   // optional 16×16, tdGrid
}
```

Values quantized with `Oa` (4 decimal places). **No `onmessage` handler** — client never consumes TD→browser messages (unidirectional).

### TD server script (`morphogen_ws_callbacks.py`)
- `json.loads` then writes rows `/morphogen/{params|field|sensors|audio|loop}/` + key.
- Grid: expects list; writes 16 rows × 16 cols into `morphogen_grid`.
- **Does not `eval` JSON** — good. Uses `str(k)` in path concatenation.

### [High] Open WS to attacker / no allowlist
**Evidence:** `new WebSocket(this.url)` after `trim()` only; persisted `tdUrl` in `localStorage` key `morphogen-v7`.  
**Impact:** If user pastes `wss://evil.example`, attacker receives continuous biometric-ish sensor stream + touch positions + mic RMS + field state. Social engineering via “Sync” panel is enough — no CSRF needed.  
**Fix:** Allowlist `ws(s)://127.0.0.1|localhost|*.local`; warn on remote hosts; optional token in hello; never persist hostile URLs without confirm.

### [High] HTTPS → `wss` requirement / mixed content
**Evidence:** Error string `Socket error — if this page is HTTPS, TouchDesigner must serve wss://`; docs in py file. Default `ws://127.0.0.1:9980` works on Chromium localhost exception; remote LAN IP over plain `ws://` fails from HTTPS origin.  
**Fix:** Auto-rewrite scheme based on `location.protocol`; UI wizard for reverse-proxy / TD wss.

### [Medium] No reconnect
**Evidence:** `onclose` → status `idle`; **0** `reconnect` matches. Dropped Wi‑Fi / TD restart requires manual Connect.  
**Fix:** Exponential backoff reconnect with jitter; pause pump when hidden.

### [Low] TD path injection / XSS in TD land
**Evidence:** `table.appendRow(["/morphogen/params/" + str(k), v])` — if a future bidirectional protocol accepted hostile keys, path/script CHOPs could break. Current client controls keys (safe). Grid assumes `len>=256` without guard — short list → TD errors / partial rows.  
**Fix:** Sanitize keys `[A-Za-z0-9_]`; validate `len(grid)==256`.

### [Info] MIDI alternative
CC 20–29: Feed, Kill, Energy, Mean V, Centroid X/Y, Mic RMS, Gyro γ/β, Edge. `sysex:false`.

---

## 5. UX / product risks

### [Medium] Gesture discoverability
**Evidence:** Marketing copy: “Double-tap and hold to lock a loop.” Implementation in `wa`: second tap within 420ms & 64px → `lock` mode; hold **260ms** without move >22px → `locked` + `vibrate(16)`. Easy to miss; move cancels into paint. Panel also has explicit `Lock loop` / `Release`.  
**Fix:** First-run coach mark; progress ring already driven via callback `i?.(a,x,y)` — ensure visible.

### [Medium] Destructive actions without confirm
**Evidence:** `Clear all loops` → `onClick:x` with no `confirm`; Reset field toolbar button; Defaults control. Undo stack helps but Clear locks may not push undo.  
**Fix:** Confirm dialog when `lockCount>0`; always snapshot before reset.

### [Medium] Camera / mic permissions & privacy
**Evidence:**
- Camera: `facingMode:'environment'`, ideal 1920×1080, continuous `requestAnimationFrame` → `setImage(video)`
- Mic: optional, echoCancellation on
- Gyro default `gyroOn:true`; Enter forces `Sa()` permission prompt path on iOS
- Hidden `<video playsInline muted>` in SSR HTML

**Impact:** Users may not realize environment camera stays hot while `cameraOn`; TD stream exports motion sensors whenever connected.  
**Fix:** Privacy sheet on first Sync/Body enable; stop tracks when panel closes; indicator LED in chrome; exclude sensors from TD until toggled.

### [Low] Loop lock product risk
Locks composite in display shader (`uLock0…3`); max 4. “Keep loops 1–N” UI strings exist. Losing locks on resize/context loss is unreported.

### [Info] roomCode / role:`solo`
Zustand fields `roomCode:''`, `role:'solo'` appear unused in shipping UI — future multiplayer surface; ensure they do not silently enable networking later without threat model.

---

## 6. Security / abuse

### [High] Missing CSP + third-party script
**Evidence:** Response headers: HSTS yes; **no** `Content-Security-Policy`, `X-Frame-Options`, `Permissions-Policy`, `Referrer-Policy`. HTML loads:
- `https://grok.com/grok-app-builder/extensions.js` (defer) with `data-project-id`
- Google Fonts CSS  
`extensions.js` sets `shadow.innerHTML` and talks to deployer origins.  
**Impact:** Any XSS or extension compromise gets full access to camera/mic/WebGL/`__morphogen`/TD URL. Clickjacking possible without frame ancestors.  
**Fix:** Strict CSP (`default-src 'self'`; explicit font/CDNs); `frame-ancestors 'none'`; `Permissions-Policy` for camera/mic/gyroscope/midi; consider dropping extensions script on production synth URL.

### [Medium] `window.__morphogen` info leak
**Evidence:** Assigns function returning `{energy, meanV, brushes, locks, feed, kill, sim, gyro, preset, hz, voices, antenna, recording, morphing, waveform, history}`. Deleted on cleanup.  
**Impact:** Any script on page (extensions, XSS, malicious browser extension) can fingerprint performance session / exfiltrate interaction.  
**Fix:** Gate behind `?debug=1` or `localStorage` flag; do not expose in production builds.

### [Medium] Persist / prototype pollution surface
**Evidence:** Zustand persist `merge:(e,t)=>({...t,...e})`, `JSON.parse` without proto sanitization; runtime `Object.assign(X.params,e)` via `si`. Partialize includes attacker-interesting `tdUrl`.  
**Impact:** Shared-device localStorage tampering can point next session at evil WSS or corrupt params. Classic `__proto__` less effective with object spread, but nested pollution / unexpected keys still possible.  
**Fix:** Schema-validate rehydrated state (zod); allowlist param keys; sanitize `tdUrl`.

### [Low] Unsafe HTML in app bundle
**Evidence:** App code: no `dangerouslySetInnerHTML` / `innerHTML` / `eval` / `new Function`. Vendor React in `index.js` has normal `dangerouslySetInnerHTML` plumbing. TD callbacks copied as text — OK.  
**Fix:** Keep React text escaping; avoid ever rendering TD JSON into DOM.

### [Low] Dependency surface
Bundled: React, TanStack Router/Start, Radix UI, Zustand persist, sonner, lucide-style icons. Versions not clearly bannered in minified output — SCA harder.  
**Fix:** Generate SBOM; pin and audit.

### [Info] Project / infra identifiers
`meta name="grok-project-id"` / `grok:app_id` = `01a0ae0e-59ed-77a0-9018-2a9b7d21ac4e`; Cloudflare `__cf_bm` cookie on `Domain=grok.me`. Low sensitivity but aids targeting.

### [Info] CSRF
Mostly N/A — static app, no cookie auth API. Abuse is user-driven WS connect and permission grants.

---

## 7. Reliability

### [Medium] Offline / PWA
**Evidence:** Manifest `/__grok/manifest.webmanifest` is generic **“Grok App”** (not “Morphogen”), `display:standalone`, single 180×180 icon. **No service worker** (`/sw.js` returns SPA HTML 404). Fonts require network.  
**Impact:** “Add to Home Screen” branding wrong; offline play fails; first paint depends on Google Fonts.  
**Fix:** App-specific manifest; optional SW caching for JS/WASM-less assets; self-host fonts.

### [Low] CDN / platform
Cloudflare + Vercel; `cache-control: public, max-age=0, must-revalidate` on HTML; hashed assets under `/assets/`. Good for deploy atomicity; cold `DYNAMIC` HTML.  
**Fix:** Long-cache hashed bundles (likely already); monitor CF 5xx separately from app bugs.

### [Low] Deep links
Single route `/` via TanStack; no documented query deep links for preset/tdUrl. `roomCode` unused.  
**Fix:** If adding `?preset=` / `?td=`, validate strictly to avoid open-redirect-style WS.

### [Info] robots
`/robots.txt` → SPA 404 body; header `x-robots-tag: noindex` on HTML — intentional private-ish deploy.

---

## Severity legend

| Tag | Meaning |
|-----|---------|
| Critical | Remote code exec / mass user compromise without interaction (none confirmed in this static pass) |
| High | Significant confidentiality, safety (hearing), or reliability failure; realistic abuse |
| Medium | Notable product/security/reliability issue under common conditions |
| Low | Edge cases, defense-in-depth |
| Info | Observations for backlog |

---

## Recommended fix priority (engineering order)

1. Call `audio.dispose()`, TD `disconnect()`, MIDI `dispose()` on unmount; pause RAF when `document.hidden`.
2. Add CSP + Permissions-Policy; remove or tightly scope `extensions.js` on this origin; hide `__morphogen` in prod.
3. Harden TD URL (allowlist, scheme auto-fix, reconnect, consent banner for sensor export).
4. Handle WebGL context loss; revisit float textures; tighten mobile `maxSide`/history budgets.
5. Confirm dialogs for Clear locks / Reset; coach marks for double-tap-hold; recording capability detection.
6. Morphogen-specific PWA manifest + optional offline shell; self-host fonts.

---

## Appendix A — Key symbols / strings

| Symbol / string | Role |
|-----------------|------|
| `morphogen-v7` | Zustand persist name |
| `xa` | Audio engine class |
| `ka` | TD WebSocket client |
| `Ea` | MIDI output |
| `Na` | MediaRecorder session |
| `oi` / `oa` | maxSide policy / aspect fit |
| `Da` / `Oa` | TD payload builder / quantizer |
| `wa` | Pointer / loop-lock gestures |
| `Sa` / `Ca` | Motion permission / listeners |
| `Qi,$i,ea,ta,na` | GLSL ES 3.00 shaders |
| `hello: morphogen` | WS handshake |
| `ws://127.0.0.1:9980` | Default TD URL |
| `window.__morphogen` | Debug API |

## Appendix B — Fetched public endpoints

| URL | Result |
|-----|--------|
| `/td/morphogen_ws_callbacks.py` | 200, 1923 bytes |
| `/__grok/manifest.webmanifest` | 200, generic Grok App |
| `/favicon.svg` | 200 |
| `/assets/styles-yO5zedZ4.css` | 200 |
| `/sw.js` | 404 (SPA HTML) |
| `/td/` | 307 |
| `/health`, `/api/health` | 404 |

---

*End of report. Scope limited to Morphogen client static analysis; MORPHOS codec / GitHub not modified.*
