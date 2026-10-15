// Morphogen v2 frame loop tests (node:test, no browser) — 2026-10-15.
// Run: npm test   (esbuild bundles app/loop.ts → .test-build/, then node --test)
// Covers paceSteps, createFrameLoop (fake rAF) and singleFlightUnlock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SIM_HZ,
  SIM_STEP_MS,
  MAX_STEPS_PER_FRAME,
  FIRST_FRAME_MS,
  paceSteps,
  createFrameLoop,
  singleFlightUnlock,
} from '../.test-build/loop.mjs';

/** Run `frames` frames at `hz` through paceSteps; return total steps. */
function simulate(hz, frames) {
  let carry = 0;
  let total = 0;
  for (let i = 0; i < frames; i++) {
    const p = paceSteps(carry, 1000 / hz);
    assert.ok(p.steps >= 0 && p.steps <= MAX_STEPS_PER_FRAME);
    assert.ok(p.carryMs >= 0 && p.carryMs < SIM_STEP_MS, `carry ${p.carryMs}`);
    carry = p.carryMs;
    total += p.steps;
  }
  return total;
}

test('paceSteps: 60 Hz keeps the old 2 steps/frame; sim rate is display-independent', () => {
  assert.equal(SIM_HZ, 120);
  assert.deepEqual(paceSteps(0, 1000 / 60).steps, 2, '16.67 ms → 2 steps (float slack)');
  // one second of frames at each display rate → SIM_HZ steps (±1 for carry)
  for (const hz of [60, 75, 90, 120, 144, 165, 240]) {
    const steps = simulate(hz, hz);
    assert.ok(Math.abs(steps - SIM_HZ) <= 1, `${hz} Hz ran ${steps} steps/s`);
  }
  // 30 Hz: exactly 4/frame, still on rate
  assert.equal(simulate(30, 30), SIM_HZ);
});

test('paceSteps: slow frames hit the cap and drop the backlog instead of bursting', () => {
  assert.deepEqual(paceSteps(0, 1000), { steps: MAX_STEPS_PER_FRAME, carryMs: 0 }, 'tab return');
  assert.deepEqual(paceSteps(0, 1e9), { steps: MAX_STEPS_PER_FRAME, carryMs: 0 });
  assert.deepEqual(paceSteps(0, Infinity), { steps: 0, carryMs: 0 }, 'non-finite elapsed');
  // after a capped frame, the next normal frame is normal again
  const after = paceSteps(paceSteps(0, 5000).carryMs, 1000 / 60);
  assert.equal(after.steps, 2);
  // 20 Hz device: capped every frame → sim slows to 80 steps/s, never more
  assert.equal(simulate(20, 20), 20 * MAX_STEPS_PER_FRAME);
});

test('paceSteps: bad timestamps and corrupt carry never stall or burst', () => {
  assert.deepEqual(paceSteps(0, 0), { steps: 0, carryMs: 0 }, 'duplicate timestamp');
  assert.deepEqual(paceSteps(3, -16), { steps: 0, carryMs: 3 }, 'backwards clock keeps carry');
  assert.deepEqual(paceSteps(3, NaN), { steps: 0, carryMs: 3 });
  assert.equal(paceSteps(NaN, 1000 / 60).steps, 2, 'NaN carry → 0');
  assert.equal(paceSteps(-50, 1000 / 60).steps, 2, 'negative carry → 0');
  assert.equal(paceSteps(1e9, 1).steps, 1, 'huge carry clamped to < one step + elapsed');
  // sub-step frames accumulate: 4 ms + 4 ms + 4 ms → one step on the third
  let p = paceSteps(0, 4);
  assert.equal(p.steps, 0);
  p = paceSteps(p.carryMs, 4);
  assert.equal(p.steps, 0);
  p = paceSteps(p.carryMs, 4);
  assert.equal(p.steps, 1);
  assert.ok(Math.abs(p.carryMs - (12 - SIM_STEP_MS)) < 1e-9);
});

/** Fake rAF: frames run only when the test calls flush(now). */
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

test('createFrameLoop: paces from rAF timestamps; start is idempotent; stop cancels', () => {
  const raf = fakeRaf();
  const seen = [];
  const loop = createFrameLoop({ ...raf, onFrame: (steps, now) => seen.push([steps, now]) });
  assert.equal(loop.isRunning(), false);
  assert.equal(raf.pending(), 0, 'nothing scheduled before start');
  loop.start();
  loop.start();
  assert.equal(raf.pending(), 1, 'double start → one rAF chain');
  raf.flush(1000); // first frame: FIRST_FRAME_MS assumed
  raf.flush(1000 + 1000 / 60);
  raf.flush(1000 + 2000 / 60);
  raf.flush(1000 + 2000 / 60); // duplicate timestamp → 0 steps
  raf.flush(5000); // long gap → capped
  assert.deepEqual(
    seen.map((s) => s[0]),
    [Math.floor((FIRST_FRAME_MS + 1e-6) / SIM_STEP_MS), 2, 2, 0, MAX_STEPS_PER_FRAME],
  );
  loop.stop();
  assert.equal(loop.isRunning(), false);
  assert.equal(raf.pending(), 0, 'stop cancels the queued frame');
  loop.stop(); // idempotent
});

test('createFrameLoop: restart resets the clock (stopped time is not replayed)', () => {
  const raf = fakeRaf();
  const steps = [];
  const loop = createFrameLoop({ ...raf, onFrame: (s) => steps.push(s) });
  loop.start();
  raf.flush(0);
  loop.stop();
  loop.start();
  raf.flush(60_000); // a minute later
  assert.deepEqual(steps, [2, 2], 'restart frame treated as a first frame, not a 60 s gap');
});

test('createFrameLoop: stop() inside onFrame halts; a throwing frame does not freeze the loop', () => {
  const raf = fakeRaf();
  let n = 0;
  const loop = createFrameLoop({
    ...raf,
    onFrame: () => {
      n++;
      if (n === 2) loop.stop();
    },
  });
  loop.start();
  raf.flush(0);
  raf.flush(16);
  assert.equal(n, 2);
  assert.equal(raf.pending(), 0, 'stopped from inside the frame → nothing rescheduled');

  const raf2 = fakeRaf();
  let calls = 0;
  const loop2 = createFrameLoop({
    ...raf2,
    onFrame: () => {
      calls++;
      if (calls === 1) throw new Error('bad frame');
    },
  });
  loop2.start();
  assert.throws(() => raf2.flush(0), /bad frame/);
  assert.equal(raf2.pending(), 1, 'next frame still scheduled after a throw');
  raf2.flush(16);
  assert.equal(calls, 2);
  loop2.stop();
});

test('singleFlightUnlock: overlapping calls share one attempt; failures resolve false; retry after settle', async () => {
  let calls = 0;
  let release;
  const unlock = singleFlightUnlock(() => {
    calls++;
    return new Promise((r) => {
      release = r;
    });
  });
  const a = unlock();
  const b = unlock();
  assert.equal(a, b, 'ENTER + canvas press in one gesture → same promise');
  assert.equal(calls, 1);
  release(true);
  assert.equal(await a, true);
  const c = unlock(); // settled → a fresh attempt (a later gesture may succeed)
  assert.notEqual(c, a);
  assert.equal(calls, 2);
  release(false);
  assert.equal(await c, false);

  const rejecting = singleFlightUnlock(() => Promise.reject(new Error('NotAllowedError')));
  assert.equal(await rejecting(), false, 'rejecting resume() → false, never throws');
  const throwing = singleFlightUnlock(() => {
    throw new Error('sync throw');
  });
  assert.equal(await throwing(), false, 'synchronous throw → false');
  const truthy = singleFlightUnlock(async () => 'yes');
  assert.equal(await truthy(), false, 'only a real true counts as unlocked');
});
