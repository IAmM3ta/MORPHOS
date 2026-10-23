"""TD <-> browser contract test for the Morphogen v2 control plane (2026-10-23).

Reads the same golden file as morphogen-v2/tests/tdContract.test.mjs
(morphogen-v2/tests/fixtures/td-commands.v1.json) and checks the TouchDesigner
side: the frame builders must emit exactly the bytes the browser suite parses,
reject what they should, and CommandPacer must give the same allow/deny
verdicts as the browser's createCommandGate for the same clock script.
"""

import json
import os
import sys

import pytest

ROOT = os.path.join(os.path.dirname(__file__), "..", "morphogen-v2")
sys.path.insert(0, os.path.join(ROOT, "td"))

from morphogen_sync_commands import (  # noqa: E402
    PONG,
    CommandPacer,
    RttTracker,
    classify_inbound,
    make_ping_command,
    make_preset_command,
)

with open(os.path.join(ROOT, "tests", "fixtures", "td-commands.v1.json"), encoding="utf-8") as fh:
    FIXTURE = json.load(fh)


def _build(spec):
    kind, arg = spec
    if kind == "preset":
        return make_preset_command(arg)
    if kind == "preset_unknown":
        return make_preset_command(arg, allow_unknown=True)
    if kind == "ping":
        # Fixture can't hold NaN/Infinity as JSON numbers, so they're spelled as strings.
        if arg in ("NaN", "Infinity"):
            arg = float(arg)
        return make_ping_command(arg)
    raise AssertionError(f"unknown build kind {kind!r}")


def test_fixture_version():
    assert FIXTURE["version"] == 1


@pytest.mark.parametrize("row", FIXTURE["built"], ids=lambda r: r["raw"])
def test_builder_emits_exact_bytes(row):
    assert _build(row["build"]) == row["raw"]


@pytest.mark.parametrize("spec", FIXTURE["builder_rejects"], ids=repr)
def test_builder_rejects(spec):
    with pytest.raises(ValueError):
        _build(spec)


def test_browser_pong_is_matched_by_rtt_tracker():
    clock = iter([1000.0, 1012.0])
    tracker = RttTracker(clock_ms=lambda: next(clock))
    assert tracker.ping() == make_ping_command(1000.0)
    reply = FIXTURE["pong"]["reply"]
    assert classify_inbound(reply) == PONG
    assert tracker.on_pong(reply) == pytest.approx(12.0)


def test_pacer_matches_browser_gate_script():
    times = iter(FIXTURE["gate"]["clock_ms"])
    pacer = CommandPacer(clock_ms=lambda: next(times))
    got = [pacer.allow() for _ in FIXTURE["gate"]["clock_ms"]]
    assert got == FIXTURE["gate"]["allow"]
