/**
 * Morphogen v2 — frame loop: display-rate-independent sim pacing + a
 * single-flight, failure-tolerant start.
 *
 * Why this exists (2026-10-15): `main.ts` used to run a fixed `STEPS = 2`
 * kernel steps per `requestAnimationFrame`. That ties sim speed to the
 * display: a 120 Hz screen ran the field twice as fast as a 60 Hz one, a
 * throttled 30 Hz laptop ran it at half speed. Separately, `start()` awaited
 * `hum.unlock()` with no guard, so a rejecting `AudioContext.resume()` (e.g.
 * Safari's NotAllowedError) left the gate up and the sim frozen, and ENTER +
 * a canvas press in the same gesture ran two overlapping starts.
 *
 * Everything here is DOM-free (rAF / cancel are injected) so it runs under
 * node:test.
 */

/** Kernel rate. 120 Hz = 2 steps per 60 Hz frame, i.e. the old `STEPS = 2` look. */
export const SIM_HZ = 120;
/** Milliseconds of sim time one kernel step represents. */
export const SIM_STEP_MS = 1000 / SIM_HZ;
/**
 * Hard CPU budget per displayed frame. Each step is O(w·h) (65 536 cells at
 * 256²), so below ~30 fps the sim slows down instead of trying to catch up
 * (no "spiral of death"); any backlog past the cap is dropped, never replayed.
 */
export const MAX_STEPS_PER_FRAME = 4;
/** Elapsed time assumed for the first frame after start (one 60 Hz frame). */
export const FIRST_FRAME_MS = 1000 / 60;

// Float slack so 16.666…/8.333… counts as 2 steps, not 1.9999.
const EPS = 1e-6;

export interface Pace {
  /** Kernel steps to run this frame, 0 … MAX_STEPS_PER_FRAME. */
  steps: number;
  /** Leftover sim time (ms) carried into the next frame, always in [0, SIM_STEP_MS). */
  carryMs: number;
}

/**
 * Pure fixed-timestep pacing. Adds `elapsedMs` to the carried remainder and
 * returns how many whole kernel steps fit.
 * - non-finite / negative carry → 0 (a corrupt accumulator can't stall or burst)
 * - non-finite, zero or negative elapsed (duplicate / backwards rAF timestamp)
 *   → 0 steps, carry unchanged
 * - more than MAX_STEPS_PER_FRAME steps due (tab return, debugger pause, slow
 *   device) → exactly MAX_STEPS_PER_FRAME and the backlog is discarded
 */
export function paceSteps(carryMs: number, elapsedMs: number): Pace {
  const carry = Number.isFinite(carryMs) && carryMs > 0 ? Math.min(carryMs, SIM_STEP_MS) : 0;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return { steps: 0, carryMs: carry };
  const total = carry + elapsedMs;
  const due = Math.floor((total + EPS) / SIM_STEP_MS);
  if (due >= MAX_STEPS_PER_FRAME) return { steps: MAX_STEPS_PER_FRAME, carryMs: 0 };
  return { steps: due, carryMs: Math.max(0, total - due * SIM_STEP_MS) };
}

export interface FrameLoopDeps {
  requestFrame: (cb: (now: number) => void) => number;
  cancelFrame: (id: number) => void;
  /** Called once per displayed frame with the paced step count (may be 0). */
  onFrame: (steps: number, now: number) => void;
}

export interface FrameLoop {
  /** Idempotent: a second start() while running never queues a second rAF chain. */
  start(): void;
  /** Idempotent; safe to call from inside onFrame (no further frame is scheduled). */
  stop(): void;
  isRunning(): boolean;
}

/**
 * rAF-driven loop around `paceSteps`. Restarting resets the clock, so time
 * spent stopped is never replayed. If `onFrame` throws, the error still
 * surfaces but the next frame is scheduled anyway: one bad frame must not
 * freeze the instrument mid-performance.
 */
export function createFrameLoop(deps: FrameLoopDeps): FrameLoop {
  let running = false;
  let id: number | null = null;
  let last: number | null = null;
  let carry = 0;

  const tick = (now: number) => {
    id = null;
    if (!running) return;
    const elapsed = last === null ? FIRST_FRAME_MS : now - last;
    if (Number.isFinite(now) && (last === null || now > last)) last = now;
    const pace = paceSteps(carry, elapsed);
    carry = pace.carryMs;
    try {
      deps.onFrame(pace.steps, now);
    } finally {
      if (running && id === null) id = deps.requestFrame(tick);
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      last = null;
      carry = 0;
      id = deps.requestFrame(tick);
    },
    stop() {
      running = false;
      if (id !== null) deps.cancelFrame(id);
      id = null;
    },
    isRunning: () => running,
  };
}

/**
 * Single-flight, never-rejecting audio unlock. Overlapping calls (ENTER and a
 * canvas press in one gesture) share one in-flight attempt; a throwing or
 * rejecting `unlock` resolves `false` so the caller can still start the sim
 * silently and offer "tap again". Once settled, the next call tries again
 * (a later gesture may succeed where the first was refused).
 */
export function singleFlightUnlock(unlock: () => Promise<boolean>): () => Promise<boolean> {
  let pending: Promise<boolean> | null = null;
  return () => {
    if (pending) return pending;
    let p: Promise<boolean>;
    try {
      p = Promise.resolve(unlock()).then(
        (ok) => ok === true,
        () => false,
      );
    } catch {
      p = Promise.resolve(false);
    }
    pending = p.finally(() => {
      pending = null;
    });
    return pending;
  };
}

/**
 * Step hold (2026-11-12) — how `freeze` should stop the field WITHOUT stopping
 * the frame loop. FREEZE-REVIEW.md open questions 1 and 2, answered in code.
 *
 * The step-4 plan wired createFreezeControl's `halt` / `resume` to
 * `loop.stop()` / `loop.start()`. That has a hole: `control.tick(now,
 * lastFrameAt)` is the only thing that notices lease expiry and TD silence,
 * and the natural place to call it is onFrame — but a stopped loop has no
 * frames, so nothing would ever call tick and an expired freeze would never
 * end (the exact still-screen failure the review exists to prevent). Stopping
 * the loop would also freeze the HUD read-out and the Hum modulation along
 * with the field, and a thaw would call `loop.start()`, which must stay the
 * performer's / ENTER gate's decision.
 *
 * So the hold only zeroes the kernel step count. While held, the loop keeps
 * running at display rate: renderer.draw (a cheap blit of an unchanging
 * field), hud.update and hum.modulate (fed the same energy, so Hum holds its
 * tone — the review's proposed answer) and, crucially, the per-frame tick.
 * paceSteps keeps consuming elapsed time while held, so releasing the hold
 * never replays the frozen interval as a burst; the next frame runs its
 * normal 0…MAX_STEPS_PER_FRAME steps.
 *
 * Intended wiring when the refusal is lifted (main.ts, not done yet):
 *   const hold = createStepHold();
 *   const freeze = createFreezeControl({ halt: hold.hold, resume: hold.release, onThaw });
 *   td.onCommand: freeze → freeze.freeze(cmd.ms, Date.now())
 *   onFrame: (steps) => { freeze.tick(Date.now(), td.commandStats().lastAt); steps = hold.gate(steps); … }
 * ONE clock (2026-11-13 correction): the lease and its silence check must run
 * on TdClient's clock (`opts.now`, default Date.now — the clock that stamps
 * commandStats().lastAt), never onFrame's rAF `now`, which counts from page
 * load. Mixing them made the lease un-expirable on paper (elapsed clamps at
 * 0) and made silence unreachable (lastAt looks ~56 years in the future).
 * freezeLease.check now thaws on such a clock rather than holding forever,
 * but the wiring above is the fix; the guard is the seat belt.
 * `release` never starts a stopped loop, so freezeControl's "only resume
 * what I halted" rule now holds by construction as well as by bookkeeping.
 * 2026-11-14: the recipe above is now packaged as createFreezeWiring in
 * src/app/freezeWiring.ts, whose methods take no `now` at all (the clock is
 * injected once), so main.ts should call that rather than re-type this.
 */
export interface StepHold {
  /** Start holding: gate() returns 0 until release(). Idempotent. */
  hold(): void;
  /** Stop holding. Idempotent; never starts or stops the frame loop itself. */
  release(): void;
  /** True while held. */
  held(): boolean;
  /** Steps to actually run this frame: 0 while held, else `steps` unchanged. */
  gate(steps: number): number;
}

export function createStepHold(): StepHold {
  let isHeld = false;
  return {
    hold() {
      isHeld = true;
    },
    release() {
      isHeld = false;
    },
    held: () => isHeld,
    gate: (steps) => (isHeld ? 0 : steps),
  };
}
