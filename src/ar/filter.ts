/**
 * One Euro filter (Casiez et al. 2012): smooths jitter when still, stays responsive when moving.
 * Filters a fixed-size vector of values.
 */
export class OneEuroFilter {
  private x: Float64Array | null = null;
  private dx: Float64Array;
  private lastTime = 0;

  constructor(
    readonly size: number,
    public minCutoff = 1.2,
    public beta = 0.02,
    public dCutoff = 1.0,
  ) {
    this.dx = new Float64Array(size);
  }

  reset(): void {
    this.x = null;
    this.dx.fill(0);
  }

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** `time` in seconds. Returns the filtered values (internal buffer, copy if you keep it). */
  filter(values: ArrayLike<number>, time: number): Float64Array {
    if (!this.x) {
      this.x = Float64Array.from(values);
      this.lastTime = time;
      return this.x;
    }
    const dt = Math.max(1e-3, time - this.lastTime);
    this.lastTime = time;
    const ad = OneEuroFilter.alpha(this.dCutoff, dt);
    for (let i = 0; i < this.size; i++) {
      const rawDx = (values[i] - this.x[i]) / dt;
      this.dx[i] += ad * (rawDx - this.dx[i]);
      const cutoff = this.minCutoff + this.beta * Math.abs(this.dx[i]);
      const a = OneEuroFilter.alpha(cutoff, dt);
      this.x[i] += a * (values[i] - this.x[i]);
    }
    return this.x;
  }
}
