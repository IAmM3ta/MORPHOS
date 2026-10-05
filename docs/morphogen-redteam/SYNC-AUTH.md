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

`idle → connecting → authenticating → open`; any failure → `error`, which stays visible instead of silently flipping back to `idle`. Socket handlers ignore events from a superseded socket, so a fast disconnect/connect can't stop the new pump.

## Reference TD side (`morphogen-v2/td/`)

- `morphogen_sync_auth.py` — pure-Python `SyncAuthGate`, no TouchDesigner imports; tested by `tests/test_td_sync_auth.py`.
- `morphogen_sync_callbacks.py` — WebSocket DAT callbacks. Every frame goes through the gate before `morphogen_table.clear()` / `morphogen_grid`; table layout (`/morphogen/{group}/{key}`, 16×16 grid) is unchanged from v1. Secret comes from a custom string par `Syncsecret` on the parent COMP; unset or short → all clients refused (fail closed).

## Still open (REBUILD-SPEC §6 client hardening)

Reconnect backoff + jitter, path-picker UI, `*.local` allowlist with confirm, persisted `tdUrl` sanitising. wss (path C) is still required for anything beyond a trusted LAN — the timestamp window is a replay speed bump, not transport security.
