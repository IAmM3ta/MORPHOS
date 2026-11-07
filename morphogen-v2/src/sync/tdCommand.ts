/**
 * TD → app control plane (2026-10-21, REBUILD-SPEC §6 "Reserve onmessage for TD→app").
 *
 * After the hello → ack handshake, TouchDesigner may push small JSON commands
 * back down the same socket: `{ v: 1, cmd: "preset" | "ping" | "setParams" | "freeze", ... }`.
 * This module is the *only* place those frames are parsed. Everything here is
 * pure (no DOM, no socket) so it is fully unit-tested in tests/tdCommand.test.mjs.
 *
 * Accepted today:
 *   { v:1, cmd:"preset", id:"coral" }  → switch the Field preset (main.ts runs it
 *                                         through createPresetCycler().set, which
 *                                         ignores unknown ids, so a typo is a no-op)
 *   { v:1, cmd:"ping", t?:number }     → TdClient answers { v:1, pong:"morphogen", t }
 *                                         itself, so TD can measure round-trip latency.
 *
 *   { v:1, cmd:"status", rtt:{ last_ms, median_ms, samples, outstanding, lost } }
 *                                      → TD's own round-trip figures (2026-10-29).
 *                                         TdClient keeps the latest one (tdRtt())
 *                                         so the browser can show what only TD
 *                                         could see before: lost pings.
 *
 *   { v:1, cmd:"setParams", feed?:number, kill?:number }
 *                                      → fine-tune the Field like the sliders do
 *                                         (2026-11-05). main.ts applies it as a
 *                                         partial sim.setParams and snaps the
 *                                         feed / kill sliders to the new values.
 *
 * setParams limits review (2026-11-05) — why the frame is this narrow:
 *   - Only `feed` and `kill` are remote-drivable. `du` / `dv` set the stable
 *     time step (maxStableDt: D·dt ≤ 1/4), so a remote peer must not touch
 *     them; a frame carrying du, dv, dt or any other extra key is refused
 *     whole rather than half-applied.
 *   - Each value must already sit inside REMOTE_PARAM_RANGE (the same travel
 *     as the on-screen sliders, TUNE_RANGE in ui/fieldTune.ts, itself inside
 *     the kernel's PARAM_LIMITS). Out-of-range values are *refused, not
 *     clamped*: a clamp would leave TD believing it set 0.2 while the browser
 *     runs 0.09, and the refused tally makes the mistake visible instead.
 *   - Values are rounded to 4 decimals (TUNE_STEP), matching the slider snap
 *     and TD's builder, so both sides agree on the exact number.
 *   - At least one knob must be present; an empty setParams is junk.
 *   - It is an ordinary command: authed sessions only, spends a gate token,
 *     counts as `applied`.
 *
 * Still refused (parse → null): "freeze". Stopping the sim remotely needs its
 * own review (who un-freezes it if TD drops?), so the door stays shut for now.
 * That review is written up in docs/morphogen-redteam/FREEZE-REVIEW.md
 * (2026-11-07): freeze becomes a short lease ({ms} ≤ 10 s, refused not
 * clamped) that the *browser* ends — on expiry, an explicit thaw, any status
 * change away from 'open', local input, or ~3 s of TD silence — so a dropped
 * TD can never leave the Field stuck. Fixture rows come first, then this parser.
 *
 * Trust model: frames only reach this parser after TD acked our authed hello
 * (TdClient checks status === 'open'), but they are still treated as untrusted
 * input — size-capped, shape-checked, strings normalised and length-limited,
 * and rate-limited by createCommandGate so a runaway TD script can't thrash
 * the kernel 1000×/s.
 *
 * Counters (2026-10-24): TdClient tallies what happened to every authed frame
 * in a TdCommandStats record (applied / pings / refused / paced / handler
 * errors). describeCommandStats turns it into one short line for the debug
 * snapshot and, later, the Sync panel, so "TD sent it but nothing changed"
 * can be told apart from "TD's frames were refused" or "TD was rate-limited".
 *
 * Contract (2026-10-23): td/morphogen_sync_commands.py is the TD-side twin of
 * this file. tests/fixtures/td-commands.v1.json pins the exact frames, refusals
 * and rate-gate verdicts both sides must agree on; if you change a rule here,
 * update that fixture and keep tests/tdContract.test.mjs and
 * ../tests/test_td_sync_contract.py passing.
 */

/** Frames bigger than this are dropped before JSON.parse (commands are tiny). */
export const MAX_COMMAND_BYTES = 512;
/** Preset ids are short ASCII slugs; anything longer is junk. */
export const MAX_PRESET_ID_LEN = 32;
/** Status RTT values above an hour are junk, not measurements (TD: MAX_STATUS_MS). */
export const MAX_STATUS_MS = 3_600_000;
/** Status counters above a billion are junk too (TD: MAX_STATUS_COUNT). */
export const MAX_STATUS_COUNT = 1_000_000_000;
/**
 * Inclusive range a TD `setParams` value must already sit in (2026-11-05).
 * Equal to the slider travel (TUNE_RANGE) and inside PARAM_LIMITS; the TD twin
 * is REMOTE_PARAM_RANGE in td/morphogen_sync_commands.py and the shared
 * fixture's remote_param_range pins both (tests check all three agree).
 */
export const REMOTE_PARAM_RANGE = {
  feed: [0.01, 0.09],
  kill: [0.045, 0.07],
} as const;
/** Decimals a remote feed / kill is rounded to (same as the slider's TUNE_STEP 0.0001). */
export const REMOTE_PARAM_DECIMALS = 4;
/** Sustained command rate the gate allows (per second). */
export const COMMAND_RATE_PER_S = 10;
/** Short burst allowance on top of the sustained rate (e.g. a TD cue stack firing at once). */
export const COMMAND_BURST = 5;

export type TdPresetCommand = { cmd: 'preset'; id: string };
export type TdPingCommand = { cmd: 'ping'; t: number | null };
/**
 * TD-side round-trip figures, mirroring the `morphogen_rtt` table rows in TD.
 * lastMs / medianMs are null until TD has matched its first pong.
 */
export type TdRtt = {
  lastMs: number | null;
  medianMs: number | null;
  samples: number;
  outstanding: number;
  lost: number;
};
export type TdStatusCommand = { cmd: 'status'; rtt: TdRtt };
/** Partial feed / kill patch from TD; at least one key is present. */
export type TdParamsPatch = { feed?: number; kill?: number };
export type TdSetParamsCommand = { cmd: 'setParams'; params: TdParamsPatch };
export type TdCommand = TdPresetCommand | TdPingCommand | TdStatusCommand | TdSetParamsCommand;

/** What TdClient sends back for a ping. `t` echoes the ping's own clock (or null). */
export type TdPong = { v: 1; pong: 'morphogen'; t: number | null };

/**
 * Parse one raw WebSocket frame as a v1 TD command. Returns null for anything
 * that is not a well-formed, currently-accepted command — the caller just
 * ignores those (no error status: a newer TD sending a command this build
 * doesn't know must not break the session).
 */
export function parseTdCommand(raw: unknown): TdCommand | null {
  if (typeof raw !== 'string' || raw.length > MAX_COMMAND_BYTES) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const m = msg as Record<string, unknown>;
  if (m.v !== 1 || typeof m.cmd !== 'string') return null;

  if (m.cmd === 'preset') {
    if (typeof m.id !== 'string') return null;
    // Same normalisation as ?preset= (presetFromQuery): trimmed, lower-case.
    const id = m.id.trim().toLowerCase();
    if (!id || id.length > MAX_PRESET_ID_LEN || !/^[a-z0-9_-]+$/.test(id)) return null;
    return { cmd: 'preset', id };
  }
  if (m.cmd === 'ping') {
    const t = typeof m.t === 'number' && Number.isFinite(m.t) ? m.t : null;
    return { cmd: 'ping', t };
  }
  if (m.cmd === 'status') {
    const rtt = parseTdRtt(m.rtt);
    return rtt ? { cmd: 'status', rtt } : null;
  }
  if (m.cmd === 'setParams') {
    const params = parseRemoteParams(m);
    return params ? { cmd: 'setParams', params } : null;
  }
  // 'freeze' / unknown: reserved, not accepted yet.
  return null;
}

const SETPARAMS_KEYS = new Set(['v', 'cmd', 'feed', 'kill']);

/**
 * Validate a setParams frame's knobs (see the limits review in the header).
 * Returns the rounded patch, or null if any key is unexpected, any value is
 * not a finite number inside REMOTE_PARAM_RANGE, or no knob is present.
 */
function parseRemoteParams(m: Record<string, unknown>): TdParamsPatch | null {
  for (const k of Object.keys(m)) if (!SETPARAMS_KEYS.has(k)) return null;
  const scale = 10 ** REMOTE_PARAM_DECIMALS;
  const patch: TdParamsPatch = {};
  for (const knob of ['feed', 'kill'] as const) {
    if (!Object.prototype.hasOwnProperty.call(m, knob)) continue;
    const v = m[knob];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const [lo, hi] = REMOTE_PARAM_RANGE[knob];
    if (v < lo || v > hi) return null; // refuse, never clamp
    patch[knob] = Math.round(v * scale) / scale;
  }
  return patch.feed === undefined && patch.kill === undefined ? null : patch;
}

/**
 * Shape-check a status frame's `rtt` object. Every field must be present: ms
 * values null or finite 0..MAX_STATUS_MS, counts integers 0..MAX_STATUS_COUNT.
 * Any bad field refuses the whole frame (a half-valid status would mislead).
 */
function parseTdRtt(raw: unknown): TdRtt | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const ms = (v: unknown): number | null | undefined => {
    if (v === null) return null;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_STATUS_MS ? v : undefined;
  };
  const count = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_STATUS_COUNT ? v : undefined;
  const lastMs = ms(r.last_ms);
  const medianMs = ms(r.median_ms);
  const samples = count(r.samples);
  const outstanding = count(r.outstanding);
  const lost = count(r.lost);
  if (lastMs === undefined || medianMs === undefined) return null;
  if (samples === undefined || outstanding === undefined || lost === undefined) return null;
  return { lastMs, medianMs, samples, outstanding, lost };
}

/**
 * One line for TD's RTT, e.g. "TD rtt: 8.0 ms (median 9.5) · 1 lost" — the
 * exact text TD's describe_rtt() prints, so both screens read the same. The
 * lost bucket is hidden while it is zero. (TD rounds exact ties up so its
 * digits match Number.toFixed; the fixture's rtt_lines pin this.)
 */
export function describeTdRtt(rtt: TdRtt): string {
  let head = 'TD rtt: no pongs yet';
  if (rtt.lastMs !== null) {
    head = `TD rtt: ${rtt.lastMs.toFixed(1)} ms`;
    if (rtt.medianMs !== null) head += ` (median ${rtt.medianMs.toFixed(1)})`;
  }
  return rtt.lost > 0 ? `${head} · ${rtt.lost} lost` : head;
}

/** Reply frame for a ping. */
export function pongFor(cmd: TdPingCommand): TdPong {
  return { v: 1, pong: 'morphogen', t: cmd.t };
}

export type CommandGate = {
  /** True if a command arriving at `nowMs` may run; consumes one token when it does. */
  allow(nowMs: number): boolean;
  /** Refill to a full burst (used on every fresh authed session). */
  reset(): void;
};

/**
 * Token bucket: `burst` commands at once, refilled at `ratePerS` per second.
 * A non-finite or backwards clock refills nothing (it can't mint tokens), so a
 * bad timestamp can only make the gate stricter, never looser.
 */
export function createCommandGate(
  ratePerS: number = COMMAND_RATE_PER_S,
  burst: number = COMMAND_BURST,
): CommandGate {
  const rate = Number.isFinite(ratePerS) && ratePerS > 0 ? ratePerS : COMMAND_RATE_PER_S;
  const cap = Number.isFinite(burst) && burst >= 1 ? Math.floor(burst) : COMMAND_BURST;
  let tokens = cap;
  let last: number | null = null;
  return {
    allow(nowMs) {
      if (Number.isFinite(nowMs)) {
        if (last !== null && nowMs > last) tokens = Math.min(cap, tokens + ((nowMs - last) / 1000) * rate);
        if (last === null || nowMs > last) last = nowMs;
      }
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    reset() {
      tokens = cap;
      last = null;
    },
  };
}

/**
 * Per-session tally of authed TD → app frames (2026-10-24). Every frame that
 * reaches TdClient.handleCommand lands in exactly one bucket, so
 * applied + pings + refused + paced === frames:
 *   refused       → parseTdCommand returned null (junk, reserved, oversized)
 *   paced         → well-formed but the rate gate said no
 *   pings         → answered in-client with a pong
 *   applied       → handed to onCommand (preset, status since 2026-10-29,
 *                   setParams since 2026-11-05)
 * handlerErrors counts applied commands whose onCommand handler threw (it is
 * a subset of applied, not a separate bucket). lastAt is the client clock
 * (TdClientOptions.now) of the latest frame, or null before the first.
 * Counts are plain integers: no ids, payload text or tokens are kept, so the
 * record is safe to show in the UI or a debug dump.
 */
export type TdCommandStats = {
  frames: number;
  applied: number;
  pings: number;
  refused: number;
  paced: number;
  handlerErrors: number;
  lastAt: number | null;
};

/** A zeroed tally (TdClient starts each authed session with one). */
export function emptyCommandStats(): TdCommandStats {
  return { frames: 0, applied: 0, pings: 0, refused: 0, paced: 0, handlerErrors: 0, lastAt: null };
}

/**
 * One short human line for a tally, e.g. "TD cmds: 3 applied · 1 ping · 2 paced".
 * Zero buckets are left out; an empty session reads "TD cmds: none yet".
 */
export function describeCommandStats(s: TdCommandStats): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string = one) => {
    if (Number.isFinite(n) && n > 0) parts.push(`${Math.floor(n)} ${n === 1 ? one : many}`);
  };
  add(s.applied, 'applied');
  add(s.pings, 'ping', 'pings');
  add(s.refused, 'refused');
  add(s.paced, 'paced');
  add(s.handlerErrors, 'handler error', 'handler errors');
  return `TD cmds: ${parts.length ? parts.join(' · ') : 'none yet'}`;
}
