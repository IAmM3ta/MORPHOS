/**
 * Morphogen v2 — freeze wiring (2026-11-14).
 *
 * The last pure piece before FREEZE-REVIEW.md's refusal can be lifted: ONE
 * object that main.ts will call, which composes the step hold (loop.ts,
 * 11-12), the freeze binding (freezeControl.ts, 11-11) and the lease
 * (freezeLease.ts, 11-08) and owns the clock. Still NOT wired in:
 * parseTdCommand refuses `freeze` / `thaw` and main.ts does not import this
 * file, so landing it changes no runtime behaviour.
 *
 * Why a wrapper instead of the six-line recipe in the createStepHold header:
 * the 11-13 clock bug lived in that recipe. Every call had to pass a `now`,
 * and the obvious one in onFrame (the rAF timestamp, ms since page load) is
 * the wrong clock for a lease that TdClient's `commandStats().lastAt`
 * (epoch ms, TdClientOptions.now / Date.now) is compared against. Here no
 * method takes a time argument: `freeze`, `frame` and `describe` all read
 * the injected `now` — which main.ts must set to the same clock it gives
 * TdClient — so the rAF `now` cannot reach the lease by accident. The
 * freezeLease clock guard stays as the seat belt; this makes the mistake
 * unrepresentable at the call site.
 *
 * Intended main.ts wiring when the refusal is lifted (not done yet):
 *   const freeze = createFreezeWiring({
 *     now: Date.now,                         // same clock as TdClient opts.now
 *     lastFrameAt: () => td.commandStats().lastAt,
 *     onThaw: (r) => setStatus(describeThaw(r)),
 *   });
 *   td.onStatus  → freeze.status(s)          (rules 3, 4)
 *   td.onCommand → freeze.freeze(cmd.ms) / freeze.thaw()   (rules 1, 2)
 *   canvas press / ENTER / Reset / preset / slider → freeze.local()   (rule 5)
 *   onFrame: (steps, now) => { steps = freeze.frame(steps); if (document.hidden) return; … }
 * `frame` goes BEFORE the hidden-tab early return so that a browser which
 * still delivers (throttled) frames to a hidden tab keeps ticking the lease;
 * where rAF is fully paused the review's accepted gap applies (a lease that
 * expires in the background ends on the first frame after the tab returns).
 * `describe()` gives the rule-7 status line while held; snapshot() is the
 * `?debug=1` shape.
 */

import { createStepHold, type StepHold } from './loop';
import { createFreezeControl, type FreezeControl } from '../sync/freezeControl';
import { createFreezeLease, describeFreeze, type FreezeSnapshot, type ThawReason } from '../sync/freezeLease';
import type { TdStatus } from '../sync/tdClient';

export type FreezeWiringDeps = {
  /**
   * The lease clock, epoch-style ms. MUST be the clock TdClient stamps
   * commandStats().lastAt with (TdClientOptions.now, default Date.now).
   * Never the rAF timestamp. Defaults to Date.now.
   */
  now?: () => number;
  /** Newest authed TD frame on that same clock (main.ts: td.commandStats().lastAt). */
  lastFrameAt: () => number | null;
  /** Told why each lease ended (status line / tally). */
  onThaw?: (reason: ThawReason) => void;
  /** Silence window override for tests; defaults to FREEZE_SILENCE_MS. */
  silenceMs?: number;
};

export type FreezeWiringSnapshot = FreezeSnapshot & { held: boolean };

export type FreezeWiring = {
  /** TD `freeze {ms}`. True if accepted (started / renewed); refused frames change nothing. */
  freeze(ms: unknown): boolean;
  /** TD `thaw`. True if a lease was actually ended. */
  thaw(): boolean;
  /** Every TdClient onStatus change. */
  status(s: TdStatus): void;
  /** Performer input. True if it ended a lease. */
  local(): boolean;
  /**
   * Call once per displayed frame with the paced step count: ticks the lease
   * (expiry / silence) on the injected clock, then returns the steps to run
   * (0 while held). Deliberately takes no `now`.
   */
  frame(steps: number): number;
  /** True while kernel steps are held. */
  held(): boolean;
  /** Rule 7 status text while held ("frozen by TD · N s left"), else null. */
  describe(): string | null;
  /** `?debug=1`: lease until / last thaw reason, plus whether steps are held. */
  snapshot(): FreezeWiringSnapshot;
  /** Underlying pieces, for tests and the debug panel. */
  readonly control: FreezeControl;
  readonly hold: StepHold;
};

export function createFreezeWiring(deps: FreezeWiringDeps): FreezeWiring {
  const clock = deps.now ?? Date.now;
  const hold = createStepHold();
  const control = createFreezeControl(
    { halt: hold.hold, resume: hold.release, onThaw: deps.onThaw },
    createFreezeLease(deps.silenceMs),
  );

  // Read the TD frame time defensively: a throwing or garbage getter must not
  // stop the tick (that would be a still screen), it just means "no frame".
  const lastFrameAt = (): number | null => {
    try {
      const v = deps.lastFrameAt();
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  };

  return {
    control,
    hold,
    freeze(ms) {
      return control.freeze(ms, clock());
    },
    thaw() {
      return control.thaw();
    },
    status(s) {
      control.status(s);
    },
    local() {
      return control.local();
    },
    frame(steps) {
      // Tick first so a lease that ran out this frame already lets this
      // frame's steps through (no extra held frame after expiry). Ticking with
      // no lease is a no-op (check() returns null), so this runs every frame.
      control.tick(clock(), lastFrameAt());
      return hold.gate(steps);
    },
    held() {
      return hold.held();
    },
    describe() {
      if (!hold.held()) return null;
      return describeFreeze(control.lease.remaining(clock()));
    },
    snapshot() {
      return { ...control.lease.snapshot(), held: hold.held() };
    },
  };
}
