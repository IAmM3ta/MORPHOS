/**
 * Morphogen v2 — freeze control binding (2026-11-11).
 *
 * Step 4 groundwork of docs/morphogen-redteam/FREEZE-REVIEW.md: the glue that
 * will sit between `createFreezeLease` (freezeLease.ts), the sim loop and
 * `TdClient` status changes, built and tested BEFORE the refusal is lifted.
 * Like freezeLease.ts it is NOT wired in: parseTdCommand still refuses
 * `freeze` / `thaw` and main.ts does not import this file, so landing it
 * changes no runtime behaviour.
 *
 * Why a separate binding instead of calling the lease from main.ts directly:
 * the review's step-4 list ("socket close while frozen thaws before reconnect;
 * fresh ack starts running; local press thaws; silence timeout") is about
 * *who restarts the loop and when*. Keeping that in one pure object means the
 * tests can drive it with fake `halt` / `resume` callbacks and a fake clock.
 *
 * Rules enforced here (numbers match the review's "Rules" section):
 *   1. `freeze(ms, now)` halts the loop only if the lease accepted `ms`
 *      (refused, not clamped — a bad frame leaves state, and the loop, alone).
 *      A renewal while frozen never calls `halt` twice.
 *   2. `thaw(now)` (TD's explicit `thaw`) resumes at once; no-op when running.
 *   3. `status(s)`: any TdStatus other than 'open' while frozen thaws with
 *      reason 'disconnect' and resumes SYNCHRONOUSLY. TdClient calls onStatus
 *      ('reconnecting') before it arms the backoff timer (tdClient.ts
 *      scheduleReconnect), so the field is running again before any retry.
 *   4. A fresh 'open' (a new authed ack) never inherits a freeze: if a lease
 *      is somehow still held when status becomes 'open' from anything else,
 *      it is thawed ('disconnect') before TD can send another frame.
 *   5. `local()` (performer press / key) thaws with reason 'local' — local
 *      input always wins over TD.
 *   6. `tick(now, lastFrameAt)` forwards to `lease.check` and resumes on
 *      'expired' or 'silence'.
 *
 * Ownership: the binding only resumes a loop IT halted. If the performer
 * stopped the loop some other way (teardown, gate not yet passed), a thaw
 * must not start it behind their back, so `resume` is called only when this
 * binding's own `halt` is outstanding. Every thaw reports its reason through
 * `onThaw` so the caller can write describeThaw(reason) to the status line.
 */

import type { TdStatus } from './tdClient';
import { createFreezeLease, type FreezeLease, type ThawReason } from './freezeLease';

export type FreezeControlHooks = {
  /**
   * Hold kernel steps. Called once per freeze, not per renewal. Wire to
   * createStepHold().hold — NOT loop.stop(): the frame loop must keep running
   * so tick() can notice expiry / silence (2026-11-12 correction;
   * createFreezeWiring in src/app/freezeWiring.ts does this wiring for you).
   */
  halt: () => void;
  /** Release kernel steps (createStepHold().release). Only after this binding's own halt. */
  resume: () => void;
  /** Optional: told why each lease ended, for the status line / tally. */
  onThaw?: (reason: ThawReason) => void;
};

export type FreezeControl = {
  /** TD `freeze {ms}` arrived. True if accepted (started or renewed). */
  freeze(ms: unknown, nowMs: number): boolean;
  /** TD `thaw` arrived. True if a lease was actually ended. */
  thaw(): boolean;
  /** Feed every TdClient onStatus change here (rules 3 and 4). */
  status(s: TdStatus): void;
  /** Performer input (press / key). True if it ended a lease (rule 5). */
  local(): boolean;
  /** Housekeeping: call each frame / timer tick. Returns the thaw reason, if any (rule 6). */
  tick(nowMs: number, lastFrameAt: number | null): ThawReason | null;
  /** True while this binding holds the loop halted. */
  holding(): boolean;
  /** The underlying lease, for `?debug=1` snapshot() / remaining(). */
  readonly lease: FreezeLease;
};

export function createFreezeControl(
  hooks: FreezeControlHooks,
  lease: FreezeLease = createFreezeLease(),
): FreezeControl {
  let halted = false; // true only between our own halt() and resume()
  let lastStatus: TdStatus | null = null;

  // End any lease for `reason` and give the loop back if we were holding it.
  const release = (reason: ThawReason, alreadyEnded = false): boolean => {
    const ended = alreadyEnded || lease.thaw(reason);
    if (halted) {
      halted = false;
      hooks.resume();
    }
    if (ended) hooks.onThaw?.(reason);
    return ended;
  };

  return {
    lease,
    freeze(ms, nowMs) {
      // A freeze is only meaningful on an authed session; anything else is ignored.
      if (lastStatus !== 'open') return false;
      if (!lease.start(ms, nowMs)) return false; // refused: state and loop untouched
      if (!halted) {
        halted = true;
        hooks.halt();
      }
      return true;
    },
    thaw() {
      return release('thaw');
    },
    status(s) {
      const prev = lastStatus;
      lastStatus = s;
      if (s !== 'open') {
        // Rule 3: leaving 'open' (reconnecting / error / idle / …) thaws first.
        if (halted || lease.snapshot().until !== null) release('disconnect');
        return;
      }
      // Rule 4: a fresh ack starts running — never inherit an older lease.
      if (prev !== 'open' && (halted || lease.snapshot().until !== null)) release('disconnect');
    },
    local() {
      if (!halted && lease.snapshot().until === null) return false;
      return release('local');
    },
    tick(nowMs, lastFrameAt) {
      const reason = lease.check(nowMs, lastFrameAt);
      if (reason !== null) release(reason, true);
      return reason;
    },
    holding() {
      return halted;
    },
  };
}
