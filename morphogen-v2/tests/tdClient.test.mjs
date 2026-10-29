// Morphogen v2 Sync client tests (node:test, no browser).
// Run: npm test   (bundles src/sync/tdClient.ts with esbuild → .test-build/, then node --test)
// Covers the hello → ack handshake (C2) and the reconnect backoff policy:
// only transient failures retry; auth rejects / ack timeouts never do.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  TdClient,
  reconnectDelayMs,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  HELLO_ACK_TIMEOUT_MS,
} from '../.test-build/tdClient.mjs';

const URL_OK = 'ws://127.0.0.1:9980';
const SECRET = 'correct-horse-battery';
const payload = () => ({ v: 1, t: 0, params: {}, sensors: {}, audio: {}, field: {}, loop: { count: 0 }, touches: [] });

/** Minimal WebSocket double: the test drives open / message / close by hand. */
class FakeWS {
  static OPEN = 1;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = false;
    FakeWS.instances.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.readyState = 3; }
  // --- test drivers ---
  serverOpen() { this.readyState = 1; this.onopen?.(); }
  serverSend(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  serverDrop() { this.readyState = 3; this.onerror?.(); this.onclose?.(); }
}
const last = () => FakeWS.instances[FakeWS.instances.length - 1];
const ackOk = { v: 1, ack: 'morphogen', ok: true };

beforeEach(() => {
  FakeWS.instances = [];
  globalThis.WebSocket = FakeWS;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
});
afterEach(() => {
  mock.timers.reset();
  delete globalThis.WebSocket;
});

test('reconnectDelayMs: equal jitter within [ceil/2, ceil), doubling, capped', () => {
  for (let a = 0; a < 12; a++) {
    const ceil = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** a);
    assert.equal(reconnectDelayMs(a, () => 0), Math.floor(ceil / 2));
    const hi = reconnectDelayMs(a, () => 0.999999);
    assert.ok(hi < ceil && hi >= ceil / 2, `attempt ${a}: ${hi}`);
  }
  assert.equal(reconnectDelayMs(0, () => 0), RECONNECT_BASE_MS / 2);
  assert.equal(reconnectDelayMs(1000, () => 0), RECONNECT_MAX_MS / 2); // no Infinity / NaN
  assert.equal(reconnectDelayMs(-3, () => 0), RECONNECT_BASE_MS / 2);
  assert.equal(reconnectDelayMs(NaN, () => 0), RECONNECT_BASE_MS / 2);
  assert.ok(reconnectDelayMs(2, () => 7) < RECONNECT_BASE_MS * 4); // bad rand clamped
});

test('handshake: hello only until ack ok, then telemetry pumps', () => {
  const td = new TdClient(SECRET, { rand: () => 0 });
  td.connect(URL_OK, 'companion', payload);
  const ws = last();
  ws.serverOpen();
  assert.equal(td.status, 'authenticating');
  mock.timers.tick(500);
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].hello, 'morphogen');
  assert.equal(ws.sent[0].auth, SECRET);
  ws.serverSend(ackOk);
  assert.equal(td.status, 'open');
  mock.timers.tick(160);
  assert.equal(ws.sent.length, 1 + 3);
  td.disconnect();
});

test('auth reject is terminal: no retry socket', () => {
  const td = new TdClient(SECRET, { rand: () => 0 });
  td.connect(URL_OK, 'companion', payload);
  last().serverOpen();
  last().serverSend({ v: 1, ack: 'morphogen', ok: false, reason: 'bad_auth' });
  assert.equal(td.status, 'error');
  assert.match(td.lastError, /bad_auth/);
  assert.ok(!td.lastError.includes(SECRET));
  mock.timers.tick(60_000);
  assert.equal(FakeWS.instances.length, 1);
});

test('ack timeout is terminal: no retry socket', () => {
  const td = new TdClient(SECRET, { rand: () => 0 });
  td.connect(URL_OK, 'companion', payload);
  last().serverOpen();
  mock.timers.tick(HELLO_ACK_TIMEOUT_MS + 1);
  assert.equal(td.status, 'error');
  mock.timers.tick(60_000);
  assert.equal(FakeWS.instances.length, 1);
});

test('close mid-handshake is terminal (does not re-send the secret)', () => {
  const td = new TdClient(SECRET, { rand: () => 0 });
  td.connect(URL_OK, 'companion', payload);
  last().serverOpen();
  last().serverDrop();
  assert.equal(td.status, 'error');
  mock.timers.tick(60_000);
  assert.equal(FakeWS.instances.length, 1);
});

test('TD not up yet: retries with growing delay, then succeeds and resets budget', () => {
  const seen = [];
  const td = new TdClient(SECRET, { rand: () => 0 });
  td.onStatus = (s) => seen.push(s);
  td.connect(URL_OK, 'companion', payload);
  last().serverDrop(); // refused before open
  assert.equal(td.status, 'reconnecting');
  assert.equal(td.reconnectAttempt, 1);
  mock.timers.tick(RECONNECT_BASE_MS / 2 - 1);
  assert.equal(FakeWS.instances.length, 1);
  mock.timers.tick(1);
  assert.equal(FakeWS.instances.length, 2);
  last().serverDrop();
  mock.timers.tick(RECONNECT_BASE_MS - 1); // attempt 1 floor = base
  assert.equal(FakeWS.instances.length, 2);
  mock.timers.tick(1);
  assert.equal(FakeWS.instances.length, 3);
  const ws = last();
  ws.serverOpen();
  assert.equal(ws.sent.length, 1, 'fresh hello on every retry');
  ws.serverSend(ackOk);
  assert.equal(td.status, 'open');
  assert.equal(td.reconnectAttempt, 0);
  assert.ok(seen.includes('reconnecting'));
  td.disconnect();
});

test('authed session drop retries from the base delay', () => {
  const td = new TdClient(SECRET, { rand: () => 0 });
  td.connect(URL_OK, 'companion', payload);
  last().serverOpen();
  last().serverSend(ackOk);
  last().serverDrop();
  assert.equal(td.status, 'reconnecting');
  assert.match(td.lastError, /dropped/);
  mock.timers.tick(RECONNECT_BASE_MS / 2);
  assert.equal(FakeWS.instances.length, 2);
  td.disconnect();
});

test('gives up after maxReconnectAttempts transient failures', () => {
  const td = new TdClient(SECRET, { rand: () => 0, maxReconnectAttempts: 3 });
  td.connect(URL_OK, 'companion', payload);
  for (let i = 0; i < 3; i++) {
    last().serverDrop();
    assert.equal(td.status, 'reconnecting');
    mock.timers.tick(RECONNECT_MAX_MS);
  }
  last().serverDrop();
  assert.equal(td.status, 'error');
  assert.match(td.lastError, /gave up after 3 retries/);
  mock.timers.tick(60_000);
  assert.equal(FakeWS.instances.length, 4);
});

test('disconnect cancels a pending retry; autoReconnect:false never retries', () => {
  const td = new TdClient(SECRET, { rand: () => 0 });
  td.connect(URL_OK, 'companion', payload);
  last().serverDrop();
  assert.equal(td.status, 'reconnecting');
  td.disconnect();
  assert.equal(td.status, 'idle');
  mock.timers.tick(60_000);
  assert.equal(FakeWS.instances.length, 1);

  const off = new TdClient(SECRET, { autoReconnect: false });
  off.connect(URL_OK, 'companion', payload);
  last().serverDrop();
  assert.equal(off.status, 'error');
  mock.timers.tick(60_000);
  assert.equal(FakeWS.instances.length, 2);
});

test('stale socket events after reconnect are ignored', () => {
  const td = new TdClient(SECRET, { rand: () => 0 });
  td.connect(URL_OK, 'companion', payload);
  const first = last();
  td.connect(URL_OK, 'companion', payload); // user reconnects manually
  const second = last();
  first.serverDrop(); // late close from the superseded socket
  assert.equal(td.status, 'connecting');
  second.serverOpen();
  second.serverSend(ackOk);
  assert.equal(td.status, 'open');
  td.disconnect();
});

test('bad token never opens a socket', () => {
  const td = new TdClient('short');
  td.connect(URL_OK, 'companion', payload);
  assert.equal(td.status, 'error');
  assert.equal(FakeWS.instances.length, 0);
});

// --- TD → app control plane (2026-10-21) ---

test('commands: only dispatched after the authed ack; ping answered in-client', () => {
  const got = [];
  const td = new TdClient(SECRET, { rand: () => 0, now: () => 0 });
  td.onCommand = (c) => got.push(c);
  td.connect(URL_OK, 'companion', payload);
  const ws = last();
  ws.serverOpen();
  ws.serverSend({ v: 1, cmd: 'preset', id: 'coral' }); // before ack: ignored
  assert.equal(got.length, 0);
  ws.serverSend(ackOk);
  ws.serverSend({ v: 1, cmd: 'preset', id: 'Coral' });
  ws.serverSend({ v: 1, cmd: 'setParams', feed: 1 }); // reserved: dropped
  ws.serverSend({ v: 1, cmd: 'ping', t: 42 });
  assert.deepEqual(got, [{ cmd: 'preset', id: 'coral' }]);
  assert.deepEqual(ws.sent.at(-1), { v: 1, pong: 'morphogen', t: 42 });
  assert.equal(td.status, 'open');
  td.disconnect();
});

test('commands: rate-limited, and a throwing handler does not break the session', () => {
  let n = 0;
  const td = new TdClient(SECRET, { rand: () => 0, now: () => 0 });
  td.onCommand = () => {
    n++;
    throw new Error('handler bug');
  };
  td.connect(URL_OK, 'companion', payload);
  const ws = last();
  ws.serverOpen();
  ws.serverSend(ackOk);
  for (let i = 0; i < 50; i++) ws.serverSend({ v: 1, cmd: 'preset', id: 'worms' });
  assert.equal(n, 5); // COMMAND_BURST at a frozen clock
  assert.equal(td.status, 'open');
  mock.timers.tick(100);
  assert.ok(ws.sent.length > 1, 'telemetry still pumping');
  td.disconnect();
});

test('status frames: latest TD rtt kept per session, junk refused, cleared on a fresh ack', () => {
  const got = [];
  const td = new TdClient(SECRET, { rand: () => 0, now: () => 0 });
  td.onCommand = (c) => got.push(c.cmd);
  td.connect(URL_OK, 'companion', payload);
  let ws = last();
  ws.serverOpen();
  ws.serverSend({ v: 1, cmd: 'status', rtt: { last_ms: 5, median_ms: 5, samples: 1, outstanding: 0, lost: 0 } }); // pre-ack
  assert.equal(td.tdRtt(), null);
  ws.serverSend(ackOk);
  ws.serverSend({ v: 1, cmd: 'status', rtt: { last_ms: 8, median_ms: 9.5, samples: 3, outstanding: 0, lost: 1 } });
  ws.serverSend({ v: 1, cmd: 'status', rtt: { last_ms: -1, median_ms: null, samples: 0, outstanding: 0, lost: 0 } }); // refused
  assert.deepEqual(td.tdRtt(), { lastMs: 8, medianMs: 9.5, samples: 3, outstanding: 0, lost: 1 });
  const copy = td.tdRtt();
  copy.lost = 99; // callers get a copy
  assert.equal(td.tdRtt().lost, 1);
  assert.deepEqual(got, ['status']);
  const s = td.commandStats();
  assert.equal(s.applied, 1);
  assert.equal(s.refused, 1);
  ws.serverDrop();
  mock.timers.tick(RECONNECT_BASE_MS);
  ws = last();
  ws.serverOpen();
  ws.serverSend(ackOk);
  assert.equal(td.tdRtt(), null, 'new session starts without the old TD figures');
  td.disconnect();
});
