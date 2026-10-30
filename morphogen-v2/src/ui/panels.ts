/**
 * Panel stubs — Field / Image / Body / Sound / Sync (parity hooks), Sound mute
 * toggle and the live Sync status chip. Click routing and loop/reset rules are
 * pure helpers so tests/panels.test.mjs can cover them without a DOM.
 */
import { describeTdStatus, type TdSnapshot, type TdStatus } from '../sync/tdClient';
import { describeCommandStats, describeTdRtt, type TdCommandStats, type TdRtt } from '../sync/tdCommand';

export type PanelId = 'field' | 'image' | 'body' | 'sound' | 'sync';

export const PANEL_LABELS: Record<PanelId, string> = {
  field: 'Field',
  image: 'Image',
  body: 'Body',
  sound: 'Sound',
  sync: 'Sync',
};

/** Modifier state forwarded with a panel click; `shiftKey` is false unless the event literally said true. */
export type PanelClick = { shiftKey: boolean };

export type PanelHandlers = {
  /**
   * `click` carries the modifier state the Field panel needs (Shift-click =
   * previous preset, 2026-10-18). Other panels ignore it.
   */
  onPanel?: (id: PanelId, click: PanelClick) => void;
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
        handlers.onPanel?.(action.id, { shiftKey: (ev as MouseEvent).shiftKey === true });
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

// ---------------------------------------------------------------------------
// Sync command line (2026-10-26)
// ---------------------------------------------------------------------------

/** What the TD command line needs from a TdClient (structural, so tests can fake it). */
export type SyncCommandSource = {
  snapshot(): TdSnapshot;
  commandStats(): TdCommandStats;
  onStatus?: (s: TdStatus, err?: string | null) => void;
};

/** Refresh rate for the command tally while live. Commands are capped at 10/s, so 1 Hz is plenty for a human readout. */
export const SYNC_CMDS_TICK_MS = 1000;

/**
 * Mount the "TD cmds: 3 applied · 1 ping" line next to the Sync chip.
 *
 * Until today the per-session command tally (TdClient.commandStats, added
 * 2026-10-24) was only visible through the ?debug=1 console hook, so in a show
 * you could not tell "TD's cue reached the browser and was applied" from "TD
 * is rate-limited" without opening devtools. This line puts the same
 * describeCommandStats text on screen:
 *
 *   - shown only while the session is 'open' (authed); hidden otherwise, so a
 *     stale tally from a dropped session never looks live;
 *   - refreshed on every status change and, only while open, on a slow
 *     SYNC_CMDS_TICK_MS interval (no timer at all when Sync is off);
 *   - the DOM is written only when the text actually changes;
 *   - tone "warn" when anything was refused / paced / threw, so a problem is
 *     visible at a glance; "ok" otherwise.
 *
 * The text is built from counters only, never from frame contents or the auth
 * token. Chains any onStatus handler already installed (mountSyncStatus included)
 * and returns an unmount that restores it.
 */
export function mountSyncCommandLine(
  el: HTMLElement,
  td: SyncCommandSource,
  tickMs: number = SYNC_CMDS_TICK_MS,
): () => void {
  let tick: ReturnType<typeof setInterval> | null = null;
  let lastText: string | null = null;
  const stopTick = () => {
    if (tick) clearInterval(tick);
    tick = null;
  };
  const render = () => {
    const live = td.snapshot().status === 'open';
    el.hidden = !live;
    if (!live) {
      stopTick();
      return;
    }
    const s = td.commandStats();
    const text = describeCommandStats(s);
    if (text !== lastText) {
      el.textContent = text;
      lastText = text;
    }
    el.dataset.tone = s.refused > 0 || s.paced > 0 || s.handlerErrors > 0 ? 'warn' : 'ok';
    if (!tick) tick = setInterval(render, Number.isFinite(tickMs) && tickMs > 0 ? tickMs : SYNC_CMDS_TICK_MS);
  };
  const prev = td.onStatus;
  td.onStatus = (s, err) => {
    prev?.(s, err);
    render();
  };
  render();
  return () => {
    stopTick();
    td.onStatus = prev;
  };
}

// ---------------------------------------------------------------------------
// Sync TD RTT line (2026-10-30)
// ---------------------------------------------------------------------------

/** What the TD RTT line needs from a TdClient (structural, so tests can fake it). */
export type SyncRttSource = {
  snapshot(): TdSnapshot;
  tdRtt(): TdRtt | null;
  onStatus?: (s: TdStatus, err?: string | null) => void;
};

/** Refresh rate for the TD RTT line while live; TD sends status frames at its own (paced) rate, so 1 Hz is plenty. */
export const SYNC_RTT_TICK_MS = 1000;

/**
 * Mount the "TD rtt: 8.0 ms (median 9.5) · 1 lost" line next to the TD cmds chip.
 *
 * Since 2026-10-29 TD can push its own round-trip figures as a `status` frame
 * and TdClient keeps the latest in tdRtt(), but they were only visible through
 * the ?debug=1 console hook. This chip shows describeTdRtt's text, which is
 * byte-for-byte what TD's rtt_line() prints, so the browser and TD screens read
 * the same during a show:
 *
 *   - shown only while the session is 'open' (authed) AND TD has sent a status
 *     frame since the ack; tdRtt() is cleared on every fresh ack, so a dropped
 *     or reconnected session never shows the previous session's figures;
 *   - refreshed on every status change and, only while open, on a slow
 *     SYNC_RTT_TICK_MS interval (no timer at all when Sync is off);
 *   - the DOM is written only when the text actually changes;
 *   - tone "warn" when TD reports any lost pings (the link dropped or stalled
 *     at some point this session), "ok" otherwise.
 *
 * Text comes from five numbers TD sent, already range-checked by parseTdRtt;
 * nothing else from the frame (and never the auth token) reaches the DOM.
 * Chains any existing onStatus handler and returns an unmount that restores it,
 * so it stacks with mountSyncStatus / mountSyncCommandLine (unmount LIFO).
 */
export function mountSyncRttLine(
  el: HTMLElement,
  td: SyncRttSource,
  tickMs: number = SYNC_RTT_TICK_MS,
): () => void {
  let tick: ReturnType<typeof setInterval> | null = null;
  let lastText: string | null = null;
  const stopTick = () => {
    if (tick) clearInterval(tick);
    tick = null;
  };
  const render = () => {
    const live = td.snapshot().status === 'open';
    if (!live) {
      el.hidden = true;
      stopTick();
      return;
    }
    // Keep ticking while live even before the first status frame, so the chip
    // appears within one tick of TD's first send_status().
    if (!tick) tick = setInterval(render, Number.isFinite(tickMs) && tickMs > 0 ? tickMs : SYNC_RTT_TICK_MS);
    const rtt = td.tdRtt();
    el.hidden = rtt === null;
    if (!rtt) return;
    const text = describeTdRtt(rtt);
    if (text !== lastText) {
      el.textContent = text;
      lastText = text;
    }
    el.dataset.tone = rtt.lost > 0 ? 'warn' : 'ok';
  };
  const prev = td.onStatus;
  td.onStatus = (s, err) => {
    prev?.(s, err);
    render();
  };
  render();
  return () => {
    stopTick();
    td.onStatus = prev;
  };
}
