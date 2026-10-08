# Morphogen v2 Sync — auth handshake (C2 fix)

Extends REBUILD-SPEC §6 "Protocol". Added 2026-10-05.

## Handshake

```json
// client → TD, first frame on the socket
{ "v": 1, "hello": "morphogen", "t": <epoch_ms>, "auth": "<shared-secret>" }
// TD → client
{ "v": 1, "ack": "morphogen", "ok": true }
{ "v": 1, "ack": "morphogen", "ok": false, "reason": "bad_auth" }
```

- The client sends the hello on open and pumps **no telemetry** until `ok: true`. No ack within 2 s (`HELLO_ACK_TIMEOUT_MS`) → status `error`, socket closed.
- The browser client treats `ok: false` as terminal: it closes and surfaces `reason` (never the secret). TD drops the connection itself on any pre-auth non-hello frame or after 3 bad hellos.
- Reason codes: `auth_required` (telemetry before hello), `bad_auth`, `stale_hello` (|now − t| > 30 s), `frame_too_large` (> 64 KB), `bad_json`, `bad_version`, `too_many_attempts`.
- Secrets: ≥ 16 chars, no whitespace. TD compares constant-time (`hmac.compare_digest`); the client refuses short or padded tokens before opening a socket. Keep the secret out of git.
- After auth, malformed frames are ignored (not dropped) and a repeat hello is a no-op. Reconnecting always requires a fresh hello.

## Client state machine (`morphogen-v2/src/sync/tdClient.ts`)

`idle → connecting → authenticating → open`; transient failures → `reconnecting → connecting …`; terminal failures (or an exhausted retry budget) → `error`, which stays visible instead of silently flipping back to `idle`. Socket handlers ignore events from a superseded socket, so a fast disconnect/connect or a retry can't be hijacked by a late close from the old one.

## Reconnect backoff (added 2026-10-06)

Only failures that a retry can plausibly fix are retried:

| Failure | Retry? | Why |
|---|---|---|
| Socket never opened (TD not running yet, network blip) | yes | TD may be mid-restart |
| Authed session dropped (`open` → close) | yes | stage restart / Wi-Fi roam |
| URL / token validation, `new WebSocket` throws | no | deterministic — same input, same failure |
| TD `ok: false` ack (`bad_auth`, `stale_hello`, …) | no | wrong secret or clock; retrying burns TD's 3-hello budget |
| No ack within 2 s | no | TD isn't auth-gated; don't keep sending the secret to it |
| TD closes during the handshake (no ack) | no | non-conforming server; same reason |

Delay for retry *n* (0-based) is `reconnectDelayMs(n)`: capped exponential backoff with equal jitter — ceiling = min(15 s, 500 ms · 2ⁿ), delay uniform in [ceiling/2, ceiling). The floor stops a client hammering TD; the jittered upper half spreads a room of phones apart when TD comes back. Defaults: `RECONNECT_BASE_MS = 500`, `RECONNECT_MAX_MS = 15000`, `RECONNECT_MAX_ATTEMPTS = 8` (≈ 30–60 s of retrying in total before giving up). A successful ack resets the budget; every retry is a fresh socket and a fresh hello with a new `t`. `disconnect()` cancels a pending retry. While waiting, `status === 'reconnecting'`, `reconnectAttempt` / `nextRetryAt` are set, and `lastError` reads e.g. `Could not reach TD — retry 2/8 in 0.7 s`. Opt out with `new TdClient(secret, { autoReconnect: false })`.

Tests: `cd morphogen-v2 && npm test` (node:test with a fake WebSocket + mocked timers — handshake, terminal vs transient classification, backoff timing, budget exhaustion, stale-socket guard).

## Sync status chip (added 2026-10-07)

The footer now has a live Sync chip (`#syncStatus`, `aria-live="polite"`) plus a **Retry now** button, mounted by `mountSyncStatus()` in `morphogen-v2/src/ui/panels.ts`. Text and colour come from the pure `describeTdStatus(td.snapshot(), now)` in `tdClient.ts`:

| `status` | Chip text | Tone |
|---|---|---|
| `idle` | Sync off | idle |
| `connecting` | Sync: connecting… / reconnecting (try n/8)… | busy |
| `authenticating` | Sync: waiting for TD hello ack… | busy |
| `open` | Sync: live → TD | ok |
| `reconnecting` | Sync: TD unreachable — retry n/8 in 2.4 s (live countdown) | warn |
| `error` | Sync error: `lastError` | error |

- The countdown is recomputed from `nextRetryAt` on a 250 ms tick (`SYNC_COUNTDOWN_TICK_MS`) that exists **only** while `reconnecting`, so it can't drift from the real retry and an idle/live session costs no timers. It rounds up, so it never reads `0.0 s` while a retry is still pending.
- **Retry now** is visible only while `reconnecting`. `TdClient.retryNow()` cancels the pending timer and opens a fresh socket + hello immediately, but does **not** reset the retry budget — mashing it can't exceed 8 tries — and it is a no-op after a terminal failure (`bad_auth`, ack timeout, …), which still needs a deliberate `connect()` with a corrected secret.
- `snapshot()` returns plain data (status, lastError, attempt, budget, nextRetryAt) and never contains the token; `?debug=1` now exposes it via `__morphogen().td`.

Tests: `morphogen-v2/tests/syncStatus.test.mjs` (labels/tones, countdown rounding + clamping, snapshot, retryNow budget + terminal no-op, chip render/tick/button/unmount with a DOM stub).

## Sync URL allowlist + persisted settings (added 2026-10-08)

Every TD URL now goes through `sanitizeTdUrl()` in `morphogen-v2/src/sync/syncUrl.ts` before `validateTdUrl()` checks the path, and `TdClient.connect()` opens the **canonical** URL it returns, never the raw paste. This closes red-team H-WS (any URL accepted) and M-PERSIST (`tdUrl` rehydrated unsanitised).

**Sanitising.** Only `ws://` / `wss://`, at most 512 chars, no spaces or control characters (which `URL()` would silently strip, letting look-alike pastes through), no `user:pass@` (it only leaks into storage — use the Sync secret field), fragment dropped, scheme and host lower-cased. Error reasons are fixed strings and never echo the input.

**Host allowlist** (`classifyTdHost`, REBUILD-SPEC §6):

| Host | Class | Path A companion (`ws://`) | Path C (`wss://`) |
|---|---|---|---|
| `127.0.0.1`, `localhost`, `[::1]` | loopback | allowed (not from an https page) | allowed |
| `name.local`, `td.stage.local` (plain DNS labels) | mdns | allowed (not from an https page) | allowed |
| anything else, incl. LAN IPs and `localhost.evil.com` | remote | **refused** — confirming can't make cleartext telemetry to a remote host OK | needs `connect(…, { confirmRemote: true })` after the user accepts `remoteConfirmMessage(host)` |

LAN IPs (`192.168.x.x`) are deliberately "remote": the confirm is one click, and private addresses are exactly what tunnels and shared Wi-Fi hand out. Use `*.local` for a trusted LAN TD box.

**Persisted settings.** `loadSyncSettings()` / `saveSyncSettings()` own the `localStorage` key `morphogen-v2.sync`, stored as `{ v:1, url, path, grid }` and nothing else:

- On load, bad JSON, a wrong version, a non-object, an unknown path or a URL that fails sanitising wipes the key and returns defaults with `dropped` set to the reason. Only the three known fields are read (no object spread), so `__proto__` or extra keys are inert.
- The auth token is never part of the record; a stored `auth` field (old build or tampering) is ignored and the key rewritten without it.
- A remote host always comes back with `needsConfirm: true`. Confirms are per session and are **not** persisted, so tampered storage on a shared machine can't silently point the next session at someone else's wss endpoint.
- If `grid` isn't stored, it defaults on only for loopback (`defaultTdGrid`), since 256 floats per pump is cheap locally and costly over Wi-Fi or tunnels (Elliot M2).

`main.ts` loads the record at start-up (`?debug=1` shows it in `__morphogen().sync`); the path-picker UI will be the first caller of `saveSyncSettings` and the confirm prompt.

Tests: `morphogen-v2/tests/syncUrl.test.mjs` (12 tests: host classes, canonical form, rejection reasons that don't echo input, per-path validation and the remote confirm, connect opening only the canonical URL, save/load round-trip, corrupt/tampered records wiped, secret scrubbed, throwing storage).

## Reference TD side (`morphogen-v2/td/`)

- `morphogen_sync_auth.py` — pure-Python `SyncAuthGate`, no TouchDesigner imports; tested by `tests/test_td_sync_auth.py`.
- `morphogen_sync_callbacks.py` — WebSocket DAT callbacks. Every frame goes through the gate before `morphogen_table.clear()` / `morphogen_grid`; table layout (`/morphogen/{group}/{key}`, 16×16 grid) is unchanged from v1. Secret comes from a custom string par `Syncsecret` on the parent COMP; unset or short → all clients refused (fail closed).

## Still open (REBUILD-SPEC §6 client hardening)

Path-picker UI (URL / path / secret entry feeding `connect()`, the remote-host confirm and `saveSyncSettings` — the status chip and URL hygiene above are the plumbing it sits on). Pause the pump while `document.hidden` (`bufferedAmount` backpressure is already in the pump). wss (path C) is still required for anything beyond a trusted LAN — the timestamp window is a replay speed bump, not transport security.
