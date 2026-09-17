/** Portable CPU Gray–Scott reaction–diffusion kernel (no GPU). */

export type RdParams = {
  feed: number;
  kill: number;
  du: number;
  dv: number;
};

export type FieldStats = {
  meanU: number;
  meanV: number;
  energy: number;
  cx: number;
  cy: number;
  edge: number;
};

/** v7 Mitosis default */
export const PRESET_MITOSIS: RdParams = {
  feed: 0.0367,
  kill: 0.0649,
  du: 0.16,
  dv: 0.08,
};

export const PRESETS: Record<string, RdParams & { name: string }> = {
  mitosis: { name: 'Mitosis', ...PRESET_MITOSIS },
  solitons: { name: 'Solitons', feed: 0.0353, kill: 0.0653, du: 0.16, dv: 0.08 },
  pulsing: { name: 'Pulsing', feed: 0.025, kill: 0.06, du: 0.14, dv: 0.07 },
  holes: { name: 'Holes', feed: 0.039, kill: 0.058, du: 0.16, dv: 0.08 },
  mazes: { name: 'Mazes', feed: 0.029, kill: 0.057, du: 0.16, dv: 0.08 },
  fingerprint: { name: 'Fingerprint', feed: 0.026, kill: 0.061, du: 0.16, dv: 0.08 },
  spirals: { name: 'Spirals', feed: 0.018, kill: 0.051, du: 0.16, dv: 0.08 },
  worms: { name: 'Worms', feed: 0.046, kill: 0.063, du: 0.16, dv: 0.08 },
  coral: { name: 'Coral', feed: 0.0545, kill: 0.062, du: 0.16, dv: 0.08 },
  uskate: { name: 'Skate', feed: 0.062, kill: 0.0609, du: 0.16, dv: 0.08 },
};

export class GrayScott {
  readonly width: number;
  readonly height: number;
  u: Float32Array;
  v: Float32Array;
  private u2: Float32Array;
  private v2: Float32Array;
  params: RdParams;

  constructor(width: number, height: number, params: RdParams = PRESET_MITOSIS) {
    this.width = width;
    this.height = height;
    const n = width * height;
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.u2 = new Float32Array(n);
    this.v2 = new Float32Array(n);
    this.params = { ...params };
    this.reset();
  }

  reset(): void {
    this.u.fill(1);
    this.v.fill(0);
    // small central seed so field isn't empty
    this.seed(0.5, 0.5, 0.04, 1);
  }

  /** Seed V (and depress U) in a disk. nx,ny in 0..1 */
  seed(nx: number, ny: number, radius = 0.05, strength = 1): void {
    const { width: w, height: h } = this;
    const cx = nx * w;
    const cy = ny * h;
    const r = radius * Math.min(w, h);
    const r2 = r * r;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r2) {
          const t = 1 - d2 / r2;
          const i = y * w + x;
          const s = strength * t * t;
          this.v[i] = Math.min(1, this.v[i] + s);
          this.u[i] = Math.max(0, this.u[i] - s * 0.5);
        }
      }
    }
  }

  step(dt = 1): void {
    const { width: w, height: h, params } = this;
    const { feed: f, kill: k, du, dv } = params;
    const u = this.u;
    const v = this.v;
    const uN = this.u2;
    const vN = this.v2;

    for (let y = 0; y < h; y++) {
      const ym = (y - 1 + h) % h;
      const yp = (y + 1) % h;
      for (let x = 0; x < w; x++) {
        const xm = (x - 1 + w) % w;
        const xp = (x + 1) % w;
        const i = y * w + x;
        const uc = u[i];
        const vc = v[i];
        const lapU =
          u[ym * w + x] + u[yp * w + x] + u[y * w + xm] + u[y * w + xp] - 4 * uc;
        const lapV =
          v[ym * w + x] + v[yp * w + x] + v[y * w + xm] + v[y * w + xp] - 4 * vc;
        const uvv = uc * vc * vc;
        uN[i] = uc + (du * lapU - uvv + f * (1 - uc)) * dt;
        vN[i] = vc + (dv * lapV + uvv - (k + f) * vc) * dt;
      }
    }

    // clamp + swap
    for (let i = 0; i < u.length; i++) {
      u[i] = Math.min(1, Math.max(0, uN[i]));
      v[i] = Math.min(1, Math.max(0, vN[i]));
    }
  }

  stepN(n: number, dt = 1): void {
    for (let i = 0; i < n; i++) this.step(dt);
  }

  stats(): FieldStats {
    const { width: w, height: h, u, v } = this;
    let sumU = 0;
    let sumV = 0;
    let energy = 0;
    let mx = 0;
    let my = 0;
    let mass = 0;
    let edge = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const vv = v[i];
        sumU += u[i];
        sumV += vv;
        energy += vv * vv;
        mass += vv;
        mx += x * vv;
        my += y * vv;
      }
    }
    const n = w * h;
    // crude edge: V gradient magnitude mean
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const gx = v[y * w + x + 1] - v[y * w + x - 1];
        const gy = v[(y + 1) * w + x] - v[(y - 1) * w + x];
        edge += Math.hypot(gx, gy);
      }
    }
    edge /= Math.max(1, (w - 2) * (h - 2));
    return {
      meanU: sumU / n,
      meanV: sumV / n,
      energy: energy / n,
      cx: mass > 1e-6 ? mx / mass / w : 0.5,
      cy: mass > 1e-6 ? my / mass / h : 0.5,
      edge,
    };
  }

  /** 16×16 V grid for Sync (256 floats). */
  grid16(): Float32Array {
    const out = new Float32Array(256);
    const { width: w, height: h, v } = this;
    const bw = w / 16;
    const bh = h / 16;
    for (let gy = 0; gy < 16; gy++) {
      for (let gx = 0; gx < 16; gx++) {
        let s = 0;
        let c = 0;
        const x0 = Math.floor(gx * bw);
        const x1 = Math.floor((gx + 1) * bw);
        const y0 = Math.floor(gy * bh);
        const y1 = Math.floor((gy + 1) * bh);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            s += v[y * w + x];
            c++;
          }
        }
        out[gy * 16 + gx] = c ? s / c : 0;
      }
    }
    return out;
  }
}
