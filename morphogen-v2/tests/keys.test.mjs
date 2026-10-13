// Morphogen v2 keyboard shortcut tests (node:test, no browser) — 2026-10-13.
// Run: npm test   (esbuild bundles keys.ts → .test-build/, then node --test)
// Covers KEY_SHORTCUTS, resolveKeyAction (case, chords, repeat, IME, handled
// events, prototype keys), isTextEntryTarget and mountKeyboardShortcuts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_SHORTCUTS,
  isTextEntryTarget,
  resolveKeyAction,
  mountKeyboardShortcuts,
} from '../.test-build/keys.mjs';

const body = { tagName: 'BODY' };
const key = (k, extra = {}) => ({ key: k, target: body, ...extra });

test('KEY_SHORTCUTS: m = mute, l = lock, frozen, no reset key', () => {
  assert.deepEqual({ ...KEY_SHORTCUTS }, { m: 'mute', l: 'lock' });
  assert.ok(Object.isFrozen(KEY_SHORTCUTS));
  assert.equal(Object.values(KEY_SHORTCUTS).includes('reset'), false);
});

test('resolveKeyAction: letters map case-insensitively; other keys ignored', () => {
  assert.equal(resolveKeyAction(key('m')), 'mute');
  assert.equal(resolveKeyAction(key('M', { shiftKey: true })), 'mute');
  assert.equal(resolveKeyAction(key('l')), 'lock');
  assert.equal(resolveKeyAction(key('L')), 'lock');
  for (const k of ['r', 'R', 'Enter', 'Escape', ' ', 'Meta', 'mm', '']) {
    assert.equal(resolveKeyAction(key(k)), null, JSON.stringify(k));
  }
  assert.equal(resolveKeyAction(null), null);
  assert.equal(resolveKeyAction(undefined), null);
  assert.equal(resolveKeyAction({ target: body }), null);
  assert.equal(resolveKeyAction(key(77)), null);
});

test('resolveKeyAction: prototype keys never resolve', () => {
  for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.equal(resolveKeyAction(key(k)), null, k);
  }
});

test('resolveKeyAction: chords, auto-repeat, IME and handled events are ignored', () => {
  assert.equal(resolveKeyAction(key('m', { ctrlKey: true })), null);
  assert.equal(resolveKeyAction(key('m', { metaKey: true })), null, 'Cmd-M minimises on macOS');
  assert.equal(resolveKeyAction(key('l', { ctrlKey: true })), null, 'Ctrl-L is the address bar');
  assert.equal(resolveKeyAction(key('m', { altKey: true })), null);
  assert.equal(resolveKeyAction(key('m', { repeat: true })), null, 'holding m must not flap the mute');
  assert.equal(resolveKeyAction(key('m', { isComposing: true })), null);
  assert.equal(resolveKeyAction(key('m', { defaultPrevented: true })), null);
});

test('isTextEntryTarget: typing surfaces block shortcuts, controls do not', () => {
  for (const t of [
    { tagName: 'TEXTAREA' },
    { tagName: 'select' },
    { tagName: 'INPUT', type: 'text' },
    { tagName: 'INPUT', type: 'search' },
    { tagName: 'INPUT', type: 'password' },
    { tagName: 'INPUT', type: 'number' },
    { tagName: 'INPUT', type: 'URL' },
    { tagName: 'INPUT' },
    { tagName: 'DIV', isContentEditable: true },
  ]) {
    assert.equal(isTextEntryTarget(t), true, JSON.stringify(t));
    assert.equal(resolveKeyAction({ key: 'm', target: t }), null, JSON.stringify(t));
  }
  for (const t of [
    { tagName: 'INPUT', type: 'range' },
    { tagName: 'INPUT', type: 'checkbox' },
    { tagName: 'BUTTON' },
    { tagName: 'CANVAS' },
    body,
    { tagName: 'DIV', isContentEditable: false },
    null,
    undefined,
    'INPUT',
  ]) {
    assert.equal(isTextEntryTarget(t), false, JSON.stringify(t));
  }
  assert.equal(resolveKeyAction({ key: 'm', target: { tagName: 'INPUT', type: 'range' } }), 'mute');
  assert.equal(resolveKeyAction({ key: 'l', target: { tagName: 'BUTTON' } }), 'lock');
});

function host() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener: (k, fn) => listeners.set(k, fn),
    removeEventListener: (k, fn) => { if (listeners.get(k) === fn) listeners.delete(k); },
    press(k, extra = {}) {
      const ev = { key: k, target: body, prevented: 0, ...extra };
      ev.preventDefault = () => { ev.prevented++; };
      listeners.get('keydown')?.(ev);
      return ev;
    },
  };
}

test('mountKeyboardShortcuts: dispatches, preventDefault only when handled, unmount removes listener', () => {
  const h = host();
  const calls = [];
  const unmount = mountKeyboardShortcuts(h, {
    onMuteToggle: () => calls.push('mute'),
    onLockLoop: () => calls.push('lock'),
  });
  assert.equal(h.press('m').prevented, 1);
  assert.equal(h.press('L').prevented, 1);
  assert.equal(h.press('r').prevented, 0, 'unmapped keys keep browser behaviour');
  assert.equal(h.press('m', { metaKey: true }).prevented, 0);
  assert.equal(h.press('m', { target: { tagName: 'TEXTAREA' } }).prevented, 0);
  assert.deepEqual(calls, ['mute', 'lock']);
  unmount();
  assert.equal(h.listeners.has('keydown'), false);
});

test('mountKeyboardShortcuts: a missing handler leaves the key alone', () => {
  const h = host();
  const calls = [];
  mountKeyboardShortcuts(h, { onMuteToggle: () => calls.push('mute') });
  assert.equal(h.press('l').prevented, 0);
  assert.equal(h.press('m').prevented, 1);
  assert.deepEqual(calls, ['mute']);
});
