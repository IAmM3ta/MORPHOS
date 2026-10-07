/** Panel stubs — Field / Image / Body / Sound / Sync (parity hooks) + live Sync status chip. */
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
};

export function mountPanelStubs(root: HTMLElement, handlers: PanelHandlers): () => void {
  const note = root.querySelector<HTMLElement>('#panelNote');
  const onClick = (ev: Event) => {
    const t = ev.target as HTMLElement | null;
    if (!t) return;
    const panel = t.getAttribute('data-panel') as PanelId | null;
    if (panel) {
      handlers.onPanel?.(panel);
      if (note) note.textContent = `panel: ${PANEL_LABELS[panel]} (stub)`;
    }
    if (t.id === 'lockLoop') handlers.onLockLoop?.();
    if (t.id === 'resetField') handlers.onReset?.();
  };
  root.addEventListener('click', onClick);
  return () => root.removeEventListener('click', onClick);
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
