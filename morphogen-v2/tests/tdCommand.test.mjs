// Morphogen v2 TD → app control plane tests (node:test, no browser).
// Run: npm test   (bundles src/sync/tdCommand.ts with esbuild → .test-build/)
// Covers parsing (accepted / refused / junk frames), the ping reply shape and
// the token-bucket rate gate, including bad clocks that must never loosen it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTdCommand,
  pongFor,
  createCommandGate,
  describeTdRtt,
  MAX_STATUS_MS,
  MAX_STATUS_COUNT,
  MAX_COMMAND_BYTES,
  MAX_PRESET_ID_LEN,
  COMMAND_BURST,
} from '../.test-build/tdCommand.mjs';

const j = (o) => JSON.stringify(o);

test('preset: accepted, trimmed + lower-cased like ?preset=', () => {
  assert.deepEqual(parseTdCommand(j({ v: 1, cmd: 'preset', id: 'coral' })), { cmd: 'preset', id: 'coral' });
  assert.deepEqual(parseTdCommand(j({ v: 1, cmd: 'preset', id: '  Coral ' })), { cmd: 'preset', id: 'coral' });
  // Unknown-but-well-formed ids pass the parser; the cycler's set() ignores them.
  assert.deepEqual(parseTdCommand(j({ v: 1, cmd: 'preset', id: 'nebula' })), { cmd: 'preset', id: 'nebula' });
});

test('preset: junk ids refused', () => {
  for (const id of [undefined, 3, null, '', '   ', 'a'.repeat(MAX_PRESET_ID_LEN + 1), 'co ral', '__proto__!', '<b>', ['coral']]) {
    assert.equal(parseTdCommand(j({ v: 1, cmd: 'preset', id })), null, String(id));
  }
});

test('ping: finite t echoed, anything else becomes null', () => {
  assert.deepEqual(parseTdCommand(j({ v: 1, cmd: 'ping', t: 1234.5 })), { cmd: 'ping', t: 1234.5 });
  assert.deepEqual(parseTdCommand(j({ v: 1, cmd: 'ping' })), { cmd: 'ping', t: null });
  assert.deepEqual(parseTdCommand(j({ v: 1, cmd: 'ping', t: '5' })), { cmd: 'ping', t: null });
  assert.deepEqual(parseTdCommand('{"v":1,"cmd":"ping","t":1e999}'), { cmd: 'ping', t: null }); // Infinity
  assert.deepEqual(pongFor({ cmd: 'ping', t: 7 }), { v: 1, pong: 'morphogen', t: 7 });
});

test('reserved / unknown commands and malformed frames are refused', () => {
  for (const raw of [
    j({ v: 1, cmd: 'setParams', feed: 0.05 }),
    j({ v: 1, cmd: 'freeze' }),
    j({ v: 1, cmd: 'rm -rf' }),
    j({ v: 2, cmd: 'preset', id: 'coral' }),
    j({ cmd: 'preset', id: 'coral' }),
    j({ v: 1, ack: 'morphogen', ok: true }),
    j([1, 'preset']),
    'null',
    'not json',
    j({ v: 1, cmd: 'preset', id: 'coral', pad: 'x'.repeat(MAX_COMMAND_BYTES) }),
    42,
    null,
    undefined,
  ]) {
    assert.equal(parseTdCommand(raw), null, String(raw).slice(0, 40));
  }
});

test('gate: burst then ~rate per second', () => {
  const g = createCommandGate(10, 5);
  let ok = 0;
  for (let i = 0; i < 20; i++) if (g.allow(1000)) ok++;
  assert.equal(ok, 5); // burst only, same instant
  assert.equal(g.allow(1050), false); // 0.5 token refilled
  assert.equal(g.allow(1100), true); // 1 token
  ok = 0;
  for (let t = 1100; t <= 2100; t += 10) if (g.allow(t)) ok++;
  assert.ok(ok >= 9 && ok <= 11, `~10/s, got ${ok}`);
});

test('gate: backwards / NaN clocks never mint tokens; reset refills', () => {
  const g = createCommandGate(10, 2);
  assert.equal(g.allow(5000), true);
  assert.equal(g.allow(5000), true);
  assert.equal(g.allow(NaN), false);
  assert.equal(g.allow(Infinity), false);
  assert.equal(g.allow(1000), false); // clock went back
  g.reset();
  assert.equal(g.allow(1000), true);
  // bad constructor args fall back to defaults instead of disabling the gate
  const d = createCommandGate(NaN, -1);
  let ok = 0;
  for (let i = 0; i < 50; i++) if (d.allow(0)) ok++;
  assert.equal(ok, COMMAND_BURST);
});

test('status: bounds are inclusive, every field required, extra fields ignored (2026-10-29)', () => {
  const frame = (rtt) => JSON.stringify({ v: 1, cmd: 'status', rtt });
  const base = { last_ms: 0, median_ms: MAX_STATUS_MS, samples: 0, outstanding: MAX_STATUS_COUNT, lost: 0 };
  assert.deepEqual(parseTdCommand(frame({ ...base, extra: 'x' })), {
    cmd: 'status',
    rtt: { lastMs: 0, medianMs: MAX_STATUS_MS, samples: 0, outstanding: MAX_STATUS_COUNT, lost: 0 },
  });
  assert.equal(parseTdCommand(frame({ ...base, median_ms: MAX_STATUS_MS + 1 })), null);
  assert.equal(parseTdCommand(frame({ ...base, outstanding: MAX_STATUS_COUNT + 1 })), null);
  for (const key of Object.keys(base)) {
    const { [key]: _drop, ...rest } = base;
    assert.equal(parseTdCommand(frame(rest)), null, `missing ${key}`);
  }
  assert.equal(describeTdRtt({ lastMs: 3, medianMs: null, samples: 1, outstanding: 0, lost: 0 }), 'TD rtt: 3.0 ms');
});
