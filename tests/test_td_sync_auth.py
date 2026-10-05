"""Tests for the Morphogen v2 TD-side Sync auth gate (no TouchDesigner needed)."""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "morphogen-v2", "td"))

from morphogen_sync_auth import (  # noqa: E402
    ACCEPT,
    DROP,
    IGNORE,
    REPLY,
    SyncAuthGate,
    make_ack,
)

SECRET = "correct-horse-battery-staple"
NOW = 1_800_000_000_000.0


def _gate(**kw):
    return SyncAuthGate(secret=SECRET, clock_ms=lambda: NOW, **kw)


def _hello(auth=SECRET, t=NOW):
    return json.dumps({"v": 1, "hello": "morphogen", "t": t, "auth": auth})


def _telemetry():
    return json.dumps({"v": 1, "t": NOW, "params": {"feed": 0.03, "kill": 0.06}})


def _ack(reply):
    return json.loads(reply)


def test_good_hello_then_telemetry_accepted():
    g = _gate()
    g.on_connect("c1")
    action, reply, payload = g.on_text("c1", _hello())
    assert action == REPLY and payload is None
    assert _ack(reply) == {"v": 1, "ack": "morphogen", "ok": True}
    assert g.is_authed("c1") and g.authed_count == 1
    action, reply, payload = g.on_text("c1", _telemetry())
    assert action == ACCEPT and reply is None
    assert payload["params"]["feed"] == pytest.approx(0.03)


def test_telemetry_before_hello_is_dropped():
    g = _gate()
    g.on_connect("c1")
    action, reply, payload = g.on_text("c1", _telemetry())
    assert action == DROP and payload is None
    assert _ack(reply) == {"v": 1, "ack": "morphogen", "ok": False, "reason": "auth_required"}
    assert not g.is_authed("c1")


def test_wrong_secret_rejected_without_echo():
    g = _gate()
    g.on_connect("c1")
    action, reply, _ = g.on_text("c1", _hello(auth="nope-nope-nope-nope"))
    assert action == REPLY and not g.is_authed("c1")
    assert _ack(reply)["reason"] == "bad_auth"
    assert "nope" not in reply and SECRET not in reply


@pytest.mark.parametrize("auth", ["", None, 12345, "\u00e9" * 20])
def test_malformed_auth_values_rejected(auth):
    g = _gate()
    g.on_connect("c1")
    action, reply, _ = g.on_text("c1", json.dumps({"v": 1, "hello": "morphogen", "t": NOW, "auth": auth}))
    assert action == REPLY and _ack(reply)["reason"] == "bad_auth"


@pytest.mark.parametrize("t", [NOW - 31_000, NOW + 31_000, "now", None, True])
def test_stale_or_bad_timestamp_rejected(t):
    g = _gate()
    g.on_connect("c1")
    action, reply, _ = g.on_text("c1", _hello(t=t))
    assert action == REPLY and _ack(reply)["reason"] == "stale_hello"


def test_timestamp_inside_skew_window_ok():
    g = _gate()
    g.on_connect("c1")
    assert g.on_text("c1", _hello(t=NOW - 29_000))[0] == REPLY


def test_oversized_frame_dropped_before_parse():
    g = _gate(max_frame_bytes=128)
    g.on_connect("c1")
    action, reply, _ = g.on_text("c1", "x" * 200)
    assert action == DROP and _ack(reply)["reason"] == "frame_too_large"


@pytest.mark.parametrize("frame,reason", [("{not json", "bad_json"), ('{"v":2,"hello":"morphogen"}', "bad_version"), ("[1,2]", "bad_version")])
def test_garbage_pre_auth_dropped(frame, reason):
    g = _gate()
    g.on_connect("c1")
    action, reply, _ = g.on_text("c1", frame)
    assert action == DROP and _ack(reply)["reason"] == reason


def test_garbage_after_auth_ignored_not_dropped():
    g = _gate()
    g.on_connect("c1")
    g.on_text("c1", _hello())
    assert g.on_text("c1", "{not json")[0] == IGNORE
    assert g.on_text("c1", _hello())[0] == IGNORE  # duplicate hello is a no-op
    assert g.is_authed("c1")


def test_attempt_cap_drops_after_repeated_bad_hellos():
    g = _gate(max_hello_attempts=2)
    g.on_connect("c1")
    action, reply, _ = g.on_text("c1", _hello(auth="x" * 20))
    assert action == REPLY and _ack(reply)["reason"] == "bad_auth"
    action, reply, _ = g.on_text("c1", _hello(auth="x" * 20))
    assert action == DROP and _ack(reply)["reason"] == "too_many_attempts"


def test_good_hello_after_bad_one_under_cap_authenticates():
    g = _gate()
    g.on_connect("c1")
    assert g.on_text("c1", _hello(auth="y" * 20))[0] == REPLY
    action, reply, _ = g.on_text("c1", _hello())
    assert action == REPLY and _ack(reply)["ok"] is True and g.is_authed("c1")


def test_clients_are_isolated_and_disconnect_clears_auth():
    g = _gate()
    g.on_connect("a")
    g.on_connect("b")
    g.on_text("a", _hello())
    assert g.is_authed("a") and not g.is_authed("b")
    assert g.on_text("b", _telemetry())[0] == DROP
    g.on_disconnect("a")
    assert not g.is_authed("a") and g.authed_count == 0
    g.on_connect("a")  # reconnect must re-hello
    assert g.on_text("a", _telemetry())[0] == DROP


def test_frame_from_unknown_client_is_treated_as_unauthed():
    g = _gate()
    assert g.on_text("ghost", _telemetry())[0] == DROP


@pytest.mark.parametrize("secret", ["", "short", "has space in the secret!", " padded-secret-value-x "])
def test_weak_server_secret_fails_closed(secret):
    with pytest.raises(ValueError):
        SyncAuthGate(secret=secret)


def test_make_ack_shape():
    assert json.loads(make_ack(True)) == {"v": 1, "ack": "morphogen", "ok": True}
    assert json.loads(make_ack(False, "bad_auth"))["reason"] == "bad_auth"


def test_callbacks_flatten_telemetry_skips_non_numeric():
    from morphogen_sync_callbacks import flatten_telemetry

    rows = flatten_telemetry(
        {
            "params": {"feed": 0.03, "kill": 0.06, "name": "mitosis"},
            "loop": {"count": 2, "on": True},
            "grid": [0.0] * 256,
        }
    )
    assert ("/morphogen/params/feed", 0.03) in rows
    assert ("/morphogen/loop/count", 2.0) in rows
    assert all("name" not in p and "on" not in p.rsplit("/", 1)[-1] for p, _ in rows)
    assert not any("grid" in p for p, _ in rows)
