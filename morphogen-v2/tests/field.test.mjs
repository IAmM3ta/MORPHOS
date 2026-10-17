// Morphogen v2 Field preset tests (node:test, no browser) — 2026-10-17.
// Run: npm test   (esbuild bundles ui/field.ts → .test-build/, then node --test)
// Covers preset order / wrap, id narrowing, sanitised params, status text,
// ?preset= parsing and the cycler's apply-then-commit behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESET_ORDER,
  DEFAULT_PRESET,
  isPresetId,
  nextPresetId,
  presetParams,
  describePreset,
  presetFromQuery,
  createPresetCycler,
} from '../.test-build/field.mjs';
import { PRESETS, PARAM_LIMITS } from '../.test-build/grayScott.mjs';

test('PRESET_ORDER lists every kernel preset exactly once, Mitosis first', () => {
  assert.equal(PRESET_ORDER.length, 10, 'REBUILD-SPEC parity: 10 presets');
  assert.deepEqual([...PRESET_ORDER].sort(), Object.keys(PRESETS).sort());
  assert.equal(new Set(PRESET_ORDER).size, PRESET_ORDER.length);
  assert.equal(PRESET_ORDER[0], 'mitosis');
  assert.equal(DEFAULT_PRESET, 'mitosis');
});

test('isPresetId: known ids only, no prototype keys', () => {
  assert.ok(isPresetId('coral'));
  for (const bad of ['Coral', 'toString', '__proto__', 'constructor', '', null, undefined, 3, {}]) {
    assert.equal(isPresetId(bad), false, `rejects ${String(bad)}`);
  }
});

test('nextPresetId: steps and wraps both ways; junk dir reads as forward', () => {
  assert.equal(nextPresetId('mitosis'), 'solitons');
  assert.equal(nextPresetId('uskate'), 'mitosis', 'wraps forward');
  assert.equal(nextPresetId('mitosis', -1), 'uskate', 'wraps back');
  assert.equal(nextPresetId('coral', -5), 'worms', 'any negative = one step back');
  assert.equal(nextPresetId('coral', 0), 'uskate');
  assert.equal(nextPresetId('coral', NaN), 'uskate');
  assert.equal(nextPresetId('nope'), 'mitosis', 'unknown → first');
  assert.equal(nextPresetId(undefined, -1), 'uskate', 'unknown backwards → last');
  // A full lap forward visits every preset once and returns home.
  let id = 'mitosis';
  const seen = [];
  for (let i = 0; i < PRESET_ORDER.length; i++) seen.push((id = nextPresetId(id)));
  assert.equal(id, 'mitosis');
  assert.equal(new Set(seen).size, PRESET_ORDER.length);
});

test('presetParams: exact table values, no name field, always in limits', () => {
  assert.deepEqual(presetParams('coral'), { feed: 0.0545, kill: 0.062, du: 0.16, dv: 0.08 });
  for (const id of PRESET_ORDER) {
    const p = presetParams(id);
    assert.deepEqual(Object.keys(p).sort(), ['du', 'dv', 'feed', 'kill']);
    for (const [k, [lo, hi]] of Object.entries(PARAM_LIMITS)) {
      assert.ok(Number.isFinite(p[k]) && p[k] >= lo && p[k] <= hi, `${id}.${k} in limits`);
    }
  }
  assert.deepEqual(presetParams('bogus'), presetParams('mitosis'), 'unknown → Mitosis');
  const a = presetParams('mitosis');
  a.feed = 99;
  assert.notEqual(presetParams('mitosis').feed, 99, 'returns a fresh object each call');
});

test('describePreset: name, position and fixed-point feed / kill', () => {
  assert.equal(describePreset('coral'), 'Field: Coral (9/10) · feed 0.0545 · kill 0.0620');
  assert.equal(describePreset('mitosis'), 'Field: Mitosis (1/10) · feed 0.0367 · kill 0.0649');
  assert.equal(describePreset('uskate'), 'Field: Skate (10/10) · feed 0.0620 · kill 0.0609');
  assert.equal(describePreset(42), describePreset('mitosis'), 'junk → default');
});

test('presetFromQuery: trimmed, case-insensitive, junk ignored', () => {
  assert.equal(presetFromQuery('?preset=coral'), 'coral');
  assert.equal(presetFromQuery('?perform=1&preset=%20Mazes%20'), 'mazes');
  assert.equal(presetFromQuery('preset=WORMS'), 'worms', 'leading ? optional');
  assert.equal(presetFromQuery(''), null);
  assert.equal(presetFromQuery('?preset='), null);
  assert.equal(presetFromQuery('?preset=toString'), null);
  assert.equal(presetFromQuery('?preset=' + 'a'.repeat(40)), null, 'over-long value');
});

test('createPresetCycler: applies initial, cycles, ignores junk set, survives a throwing apply', () => {
  const calls = [];
  const c = createPresetCycler({ initial: 'mazes', apply: (p, id) => calls.push([id, p.feed]) });
  assert.equal(c.current(), 'mazes');
  assert.deepEqual(calls, [['mazes', 0.029]], 'initial preset applied at construction');
  assert.equal(c.next(), 'fingerprint');
  assert.equal(c.next(-1), 'mazes');
  assert.equal(c.set('coral'), 'coral');
  assert.equal(c.set('nope'), 'coral', 'unknown id ignored');
  assert.equal(calls.length, 4, 'junk set never calls apply');

  const d = createPresetCycler({ initial: 'garbage', apply: () => {} });
  assert.equal(d.current(), DEFAULT_PRESET, 'bad initial → Mitosis');

  let fail = false;
  const e = createPresetCycler({
    apply: () => {
      if (fail) throw new Error('kernel busy');
    },
  });
  fail = true;
  assert.equal(e.next(), 'mitosis', 'failed apply keeps the previous preset');
  assert.equal(e.set('coral'), 'mitosis');
  fail = false;
  assert.equal(e.next(), 'solitons', 'recovers once apply works again');
});
