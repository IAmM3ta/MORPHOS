"""Morphogen v2 Sync — TouchDesigner-side command sender + pong / RTT tracker.

Pure Python (no TD imports), the TD-side twin of morphogen-v2/src/sync/tdCommand.ts.
Since 2026-10-21 the browser accepts two small TD -> app commands on an authed
socket:

    TD      -> {"v": 1, "cmd": "preset", "id": "<preset id>"}
    TD      -> {"v": 1, "cmd": "ping", "t": <TD clock ms>}
    browser -> {"v": 1, "pong": "morphogen", "t": <same t>}

Until this module existed, TD had no helper to build those frames and the
callbacks DAT treated a returning pong as telemetry: it cleared
`morphogen_table` and wrote zero rows, so every ping blanked the table until
the next telemetry frame. `classify_inbound()` now lets the callbacks route
pongs here instead.

Rules mirror the browser so TD never sends a frame the app would silently drop:
  * Preset ids are trimmed + lower-cased, `[a-z0-9_-]`, <= MAX_PRESET_ID_LEN.
    Known ids (PRESET_IDS, same order as PRESET_ORDER in src/ui/field.ts) are
    accepted; unknown-but-well-formed ids raise unless allow_unknown=True
    (useful if the browser build has newer presets than this file).
  * Frames are compact JSON and must fit MAX_COMMAND_BYTES (512), the browser's cap.
  * `setParams` / `freeze` are not offered: the browser refuses them today.
  * The browser rate-limits commands (10/s, burst 5); `CommandPacer` applies
    the same token bucket on the TD side so a cue stack can't have frames
    silently discarded at the other end.

Tested without TouchDesigner in tests/test_td_sync_commands.py.

Send tally (2026-10-25): `SendStats` counts what TD actually did with each
command it tried to send (sent preset / sent ping / paced out / nobody authed),
and `describe_send_stats()` renders the same one-line style as the browser's
describeCommandStats ("TD cmds: 3 applied · 1 ping"). Read the two side by
side: if TD says "3 presets" but the browser says "none yet", the frames are
not reaching an authed session; if TD says "2 paced", the cue stack fired
faster than the 10/s, burst-5 limit and TD held those frames back itself.

Contract (2026-10-23): morphogen-v2/tests/fixtures/td-commands.v1.json pins the
exact frame bytes, refusals and pacer verdicts this module and the browser must
agree on. Change the fixture first if a rule changes, then keep both
tests/test_td_sync_contract.py and morphogen-v2/tests/tdContract.test.mjs green.
"""

from __future__ import annotations

import json
import math
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

# --- keep in sync with morphogen-v2/src/sync/tdCommand.ts ------------------
MAX_COMMAND_BYTES = 512
MAX_PRESET_ID_LEN = 32
COMMAND_RATE_PER_S = 10.0
COMMAND_BURST = 5.0
# --- keep in sync with PRESET_ORDER in morphogen-v2/src/ui/field.ts --------
PRESET_IDS = (
    "mitosis",
    "solitons",
    "pulsing",
    "holes",
    "mazes",
    "fingerprint",
    "spirals",
    "worms",
    "coral",
    "uskate",
)

_PRESET_RE = re.compile(r"^[a-z0-9_-]+$")

# Inbound frame kinds returned by classify_inbound().
TELEMETRY = "telemetry"
PONG = "pong"
OTHER = "other"


def _dump(msg: Dict[str, Any]) -> str:
    text = json.dumps(msg, separators=(",", ":"), allow_nan=False)
    if len(text.encode("utf-8")) > MAX_COMMAND_BYTES:
        raise ValueError(f"command frame exceeds {MAX_COMMAND_BYTES} bytes")
    return text


def normalize_preset_id(raw: Any, allow_unknown: bool = False) -> str:
    """Return the id the browser will see, or raise ValueError.

    Same normalisation as the browser's parseTdCommand / ?preset=: strip, lower.
    """
    if not isinstance(raw, str):
        raise ValueError("preset id must be a string")
    pid = raw.strip().lower()
    if not pid or len(pid) > MAX_PRESET_ID_LEN or not _PRESET_RE.match(pid):
        raise ValueError(f"malformed preset id: {raw!r}")
    if pid not in PRESET_IDS and not allow_unknown:
        raise ValueError(f"unknown preset id {pid!r}; known: {', '.join(PRESET_IDS)}")
    return pid


def make_preset_command(preset_id: Any, allow_unknown: bool = False) -> str:
    """Serialize `{v:1, cmd:"preset", id}` for TD's WebSocket DAT sendText."""
    return _dump({"v": 1, "cmd": "preset", "id": normalize_preset_id(preset_id, allow_unknown)})


def make_ping_command(t_ms: float) -> str:
    """Serialize `{v:1, cmd:"ping", t}`; t must be a finite number (it is echoed back)."""
    if isinstance(t_ms, bool) or not isinstance(t_ms, (int, float)) or not math.isfinite(t_ms):
        raise ValueError("ping t must be a finite number of ms")
    return _dump({"v": 1, "cmd": "ping", "t": t_ms})


def classify_inbound(payload: Any) -> str:
    """Sort an authed client's parsed frame: PONG, TELEMETRY, or OTHER.

    The auth gate hands every post-ack dict to the callbacks as ACCEPT; only
    frames that carry at least one telemetry group should touch the tables.
    """
    if not isinstance(payload, dict):
        return OTHER
    if payload.get("pong") == "morphogen":
        return PONG
    if any(isinstance(payload.get(g), dict) for g in ("params", "field", "sensors", "audio", "loop")):
        return TELEMETRY
    if isinstance(payload.get("grid"), list):
        return TELEMETRY
    return OTHER


@dataclass
class CommandPacer:
    """Token bucket matching the browser's createCommandGate (10/s, burst 5).

    Call allow() before each sendText; False means the browser would drop it.
    Non-finite or backwards clock readings refill nothing (same as the browser).
    """

    rate_per_s: float = COMMAND_RATE_PER_S
    burst: float = COMMAND_BURST
    clock_ms: Callable[[], float] = field(default=lambda: time.time() * 1000.0)
    _tokens: float = field(default=-1.0, init=False, repr=False)
    _last: Optional[float] = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        if not (isinstance(self.rate_per_s, (int, float)) and math.isfinite(self.rate_per_s) and self.rate_per_s > 0):
            self.rate_per_s = COMMAND_RATE_PER_S
        if not (isinstance(self.burst, (int, float)) and math.isfinite(self.burst) and self.burst >= 1):
            self.burst = COMMAND_BURST
        self._tokens = float(self.burst)

    def reset(self) -> None:
        """Refill fully — call when a fresh authed session starts (browser does the same)."""
        self._tokens = float(self.burst)
        self._last = None

    def allow(self) -> bool:
        now = self.clock_ms()
        if isinstance(now, (int, float)) and math.isfinite(now):
            if self._last is not None and now > self._last:
                self._tokens = min(self.burst, self._tokens + (now - self._last) / 1000.0 * self.rate_per_s)
            if self._last is None or now > self._last:
                self._last = float(now)
        if self._tokens >= 1.0:
            self._tokens -= 1.0
            return True
        return False


@dataclass
class RttTracker:
    """Match pongs to pings sent from this TD and keep recent round-trip times.

    Only pongs echoing a `t` we actually sent (and haven't matched yet) count,
    so a stale, duplicated or forged pong can't fake a latency figure.
    """

    clock_ms: Callable[[], float] = field(default=lambda: time.time() * 1000.0)
    window: int = 16
    max_outstanding: int = 32
    _pending: List[float] = field(default_factory=list, init=False, repr=False)
    samples: List[float] = field(default_factory=list, init=False)

    def ping(self) -> str:
        """Build a ping frame stamped with the current clock and remember it."""
        t = float(self.clock_ms())
        frame = make_ping_command(t)
        self._pending.append(t)
        del self._pending[: max(0, len(self._pending) - self.max_outstanding)]
        return frame

    def on_pong(self, payload: Any) -> Optional[float]:
        """Record a pong; returns the RTT in ms, or None if it matched nothing."""
        if not isinstance(payload, dict) or payload.get("pong") != "morphogen":
            return None
        t = payload.get("t")
        if isinstance(t, bool) or not isinstance(t, (int, float)) or t not in self._pending:
            return None
        self._pending.remove(t)
        rtt = max(0.0, float(self.clock_ms()) - float(t))
        self.samples.append(rtt)
        del self.samples[: max(0, len(self.samples) - self.window)]
        return rtt

    @property
    def last_ms(self) -> Optional[float]:
        return self.samples[-1] if self.samples else None

    @property
    def median_ms(self) -> Optional[float]:
        if not self.samples:
            return None
        s = sorted(self.samples)
        mid = len(s) // 2
        return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2.0


# Outcomes SendStats.record() accepts (returned by the callbacks' _broadcast).
SENT = "sent"
PACED = "paced"
NO_CLIENT = "no_client"


@dataclass
class SendStats:
    """TD-side tally of outbound commands, the twin of the browser's TdCommandStats.

    The browser counts what it *received*; this counts what TD *tried to send*
    and why a frame didn't go. Without it, send_preset() returning 0 could mean
    either "rate-limited" or "no authed browser", and the two need different
    fixes (slow the cue stack vs. check Syncsecret / the browser's ?td= URL).
    Reset it whenever a fresh authed session starts, like the browser does.
    """

    presets: int = 0
    pings: int = 0
    paced: int = 0
    no_client: int = 0

    def record(self, kind: str, outcome: str) -> None:
        """Count one send attempt. kind is "preset" or "ping"; unknown values are ignored."""
        if outcome == SENT:
            if kind == "preset":
                self.presets += 1
            elif kind == "ping":
                self.pings += 1
        elif outcome == PACED:
            self.paced += 1
        elif outcome == NO_CLIENT:
            self.no_client += 1

    def reset(self) -> None:
        self.presets = self.pings = self.paced = self.no_client = 0

    def as_rows(self) -> List[List[Any]]:
        """Rows for an optional `morphogen_cmds` Table DAT (name, count)."""
        return [
            ["presets", self.presets],
            ["pings", self.pings],
            ["paced", self.paced],
            ["no_client", self.no_client],
        ]


def describe_send_stats(s: SendStats) -> str:
    """One short line, same shape as describeCommandStats in tdCommand.ts.

    Zero counters are omitted; an untouched tally reads "TD sent: none yet".
    """
    parts: List[str] = []

    def add(n: int, one: str, many: str) -> None:
        if isinstance(n, int) and not isinstance(n, bool) and n > 0:
            parts.append(f"{n} {one if n == 1 else many}")

    add(s.presets, "preset", "presets")
    add(s.pings, "ping", "pings")
    add(s.paced, "paced", "paced")
    add(s.no_client, "with no authed client", "with no authed client")
    return "TD sent: " + (" · ".join(parts) if parts else "none yet")
