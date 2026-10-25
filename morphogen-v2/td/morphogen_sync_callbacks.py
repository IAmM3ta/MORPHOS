"""TouchDesigner WebSocket DAT callbacks for Morphogen v2 Sync (auth-gated).

Paste into the WebSocket DAT's Callbacks DAT (or point the DAT at this file).
Requires morphogen_sync_auth.py on TD's Python path (e.g. a Text DAT named
`morphogen_sync_auth` with "Module on demand" or a folder added to sys.path).

Configure the shared secret as a custom string parameter `Syncsecret` on the
parent COMP (never hard-code it here, and never commit it). The browser side
sets the same value via TdClient.setAuth(). Telemetry is written to the
`morphogen_table` Table DAT only after the hello is acked — the legacy stub
cleared/wrote the table for any connected client.

Table layout is unchanged from v1: rows of `/morphogen/{group}/{key}`, value;
the optional 16x16 `grid` goes to `morphogen_grid` (16 rows x 16 cols).

TD -> app commands (2026-10-22): call `send_preset(dat, "coral")` or
`send_ping(dat)` from a CHOP Execute / Panel Execute DAT (or a cue). They go
only to authed clients and are paced to the browser's 10/s, burst-5 limit.
Pongs come back on the same socket and are matched by RttTracker; the latest
round-trip is written to an optional `morphogen_rtt` Table DAT and never
touches `morphogen_table` (previously a pong cleared it).

Send tally (2026-10-25): every send_preset / send_ping attempt is counted in a
SendStats (sent / paced out / no authed client) and, if present, written to a
`morphogen_cmds` Table DAT; `send_stats_line()` gives a one-line summary for a
Text TOP. A ping that is paced out or has nobody to go to is no longer stamped
into the RTT tracker (it used to be, so it sat in the pending list forever).
Requires morphogen_sync_commands.py beside morphogen_sync_auth.py.
"""

from morphogen_sync_auth import ACCEPT, DROP, REPLY, SyncAuthGate  # noqa: E402
from morphogen_sync_commands import (  # noqa: E402
    NO_CLIENT,
    PACED,
    PONG,
    SENT,
    TELEMETRY,
    CommandPacer,
    RttTracker,
    SendStats,
    classify_inbound,
    describe_send_stats,
    make_preset_command,
)

_gate = None
_pacer = CommandPacer()
_rtt = RttTracker()
_stats = SendStats()


def _get_gate(dat):
    global _gate
    secret = str(dat.parent().par.Syncsecret.eval()) if hasattr(dat.parent().par, "Syncsecret") else ""
    if _gate is None or _gate.secret != secret:
        _gate = SyncAuthGate(secret=secret)  # raises if secret is unset/short → fail closed
    return _gate


def flatten_telemetry(msg):
    """Pure helper: telemetry dict -> list of (path, value) rows (grid excluded)."""
    rows = []
    for group in ("params", "field", "sensors", "audio", "loop"):
        part = msg.get(group)
        if isinstance(part, dict):
            for key, val in part.items():
                if isinstance(val, (int, float)) and not isinstance(val, bool):
                    rows.append((f"/morphogen/{group}/{key}", float(val)))
    return rows


def _authed_clients(dat):
    """Clients the gate has acked; commands never go to an un-authed socket."""
    return _gate.authed_clients() if _gate is not None else []


def _broadcast(dat, kind, make_frame):
    """Send one command frame to every authed client if the pacer allows it.

    `make_frame` is called only once we know the frame will go, so a ping that
    is paced out never registers as outstanding in the RTT tracker. Each
    attempt is tallied in `_stats`. Returns the number of clients it went to
    (0 = paced out or nobody authed; `_stats` / `morphogen_cmds` says which).
    """
    clients = _authed_clients(dat)
    if not clients:
        outcome, sent = NO_CLIENT, 0
    elif not _pacer.allow():
        outcome, sent = PACED, 0
    else:
        frame = make_frame()
        for c in clients:
            dat.sendText(c, frame)
        outcome, sent = SENT, len(clients)
    _stats.record(kind, outcome)
    _write_send_stats()
    return sent


def _write_send_stats():
    tdat = op("morphogen_cmds")  # noqa: F821 (TD builtin)
    if tdat is not None:
        tdat.clear()
        for row in _stats.as_rows():
            tdat.appendRow(row)


def send_stats_line():
    """e.g. 'TD sent: 3 presets · 1 ping · 2 paced' — compare with the browser's ?debug=1 line."""
    return describe_send_stats(_stats)


def send_preset(dat, preset_id, allow_unknown=False):
    """Switch the browser's Field preset, e.g. send_preset(op('websocket1'), 'coral').

    The id is validated up front (raises ValueError) even if the send is then
    paced out, so a typo in a cue fails loudly every time.
    """
    frame = make_preset_command(preset_id, allow_unknown)
    return _broadcast(dat, "preset", lambda: frame)


def send_ping(dat):
    """Ping authed clients; the matching pong updates `morphogen_rtt`."""
    return _broadcast(dat, "ping", _rtt.ping)


def _record_pong(payload):
    rtt = _rtt.on_pong(payload)
    if rtt is None:
        return
    tdat = op("morphogen_rtt")  # noqa: F821 (TD builtin)
    if tdat is not None:
        tdat.clear()
        tdat.appendRow(["last_ms", round(rtt, 2)])
        tdat.appendRow(["median_ms", round(_rtt.median_ms, 2)])
        tdat.appendRow(["samples", len(_rtt.samples)])


def onConnect(dat, client):
    try:
        _get_gate(dat).on_connect(client)
    except ValueError as e:
        debug(f"[morphogen sync] refusing all clients: {e}")  # noqa: F821 (TD builtin)
        if hasattr(dat, "disconnect"):
            dat.disconnect(client)
    return


def onDisconnect(dat, client):
    if _gate is not None:
        _gate.on_disconnect(client)
    return


def onReceiveText(dat, rowIndex, message, client):
    try:
        gate = _get_gate(dat)
    except ValueError:
        return
    action, reply, payload = gate.on_text(client, message)
    if reply and action in (REPLY, DROP):
        dat.sendText(client, reply)
    if action == REPLY and gate.is_authed(client):
        _pacer.reset()  # fresh authed session: browser refilled its gate too
        _stats.reset()  # ...and zeroed its command tally, so keep the two comparable
        _write_send_stats()
    if action == DROP:
        gate.on_disconnect(client)
        if hasattr(dat, "disconnect"):
            dat.disconnect(client)
        return
    if action != ACCEPT:
        return
    kind = classify_inbound(payload)
    if kind == PONG:
        _record_pong(payload)
        return
    if kind != TELEMETRY:
        return  # unknown authed frame: ignore rather than blank the tables
    table = op("morphogen_table")  # noqa: F821 (TD builtin)
    if table is not None:
        table.clear()
        for path, val in flatten_telemetry(payload):
            table.appendRow([path, val])
    grid = payload.get("grid")
    gdat = op("morphogen_grid")  # noqa: F821
    if gdat is not None and isinstance(grid, list) and len(grid) == 256:
        gdat.clear()
        for r in range(16):
            gdat.appendRow([float(v) for v in grid[r * 16:(r + 1) * 16]])
    return


def onReceiveBinary(dat, contents, client):
    # Binary frames are not part of the protocol; drop unauthenticated senders.
    if _gate is not None and not _gate.is_authed(client):
        _gate.on_disconnect(client)
        if hasattr(dat, "disconnect"):
            dat.disconnect(client)
    return
