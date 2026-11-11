// Morphogen v2 freeze control binding tests (node:test, no browser) — 2026-11-11.
// Run: npm test   (esbuild bundles sync/freezeControl.ts → .test-build/, then node --test)
// These are the FREEZE-REVIEW.md step-4 cases that must exist before the
// `freeze` refusal is lifted: lease expiry and renewal resume the loop exactly
// once, socket close while frozen thaws before reconnect, a fresh ack starts
// running, local press thaws, silence timeout, out-of-range refused (not
// clamped). The binding is driven with fake halt/resume hooks and a fake clock;
// it is not wired into main.ts and parseTdCommand still refuses `freeze`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFreezeControl } from '../.test-build/freezeControl.mjs';
import { FREEZE_SILENCE_MS } from '../.test-build/freezeLease.mjs';

// Records every hook call in order so tests can assert exact sequences.
function harness() {
  const calls = [];
  const ctl = createFreezeControl({
    halt: () => calls.push('halt'),
    resume: () => calls.push('resume'),
    onThaw: (r) => calls.push(`thaw:${r}`),
  });
  ctl.status('connecting');
  ctl.status('authenticating');
  ctl.status('open');
  calls.length = 0; // connection set-up is not under test
  return { ctl, calls };
}

test('freeze halts once; renewal does not halt again', () => {
  const { ctl, calls } = harness();
  assert.equal(ctl.freeze(1000, 0), true);
  assert.equal(ctl.freeze(2000, 500), true); // renew
  assert.deepEqual(calls, ['halt']);
  assert.equal(ctl.holding(), true);
});

test('out-of-range freeze is refused, not clamped: no halt, no lease', () => {
  const { ctl, calls } = harness();
  for (const bad of [0, 249, 10_001, 1.5, '500', null, NaN]) {
    assert.equal(ctl.freeze(bad, 0), false, `refuses ${String(bad)}`);
  }
  assert.deepEqual(calls, []);
  assert.equal(ctl.lease.snapshot().until, null);
  // a bad renewal leaves the good lease (and the halted loop) alone
  ctl.freeze(1000, 0);
  assert.equal(ctl.freeze(60_000, 100), false);
  assert.equal(ctl.lease.snapshot().until, 1000);
  assert.deepEqual(calls, ['halt']);
});

test('freeze is ignored unless the session is authed (status open)', () => {
  const calls = [];
  const ctl = createFreezeControl({ halt: () => calls.push('halt'), resume: () => calls.push('resume') });
  assert.equal(ctl.freeze(1000, 0), false); // never connected
  ctl.status('authenticating');
  assert.equal(ctl.freeze(1000, 0), false); // hello sent, no ack yet
  assert.deepEqual(calls, []);
});

test('lease expiry resumes exactly once via tick', () => {
  const { ctl, calls } = harness();
  ctl.freeze(1000, 0);
  assert.equal(ctl.tick(500, 400), null);
  assert.equal(ctl.tick(1000, 900), 'expired');
  assert.equal(ctl.tick(1100, 1000), null); // nothing left to thaw
  assert.deepEqual(calls, ['halt', 'resume', 'thaw:expired']);
  assert.equal(ctl.holding(), false);
});

test('renewal before expiry keeps the loop halted past the first lease', () => {
  const { ctl, calls } = harness();
  ctl.freeze(1000, 0);
  ctl.freeze(1000, 900); // renewed from 900 → ends at 1900
  assert.equal(ctl.tick(1500, 1400), null);
  assert.equal(ctl.holding(), true);
  assert.equal(ctl.tick(1900, 1800), 'expired');
  assert.deepEqual(calls, ['halt', 'resume', 'thaw:expired']);
});

test('explicit TD thaw resumes; a thaw while running is a no-op', () => {
  const { ctl, calls } = harness();
  assert.equal(ctl.thaw(), false);
  assert.deepEqual(calls, []);
  ctl.freeze(5000, 0);
  assert.equal(ctl.thaw(), true);
  assert.deepEqual(calls, ['halt', 'resume', 'thaw:thaw']);
});

test('socket close while frozen thaws synchronously, before any reconnect', () => {
  const { ctl, calls } = harness();
  ctl.freeze(10_000, 0);
  // TdClient calls onStatus('reconnecting') before it arms the retry timer,
  // so the resume must already have happened when status() returns.
  ctl.status('reconnecting');
  assert.deepEqual(calls, ['halt', 'resume', 'thaw:disconnect']);
  assert.equal(ctl.holding(), false);
  assert.equal(ctl.lease.snapshot().until, null);
});

test('terminal error while frozen also thaws', () => {
  const { ctl, calls } = harness();
  ctl.freeze(10_000, 0);
  ctl.status('error');
  assert.deepEqual(calls, ['halt', 'resume', 'thaw:disconnect']);
});

test('fresh ack starts running and a reconnected TD cannot inherit the old lease', () => {
  const { ctl, calls } = harness();
  ctl.freeze(10_000, 0);
  ctl.status('reconnecting');
  ctl.status('connecting');
  ctl.status('authenticating');
  ctl.status('open');
  assert.equal(ctl.holding(), false);
  assert.equal(ctl.tick(100, null), null);
  assert.deepEqual(calls, ['halt', 'resume', 'thaw:disconnect']); // one thaw, no second halt
  // the new session can freeze again normally
  assert.equal(ctl.freeze(1000, 200), true);
  assert.deepEqual(calls.slice(-1), ['halt']);
});

test('repeated open (no transition) does not thaw a live lease', () => {
  const { ctl, calls } = harness();
  ctl.freeze(5000, 0);
  ctl.status('open');
  assert.equal(ctl.holding(), true);
  assert.deepEqual(calls, ['halt']);
});

test('local press thaws with reason local; local while running is a no-op', () => {
  const { ctl, calls } = harness();
  assert.equal(ctl.local(), false);
  ctl.freeze(5000, 0);
  assert.equal(ctl.local(), true);
  assert.deepEqual(calls, ['halt', 'resume', 'thaw:local']);
});

test('TD silence while frozen thaws via tick', () => {
  const { ctl, calls } = harness();
  ctl.freeze(10_000, 0);
  assert.equal(ctl.tick(FREEZE_SILENCE_MS, null), null); // exactly at the limit: still held
  assert.equal(ctl.tick(FREEZE_SILENCE_MS + 1, null), 'silence');
  assert.deepEqual(calls, ['halt', 'resume', 'thaw:silence']);
});

test('heartbeat frames keep a long lease alive against the silence check', () => {
  const { ctl } = harness();
  ctl.freeze(10_000, 0);
  for (let t = 1000; t < 10_000; t += 1000) assert.equal(ctl.tick(t, t - 10), null);
  assert.equal(ctl.holding(), true);
  assert.equal(ctl.tick(10_000, 9_990), 'expired');
});

test('NaN clock never resumes or halts on its own', () => {
  const { ctl, calls } = harness();
  assert.equal(ctl.freeze(1000, NaN), false);
  ctl.freeze(1000, 0);
  assert.equal(ctl.tick(NaN, null), null);
  assert.deepEqual(calls, ['halt']);
});
