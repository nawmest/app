import { bandpass, dominantFrequency, findPeaks, hrvFromBeats, type HrvMetrics, resampleUniform } from './dsp';
import { type MotionInfo, type Pose, suppressMotion } from './motion';
import { pos } from './pos';

/** One analysed camera frame. */
export interface FrameSample {
  /** Capture time in seconds. */
  t: number;
  /** Mean skin colour of the measurement regions (0-255). */
  rgb: [number, number, number];
  /** Vertical head position relative to face height (breathing moves it slightly). */
  motionY: number;
  /** Head pose, for removing motion artefacts (see `suppressMotion`). */
  pose?: Pose;
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
  /** Unsmoothed heart rate from this window (bpm), for diagnostics. */
  rawHeartRate: number | null;
  /** Head-motion analysis, when pose was supplied. */
  motion: MotionInfo | null;
}

export const SAMPLE_RATE = 30;
const HR_BAND: [number, number] = [0.65, 3.5]; // 39-210 bpm
const RESP_BAND: [number, number] = [0.1, 0.6]; // 6-36 breaths/min
/** Head motion can follow faster breathing (after exercise) without confusing it with the pulse. */
const RESP_MOTION_HI = 0.75; // 45 breaths/min
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
  /** Recent raw (unsmoothed) estimates, to notice when the smoothed value is stuck on a wrong one. */
  private recentRaw: number[] = [];

  constructor(
    /** Heart-rate analysis window (s). */
    private readonly hrWindow = 10,
    /** Longest history kept (s): respiration and HRV use up to this much. */
    private readonly maxHistory = 40,
  ) {}

  reset(): void {
    this.samples = [];
    this.smoothedHr = null;
    this.recentRaw = [];
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
    const hasPose = this.samples.every((s) => s.pose);
    const all = resampleUniform(
      times,
      [
        this.samples.map((s) => s.rgb[0]),
        this.samples.map((s) => s.rgb[1]),
        this.samples.map((s) => s.rgb[2]),
        this.samples.map((s) => s.motionY),
        ...(hasPose ? [0, 1, 2, 3, 4, 5].map((c) => this.samples.map((s) => s.pose![c])) : []),
      ],
      fs,
    );
    const [r, g, b, my, ...poseCh] = all.channels;
    const N = r.length;

    // Pulse over the whole history, band-limited to plausible heart rates. POS output falls as
    // blood volume rises (skin absorbs more), so flip it to make systolic peaks maxima.
    const pulse = bandpass(pos(r, g, b, fs).map((v) => -v), fs, HR_BAND[0], hrHi);
    const hrStart = Math.max(0, N - Math.round(this.hrWindow * fs));
    let motion: MotionInfo | null = null;
    if (hasPose) {
      const m = suppressMotion(pulse, poseCh, hrStart, fs, HR_BAND[0], hrHi);
      pulse.set(m.clean, hrStart);
      motion = m.info;
    }
    const hrSeg = pulse.subarray(hrStart);
    const peak = dominantFrequency(hrSeg, fs, HR_BAND[0], hrHi, true);
    const snr = peak?.snr ?? -20;
    const confidence = confidenceFromSnr(snr);

    // Smooth the heart rate; trust new values in proportion to their quality.
    let hr: number | null = null;
    if (peak && confidence > 0.15) {
      const raw = peak.freq * 60;
      const dt = Math.max(0.05, tEnd - this.lastHrT);
      this.lastHrT = tEnd;
      // Only clear readings take part in re-locking, so it can't snap onto a run of noise.
      if (confidence >= 0.6) this.recentRaw.push(raw);
      else this.recentRaw = [];
      if (this.recentRaw.length > 6) this.recentRaw.shift();
      const recent = this.recentRaw.slice(-5).sort((a, b) => a - b);
      const median = recent[recent.length >> 1];
      const agree = recent.length === 5 && recent[4] - recent[0] < 8;
      if (this.smoothedHr === null) this.smoothedHr = raw;
      else if (agree && Math.abs(median - this.smoothedHr) > 12) {
        // Five consecutive estimates agree on a clearly different rate: the earlier lock was
        // wrong (e.g. noise during the first seconds) or the rate really moved. Re-lock.
        this.smoothedHr = median;
      } else {
        const jump = Math.abs(raw - this.smoothedHr);
        // Isolated large jumps need strong evidence (and are more likely noise).
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
      const cand = [
        dominantFrequency(bandpass(my.subarray(start), fs, lp, RESP_MOTION_HI), fs, RESP_BAND[0], RESP_MOTION_HI, false),
        dominantFrequency(bandpass(g.subarray(start), fs, lp, RESP_BAND[1]), fs, RESP_BAND[0], RESP_BAND[1], false),
      ]
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
      rawHeartRate: peak ? peak.freq * 60 : null,
      motion,
    };
  }
}
