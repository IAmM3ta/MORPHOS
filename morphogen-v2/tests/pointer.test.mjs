// Morphogen v2 pointer seeding tests (node:test, no browser) — 2026-10-14.
// Run: npm test   (esbuild bundles pointer.ts → .test-build/, then node --test)
// Covers pointerToField, strokePoints, isPaintButton and mountPointerSeeding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STROKE_SPACING,
  STROKE_MAX_POINTS,
  pointerToField,
  strokePoints,
  isPaintButton,
  mountPointerSeeding,
} from '../.test-build/pointer.mjs';

const rect = { left: 100, top: 50, width: 200, height: 100 };

test('pointerToField: maps client coords into [0,1] and rejects bad rects / out of bounds', () => {
  assert.deepEqual(pointerToField(100, 50, rect), { nx: 0, ny: 0 });
  assert.deepEqual(pointerToField(300, 150, rect), { nx: 1, ny: 1 });
  assert.deepEqual(pointerToField(200, 100, rect), { nx: 0.5, ny: 0.5 });
  assert.equal(pointerToField(99, 100, rect), null, 'left of canvas');
  assert.equal(pointerToField(301, 100, rect), null, 'right of canvas');
  assert.equal(pointerToField(200, 49, rect), null, 'above canvas');
  assert.equal(pointerToField(200, 151, rect), null, 'below canvas');
  assert.equal(pointerToField(200, 100, null), null);
  assert.equal(pointerToField(200, 100, undefined), null);
  assert.equal(pointerToField(200, 100, { ...rect, width: 0 }), null, 'zero width → no /0');
  assert.equal(pointerToField(200, 100, { ...rect, height: -1 }), null);
  assert.equal(pointerToField(NaN, 100, rect), null);
  assert.equal(pointerToField(200, Infinity, rect), null);
  assert.equal(pointerToField(200, 100, { ...rect, left: NaN }), null);
});

test('strokePoints: first contact is just next; drag is evenly spaced incl. endpoint', () => {
  const a = { nx: 0, ny: 0 };
  const b = { nx: 0.05, ny: 0 };
  assert.deepEqual(strokePoints(null, a), [a]);
  const pts = strokePoints(a, b, 0.01);
  assert.equal(pts.length, 5);
  assert.ok(Math.abs(pts[0].nx - 0.01) < 1e-12 && pts[0].ny === 0, `first step ${JSON.stringify(pts[0])}`);
  assert.deepEqual(pts[pts.length - 1], b, 'endpoint always included');
  // tiny move still produces the endpoint once
  assert.deepEqual(strokePoints(a, { nx: 0.001, ny: 0 }, 0.01), [{ nx: 0.001, ny: 0 }]);
});

test('strokePoints: caps length and sanitises bad spacing / max', () => {
  const a = { nx: 0, ny: 0 };
  const far = { nx: 1, ny: 0 };
  assert.equal(strokePoints(a, far, 0.01, 8).length, 8);
  assert.equal(strokePoints(a, far, 0.01, STROKE_MAX_POINTS).length, STROKE_MAX_POINTS);
  assert.equal(strokePoints(a, far, NaN, 4).length, 4, 'NaN spacing → default step, still capped');
  assert.equal(strokePoints(a, far, -1, 4).length, 4);
  assert.equal(strokePoints(a, far, 0.01, 0).length, STROKE_MAX_POINTS, 'bad cap → default');
  assert.equal(strokePoints(a, far, 0.01, NaN).length, STROKE_MAX_POINTS);
  assert.equal(STROKE_SPACING, 0.01);
  assert.equal(STROKE_MAX_POINTS, 24);
});

test('isPaintButton: primary + button 0 only; missing fields count as paint', () => {
  assert.equal(isPaintButton({ button: 0, isPrimary: true }), true);
  assert.equal(isPaintButton({}), true, 'synthetic / older browsers');
  assert.equal(isPaintButton({ button: 0 }), true);
  assert.equal(isPaintButton({ button: 1 }), false, 'middle');
  assert.equal(isPaintButton({ button: 2 }), false, 'right');
  assert.equal(isPaintButton({ button: 0, isPrimary: false }), false, 'second finger');
  assert.equal(isPaintButton(null), false);
  assert.equal(isPaintButton(undefined), false);
});

test('mountPointerSeeding: seeds, interpolates, ignores other pointers, unmounts', () => {
  const listeners = new Map();
  const surface = {
    getBoundingClientRect: () => rect,
    addEventListener(t, fn) {
      listeners.set(t, fn);
    },
    removeEventListener(t) {
      listeners.delete(t);
    },
    setPointerCapture() {},
  };
  const seeds = [];
  let presses = 0;
  const unmount = mountPointerSeeding(surface, {
    onPress: () => {
      presses += 1;
    },
    onSeed: (p) => seeds.push(p),
  });
  assert.equal(listeners.size, 5);

  listeners.get('pointerdown')({ pointerId: 1, button: 0, isPrimary: true, clientX: 100, clientY: 50 });
  assert.equal(presses, 1);
  assert.deepEqual(seeds, [{ nx: 0, ny: 0 }]);

  // drag 0.05 in nx → 5 interpolated points (not including previous)
  listeners.get('pointermove')({ pointerId: 1, clientX: 110, clientY: 50 });
  assert.equal(seeds.length, 1 + 5);
  assert.deepEqual(seeds[seeds.length - 1], { nx: 0.05, ny: 0 });

  // second finger ignored while first is active
  const before = seeds.length;
  listeners.get('pointerdown')({ pointerId: 2, button: 0, isPrimary: true, clientX: 200, clientY: 100 });
  assert.equal(seeds.length, before);
  assert.equal(presses, 1);

  // right-click ignored when idle
  listeners.get('pointerup')({ pointerId: 1 });
  listeners.get('pointerdown')({ pointerId: 3, button: 2, isPrimary: true, clientX: 200, clientY: 100 });
  assert.equal(seeds.length, before);
  assert.equal(presses, 1);

  // zero-size canvas never seeds
  surface.getBoundingClientRect = () => ({ ...rect, width: 0 });
  listeners.get('pointerdown')({ pointerId: 4, button: 0, isPrimary: true, clientX: 200, clientY: 100 });
  assert.equal(presses, 2, 'onPress still fires so ENTER unlock works');
  assert.equal(seeds.length, before);

  unmount();
  assert.equal(listeners.size, 0);
});

test('mountPointerSeeding: leaving the canvas breaks the stroke; re-entry starts fresh', () => {
  const listeners = new Map();
  const surface = {
    getBoundingClientRect: () => rect,
    addEventListener(t, fn) {
      listeners.set(t, fn);
    },
    removeEventListener(t) {
      listeners.delete(t);
    },
  };
  const seeds = [];
  mountPointerSeeding(surface, { onSeed: (p) => seeds.push(p) });
  listeners.get('pointerdown')({ pointerId: 1, button: 0, clientX: 100, clientY: 50 });
  listeners.get('pointermove')({ pointerId: 1, clientX: 50, clientY: 50 }); // off canvas → clear last
  const n = seeds.length;
  listeners.get('pointermove')({ pointerId: 1, clientX: 200, clientY: 100 }); // re-enter
  assert.deepEqual(seeds.slice(n), [{ nx: 0.5, ny: 0.5 }], 're-entry is a fresh first-contact seed, not a long stroke');
});

test('mountPointerSeeding: lostpointercapture ends painting without a stuck drag', () => {
  const listeners = new Map();
  const surface = {
    getBoundingClientRect: () => rect,
    addEventListener(t, fn) {
      listeners.set(t, fn);
    },
    removeEventListener() {},
    setPointerCapture() {},
  };
  const seeds = [];
  mountPointerSeeding(surface, { onSeed: (p) => seeds.push(p) });
  listeners.get('pointerdown')({ pointerId: 7, button: 0, clientX: 100, clientY: 50 });
  listeners.get('lostpointercapture')({ pointerId: 7 });
  const n = seeds.length;
  listeners.get('pointermove')({ pointerId: 7, clientX: 200, clientY: 100 });
  assert.equal(seeds.length, n, 'move after lost capture must not paint');
});
