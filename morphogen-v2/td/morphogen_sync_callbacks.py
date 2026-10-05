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
"""

from morphogen_sync_auth import ACCEPT, DROP, REPLY, SyncAuthGate  # noqa: E402

_gate = None


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
    if action == DROP:
        gate.on_disconnect(client)
        if hasattr(dat, "disconnect"):
            dat.disconnect(client)
        return
    if action != ACCEPT:
        return
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
