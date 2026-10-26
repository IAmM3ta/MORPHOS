// Morphogen v2 Sync command line tests (2026-10-26, node:test, no browser).
// Run: npm test
// Covers mountSyncCommandLine: the "TD cmds: …" line next to the Sync chip is
// hidden unless the session is authed, refreshes on a slow tick only while
// live (no timer when Sync is off), turns "warn" on refused / paced frames,
// only touches the DOM when the text changes, and unmount restores onStatus.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { TdClient } from '../.test-build/tdClient.mjs';
import { mountSyncCommandLine, SYNC_CMDS_TICK_MS } from '../.test-build/panels.mjs';
import { COMMAND_BURST } from '../.test-build/tdCommand.mjs';

const URL_OK = 'ws://127.0.0.1:9980';
const SECRET = 'correct-horse-battery';
const payload = () => ({ v: 1, t: 0, params: {}, sensors: {}, audio: {}, field: {}, loop: { count: 0 }, touches: [] });
const ackOk = { v: 1, ack: 'morphogen', ok: true };

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

beforeEach(() => {
  FakeWS.instances = [];
  globalThis.WebSocket = FakeWS;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
});
afterEach(() => {
  mock.timers.reset();
  delete globalThis.WebSocket;
});

test('mountSyncCommandLine: hidden until authed, then shows the live tally', () => {
  const td = new TdClient(SECRET, { rand: () => 0 });
  td.onCommand = () => {};
  const el = fakeEl();
  const unmount = mountSyncCommandLine(el, td);
  assert.equal(el.hidden, true, 'Sync off: hidden');
  assert.equal(el.writes, 0, 'nothing rendered while hidden');

  td.connect(URL_OK, 'companion', payload);
  last().serverOpen();
  assert.equal(el.hidden, true, 'waiting for ack: still hidden');
  last().serverSend(ackOk);
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, 'TD cmds: none yet');
  assert.equal(el.dataset.tone, 'ok');

  last().serverSend({ v: 1, cmd: 'preset', id: 'coral' });
  last().serverSend({ v: 1, cmd: 'ping', t: 5 });
  assert.equal(el.textContent, 'TD cmds: none yet', 'no re-render before the tick');
  mock.timers.tick(SYNC_CMDS_TICK_MS);
  assert.equal(el.textContent, 'TD cmds: 1 applied · 1 ping');
  assert.equal(el.dataset.tone, 'ok');
  unmount();
});

test('mountSyncCommandLine: refused / paced frames turn the line warn', () => {
  const td = new TdClient(SECRET, { rand: () => 0 });
  td.onCommand = () => {};
  const el = fakeEl();
  mountSyncCommandLine(el, td);
  td.connect(URL_OK, 'companion', payload);
  last().serverOpen();
  last().serverSend(ackOk);
  last().serverSend({ v: 1, cmd: 'freeze' }); // refused by the parser
  mock.timers.tick(SYNC_CMDS_TICK_MS);
  assert.match(el.textContent, /1 refused/);
  assert.equal(el.dataset.tone, 'warn');
  for (let i = 0; i < COMMAND_BURST + 2; i++) last().serverSend({ v: 1, cmd: 'preset', id: 'mazes' });
  mock.timers.tick(SYNC_CMDS_TICK_MS);
  assert.match(el.textContent, /paced/);
});

test('mountSyncCommandLine: no timer while off, DOM written only on change, hides on drop', () => {
  const td = new TdClient(SECRET, { rand: () => 0.99 });
  const el = fakeEl();
  const unmount = mountSyncCommandLine(el, td);
  mock.timers.tick(SYNC_CMDS_TICK_MS * 5);
  assert.equal(el.writes, 0, 'idle Sync costs no renders');

  td.connect(URL_OK, 'companion', payload);
  last().serverOpen();
  last().serverSend(ackOk);
  const afterLive = el.writes;
  mock.timers.tick(SYNC_CMDS_TICK_MS * 3);
  assert.equal(el.writes, afterLive, 'unchanged text is not rewritten');

  last().serverDrop();
  assert.equal(el.hidden, true, 'a dropped session never shows a stale tally');
  unmount();
});

test('mountSyncCommandLine: chains and restores an existing onStatus handler', () => {
  const td = new TdClient(SECRET, { rand: () => 0 });
  const seen = [];
  const prev = (s) => seen.push(s);
  td.onStatus = prev;
  const el = fakeEl();
  const unmount = mountSyncCommandLine(el, td);
  td.connect(URL_OK, 'companion', payload);
  assert.ok(seen.includes('connecting'), 'previous handler still called');
  unmount();
  assert.equal(td.onStatus, prev);
  td.disconnect();
});
