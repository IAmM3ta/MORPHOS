// Morphogen v2 freeze lease tests (node:test, no browser) — 2026-11-08.
// Run: npm test   (esbuild bundles sync/freezeLease.ts → .test-build/, then node --test)
// Covers FREEZE-REVIEW.md rules 1, 2, 6 and 7 on the pure helper: range
// refusals (refused, not clamped), renewal, expiry, explicit thaw, silence
// timeout, caller-driven 'disconnect' / 'local' thaws, clock safety, and the
// status / debug text. The helper is not wired into main.ts yet, and
// tdCommandsDoc still asserts that `freeze` frames are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_FREEZE_MS,
  MAX_FREEZE_MS,
  FREEZE_SILENCE_MS,
  isValidFreezeMs,
  createFreezeLease,
  describeFreeze,
  describeThaw,
} from '../.test-build/freezeLease.mjs';

test('limits match FREEZE-REVIEW.md rule 1 and rule 6', () => {
  assert.equal(MIN_FREEZE_MS, 250);
  assert.equal(MAX_FREEZE_MS, 10_000);
  assert.equal(FREEZE_SILENCE_MS, 3_000);
});

test('isValidFreezeMs: inclusive integer range, everything else refused', () => {
  for (const ok of [250, 251, 5000, 10_000]) assert.ok(isValidFreezeMs(ok), `accepts ${ok}`);
  for (const bad of [0, 249, 10_001, 1.5, 500.5, -500, '500', null, undefined, NaN, Infinity, {}, []]) {
    assert.equal(isValidFreezeMs(bad), false, `refuses ${String(bad)}`);
  }
});

test('start: refused, not clamped — an out-of-range frame leaves state untouched', () => {
  const lease = createFreezeLease();
  assert.equal(lease.start(60_000, 0), false);
  assert.equal(lease.frozen(0), false);
  assert.equal(lease.start(1000, 0), true);
  // a bad renewal must not shorten, lengthen or cancel the good lease
  assert.equal(lease.start(10_001, 100), false);
  assert.equal(lease.start(1000, NaN), false);
  assert.equal(lease.remaining(100), 900);
});

test('lease expires on its own and check() reports why', () => {
  const lease = createFreezeLease();
  lease.start(500, 1000);
  assert.equal(lease.frozen(1499), true);
  assert.equal(lease.check(1499, 1000), null);
  assert.equal(lease.frozen(1500), false, 'reads thawed at expiry even before check()');
  assert.equal(lease.check(1500, 1000), 'expired');
  assert.deepEqual(lease.snapshot(), { until: null, reason: 'expired' });
  assert.equal(lease.check(1600, 1000), null, 'nothing left to thaw');
});

test('renewal restarts the lease from now', () => {
  const lease = createFreezeLease();
  lease.start(1000, 0);
  lease.start(1000, 900);
  assert.equal(lease.remaining(1500), 400);
  assert.deepEqual(lease.snapshot(), { until: 1900, reason: null });
});

test('explicit thaw ends at once and is a no-op when running', () => {
  const lease = createFreezeLease();
  assert.equal(lease.thaw('thaw'), false, 'defensive thaw while running');
  assert.equal(lease.snapshot().reason, null, 'a no-op thaw does not overwrite the last reason');
  lease.start(5000, 0);
  assert.equal(lease.thaw('thaw'), true);
  assert.equal(lease.frozen(1), false);
  assert.equal(lease.remaining(1), 0);
  assert.equal(lease.snapshot().reason, 'thaw');
});

test('caller-driven exits: disconnect and local input are recorded', () => {
  for (const reason of ['disconnect', 'local']) {
    const lease = createFreezeLease();
    lease.start(10_000, 0);
    assert.equal(lease.thaw(reason), true);
    assert.deepEqual(lease.snapshot(), { until: null, reason });
  }
});

test('silence: no TD frame for FREEZE_SILENCE_MS thaws a still-valid lease', () => {
  const lease = createFreezeLease();
  lease.start(10_000, 0);
  assert.equal(lease.check(2_500, 2_000), null, 'heartbeat 0.5 s ago');
  assert.equal(lease.check(5_000, 2_000), null, 'exactly 3 s of silence is still OK');
  assert.equal(lease.check(5_001, 2_000), 'silence');
  assert.equal(lease.frozen(5_001), false);
});

test('silence counts the freeze frame itself as traffic (null or stale lastFrameAt)', () => {
  const lease = createFreezeLease();
  lease.start(10_000, 1_000);
  assert.equal(lease.check(3_900, null), null);
  assert.equal(lease.check(3_900, 0), null, 'older lastFrameAt does not pre-date the lease');
  assert.equal(lease.check(4_001, null), 'silence');
});

test('custom silence window; junk window falls back to the default', () => {
  const short = createFreezeLease(1000);
  short.start(10_000, 0);
  assert.equal(short.check(1001, 0), 'silence');
  const junk = createFreezeLease(NaN);
  junk.start(10_000, 0);
  assert.equal(junk.check(2_000, 0), null);
  assert.equal(junk.check(3_001, 0), 'silence');
});

test('clock safety: NaN is ignored, a backwards clock cannot lengthen the lease', () => {
  const lease = createFreezeLease();
  lease.start(1000, 5000);
  assert.equal(lease.remaining(NaN), null);
  assert.equal(lease.frozen(NaN), true);
  assert.equal(lease.check(NaN, 5000), null, 'unusable clock never thaws or extends');
  assert.equal(lease.remaining(1000), 1000, 'clock went back: capped at the granted 1000 ms');
  assert.equal(lease.remaining(5600), 400);
});

test('status and debug text', () => {
  assert.equal(describeFreeze(4200), 'frozen by TD · 5 s left');
  assert.equal(describeFreeze(1000), 'frozen by TD · 1 s left');
  assert.equal(describeFreeze(10), 'frozen by TD · 1 s left', 'never "0 s left" while frozen');
  assert.equal(describeFreeze(null), 'frozen by TD');
  assert.equal(describeThaw('local'), 'thawed (local)');
  assert.equal(describeThaw('silence'), 'thawed (silence)');
});

// 2026-11-13 clock guard: main.ts has two clocks — rAF's `now` (ms since page
// load) and TdClient's Date.now (which stamps commandStats().lastAt). If the
// lease is started on one and checked on the other it must thaw, not hold forever.
test('clock guard: a now far behind the lease start thaws (mixed clocks never hold forever)', () => {
  const epoch = 1_763_000_000_000; // a Date.now()-sized start
  const lease = createFreezeLease();
  lease.start(10_000, epoch);
  // a small backwards step (< silence window) is tolerated: still frozen
  assert.equal(lease.check(epoch - 1000, null), null);
  // rAF-sized clock (12 s since page load) against an epoch lease: thaw
  assert.equal(lease.check(12_000, null), 'silence');
  assert.deepEqual(lease.snapshot(), { until: null, reason: 'silence' });
});

test('clock guard: a lastFrameAt ahead of now cannot postpone the silence thaw', () => {
  const lease = createFreezeLease();
  lease.start(10_000, 1000);
  const epochLastAt = 1_763_000_000_000; // Date.now()-stamped TD frame
  assert.equal(lease.check(1000 + FREEZE_SILENCE_MS, epochLastAt), null, 'not silent yet (from lease start)');
  assert.equal(lease.check(1001 + FREEZE_SILENCE_MS, epochLastAt), 'silence', 'future frame ignored');
  // a genuine recent frame on the same clock still counts as traffic
  const ok = createFreezeLease();
  ok.start(10_000, 1000);
  assert.equal(ok.check(1000 + FREEZE_SILENCE_MS + 500, 1000 + 1000), null);
});
