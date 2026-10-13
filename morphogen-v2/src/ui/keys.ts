/**
 * Keyboard shortcuts for performers (2026-10-13): `m` toggles the Hum mute and
 * `l` locks a loop, the same actions as the `#muteHum` / `#lockLoop` buttons.
 * Reset is deliberately click-only (it can clear locked work).
 *
 * Everything that decides whether a key press counts is pure so
 * tests/keys.test.mjs can cover it without a DOM. A shortcut never fires while
 * the user is typing (text-like <input>, <textarea>, <select>, contentEditable),
 * for Ctrl / Cmd / Alt chords (Cmd-M minimises on macOS, Ctrl-L focuses the
 * address bar), on auto-repeat (holding `m` must not flap the mute), during IME
 * composition, or when another handler already called preventDefault().
 */

export type KeyAction = 'mute' | 'lock';

/** Single-key shortcuts, keyed by lower-cased `KeyboardEvent.key` (so Shift / Caps Lock still work). */
export const KEY_SHORTCUTS: Readonly<Record<string, KeyAction>> = Object.freeze({
  m: 'mute',
  l: 'lock',
});

/** Minimal shape of a key event target (real elements satisfy it; tests pass plain objects). */
export type KeyTarget = {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
};

/** Minimal shape of a keydown event. */
export type KeyEventLike = {
  key?: unknown;
  repeat?: boolean;
  isComposing?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
};

/** <input> types that take no typed text, so a shortcut over them is safe. */
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/**
 * True when the focused element accepts typed text, so a letter key belongs to
 * it and not to a shortcut. Unknown or missing <input> types count as text
 * (the browser default is type=text), which errs on the side of not firing.
 */
export function isTextEntryTarget(t: unknown): boolean {
  if (!t || typeof t !== 'object') return false;
  const el = t as KeyTarget;
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = typeof el.type === 'string' ? el.type.toLowerCase() : '';
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  return false;
}

/** Map a keydown event to a shortcut action, or null when the press should be left alone. */
export function resolveKeyAction(ev: KeyEventLike | null | undefined): KeyAction | null {
  if (!ev || typeof ev.key !== 'string') return null;
  if (ev.defaultPrevented || ev.repeat || ev.isComposing) return null;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  if (isTextEntryTarget(ev.target)) return null;
  const k = ev.key.toLowerCase();
  // Own-key check: 'constructor' / 'toString' / '__proto__' never resolve.
  return Object.prototype.hasOwnProperty.call(KEY_SHORTCUTS, k) ? KEY_SHORTCUTS[k] : null;
}

export type KeyHandlers = {
  onMuteToggle?: () => void;
  onLockLoop?: () => void;
};

/** Anything that can carry a keydown listener (document, window, or a test stub). */
export type KeyListenerHost = {
  addEventListener(type: string, fn: (ev: Event) => void): void;
  removeEventListener(type: string, fn: (ev: Event) => void): void;
};

/**
 * Listen for shortcuts on `host` (normally `document`). preventDefault() is
 * called only for keys that were actually handled, so every other key keeps
 * its browser behaviour. Returns an unmount function.
 */
export function mountKeyboardShortcuts(host: KeyListenerHost, handlers: KeyHandlers): () => void {
  const onKey = (ev: Event) => {
    const ke = ev as unknown as KeyEventLike & { preventDefault?: () => void };
    const action = resolveKeyAction(ke);
    const fn = action === 'mute' ? handlers.onMuteToggle : action === 'lock' ? handlers.onLockLoop : undefined;
    if (!fn) return;
    ke.preventDefault?.();
    fn();
  };
  host.addEventListener('keydown', onKey);
  return () => host.removeEventListener('keydown', onKey);
}
