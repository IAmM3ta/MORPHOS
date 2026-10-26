/**
 * Morphogen v2 — CPU Gray–Scott + Canvas 2D + Hum.
 * Canvas 2D only — GPU contexts forbidden.
 */
import { GrayScott, PRESET_MITOSIS } from './sim/grayScott';
import { Canvas2DRenderer } from './render/canvas2d';
import { HumEngine } from './audio/hum';
import { TdClient, isSecurePage } from './sync/tdClient';
import { describeCommandStats } from './sync/tdCommand';
import { loadSyncSettings } from './sync/syncUrl';
import {
  mountMuteToggle,
  mountPanelStubs,
  mountSyncStatus,
  mountSyncCommandLine,
  nextLockCount,
  resetNeedsConfirm,
  LOOP_MAX,
  type PanelId,
} from './ui/panels';
import { mountKeyboardShortcuts } from './ui/keys';
import { mountPointerSeeding } from './ui/pointer';
import { createHudWriter } from './ui/hud';
import { createPresetCycler, describePreset, presetFromQuery, presetStepDir } from './ui/field';
import { createFrameLoop, singleFlightUnlock } from './app/loop';

const SIM_SIZE = 256;

function qs<T extends HTMLElement>(sel: string): T {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`Missing ${sel}`);
  return el as T;
}

function applyPerformMode(): void {
  const sp = new URLSearchParams(location.search);
  if (sp.get('perform') === '1') document.body.classList.add('perform');
}

function main(): void {
  applyPerformMode();

  const canvas = qs<HTMLCanvasElement>('#field');
  const gate = qs<HTMLElement>('#gate');
  const enter = qs<HTMLButtonElement>('#enter');
  const status = qs<HTMLElement>('#status');
  // HUD line: NaN-safe numbers, written at most 10×/s and only on change
  // (it was rewritten every frame, 60–240×/s). The static pre-ENTER hint in
  // index.html stays until the first frame.
  const hud = createHudWriter(qs<HTMLElement>('#hud'));
  const panels = qs<HTMLElement>('#panels');

  const sim = new GrayScott(SIM_SIZE, SIM_SIZE, PRESET_MITOSIS);
  // Field presets (Mitosis…Skate): the Field panel steps through them in a
  // fixed order; `?preset=coral` picks the boot preset (unknown ids → Mitosis).
  // Params go through sim.setParams, so sanitizeParams still guards them; the
  // field itself is kept, so the pattern morphs into the new regime.
  const field = createPresetCycler({
    initial: presetFromQuery(location.search),
    apply: (p) => sim.setParams(p),
  });
  const renderer = new Canvas2DRenderer(canvas);
  const hum = new HumEngine();
  const td = new TdClient(''); // auth required before real connect
  // Persisted Sync record: schema-checked + URL re-sanitised on load; never holds
  // the secret; a remote host comes back needsConfirm (path-picker UI will ask).
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null; // private mode / sandboxed iframe
  }
  const syncSettings = loadSyncSettings(storage);
  let lockCount = 0;

  const setStatus = (s: string) => {
    status.textContent = s;
  };

  // Sim pacing is fixed at SIM_HZ (120 steps/s, the old 2-per-frame look at
  // 60 Hz) whatever the display rate, capped at MAX_STEPS_PER_FRAME so a slow
  // device or a tab return slows the field instead of bursting.
  const loop = createFrameLoop({
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (id) => cancelAnimationFrame(id),
    onFrame: (steps, now) => {
      if (document.hidden) return;
      if (steps > 0) sim.stepN(steps, 1);
      renderer.draw(sim);
      const st = sim.stats();
      hum.modulate(st.energy);
      hud.update(st, lockCount, now);
    },
  });

  // ENTER and a first canvas press can land in the same gesture: they share
  // one unlock attempt, and a rejecting AudioContext.resume() still starts the
  // sim (silently) instead of leaving the gate up.
  const unlockHum = singleFlightUnlock(() => hum.unlock());
  const start = async () => {
    const ok = await unlockHum();
    gate.classList.add('hidden');
    loop.start(); // idempotent
    setStatus(ok ? 'hum unlocked · sim' : 'sim (tap again if silent)');
  };

  enter.addEventListener('click', () => {
    void start();
  });

  // Click / drag seeding: one pointer at a time, primary button only, fast
  // drags interpolated into a continuous stroke; a zero-size canvas or an
  // off-canvas point never reaches sim.seed().
  const unmountPointer = mountPointerSeeding(canvas, {
    onPress: () => {
      // also unlock if user skipped ENTER
      if (!loop.isRunning()) void start();
    },
    onSeed: ({ nx, ny }) => sim.seed(nx, ny, 0.045, 0.95),
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void hum.suspend();
    else void hum.resume();
  });

  // Live Sync chip: connecting / waiting for ack / live / retry countdown / error.
  const unmountSync = mountSyncStatus(
    qs<HTMLElement>('#syncStatus'),
    document.querySelector<HTMLButtonElement>('#syncRetry'),
    td,
  );
  // TD -> app command tally next to the chip, visible only while live (2026-10-26).
  const syncCmdsEl = document.querySelector<HTMLElement>('#syncCmds');
  const unmountSyncCmds = syncCmdsEl ? mountSyncCommandLine(syncCmdsEl, td) : () => {};

  // Sound mute: label + aria-pressed mirror HumEngine; safe before ENTER.
  const toggleMute = mountMuteToggle(qs<HTMLElement>('#muteHum'), hum);

  // One code path per action, shared by the panel buttons and the keyboard.
  const muteToggle = () => {
    setStatus(toggleMute() ? 'hum muted' : 'hum on');
  };
  // Field preset step: +1 next / -1 previous. Shared by the Field button
  // (click / Shift-click) and the `]` / `[` keys so the status text is identical.
  const stepPreset = (dir: 1 | -1) => {
    setStatus(describePreset(field.next(dir)));
  };
  // TD → app commands (authed sessions only; parsed + rate-limited in
  // sync/tdCommand.ts). `preset` goes through the same cycler as the Field
  // button, so an unknown id from TD is a no-op and the label stays honest.
  td.onCommand = (cmd) => {
    if (cmd.cmd !== 'preset') return;
    const before = field.current();
    const now = field.set(cmd.id);
    if (now !== before) setStatus(`${describePreset(now)} · from TD`);
  };
  const lockLoop = () => {
    lockCount = nextLockCount(lockCount);
    hud.invalidate(); // show the new loop count on the next frame
    setStatus(lockCount >= LOOP_MAX ? `LOOP ${lockCount} (max)` : `LOOP ${lockCount}`);
  };

  const unmountPanels = mountPanelStubs(panels, {
    onPanel: (id: PanelId, click) => {
      if (id === 'sync') {
        const msg = isSecurePage()
          ? 'Sync: HTTPS → use companion http://127.0.0.1 (A), MIDI (B), or auth wss (C). Default ws:// blocked.'
          : 'Sync: companion ws://127.0.0.1:9980 OK on http; set auth token before connect.';
        setStatus(msg);
      } else if (id === 'field') {
        stepPreset(presetStepDir(click));
      } else {
        setStatus(`panel ${id} (stub)`);
      }
    },
    onLockLoop: lockLoop,
    onMuteToggle: muteToggle,
    onReset: () => {
      if (resetNeedsConfirm(lockCount)) {
        const ok = confirm('Clear field and loops?');
        if (!ok) return;
      }
      lockCount = 0;
      sim.reset();
      hud.invalidate();
      setStatus('reset');
    },
  });

  // `m` mute / `l` lock loop / `]` next preset / `[` previous preset; ignored
  // while typing, on chords and on auto-repeat. Reset stays click-only.
  const unmountKeys = mountKeyboardShortcuts(document, {
    onMuteToggle: muteToggle,
    onLockLoop: lockLoop,
    onPresetNext: () => stepPreset(1),
    onPresetPrev: () => stepPreset(-1),
  });

  // Expose nothing in prod; debug only
  if (new URLSearchParams(location.search).get('debug') === '1') {
    (window as unknown as { __morphogen?: unknown }).__morphogen = () => ({
      energy: sim.stats().energy,
      locks: lockCount,
      preset: field.current(),
      td: td.snapshot(),
      // Per-session TD command tally: applied / pings / refused / paced.
      tdCommands: { ...td.commandStats(), line: describeCommandStats(td.commandStats()) },
      sync: syncSettings,
    });
  }

  const teardown = () => {
    loop.stop();
    unmountKeys();
    unmountPointer();
    unmountPanels();
    td.disconnect();
    unmountSyncCmds();
    unmountSync();
    hum.dispose();
  };
  window.addEventListener('beforeunload', teardown);

  // Initial draw (pre-ENTER still shows field seed)
  renderer.draw(sim);
  setStatus(isSecurePage() ? 'idle · https (sync path A/B/C)' : 'idle');
}

main();
