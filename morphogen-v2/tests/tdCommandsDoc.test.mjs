// Morphogen v2 TD command doc drift test (2026-10-27, node:test, no browser).
// Run: npm test
// docs/morphogen-redteam/TD-COMMANDS.md is the human map of the TD -> app
// control plane. This test keeps it honest: the Limits table must match the
// real constants in src/sync/tdCommand.ts, every example frame the doc calls
// "accepted" must parse (and its pong must match), every reserved command the
// doc names must be refused, and the doc must point at the live fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_COMMAND_BYTES,
  MAX_PRESET_ID_LEN,
  COMMAND_RATE_PER_S,
  COMMAND_BURST,
  parseTdCommand,
  pongFor,
} from '../.test-build/tdCommand.mjs';

const doc = readFileSync(new URL('../../docs/morphogen-redteam/TD-COMMANDS.md', import.meta.url), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/td-commands.v1.json', import.meta.url), 'utf8'));

/** Value cell of the Limits table row whose last cell names `constant`. */
function limitRow(constant) {
  const row = doc.split('\n').find((l) => l.startsWith('|') && l.includes(`\`${constant}\``));
  assert.ok(row, `Limits table has a row for ${constant}`);
  const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
  const n = Number.parseFloat(cells[1]);
  assert.ok(Number.isFinite(n), `numeric value for ${constant}: ${cells[1]}`);
  return n;
}

test('Limits table matches tdCommand.ts constants', () => {
  assert.equal(limitRow('MAX_COMMAND_BYTES'), MAX_COMMAND_BYTES);
  assert.equal(limitRow('MAX_PRESET_ID_LEN'), MAX_PRESET_ID_LEN);
  assert.equal(limitRow('COMMAND_RATE_PER_S'), COMMAND_RATE_PER_S);
  assert.equal(limitRow('COMMAND_BURST'), COMMAND_BURST);
});

test('accepted example frames parse, and the ping example pong matches the doc', () => {
  const preset = parseTdCommand('{"v":1,"cmd":"preset","id":"coral"}');
  assert.deepEqual(preset, { cmd: 'preset', id: 'coral' });
  assert.ok(doc.includes('`{"v":1,"cmd":"preset","id":"coral"}`'));

  const ping = parseTdCommand('{"v":1,"cmd":"ping","t":1000}');
  assert.deepEqual(ping, { cmd: 'ping', t: 1000 });
  const pong = JSON.stringify(pongFor(ping));
  assert.ok(doc.includes(`\`${pong}\``), `doc shows the real pong ${pong}`);
  assert.deepEqual(pongFor(ping), fixture.pong.reply);
});

test('reserved commands named in the doc are refused', () => {
  for (const cmd of ['setParams', 'freeze']) {
    assert.ok(doc.includes(`\`${cmd}\``), `doc names ${cmd}`);
    assert.equal(parseTdCommand(JSON.stringify({ v: 1, cmd })), null);
  }
});

test('doc points at the live fixture and the code files it maps', () => {
  assert.equal(fixture.version, 1);
  for (const path of [
    'tests/fixtures/td-commands.v1.json',
    'src/sync/tdCommand.ts',
    'td/morphogen_sync_commands.py',
    'td/morphogen_sync_callbacks.py',
  ]) {
    assert.ok(doc.includes(path), `doc mentions ${path}`);
  }
});
