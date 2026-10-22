/**
 * Eyelid analysis for tiredness. Sleepiness shows in the eyes before anything else: blinks get
 * longer and slower, the lids droop and stay closed for more of the time (PERCLOS, the share of
 * time the eyes are at least 80% closed, is the standard drowsiness measure in driver
 * monitoring), and yawns appear. The input is MediaPipe's eye-blink blendshape per frame.
 */

export interface EyeStats {
  /** Observed time (s). */
  seconds: number;
  blinks: number;
  blinksPerMin: number;
  /** Mean time each blink keeps the eyes more than half closed (ms), or null without blinks. */
  meanBlinkMs: number | null;
  /** Share of time the eyes were at least 80% closed (0..1). */
  perclos: number;
  /** Closures of half a second or more (eyes resting shut, micro-sleeps). */
  longClosures: number;
  yawns: number;
  /** Whether the numbers can be trusted; otherwise why not. */
  issue: null | 'eyes-closed' | 'low-fps';
}

/** Longest frame gap counted as observed time (s); longer gaps are lost tracking. */
const MAX_GAP = 0.25;

export class EyeAnalyzer {
  private t: number[] = [];
  private closure: number[] = [];
  private jaw: number[] = [];

  reset(): void {
    this.t = [];
    this.closure = [];
    this.jaw = [];
  }

  push(t: number, closure: number, jawOpen: number): void {
    const last = this.t[this.t.length - 1];
    if (last !== undefined && t <= last) return;
    this.t.push(t);
    this.closure.push(closure);
    this.jaw.push(jawOpen);
  }

  stats(): EyeStats | null {
    const { t, closure: c, jaw } = this;
    const n = t.length;
    let seconds = 0;
    for (let i = 1; i < n; i++) seconds += Math.min(MAX_GAP, t[i] - t[i - 1]);
    if (n < 30 || seconds < 10) return null;
    const fps = (n - 1) / (t[n - 1] - t[0]);

    // People's "open" level differs (and rises when looking down at a phone): measure the
    // thresholds from it rather than using fixed ones.
    const open = c.slice().sort((a, b) => a - b)[Math.floor(n * 0.25)];
    const at = (fraction: number) => open + fraction * (1 - open);
    const half = at(0.5);
    const shut = at(0.8);
    const release = at(0.3);

    // Blinks: from rising above half closure to falling back below it (with hysteresis), timed
    // at interpolated crossings of the half-closure level.
    const cross = (i: number, level: number) => t[i - 1] + ((level - c[i - 1]) / (c[i] - c[i - 1])) * (t[i] - t[i - 1]);
    const durations: number[] = [];
    let start: number | null = null;
    let below: number | null = null;
    for (let i = 1; i < n; i++) {
      if (t[i] - t[i - 1] > MAX_GAP) {
        start = null;
        continue;
      }
      if (start === null) {
        if (c[i] >= half && c[i - 1] < half) {
          start = cross(i, half);
          below = null;
        }
      } else {
        if (below === null && c[i] < half && c[i - 1] >= half) below = cross(i, half);
        if (below !== null && c[i] >= half) below = null;
        if (c[i] < release) {
          durations.push((below ?? t[i]) - start);
          start = null;
        }
      }
    }

    let perclosT = 0;
    for (let i = 1; i < n; i++) if (c[i] >= shut) perclosT += Math.min(MAX_GAP, t[i] - t[i - 1]);

    let yawns = 0;
    let yawnStart: number | null = null;
    for (let i = 0; i < n; i++) {
      if (jaw[i] > 0.5) {
        yawnStart ??= t[i];
        if (t[i] - yawnStart >= 1.2) {
          yawns++;
          yawnStart = Infinity; // counted; wait for the mouth to close
        }
      } else yawnStart = null;
    }

    return {
      seconds,
      blinks: durations.length,
      blinksPerMin: (durations.length / seconds) * 60,
      meanBlinkMs: durations.length ? (durations.reduce((s, d) => s + d, 0) / durations.length) * 1000 : null,
      perclos: perclosT / seconds,
      longClosures: durations.filter((d) => d >= 0.5).length,
      yawns,
      issue: open > 0.5 ? 'eyes-closed' : fps < 12 ? 'low-fps' : null,
    };
  }
}
