/**
 * HUD read-out for the field (2026-10-16). The footer line under the canvas
 * shows the Gray–Scott energy, mean V and the locked-loop count.
 *
 * Before this module `main.ts` rebuilt the string inline on every frame:
 *  - `toFixed(3)` on a NaN / Infinity stat printed "NaN" / "Infinity", and a
 *    tiny negative value printed "-0.000", so the HUD flickered between signs;
 *  - `textContent` was assigned 60–240 times a second even when the text had
 *    not changed, forcing a layout/paint of the footer every frame and making
 *    the numbers unreadable at high refresh rates;
 *  - a corrupt lock count (NaN, negative, fractional) was printed as-is.
 *
 * The formatting is pure (`formatStat`, `formatLockCount`, `formatHud`) so
 * tests/hud.test.mjs covers it without a DOM. `createHudWriter` is the thin
 * DOM layer: at most one write every `HUD_INTERVAL_MS`, and only when the
 * text actually changed. `invalidate()` lets an action (lock loop, reset) show
 * on the very next frame instead of waiting out the interval.
 */

/** The stats the HUD reads (a `GrayScott.stats()` result satisfies it). */
export type HudStats = { energy: number; meanV: number };

/** Minimum gap between HUD writes: 10 Hz is readable and costs ~nothing. */
export const HUD_INTERVAL_MS = 100;

/** Shown in place of a number that is NaN / ±Infinity / not a number at all. */
export const HUD_MISSING = '—';

/** Controls hint appended to every HUD line (kept in sync with keys.ts / pointer.ts). */
export const HUD_HINT = 'click/drag seed · m mute · l lock';

/**
 * Fixed-point format that never prints "NaN", "Infinity" or "-0.000".
 * `digits` is clamped to an integer in [0, 6]; a bad value falls back to 3.
 */
export function formatStat(value: unknown, digits = 3): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return HUD_MISSING;
  const d = Number.isFinite(digits) ? Math.min(6, Math.max(0, Math.trunc(digits))) : 3;
  const text = value.toFixed(d);
  // A value that rounds to zero keeps its sign in toFixed ("-0.000"); drop it.
  return Number(text) === 0 ? (0).toFixed(d) : text;
}

/** Lock count as shown: a non-negative integer; NaN / negative / non-numbers read 0. */
export function formatLockCount(count: unknown): string {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return '0';
  return String(Math.floor(count));
}

/** The full HUD line. A missing stats object reads as missing numbers, not a throw. */
export function formatHud(stats: HudStats | null | undefined, lockCount: unknown): string {
  const energy = formatStat(stats?.energy);
  const meanV = formatStat(stats?.meanV);
  return `energy ${energy} · meanV ${meanV} · loops ${formatLockCount(lockCount)} · ${HUD_HINT}`;
}

/** Minimal element surface the writer touches (real elements satisfy it; tests pass objects). */
export type TextSink = { textContent: string | null };

export type HudWriter = {
  /**
   * Offer a new frame's stats. Writes when the interval has elapsed (or after
   * `invalidate()`) and the text differs from what is shown. Returns true if
   * it wrote.
   */
  update(stats: HudStats | null | undefined, lockCount: unknown, nowMs: number): boolean;
  /** Force the next `update` to write regardless of the interval. */
  invalidate(): void;
};

/**
 * Throttled, change-only HUD writer. `nowMs` is the rAF timestamp; a non-finite
 * or backwards clock is treated as "interval elapsed" so the HUD can never
 * freeze on a bad timestamp. `intervalMs` ≤ 0 or non-finite → `HUD_INTERVAL_MS`.
 */
export function createHudWriter(el: TextSink, intervalMs = HUD_INTERVAL_MS): HudWriter {
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : HUD_INTERVAL_MS;
  let lastWriteMs = -Infinity;
  let forced = true; // first update always lands
  return {
    update(stats, lockCount, nowMs) {
      const clockOk = Number.isFinite(nowMs) && nowMs >= lastWriteMs;
      if (!forced && clockOk && nowMs - lastWriteMs < interval) return false;
      const text = formatHud(stats, lockCount);
      forced = false;
      lastWriteMs = Number.isFinite(nowMs) ? nowMs : -Infinity;
      if (el.textContent === text) return false;
      el.textContent = text;
      return true;
    },
    invalidate() {
      forced = true;
    },
  };
}
