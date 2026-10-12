// Morphogen v2 panel routing + Sound mute toggle tests (node:test, no browser) — 2026-10-12.
// Run: npm test   (esbuild bundles panels.ts → .test-build/, then node --test)
// Covers isPanelId, nextLockCount / resetNeedsConfirm (loop rules moved out of
// main.ts), resolvePanelAction (ancestor walk, disabled + unknown ids ignored,
// stops at root), mountPanelStubs dispatch and mountMuteToggle (label + aria-pressed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_LABELS,
  LOOP_MAX,
  isPanelId,
  nextLockCount,
  resetNeedsConfirm,
  resolvePanelAction,
  describeMute,
  mountPanelStubs,
  mountMuteToggle,
} from '../.test-build/panels.mjs';

/** Tiny element stand-in: id, attributes, parent link. */
function el({ id = '', attrs = {}, parent = null } = {}) {
  return {
    id,
    parentElement: parent,
    textContent: '',
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null; },
    hasAttribute(n) { return Object.prototype.hasOwnProperty.call(attrs, n); },
    setAttribute(n, v) { attrs[n] = String(v); },
  };
}

test('isPanelId: only the five known panels (no prototype keys)', () => {
  for (const id of Object.keys(PANEL_LABELS)) assert.ok(isPanelId(id));
  for (const bad of ['', 'Field', 'toString', '__proto__', 'constructor', null, undefined, 3]) {
    assert.equal(isPanelId(bad), false, String(bad));
  }
});

test('nextLockCount: +1 capped at LOOP_MAX; corrupt counts restart', () => {
  assert.equal(LOOP_MAX, 4);
  assert.equal(nextLockCount(0), 1);
  assert.equal(nextLockCount(3), 4);
  assert.equal(nextLockCount(4), 4);
  assert.equal(nextLockCount(99), 4);
  assert.equal(nextLockCount(NaN), 1);
  assert.equal(nextLockCount(-2), 1);
  assert.equal(nextLockCount(2.7), 3);
  assert.equal(nextLockCount(Infinity), 1);
});

test('resetNeedsConfirm: only when loops are locked', () => {
  assert.equal(resetNeedsConfirm(0), false);
  assert.equal(resetNeedsConfirm(NaN), false);
  assert.equal(resetNeedsConfirm(1), true);
  assert.equal(resetNeedsConfirm(LOOP_MAX), true);
});

test('resolvePanelAction: direct hits on each control', () => {
  assert.deepEqual(resolvePanelAction(el({ attrs: { 'data-panel': 'sync' } })), { kind: 'panel', id: 'sync' });
  assert.deepEqual(resolvePanelAction(el({ id: 'lockLoop' })), { kind: 'lock' });
  assert.deepEqual(resolvePanelAction(el({ id: 'resetField' })), { kind: 'reset' });
  assert.deepEqual(resolvePanelAction(el({ id: 'muteHum' })), { kind: 'mute' });
  assert.equal(resolvePanelAction(null), null);
  assert.equal(resolvePanelAction(el({ id: 'panelNote' })), null);
});

test('resolvePanelAction: click on a child span routes to its button', () => {
  const btn = el({ attrs: { 'data-panel': 'sound' } });
  const span = el({ parent: btn });
  const icon = el({ parent: span });
  assert.deepEqual(resolvePanelAction(icon), { kind: 'panel', id: 'sound' });
  const lock = el({ id: 'lockLoop' });
  assert.deepEqual(resolvePanelAction(el({ parent: lock })), { kind: 'lock' });
});

test('resolvePanelAction: unknown data-panel and disabled controls are ignored', () => {
  assert.equal(resolvePanelAction(el({ attrs: { 'data-panel': 'toString' } })), null);
  assert.equal(resolvePanelAction(el({ attrs: { 'data-panel': 'nope' } })), null);
  const disabled = el({ id: 'resetField', attrs: { disabled: '' } });
  assert.equal(resolvePanelAction(disabled), null);
  assert.equal(resolvePanelAction(el({ parent: disabled })), null);
});

test('resolvePanelAction: stops at root and after a bounded walk', () => {
  const outside = el({ id: 'lockLoop' });
  const root = el({ id: 'panels', parent: outside });
  assert.equal(resolvePanelAction(el({ parent: root }), root), null);
  let deep = el({ id: 'resetField' });
  for (let i = 0; i < 6; i++) deep = el({ parent: deep });
  assert.equal(resolvePanelAction(deep), null);
});

test('mountPanelStubs: dispatches each action, writes the note, unmount removes listener', () => {
  const note = el({ id: 'panelNote' });
  const listeners = new Map();
  const root = {
    ...el({ id: 'panels' }),
    querySelector: (sel) => (sel === '#panelNote' ? note : null),
    addEventListener: (k, fn) => listeners.set(k, fn),
    removeEventListener: (k, fn) => { if (listeners.get(k) === fn) listeners.delete(k); },
  };
  const calls = [];
  const unmount = mountPanelStubs(root, {
    onPanel: (id) => calls.push(`panel:${id}`),
    onLockLoop: () => calls.push('lock'),
    onReset: () => calls.push('reset'),
    onMuteToggle: () => calls.push('mute'),
  });
  const click = (target) => listeners.get('click')({ target });
  click(el({ attrs: { 'data-panel': 'field' } }));
  click(el({ id: 'lockLoop' }));
  click(el({ id: 'resetField' }));
  click(el({ id: 'muteHum' }));
  click(el({ attrs: { 'data-panel': 'bogus' } }));
  click(null);
  assert.deepEqual(calls, ['panel:field', 'lock', 'reset', 'mute']);
  assert.equal(note.textContent, 'panel: Field (stub)');
  unmount();
  assert.equal(listeners.has('click'), false);
});

test('mountMuteToggle: renders engine state, toggles via setMuted, aria-pressed follows', () => {
  assert.deepEqual(describeMute(false), { label: 'Hum on', pressed: 'false' });
  assert.deepEqual(describeMute(true), { label: 'Hum muted', pressed: 'true' });
  const hum = {
    muted: true, // e.g. muted on the gate before ENTER
    sets: [],
    get isMuted() { return this.muted; },
    setMuted(m) { this.sets.push(m); this.muted = m; },
  };
  const btn = el({ id: 'muteHum' });
  const toggle = mountMuteToggle(btn, hum);
  assert.equal(btn.textContent, 'Hum muted');
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(hum.sets, [], 'mounting must not touch the engine');
  assert.equal(toggle(), false);
  assert.equal(btn.textContent, 'Hum on');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.equal(toggle(), true);
  assert.deepEqual(hum.sets, [false, true]);
});
