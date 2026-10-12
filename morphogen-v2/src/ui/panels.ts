/**
 * Panel stubs — Field / Image / Body / Sound / Sync (parity hooks), Sound mute
 * toggle and the live Sync status chip. Click routing and loop/reset rules are
 * pure helpers so tests/panels.test.mjs can cover them without a DOM.
 */
import { describeTdStatus, type TdSnapshot, type TdStatus } from '../sync/tdClient';

export type PanelId = 'field' | 'image' | 'body' | 'sound' | 'sync';

export const PANEL_LABELS: Record<PanelId, string> = {
  field: 'Field',
  image: 'Image',
  body: 'Body',
  sound: 'Sound',
  sync: 'Sync',
};

export type PanelHandlers = {
  onPanel?: (id: PanelId) => void;
  onLockLoop?: () => void;
  onReset?: () => void;
  onMuteToggle?: () => void;
};

/** Narrow an arbitrary `data-panel` attribute to a known panel (unknown / typo'd ids are ignored). */
export function isPanelId(x: unknown): x is PanelId {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(PANEL_LABELS, x);
}

/** Hard ceiling on locked loops (REBUILD-SPEC: explicit Lock loop, 4 slots). */
export const LOOP_MAX = 4;

/** Next lock count after one "Lock loop" press: +1, capped at LOOP_MAX; a corrupt (NaN / negative / fractional) count restarts from 0. */
export function nextLockCount(n: number): number {
  const base = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return Math.min(LOOP_MAX, base + 1);
}

/** Reset only asks for confirmation when there is locked work to lose. */
export function resetNeedsConfirm(lockCount: number): boolean {
  return Number.isFinite(lockCount) && lockCount > 0;
}

export type PanelAction =
  | { kind: 'panel'; id: PanelId }
  | { kind: 'lock' }
  | { kind: 'reset' }
  | { kind: 'mute' };

/** Minimal element shape the router walks (real DOM elements satisfy it; tests pass plain objects). */
export type ActionTarget = {
  id?: string;
  getAttribute(name: string): string | null;
  hasAttribute?(name: string): boolean;
  parentElement?: ActionTarget | null;
};

/** How far up from the click target we look for a control (button → its icon/span children). */
const ACTION_WALK_LIMIT = 4;

/**
 * Map a click target to a panel action (2026-10-12). Walks up a few ancestors so a
 * click on a `<span>` or icon inside a button still routes, stops at `root`, and
 * ignores disabled controls and unknown `data-panel` values. Previously the
 * handler only looked at `ev.target` itself and trusted any `data-panel` string.
 */
export function resolvePanelAction(
  target: ActionTarget | null | undefined,
  root?: ActionTarget | null,
): PanelAction | null {
  let el = target ?? null;
  for (let depth = 0; el && depth < ACTION_WALK_LIMIT; depth++) {
    if (el.hasAttribute?.('disabled')) return null;
    const panel = el.getAttribute('data-panel');
    if (panel !== null) return isPanelId(panel) ? { kind: 'panel', id: panel } : null;
    if (el.id === 'lockLoop') return { kind: 'lock' };
    if (el.id === 'resetField') return { kind: 'reset' };
    if (el.id === 'muteHum') return { kind: 'mute' };
    if (el === root) break;
    el = el.parentElement ?? null;
  }
  return null;
}

export function mountPanelStubs(root: HTMLElement, handlers: PanelHandlers): () => void {
  const note = root.querySelector<HTMLElement>('#panelNote');
  const onClick = (ev: Event) => {
    const action = resolvePanelAction(ev.target as ActionTarget | null, root);
    if (!action) return;
    switch (action.kind) {
      case 'panel':
        handlers.onPanel?.(action.id);
        if (note) note.textContent = `panel: ${PANEL_LABELS[action.id]} (stub)`;
        break;
      case 'lock':
        handlers.onLockLoop?.();
        break;
      case 'reset':
        handlers.onReset?.();
        break;
      case 'mute':
        handlers.onMuteToggle?.();
        break;
    }
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
}

/** The slice of HumEngine the mute button needs. */
export type MuteSource = {
  readonly isMuted: boolean;
  setMuted(muted: boolean): void;
};

/** Label / pressed state for the Sound mute button (pure, so it is testable). */
export function describeMute(muted: boolean): { label: string; pressed: 'true' | 'false' } {
  return muted ? { label: 'Hum muted', pressed: 'true' } : { label: 'Hum on', pressed: 'false' };
}

/**
 * Wire the Sound-panel mute button to `HumEngine.setMuted` (2026-10-12).
 * Works before ENTER: HumEngine remembers the mute across unlock, so pressing
 * it on the gate keeps the 0.8 s ramp-in from ever starting. Reflects state via
 * the label and `aria-pressed`. Clicks arrive through `mountPanelStubs`
 * (`#muteHum` → `onMuteToggle`), so this adds no listener of its own; the
 * returned `toggle` flips the engine, re-renders and reports the new state
 * (also usable from a future `m` key / MIDI CC).
 */
export function mountMuteToggle(btn: HTMLElement, hum: MuteSource): () => boolean {
  const render = () => {
    const view = describeMute(hum.isMuted);
    btn.textContent = view.label;
    btn.setAttribute('aria-pressed', view.pressed);
  };
  const toggle = () => {
    hum.setMuted(!hum.isMuted);
    render();
    return hum.isMuted;
  };
  render();
  return toggle;
}

/** The slice of TdClient the status chip needs (keeps the UI testable with a stub). */
export type SyncStatusSource = {
  snapshot(): TdSnapshot;
  retryNow(): boolean;
  onStatus?: (s: TdStatus, err?: string | null) => void;
};

/** Countdown refresh while reconnecting; 4 Hz is smooth for a 0.1 s readout and cheap. */
export const SYNC_COUNTDOWN_TICK_MS = 250;

/**
 * Mount the Sync status chip (2026-10-07). Re-renders on every TdClient status
 * change and, only while a retry is pending, ticks the countdown from
 * `nextRetryAt` — the interval is cleared as soon as the client leaves
 * 'reconnecting', so an idle or live session costs no timers. "Retry now" calls
 * `retryNow()`, which skips the wait but never resets the retry budget.
 * Chains any onStatus handler that was already installed.
 */
export function mountSyncStatus(
  chip: HTMLElement,
  retryBtn: HTMLButtonElement | null,
  td: SyncStatusSource,
): () => void {
  let tick: ReturnType<typeof setInterval> | null = null;
  const stopTick = () => {
    if (tick) clearInterval(tick);
    tick = null;
  };
  const render = () => {
    const view = describeTdStatus(td.snapshot());
    chip.textContent = view.label;
    chip.dataset.tone = view.tone;
    if (retryBtn) retryBtn.hidden = !view.canRetryNow;
    if (view.countdownMs !== null) {
      if (!tick) tick = setInterval(render, SYNC_COUNTDOWN_TICK_MS);
    } else {
      stopTick();
    }
  };
  const prev = td.onStatus;
  td.onStatus = (s, err) => {
    prev?.(s, err);
    render();
  };
  const onRetry = () => {
    td.retryNow();
    render();
  };
  retryBtn?.addEventListener('click', onRetry);
  render();
  return () => {
    stopTick();
    td.onStatus = prev;
    retryBtn?.removeEventListener('click', onRetry);
  };
}
