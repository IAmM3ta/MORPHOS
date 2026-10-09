// CPU Gray–Scott kernel guards: parameter sanitising, dt stability clamp,
// NaN containment, and basic invariants (bounds, toroidal symmetry, grid16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GrayScott,
  PRESET_MITOSIS,
  PRESETS,
  PARAM_LIMITS,
  sanitizeParams,
  maxStableDt,
} from '../.test-build/grayScott.mjs';

const inUnit = (arr) => arr.every((x) => Number.isFinite(x) && x >= 0 && x <= 1);

test('every preset sits inside PARAM_LIMITS and is stable at dt = 1', () => {
  for (const [id, p] of Object.entries(PRESETS)) {
    for (const [k, [lo, hi]] of Object.entries(PARAM_LIMITS)) {
      assert.ok(p[k] >= lo && p[k] <= hi, `${id}.${k}`);
    }
    assert.ok(maxStableDt(p) >= 1, `${id} unstable at dt=1`);
  }
});

test('sanitizeParams clamps out-of-range and drops non-finite values', () => {
  const p = sanitizeParams({ feed: 5, kill: -1, du: NaN, dv: Infinity });
  assert.equal(p.feed, PARAM_LIMITS.feed[1]);
  assert.equal(p.kill, PARAM_LIMITS.kill[0]);
  assert.equal(p.du, PRESET_MITOSIS.du);
  assert.equal(p.dv, PRESET_MITOSIS.dv);
  // string from a sloppy MIDI/Sync payload is ignored, not coerced
  assert.equal(sanitizeParams({ feed: '0.05' }).feed, PRESET_MITOSIS.feed);
});

test('setParams keeps prior values for omitted / bad keys', () => {
  const g = new GrayScott(16, 16);
  g.setParams({ feed: 0.05 });
  g.setParams({ kill: NaN });
  assert.equal(g.params.feed, 0.05);
  assert.equal(g.params.kill, PRESET_MITOSIS.kill);
});

test('maxStableDt follows D·dt ≤ 1/4', () => {
  assert.equal(maxStableDt({ du: 0.25, dv: 0.1 }), 1);
  assert.equal(maxStableDt({ du: 0, dv: 0 }), Infinity);
});

test('huge dt is clamped: field stays bounded and finite', () => {
  const g = new GrayScott(48, 48);
  for (let i = 0; i < 200; i++) g.step(50);
  assert.ok(inUnit(g.u) && inUnit(g.v));
});

test('non-finite or non-positive dt is a no-op', () => {
  const g = new GrayScott(24, 24);
  const before = Float32Array.from(g.v);
  g.step(NaN);
  g.step(0);
  g.step(-1);
  assert.deepEqual(g.v, before);
});

test('a NaN cell is scrubbed instead of spreading', () => {
  const g = new GrayScott(32, 32);
  g.v[5] = NaN;
  g.u[7] = NaN;
  g.stepN(20);
  assert.ok(inUnit(g.u) && inUnit(g.v));
});

test('mitosis seed grows a pattern and stays in [0,1]', () => {
  const g = new GrayScott(64, 64);
  const v0 = g.stats().meanV;
  g.stepN(400);
  const s = g.stats();
  assert.ok(inUnit(g.u) && inUnit(g.v));
  assert.ok(s.meanV > 0 && s.meanV !== v0);
  // centred seed + toroidal Laplacian → centroid stays near the middle
  assert.ok(Math.abs(s.cx - 0.5) < 0.05 && Math.abs(s.cy - 0.5) < 0.05);
});

test('grid16 is 256 block means of V', () => {
  const g = new GrayScott(32, 32);
  g.v.fill(0.25);
  const grid = g.grid16();
  assert.equal(grid.length, 256);
  assert.ok(grid.every((x) => Math.abs(x - 0.25) < 1e-6));
});
