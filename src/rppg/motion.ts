import { bandpass, dominantFrequency, mean, std } from './dsp';

/**
 * Head pose references, per frame: face centre x and y and face size (in face heights), yaw,
 * pitch and roll (radians).
 */
export type Pose = [number, number, number, number, number, number];

/**
 * Below these variations (std over the analysis window) a pose reference is only tracking
 * jitter, and is left out.
 */
const MIN_STD = [0.004, 0.004, 0.003, 0.01, 0.01, 0.01];

export interface MotionInfo {
  /** Whether the head moved enough for motion to matter. */
  active: boolean;
  /** Frequency (Hz) of clearly rhythmic head motion (e.g. heavy breathing), or null. */
  freq: number | null;
  /** Fraction of the pulse signal's energy explained by head motion and removed. */
  removed: number;
}

/** Solves (A + ridge·I) x = b for a small symmetric positive-definite A (Gaussian elimination). */
function solve(A: number[][], b: number[], ridge: number): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row.map((v, j) => v + (i === j ? ridge : 0)), b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * Removes motion artefacts from a band-passed pulse signal. When the head moves (heavy breathing
 * after exercise, a hand-held phone), the light on the skin changes with it. That change is
 * strongest at the motion frequency and its harmonics, and can outweigh the pulse: breathing at
 * 32/min puts an artefact at 64 "bpm". The pose references and their squares (for the harmonic
 * that shading produces when the head rocks both ways; cubes too for large motion) are
 * band-passed like the pulse and regressed out of it. Also reports the frequency of clearly
 * rhythmic motion, for diagnostics.
 *
 * `pose` holds full-history pose channels (resampled like the pulse); `from` is where the
 * analysis window starts.
 */
export function suppressMotion(
  pulse: Float64Array,
  pose: Float64Array[],
  from: number,
  fs: number,
  lo: number,
  hi: number,
): { clean: Float64Array; info: MotionInfo } {
  const seg = pulse.slice(from);
  const regressors: Float64Array[] = [];
  let best: { freq: number; snr: number } | null = null;
  pose.forEach((ch, c) => {
    const amount = std(ch, from) / MIN_STD[c];
    if (amount < 1) return;
    // Faster than drifting (~0.08 Hz), as the motion that can leave artefacts in the pulse band.
    const m = bandpass(ch, fs, 0.08, hi);
    const mm = mean(m);
    const ms = std(m) || 1;
    const sq = m.map((v) => ((v - mm) / ms) ** 2);
    const terms = [bandpass(m, fs, lo, hi), bandpass(sq, fs, lo, hi)];
    // Only large motion (heavy breathing) leaves a 3rd harmonic; for small motion the extra
    // reference would mostly take away pulse that happens to sit there.
    if (amount >= 3) terms.push(bandpass(m.map((v) => ((v - mm) / ms) ** 3), fs, lo, hi));
    for (const r of terms) {
      const w = r.slice(from);
      const s = std(w);
      if (s > 1e-12) regressors.push(w.map((v) => v / s));
    }
    const p = dominantFrequency(m.subarray(from), fs, 0.15, hi, false);
    if (p && (!best || p.snr > best.snr)) best = p;
  });
  const active = regressors.length > 0;
  let removed = 0;
  let clean = seg;
  if (active) {
    const k = regressors.length;
    const A = regressors.map((a) => regressors.map((b) => a.reduce((s, v, i) => s + v * b[i], 0)));
    const b = regressors.map((a) => a.reduce((s, v, i) => s + v * seg[i], 0));
    // A little ridge keeps nearly collinear references stable.
    const beta = solve(A, b, 0.02 * seg.length);
    clean = seg.slice();
    for (let j = 0; j < k; j++) for (let i = 0; i < clean.length; i++) clean[i] -= beta[j] * regressors[j][i];
    const v0 = std(seg) ** 2;
    removed = v0 > 0 ? Math.max(0, 1 - std(clean) ** 2 / v0) : 0;
  }
  const rhythmic = best as { freq: number; snr: number } | null;
  return { clean, info: { active, freq: rhythmic && rhythmic.snr > 0 ? rhythmic.freq : null, removed } };
}
