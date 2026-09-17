/** Schumann Hum pad — Web Audio. MUST dispose on teardown. */

const SCHUMANN = 7.83;

export class HumEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private oscs: OscillatorNode[] = [];
  private gains: GainNode[] = [];
  private unlocked = false;
  private disposed = false;

  /** Call from a direct user gesture. */
  async unlock(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.unlocked && this.ctx?.state === 'running') return true;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return false;
    if (!this.ctx) {
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.buildGraph();
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    this.unlocked = this.ctx.state === 'running';
    return this.unlocked;
  }

  private buildGraph(): void {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.gain.value = 0.0001;

    // brick-wall-ish limiter after gentle compress
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 6;
    comp.ratio.value = 3.2;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.05;

    this.master.connect(comp);
    comp.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    // partials near Schumann stack (audible octave lifts of 7.83)
    const partials = [SCHUMANN * 32, SCHUMANN * 48, SCHUMANN * 64, SCHUMANN * 96];
    const levels = [0.22, 0.14, 0.1, 0.06];
    partials.forEach((hz, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.value = levels[i] ?? 0.05;
      osc.connect(g);
      g.connect(this.master!);
      osc.start();
      this.oscs.push(osc);
      this.gains.push(g);
    });

    // ramp in
    const t = ctx.currentTime;
    this.master.gain.exponentialRampToValueAtTime(0.55, t + 0.8);
  }

  setMuted(muted: boolean): void {
    if (!this.master || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.linearRampToValueAtTime(muted ? 0.0001 : 0.55, t + 0.05);
  }

  /** Map field energy lightly into detune / level. */
  modulate(energy: number): void {
    if (!this.ctx || !this.master) return;
    const e = Math.min(1, Math.max(0, energy * 8));
    for (let i = 0; i < this.oscs.length; i++) {
      const base = [SCHUMANN * 32, SCHUMANN * 48, SCHUMANN * 64, SCHUMANN * 96][i]!;
      this.oscs[i]!.frequency.setTargetAtTime(base * (1 + e * 0.02), this.ctx.currentTime, 0.2);
    }
  }

  async suspend(): Promise<void> {
    if (this.ctx?.state === 'running') await this.ctx.suspend();
  }

  async resume(): Promise<void> {
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
  }

  /** REQUIRED on teardown — stops oscillators and closes context. */
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
    for (const g of this.gains) {
      try {
        g.disconnect();
      } catch {
        /* */
      }
    }
    this.gains = [];
    try {
      this.master?.disconnect();
      this.limiter?.disconnect();
    } catch {
      /* */
    }
    this.master = null;
    this.limiter = null;
    const ctx = this.ctx;
    this.ctx = null;
    void ctx?.close();
    this.unlocked = false;
  }
}
