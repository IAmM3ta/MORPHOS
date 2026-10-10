/**
 * Schumann Hum pad — Web Audio. MUST dispose on teardown.
 *
 * Signal path: 4 sine partials → per-partial gain → master → gentle compressor
 * → brick-wall-ish limiter → destination. Safety rules this file enforces:
 *   - master gain never exceeds HUM_LEVEL_ON and every ramp is anchored with
 *     setValueAtTime, so a cancel mid-ramp can't jump to an unscheduled value;
 *   - mute state is remembered, so muting before unlock (or before the 0.8 s
 *     ramp-in finishes) is respected instead of being overwritten by the ramp-in;
 *   - modulate() sanitises energy (NaN/±Infinity → 0) and only schedules a new
 *     frequency target when the quantised detune actually changes, so a 60 fps
 *     caller doesn't pile thousands of automation events onto each oscillator;
 *   - every node (including the compressor) is disconnected on dispose(), and a
 *     disposed engine never re-creates a context.
 */

const SCHUMANN = 7.83;

/** Audible octave-ish lifts of 7.83 Hz (≈250 / 376 / 501 / 752 Hz). */
export const HUM_PARTIALS: readonly number[] = [SCHUMANN * 32, SCHUMANN * 48, SCHUMANN * 64, SCHUMANN * 96];
export const HUM_PARTIAL_LEVELS: readonly number[] = [0.22, 0.14, 0.1, 0.06];
/** Master gain when audible / when muted (exponential ramps can't target 0). */
export const HUM_LEVEL_ON = 0.55;
export const HUM_LEVEL_OFF = 0.0001;
/** Max detune at full energy (2 %), and the step it is quantised to. */
export const HUM_MAX_DETUNE = 0.02;
export const HUM_DETUNE_STEP = 0.0005;

/**
 * Field energy → fractional detune in [0, HUM_MAX_DETUNE], quantised to
 * HUM_DETUNE_STEP. Non-finite or negative energy maps to 0 (no detune).
 */
export function energyToDetune(energy: number): number {
  const e = Number.isFinite(energy) ? Math.min(1, Math.max(0, energy * 8)) : 0;
  return Math.round((e * HUM_MAX_DETUNE) / HUM_DETUNE_STEP) * HUM_DETUNE_STEP;
}

/** Minimal AudioContext constructor shape — lets tests inject a fake. */
export type AudioContextFactory = () => AudioContext | null;

const defaultFactory: AudioContextFactory = () => {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return AC ? new AC({ latencyHint: 'interactive' }) : null;
};

export class HumEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private comp: DynamicsCompressorNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private oscs: OscillatorNode[] = [];
  private gains: GainNode[] = [];
  private unlocked = false;
  private disposed = false;
  private muted = false;
  private lastDetune = Number.NaN;

  constructor(private readonly makeContext: AudioContextFactory = defaultFactory) {}

  get isMuted(): boolean {
    return this.muted;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Call from a direct user gesture. */
  async unlock(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.unlocked && this.ctx?.state === 'running') return true;
    if (!this.ctx) {
      this.ctx = this.makeContext();
      if (!this.ctx) return false;
      this.buildGraph();
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    // dispose() may have run while resume() was pending.
    if (this.disposed || !this.ctx) return false;
    this.unlocked = this.ctx.state === 'running';
    return this.unlocked;
  }

  private buildGraph(): void {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.gain.value = HUM_LEVEL_OFF;

    // gentle compress, then brick-wall-ish limiter
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 6;
    comp.ratio.value = 3.2;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    this.comp = comp;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.05;

    this.master.connect(comp);
    comp.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    HUM_PARTIALS.forEach((hz, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.value = HUM_PARTIAL_LEVELS[i] ?? 0.05;
      osc.connect(g);
      g.connect(this.master!);
      osc.start();
      this.oscs.push(osc);
      this.gains.push(g);
    });

    // ramp in — unless the user already muted before unlocking
    if (!this.muted) {
      const t = ctx.currentTime;
      this.master.gain.setValueAtTime(HUM_LEVEL_OFF, t);
      this.master.gain.exponentialRampToValueAtTime(HUM_LEVEL_ON, t + 0.8);
    }
  }

  /** Remembered across unlock; 50 ms anchored ramp so there's no click. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!this.master || !this.ctx) return;
    const t = this.ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.min(HUM_LEVEL_ON, Math.max(HUM_LEVEL_OFF, g.value)), t);
    g.linearRampToValueAtTime(muted ? HUM_LEVEL_OFF : HUM_LEVEL_ON, t + 0.05);
  }

  /** Map field energy lightly into detune. Safe to call every frame. */
  modulate(energy: number): void {
    if (!this.ctx || !this.master) return;
    const d = energyToDetune(energy);
    if (d === this.lastDetune) return; // nothing new to schedule
    this.lastDetune = d;
    const t = this.ctx.currentTime;
    for (let i = 0; i < this.oscs.length; i++) {
      this.oscs[i]!.frequency.setTargetAtTime(HUM_PARTIALS[i]! * (1 + d), t, 0.2);
    }
  }

  async suspend(): Promise<void> {
    if (this.ctx?.state === 'running') await this.ctx.suspend();
  }

  async resume(): Promise<void> {
    if (this.disposed) return;
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
  }

  /** REQUIRED on teardown — stops oscillators, disconnects every node, closes context. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const o of this.oscs) {
      try {
        o.stop();
        o.disconnect();
      } catch {
        /* already stopped */
      }
    }
    this.oscs = [];
    for (const n of [...this.gains, this.master, this.comp, this.limiter]) {
      try {
        n?.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.gains = [];
    this.master = null;
    this.comp = null;
    this.limiter = null;
    const ctx = this.ctx;
    this.ctx = null;
    void ctx?.close();
    this.unlocked = false;
  }
}
