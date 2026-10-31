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

RTT status frame (2026-10-29): TD's round-trip figures used to live only in
TD (`morphogen_rtt`), so the browser operator could not see that TD was
losing pings. `make_status_command()` / `RttTracker.status_frame()` build

    TD      -> {"v": 1, "cmd": "status", "rtt": {"last_ms": 8.0, "median_ms": 9.5,
                "samples": 3, "outstanding": 0, "lost": 1}}

with the same field names as the `morphogen_rtt` rows. The browser parses it
(parseTdCommand in tdCommand.ts) and renders it with describeTdRtt, which must
print exactly what describe_rtt() prints here; the shared fixture pins both.
Status frames go through CommandPacer like every other command, so send them
at a slow cadence (about 1/s), never per frame.

Contract (2026-10-23): morphogen-v2/tests/fixtures/td-commands.v1.json pins the
exact frame bytes, refusals and pacer verdicts this module and the browser must
agree on. Change the fixture first if a rule changes, then keep both
tests/test_td_sync_contract.py and morphogen-v2/tests/tdContract.test.mjs green.
"""

from __future__ import annotations

import json
import math
from decimal import ROUND_HALF_UP, Decimal
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

# --- keep in sync with morphogen-v2/src/sync/tdCommand.ts ------------------
MAX_COMMAND_BYTES = 512
MAX_PRESET_ID_LEN = 32
# Status frame bounds (2026-10-29): RTT figures above an hour or counts above a
# billion are junk, not measurements; both sides refuse them.
MAX_STATUS_MS = 3_600_000
MAX_STATUS_COUNT = 1_000_000_000
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


def _status_ms(name: str, v: Any) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ValueError(f"status {name} must be a finite number of ms or None")
    if v < 0 or v > MAX_STATUS_MS:
        raise ValueError(f"status {name} out of range 0..{MAX_STATUS_MS}")
    return round(float(v), 2)


def _status_count(name: str, v: Any) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or v < 0 or v > MAX_STATUS_COUNT:
        raise ValueError(f"status {name} must be an integer 0..{MAX_STATUS_COUNT}")
    return v


def make_status_command(
    last_ms: Any = None,
    median_ms: Any = None,
    samples: Any = 0,
    outstanding: Any = 0,
    lost: Any = 0,
) -> str:
    """Serialize `{v:1, cmd:"status", rtt:{...}}` — TD's RTT figures for the browser.

    ms values are None (no pong yet) or finite 0..MAX_STATUS_MS, rounded to
    0.01 ms; counts are ints 0..MAX_STATUS_COUNT. Same field names and order as
    RttTracker.as_rows(), so the browser line and the TD table read alike.
    """
    rtt = {
        "last_ms": _status_ms("last_ms", last_ms),
        "median_ms": _status_ms("median_ms", median_ms),
        "samples": _status_count("samples", samples),
        "outstanding": _status_count("outstanding", outstanding),
        "lost": _status_count("lost", lost),
    }
    return _dump({"v": 1, "cmd": "status", "rtt": rtt})


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

    Lost pings (2026-10-28): a ping that gets no pong within `timeout_ms` is
    dropped from the pending list and counted in `lost`. Before this, an
    unanswered ping sat in `_pending` until 32 newer ones pushed it out, so a
    dead link showed up only as "the RTT table stopped changing" — it now shows
    up as a climbing `lost` count. A pong that arrives after its ping expired
    is ignored (it is already counted as lost, and its RTT would be misleading).
    Pings pushed out by the `max_outstanding` cap are counted as lost too.

    Expiry piggybacks on the clock read that ping() / on_pong() already make
    (exactly one clock call each), so there is no timer to run in TD and the
    contract test's two-tick clock script still holds. A non-finite clock
    reading never expires anything (fail safe: no false "lost" on a bad clock),
    and a clock that steps backwards just makes pings look younger.
    """

    clock_ms: Callable[[], float] = field(default=lambda: time.time() * 1000.0)
    window: int = 16
    max_outstanding: int = 32
    timeout_ms: float = 5000.0
    _pending: List[float] = field(default_factory=list, init=False, repr=False)
    samples: List[float] = field(default_factory=list, init=False)
    lost: int = field(default=0, init=False)

    def _expire(self, now: float) -> None:
        """Move pings older than timeout_ms from pending into the lost count."""
        if not math.isfinite(now):
            return
        keep = [t for t in self._pending if now - t <= self.timeout_ms]
        self.lost += len(self._pending) - len(keep)
        self._pending = keep

    def ping(self) -> str:
        """Build a ping frame stamped with the current clock and remember it."""
        t = float(self.clock_ms())
        self._expire(t)
        frame = make_ping_command(t)
        self._pending.append(t)
        overflow = max(0, len(self._pending) - self.max_outstanding)
        if overflow:
            self.lost += overflow  # oldest unanswered pings give up their slot
            del self._pending[:overflow]
        return frame

    def on_pong(self, payload: Any) -> Optional[float]:
        """Record a pong; returns the RTT in ms, or None if it matched nothing."""
        if not isinstance(payload, dict) or payload.get("pong") != "morphogen":
            return None
        t = payload.get("t")
        if isinstance(t, bool) or not isinstance(t, (int, float)):
            return None
        now = float(self.clock_ms())
        self._expire(now)  # a pong for an expired ping no longer matches
        if t not in self._pending:
            return None
        self._pending.remove(t)
        rtt = max(0.0, now - float(t))
        self.samples.append(rtt)
        del self.samples[: max(0, len(self.samples) - self.window)]
        return rtt

    def reset(self) -> None:
        """Forget pending pings, samples and the lost count (fresh authed session).

        Pings sent to a previous session can never be answered on the new one,
        so they are dropped silently rather than reported as lost.
        """
        self._pending.clear()
        self.samples.clear()
        self.lost = 0

    @property
    def outstanding(self) -> int:
        """Pings sent and still waiting for a pong (not yet expired)."""
        return len(self._pending)

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

    def status_frame(self) -> str:
        """This tracker's figures as a browser status frame (see make_status_command)."""
        return make_status_command(
            self.last_ms, self.median_ms, len(self.samples), self.outstanding, self.lost
        )

    def as_rows(self) -> List[list]:
        """Rows for the optional `morphogen_rtt` Table DAT ("" = no sample yet)."""
        last, med = self.last_ms, self.median_ms
        return [
            ["last_ms", "" if last is None else round(last, 2)],
            ["median_ms", "" if med is None else round(med, 2)],
            ["samples", len(self.samples)],
            ["outstanding", self.outstanding],
            ["lost", self.lost],
        ]


def _fmt_ms(v: float) -> str:
    """One decimal, ties rounded up — the same digits as JS Number.toFixed(1).

    Python's f"{v:.1f}" rounds an exact tie (8.25) to even ("8.2") while
    toFixed gives "8.3"; Decimal(v) is the float's exact value, so HALF_UP on
    it matches toFixed for every non-negative input.
    """
    return str(Decimal(v).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


def describe_rtt_fields(last_ms: Optional[float], median_ms: Optional[float], lost: int) -> str:
    """The describe_rtt line from raw fields; the browser's describeTdRtt twin."""
    if last_ms is None:
        head = "TD rtt: no pongs yet"
    else:
        head = f"TD rtt: {_fmt_ms(last_ms)} ms"
        if median_ms is not None:
            head += f" (median {_fmt_ms(median_ms)})"
    return head + (f" · {lost} lost" if lost else "")


def describe_rtt(tracker: "RttTracker") -> str:
    """One line for a Text TOP, e.g. 'TD rtt: 8.0 ms (median 9.5) · 1 lost'.

    Mirrors describe_send_stats(): the lost bucket is hidden while it is zero.
    """
    return describe_rtt_fields(tracker.last_ms, tracker.median_ms, tracker.lost)


# How often status_tick() pushes a status frame (2026-10-31). 1 s keeps the
# browser's #syncRtt chip fresh while spending 1 of the 10/s pacer tokens; the
# floor stops a typo (e.g. 10 instead of 1000) from starving presets / pings.
STATUS_INTERVAL_MS = 1000.0
MIN_STATUS_INTERVAL_MS = 250.0


@dataclass
class StatusHeartbeat:
    """Decide when the next periodic status frame is due (pure, no TD timer).

    TD calls the callbacks' status_tick() as often as it likes (every frame
    from an Execute DAT, or each pulse of a Timer CHOP); due() answers True at
    most once per interval_ms so the cadence does not depend on how often it
    is called. Rules, chosen to fail quiet rather than flood the pacer:

    - The first due() after construction / reset() is True, so a freshly
      authed browser gets TD's figures on the next tick, not a second later.
    - A non-finite clock reading is never due (no sends on a broken clock).
    - A clock that steps backwards re-arms from the new reading instead of
      waiting for the old timestamp to come round again.
    - interval_ms below MIN_STATUS_INTERVAL_MS (or not a finite number) falls
      back: too small clamps to the floor, junk uses STATUS_INTERVAL_MS.
    """

    interval_ms: float = STATUS_INTERVAL_MS
    clock_ms: Callable[[], float] = field(default=lambda: time.time() * 1000.0)
    _last: Optional[float] = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        v = self.interval_ms
        if not (isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)):
            self.interval_ms = STATUS_INTERVAL_MS
        else:
            self.interval_ms = max(MIN_STATUS_INTERVAL_MS, float(v))

    def reset(self) -> None:
        """Make the next due() True — call on each fresh authed hello."""
        self._last = None

    def due(self) -> bool:
        """True if a status frame should go now; stamps the time when it says so."""
        now = self.clock_ms()
        if not (isinstance(now, (int, float)) and not isinstance(now, bool) and math.isfinite(now)):
            return False
        now = float(now)
        if self._last is None or now - self._last >= self.interval_ms:
            self._last = now
            return True
        if now < self._last:
            self._last = now  # clock stepped back: restart the interval from here
        return False


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
    statuses: int = 0
    paced: int = 0
    no_client: int = 0

    def record(self, kind: str, outcome: str) -> None:
        """Count one send attempt. kind is "preset", "ping" or "status"; unknown values are ignored."""
        if outcome == SENT:
            if kind == "preset":
                self.presets += 1
            elif kind == "ping":
                self.pings += 1
            elif kind == "status":
                self.statuses += 1
        elif outcome == PACED:
            self.paced += 1
        elif outcome == NO_CLIENT:
            self.no_client += 1

    def reset(self) -> None:
        self.presets = self.pings = self.statuses = self.paced = self.no_client = 0

    def as_rows(self) -> List[List[Any]]:
        """Rows for an optional `morphogen_cmds` Table DAT (name, count)."""
        return [
            ["presets", self.presets],
            ["pings", self.pings],
            ["statuses", self.statuses],
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
    add(s.statuses, "status", "statuses")
    add(s.paced, "paced", "paced")
    add(s.no_client, "with no authed client", "with no authed client")
    return "TD sent: " + (" · ".join(parts) if parts else "none yet")
