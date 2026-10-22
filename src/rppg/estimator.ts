import { bandpass, dominantFrequency, findPeaks, hrvFromBeats, type HrvMetrics, resampleUniform } from './dsp';
import { pos } from './pos';

/** One analysed camera frame. */
export interface FrameSample {
  /** Capture time in seconds. */
  t: number;
  /** Mean skin colour of the measurement regions (0-255). */
  rgb: [number, number, number];
  /** Vertical head position relative to face height (breathing moves it slightly). */
  motionY: number;
}

export interface Vitals {
  /** Beats per minute, or null until the signal is good enough. */
  heartRate: number | null;
  /** 0..1, from the pulse signal-to-noise ratio. */
  confidence: number;
  snrDb: number;
  /** Recent pulse waveform (normalised) and its sample times, for display. */
  waveform: Float64Array;
  waveformT0: number;
  fs: number;
  /** Detected heartbeat times (s) in the analysis window. */
  beats: number[];
  hrv: HrvMetrics | null;
  /** Breaths per minute (estimate), or null. */
  respiration: number | null;
  respirationConfidence: number;
}

export const SAMPLE_RATE = 30;
const HR_BAND: [number, number] = [0.65, 3.5]; // 39-210 bpm
const RESP_BAND: [number, number] = [0.1, 0.6]; // 6-36 breaths/min
/** Minimum pulse SNR (dB) for HRV; below it timing noise inflates RMSSD (see tests). */
export const HRV_MIN_SNR = 5;

/** Maps the pulse SNR (dB) to a 0..1 confidence. ~-6 dB is barely usable, +3 dB is excellent. */
export const confidenceFromSnr = (snr: number) => Math.max(0, Math.min(1, (snr + 8) / 11));

/**
 * Continuous vital-sign estimation from a stream of frame samples: POS pulse extraction over a
 * sliding window, spectral heart rate with quality gating and smoothing, beat detection for HRV,
 * and breathing rate from head motion and slow skin-colour changes.
 */
export class VitalsEstimator {
  private samples: FrameSample[] = [];
  private smoothedHr: number | null = null;
  private lastHrT = 0;

  constructor(
    /** Heart-rate analysis window (s). */
    private readonly hrWindow = 10,
    /** Longest history kept (s): respiration and HRV use up to this much. */
    private readonly maxHistory = 40,
  ) {}

  reset(): void {
    this.samples = [];
    this.smoothedHr = null;
  }

  get duration(): number {
    const n = this.samples.length;
    return n > 1 ? this.samples[n - 1].t - this.samples[0].t : 0;
  }

  push(s: FrameSample): void {
    const last = this.samples[this.samples.length - 1];
    if (last && s.t <= last.t) return;
    // A long gap (tab hidden, face lost) breaks the signal: start over.
    if (last && s.t - last.t > 1) this.reset();
    this.samples.push(s);
    const cutoff = s.t - this.maxHistory;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop].t < cutoff) drop++;
    if (drop) this.samples.splice(0, drop);
  }

  /**
   * `frameRate` is the real camera/analysis rate: content above half of it is aliased, so the
   * heart-rate search stops below that (45% for margin).
   */
  estimate(frameRate = SAMPLE_RATE): Vitals | null {
    const n = this.samples.length;
    if (n < 2 || this.duration < 4) return null;
    const fs = SAMPLE_RATE;
    const hrHi = Math.max(HR_BAND[0] + 0.5, Math.min(HR_BAND[1], 0.45 * frameRate));
    const tEnd = this.samples[n - 1].t;
    const times = this.samples.map((s) => s.t);
    const all = resampleUniform(
      times,
      [this.samples.map((s) => s.rgb[0]), this.samples.map((s) => s.rgb[1]), this.samples.map((s) => s.rgb[2]), this.samples.map((s) => s.motionY)],
      fs,
    );
    const [r, g, b, my] = all.channels;
    const N = r.length;

    // Pulse over the whole history, band-limited to plausible heart rates. POS output falls as
    // blood volume rises (skin absorbs more), so flip it to make systolic peaks maxima.
    const pulse = bandpass(pos(r, g, b, fs).map((v) => -v), fs, HR_BAND[0], hrHi);
    const hrStart = Math.max(0, N - Math.round(this.hrWindow * fs));
    const hrSeg = pulse.subarray(hrStart);
    const peak = dominantFrequency(hrSeg, fs, HR_BAND[0], hrHi);
    const snr = peak?.snr ?? -20;
    const confidence = confidenceFromSnr(snr);

    // Smooth the heart rate; trust new values in proportion to their quality.
    let hr: number | null = null;
    if (peak && confidence > 0.15) {
      const raw = peak.freq * 60;
      const dt = Math.max(0.05, tEnd - this.lastHrT);
      this.lastHrT = tEnd;
      if (this.smoothedHr === null) this.smoothedHr = raw;
      else {
        const jump = Math.abs(raw - this.smoothedHr);
        // Large jumps need strong evidence (and are more likely a harmonic or noise).
        const trust = confidence * (jump > 15 ? 0.25 : 1);
        const k = 1 - Math.exp(-dt * 2 * trust);
        this.smoothedHr += (raw - this.smoothedHr) * k;
      }
      hr = this.smoothedHr;
    }

    // Beats are timed at the steepest point of each systolic upstroke (the peak of the first
    // derivative), which is sharper and less noise-sensitive than the rounded top of the wave.
    const minGap = hr ? (0.6 * 60) / hr : 0.3;
    const slope = new Float64Array(pulse.length);
    for (let i = 1; i < pulse.length - 1; i++) slope[i] = (pulse[i + 1] - pulse[i - 1]) / 2;
    const peaks = findPeaks(slope, fs, minGap);
    const beats = peaks.map((i) => all.t0 + i / fs);
    // Beat-to-beat timing is far more noise-sensitive than the average rate: only report HRV
    // from a clean signal.
    const hrv = hr && snr >= HRV_MIN_SNR ? hrvFromBeats(beats.filter((t) => t > tEnd - 30)) : null;

    // Breathing: head motion and the slow colour baseline (respiratory-induced intensity
    // variation); keep the cleaner of the two.
    let respiration: number | null = null;
    let respirationConfidence = 0;
    if (this.duration >= 15) {
      const start = Math.max(0, N - Math.round(30 * fs));
      const lp = 0.08;
      const cand = [bandpass(my.subarray(start), fs, lp, RESP_BAND[1]), bandpass(g.subarray(start), fs, lp, RESP_BAND[1])]
        .map((x) => dominantFrequency(x, fs, RESP_BAND[0], RESP_BAND[1], false))
        .filter((p): p is NonNullable<typeof p> => !!p)
        .sort((p, q) => q.snr - p.snr);
      if (cand.length) {
        respirationConfidence = Math.max(0, Math.min(1, (cand[0].snr + 4) / 10));
        if (respirationConfidence > 0.2) respiration = cand[0].freq * 60;
      }
    }

    // Waveform for display: last 6 s, normalised.
    const wStart = Math.max(0, N - 6 * fs);
    const wave = pulse.slice(wStart);
    let peakAbs = 1e-9;
    for (const v of wave) peakAbs = Math.max(peakAbs, Math.abs(v));
    for (let i = 0; i < wave.length; i++) wave[i] /= peakAbs;

    return {
      heartRate: hr,
      confidence,
      snrDb: snr,
      waveform: wave,
      waveformT0: all.t0 + wStart / fs,
      fs,
      beats,
      hrv,
      respiration,
      respirationConfidence,
    };
  }
}
