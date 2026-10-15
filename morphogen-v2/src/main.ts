/**
 * Morphogen v2 — CPU Gray–Scott + Canvas 2D + Hum.
 * Canvas 2D only — GPU contexts forbidden.
 */
import { GrayScott, PRESET_MITOSIS } from './sim/grayScott';
import { Canvas2DRenderer } from './render/canvas2d';
import { HumEngine } from './audio/hum';
import { TdClient, isSecurePage } from './sync/tdClient';
import { loadSyncSettings } from './sync/syncUrl';
import {
  mountMuteToggle,
  mountPanelStubs,
  mountSyncStatus,
  nextLockCount,
  resetNeedsConfirm,
  LOOP_MAX,
  type PanelId,
} from './ui/panels';
import { mountKeyboardShortcuts } from './ui/keys';
import { mountPointerSeeding } from './ui/pointer';
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
  const hud = qs<HTMLElement>('#hud');
  const panels = qs<HTMLElement>('#panels');

  const sim = new GrayScott(SIM_SIZE, SIM_SIZE, PRESET_MITOSIS);
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
    onFrame: (steps) => {
      if (document.hidden) return;
      if (steps > 0) sim.stepN(steps, 1);
      renderer.draw(sim);
      const st = sim.stats();
      hum.modulate(st.energy);
      hud.textContent = `energy ${st.energy.toFixed(3)} · meanV ${st.meanV.toFixed(3)} · loops ${lockCount} · click/drag seed · m mute · l lock`;
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

  // Sound mute: label + aria-pressed mirror HumEngine; safe before ENTER.
  const toggleMute = mountMuteToggle(qs<HTMLElement>('#muteHum'), hum);

  // One code path per action, shared by the panel buttons and the keyboard.
  const muteToggle = () => {
    setStatus(toggleMute() ? 'hum muted' : 'hum on');
  };
  const lockLoop = () => {
    lockCount = nextLockCount(lockCount);
    setStatus(lockCount >= LOOP_MAX ? `LOOP ${lockCount} (max)` : `LOOP ${lockCount}`);
  };

  const unmountPanels = mountPanelStubs(panels, {
    onPanel: (id: PanelId) => {
      if (id === 'sync') {
        const msg = isSecurePage()
          ? 'Sync: HTTPS → use companion http://127.0.0.1 (A), MIDI (B), or auth wss (C). Default ws:// blocked.'
          : 'Sync: companion ws://127.0.0.1:9980 OK on http; set auth token before connect.';
        setStatus(msg);
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
      setStatus('reset');
    },
  });

  // `m` mute / `l` lock loop; ignored while typing, on chords and on auto-repeat.
  // Reset stays click-only.
  const unmountKeys = mountKeyboardShortcuts(document, {
    onMuteToggle: muteToggle,
    onLockLoop: lockLoop,
  });

  // Expose nothing in prod; debug only
  if (new URLSearchParams(location.search).get('debug') === '1') {
    (window as unknown as { __morphogen?: unknown }).__morphogen = () => ({
      energy: sim.stats().energy,
      locks: lockCount,
      td: td.snapshot(),
      sync: syncSettings,
    });
  }

  const teardown = () => {
    loop.stop();
    unmountKeys();
    unmountPointer();
    unmountPanels();
    td.disconnect();
    unmountSync();
    hum.dispose();
  };
  window.addEventListener('beforeunload', teardown);

  // Initial draw (pre-ENTER still shows field seed)
  renderer.draw(sim);
  setStatus(isSecurePage() ? 'idle · https (sync path A/B/C)' : 'idle');
}

main();
