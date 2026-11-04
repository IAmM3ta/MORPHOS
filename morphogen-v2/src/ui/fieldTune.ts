/**
 * Field panel feed / kill sliders (added 2026-11-04).
 *
 * The Field button only jumps between the 10 fixed presets. Performers asked
 * for the in-between regimes too (e.g. Coral drifting toward Worms), so two
 * range inputs now fine-tune the two Gray–Scott knobs that decide the pattern
 * family: `feed` (F) and `kill` (k). Diffusion (du / dv) stays on the preset
 * because nudging it mostly changes scale, and a careless du can approach the
 * dt stability bound (see maxStableDt in sim/grayScott.ts).
 *
 * Rules this module enforces, all covered by tests/fieldTune.test.mjs:
 *   - Slider bounds come from a curated sub-range of PARAM_LIMITS
 *     (TUNE_RANGE), so a slider can never offer a value sanitizeParams would
 *     clamp away, and the whole travel stays in the "something happens" band
 *     of the F/k map instead of mostly dead (all-U or all-V) space.
 *   - Raw input strings are parsed, snapped to TUNE_STEP and clamped; junk
 *     (NaN, "", "1e999") returns null and is ignored, never sent to the kernel.
 *   - Every accepted change is a partial update ({feed} or {kill}) through the
 *     caller's apply (main.ts → sim.setParams), so sanitizeParams still guards
 *     the kernel and du / dv are left alone.
 *   - Picking a preset (button, ] / [, or a TD `preset` command) snaps both
 *     sliders back to that preset's values via `sync()`, so the sliders never
 *     show numbers the kernel isn't running.
 *
 * DOM access is limited to a tiny SliderLike interface (value / min / max /
 * step + input listeners), so the tests run under node with plain objects.
 */
import { PARAM_LIMITS, type RdParams } from '../sim/grayScott';

export type TuneKnob = 'feed' | 'kill';

/** Slider granularity. 4 decimals matches the preset table (0.0367, 0.0609 …). */
export const TUNE_STEP = 0.0001;

/**
 * Slider travel per knob. Covers every preset (feed 0.018–0.062,
 * kill 0.051–0.0653) with margin; must sit inside PARAM_LIMITS (tests check).
 */
export const TUNE_RANGE: Record<TuneKnob, readonly [number, number]> = {
  feed: [0.01, 0.09],
  kill: [0.045, 0.07],
};

/** Round to the 4-decimal step without float fuzz (0.0367000001 → 0.0367). */
function snap(x: number): number {
  return Math.round(x / TUNE_STEP) / Math.round(1 / TUNE_STEP);
}

/**
 * Parse one slider value. Returns the snapped, clamped number, or null for
 * anything that isn't a finite number (so the caller can just ignore it).
 */
export function parseTuneValue(knob: TuneKnob, raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  if (typeof raw === 'string' && (raw.trim() === '' || raw.length > 32)) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const [lo, hi] = TUNE_RANGE[knob];
  const [plo, phi] = PARAM_LIMITS[knob];
  // Clamp to the slider range, then (belt and braces) to the kernel limits.
  return Math.min(phi, Math.max(plo, snap(Math.min(hi, Math.max(lo, n)))));
}

/** Slider position string for a kernel value (clamped to the slider range). */
export function formatTuneValue(knob: TuneKnob, value: number): string {
  const v = parseTuneValue(knob, value);
  return (v ?? TUNE_RANGE[knob][0]).toFixed(4);
}

/**
 * Status-line text while tuned, e.g. "Field: Coral (tuned) · feed 0.0560 · kill 0.0620".
 * `presetName` is the preset the tuning started from.
 */
export function describeTune(presetName: string, p: Pick<RdParams, 'feed' | 'kill'>): string {
  const name = typeof presetName === 'string' && presetName ? presetName.slice(0, 32) : 'Field';
  const f = Number.isFinite(p.feed) ? p.feed.toFixed(4) : '—';
  const k = Number.isFinite(p.kill) ? p.kill.toFixed(4) : '—';
  return `Field: ${name} (tuned) · feed ${f} · kill ${k}`;
}

/** The slice of HTMLInputElement the sliders need (plain objects in tests). */
export type SliderLike = {
  value: string;
  min: string;
  max: string;
  step: string;
  addEventListener(type: 'input', cb: () => void): void;
  removeEventListener(type: 'input', cb: () => void): void;
};

export type FieldSliders = {
  /** Move both sliders to the kernel's current feed / kill (call after a preset change). */
  sync(p: Pick<RdParams, 'feed' | 'kill'>): void;
  /** Remove listeners. */
  unmount(): void;
};

/**
 * Wire the two range inputs. Sets min / max / step from TUNE_RANGE, positions
 * them at `initial`, and on each `input` event calls `apply({feed})` or
 * `apply({kill})` with the parsed value. Junk values are ignored and the slider
 * is put back; if `apply` throws, the slider also snaps back to the last value
 * that was accepted, so the UI never claims a value the kernel refused.
 */
export function mountFieldSliders(
  els: Record<TuneKnob, SliderLike>,
  opts: {
    initial: Pick<RdParams, 'feed' | 'kill'>;
    apply: (patch: Partial<Pick<RdParams, 'feed' | 'kill'>>, knob: TuneKnob) => void;
  },
): FieldSliders {
  const last: Record<TuneKnob, string> = { feed: '', kill: '' };
  const knobs: TuneKnob[] = ['feed', 'kill'];
  const put = (knob: TuneKnob, value: number) => {
    last[knob] = formatTuneValue(knob, value);
    els[knob].value = last[knob];
  };
  const handlers = {} as Record<TuneKnob, () => void>;
  for (const knob of knobs) {
    const el = els[knob];
    el.min = TUNE_RANGE[knob][0].toFixed(4);
    el.max = TUNE_RANGE[knob][1].toFixed(4);
    el.step = TUNE_STEP.toFixed(4);
    put(knob, opts.initial[knob]);
    handlers[knob] = () => {
      const v = parseTuneValue(knob, el.value);
      if (v == null) {
        el.value = last[knob];
        return;
      }
      try {
        opts.apply(knob === 'feed' ? { feed: v } : { kill: v }, knob);
        put(knob, v);
      } catch {
        el.value = last[knob];
      }
    };
    el.addEventListener('input', handlers[knob]);
  }
  return {
    sync: (p) => {
      for (const knob of knobs) put(knob, p[knob]);
    },
    unmount: () => {
      for (const knob of knobs) els[knob].removeEventListener('input', handlers[knob]);
    },
  };
}
