/**
 * Morphogen v2 — CPU Gray–Scott + Canvas 2D + Hum.
 * Canvas 2D only — GPU contexts forbidden.
 */
import { GrayScott, PRESET_MITOSIS } from './sim/grayScott';
import { Canvas2DRenderer } from './render/canvas2d';
import { HumEngine } from './audio/hum';
import { TdClient, isSecurePage } from './sync/tdClient';
import { mountPanelStubs, type PanelId } from './ui/panels';

const SIM_SIZE = 256;
const STEPS = 2;

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
  let lockCount = 0;
  let running = false;
  let raf = 0;
  let painting = false;

  const setStatus = (s: string) => {
    status.textContent = s;
  };

  const frame = () => {
    if (!running) return;
    if (!document.hidden) {
      sim.stepN(STEPS, 1);
      renderer.draw(sim);
      const st = sim.stats();
      hum.modulate(st.energy);
      hud.textContent = `energy ${st.energy.toFixed(3)} · meanV ${st.meanV.toFixed(3)} · loops ${lockCount} · click/drag seed`;
    }
    raf = requestAnimationFrame(frame);
  };

  const start = async () => {
    const ok = await hum.unlock();
    gate.classList.add('hidden');
    running = true;
    setStatus(ok ? 'hum unlocked · sim' : 'sim (tap again if silent)');
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  };

  enter.addEventListener('click', () => {
    void start();
  });

  const seedAt = (ev: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const nx = (ev.clientX - rect.left) / rect.width;
    const ny = (ev.clientY - rect.top) / rect.height;
    if (nx < 0 || ny < 0 || nx > 1 || ny > 1) return;
    sim.seed(nx, ny, 0.045, 0.95);
  };

  canvas.addEventListener('pointerdown', (ev) => {
    painting = true;
    canvas.setPointerCapture(ev.pointerId);
    seedAt(ev);
    // also unlock if user skipped ENTER
    if (!running) void start();
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (painting) seedAt(ev);
  });
  canvas.addEventListener('pointerup', () => {
    painting = false;
  });
  canvas.addEventListener('pointercancel', () => {
    painting = false;
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void hum.suspend();
    else void hum.resume();
  });

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
    onLockLoop: () => {
      lockCount = Math.min(4, lockCount + 1);
      setStatus(`LOOP ${lockCount}`);
    },
    onReset: () => {
      if (lockCount > 0) {
        const ok = confirm('Clear field and loops?');
        if (!ok) return;
      }
      lockCount = 0;
      sim.reset();
      setStatus('reset');
    },
  });

  // Expose nothing in prod; debug only
  if (new URLSearchParams(location.search).get('debug') === '1') {
    (window as unknown as { __morphogen?: unknown }).__morphogen = () => ({
      energy: sim.stats().energy,
      locks: lockCount,
      td: td.status,
    });
  }

  const teardown = () => {
    running = false;
    cancelAnimationFrame(raf);
    unmountPanels();
    td.disconnect();
    hum.dispose();
  };
  window.addEventListener('beforeunload', teardown);

  // Initial draw (pre-ENTER still shows field seed)
  renderer.draw(sim);
  setStatus(isSecurePage() ? 'idle · https (sync path A/B/C)' : 'idle');
}

main();
