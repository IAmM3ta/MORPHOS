/**
 * Canvas 2D display path — putImageData only. GPU contexts forbidden.
 *
 * 2026-10-11 hardening:
 * - The palette is a precomputed 256-entry RGBA lookup table (`PALETTE_LUT`)
 *   instead of three `Math.floor` calls per pixel per frame; tone is quantised
 *   to 1/255, which is below what an 8-bit channel can show anyway.
 * - `fieldTone` is NaN-safe: a non-finite U or V maps to tone 0 (background)
 *   for that pixel only, so a bad cell can never poison a whole frame.
 * - `fieldToRGBA` is pure and DOM-free (tested headless) and refuses to read
 *   past short U/V buffers or write past a short output buffer.
 * - `resize` coerces width/height to integers ≥ 1, so a 0 / NaN / fractional
 *   size can't make `createImageData` throw mid-render.
 */

import type { GrayScott } from '../sim/grayScott';

/** Number of palette steps (one per 8-bit tone level). */
export const PALETTE_STEPS = 256;

/** Abyss-ish cyan palette (v7 vibe): near-black → cyan/teal colonies, opaque. */
function paletteRGB(x: number): [number, number, number] {
  return [Math.floor(8 + x * 40), Math.floor(12 + x * 200), Math.floor(18 + x * 220)];
}

/** RGBA lookup table, PALETTE_STEPS × 4 bytes; alpha always 255. */
export const PALETTE_LUT: Uint8ClampedArray = (() => {
  const lut = new Uint8ClampedArray(PALETTE_STEPS * 4);
  for (let i = 0; i < PALETTE_STEPS; i++) {
    const [r, g, b] = paletteRGB(i / (PALETTE_STEPS - 1));
    lut[i * 4] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = 255;
  }
  return lut;
})();

/**
 * Display tone in [0, 1] for one cell: mostly V (the colonies), lifted slightly
 * where U is depleted. Non-finite input → 0 so NaN shows as background.
 */
export function fieldTone(v: number, u: number): number {
  const t = v * 0.85 + (1 - u) * 0.15;
  if (!Number.isFinite(t)) return 0;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Minimal field shape the renderer reads (GrayScott satisfies it). */
export type FieldView = Pick<GrayScott, 'width' | 'height' | 'u' | 'v'>;

/**
 * Map a field into an RGBA byte buffer (row-major, 4 bytes per cell).
 * Writes min(width·height, |u|, |v|, |out|/4) pixels and returns that count;
 * anything past it is left untouched.
 */
export function fieldToRGBA(field: FieldView, out: Uint8ClampedArray): number {
  const { width: w, height: h, u, v } = field;
  const n = Math.max(0, Math.min(w * h, u.length, v.length, Math.floor(out.length / 4)));
  const last = PALETTE_STEPS - 1;
  for (let i = 0; i < n; i++) {
    const k = ((fieldTone(v[i], u[i]) * last + 0.5) | 0) * 4;
    const o = i * 4;
    out[o] = PALETTE_LUT[k];
    out[o + 1] = PALETTE_LUT[k + 1];
    out[o + 2] = PALETTE_LUT[k + 2];
    out[o + 3] = 255;
  }
  return n;
}

/** Coerce a requested canvas dimension to an integer ≥ 1 (NaN / ≤0 → 1). */
export function safeDim(x: number): number {
  return Number.isFinite(x) && x >= 1 ? Math.floor(x) : 1;
}

export class Canvas2DRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private image: ImageData;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D unavailable');
    this.ctx = ctx;
    this.image = ctx.createImageData(safeDim(canvas.width), safeDim(canvas.height));
  }

  resize(w: number, h: number): void {
    const sw = safeDim(w);
    const sh = safeDim(h);
    this.canvas.width = sw;
    this.canvas.height = sh;
    this.image = this.ctx.createImageData(sw, sh);
  }

  /** Map field V (and slight U) into ImageData and blit. */
  draw(sim: FieldView): void {
    const w = safeDim(sim.width);
    const h = safeDim(sim.height);
    if (w !== this.image.width || h !== this.image.height) {
      this.resize(w, h);
    }
    fieldToRGBA({ width: w, height: h, u: sim.u, v: sim.v }, this.image.data);
    this.ctx.putImageData(this.image, 0, 0);
  }
}
