// Morphogen v2 TD command tally tests (2026-10-24, node:test, no browser).
// Run: npm test
// Covers describeCommandStats (pure text) and TdClient.commandStats(): every
// authed frame lands in exactly one bucket, the tally resets on a fresh ack,
// frames before the ack are never counted, and nothing sensitive is kept.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { TdClient } from '../.test-build/tdClient.mjs';
import { describeCommandStats, emptyCommandStats, COMMAND_BURST } from '../.test-build/tdCommand.mjs';

const URL_OK = 'ws://127.0.0.1:9980';
const SECRET = 'correct-horse-battery';
const payload = () => ({ v: 1, t: 0, params: {}, sensors: {}, audio: {}, field: {}, loop: { count: 0 }, touches: [] });

/** Minimal WebSocket double (same shape as tests/tdClient.test.mjs). */
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
  serverSend(obj) { this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
  serverDrop() { this.readyState = 3; this.onerror?.(); this.onclose?.(); }
}
const last = () => FakeWS.instances[FakeWS.instances.length - 1];
const ackOk = { v: 1, ack: 'morphogen', ok: true };
const buckets = (s) => s.applied + s.pings + s.refused + s.paced;

beforeEach(() => {
  FakeWS.instances = [];
  globalThis.WebSocket = FakeWS;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
});
afterEach(() => {
  mock.timers.reset();
  delete globalThis.WebSocket;
});

test('describeCommandStats: zero buckets hidden, plurals, empty session', () => {
  assert.equal(describeCommandStats(emptyCommandStats()), 'TD cmds: none yet');
  assert.equal(
    describeCommandStats({ ...emptyCommandStats(), frames: 6, applied: 3, pings: 1, paced: 2 }),
    'TD cmds: 3 applied · 1 ping · 2 paced',
  );
  assert.equal(
    describeCommandStats({ ...emptyCommandStats(), frames: 4, refused: 2, pings: 2, applied: 0, handlerErrors: 0 }),
    'TD cmds: 2 pings · 2 refused',
  );
  assert.match(describeCommandStats({ ...emptyCommandStats(), applied: 1, handlerErrors: 1 }), /1 handler error$/);
  // Garbage numbers never render as "NaN applied".
  assert.equal(describeCommandStats({ ...emptyCommandStats(), applied: NaN, paced: -1 }), 'TD cmds: none yet');
});

test('commandStats: one bucket per authed frame; pre-ack frames not counted', () => {
  let clock = 1000;
  const td = new TdClient(SECRET, { rand: () => 0, now: () => clock });
  td.onCommand = () => {};
  td.connect(URL_OK, 'companion', payload);
  const ws = last();
  ws.serverOpen();
  ws.serverSend({ v: 1, cmd: 'preset', id: 'coral' }); // before ack: not a command frame
  assert.deepEqual(td.commandStats(), emptyCommandStats());
  ws.serverSend(ackOk);
  ws.serverSend({ v: 1, cmd: 'preset', id: 'coral' });
  ws.serverSend({ v: 1, cmd: 'ping', t: 5 });
  ws.serverSend({ v: 1, cmd: 'setParams', feed: 1 }); // reserved
  ws.serverSend('not json');
  const s = td.commandStats();
  assert.equal(s.frames, 4);
  assert.equal(s.applied, 1);
  assert.equal(s.pings, 1);
  assert.equal(s.refused, 2);
  assert.equal(s.paced, 0);
  assert.equal(buckets(s), s.frames);
  assert.equal(s.lastAt, 1000);
  // Refused frames don't spend rate tokens: the full burst is still there.
  for (let i = 0; i < COMMAND_BURST + 3; i++) ws.serverSend({ v: 1, cmd: 'preset', id: 'worms' });
  const t = td.commandStats();
  assert.equal(t.applied + t.pings, COMMAND_BURST, 'burst shared by preset + ping');
  assert.equal(t.paced, 5); // 8 sent, 3 tokens were left after the preset + ping
  assert.equal(buckets(t), t.frames);
  td.disconnect();
});

test('commandStats: handler errors counted, copy is detached, reset on fresh ack', () => {
  const td = new TdClient(SECRET, { rand: () => 0, now: () => 0 });
  td.onCommand = () => {
    throw new Error('handler bug');
  };
  td.connect(URL_OK, 'companion', payload);
  let ws = last();
  ws.serverOpen();
  ws.serverSend(ackOk);
  ws.serverSend({ v: 1, cmd: 'preset', id: 'coral' });
  const s = td.commandStats();
  assert.equal(s.applied, 1);
  assert.equal(s.handlerErrors, 1);
  s.applied = 99; // mutating the copy must not touch the client
  assert.equal(td.commandStats().applied, 1);
  assert.ok(!JSON.stringify(td.commandStats()).includes(SECRET), 'no token in the tally');
  assert.ok(!JSON.stringify(td.commandStats()).includes('coral'), 'no payload text kept');

  // Drop → backoff retry → new socket → new ack: tally starts from zero.
  ws.serverDrop();
  assert.equal(td.status, 'reconnecting');
  mock.timers.tick(1000);
  ws = last();
  ws.serverOpen();
  assert.equal(td.commandStats().applied, 1, 'kept while re-authenticating');
  ws.serverSend(ackOk);
  assert.deepEqual(td.commandStats(), emptyCommandStats());
  td.disconnect();
});
