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
 * Deliberately refused for now (parse → null): "setParams" and "freeze". They
 * are in the spec but need their own limits review before a remote peer can
 * drive kernel numbers or stop the sim; refusing them keeps the door shut
 * without precluding them later.
 *
 * Trust model: frames only reach this parser after TD acked our authed hello
 * (TdClient checks status === 'open'), but they are still treated as untrusted
 * input — size-capped, shape-checked, strings normalised and length-limited,
 * and rate-limited by createCommandGate so a runaway TD script can't thrash
 * the kernel 1000×/s.
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
/** Sustained command rate the gate allows (per second). */
export const COMMAND_RATE_PER_S = 10;
/** Short burst allowance on top of the sustained rate (e.g. a TD cue stack firing at once). */
export const COMMAND_BURST = 5;

export type TdPresetCommand = { cmd: 'preset'; id: string };
export type TdPingCommand = { cmd: 'ping'; t: number | null };
export type TdCommand = TdPresetCommand | TdPingCommand;

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
  // 'setParams' / 'freeze' / unknown: reserved, not accepted yet.
  return null;
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
