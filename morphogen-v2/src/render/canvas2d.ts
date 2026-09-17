/** Canvas 2D display path — putImageData only. GPU contexts forbidden. */

import type { GrayScott } from '../sim/grayScott';

/** Abyss-ish cyan palette (v7 vibe): dark → cyan colonies */
function palette(t: number, out: Uint8ClampedArray, o: number): void {
  const x = Math.min(1, Math.max(0, t));
  // lift V into cyan/teal on near-black
  const r = Math.floor(8 + x * 40);
  const g = Math.floor(12 + x * 200);
  const b = Math.floor(18 + x * 220);
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
  out[o + 3] = 255;
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
    this.image = ctx.createImageData(canvas.width, canvas.height);
  }

  resize(w: number, h: number): void {
    this.canvas.width = w;
    this.canvas.height = h;
    this.image = this.ctx.createImageData(w, h);
  }

  /** Map field V (and slight U) into ImageData and blit. */
  draw(sim: GrayScott): void {
    const { width: w, height: h, v, u } = sim;
    if (w !== this.canvas.width || h !== this.canvas.height) {
      this.resize(w, h);
    }
    const data = this.image.data;
    for (let i = 0; i < w * h; i++) {
      const t = v[i] * 0.85 + (1 - u[i]) * 0.15;
      palette(t, data, i * 4);
    }
    this.ctx.putImageData(this.image, 0, 0);
  }
}
