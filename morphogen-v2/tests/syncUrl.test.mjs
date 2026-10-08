// Morphogen v2 Sync URL hygiene tests (node:test, no browser) — 2026-10-08.
// Run: npm test   (esbuild bundles syncUrl.ts + tdClient.ts → .test-build/, then node --test)
// Covers classifyTdHost (loopback / *.local / remote), sanitizeTdUrl (canonical
// form, credential / scheme / control-char rejection, reasons never echo input),
// validateTdUrl per path incl. the remote-wss confirm, TdClient.connect opening
// the canonical URL only, and load/saveSyncSettings (schema-checked rehydrate,
// no secret persisted, remote host always needs a fresh confirm).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTdHost,
  sanitizeTdUrl,
  tdUrlNeedsConfirm,
  defaultTdGrid,
  remoteConfirmMessage,
  loadSyncSettings,
  saveSyncSettings,
  SYNC_SETTINGS_KEY,
  DEFAULT_SYNC_SETTINGS,
  MAX_TD_URL_LEN,
} from '../.test-build/syncUrl.mjs';
import { TdClient, validateTdUrl } from '../.test-build/tdClient.mjs';

class FakeWS {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; FakeWS.instances.push(this); }
  send() {}
  close() { this.readyState = 3; }
}

/** In-memory Storage with the three methods syncUrl uses. */
function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    raw: m,
  };
}

const SECRET = 'correct-horse-battery';
const payload = () => ({ v: 1, t: 0, params: {}, sensors: {}, audio: {}, field: {}, loop: { count: 0 }, touches: [] });

beforeEach(() => {
  FakeWS.instances = [];
  globalThis.WebSocket = FakeWS;
});

test('classifyTdHost: loopback, *.local, everything else remote', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]', 'LOCALHOST', 'localhost.']) {
    assert.equal(classifyTdHost(h), 'loopback', h);
  }
  for (const h of ['studio-pc.local', 'td.stage.local', 'td.local.']) {
    assert.equal(classifyTdHost(h), 'mdns', h);
  }
  for (const h of ['local', 'x..local', '-bad.local', 'under_score.local', 'evil.example', '192.168.1.20', 'localhost.evil.com', '127.0.0.1.nip.io']) {
    assert.equal(classifyTdHost(h), 'remote', h);
  }
});

test('sanitizeTdUrl: canonical ws/wss URL, fragment stripped', () => {
  const s = sanitizeTdUrl('  WS://LocalHost:9980#frag  ');
  assert.equal(s.ok, true);
  assert.equal(s.url, 'ws://localhost:9980/');
  assert.equal(s.hostClass, 'loopback');
  assert.equal(s.scheme, 'ws:');
  const r = sanitizeTdUrl('wss://td.stage.local/morphogen?room=1');
  assert.equal(r.url, 'wss://td.stage.local/morphogen?room=1');
  assert.equal(r.hostClass, 'mdns');
});

test('sanitizeTdUrl: rejects bad input without echoing it', () => {
  const secretish = 'hunter2-hunter2-hunter2';
  const cases = [
    [42, /text/],
    ['', /empty/],
    ['http://127.0.0.1:9980', /ws:\/\/ or wss:\/\//],
    ['javascript:alert(1)', /ws:\/\/ or wss:\/\//],
    [`wss://user:${secretish}@td.example`, /credentials/],
    [`ws://127.0.0.1:9980/${secretish} x`, /spaces or control/],
    ['ws://127.0.0.1:99\t80', /spaces or control/],
    ['not a url', /spaces or control|Invalid URL/],
    ['ws://', /Invalid URL|no host/],
    ['ws://127.0.0.1/' + 'a'.repeat(MAX_TD_URL_LEN), /too long/],
  ];
  for (const [input, re] of cases) {
    const s = sanitizeTdUrl(input);
    assert.equal(s.ok, false, String(input));
    assert.match(s.reason, re, String(input));
    assert.ok(!s.reason.includes(secretish), 'reason must not echo input');
  }
});

test('confirm + grid helpers', () => {
  assert.equal(tdUrlNeedsConfirm(sanitizeTdUrl('wss://td.example')), true);
  assert.equal(tdUrlNeedsConfirm(sanitizeTdUrl('wss://td.local')), false);
  assert.equal(tdUrlNeedsConfirm(sanitizeTdUrl('nope')), false);
  assert.equal(defaultTdGrid('loopback'), true);
  assert.equal(defaultTdGrid('mdns'), false);
  assert.equal(defaultTdGrid('remote'), false);
  const msg = remoteConfirmMessage('td.example');
  assert.match(msg, /td\.example/);
  assert.match(msg, /\*\.local/);
});

test('validateTdUrl: companion allows loopback + *.local over ws, refuses remote', () => {
  assert.equal(validateTdUrl('ws://127.0.0.1:9980', 'companion').ok, true);
  assert.equal(validateTdUrl('ws://studio-pc.local:9980', 'companion').ok, true);
  const remote = validateTdUrl('ws://evil.example:9980', 'companion', { confirmRemote: true });
  assert.equal(remote.ok, false, 'confirm never unlocks cleartext to a remote host');
  assert.match(remote.reason, /allowlist/);
  assert.equal(validateTdUrl('wss://127.0.0.1:9980', 'companion').ok, false);
  assert.equal(validateTdUrl('ws://127.0.0.1:9980', 'midi').ok, false);
});

test('validateTdUrl: wss remote host needs explicit confirm', () => {
  assert.equal(validateTdUrl('wss://td.local', 'wss').ok, true);
  const pending = validateTdUrl('wss://td.example', 'wss');
  assert.equal(pending.ok, false);
  assert.equal(pending.needsConfirm, true);
  assert.equal(pending.hostClass, 'remote');
  assert.match(pending.reason, /Confirm remote TD host td\.example/);
  const ok = validateTdUrl('wss://td.example', 'wss', { confirmRemote: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.url, 'wss://td.example/');
  assert.equal(validateTdUrl('ws://td.example', 'wss', { confirmRemote: true }).ok, false);
});

test('TdClient.connect: unconfirmed remote opens no socket; socket uses canonical URL', () => {
  const td = new TdClient(SECRET, { autoReconnect: false });
  td.connect('wss://td.example', 'wss', payload);
  assert.equal(td.status, 'error');
  assert.equal(FakeWS.instances.length, 0);
  td.connect('  wss://TD.example#x ', 'wss', payload, { confirmRemote: true });
  assert.equal(FakeWS.instances.length, 1);
  assert.equal(FakeWS.instances[0].url, 'wss://td.example/');
  td.disconnect();
});

test('loadSyncSettings: missing / no storage → defaults, nothing dropped', () => {
  assert.deepEqual(loadSyncSettings(null), { ...DEFAULT_SYNC_SETTINGS, needsConfirm: false, dropped: null });
  assert.deepEqual(loadSyncSettings(fakeStorage()), { ...DEFAULT_SYNC_SETTINGS, needsConfirm: false, dropped: null });
});

test('save → load round-trip; remote host always needs a fresh confirm', () => {
  const st = fakeStorage();
  assert.equal(saveSyncSettings(st, { url: 'wss://td.example/x#f', path: 'wss', grid: false }), true);
  const stored = JSON.parse(st.raw.get(SYNC_SETTINGS_KEY));
  assert.deepEqual(stored, { v: 1, url: 'wss://td.example/x', path: 'wss', grid: false });
  const loaded = loadSyncSettings(st);
  assert.equal(loaded.url, 'wss://td.example/x');
  assert.equal(loaded.needsConfirm, true);
  assert.equal(loaded.dropped, null);
  assert.equal(saveSyncSettings(st, { url: 'http://nope', path: 'wss', grid: false }), false, 'invalid URL not saved');
  assert.equal(saveSyncSettings(st, { url: 'wss://td.local', path: 'bogus', grid: false }), false, 'invalid path not saved');
});

test('loadSyncSettings: tampered / corrupt records are wiped, not trusted', () => {
  const bad = [
    ['{not json', /valid JSON/],
    ['[1,2]', /malformed/],
    ['null', /malformed/],
    [JSON.stringify({ v: 9, url: 'ws://127.0.0.1:9980', path: 'companion' }), /unknown version/],
    [JSON.stringify({ v: 1, url: 'ws://127.0.0.1:9980', path: 'telnet' }), /path invalid/],
    [JSON.stringify({ v: 1, url: 'wss://u:p@evil.example', path: 'wss' }), /credentials/],
    [JSON.stringify({ v: 1, url: 'x'.repeat(5000), path: 'wss' }), /too large/],
  ];
  for (const [raw, re] of bad) {
    const st = fakeStorage({ [SYNC_SETTINGS_KEY]: raw });
    const out = loadSyncSettings(st);
    assert.match(out.dropped, re, raw.slice(0, 40));
    assert.equal(out.url, DEFAULT_SYNC_SETTINGS.url);
    assert.equal(out.needsConfirm, false);
    assert.equal(st.raw.has(SYNC_SETTINGS_KEY), false, 'bad record removed');
  }
});

test('loadSyncSettings: stray keys inert, stored secret scrubbed, grid default by host', () => {
  const st = fakeStorage({
    // Raw JSON so "__proto__" is a real own key (an object literal would set the prototype instead).
    [SYNC_SETTINGS_KEY]:
      `{"v":1,"url":"ws://studio-pc.local:9980","path":"companion","auth":"${SECRET}","__proto__":{"polluted":true},"extra":1}`,
  });
  const out = loadSyncSettings(st);
  assert.deepEqual(Object.keys(out).sort(), ['dropped', 'grid', 'needsConfirm', 'path', 'url']);
  assert.equal(out.grid, false, 'no stored grid → off for non-loopback host');
  assert.equal(({}).polluted, undefined);
  assert.equal(out.polluted, undefined);
  const rewritten = st.raw.get(SYNC_SETTINGS_KEY);
  assert.ok(!rewritten.includes(SECRET), 'secret removed from storage');
  assert.deepEqual(JSON.parse(rewritten), { v: 1, url: 'ws://studio-pc.local:9980/', path: 'companion', grid: false });
});

test('loadSyncSettings: throwing storage degrades to defaults', () => {
  const st = { getItem() { throw new Error('SecurityError'); }, setItem() {}, removeItem() {} };
  const out = loadSyncSettings(st);
  assert.equal(out.dropped, 'storage unavailable');
  assert.equal(out.url, DEFAULT_SYNC_SETTINGS.url);
});
