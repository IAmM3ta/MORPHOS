"""Morphogen v2 Sync — TouchDesigner-side auth gate (pure Python, no TD imports).

Fixes red-team finding C2 ("unauthenticated multi-client TD server"): the
legacy callbacks DAT wrote every incoming JSON frame straight into tables, so
any page that could reach ws://<host>:9980 could drive the show and receive
nothing back to tell it otherwise.

Protocol (mirrors morphogen-v2/src/sync/tdClient.ts; see docs/morphogen-redteam/SYNC-AUTH.md):

    client -> {"v": 1, "hello": "morphogen", "t": <epoch_ms>, "auth": "<secret>"}
    TD     -> {"v": 1, "ack": "morphogen", "ok": true}
              or {"v": 1, "ack": "morphogen", "ok": false, "reason": "<code>"}
    client -> telemetry frames (only after ok: true)

Rules enforced here:
  * The first frame on a connection must be a hello; anything else is a
    protocol error and the connection is dropped (no telemetry pre-auth).
  * Secret comparison is constant-time (hmac.compare_digest).
  * Hello timestamps outside +/- max_skew_ms are refused (cheap replay guard
    for a captured hello; not a substitute for wss on untrusted networks).
  * Oversized frames are refused before json.loads.
  * A bad hello (wrong secret / stale t) gets an ok:false ack; the browser
    client treats that as terminal and closes. After max_hello_attempts bad
    hellos on one connection TD drops it itself (non-conforming clients).
  * Reason codes never echo the submitted secret.

The TD glue lives in morphogen_sync_callbacks.py; this module is importable
and testable without TouchDesigner (see tests/test_td_sync_auth.py).
"""

from __future__ import annotations

import hmac
import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional, Tuple

MIN_SECRET_LEN = 16  # keep in sync with MIN_AUTH_TOKEN_LEN in tdClient.ts
MAX_FRAME_BYTES = 64 * 1024  # telemetry with a 256-float grid is ~5 KB
DEFAULT_MAX_SKEW_MS = 30_000
DEFAULT_MAX_HELLO_ATTEMPTS = 3

# Actions returned by SyncAuthGate.on_text — the TD glue maps these to DAT ops.
ACCEPT = "accept"  # authed telemetry: caller should apply `payload`
REPLY = "reply"  # send `reply` text back, keep the connection open
DROP = "drop"  # send `reply` (if any), then disconnect the client
IGNORE = "ignore"  # nothing to do


def make_ack(ok: bool, reason: Optional[str] = None) -> str:
    """Serialize the server -> client hello ack (compact JSON)."""
    msg: Dict[str, Any] = {"v": 1, "ack": "morphogen", "ok": bool(ok)}
    if reason:
        msg["reason"] = reason
    return json.dumps(msg, separators=(",", ":"))


@dataclass
class _ClientState:
    authed: bool = False
    bad_hellos: int = 0


@dataclass
class SyncAuthGate:
    """Per-server auth state machine keyed by client id (TD's `client` arg).

    secret: shared secret configured on the TD side (>= MIN_SECRET_LEN chars).
    clock_ms: injectable clock for tests; defaults to wall time in ms.
    """

    secret: str
    max_skew_ms: int = DEFAULT_MAX_SKEW_MS
    max_hello_attempts: int = DEFAULT_MAX_HELLO_ATTEMPTS
    max_frame_bytes: int = MAX_FRAME_BYTES
    clock_ms: Callable[[], float] = field(default=lambda: time.time() * 1000.0)
    _clients: Dict[Any, _ClientState] = field(default_factory=dict, init=False, repr=False)

    def __post_init__(self) -> None:
        if not isinstance(self.secret, str) or len(self.secret) < MIN_SECRET_LEN:
            raise ValueError(f"Sync secret must be a string of >= {MIN_SECRET_LEN} chars")
        if self.secret != self.secret.strip() or any(c.isspace() for c in self.secret):
            raise ValueError("Sync secret must not contain whitespace")

    # -- connection lifecycle -------------------------------------------------

    def on_connect(self, client: Any) -> None:
        self._clients[client] = _ClientState()

    def on_disconnect(self, client: Any) -> None:
        self._clients.pop(client, None)

    def is_authed(self, client: Any) -> bool:
        st = self._clients.get(client)
        return bool(st and st.authed)

    @property
    def authed_count(self) -> int:
        return sum(1 for st in self._clients.values() if st.authed)

    # -- frames ---------------------------------------------------------------

    def on_text(self, client: Any, text: str) -> Tuple[str, Optional[str], Optional[dict]]:
        """Classify one incoming text frame.

        Returns (action, reply_text, payload):
          (ACCEPT, None, telemetry_dict)  authed client sent telemetry
          (REPLY, ack_json, None)         hello answered (ok: true, or ok: false
                                          for a bad hello under the attempt cap)
          (DROP, ack_json|None, None)     refuse and disconnect
          (IGNORE, None, None)            e.g. duplicate hello after auth
        """
        st = self._clients.get(client)
        if st is None:  # frame before onConnect (or after disconnect): be strict
            st = self._clients[client] = _ClientState()

        if not isinstance(text, str) or len(text.encode("utf-8", "ignore")) > self.max_frame_bytes:
            return DROP, make_ack(False, "frame_too_large"), None

        try:
            msg = json.loads(text)
        except (ValueError, TypeError):
            return (DROP, make_ack(False, "bad_json"), None) if not st.authed else (IGNORE, None, None)
        if not isinstance(msg, dict) or msg.get("v") != 1:
            return (DROP, make_ack(False, "bad_version"), None) if not st.authed else (IGNORE, None, None)

        is_hello = msg.get("hello") == "morphogen"

        if st.authed:
            if is_hello:
                return IGNORE, None, None  # re-hello on an authed socket is a no-op
            return ACCEPT, None, msg

        # --- not yet authed: only a valid hello is acceptable ---
        if not is_hello:
            return DROP, make_ack(False, "auth_required"), None

        reason = self._check_hello(msg)
        if reason is None:
            st.authed = True
            st.bad_hellos = 0
            return REPLY, make_ack(True), None

        st.bad_hellos += 1
        if st.bad_hellos >= self.max_hello_attempts:
            return DROP, make_ack(False, "too_many_attempts"), None
        # bad_auth / stale_hello under the cap: answer and keep the socket;
        # tdClient closes on ok:false, anything else hits the cap and is dropped.
        return REPLY, make_ack(False, reason), None

    def _check_hello(self, msg: dict) -> Optional[str]:
        auth = msg.get("auth")
        if not isinstance(auth, str) or not auth:
            return "bad_auth"
        # compare_digest needs equal types; encode so non-ASCII can't raise.
        if not hmac.compare_digest(auth.encode("utf-8"), self.secret.encode("utf-8")):
            return "bad_auth"
        t = msg.get("t")
        if isinstance(t, bool) or not isinstance(t, (int, float)):
            return "stale_hello"
        if abs(self.clock_ms() - float(t)) > self.max_skew_ms:
            return "stale_hello"
        return None
