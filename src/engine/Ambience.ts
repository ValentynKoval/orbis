/**
 * Generative sound bed, no audio files: two detuned low drones breathing
 * through a slow filter sweep, a whisper of filtered noise like a distant
 * radio carrier, and a soft ping when something is selected. Starts only
 * after a user gesture, as browsers require.
 */
export class Ambience {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  get playing() {
    return !!this.ctx && this.ctx.state === "running";
  }

  async start() {
    if (this.ctx) {
      await this.ctx.resume();
      this.fade(0.9, 2.5);
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    this.master = master;

    // Drone: a fifth apart, slightly detuned, through a lowpass that breathes.
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    filter.Q.value = 0.7;
    filter.connect(master);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.035;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
    for (const [freq, detune, level] of [
      [55, -6, 0.22],
      [82.4, 5, 0.16],
      [110, 9, 0.06],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(filter);
      osc.start();
    }

    // Carrier hiss: pink-ish noise through a narrow band-pass, very quiet.
    const length = ctx.sampleRate * 4;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + white * 0.03;
      b1 = 0.985 * b1 + white * 0.05;
      data[i] = b0 + b1;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1800;
    band.Q.value = 4;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.05;
    noise.connect(band).connect(noiseGain).connect(master);
    noise.start();

    this.fade(0.9, 3);
  }

  stop() {
    if (!this.ctx) return;
    this.fade(0, 0.8);
    const ctx = this.ctx;
    window.setTimeout(() => {
      if (this.master?.gain.value !== undefined && this.master.gain.value < 0.01) ctx.suspend();
    }, 900);
  }

  /** A short, soft two-note chime for selections. */
  ping() {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== "running") return;
    const now = ctx.currentTime;
    for (const [freq, delay] of [
      [1318.5, 0],
      [1975.5, 0.07],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now + delay);
      g.gain.linearRampToValueAtTime(0.05, now + delay + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.9);
      osc.connect(g).connect(this.master);
      osc.start(now + delay);
      osc.stop(now + delay + 1);
    }
  }

  dispose() {
    this.ctx?.close();
    this.ctx = null;
  }

  private fade(to: number, seconds: number) {
    if (!this.ctx || !this.master) return;
    const g = this.master.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(to * 0.35, now + seconds);
  }
}
