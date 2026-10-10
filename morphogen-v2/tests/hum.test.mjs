// Hum audio safety: energy→detune sanitising, automation-event throttling,
// mute state across unlock, anchored ramps, gain ceiling, full dispose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HumEngine,
  energyToDetune,
  HUM_PARTIALS,
  HUM_LEVEL_ON,
  HUM_LEVEL_OFF,
  HUM_MAX_DETUNE,
} from '../.test-build/hum.mjs';

class FakeParam {
  constructor(v) { this.value = v; this.events = []; }
  setValueAtTime(v, t) { this.events.push(['set', v, t]); this.value = v; }
  linearRampToValueAtTime(v, t) { this.events.push(['lin', v, t]); this.value = v; }
  exponentialRampToValueAtTime(v, t) { this.events.push(['exp', v, t]); this.value = v; }
  setTargetAtTime(v, t, c) { this.events.push(['target', v, t, c]); }
  cancelScheduledValues(t) { this.events.push(['cancel', t]); }
}
class FakeNode {
  constructor(ctx) { ctx.nodes.push(this); this.connected = []; this.disconnected = 0; }
  connect(n) { this.connected.push(n); }
  disconnect() { this.disconnected++; }
}
class FakeCtx {
  constructor(state = 'suspended') {
    this.state = state; this.currentTime = 1; this.nodes = []; this.closed = false;
    this.destination = { dest: true };
  }
  createGain() { const n = new FakeNode(this); n.gain = new FakeParam(1); return n; }
  createDynamicsCompressor() {
    const n = new FakeNode(this);
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = new FakeParam(0);
    return n;
  }
  createOscillator() {
    const n = new FakeNode(this);
    n.frequency = new FakeParam(440); n.started = false; n.stopped = false;
    n.start = () => { n.started = true; }; n.stop = () => { n.stopped = true; };
    return n;
  }
  async resume() { this.state = 'running'; }
  async suspend() { this.state = 'suspended'; }
  async close() { this.closed = true; this.state = 'closed'; }
}
const make = () => { const box = {}; const hum = new HumEngine(() => (box.ctx = new FakeCtx())); return { hum, box }; };
const oscs = (ctx) => ctx.nodes.filter((n) => n.frequency);
const master = (ctx) => ctx.nodes.find((n) => n.gain && n.connected.length && n.connected[0].ratio);

test('energyToDetune clamps, quantises and maps non-finite to 0', () => {
  assert.equal(energyToDetune(NaN), 0);
  assert.equal(energyToDetune(Infinity), 0);
  assert.equal(energyToDetune(-5), 0);
  assert.equal(energyToDetune(10), HUM_MAX_DETUNE);
  assert.equal(energyToDetune(0.0625), HUM_MAX_DETUNE / 2);
  assert.equal(energyToDetune(0.0625), energyToDetune(0.06251)); // same quantum
});

test('unlock builds 4 partials, resumes, ramps in to HUM_LEVEL_ON anchored', async () => {
  const { hum, box } = make();
  assert.equal(await hum.unlock(), true);
  const os = oscs(box.ctx);
  assert.equal(os.length, 4);
  assert.deepEqual(os.map((o) => o.frequency.value), [...HUM_PARTIALS]);
  assert.ok(os.every((o) => o.started));
  const ev = master(box.ctx).gain.events;
  assert.deepEqual(ev[0], ['set', HUM_LEVEL_OFF, 1]);
  assert.equal(ev[1][0], 'exp');
  assert.equal(ev[1][1], HUM_LEVEL_ON);
  assert.equal(await hum.unlock(), true); // idempotent, no second graph
  assert.equal(oscs(box.ctx).length, 4);
});

test('no AudioContext available → unlock false, engine stays inert', async () => {
  const hum = new HumEngine(() => null);
  assert.equal(await hum.unlock(), false);
  hum.modulate(1); hum.setMuted(true); hum.dispose(); // no throw
});

test('muting before unlock skips the ramp-in', async () => {
  const { hum, box } = make();
  hum.setMuted(true);
  await hum.unlock();
  const g = master(box.ctx).gain;
  assert.equal(g.events.length, 0);
  assert.equal(g.value, HUM_LEVEL_OFF);
  assert.equal(hum.isMuted, true);
});

test('setMuted cancels, anchors at current value, ramps within gain ceiling', async () => {
  const { hum, box } = make();
  await hum.unlock();
  const g = master(box.ctx).gain;
  g.events.length = 0;
  g.value = 3; // pretend something pushed it past the ceiling
  hum.setMuted(false);
  assert.deepEqual(g.events[0], ['cancel', 1]);
  assert.deepEqual(g.events[1], ['set', HUM_LEVEL_ON, 1]);
  assert.equal(g.events[2][0], 'lin');
  hum.setMuted(true);
  assert.equal(g.events.at(-1)[1], HUM_LEVEL_OFF);
});

test('modulate ignores NaN and only schedules when detune changes', async () => {
  const { hum, box } = make();
  await hum.unlock();
  const [o0] = oscs(box.ctx);
  for (let i = 0; i < 600; i++) hum.modulate(0.05); // 10 s at 60 fps, flat energy
  assert.equal(o0.frequency.events.length, 1);
  hum.modulate(NaN);
  const last = o0.frequency.events.at(-1);
  assert.ok(Number.isFinite(last[1]));
  assert.equal(last[1], HUM_PARTIALS[0]); // NaN → zero detune
  hum.modulate(1);
  assert.ok(Math.abs(o0.frequency.events.at(-1)[1] - HUM_PARTIALS[0] * (1 + HUM_MAX_DETUNE)) < 1e-9);
});

test('dispose stops oscillators, disconnects every node incl. compressor, closes ctx', async () => {
  const { hum, box } = make();
  await hum.unlock();
  hum.dispose();
  assert.ok(oscs(box.ctx).every((o) => o.stopped));
  assert.ok(box.ctx.nodes.every((n) => n.disconnected >= 1), 'a node was left connected');
  assert.equal(box.ctx.closed, true);
  assert.equal(await hum.unlock(), false); // never resurrects
  hum.dispose(); // idempotent
});

test('dispose during a pending resume makes unlock resolve false', async () => {
  const { hum } = make();
  const p = hum.unlock();
  hum.dispose();
  assert.equal(await p, false);
});
