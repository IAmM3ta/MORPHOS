// Canvas 2D renderer: palette LUT, NaN-safe tone, bounded RGBA fill, safe resize.
// Run: npm test   (esbuild bundles canvas2d.ts → .test-build/, then node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PALETTE_LUT,
  PALETTE_STEPS,
  fieldTone,
  fieldToRGBA,
  safeDim,
  Canvas2DRenderer,
} from '../.test-build/canvas2d.mjs';

function fakeCanvas(w, h, { no2d = false } = {}) {
  const calls = { create: [], put: 0, ctxArgs: null };
  const ctx = {
    createImageData(cw, ch) {
      if (!(Number.isInteger(cw) && cw > 0 && Number.isInteger(ch) && ch > 0)) throw new RangeError('bad size');
      calls.create.push([cw, ch]);
      return { width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) };
    },
    putImageData() { calls.put++; },
  };
  const canvas = {
    width: w,
    height: h,
    getContext(kind, opts) { calls.ctxArgs = [kind, opts]; return no2d ? null : ctx; },
  };
  return { canvas, calls };
}

test('PALETTE_LUT: 256 opaque entries, dark → cyan, monotone per channel', () => {
  assert.equal(PALETTE_LUT.length, PALETTE_STEPS * 4);
  assert.deepEqual([...PALETTE_LUT.slice(0, 4)], [8, 12, 18, 255]);
  assert.deepEqual([...PALETTE_LUT.slice(-4)], [48, 212, 238, 255]);
  for (let i = 1; i < PALETTE_STEPS; i++) {
    for (let c = 0; c < 3; c++) assert.ok(PALETTE_LUT[i * 4 + c] >= PALETTE_LUT[(i - 1) * 4 + c]);
    assert.equal(PALETTE_LUT[i * 4 + 3], 255);
  }
});

test('fieldTone clamps to [0,1] and maps non-finite input to 0', () => {
  assert.equal(fieldTone(0, 1), 0);
  assert.equal(fieldTone(1, 0), 1);
  assert.equal(fieldTone(5, -5), 1);
  assert.equal(fieldTone(-5, 5), 0);
  assert.equal(fieldTone(NaN, 0.5), 0);
  assert.equal(fieldTone(0.5, Infinity), 0);
});

test('fieldToRGBA: NaN cell shows as background without touching neighbours', () => {
  const u = new Float32Array([1, 0, NaN, 1]);
  const v = new Float32Array([0, 1, 0.5, 0]);
  const out = new Uint8ClampedArray(16);
  assert.equal(fieldToRGBA({ width: 2, height: 2, u, v }, out), 4);
  assert.deepEqual([...out.slice(0, 4)], [8, 12, 18, 255]);
  assert.deepEqual([...out.slice(4, 8)], [48, 212, 238, 255]);
  assert.deepEqual([...out.slice(8, 12)], [8, 12, 18, 255]);
});

test('fieldToRGBA never reads/writes past short buffers', () => {
  const field = { width: 4, height: 4, u: new Float32Array(16).fill(0), v: new Float32Array(3).fill(1) };
  const out = new Uint8ClampedArray(64).fill(7);
  assert.equal(fieldToRGBA(field, out), 3);
  assert.equal(out[12], 7, 'pixel 3 left untouched');
  const tiny = new Uint8ClampedArray(6);
  assert.equal(fieldToRGBA({ width: 2, height: 1, u: new Float32Array(2), v: new Float32Array(2) }, tiny), 1);
});

test('safeDim coerces 0 / negative / NaN / fractional sizes', () => {
  assert.equal(safeDim(0), 1);
  assert.equal(safeDim(-3), 1);
  assert.equal(safeDim(NaN), 1);
  assert.equal(safeDim(Infinity), 1);
  assert.equal(safeDim(128.9), 128);
});

test('renderer asks for an opaque 2d context and throws if unavailable', () => {
  const { canvas, calls } = fakeCanvas(4, 4);
  new Canvas2DRenderer(canvas);
  assert.deepEqual(calls.ctxArgs, ['2d', { alpha: false }]);
  assert.throws(() => new Canvas2DRenderer(fakeCanvas(4, 4, { no2d: true }).canvas), /Canvas 2D unavailable/);
});

test('renderer survives a 0×0 canvas and resizes once to the field', () => {
  const { canvas, calls } = fakeCanvas(0, 0);
  const r = new Canvas2DRenderer(canvas);
  const field = { width: 3, height: 2, u: new Float32Array(6).fill(1), v: new Float32Array(6) };
  r.draw(field);
  r.draw(field);
  assert.deepEqual(calls.create, [[1, 1], [3, 2]]);
  assert.equal(canvas.width, 3);
  assert.equal(canvas.height, 2);
  assert.equal(calls.put, 2);
});
