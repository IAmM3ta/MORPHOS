// Morphogen v2 step hold tests (node:test, no browser) — 2026-11-12.
// Run: npm test   (esbuild bundles app/loop.ts + sync/freezeControl.ts → .test-build/)
// createStepHold is how `freeze` should pause the field without stopping the
// frame loop (see the createStepHold header in src/app/loop.ts and
// FREEZE-REVIEW.md open questions). These tests drive the real frame loop with
// a fake rAF and the real freezeControl binding, the way main.ts will once the
// refusal is lifted. Nothing here is wired into main.ts yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameLoop, createStepHold, MAX_STEPS_PER_FRAME } from '../.test-build/loop.mjs';
import { createFreezeControl } from '../.test-build/freezeControl.mjs';
import { FREEZE_SILENCE_MS } from '../.test-build/freezeLease.mjs';

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

// A miniature main.ts: real loop, real hold, real freeze binding. Each frame
// records the gated step count; `lastFrameAt` stands in for TdClient's clock.
function rig() {
  const raf = fakeRaf();
  const hold = createStepHold();
  const thaws = [];
  const ctl = createFreezeControl({ halt: hold.hold, resume: hold.release, onThaw: (r) => thaws.push(r) });
  const frames = [];
  const td = { lastFrameAt: null };
  const loop = createFrameLoop({
    requestFrame: raf.requestFrame,
    cancelFrame: raf.cancelFrame,
    onFrame: (steps, now) => {
      ctl.tick(now, td.lastFrameAt);
      frames.push(hold.gate(steps));
    },
  });
  ctl.status('connecting');
  ctl.status('authenticating');
  ctl.status('open');
  return { raf, hold, ctl, loop, frames, thaws, td };
}

/** Advance the fake display at 60 Hz from `from` for `n` frames; returns the last timestamp. */
function run(raf, from, n) {
  let t = from;
  for (let i = 0; i < n; i++) {
    t += 1000 / 60;
    raf.flush(t);
  }
  return t;
}

test('gate: passes steps through, returns 0 while held; hold/release are idempotent', () => {
  const h = createStepHold();
  assert.equal(h.gate(3), 3);
  h.hold();
  h.hold();
  assert.equal(h.held(), true);
  assert.equal(h.gate(3), 0);
  h.release();
  h.release();
  assert.equal(h.held(), false);
  assert.equal(h.gate(2), 2);
});

test('a frozen field keeps its frame loop: onFrame still fires, kernel steps are 0', () => {
  const { raf, ctl, loop, frames } = rig();
  loop.start();
  let t = run(raf, 0, 3);
  assert.ok(frames.every((s) => s > 0));
  assert.equal(ctl.freeze(1000, t), true);
  frames.length = 0;
  t = run(raf, t, 10);
  assert.equal(frames.length, 10, 'loop kept running (HUD / Hum / tick still get frames)');
  assert.ok(frames.every((s) => s === 0), 'no kernel steps while frozen');
  assert.equal(loop.isRunning(), true);
});

test('expiry is noticed by the per-frame tick and steps resume with no burst', () => {
  const { raf, ctl, loop, frames, thaws, td } = rig();
  loop.start();
  let t = run(raf, 0, 1);
  ctl.freeze(500, t);
  td.lastFrameAt = t; // TD keeps talking, so silence can't fire first
  frames.length = 0;
  t = run(raf, t, 40); // ~667 ms, past the 500 ms lease
  assert.deepEqual(thaws, ['expired']);
  const firstLive = frames.findIndex((s) => s > 0);
  assert.ok(firstLive > 0, 'held for a while, then resumed');
  // after release every frame is a normal 60 Hz frame: never more than 2 steps,
  // and certainly never the frozen interval replayed (MAX_STEPS_PER_FRAME cap untouched)
  for (const s of frames.slice(firstLive)) assert.ok(s <= 2 && s <= MAX_STEPS_PER_FRAME, `steps ${s}`);
});

test('TD silence while frozen thaws from the frame loop even with a long lease', () => {
  const { raf, ctl, loop, thaws, td } = rig();
  loop.start();
  let t = run(raf, 0, 1);
  ctl.freeze(10_000, t);
  td.lastFrameAt = t;
  run(raf, t, Math.ceil((FREEZE_SILENCE_MS + 200) / (1000 / 60)));
  assert.deepEqual(thaws, ['silence']);
});

test('leaving open releases the hold synchronously, before any reconnect timer', () => {
  const { raf, hold, ctl, loop } = rig();
  loop.start();
  const t = run(raf, 0, 1);
  ctl.freeze(5000, t);
  assert.equal(hold.held(), true);
  ctl.status('reconnecting');
  assert.equal(hold.held(), false);
  assert.equal(loop.isRunning(), true);
});

test('a thaw after teardown never restarts a stopped loop', () => {
  const { raf, ctl, loop, thaws } = rig();
  loop.start();
  const t = run(raf, 0, 1);
  ctl.freeze(5000, t);
  loop.stop(); // teardown / performer stop while frozen
  ctl.local(); // thaw arrives afterwards
  assert.deepEqual(thaws, ['local']);
  assert.equal(loop.isRunning(), false);
  assert.equal(raf.pending(), 0, 'no frame scheduled behind the performer');
});

// 2026-11-13: the wiring in the createStepHold header uses ONE clock. This is
// what happens if someone wires the rAF `now` into tick while freeze() and
// TdClient's lastAt run on Date.now: before the freezeLease clock guard the
// hold never released (elapsed clamps at 0, lastAt looks far in the future).
test('mixed clocks (rAF now vs Date.now lease) still release the hold, never a still screen', () => {
  const { raf, hold, ctl, loop, thaws, td } = rig();
  loop.start();
  const epoch = 1_763_000_000_000;
  let t = run(raf, 0, 1);
  assert.equal(ctl.freeze(10_000, epoch), true); // wrong clock on purpose
  td.lastFrameAt = epoch; // TdClient stamps Date.now
  t = run(raf, t, 2); // tick(now≈50 ms since load, lastAt=epoch)
  assert.deepEqual(thaws, ['silence']);
  assert.equal(hold.held(), false);
});

test('one clock (the header wiring): Date.now-style clock times the lease correctly', () => {
  const raf = fakeRaf();
  const hold = createStepHold();
  const thaws = [];
  const ctl = createFreezeControl({ halt: hold.hold, resume: hold.release, onThaw: (r) => thaws.push(r) });
  let wall = 1_763_000_000_000; // stands in for Date.now, advanced with each frame
  const td = { lastAt: null };
  const loop = createFrameLoop({
    requestFrame: raf.requestFrame,
    cancelFrame: raf.cancelFrame,
    onFrame: (steps) => {
      ctl.tick(wall, td.lastAt);
      hold.gate(steps);
    },
  });
  ctl.status('open');
  loop.start();
  let t = 0;
  const frame = () => {
    t += 1000 / 60;
    wall += 1000 / 60;
    raf.flush(t);
  };
  frame();
  ctl.freeze(2000, wall);
  for (let i = 0; i < 60; i++) {
    td.lastAt = wall; // TD heartbeat keeps arriving
    frame();
  }
  assert.equal(hold.held(), true, '1 s into a 2 s lease: still frozen');
  for (let i = 0; i < 70; i++) {
    td.lastAt = wall;
    frame();
  }
  assert.deepEqual(thaws, ['expired']);
  assert.equal(hold.held(), false);
});
