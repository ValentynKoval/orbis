/**
 * Simulated time. Live mode tracks the wall clock; later, the timeline can
 * offset it or change its rate without any layer knowing the difference.
 */
export class SimClock {
  private anchorReal = performance.now();
  private anchorSim = Date.now();
  private _rate = 1;

  now(): number {
    return this.anchorSim + (performance.now() - this.anchorReal) * this._rate;
  }

  get rate() {
    return this._rate;
  }

  get isLive() {
    return this._rate === 1 && Math.abs(this.now() - Date.now()) < 2000;
  }

  set(simMs: number, rate = this._rate) {
    this.anchorReal = performance.now();
    this.anchorSim = simMs;
    this._rate = rate;
  }

  goLive() {
    this.set(Date.now(), 1);
  }
}
