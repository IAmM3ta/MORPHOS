/**
 * Field panel — Gray–Scott preset cycling (REBUILD-SPEC parity: 10 presets,
 * Mitosis…Skate). Until now the Field button was a stub that only printed
 * "panel field (stub)"; it now steps through PRESETS in a fixed order and
 * pushes each preset through GrayScott.setParams (so sanitizeParams still
 * guards every value). `?preset=<id>` picks the starting preset for a
 * performance boot.
 *
 * Everything here is pure or DOM-free so tests/field.test.mjs can cover it
 * without a browser; main.ts only wires the cycler to the panel + status line.
 */
import { PRESETS, PRESET_MITOSIS, sanitizeParams, type RdParams } from '../sim/grayScott';

export type PresetId = keyof typeof PRESETS & string;

/**
 * Cycle order. Spelled out instead of Object.keys(PRESETS) so adding a preset
 * to the kernel table is a deliberate UI decision, and so the order can't
 * shift if the table is ever rebuilt. Must list every PRESETS key exactly once
 * (tests/field.test.mjs checks this).
 */
export const PRESET_ORDER: readonly PresetId[] = [
  'mitosis',
  'solitons',
  'pulsing',
  'holes',
  'mazes',
  'fingerprint',
  'spirals',
  'worms',
  'coral',
  'uskate',
];

/** Boot preset when nothing (or junk) is asked for: the v7 Mitosis default. */
export const DEFAULT_PRESET: PresetId = 'mitosis';

/** Narrow an untrusted string (query param, Sync payload, MIDI map) to a known preset id. */
export function isPresetId(x: unknown): x is PresetId {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(PRESETS, x);
}

/**
 * Next preset in PRESET_ORDER, wrapping at both ends. `dir` is +1 / -1; any
 * other value (0, NaN, 2.5) is read by sign, and 0 / NaN count as +1.
 * An unknown `current` starts from the top (forward → first, back → last).
 */
export function nextPresetId(current: unknown, dir = 1): PresetId {
  const step = Number.isFinite(dir) && dir < 0 ? -1 : 1;
  const n = PRESET_ORDER.length;
  const i = isPresetId(current) ? PRESET_ORDER.indexOf(current) : -1;
  if (i < 0) return step > 0 ? PRESET_ORDER[0] : PRESET_ORDER[n - 1];
  return PRESET_ORDER[(i + step + n) % n];
}

/**
 * Kernel params for a preset: the `name` label is stripped and the numbers
 * go through sanitizeParams, so the result is always a clean RdParams even
 * if the table is edited badly. Unknown ids fall back to Mitosis.
 */
export function presetParams(id: unknown): RdParams {
  if (!isPresetId(id)) return { ...PRESET_MITOSIS };
  const { feed, kill, du, dv } = PRESETS[id];
  return sanitizeParams({ feed, kill, du, dv });
}

/** Status-line text, e.g. "Field: Coral (9/10) · feed 0.0545 · kill 0.0620". */
export function describePreset(id: unknown): string {
  const safe: PresetId = isPresetId(id) ? id : DEFAULT_PRESET;
  const p = presetParams(safe);
  const pos = PRESET_ORDER.indexOf(safe) + 1;
  return `Field: ${PRESETS[safe].name} (${pos}/${PRESET_ORDER.length}) · feed ${p.feed.toFixed(4)} · kill ${p.kill.toFixed(4)}`;
}

/**
 * Starting preset from a query string (`?preset=coral`). Case-insensitive and
 * whitespace-trimmed; anything unknown (or an over-long value) is ignored and
 * returns null so the caller keeps its default.
 */
export function presetFromQuery(search: string): PresetId | null {
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(search).get('preset');
  } catch {
    return null;
  }
  if (raw == null || raw.length > 32) return null;
  const id = raw.trim().toLowerCase();
  return isPresetId(id) ? id : null;
}

export type PresetCycler = {
  /** Preset currently applied to the kernel. */
  current(): PresetId;
  /** Step forward (dir > 0, default) or back (dir < 0), apply it and return the new id. */
  next(dir?: number): PresetId;
  /** Jump to a preset; unknown ids are ignored and the current id is returned. */
  set(id: unknown): PresetId;
};

/**
 * Holds the active preset and calls `apply(params, id)` on every change
 * (main.ts passes sim.setParams). The initial preset is applied immediately
 * so the kernel and the UI can't disagree at boot. If `apply` throws, the
 * cycler keeps the previous id, so the label never claims a preset the
 * kernel didn't take.
 */
export function createPresetCycler(opts: {
  initial?: unknown;
  apply: (params: RdParams, id: PresetId) => void;
}): PresetCycler {
  let cur: PresetId = isPresetId(opts.initial) ? opts.initial : DEFAULT_PRESET;
  const go = (id: PresetId): PresetId => {
    opts.apply(presetParams(id), id);
    cur = id;
    return cur;
  };
  go(cur);
  return {
    current: () => cur,
    next: (dir = 1) => {
      try {
        return go(nextPresetId(cur, dir));
      } catch {
        return cur;
      }
    },
    set: (id) => {
      if (!isPresetId(id)) return cur;
      try {
        return go(id);
      } catch {
        return cur;
      }
    },
  };
}
