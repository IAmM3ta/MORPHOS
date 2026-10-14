/**
 * Pointer seeding for the field canvas (2026-10-14). Click / drag on the canvas
 * drops V into the Gray–Scott field via `sim.seed(nx, ny, …)`.
 *
 * Before this module `main.ts` did the maths inline, which had three gaps:
 *  - a zero-size canvas rect (collapsed layout, hidden parent) divided by 0 and
 *    the resulting NaN slipped past the `< 0 || > 1` bounds check into `seed()`;
 *  - a fast drag only seeded where `pointermove` happened to fire, leaving a
 *    dotted trail instead of a stroke;
 *  - a second finger, a pen barrel button or a right-click also painted, and a
 *    lost pointer capture (alt-tab mid-drag) could leave painting stuck on.
 *
 * The decisions are pure (`pointerToField`, `strokePoints`, `isPaintButton`) so
 * tests/pointer.test.mjs covers them without a DOM; `mountPointerSeeding` is the
 * thin listener layer and follows exactly one pointer at a time.
 */

/** Normalised field coordinate, both axes in [0, 1]. */
export type FieldPoint = { nx: number; ny: number };

/** The parts of a DOMRect we read (real rects satisfy it; tests pass plain objects). */
export type RectLike = { left: number; top: number; width: number; height: number };

/** Gap between interpolated seeds along a drag, in normalised field units (~2.5 cells at 256²). */
export const STROKE_SPACING = 0.01;

/** Hard cap on seeds per pointermove so one huge jump can't stall a frame (each seed is O(w·h)). */
export const STROKE_MAX_POINTS = 24;

/**
 * Map a client-space pointer position onto the field. Returns null when the
 * rect has no usable size, any input is non-finite, or the point is outside
 * the canvas (edges included as inside).
 */
export function pointerToField(clientX: number, clientY: number, rect: RectLike | null | undefined): FieldPoint | null {
  if (!rect) return null;
  const { left, top, width, height } = rect;
  if (![clientX, clientY, left, top, width, height].every(Number.isFinite)) return null;
  if (width <= 0 || height <= 0) return null;
  const nx = (clientX - left) / width;
  const ny = (clientY - top) / height;
  if (nx < 0 || ny < 0 || nx > 1 || ny > 1) return null;
  return { nx, ny };
}

/**
 * Seeds to drop when the pointer moves from `prev` to `next`: evenly spaced
 * points after `prev` up to and including `next`, at most `maxPoints`. With no
 * `prev` (first contact) it is just `[next]`. Non-finite or non-positive
 * spacing falls back to {@link STROKE_SPACING}; a bad cap falls back to
 * {@link STROKE_MAX_POINTS}.
 */
export function strokePoints(
  prev: FieldPoint | null,
  next: FieldPoint,
  spacing = STROKE_SPACING,
  maxPoints = STROKE_MAX_POINTS,
): FieldPoint[] {
  if (!prev) return [next];
  const step = Number.isFinite(spacing) && spacing > 0 ? spacing : STROKE_SPACING;
  const cap = Number.isFinite(maxPoints) && maxPoints >= 1 ? Math.floor(maxPoints) : STROKE_MAX_POINTS;
  const dx = next.nx - prev.nx;
  const dy = next.ny - prev.ny;
  const dist = Math.hypot(dx, dy);
  const n = Math.min(cap, Math.max(1, Math.ceil(dist / step)));
  const out: FieldPoint[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    out.push({ nx: prev.nx + dx * t, ny: prev.ny + dy * t });
  }
  return out;
}

/** Minimal pointer event shape used here. */
export type PointerLike = {
  pointerId?: number;
  button?: number;
  isPrimary?: boolean;
  clientX?: number;
  clientY?: number;
};

/**
 * Only the primary pointer's main button paints: left mouse button, first
 * finger, pen tip. Missing fields count as primary / button 0 so synthetic
 * events from older browsers still work.
 */
export function isPaintButton(ev: PointerLike | null | undefined): boolean {
  if (!ev) return false;
  if (ev.isPrimary === false) return false;
  return ev.button === undefined || ev.button === 0;
}

/** Element surface `mountPointerSeeding` needs (an HTMLCanvasElement, or a test stub). */
export type PointerSurface = {
  getBoundingClientRect(): RectLike;
  addEventListener(type: string, fn: (ev: Event) => void): void;
  removeEventListener(type: string, fn: (ev: Event) => void): void;
  setPointerCapture?(id: number): void;
};

export type PointerSeedHandlers = {
  /** Called once per seed point, in stroke order. */
  onSeed: (p: FieldPoint) => void;
  /** Called on every accepted pointerdown, before the first seed (main.ts uses it to start the sim). */
  onPress?: () => void;
};

/**
 * Wire click-and-drag seeding on `surface`. Tracks a single active pointer;
 * other pointers are ignored until it lifts. Painting ends on pointerup,
 * pointercancel or lostpointercapture. Returns an unmount function.
 */
export function mountPointerSeeding(surface: PointerSurface, handlers: PointerSeedHandlers): () => void {
  let active: number | null = null;
  let last: FieldPoint | null = null;

  const at = (ev: PointerLike) =>
    pointerToField(Number(ev.clientX), Number(ev.clientY), surface.getBoundingClientRect());

  const end = (ev: Event) => {
    const pe = ev as unknown as PointerLike;
    if (active === null || (pe.pointerId !== undefined && pe.pointerId !== active)) return;
    active = null;
    last = null;
  };

  const down = (ev: Event) => {
    const pe = ev as unknown as PointerLike;
    if (active !== null || !isPaintButton(pe)) return;
    active = pe.pointerId ?? 0;
    try {
      surface.setPointerCapture?.(active);
    } catch {
      // capture can throw for an already-released pointer; painting still works without it
    }
    handlers.onPress?.();
    const p = at(pe);
    last = p;
    if (p) handlers.onSeed(p);
  };

  const move = (ev: Event) => {
    const pe = ev as unknown as PointerLike;
    if (active === null || (pe.pointerId ?? 0) !== active) return;
    const p = at(pe);
    if (!p) {
      last = null; // left the canvas: the next in-bounds point starts a fresh stroke
      return;
    }
    for (const q of strokePoints(last, p)) handlers.onSeed(q);
    last = p;
  };

  const types: Array<[string, (ev: Event) => void]> = [
    ['pointerdown', down],
    ['pointermove', move],
    ['pointerup', end],
    ['pointercancel', end],
    ['lostpointercapture', end],
  ];
  for (const [t, fn] of types) surface.addEventListener(t, fn);
  return () => {
    for (const [t, fn] of types) surface.removeEventListener(t, fn);
    active = null;
    last = null;
  };
}
