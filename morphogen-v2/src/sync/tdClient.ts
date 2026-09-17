/**
 * TouchDesigner Sync client stub.
 * Paths: (A) companion http://127.0.0.1 cleartext WS
 *        (B) MIDI-only on HTTPS
 *        (C) authenticated wss
 * Default must not silently use broken mixed-content ws:// from https:// pages.
 */

export type SyncPath = 'companion' | 'midi' | 'wss';

export type TdHello = {
  v: 1;
  hello: 'morphogen';
  t: number;
  auth: string;
};

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

export class TdClient {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private authToken: string;
  status: 'idle' | 'connecting' | 'open' | 'error' = 'idle';
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
    if (!this.authToken) {
      this.status = 'error';
      this.lastError = 'Auth token required in hello (C2)';
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
    this.ws.onopen = () => {
      this.status = 'open';
      this.onStatus?.(this.status, null);
      this.ws?.send(JSON.stringify(this.helloPacket()));
      this.timer = setInterval(() => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        if (this.ws.bufferedAmount > 256_000) return; // backpressure
        this.ws.send(JSON.stringify(getPayload()));
      }, 50);
    };
    this.ws.onclose = () => {
      this.stopPump();
      this.status = 'idle';
      this.onStatus?.(this.status, null);
    };
    this.ws.onerror = () => {
      this.lastError = 'Socket error — if HTTPS, use path A companion, B MIDI, or C wss';
      this.status = 'error';
      this.onStatus?.(this.status, this.lastError);
    };
    // Design hook for TD→app later
    this.ws.onmessage = (_ev: MessageEvent) => {
      // optional bidirectional control plane
    };
  }

  private stopPump(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
