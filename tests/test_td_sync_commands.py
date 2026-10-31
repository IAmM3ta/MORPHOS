"""Tests for the TD-side Sync command sender / pong tracker and callbacks routing.

Runs without TouchDesigner: the callbacks module's TD builtins (`op`, `debug`)
are injected as fakes.
"""

import json
import math
import os
import sys

import pytest

TD_DIR = os.path.join(os.path.dirname(__file__), "..", "morphogen-v2", "td")
sys.path.insert(0, TD_DIR)

import morphogen_sync_callbacks as cb  # noqa: E402
from morphogen_sync_commands import (  # noqa: E402
    MAX_COMMAND_BYTES,
    MAX_STATUS_COUNT,
    MAX_STATUS_MS,
    OTHER,
    PONG,
    PRESET_IDS,
    TELEMETRY,
    CommandPacer,
    RttTracker,
    MIN_STATUS_INTERVAL_MS,
    STATUS_INTERVAL_MS,
    SendStats,
    StatusHeartbeat,
    classify_inbound,
    describe_rtt,
    describe_send_stats,
    make_ping_command,
    make_preset_command,
    make_status_command,
    normalize_preset_id,
)

FIELD_TS = os.path.join(os.path.dirname(__file__), "..", "morphogen-v2", "src", "ui", "field.ts")
COMMAND_TS = os.path.join(os.path.dirname(__file__), "..", "morphogen-v2", "src", "sync", "tdCommand.ts")


def test_preset_ids_match_browser_order():
    src = open(FIELD_TS, encoding="utf-8").read()
    block = src.split("PRESET_ORDER", 1)[1].split("];", 1)[0]
    ids = tuple(part.strip().strip("',") for part in block.splitlines() if part.strip().startswith("'"))
    assert ids == PRESET_IDS


def test_limits_match_browser_constants():
    src = open(COMMAND_TS, encoding="utf-8").read()
    assert f"MAX_COMMAND_BYTES = {MAX_COMMAND_BYTES};" in src
    assert "MAX_PRESET_ID_LEN = 32;" in src
    # Status frame bounds (2026-10-29): TS writes them with digit separators.
    assert f"MAX_STATUS_MS = {MAX_STATUS_MS:_};" in src
    assert f"MAX_STATUS_COUNT = {MAX_STATUS_COUNT:_};" in src


def test_preset_command_normalises_and_validates():
    assert json.loads(make_preset_command("  Coral ")) == {"v": 1, "cmd": "preset", "id": "coral"}
    assert make_preset_command("uskate") == '{"v":1,"cmd":"preset","id":"uskate"}'
    for bad in ("", "   ", "co ral", "coral!", "x" * 33, None, 3, "__proto__x/"):
        with pytest.raises(ValueError):
            make_preset_command(bad)
    with pytest.raises(ValueError):
        normalize_preset_id("lava")  # well-formed but unknown
    assert normalize_preset_id("Lava", allow_unknown=True) == "lava"


def test_ping_command_requires_finite_t():
    assert json.loads(make_ping_command(123.5)) == {"v": 1, "cmd": "ping", "t": 123.5}
    for bad in (math.nan, math.inf, True, "1", None):
        with pytest.raises(ValueError):
            make_ping_command(bad)


def test_classify_inbound():
    assert classify_inbound({"v": 1, "pong": "morphogen", "t": 1}) == PONG
    assert classify_inbound({"v": 1, "params": {"feed": 0.05}}) == TELEMETRY
    assert classify_inbound({"v": 1, "grid": [0.0] * 256}) == TELEMETRY
    assert classify_inbound({"v": 1, "cmd": "preset"}) == OTHER
    assert classify_inbound(["pong"]) == OTHER


def test_pacer_matches_browser_bucket():
    now = [1000.0]
    p = CommandPacer(clock_ms=lambda: now[0])
    assert [p.allow() for _ in range(6)] == [True] * 5 + [False]
    now[0] += 100  # 10/s → one token per 100 ms
    assert p.allow() and not p.allow()
    now[0] = 0.0  # backwards clock refills nothing
    assert not p.allow()
    now[0] = math.nan
    assert not p.allow()
    p.reset()
    assert p.allow()
    assert CommandPacer(rate_per_s=0, burst=math.nan).burst == 5.0


def test_rtt_only_counts_our_pings():
    now = [5000.0]
    r = RttTracker(clock_ms=lambda: now[0])
    t = json.loads(r.ping())["t"]
    assert r.on_pong({"v": 1, "pong": "morphogen", "t": 4999.0}) is None  # never sent
    now[0] += 12.5
    assert r.on_pong({"v": 1, "pong": "morphogen", "t": t}) == 12.5
    assert r.on_pong({"v": 1, "pong": "morphogen", "t": t}) is None  # duplicate
    assert r.on_pong({"v": 1, "pong": "morphogen", "t": True}) is None
    for d in (30.0, 20.0):
        t = json.loads(r.ping())["t"]
        now[0] += d
        r.on_pong({"v": 1, "pong": "morphogen", "t": t})
    assert r.last_ms == 20.0 and r.median_ms == 20.0 and len(r.samples) == 3


class FakeTable:
    def __init__(self):
        self.rows = [["stale", 1]]

    def clear(self):
        self.rows = []

    def appendRow(self, row):
        self.rows.append(row)


class FakeWsDat:
    class _Par:
        Syncsecret = type("P", (), {"eval": staticmethod(lambda: "correct-horse-battery-staple")})()

    def __init__(self):
        self.sent = []
        self._parent = type("C", (), {"par": self._Par()})()

    def parent(self):
        return self._parent

    def sendText(self, client, text):
        self.sent.append((client, text))

    def disconnect(self, client):
        pass


@pytest.fixture
def td(monkeypatch):
    now = [1_800_000_000_000.0]
    tables = {"morphogen_table": FakeTable(), "morphogen_grid": FakeTable(), "morphogen_rtt": FakeTable(), "morphogen_cmds": FakeTable()}
    monkeypatch.setattr(cb, "op", tables.get, raising=False)
    monkeypatch.setattr(cb, "debug", lambda *a: None, raising=False)
    monkeypatch.setattr(cb, "_gate", None)
    monkeypatch.setattr(cb, "_pacer", CommandPacer(clock_ms=lambda: now[0]))
    monkeypatch.setattr(cb, "_rtt", RttTracker(clock_ms=lambda: now[0]))
    monkeypatch.setattr(cb, "_stats", SendStats())
    monkeypatch.setattr(cb, "_heartbeat", StatusHeartbeat(clock_ms=lambda: now[0]))
    dat = FakeWsDat()
    cb.onConnect(dat, "a")
    cb.onConnect(dat, "b")  # never authenticates
    cb._gate.clock_ms = lambda: now[0]
    hello = json.dumps({"v": 1, "hello": "morphogen", "t": now[0], "auth": "correct-horse-battery-staple"})
    cb.onReceiveText(dat, 0, hello, "a")
    dat.sent.clear()
    return dat, tables, now


def test_commands_reach_only_authed_clients(td):
    dat, _, _ = td
    assert cb.send_preset(dat, "Coral") == 1
    assert dat.sent == [("a", '{"v":1,"cmd":"preset","id":"coral"}')]
    with pytest.raises(ValueError):
        cb.send_preset(dat, "lava")
    for _ in range(4):
        cb.send_ping(dat)
    assert cb.send_ping(dat) == 0  # 6th frame inside the burst is paced out


def test_pong_updates_rtt_without_blanking_telemetry(td):
    dat, tables, now = td
    cb.onReceiveText(dat, 0, json.dumps({"v": 1, "params": {"feed": 0.05, "kill": 0.06}}), "a")
    assert tables["morphogen_table"].rows == [["/morphogen/params/feed", 0.05], ["/morphogen/params/kill", 0.06]]
    cb.send_ping(dat)
    t = json.loads(dat.sent[-1][1])["t"]
    now[0] += 8.0
    cb.onReceiveText(dat, 0, json.dumps({"v": 1, "pong": "morphogen", "t": t}), "a")
    assert tables["morphogen_table"].rows[0][0] == "/morphogen/params/feed"  # untouched
    assert tables["morphogen_rtt"].rows[0] == ["last_ms", 8.0]
    cb.onReceiveText(dat, 0, json.dumps({"v": 1, "hmm": 1}), "a")  # unknown authed frame
    assert len(tables["morphogen_table"].rows) == 2


# --- 2026-10-25: TD-side send tally -----------------------------------------


def test_describe_send_stats_matches_browser_style():
    s = SendStats()
    assert describe_send_stats(s) == "TD sent: none yet"
    s.record("preset", "sent")
    s.record("preset", "sent")
    s.record("ping", "sent")
    s.record("ping", "paced")
    s.record("preset", "no_client")
    s.record("preset", "bogus")  # unknown outcome: ignored, never raises
    assert describe_send_stats(s) == "TD sent: 2 presets · 1 ping · 1 paced · 1 with no authed client"
    s.reset()
    assert describe_send_stats(s) == "TD sent: none yet"


def test_send_tally_separates_paced_from_no_client(td):
    dat, tables, _ = td
    for _ in range(6):  # burst of 5, then one paced out
        cb.send_preset(dat, "coral")
    assert (cb._stats.presets, cb._stats.paced, cb._stats.no_client) == (5, 1, 0)
    assert tables["morphogen_cmds"].rows == [["presets", 5], ["pings", 0], ["statuses", 0], ["paced", 1], ["no_client", 0]]
    assert cb.send_stats_line() == "TD sent: 5 presets · 1 paced"
    cb.onDisconnect(dat, "a")
    assert cb.send_preset(dat, "coral") == 0
    assert cb._stats.no_client == 1


def test_paced_ping_is_not_left_pending(td):
    dat, _, now = td
    for _ in range(5):
        cb.send_preset(dat, "mazes")  # drain the burst
    assert cb.send_ping(dat) == 0
    assert cb._rtt._pending == []  # nothing stamped for a frame that never went
    now[0] += 1000.0  # bucket refills
    assert cb.send_ping(dat) == 1
    assert len(cb._rtt._pending) == 1 and cb._stats.pings == 1


def test_fresh_auth_resets_send_tally(td):
    dat, tables, now = td
    cb.send_preset(dat, "worms")
    assert cb._stats.presets == 1
    hello = json.dumps({"v": 1, "hello": "morphogen", "t": now[0], "auth": "correct-horse-battery-staple"})
    cb.onConnect(dat, "c")
    cb.onReceiveText(dat, 0, hello, "c")
    assert describe_send_stats(cb._stats) == "TD sent: none yet"
    assert tables["morphogen_cmds"].rows[0] == ["presets", 0]


# --- Lost pings (2026-10-28) -------------------------------------------------


def test_unanswered_ping_expires_into_lost():
    now = [10_000.0]
    r = RttTracker(clock_ms=lambda: now[0], timeout_ms=5000.0)
    t_old = json.loads(r.ping())["t"]
    now[0] += 5000.0
    r.ping()  # exactly at the timeout: still pending
    assert r.lost == 0 and r.outstanding == 2
    now[0] += 0.5
    t_new = json.loads(r.ping())["t"]  # first ping is now 5000.5 ms old
    assert r.lost == 1 and r.outstanding == 2
    assert r.on_pong({"v": 1, "pong": "morphogen", "t": t_old}) is None  # late pong ignored
    assert r.on_pong({"v": 1, "pong": "morphogen", "t": t_new}) == 0.0
    assert r.samples == [0.0]


def test_pong_side_expiry_and_bad_clock_fail_safe():
    now = [0.0]
    r = RttTracker(clock_ms=lambda: now[0], timeout_ms=100.0)
    t = json.loads(r.ping())["t"]
    now[0] = 150.0
    assert r.on_pong({"v": 1, "pong": "morphogen", "t": t}) is None  # expired on arrival
    assert r.lost == 1 and r.outstanding == 0
    r.ping()
    now[0] = math.nan
    assert r.on_pong({"v": 1, "pong": "morphogen", "t": 1.0}) is None
    assert r.outstanding == 1  # non-finite clock never expires anything
    now[0] = -1e9  # clock stepped backwards: pings look younger, not lost
    r.ping()
    assert r.lost == 1


def test_overflow_counts_as_lost_and_reset_clears():
    now = [0.0]
    r = RttTracker(clock_ms=lambda: now[0], max_outstanding=3)
    for _ in range(5):
        now[0] += 1.0
        r.ping()
    assert r.outstanding == 3 and r.lost == 2
    r.reset()
    assert (r.outstanding, r.lost, r.samples) == (0, 0, [])


def test_describe_rtt_and_rows():
    now = [0.0]
    r = RttTracker(clock_ms=lambda: now[0], timeout_ms=10.0)
    assert describe_rtt(r) == "TD rtt: no pongs yet"
    assert r.as_rows()[0] == ["last_ms", ""]
    t = json.loads(r.ping())["t"]
    now[0] += 8.0
    r.on_pong({"v": 1, "pong": "morphogen", "t": t})
    r.ping()
    now[0] += 20.0
    r.ping()
    assert describe_rtt(r) == "TD rtt: 8.0 ms (median 8.0) · 1 lost"
    assert dict((k, v) for k, v in r.as_rows()) == {
        "last_ms": 8.0, "median_ms": 8.0, "samples": 1, "outstanding": 1, "lost": 1,
    }


def test_callbacks_surface_lost_pings_and_reset_on_fresh_auth(td):
    dat, tables, now = td
    cb.send_ping(dat)
    rows = dict((k, v) for k, v in tables["morphogen_rtt"].rows)
    assert rows["outstanding"] == 1 and rows["lost"] == 0
    now[0] += 6000.0  # no pong comes back
    cb.send_ping(dat)
    rows = dict((k, v) for k, v in tables["morphogen_rtt"].rows)
    assert rows["lost"] == 1 and rows["outstanding"] == 1
    assert cb.rtt_line() == "TD rtt: no pongs yet · 1 lost"
    hello = json.dumps({"v": 1, "hello": "morphogen", "t": now[0], "auth": "correct-horse-battery-staple"})
    cb.onConnect(dat, "c")
    cb.onReceiveText(dat, 0, hello, "c")  # fresh authed session
    assert cb._rtt.lost == 0 and cb._rtt.outstanding == 0
    assert dict((k, v) for k, v in tables["morphogen_rtt"].rows)["lost"] == 0


# --- RTT status frame (2026-10-29) --------------------------------------------


def test_send_status_pushes_td_rtt_to_authed_clients(td):
    dat, tables, now = td
    assert cb.send_ping(dat) == 1
    t = cb._rtt._pending[0]
    now[0] += 8.0
    cb.onReceiveText(dat, 0, json.dumps({"v": 1, "pong": "morphogen", "t": t}), "a")
    dat.sent.clear()
    assert cb.send_status(dat) == 1
    client, text = dat.sent[-1]
    assert client == "a"
    frame = json.loads(text)
    assert frame == {
        "v": 1,
        "cmd": "status",
        "rtt": {"last_ms": 8.0, "median_ms": 8.0, "samples": 1, "outstanding": 0, "lost": 0},
    }
    assert cb._stats.statuses == 1
    assert cb.send_stats_line() == "TD sent: 1 ping · 1 status"
    assert ["statuses", 1] in tables["morphogen_cmds"].rows


def test_send_status_paced_out_shares_the_command_budget(td):
    dat, _, _ = td
    for _ in range(5):
        cb.send_preset(dat, "coral")
    assert cb.send_status(dat) == 0
    assert (cb._stats.statuses, cb._stats.paced) == (0, 1)


def test_make_status_command_rounds_and_validates():
    assert make_status_command(1.23456, None, 2, 0, 0) == (
        '{"v":1,"cmd":"status","rtt":{"last_ms":1.23,"median_ms":null,"samples":2,"outstanding":0,"lost":0}}'
    )
    for bad in ({"last_ms": float("inf")}, {"samples": "3"}, {"lost": -2}, {"median_ms": False}):
        with pytest.raises(ValueError):
            make_status_command(**bad)
    assert describe_send_stats(SendStats(statuses=2)) == "TD sent: 2 statuses"


# --- status heartbeat (2026-10-31) --------------------------------------------


def test_heartbeat_first_due_then_once_per_interval():
    now = [1000.0]
    hb = StatusHeartbeat(clock_ms=lambda: now[0])
    assert hb.interval_ms == STATUS_INTERVAL_MS
    assert hb.due() is True  # first tick goes at once
    now[0] += 999.0
    assert hb.due() is False
    now[0] += 1.0
    assert hb.due() is True  # exactly one interval later
    assert hb.due() is False  # same instant, already stamped
    hb.reset()
    assert hb.due() is True  # reset re-arms immediately


def test_heartbeat_bad_clock_and_interval_fail_quiet():
    now = [float("nan")]
    hb = StatusHeartbeat(clock_ms=lambda: now[0])
    assert hb.due() is False  # never sends on a broken clock
    now[0] = 5000.0
    assert hb.due() is True
    now[0] = 1000.0  # clock stepped back 4 s
    assert hb.due() is False
    now[0] = 2000.0  # one interval after the new reading, not after 5000
    assert hb.due() is True
    assert StatusHeartbeat(interval_ms=10).interval_ms == MIN_STATUS_INTERVAL_MS
    for junk in (float("inf"), "1000", True, None):
        assert StatusHeartbeat(interval_ms=junk).interval_ms == STATUS_INTERVAL_MS


def test_status_tick_paces_itself_and_skips_idle(td):
    dat, tables, now = td
    assert cb.status_tick(dat) == 1  # first tick after auth goes immediately
    assert json.loads(dat.sent[-1][1])["cmd"] == "status"
    for _ in range(30):  # e.g. every frame for half a second at 60 fps
        now[0] += 16.0
        assert cb.status_tick(dat) == 0
    now[0] += 600.0
    assert cb.status_tick(dat) == 1
    assert cb._stats.statuses == 2 and cb._stats.paced == 0
    cb.onDisconnect(dat, "a")
    now[0] += 5000.0
    assert cb.status_tick(dat) == 0
    assert cb._stats.no_client == 0  # idle ticks are not tallied
    assert ["no_client", 0] in tables["morphogen_cmds"].rows


def test_status_tick_sends_at_once_after_fresh_auth(td):
    dat, _, now = td
    assert cb.status_tick(dat) == 1
    now[0] += 100.0
    assert cb.status_tick(dat) == 0
    hello = json.dumps({"v": 1, "hello": "morphogen", "t": now[0], "auth": "correct-horse-battery-staple"})
    cb.onConnect(dat, "c")
    cb.onReceiveText(dat, 0, hello, "c")  # fresh authed session resets the heartbeat
    dat.sent.clear()
    assert cb.status_tick(dat) >= 1
    assert all(json.loads(t)["cmd"] == "status" for _, t in dat.sent)
    assert cb._stats.statuses == 1  # tally was reset with the session, then counted this one


def test_status_tick_paced_out_waits_a_full_interval(td):
    dat, _, now = td
    for _ in range(5):
        cb.send_preset(dat, "coral")  # spend the whole burst
    assert cb.status_tick(dat) == 0
    assert cb._stats.paced == 1
    now[0] += 50.0  # pacer has refilled half a token; heartbeat isn't due anyway
    assert cb.status_tick(dat) == 0
    assert cb._stats.paced == 1  # no retry every frame
    now[0] += 1000.0
    assert cb.status_tick(dat) == 1
