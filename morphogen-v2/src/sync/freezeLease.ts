/**
 * Morphogen v2 — freeze lease helper (2026-11-08).
 *
 * Step 2a of docs/morphogen-redteam/FREEZE-REVIEW.md: the small, pure state
 * machine that a future TD `freeze` / `thaw` command will drive. It is NOT
 * wired in yet — parseTdCommand still refuses `freeze` and nothing in main.ts
 * imports this file — so landing it changes no runtime behaviour. Building the
 * exits first, and testing them on their own, is the point: the review's main
 * worry is a frozen screen that outlives the TD session that froze it.
 *
 * Rules from the review that live here (numbers match its "Rules" section):
 *   1. A freeze is a lease, never a latch: `start(ms, now)` only accepts an
 *      integer `ms` in [MIN_FREEZE_MS, MAX_FREEZE_MS]. Anything else is
 *      REFUSED, not clamped, and leaves the current state untouched, so TD can
 *      never believe it holds a longer hold than the browser is running.
 *      A second valid `start` while frozen renews the lease from `now`.
 *   2. `thaw('thaw')` ends it at once and is a harmless no-op when running.
 *   3. / 5. Callers thaw with reason 'disconnect' (TdClient left "open") or
 *      'local' (performer input) — the helper just records why.
 *   6. `check(now, lastFrameAt)` thaws on expiry, or when no TD frame arrived
 *      for FREEZE_SILENCE_MS (≈ 2 × 1 Hz status heartbeat + 1 s).
 *   7. `snapshot(now)` is the `?debug=1` shape `{until, reason}`;
 *      describeFreeze / describeThaw give the status-line text.
 *
 * Clock safety (same spirit as createCommandGate): a non-finite `now` is
 * ignored — `start` refuses, `check` does nothing, `remaining` reports null —
 * and a clock that runs backwards can never lengthen a lease past the `ms`
 * TD asked for (remaining is capped at the granted length).
 */

/** Shortest lease TD may ask for; shorter holds are refused (review rule 1). */
export const MIN_FREEZE_MS = 250;
/** Longest lease; TD re-sends `freeze` before expiry to hold longer (rule 1). */
export const MAX_FREEZE_MS = 10_000;
/** No TD frame for this long while frozen → thaw (rule 6: 2 × 1 s heartbeat + 1 s). */
export const FREEZE_SILENCE_MS = 3_000;

/** Why the last lease ended. 'expired' and 'silence' come from check(). */
export type ThawReason = 'expired' | 'thaw' | 'disconnect' | 'local' | 'silence';

/** `?debug=1` snapshot: `until` is the client clock the lease ends at (null when running). */
export type FreezeSnapshot = { until: number | null; reason: ThawReason | null };

export type FreezeLease = {
  /** Start or renew a lease of `ms` from `now`. False (state unchanged) if refused. */
  start(ms: unknown, nowMs: number): boolean;
  /** End the lease now. Returns true only if a lease was actually active. */
  thaw(reason: ThawReason): boolean;
  /** True while a lease is held at `now` (an expired lease reads false even before check()). */
  frozen(nowMs: number): boolean;
  /** Milliseconds left, 0 when running, null when frozen but `now` is not a usable clock. */
  remaining(nowMs: number): number | null;
  /**
   * Housekeeping tick (call from the loop / a timer while frozen). Thaws and
   * returns the reason on expiry or TD silence; otherwise returns null.
   */
  check(nowMs: number, lastFrameAt: number | null): ThawReason | null;
  /** Debug view: when the lease ends and why the previous one ended. */
  snapshot(): FreezeSnapshot;
};

/** Rule 1 validator, exported so the parser and tests share one definition. */
export function isValidFreezeMs(ms: unknown): ms is number {
  return (
    typeof ms === 'number' &&
    Number.isInteger(ms) &&
    ms >= MIN_FREEZE_MS &&
    ms <= MAX_FREEZE_MS
  );
}

export function createFreezeLease(silenceMs: number = FREEZE_SILENCE_MS): FreezeLease {
  const silence = Number.isFinite(silenceMs) && silenceMs > 0 ? silenceMs : FREEZE_SILENCE_MS;
  let startedAt: number | null = null; // client clock when the current lease began/renewed
  let grantedMs = 0; // length TD asked for; remaining() never exceeds it
  let lastReason: ThawReason | null = null;

  const end = (reason: ThawReason): boolean => {
    const wasFrozen = startedAt !== null;
    startedAt = null;
    grantedMs = 0;
    if (wasFrozen) lastReason = reason;
    return wasFrozen;
  };

  // Time left at `now`, capped to [0, grantedMs] so a backwards clock can't extend it.
  const left = (now: number): number => {
    if (startedAt === null) return 0;
    const elapsed = Math.max(0, now - startedAt);
    return Math.max(0, Math.min(grantedMs, grantedMs - elapsed));
  };

  return {
    start(ms, nowMs) {
      if (!isValidFreezeMs(ms) || !Number.isFinite(nowMs)) return false;
      startedAt = nowMs;
      grantedMs = ms;
      return true;
    },
    thaw(reason) {
      return end(reason);
    },
    frozen(nowMs) {
      if (startedAt === null) return false;
      if (!Number.isFinite(nowMs)) return true; // unknown clock: report what we hold, check() decides
      return left(nowMs) > 0;
    },
    remaining(nowMs) {
      if (startedAt === null) return 0;
      if (!Number.isFinite(nowMs)) return null;
      return left(nowMs);
    },
    check(nowMs, lastFrameAt) {
      if (startedAt === null || !Number.isFinite(nowMs)) return null;
      if (left(nowMs) <= 0) {
        end('expired');
        return 'expired';
      }
      // Silence is measured from the newest of "lease (re)started" and "last TD frame":
      // the freeze frame itself counts as traffic even if lastFrameAt lags.
      const heard =
        typeof lastFrameAt === 'number' && Number.isFinite(lastFrameAt)
          ? Math.max(startedAt, lastFrameAt)
          : startedAt;
      if (nowMs - heard > silence) {
        end('silence');
        return 'silence';
      }
      return null;
    },
    snapshot() {
      return {
        until: startedAt === null ? null : startedAt + grantedMs,
        reason: lastReason,
      };
    },
  };
}

/** Status-line text while frozen (rule 7). Whole seconds, rounded up, never "0 s left". */
export function describeFreeze(remainingMs: number | null): string {
  if (remainingMs === null || !Number.isFinite(remainingMs)) return 'frozen by TD';
  const s = Math.max(1, Math.ceil(remainingMs / 1000));
  return `frozen by TD · ${s} s left`;
}

/** Status-line text after a lease ends, e.g. "thawed (local)" (rule 5). */
export function describeThaw(reason: ThawReason): string {
  return `thawed (${reason})`;
}
