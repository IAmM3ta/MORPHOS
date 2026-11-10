// Morphogen v2 TD ↔ browser contract test (2026-10-23).
// The browser parser (src/sync/tdCommand.ts) and the TouchDesigner sender
// (td/morphogen_sync_commands.py) are two hand-written twins. This suite and
// ../../tests/test_td_sync_contract.py both read the SAME golden file,
// tests/fixtures/td-commands.v1.json, so a rule change on one side that the
// other side doesn't match fails a test instead of silently dropping frames.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseTdCommand,
  pongFor,
  createCommandGate,
  describeTdRtt,
  REMOTE_PARAM_RANGE,
  REMOTE_PARAM_DECIMALS,
} from '../.test-build/tdCommand.mjs';
import { TUNE_RANGE, TUNE_STEP } from '../.test-build/fieldTune.mjs';
import { PARAM_LIMITS } from '../.test-build/grayScott.mjs';
import { MIN_FREEZE_MS, MAX_FREEZE_MS, isValidFreezeMs } from '../.test-build/freezeLease.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/td-commands.v1.json', import.meta.url), 'utf8'));

test('contract: fixture is v1', () => {
  assert.equal(fixture.version, 1);
});

test('contract: every frame the TD builder emits parses to the expected command', () => {
  for (const row of fixture.built) {
    assert.deepEqual(parseTdCommand(row.raw), row.parsed, row.raw);
  }
});

test('contract: reserved / malformed frames are refused by the browser', () => {
  for (const raw of fixture.browser_refuses) {
    assert.equal(parseTdCommand(raw), null, raw);
  }
});

test('contract: ping reply shape matches what the TD RttTracker expects', () => {
  const cmd = parseTdCommand(fixture.pong.ping_raw);
  assert.ok(cmd && cmd.cmd === 'ping');
  assert.deepEqual(pongFor(cmd), fixture.pong.reply);
});

test('contract: rate gate verdicts match the shared clock script', () => {
  const gate = createCommandGate();
  const got = fixture.gate.clock_ms.map((t) => gate.allow(t));
  assert.deepEqual(got, fixture.gate.allow);
});

test('contract: describeTdRtt prints the same line as TD describe_rtt_fields (2026-10-29)', () => {
  for (const row of fixture.rtt_lines.rows) {
    const cmd = parseTdCommand(JSON.stringify({ v: 1, cmd: 'status', rtt: row.rtt }));
    assert.ok(cmd && cmd.cmd === 'status', JSON.stringify(row.rtt));
    assert.equal(describeTdRtt(cmd.rtt), row.line);
  }
});

test('contract: setParams range = fixture = slider travel, inside PARAM_LIMITS (2026-11-05)', () => {
  const want = fixture.remote_param_range;
  assert.equal(REMOTE_PARAM_DECIMALS, want.decimals);
  assert.equal(1 / 10 ** REMOTE_PARAM_DECIMALS, TUNE_STEP, 'rounding matches the slider step');
  for (const knob of ['feed', 'kill']) {
    assert.deepEqual([...REMOTE_PARAM_RANGE[knob]], want[knob], `${knob} vs fixture`);
    assert.deepEqual([...REMOTE_PARAM_RANGE[knob]], [...TUNE_RANGE[knob]], `${knob} vs TUNE_RANGE`);
    const [lo, hi] = REMOTE_PARAM_RANGE[knob];
    assert.ok(lo >= PARAM_LIMITS[knob][0] && hi <= PARAM_LIMITS[knob][1], `${knob} inside PARAM_LIMITS`);
  }
});

// ---- freeze / thaw, staged (FREEZE-REVIEW.md step 1, 2026-11-10) ----------
// The fixture now pins the freeze frames TD can already build, but the browser
// must keep refusing ALL of them until main.ts / TdClient wiring and the
// review's step-4 tests exist. The second test below is the browser-side half
// of the step-order guard (TD's half is test_no_freeze_sender_until_the_browser_
// accepts_it); delete both in the change that lifts the refusal.
test('contract: freeze_staged ms range = freezeLease.ts limits (2026-11-10)', () => {
  const want = fixture.freeze_staged.freeze_ms_range;
  assert.equal(MIN_FREEZE_MS, want.min);
  assert.equal(MAX_FREEZE_MS, want.max);
  for (const row of fixture.freeze_staged.built) {
    const frame = JSON.parse(row.raw);
    if (frame.cmd === 'freeze') assert.ok(isValidFreezeMs(frame.ms), `lease would accept ${row.raw}`);
  }
  for (const ms of fixture.freeze_staged.lease_rejects_ms) {
    assert.equal(isValidFreezeMs(ms), false, `lease must refuse ${JSON.stringify(ms)}`);
  }
});

test('contract: staged freeze / thaw frames stay refused until the wiring lands (2026-11-10)', () => {
  for (const row of fixture.freeze_staged.built) {
    assert.equal(parseTdCommand(row.raw), null, `still refused: ${row.raw}`);
  }
  for (const raw of fixture.freeze_staged.browser_refuses) {
    assert.equal(parseTdCommand(raw), null, raw);
  }
});
