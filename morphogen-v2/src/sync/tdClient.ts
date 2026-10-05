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
 */

export type SyncPath = 'companion' | 'midi' | 'wss';

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

const LOCAL_ALLOW = new Set(['127.0.0.1', 'localhost']);

export function isSecurePage(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'https:';
}

export function validateTdUrl(url: string, path: SyncPath): { ok: boolean; reason?: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'Invalid URL' };
  }
  if (path === 'midi') return { ok: false, reason: 'MIDI path does not use WebSocket' };
  if (path === 'companion') {
    if (u.protocol !== 'ws:') return { ok: false, reason: 'Companion path expects ws://' };
    if (!LOCAL_ALLOW.has(u.hostname)) {
      return { ok: false, reason: 'Companion allowlist: 127.0.0.1 / localhost' };
    }
    if (isSecurePage()) {
      return {
        ok: false,
        reason: 'This page is HTTPS — use companion http://127.0.0.1 controller (path A) or MIDI (B) or wss (C)',
      };
    }
    return { ok: true };
  }
  // path C
  if (u.protocol !== 'wss:') return { ok: false, reason: 'Advanced path expects wss://' };
  return { ok: true };
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

export class TdClient {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private authToken: string;
  /**
   * idle → connecting (socket opening) → authenticating (hello sent, awaiting ack)
   * → open (ack ok, telemetry pumping). Any failure lands in 'error'.
   */
  status: 'idle' | 'connecting' | 'authenticating' | 'open' | 'error' = 'idle';
  lastError: string | null = null;
  onStatus?: (s: TdClient['status'], err?: string | null) => void;

  constructor(authToken = '') {
    this.authToken = authToken;
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

  connect(url: string, path: SyncPath, getPayload: () => TdTelemetry): void {
    this.disconnect();
    const check = validateTdUrl(url, path);
    if (!check.ok) {
      this.status = 'error';
      this.lastError = check.reason ?? 'rejected';
      this.onStatus?.(this.status, this.lastError);
      return;
    }
    const tok = validateAuthToken(this.authToken);
    if (!tok.ok) {
      this.status = 'error';
      this.lastError = tok.reason ?? 'Auth token rejected';
      this.onStatus?.(this.status, this.lastError);
      return;
    }
    this.status = 'connecting';
    this.onStatus?.(this.status, null);
    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      this.status = 'error';
      this.lastError = e instanceof Error ? e.message : 'WebSocket failed';
      this.onStatus?.(this.status, this.lastError);
      return;
    }
    const ws = this.ws;
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
    // connect() races, or fail() already detached it).
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPump();
      // Keep a failure visible instead of flipping back to a silent 'idle'.
      if (this.status !== 'error') {
        this.status = 'idle';
        this.onStatus?.(this.status, null);
      }
    };
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.lastError = 'Socket error — if HTTPS, use path A companion, B MIDI, or C wss';
      this.status = 'error';
      this.onStatus?.(this.status, this.lastError);
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
      this.onStatus?.(this.status, null);
      this.timer = setInterval(() => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.ws.bufferedAmount > 256_000) return; // backpressure
        this.ws.send(JSON.stringify(getPayload()));
      }, 50);
    };
  }

  /** Tear down the socket but leave status='error' + lastError for the UI. */
  private fail(reason: string): void {
    this.stopPump();
    this.status = 'error';
    this.lastError = reason;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* */
    }
    this.onStatus?.(this.status, this.lastError);
  }

  private clearAckTimer(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  private stopPump(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clearAckTimer();
  }

  disconnect(): void {
    this.stopPump();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* */
      }
    }
    this.ws = null;
    this.status = 'idle';
    this.onStatus?.(this.status, null);
  }
}
