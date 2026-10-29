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
import { parseTdCommand, pongFor, createCommandGate, describeTdRtt } from '../.test-build/tdCommand.mjs';

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
