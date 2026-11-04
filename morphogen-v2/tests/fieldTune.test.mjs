// Morphogen v2 Field feed / kill slider tests (node:test, no browser) — 2026-11-04.
// Run: npm test   (esbuild bundles ui/fieldTune.ts → .test-build/, then node --test)
// Covers slider ranges vs kernel limits / presets, value parsing (snap, clamp,
// junk), status text, and mountFieldSliders' apply / revert / sync behaviour
// using plain-object stand-ins for <input type="range">.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TUNE_RANGE,
  TUNE_STEP,
  parseTuneValue,
  formatTuneValue,
  describeTune,
  mountFieldSliders,
} from '../.test-build/fieldTune.mjs';
import { PRESETS, PARAM_LIMITS } from '../.test-build/grayScott.mjs';

/** Minimal range-input fake: stores value/min/max/step, fires input on demand. */
function fakeSlider() {
  const listeners = new Set();
  return {
    value: '', min: '', max: '', step: '',
    addEventListener: (t, cb) => t === 'input' && listeners.add(cb),
    removeEventListener: (t, cb) => t === 'input' && listeners.delete(cb),
    move(v) { this.value = String(v); for (const cb of [...listeners]) cb(); },
    listenerCount: () => listeners.size,
  };
}

test('TUNE_RANGE sits inside PARAM_LIMITS and covers every preset', () => {
  for (const knob of ['feed', 'kill']) {
    const [lo, hi] = TUNE_RANGE[knob];
    const [plo, phi] = PARAM_LIMITS[knob];
    assert.ok(plo <= lo && lo < hi && hi <= phi, `${knob} range within kernel limits`);
    for (const [id, p] of Object.entries(PRESETS)) {
      assert.ok(p[knob] >= lo && p[knob] <= hi, `${id}.${knob}=${p[knob]} reachable`);
    }
  }
  assert.equal(TUNE_STEP, 0.0001);
});

test('parseTuneValue: snaps to 4 decimals and clamps to the slider range', () => {
  assert.equal(parseTuneValue('feed', '0.0367'), 0.0367);
  assert.equal(parseTuneValue('feed', '0.03674'), 0.0367);
  assert.equal(parseTuneValue('kill', 0.06096), 0.061);
  assert.equal(parseTuneValue('feed', '5'), TUNE_RANGE.feed[1]);
  assert.equal(parseTuneValue('kill', '-1'), TUNE_RANGE.kill[0]);
  // every preset survives a round trip unchanged
  for (const p of Object.values(PRESETS)) {
    assert.equal(parseTuneValue('feed', formatTuneValue('feed', p.feed)), p.feed);
    assert.equal(parseTuneValue('kill', formatTuneValue('kill', p.kill)), p.kill);
  }
});

test('parseTuneValue: junk is null, never a number for the kernel', () => {
  for (const bad of ['', '   ', 'abc', 'NaN', '1e999', NaN, Infinity, null, undefined, {}, [], '0'.repeat(40)]) {
    assert.equal(parseTuneValue('feed', bad), null, `rejects ${String(bad)}`);
  }
});

test('describeTune: preset name, (tuned) marker, fixed-point numbers, NaN-safe', () => {
  assert.equal(
    describeTune('Coral', { feed: 0.056, kill: 0.062 }),
    'Field: Coral (tuned) · feed 0.0560 · kill 0.0620',
  );
  assert.equal(describeTune('', { feed: NaN, kill: 0.05 }), 'Field: Field (tuned) · feed — · kill 0.0500');
});

test('mountFieldSliders: sets bounds, positions at initial, applies partial patches', () => {
  const feed = fakeSlider();
  const kill = fakeSlider();
  const calls = [];
  mountFieldSliders({ feed, kill }, {
    initial: { feed: 0.0545, kill: 0.062 },
    apply: (patch, knob) => calls.push([knob, patch]),
  });
  assert.deepEqual([feed.min, feed.max, feed.step], ['0.0100', '0.0900', '0.0001']);
  assert.deepEqual([kill.min, kill.max], ['0.0450', '0.0700']);
  assert.equal(feed.value, '0.0545');
  assert.equal(kill.value, '0.0620');
  assert.equal(calls.length, 0, 'mounting does not touch the kernel');

  feed.move('0.05603');
  kill.move('0.0611');
  assert.deepEqual(calls, [['feed', { feed: 0.056 }], ['kill', { kill: 0.0611 }]]);
  assert.equal(feed.value, '0.0560', 'slider shows the snapped value');
});

test('mountFieldSliders: junk input and a throwing apply both revert the slider', () => {
  const feed = fakeSlider();
  const kill = fakeSlider();
  let fail = false;
  const calls = [];
  mountFieldSliders({ feed, kill }, {
    initial: { feed: 0.0367, kill: 0.0649 },
    apply: (patch) => {
      if (fail) throw new Error('kernel said no');
      calls.push(patch);
    },
  });
  feed.move('abc');
  assert.equal(feed.value, '0.0367');
  assert.equal(calls.length, 0);
  fail = true;
  kill.move('0.0600');
  assert.equal(kill.value, '0.0649', 'reverts to the last accepted value');
  fail = false;
  kill.move('0.0600');
  assert.deepEqual(calls, [{ kill: 0.06 }]);
});

test('mountFieldSliders: sync() follows a preset change; unmount removes listeners', () => {
  const feed = fakeSlider();
  const kill = fakeSlider();
  let n = 0;
  const s = mountFieldSliders({ feed, kill }, { initial: PRESETS.mitosis, apply: () => n++ });
  s.sync(PRESETS.uskate);
  assert.equal(feed.value, '0.0620');
  assert.equal(kill.value, '0.0609');
  assert.equal(n, 0, 'sync never calls apply (the preset already did)');
  s.unmount();
  assert.equal(feed.listenerCount() + kill.listenerCount(), 0);
  feed.move('0.02');
  assert.equal(n, 0);
});
