// Morphogen v2 Sync TD RTT line tests (2026-10-30, node:test, no browser).
// Run: npm test
// Covers mountSyncRttLine: the "TD rtt: …" chip next to the TD cmds chip is
// hidden until the session is authed AND TD has sent a status frame, shows the
// exact describeTdRtt text, turns "warn" when TD reports lost pings, never
// shows a previous session's figures after a drop / re-ack, costs no timer
// while Sync is off, and unmount restores the onStatus chain.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { TdClient } from '../.test-build/tdClient.mjs';
import { mountSyncRttLine, mountSyncCommandLine, SYNC_RTT_TICK_MS } from '../.test-build/panels.mjs';

const URL_OK = 'ws://127.0.0.1:9980';
const SECRET = 'correct-horse-battery';
const payload = () => ({ v: 1, t: 0, params: {}, sensors: {}, audio: {}, field: {}, loop: { count: 0 }, touches: [] });
const ackOk = { v: 1, ack: 'morphogen', ok: true };
const status = (rtt) => ({ v: 1, cmd: 'status', rtt: { last_ms: null, median_ms: null, samples: 0, outstanding: 0, lost: 0, ...rtt } });

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

/** Element double that counts textContent writes. */
function fakeEl() {
  let text = '';
  return {
    writes: 0,
    dataset: {},
    hidden: false,
    get textContent() { return text; },
    set textContent(v) { text = v; this.writes += 1; },
  };
}

function liveClient(rand = 0) {
  const td = new TdClient(SECRET, { rand: () => rand });
  td.onCommand = () => {};
  return td;
}
function authed(td) {
  td.connect(URL_OK, 'companion', payload);
  last().serverOpen();
  last().serverSend(ackOk);
}

beforeEach(() => {
  FakeWS.instances = [];
  globalThis.WebSocket = FakeWS;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
});
afterEach(() => {
  mock.timers.reset();
  delete globalThis.WebSocket;
});

test('mountSyncRttLine: hidden until authed and TD has sent a status frame', () => {
  const td = liveClient();
  const el = fakeEl();
  const unmount = mountSyncRttLine(el, td);
  assert.equal(el.hidden, true, 'Sync off: hidden');
  authed(td);
  assert.equal(el.hidden, true, 'authed but no status frame yet: hidden');
  assert.equal(el.writes, 0);

  last().serverSend(status({}));
  mock.timers.tick(SYNC_RTT_TICK_MS);
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, 'TD rtt: no pongs yet');
  assert.equal(el.dataset.tone, 'ok');

  last().serverSend(status({ last_ms: 8, median_ms: 9.5, samples: 3 }));
  mock.timers.tick(SYNC_RTT_TICK_MS);
  assert.equal(el.textContent, 'TD rtt: 8.0 ms (median 9.5)');
  assert.equal(el.dataset.tone, 'ok');
  unmount();
});

test('mountSyncRttLine: lost pings turn the line warn with the shared text', () => {
  const td = liveClient();
  const el = fakeEl();
  mountSyncRttLine(el, td);
  authed(td);
  last().serverSend(status({ last_ms: 8.25, median_ms: 9.5, samples: 3, lost: 2 }));
  mock.timers.tick(SYNC_RTT_TICK_MS);
  // 8.25 is an exact tie: JS toFixed and TD's _fmt_ms both give 8.3 (fixture rtt_lines).
  assert.equal(el.textContent, 'TD rtt: 8.3 ms (median 9.5) · 2 lost');
  assert.equal(el.dataset.tone, 'warn');
});

test('mountSyncRttLine: a bad status frame changes nothing on screen', () => {
  const td = liveClient();
  const el = fakeEl();
  mountSyncRttLine(el, td);
  authed(td);
  last().serverSend(status({ last_ms: 4, median_ms: 4, samples: 1 }));
  mock.timers.tick(SYNC_RTT_TICK_MS);
  const before = el.textContent;
  last().serverSend(status({ lost: -1 })); // refused by parseTdRtt
  mock.timers.tick(SYNC_RTT_TICK_MS);
  assert.equal(el.textContent, before);
});

test('mountSyncRttLine: no timer while off, no rewrite of unchanged text, stale figures never shown', () => {
  const td = liveClient(0); // rand 0 -> shortest backoff, so the reconnect below happens on a tick
  const el = fakeEl();
  const unmount = mountSyncRttLine(el, td);
  mock.timers.tick(SYNC_RTT_TICK_MS * 5);
  assert.equal(el.writes, 0, 'idle Sync costs no renders');

  authed(td);
  last().serverSend(status({ last_ms: 5, median_ms: 5, samples: 1, lost: 1 }));
  mock.timers.tick(SYNC_RTT_TICK_MS);
  const writes = el.writes;
  mock.timers.tick(SYNC_RTT_TICK_MS * 3);
  assert.equal(el.writes, writes, 'unchanged text is not rewritten');

  last().serverDrop();
  assert.equal(el.hidden, true, 'dropped session: hidden');
  // Let the reconnect fire, then re-ack: tdRtt() is cleared, so stay hidden.
  const sockets = FakeWS.instances.length;
  mock.timers.tick(60_000);
  assert.equal(FakeWS.instances.length, sockets + 1, 'reconnect opened a new socket');
  last().serverOpen();
  last().serverSend(ackOk);
  assert.equal(td.snapshot().status, 'open');
  mock.timers.tick(SYNC_RTT_TICK_MS);
  assert.equal(el.hidden, true, 'fresh session with no status frame yet: hidden');
  unmount();
  td.disconnect();
});

test('mountSyncRttLine: stacks with mountSyncCommandLine and unmounts LIFO', () => {
  const td = liveClient();
  const seen = [];
  const prev = (s) => seen.push(s);
  td.onStatus = prev;
  const cmds = fakeEl();
  const rtt = fakeEl();
  const unCmds = mountSyncCommandLine(cmds, td);
  const unRtt = mountSyncRttLine(rtt, td);
  authed(td);
  assert.ok(seen.includes('open'), 'original handler still called');
  assert.equal(cmds.hidden, false, 'cmds chip still driven');
  unRtt();
  unCmds();
  assert.equal(td.onStatus, prev);
  td.disconnect();
});
