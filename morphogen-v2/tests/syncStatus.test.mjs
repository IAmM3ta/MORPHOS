// Morphogen v2 Sync status chip tests (node:test, no browser) — 2026-10-07.
// Run: npm test   (esbuild bundles tdClient.ts + panels.ts → .test-build/, then node --test)
// Covers describeTdStatus (pure status → label/tone/countdown), TdClient.snapshot(),
// TdClient.retryNow() (skips the wait, never resets the budget, never revives a
// terminal failure) and mountSyncStatus (countdown ticks only while reconnecting).
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  TdClient,
  describeTdStatus,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_ATTEMPTS,
} from '../.test-build/tdClient.mjs';
import { mountSyncStatus, SYNC_COUNTDOWN_TICK_MS } from '../.test-build/panels.mjs';

const URL_OK = 'ws://127.0.0.1:9980';
const SECRET = 'correct-horse-battery';
const payload = () => ({ v: 1, t: 0, params: {}, sensors: {}, audio: {}, field: {}, loop: { count: 0 }, touches: [] });

class FakeWS {
  static OPEN = 1;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    FakeWS.instances.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  serverOpen() { this.readyState = 1; this.onopen?.(); }
  serverSend(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  serverDrop() { this.readyState = 3; this.onerror?.(); this.onclose?.(); }
}
const last = () => FakeWS.instances[FakeWS.instances.length - 1];

/** Just enough DOM for the chip: textContent, dataset, hidden, click listeners. */
function fakeEl() {
  const listeners = [];
  return {
    textContent: '',
    dataset: {},
    hidden: false,
    addEventListener: (_t, fn) => listeners.push(fn),
    removeEventListener: (_t, fn) => listeners.splice(listeners.indexOf(fn), 1),
    click() { listeners.slice().forEach((fn) => fn()); },
    get listenerCount() { return listeners.length; },
  };
}

const snap = (over) => ({
  status: 'idle', lastError: null, reconnectAttempt: 0, maxReconnectAttempts: 8, nextRetryAt: null, ...over,
});

beforeEach(() => {
  FakeWS.instances = [];
  globalThis.WebSocket = FakeWS;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
});
afterEach(() => {
  mock.timers.reset();
  delete globalThis.WebSocket;
});

test('describeTdStatus: one tone per state, countdown only while reconnecting', () => {
  assert.deepEqual(describeTdStatus(snap({})), { label: 'Sync off', tone: 'idle', countdownMs: null, canRetryNow: false });
  assert.equal(describeTdStatus(snap({ status: 'connecting' })).label, 'Sync: connecting…');
  assert.match(describeTdStatus(snap({ status: 'connecting', reconnectAttempt: 3 })).label, /try 3\/8/);
  assert.equal(describeTdStatus(snap({ status: 'authenticating' })).tone, 'busy');
  assert.equal(describeTdStatus(snap({ status: 'open' })).tone, 'ok');
  const err = describeTdStatus(snap({ status: 'error', lastError: 'TD rejected hello (bad_auth)' }));
  assert.equal(err.tone, 'error');
  assert.equal(err.label, 'Sync error: TD rejected hello (bad_auth)');
  assert.equal(err.canRetryNow, false, 'terminal errors need a fresh connect, not a retry');
  for (const s of ['idle', 'connecting', 'authenticating', 'open', 'error']) {
    assert.equal(describeTdStatus(snap({ status: s })).countdownMs, null, s);
  }
});

test('describeTdStatus: countdown rounds up, clamps at 0, uses caller clock', () => {
  const r = snap({ status: 'reconnecting', reconnectAttempt: 2, nextRetryAt: 10_000 });
  const v = describeTdStatus(r, 8_760);
  assert.equal(v.countdownMs, 1_240);
  assert.equal(v.tone, 'warn');
  assert.equal(v.canRetryNow, true);
  assert.equal(v.label, 'Sync: TD unreachable — retry 2/8 in 1.3 s');
  assert.match(describeTdStatus(r, 9_999).label, /in 0\.1 s$/, 'never shows 0.0 while pending');
  const late = describeTdStatus(r, 12_000);
  assert.equal(late.countdownMs, 0);
  assert.match(late.label, /in 0\.0 s$/);
  assert.equal(describeTdStatus(snap({ status: 'reconnecting', nextRetryAt: null }), 5).countdownMs, 0);
});

test('snapshot mirrors client state and carries the budget', () => {
  const td = new TdClient(SECRET, { rand: () => 0 });
  assert.deepEqual(td.snapshot(), snap({ maxReconnectAttempts: RECONNECT_MAX_ATTEMPTS }));
  td.connect(URL_OK, 'companion', payload);
  last().serverDrop();
  const s = td.snapshot();
  assert.equal(s.status, 'reconnecting');
  assert.equal(s.reconnectAttempt, 1);
  assert.equal(s.nextRetryAt, Date.now() + RECONNECT_BASE_MS / 2);
  assert.ok(!JSON.stringify(s).includes(SECRET), 'snapshot never leaks the token');
  td.disconnect();
});

test('retryNow skips the backoff wait but keeps the budget', () => {
  const td = new TdClient(SECRET, { rand: () => 0, maxReconnectAttempts: 2 });
  td.connect(URL_OK, 'companion', payload);
  last().serverDrop();
  assert.equal(td.retryNow(), true);
  assert.equal(FakeWS.instances.length, 2, 'socket opened immediately');
  assert.equal(td.status, 'connecting');
  assert.equal(td.reconnectAttempt, 1, 'budget not reset');
  mock.timers.tick(60_000);
  assert.equal(FakeWS.instances.length, 2, 'cancelled timer does not fire a duplicate socket');
  last().serverDrop();
  assert.equal(td.reconnectAttempt, 2);
  td.retryNow();
  last().serverDrop();
  assert.equal(td.status, 'error', 'mashing retry cannot exceed maxReconnectAttempts');
  assert.match(td.lastError, /gave up after 2 retries/);
});

test('retryNow is a no-op outside reconnecting (idle, open, terminal error)', () => {
  const td = new TdClient(SECRET, { rand: () => 0 });
  assert.equal(td.retryNow(), false);
  td.connect(URL_OK, 'companion', payload);
  last().serverOpen();
  last().serverSend({ v: 1, ack: 'morphogen', ok: false, reason: 'bad_auth' });
  assert.equal(td.status, 'error');
  assert.equal(td.retryNow(), false, 'auth reject stays terminal');
  assert.equal(FakeWS.instances.length, 1);
});

test('mountSyncStatus: renders, ticks only while reconnecting, retry button, unmount restores', () => {
  const td = new TdClient(SECRET, { rand: () => 0.99 }); // first retry in 497 ms
  const seen = [];
  td.onStatus = (s) => seen.push(s);
  const chip = fakeEl();
  const btn = fakeEl();
  const unmount = mountSyncStatus(chip, btn, td);
  assert.equal(chip.textContent, 'Sync off');
  assert.equal(chip.dataset.tone, 'idle');
  assert.equal(btn.hidden, true);

  td.connect(URL_OK, 'companion', payload);
  assert.equal(chip.dataset.tone, 'busy');
  last().serverDrop(); // retry in floor(250 + 0.99·250) = 497 ms
  assert.equal(chip.dataset.tone, 'warn');
  assert.equal(btn.hidden, false);
  assert.match(chip.textContent, /retry 1\/8 in 0\.5 s/);
  mock.timers.tick(SYNC_COUNTDOWN_TICK_MS - 1);
  assert.match(chip.textContent, /in 0\.5 s/, 'no re-render before the first tick');
  mock.timers.tick(1); // 250 ms: tick re-renders from nextRetryAt, retry (497 ms) not yet due
  assert.match(chip.textContent, /in 0\.3 s/);
  assert.equal(FakeWS.instances.length, 1);

  btn.click(); // Retry now
  assert.equal(FakeWS.instances.length, 2);
  assert.equal(chip.textContent, 'Sync: reconnecting (try 1/8)…');
  assert.equal(btn.hidden, true);
  last().serverOpen();
  last().serverSend({ v: 1, ack: 'morphogen', ok: true });
  assert.equal(chip.textContent, 'Sync: live → TD');
  assert.equal(chip.dataset.tone, 'ok');
  assert.ok(seen.includes('open'), 'pre-existing onStatus handler still called');

  td.disconnect();
  unmount();
  assert.equal(btn.listenerCount, 0);
  assert.equal(chip.textContent, 'Sync off');
  td.connect(URL_OK, 'companion', payload);
  assert.equal(chip.textContent, 'Sync off', 'unmounted chip no longer updates');
  td.disconnect();
});
