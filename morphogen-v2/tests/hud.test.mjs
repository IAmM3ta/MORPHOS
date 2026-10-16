// Morphogen v2 HUD tests (node:test, no browser) — 2026-10-16.
// Run: npm test   (esbuild bundles ui/hud.ts → .test-build/, then node --test)
// Covers formatStat / formatLockCount / formatHud and the throttled writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HUD_INTERVAL_MS,
  HUD_MISSING,
  HUD_HINT,
  formatStat,
  formatLockCount,
  formatHud,
  createHudWriter,
} from '../.test-build/hud.mjs';

test('formatStat: fixed-point, never NaN / Infinity / -0', () => {
  assert.equal(formatStat(0.12345), '0.123');
  assert.equal(formatStat(1), '1.000');
  assert.equal(formatStat(-0.5), '-0.500', 'real negatives keep their sign');
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '0.5', {}]) {
    assert.equal(formatStat(bad), HUD_MISSING, `bad value ${String(bad)}`);
  }
  assert.equal(formatStat(-0), '0.000');
  assert.equal(formatStat(-0.0001), '0.000', 'rounds to zero → no minus sign');
  assert.equal(formatStat(-0.0001, 5), '-0.00010', 'not zero at 5 digits → sign kept');
});

test('formatStat: digits clamped to an integer in [0, 6]', () => {
  assert.equal(formatStat(2.4, 0), '2');
  assert.equal(formatStat(1 / 3, 99), (1 / 3).toFixed(6));
  assert.equal(formatStat(1 / 3, -4), '0');
  assert.equal(formatStat(1 / 3, 2.9), '0.33');
  assert.equal(formatStat(1 / 3, NaN), '0.333', 'bad digits → 3');
});

test('formatLockCount: non-negative integer, junk reads 0', () => {
  assert.equal(formatLockCount(0), '0');
  assert.equal(formatLockCount(3), '3');
  assert.equal(formatLockCount(2.7), '2');
  for (const bad of [NaN, -1, Infinity, undefined, '4']) assert.equal(formatLockCount(bad), '0');
});

test('formatHud: full line, missing stats do not throw', () => {
  assert.equal(
    formatHud({ energy: 0.0421, meanV: 0.25 }, 2),
    `energy 0.042 · meanV 0.250 · loops 2 · ${HUD_HINT}`,
  );
  assert.equal(formatHud(null, 0), `energy ${HUD_MISSING} · meanV ${HUD_MISSING} · loops 0 · ${HUD_HINT}`);
  assert.equal(formatHud({ energy: NaN, meanV: 0.1 }, NaN), `energy ${HUD_MISSING} · meanV 0.100 · loops 0 · ${HUD_HINT}`);
  assert.match(HUD_HINT, /m mute/);
  assert.match(HUD_HINT, /l lock/);
});

/** Fake element that counts textContent writes. */
function sink(initial = 'hint') {
  let text = initial;
  let writes = 0;
  return {
    get textContent() {
      return text;
    },
    set textContent(v) {
      text = v;
      writes++;
    },
    get writes() {
      return writes;
    },
  };
}

test('createHudWriter: first update writes, then at most once per interval', () => {
  const el = sink();
  const hud = createHudWriter(el);
  assert.equal(HUD_INTERVAL_MS, 100);
  // 1 s of 240 Hz frames with a changing stat → about 10 writes, not 240
  let wrote = 0;
  for (let i = 0; i < 240; i++) {
    if (hud.update({ energy: i / 1000, meanV: 0.2 }, 0, i * (1000 / 240))) wrote++;
  }
  assert.equal(wrote, el.writes);
  assert.ok(wrote >= 9 && wrote <= 11, `wrote ${wrote}× in 1 s`);
  assert.match(el.textContent, /^energy 0\.2\d\d · meanV 0\.200 · loops 0/);
});

test('createHudWriter: unchanged text is never rewritten', () => {
  const el = sink();
  const hud = createHudWriter(el);
  const st = { energy: 0.1, meanV: 0.2 };
  assert.equal(hud.update(st, 1, 0), true);
  for (let t = 100; t <= 2000; t += 100) assert.equal(hud.update(st, 1, t), false);
  assert.equal(el.writes, 1);
});

test('createHudWriter: invalidate() bypasses the interval once', () => {
  const el = sink();
  const hud = createHudWriter(el);
  hud.update({ energy: 0.1, meanV: 0.2 }, 0, 1000);
  assert.equal(hud.update({ energy: 0.1, meanV: 0.2 }, 1, 1010), false, 'inside interval');
  hud.invalidate();
  assert.equal(hud.update({ energy: 0.1, meanV: 0.2 }, 1, 1020), true, 'lock count shows at once');
  assert.match(el.textContent, /loops 1/);
  assert.equal(hud.update({ energy: 0.1, meanV: 0.2 }, 2, 1030), false, 'one-shot');
});

test('createHudWriter: bad clocks and bad intervals never freeze the HUD', () => {
  const el = sink();
  const hud = createHudWriter(el);
  hud.update({ energy: 0.1, meanV: 0.2 }, 0, 5000);
  assert.equal(hud.update({ energy: 0.3, meanV: 0.2 }, 0, 10), true, 'backwards clock writes');
  assert.equal(hud.update({ energy: 0.4, meanV: 0.2 }, 0, NaN), true, 'NaN clock writes');
  assert.equal(hud.update({ energy: 0.5, meanV: 0.2 }, 0, NaN), true);
  for (const bad of [0, -5, NaN, Infinity]) {
    const e = sink();
    const h = createHudWriter(e, bad);
    h.update({ energy: 0.1, meanV: 0 }, 0, 0);
    assert.equal(h.update({ energy: 0.2, meanV: 0 }, 0, 50), false, `interval ${bad} → default`);
    assert.equal(h.update({ energy: 0.2, meanV: 0 }, 0, 100), true);
  }
});
