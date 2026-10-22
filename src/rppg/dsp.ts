/** Signal-processing building blocks for camera-based vital signs. */

/**
 * Resamples irregularly timed samples onto a uniform grid (linear interpolation).
 * `times` in seconds, ascending. Returns the grid start time and the resampled channels.
 */
export function resampleUniform(times: ArrayLike<number>, channels: ArrayLike<number>[], fs: number, from?: number, to?: number) {
  const n = times.length;
  const t0 = from ?? times[0];
  const t1 = to ?? times[n - 1];
  const count = Math.max(0, Math.floor((t1 - t0) * fs) + 1);
  const out = channels.map(() => new Float64Array(count));
  let j = 0;
  for (let i = 0; i < count; i++) {
    const t = t0 + i / fs;
    while (j < n - 2 && times[j + 1] < t) j++;
    const ta = times[j];
    const tb = times[Math.min(j + 1, n - 1)];
    const k = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 0;
    for (let c = 0; c < channels.length; c++) {
      const a = channels[c][j];
      const b = channels[c][Math.min(j + 1, n - 1)];
      out[c][i] = a + (b - a) * k;
    }
  }
  return { t0, channels: out };
}

export function mean(x: ArrayLike<number>, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i];
  return s / Math.max(1, to - from);
}

export function std(x: ArrayLike<number>, from = 0, to = x.length): number {
  const m = mean(x, from, to);
  let s = 0;
  for (let i = from; i < to; i++) s += (x[i] - m) * (x[i] - m);
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Second-order section (RBJ cookbook biquad). */
interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function biquad(type: 'lowpass' | 'highpass', f: number, fs: number, q = Math.SQRT1_2): Biquad {
  const w = (2 * Math.PI * f) / fs;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b1 = type === 'lowpass' ? 1 - cos : -(1 + cos);
  const b0 = type === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2;
  return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

function runBiquad(x: Float64Array, s: Biquad): void {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  // Start from steady state on the first value to limit the edge transient.
  const dc = (s.b0 + s.b1 + s.b2) / (1 + s.a1 + s.a2);
  if (Number.isFinite(dc)) {
    x1 = x2 = x[0];
    y1 = y2 = x[0] * dc;
  }
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    const y = s.b0 * v + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/**
 * Zero-phase band-pass (Butterworth high-pass + low-pass, run forwards and backwards), so beat
 * timing is not shifted. Returns a new array.
 */
export function bandpass(x: ArrayLike<number>, fs: number, lo: number, hi: number): Float64Array {
  const y = Float64Array.from(x);
  const m = mean(y);
  for (let i = 0; i < y.length; i++) y[i] -= m;
  const sections = [biquad('highpass', lo, fs), biquad('lowpass', hi, fs)];
  for (const s of sections) {
    runBiquad(y, s);
    y.reverse();
    runBiquad(y, s);
    y.reverse();
  }
  return y;
}

/** In-place radix-2 FFT. Length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Power spectrum of a Hann-windowed, zero-padded signal. `df` is the bin spacing in Hz. */
export function powerSpectrum(x: ArrayLike<number>, fs: number, minSize = 4096): { power: Float64Array; df: number } {
  let n = minSize;
  while (n < x.length) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const m = mean(x);
  const N = x.length;
  for (let i = 0; i < N; i++) re[i] = (x[i] - m) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  fft(re, im);
  const power = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) power[i] = re[i] * re[i] + im[i] * im[i];
  return { power, df: fs / n };
}

export interface SpectralPeak {
  /** Peak frequency in Hz (parabolic interpolation between bins). */
  freq: number;
  /**
   * Signal-to-noise ratio in dB: power around the peak (and its first harmonic, when
   * `harmonic`) versus the rest of the band (de Haan & Jeanne, 2013).
   */
  snr: number;
}

export function dominantFrequency(x: ArrayLike<number>, fs: number, lo: number, hi: number, harmonic = true): SpectralPeak | null {
  if (x.length < fs * 2) return null;
  const { power, df } = powerSpectrum(x, fs);
  const i0 = Math.max(1, Math.ceil(lo / df));
  const i1 = Math.min(power.length - 2, Math.floor(hi / df));
  let best = -1;
  for (let i = i0; i <= i1; i++) if (best < 0 || power[i] > power[best]) best = i;
  if (best < 0) return null;
  if (harmonic) {
    // Pulse waves can carry more power in their second harmonic than in the fundamental.
    // A strong peak at half the frequency means that half is the real rate.
    const half = Math.round(best / 2);
    let sub = -1;
    for (let i = Math.max(i0, half - 2); i <= Math.min(i1, half + 2); i++) if (sub < 0 || power[i] > power[sub]) sub = i;
    if (sub >= 0 && power[sub] > 0.3 * power[best] && power[sub] >= power[sub - 1] && power[sub] >= power[sub + 1]) best = sub;
  }
  const a = power[best - 1], b = power[best], c = power[best + 1];
  const den = a - 2 * b + c;
  const shift = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  const freq = (best + shift) * df;
  // SNR: energy within +-0.1 Hz of the peak (+ harmonic) vs the rest of [lo, 2*hi].
  const w = Math.max(1, Math.round(0.1 / df));
  let sig = 0;
  let noise = 0;
  const end = Math.min(power.length - 1, Math.floor((harmonic ? Math.max(hi, 2 * freq + 0.2) : hi) / df));
  for (let i = i0; i <= end; i++) {
    const near = Math.abs(i - freq / df) <= w || (harmonic && Math.abs(i - (2 * freq) / df) <= w);
    if (near) sig += power[i];
    else noise += power[i];
  }
  return { freq, snr: 10 * Math.log10(sig / Math.max(noise, 1e-12)) };
}

/**
 * Finds systolic peaks in a band-passed pulse signal. `minGap` is the shortest allowed
 * interval between beats (seconds). Returns sample indices (with sub-sample refinement).
 */
export function findPeaks(x: ArrayLike<number>, fs: number, minGap: number): number[] {
  const n = x.length;
  const sd = std(x);
  const gap = Math.max(1, Math.round(minGap * fs));
  const peaks: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (!(x[i] > x[i - 1] && x[i] >= x[i + 1] && x[i] > 0.2 * sd)) continue;
    // Must be the highest point within +-gap/2.
    let isMax = true;
    for (let k = Math.max(0, i - (gap >> 1)); k <= Math.min(n - 1, i + (gap >> 1)); k++) {
      if (x[k] > x[i]) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    if (peaks.length && i - peaks[peaks.length - 1] < gap) continue;
    const a = x[i - 1], b = x[i], c = x[i + 1];
    const den = a - 2 * b + c;
    peaks.push(i + (den !== 0 ? (0.5 * (a - c)) / den : 0));
  }
  return peaks;
}

export interface HrvMetrics {
  /** Root mean square of successive differences, ms. */
  rmssd: number;
  /** Standard deviation of normal-to-normal intervals, ms. */
  sdnn: number;
  beats: number;
}

/**
 * Time-domain HRV from beat times (s). Intervals more than 20% away from the median, and their
 * neighbours' differences, are treated as artefacts and skipped.
 */
export function hrvFromBeats(beatTimes: number[]): HrvMetrics | null {
  const ibi: number[] = [];
  for (let i = 1; i < beatTimes.length; i++) ibi.push((beatTimes[i] - beatTimes[i - 1]) * 1000);
  if (ibi.length < 8) return null;
  const sorted = [...ibi].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const ok = ibi.map((v) => Math.abs(v - med) <= 0.2 * med);
  const nn = ibi.filter((_, i) => ok[i]);
  if (nn.length < 8) return null;
  let diffs: number[] = [];
  for (let i = 1; i < ibi.length; i++) if (ok[i] && ok[i - 1]) diffs.push(ibi[i] - ibi[i - 1]);
  // Drop successive differences that are outliers (> 3.5 robust standard deviations).
  const absd = diffs.map(Math.abs).sort((a, b) => a - b);
  const mad = absd[absd.length >> 1] * 1.4826;
  if (mad > 0) diffs = diffs.filter((d) => Math.abs(d) <= 3.5 * mad);
  if (diffs.length < 6) return null;
  const rmssd = Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length);
  return { rmssd, sdnn: std(nn), beats: nn.length + 1 };
}
