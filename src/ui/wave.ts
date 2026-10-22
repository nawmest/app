import type { Vitals } from '../rppg/estimator';

/** Scrolling pulse waveform with beat markers (the live "ECG strip" in the dock). */
export class WaveRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private level = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
  }

  /** `now` in seconds on the same clock as the vitals' beat times. */
  render(v: Vitals | null, now: number, dt: number): void {
    const { ctx, w, h } = this;
    if (!w) this.resize();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // Faint grid, like a monitor strip.
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < w; x += 16) {
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
    }
    ctx.moveTo(0, h / 2 + 0.5);
    ctx.lineTo(w, h / 2 + 0.5);
    ctx.stroke();

    const show = v && v.confidence > 0.2 ? 1 : 0;
    this.level += (show - this.level) * Math.min(1, dt * 3);
    const span = 6; // seconds shown
    const t1 = now;
    const t0 = t1 - span;
    const xOf = (t: number) => ((t - t0) / span) * w;
    if (!v || this.level < 0.02) {
      // Idle trace.
      ctx.strokeStyle = 'rgba(147,160,184,0.35)';
      ctx.beginPath();
      for (let x = 0; x <= w; x += 3) {
        const y = h / 2 + Math.sin(x * 0.05 + now * 4) * 1.5;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      return;
    }
    const amp = (h / 2 - 8) * this.level;
    const path = new Path2D();
    let started = false;
    for (let i = 0; i < v.waveform.length; i++) {
      const t = v.waveformT0 + i / v.fs;
      if (t < t0) continue;
      const x = xOf(t);
      const y = h / 2 - v.waveform[i] * amp;
      if (!started) {
        path.moveTo(x, y);
        started = true;
      } else path.lineTo(x, y);
    }
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(255,84,112,0)');
    grad.addColorStop(0.25, 'rgba(255,84,112,0.65)');
    grad.addColorStop(1, 'rgba(255,120,140,1)');
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,84,112,0.18)';
    ctx.lineWidth = 6;
    ctx.stroke(path);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.stroke(path);
    // Beat markers.
    for (const b of v.beats) {
      if (b < t0 || b > t1) continue;
      const x = xOf(b);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.arc(x, 7, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
