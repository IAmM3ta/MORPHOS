// Morphogen v2 freeze wiring tests (node:test, no browser) — 2026-11-14.
// Run: npm test   (esbuild bundles app/freezeWiring.ts → .test-build/)
// createFreezeWiring is the one object main.ts will call once FREEZE-REVIEW's
// refusal is lifted: step hold + freeze binding + lease, with the clock owned
// inside so the rAF timestamp can't reach the lease (the 11-13 bug). These
// tests drive it through the real frame loop with a fake rAF whose timestamps
// start at 0 (ms since load) while the injected wall clock is epoch ms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createFreezeWiring } from '../.test-build/freezeWiring.mjs';
import { createFrameLoop } from '../.test-build/loop.mjs';
import { FREEZE_SILENCE_MS } from '../.test-build/freezeLease.mjs';
import { parseTdCommand } from '../.test-build/tdCommand.mjs';

const EPOCH = 1_763_100_000_000;
const FRAME = 1000 / 60;

function fakeRaf() {
  let nextId = 1;
  const queue = new Map();
  return {
    requestFrame(cb) {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    },
    cancelFrame(id) {
      queue.delete(id);
    },
    pending: () => queue.size,
    flush(now) {
      const cbs = [...queue.values()];
      queue.clear();
      for (const cb of cbs) cb(now);
    },
  };
}

// A miniature main.ts using the wiring exactly as its header describes.
function rig({ lastFrameAt, silenceMs } = {}) {
  const raf = fakeRaf();
  const clock = { wall: EPOCH, raf: 0 };
  const td = { lastAt: null };
  const thaws = [];
  const steps = [];
  const freeze = createFreezeWiring({
    now: () => clock.wall,
    lastFrameAt: lastFrameAt ?? (() => td.lastAt),
    onThaw: (r) => thaws.push(r),
    silenceMs,
  });
  const loop = createFrameLoop({
    requestFrame: raf.requestFrame,
    cancelFrame: raf.cancelFrame,
    onFrame: (s) => steps.push(freeze.frame(s)),
  });
  freeze.status('connecting');
  freeze.status('authenticating');
  freeze.status('open');
  // One 60 Hz frame on both clocks; `heartbeat` = TD frame arrived this frame.
  const frame = (heartbeat = false) => {
    clock.wall += FRAME;
    clock.raf += FRAME;
    if (heartbeat) td.lastAt = clock.wall;
    raf.flush(clock.raf);
  };
  const frames = (n, heartbeat = false) => {
    for (let i = 0; i < n; i++) frame(heartbeat);
  };
  return { raf, clock, td, thaws, steps, freeze, loop, frame, frames };
}

test('running: frame() passes steps through; describe() is null; freeze before open is ignored', () => {
  const w = createFreezeWiring({ now: () => EPOCH, lastFrameAt: () => null });
  assert.equal(w.frame(2), 2);
  assert.equal(w.describe(), null);
  assert.equal(w.freeze(1000), false, 'no authed session yet');
  assert.equal(w.held(), false);
  w.status('open');
  assert.equal(w.freeze(1000), true);
  assert.equal(w.frame(2), 0);
});

test('lease is timed on the injected clock, not the rAF timestamp', () => {
  const r = rig();
  r.loop.start();
  r.frames(1);
  assert.equal(r.freeze.freeze(2000), true);
  assert.equal(r.freeze.snapshot().until, r.clock.wall + 2000, 'started on the wall clock');
  r.frames(60, true); // ~1 s, TD heartbeat every frame
  assert.equal(r.freeze.held(), true, '1 s into a 2 s lease');
  r.frames(70, true); // past 2 s
  assert.deepEqual(r.thaws, ['expired']);
  assert.equal(r.freeze.held(), false);
});

test('the frame that crosses expiry already runs its steps (tick before gate)', () => {
  const r = rig();
  r.loop.start();
  r.frames(1);
  r.freeze.freeze(250);
  r.steps.length = 0;
  let i = 0;
  while (r.thaws.length === 0 && i++ < 100) r.frame(true);
  assert.deepEqual(r.thaws, ['expired']);
  assert.ok(r.steps.at(-1) > 0, 'expiry frame was not held');
  assert.ok(r.steps.slice(0, -1).every((s) => s === 0), 'every earlier frame was held');
});

test('TD silence ends a long lease via the lastFrameAt getter', () => {
  const r = rig();
  r.loop.start();
  r.frames(1, true);
  r.freeze.freeze(10_000);
  r.frames(Math.ceil((FREEZE_SILENCE_MS + 200) / FRAME)); // no heartbeats
  assert.deepEqual(r.thaws, ['silence']);
  assert.equal(r.freeze.held(), false);
});

test('a throwing or garbage lastFrameAt getter never wedges the hold (counts as silence)', () => {
  for (const bad of [
    () => {
      throw new Error('stats gone');
    },
    () => NaN,
    () => '123',
    () => undefined,
  ]) {
    const r = rig({ lastFrameAt: bad });
    r.loop.start();
    r.frames(1);
    assert.equal(r.freeze.freeze(10_000), true);
    r.frames(Math.ceil((FREEZE_SILENCE_MS + 200) / FRAME));
    assert.deepEqual(r.thaws, ['silence'], String(bad));
    assert.equal(r.loop.isRunning(), true, 'the loop survived every frame');
  }
});

test('describe(): rule 7 line counts down on the wall clock; snapshot() reports held', () => {
  const r = rig();
  r.freeze.freeze(2000);
  assert.equal(r.freeze.describe(), 'frozen by TD · 2 s left');
  assert.deepEqual(r.freeze.snapshot(), { until: EPOCH + 2000, reason: null, held: true });
  r.clock.wall += 1200;
  assert.equal(r.freeze.describe(), 'frozen by TD · 1 s left');
  r.freeze.thaw();
  assert.equal(r.freeze.describe(), null);
  assert.deepEqual(r.freeze.snapshot(), { until: null, reason: 'thaw', held: false });
});

test('leaving open releases synchronously; local input thaws; refused ms changes nothing', () => {
  const r = rig();
  assert.equal(r.freeze.freeze(9_999.5), false, 'refused, not clamped');
  assert.equal(r.freeze.held(), false);
  r.freeze.freeze(5000);
  r.freeze.status('reconnecting');
  assert.equal(r.freeze.held(), false);
  r.freeze.status('open');
  r.freeze.freeze(5000);
  assert.equal(r.freeze.local(), true);
  assert.deepEqual(r.thaws, ['disconnect', 'local']);
  assert.equal(r.freeze.local(), false, 'nothing left to thaw');
});

test('a thaw after the loop was stopped never restarts it', () => {
  const r = rig();
  r.loop.start();
  r.frames(1);
  r.freeze.freeze(5000);
  r.loop.stop();
  r.freeze.local();
  assert.equal(r.loop.isRunning(), false);
  assert.equal(r.raf.pending(), 0);
});

test('default clock is Date.now (the TdClient default)', () => {
  const w = createFreezeWiring({ lastFrameAt: () => null });
  w.status('open');
  const before = Date.now();
  w.freeze(1000);
  const until = w.snapshot().until;
  assert.ok(until >= before + 1000 && until <= Date.now() + 1000, `until ${until}`);
});

// Browser half of the step order, like the fixture guard in tdContract.test.mjs:
// main.ts may import the wiring only in the same change that lets the parser
// accept `freeze`. Delete this test in that change.
test('step order: main.ts does not import freezeWiring while freeze is refused', () => {
  const refused = parseTdCommand(JSON.stringify({ v: 1, cmd: 'freeze', ms: 1000 })) === null;
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  if (refused) assert.doesNotMatch(main, /freezeWiring|createFreezeWiring/);
});
