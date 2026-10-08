/**
 * TouchDesigner Sync client stub.
 * Paths: (A) companion http://127.0.0.1 cleartext WS
 *        (B) MIDI-only on HTTPS
 *        (C) authenticated wss
 * Default must not silently use broken mixed-content ws:// from https:// pages.
 *
 * Handshake (v2, see docs/morphogen-redteam/SYNC-AUTH.md):
 *   client → { v:1, hello:'morphogen', t, auth }
 *   TD     → { v:1, ack:'morphogen', ok:true }        (or ok:false + reason, then close)
 *   client → telemetry @ 20 Hz, only after ok:true; no ack within HELLO_ACK_TIMEOUT_MS → error.
 * Reference TD-side gate: morphogen-v2/td/morphogen_sync_auth.py.
 *
 * Reconnect (2026-10-06, REBUILD-SPEC §6 client hardening):
 *   Only *transient* failures retry — the socket failed to open (TD not up yet)
 *   or an authed session dropped. Retries use capped exponential backoff with
 *   "equal jitter" (see reconnectDelayMs) so a room full of phones doesn't
 *   stampede TD the instant it restarts. *Terminal* failures never retry:
 *   bad URL / token, TD's ok:false ack, ack timeout, or a close mid-handshake —
 *   retrying those would only burn TD's bad-hello budget with the same secret.
 *   Every retry is a fresh socket + fresh hello (no auth state is reused).
 *
 * URL hygiene (2026-10-08, see ./syncUrl.ts): every URL goes through
 * sanitizeTdUrl() and the host allowlist (127.0.0.1 / localhost / *.local);
 * other wss hosts need an explicit per-session confirm, and the socket is
 * opened on the canonical URL, never the raw paste.
 */

import { sanitizeTdUrl, type TdHostClass } from './syncUrl';

export type SyncPath = 'companion' | 'midi' | 'wss';

export type TdStatus = 'idle' | 'connecting' | 'authenticating' | 'open' | 'reconnecting' | 'error';

export type TdHello = {
  v: 1;
  hello: 'morphogen';
  t: number;
  auth: string;
};

/**
 * Server → client reply to the hello (v2 auth handshake).
 * TD sends exactly one of these; telemetry is only pumped after `ok: true`.
 * `reason` is a short machine code (e.g. 'bad_auth', 'stale_hello') — never echoes the secret.
 */
export type TdHelloAck = {
  v: 1;
  ack: 'morphogen';
  ok: boolean;
  reason?: string;
};

/** How long to wait for TD's hello ack before giving up (ms). */
export const HELLO_ACK_TIMEOUT_MS = 2000;
/** Shared secrets shorter than this are refused client-side (cheap brute-force guard). */
export const MIN_AUTH_TOKEN_LEN = 16;
/** Upper bound so a pasted blob can't bloat every hello. */
export const MAX_AUTH_TOKEN_LEN = 256;

/** First retry waits ~RECONNECT_BASE_MS (jittered); each later one doubles the ceiling. */
export const RECONNECT_BASE_MS = 500;
/** Backoff ceiling — a stage restart should be picked up within ~15 s. */
export const RECONNECT_MAX_MS = 15_000;
/** Give up (status 'error') after this many consecutive transient failures. */
export const RECONNECT_MAX_ATTEMPTS = 8;

/**
 * Delay before reconnect attempt `attempt` (0-based), in ms.
 *
 * Capped exponential backoff with equal jitter: ceiling = min(max, base·2^attempt),
 * delay ∈ [ceiling/2, ceiling). The floor of ceiling/2 keeps clients from
 * hammering TD; the random upper half spreads simultaneous reconnects apart.
 * `rand` is injectable for tests and must return a value in [0, 1).
 */
export function reconnectDelayMs(
  attempt: number,
  rand: () => number = Math.random,
  baseMs: number = RECONNECT_BASE_MS,
  maxMs: number = RECONNECT_MAX_MS,
): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  // 2^n overflows to Infinity long before it matters; min() clamps it anyway.
  const ceiling = Math.min(maxMs, baseMs * 2 ** n);
  const r = Math.min(Math.max(rand(), 0), 1 - Number.EPSILON);
  return Math.floor(ceiling / 2 + r * (ceiling / 2));
}

export type TdTelemetry = {
  v: 1;
  t: number;
  params: { feed: number; kill: number; du: number; dv: number; speed: number };
  sensors: { alpha: number; beta: number; gamma: number; ax: number; ay: number; az: number };
  audio: { rms: number; energy: number };
  field: {
    meanU: number;
    meanV: number;
    energy: number;
    cx: number;
    cy: number;
    edge: number;
  };
  loop: { count: number };
  touches: { x: number; y: number; p: number }[];
  grid?: number[];
};

export function isSecurePage(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'https:';
}

export type TdUrlCheck = {
  ok: boolean;
  reason?: string;
  /** Canonical URL from sanitizeTdUrl — connect() opens this, not the raw input. */
  url?: string;
  hostClass?: TdHostClass;
  /** Set when the only thing missing is the user's confirm for a remote host. */
  needsConfirm?: boolean;
};

export type TdUrlCheckOptions = {
  /** The user has confirmed this remote host for this session (never persisted). */
  confirmRemote?: boolean;
};

/**
 * Path-aware URL gate (2026-10-08: allowlist from REBUILD-SPEC §6).
 *   A companion — cleartext ws:// only to loopback or *.local, and never from an
 *                 https:// page (mixed content). Remote hosts are refused outright:
 *                 cleartext telemetry over the internet has no confirm that makes it OK.
 *   B midi      — no WebSocket at all.
 *   C wss       — wss:// only. Loopback / *.local pass; any other host needs
 *                 `confirmRemote` (remoteConfirmMessage() is the prompt text).
 */
export function validateTdUrl(url: string, path: SyncPath, opts: TdUrlCheckOptions = {}): TdUrlCheck {
  if (path === 'midi') return { ok: false, reason: 'MIDI path does not use WebSocket' };
  const s = sanitizeTdUrl(url);
  if (!s.ok) return { ok: false, reason: s.reason };
  const base = { url: s.url, hostClass: s.hostClass };
  if (path === 'companion') {
    if (s.scheme !== 'ws:') return { ok: false, reason: 'Companion path expects ws://', ...base };
    if (s.hostClass === 'remote') {
      return { ok: false, reason: 'Companion allowlist: 127.0.0.1 / localhost / *.local — use wss (C) for other hosts', ...base };
    }
    if (isSecurePage()) {
      return {
        ok: false,
        reason: 'This page is HTTPS — use companion http://127.0.0.1 controller (path A) or MIDI (B) or wss (C)',
        ...base,
      };
    }
    return { ok: true, ...base };
  }
  // path C
  if (s.scheme !== 'wss:') return { ok: false, reason: 'Advanced path expects wss://', ...base };
  if (s.hostClass === 'remote' && !opts.confirmRemote) {
    return { ok: false, reason: `Confirm remote TD host ${s.host} before connecting`, needsConfirm: true, ...base };
  }
  return { ok: true, ...base };
}

/**
 * Client-side shared-secret sanity check. Does not prove the secret is right —
 * only TD can do that — but rejects empty / short / whitespace-padded tokens
 * before we open a socket. Error strings never include the token itself.
 */
export function validateAuthToken(token: string): { ok: boolean; reason?: string } {
  if (!token) return { ok: false, reason: 'Auth token required in hello (C2)' };
  if (token !== token.trim()) return { ok: false, reason: 'Auth token has leading/trailing whitespace' };
  if (/\s/.test(token)) return { ok: false, reason: 'Auth token must not contain whitespace' };
  if (token.length < MIN_AUTH_TOKEN_LEN) {
    return { ok: false, reason: `Auth token too short (min ${MIN_AUTH_TOKEN_LEN} chars)` };
  }
  if (token.length > MAX_AUTH_TOKEN_LEN) {
    return { ok: false, reason: `Auth token too long (max ${MAX_AUTH_TOKEN_LEN} chars)` };
  }
  return { ok: true };
}

/**
 * Parse a raw WebSocket text frame as a hello ack. Returns null for anything
 * that is not a well-formed v1 ack (other TD→app messages fall through to the
 * future control plane).
 */
export function parseHelloAck(raw: unknown): TdHelloAck | null {
  if (typeof raw !== 'string' || raw.length > 1024) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m.v !== 1 || m.ack !== 'morphogen' || typeof m.ok !== 'boolean') return null;
  const ack: TdHelloAck = { v: 1, ack: 'morphogen', ok: m.ok };
  if (typeof m.reason === 'string') ack.reason = m.reason.slice(0, 64);
  return ack;
}

/** Plain-data view of a client, for the UI and for tests (no socket handles). */
export type TdSnapshot = {
  status: TdStatus;
  lastError: string | null;
  reconnectAttempt: number;
  maxReconnectAttempts: number;
  nextRetryAt: number | null;
};

export type TdStatusTone = 'idle' | 'busy' | 'ok' | 'warn' | 'error';

/** What the Sync panel shows: one line of text, a colour tone, and the live countdown. */
export type TdStatusView = {
  label: string;
  tone: TdStatusTone;
  /** ms until the scheduled retry while reconnecting (never negative), else null. */
  countdownMs: number | null;
  /** True only while a backoff retry is pending (terminal errors need a fresh user connect). */
  canRetryNow: boolean;
};

/**
 * Pure status → text mapping for the Sync panel (2026-10-07).
 * Kept out of the DOM so it is unit-testable and so the countdown is computed
 * from `nextRetryAt` against the caller's clock instead of a second timer that
 * could drift from the real retry. Strings never include the auth token —
 * `lastError` is built only from fixed messages and TD reason codes.
 */
export function describeTdStatus(snap: TdSnapshot, now: number = Date.now()): TdStatusView {
  switch (snap.status) {
    case 'idle':
      return { label: 'Sync off', tone: 'idle', countdownMs: null, canRetryNow: false };
    case 'connecting':
      return {
        label: snap.reconnectAttempt > 0 ? `Sync: reconnecting (try ${snap.reconnectAttempt}/${snap.maxReconnectAttempts})…` : 'Sync: connecting…',
        tone: 'busy',
        countdownMs: null,
        canRetryNow: false,
      };
    case 'authenticating':
      return { label: 'Sync: waiting for TD hello ack…', tone: 'busy', countdownMs: null, canRetryNow: false };
    case 'open':
      return { label: 'Sync: live → TD', tone: 'ok', countdownMs: null, canRetryNow: false };
    case 'reconnecting': {
      const ms = snap.nextRetryAt === null ? 0 : Math.max(0, snap.nextRetryAt - now);
      // Round *up* so the display never reads "0.0 s" while the retry is still pending.
      const secs = (Math.ceil(ms / 100) / 10).toFixed(1);
      return {
        label: `Sync: TD unreachable — retry ${snap.reconnectAttempt}/${snap.maxReconnectAttempts} in ${secs} s`,
        tone: 'warn',
        countdownMs: ms,
        canRetryNow: true,
      };
    }
    case 'error':
    default:
      return {
        label: `Sync error: ${snap.lastError ?? 'unknown'}`,
        tone: 'error',
        countdownMs: null,
        canRetryNow: false,
      };
  }
}

export type TdClientOptions = {
  /** Retry transient failures with backoff (default true). */
  autoReconnect?: boolean;
  /** Consecutive transient failures before giving up (default RECONNECT_MAX_ATTEMPTS). */
  maxReconnectAttempts?: number;
  /** Jitter source in [0, 1); injectable for tests (default Math.random). */
  rand?: () => number;
};

type ConnectTarget = { url: string; path: SyncPath; getPayload: () => TdTelemetry };

export class TdClient {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private authToken: string;
  private target: ConnectTarget | null = null;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly rand: () => number;
  /**
   * idle → connecting (socket opening) → authenticating (hello sent, awaiting ack)
   * → open (ack ok, telemetry pumping). Transient failures → reconnecting (retry
   * scheduled) → connecting …; terminal failures or an exhausted budget → error.
   */
  status: TdStatus = 'idle';
  lastError: string | null = null;
  /** Consecutive transient failures since the last successful ack (0 when healthy). */
  reconnectAttempt = 0;
  /** Epoch ms of the scheduled retry while status === 'reconnecting', else null. */
  nextRetryAt: number | null = null;
  onStatus?: (s: TdStatus, err?: string | null) => void;

  constructor(authToken = '', opts: TdClientOptions = {}) {
    this.authToken = authToken;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.maxReconnectAttempts = Math.max(0, opts.maxReconnectAttempts ?? RECONNECT_MAX_ATTEMPTS);
    this.rand = opts.rand ?? Math.random;
  }

  setAuth(token: string): void {
    this.authToken = token;
  }

  /** Build hello with auth — required for C2 fix. */
  helloPacket(): TdHello {
    return {
      v: 1,
      hello: 'morphogen',
      t: Date.now(),
      auth: this.authToken,
    };
  }

  /**
   * User-initiated connect: resets the retry budget, then opens a socket to the
   * *sanitised* URL. Remote wss hosts need `opts.confirmRemote` (the UI asks with
   * remoteConfirmMessage()); without it this lands in 'error' and opens nothing.
   */
  connect(url: string, path: SyncPath, getPayload: () => TdTelemetry, opts: TdUrlCheckOptions = {}): void {
    this.disconnect();
    const check = validateTdUrl(url, path, opts);
    if (!check.ok || !check.url) {
      this.setError(check.reason ?? 'rejected');
      return;
    }
    const tok = validateAuthToken(this.authToken);
    if (!tok.ok) {
      this.setError(tok.reason ?? 'Auth token rejected');
      return;
    }
    this.target = { url: check.url, path, getPayload };
    this.reconnectAttempt = 0;
    this.openSocket();
  }

  /** Open one socket for `this.target` and run the hello → ack → pump sequence. */
  private openSocket(): void {
    const target = this.target;
    if (!target) return;
    this.nextRetryAt = null;
    this.status = 'connecting';
    this.onStatus?.(this.status, null);
    let ws: WebSocket;
    try {
      ws = new WebSocket(target.url);
    } catch (e) {
      // Constructor throws are deterministic (bad URL, CSP, mixed content) —
      // retrying the same URL can't succeed, so this is terminal.
      this.fail(e instanceof Error ? e.message : 'WebSocket failed');
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      // Hello first; no telemetry until TD acks auth (C2). Previously the pump
      // started on open, so an unauthenticated server still got sensor data.
      this.status = 'authenticating';
      this.onStatus?.(this.status, null);
      ws.send(JSON.stringify(this.helloPacket()));
      this.ackTimer = setTimeout(() => {
        this.fail('No hello ack from TD — is the callbacks DAT auth-gated and the secret set?');
      }, HELLO_ACK_TIMEOUT_MS);
    };
    // Every handler ignores events from a superseded socket (disconnect() →
    // connect() races, retries, or fail() already detached it).
    ws.onerror = () => {
      if (this.ws !== ws) return;
      // Browsers always follow 'error' with 'close'; decide retry vs. give up there.
      this.lastError = 'Socket error — if HTTPS, use path A companion, B MIDI, or C wss';
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      const was = this.status;
      this.ws = null;
      this.stopPump();
      if (was === 'authenticating') {
        // TD closed before acking. A gated TD always acks first, so this is a
        // non-conforming / legacy server — don't keep re-sending the secret.
        this.fail('TD closed the socket during the hello handshake');
        return;
      }
      const reason =
        was === 'open'
          ? 'Sync connection dropped'
          : (this.lastError ?? 'Could not reach TD');
      this.scheduleReconnect(reason);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      if (this.status !== 'authenticating') {
        // Reserved for the optional TD→app control plane ({ v, cmd, ... }).
        return;
      }
      const ack = parseHelloAck(ev.data);
      if (!ack) return; // ignore noise until a real ack or the timeout
      this.clearAckTimer();
      if (!ack.ok) {
        this.fail(`TD rejected hello${ack.reason ? ` (${ack.reason})` : ''}`);
        return;
      }
      this.status = 'open';
      this.lastError = null;
      this.reconnectAttempt = 0; // healthy again: next drop starts from the base delay
      this.onStatus?.(this.status, null);
      this.timer = setInterval(() => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.ws.bufferedAmount > 256_000) return; // backpressure
        this.ws.send(JSON.stringify(target.getPayload()));
      }, 50);
    };
  }

  /** Transient failure: retry with backoff, or give up once the budget is spent. */
  private scheduleReconnect(reason: string): void {
    this.clearRetryTimer();
    if (!this.autoReconnect || !this.target || this.reconnectAttempt >= this.maxReconnectAttempts) {
      const spent = this.autoReconnect && this.maxReconnectAttempts > 0;
      this.fail(spent ? `${reason} — gave up after ${this.reconnectAttempt} retries` : reason);
      return;
    }
    const delay = reconnectDelayMs(this.reconnectAttempt, this.rand);
    this.reconnectAttempt += 1;
    this.nextRetryAt = Date.now() + delay;
    this.status = 'reconnecting';
    this.lastError = `${reason} — retry ${this.reconnectAttempt}/${this.maxReconnectAttempts} in ${(delay / 1000).toFixed(1)} s`;
    this.onStatus?.(this.status, this.lastError);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.openSocket();
    }, delay);
  }

  private setError(reason: string): void {
    this.status = 'error';
    this.lastError = reason;
    this.onStatus?.(this.status, this.lastError);
  }

  /** Terminal: tear down the socket, cancel retries, leave status='error' + lastError for the UI. */
  private fail(reason: string): void {
    this.stopPump();
    this.clearRetryTimer();
    this.nextRetryAt = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* */
    }
    this.setError(reason);
  }

  private clearAckTimer(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private stopPump(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clearAckTimer();
  }

  /** Current state as plain data (feed to describeTdStatus). */
  snapshot(): TdSnapshot {
    return {
      status: this.status,
      lastError: this.lastError,
      reconnectAttempt: this.reconnectAttempt,
      maxReconnectAttempts: this.maxReconnectAttempts,
      nextRetryAt: this.nextRetryAt,
    };
  }

  /**
   * Skip the remaining backoff and retry immediately (Sync panel "Retry now").
   * Only acts while status === 'reconnecting'; it does NOT reset the retry
   * budget, so mashing the button can't exceed maxReconnectAttempts or turn a
   * terminal auth failure back into a hello loop. Returns true if a socket opened.
   */
  retryNow(): boolean {
    if (this.status !== 'reconnecting' || !this.target || !this.retryTimer) return false;
    this.clearRetryTimer();
    this.openSocket();
    return true;
  }

  /** User-initiated stop: cancels any pending retry and forgets the target. */
  disconnect(): void {
    this.stopPump();
    this.clearRetryTimer();
    this.target = null;
    this.nextRetryAt = null;
    this.reconnectAttempt = 0;
    const ws = this.ws;
    this.ws = null; // detach first so its onclose can't schedule a retry
    if (ws) {
      try {
        ws.close();
      } catch {
        /* */
      }
    }
    this.status = 'idle';
    this.onStatus?.(this.status, null);
  }
}
