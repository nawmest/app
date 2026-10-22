import { describe, expect, it } from 'vitest';
import { bandpass, dominantFrequency, fft, hrvFromBeats } from '../src/rppg/dsp';
import { VitalsEstimator } from '../src/rppg/estimator';
import type { Pose } from '../src/rppg/motion';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** PPG-like beat: fast systolic rise, slower decay, smaller dicrotic wave. Phase in [0, 1). */
const beatShape = (ph: number) =>
  ph < 0.15 ? Math.sin((ph / 0.15) * (Math.PI / 2)) ** 2 : Math.exp(-(ph - 0.15) / 0.22) + 0.25 * Math.exp(-(((ph - 0.5) / 0.1) ** 2));

interface SimOptions {
  bpm: number;
  seconds: number;
  /** Beat-to-beat variability (std of RR intervals, ms). */
  rrJitterMs?: number;
  breathsPerMin?: number;
  /** Common-mode illumination flicker amplitude (fraction). */
  flicker?: number;
  pulseAmplitude?: number;
  /** Noise on the region mean (peak-to-peak, colour levels). */
  noise?: number;
  /** Heart rate at the end of the recording, for a linear change (e.g. recovery after exercise). */
  bpmEnd?: number;
  /**
   * Colour disturbances that don't follow the skin tone (moving shading, sweat highlights,
   * changing light), so POS can't fully cancel them: [frequency Hz, relative amplitude].
   */
  disturbances?: [number, number][];
  /**
   * Heavy breathing that rocks the head (pitch amplitude, rad) and changes the shading of the
   * skin with it, including a harmonic at twice the breathing rate. Needs `breathsPerMin`.
   */
  heave?: { pitch: number; shading: number };
  /** Stretches with a different noise level: [from s, to s, noise]. */
  noisyBetween?: [number, number, number][];
  /** Slow hand-held camera drift (face position, face heights) with a matching light gradient. */
  drift?: number;
  seed?: number;
}

/** Simulates the mean skin colour of a face under a camera, frame by frame. */
function simulate(o: SimOptions) {
  const r = rng(o.seed ?? 1);
  // Beat times with optional variability.
  const beats: number[] = [];
  let t = 0;
  const bpmAt = (time: number) => o.bpm + ((o.bpmEnd ?? o.bpm) - o.bpm) * Math.min(1, time / o.seconds);
  while (t < o.seconds + 2) {
    beats.push(t);
    t += 60 / bpmAt(t) + ((o.rrJitterMs ?? 0) / 1000) * (r() * 2 - 1) * Math.sqrt(3);
  }
  const pulseAt = (time: number) => {
    let i = 0;
    while (i < beats.length - 2 && beats[i + 1] <= time) i++;
    const ph = (time - beats[i]) / (beats[i + 1] - beats[i]);
    return beatShape(ph);
  };
  const base = [182, 134, 112];
  const pbv = [0.33, 0.77, 0.53]; // relative pulsatile strength per channel (blood volume pulse)
  const a = o.pulseAmplitude ?? 0.008;
  const samples: { t: number; rgb: [number, number, number]; motionY: number; pose: Pose }[] = [];
  const noiseAt = (t: number) => o.noisyBetween?.find(([a, b]) => t >= a && t < b)?.[2] ?? o.noise ?? 0.5;
  let ft = 0;
  while (ft < o.seconds) {
    const p = pulseAt(ft);
    const breath = o.breathsPerMin ? Math.sin((2 * Math.PI * o.breathsPerMin * ft) / 60) : 0;
    const light = 1 + (o.flicker ?? 0) * Math.sin(2 * Math.PI * 0.7 * ft) + 0.002 * breath + 0.003 * (r() - 0.5);
    let dist = 0;
    for (const [f, amp] of o.disturbances ?? []) dist += amp * Math.sin(2 * Math.PI * f * ft + f);
    const rock = o.heave ? Math.sin((2 * Math.PI * (o.breathsPerMin ?? 0) * ft) / 60 + 0.4) : 0;
    const pitch = (o.heave?.pitch ?? 0) * rock;
    // Shading follows how the face is tilted towards the light, both ways: fundamental + harmonic.
    let heave = 0;
    if (o.heave) heave = o.heave.shading * (0.5 * rock + rock * rock);
    const dx = (o.drift ?? 0) * (Math.sin(0.23 * ft) + 0.6 * Math.sin(0.41 * ft + 1));
    dist += 0.5 * dx;
    const tint = [1.0, 0.45, 0.2]; // not proportional to the skin tone
    // The region mean averages thousands of pixels: small noise, no integer quantisation.
    // Rocking also changes how much light reaches the skin under the surface (and the blood
    // seen through it), which looks like a blood volume change: POS can't remove it.
    const heaveTint = [0.4, 0.75, 0.5];
    const rgb = base.map((v, c) => v * light * (1 + dist * tint[c] + heave * heaveTint[c]) * (1 - a * pbv[c] * p) + (r() - 0.5) * noiseAt(ft)) as [number, number, number];
    const jit = () => (r() - 0.5) * 0.004; // landmark jitter
    const pose: Pose = [dx + jit(), 0.4 * pitch + 0.002 * breath + jit(), 0.7 + jit(), jit() * 2, pitch + jit() * 2, jit() * 2];
    samples.push({ t: ft, rgb, motionY: 0.002 * breath + 0.4 * pitch + 0.0005 * (r() - 0.5), pose });
    ft += 1 / 30 + (r() - 0.5) * 0.012; // jittery frame timing
  }
  return { samples, beats };
}

describe('dsp', () => {
  it('computes an FFT', () => {
    const re = Float64Array.from({ length: 8 }, (_, i) => Math.cos((2 * Math.PI * i) / 8));
    const im = new Float64Array(8);
    fft(re, im);
    expect(re[1]).toBeCloseTo(4);
    expect(re[7]).toBeCloseTo(4);
    expect(Math.abs(re[2])).toBeLessThan(1e-9);
  });

  it('finds the dominant frequency in a noisy band-passed signal', () => {
    const r = rng(4);
    const fs = 30;
    const x = Float64Array.from({ length: 300 }, (_, i) => Math.sin(2 * Math.PI * 1.3 * (i / fs)) + (r() - 0.5) * 1.5 + 0.02 * i);
    const p = dominantFrequency(bandpass(x, fs, 0.7, 3.5), fs, 0.7, 3.5)!;
    expect(p.freq).toBeCloseTo(1.3, 1);
    expect(p.snr).toBeGreaterThan(0);
  });

  it('computes HRV from beat times and rejects artefacts', () => {
    const beats = [0];
    const rr = [800, 840, 790, 830, 810, 850, 800, 820, 400, 810, 830, 790];
    for (const v of rr) beats.push(beats[beats.length - 1] + v / 1000);
    const h = hrvFromBeats(beats)!;
    expect(h.rmssd).toBeGreaterThan(20);
    expect(h.rmssd).toBeLessThan(60); // the 400 ms artefact is excluded
  });
});

describe('VitalsEstimator', () => {
  for (const bpm of [55, 72, 96, 125]) {
    it(`measures ${bpm} bpm from simulated skin colour`, () => {
      const { samples } = simulate({ bpm, seconds: 25, flicker: 0.01, seed: bpm });
      const est = new VitalsEstimator();
      let v = null;
      for (const s of samples) {
        est.push(s);
        if (s.t > 5 && Math.round(s.t * 30) % 15 === 0) v = est.estimate() ?? v;
      }
      v = est.estimate()!;
      expect(v.heartRate).not.toBeNull();
      expect(Math.abs(v.heartRate! - bpm)).toBeLessThan(2.5);
      expect(v.confidence).toBeGreaterThan(0.5);
    });
  }

  it('reads a slow pulse whose second harmonic is stronger than its fundamental', () => {
    // A very spiky wave (narrow systolic peak + dicrotic wave) puts most power at 2x the rate.
    const spiky = (ph: number) => Math.exp(-((ph - 0.18) ** 2) / 0.006) + 0.35 * Math.exp(-((ph - 0.55) ** 2) / 0.012);
    const fs = 30;
    const est = new VitalsEstimator();
    for (let i = 0; i < fs * 25; i++) {
      const t = i / fs;
      const p = spiky(((t * 56) / 60) % 1);
      est.push({ t, rgb: [182 * (1 - 0.008 * 0.33 * p), 134 * (1 - 0.008 * 0.77 * p), 112 * (1 - 0.008 * 0.53 * p)], motionY: 0 });
    }
    expect(Math.abs(est.estimate()!.heartRate! - 56)).toBeLessThan(2.5);
  });

  // After exercise: fast heart rate that is recovering, deep fast breathing (whose harmonic falls
  // right at half the heart rate) and body motion. The estimate must not lock onto half the rate.
  for (const [start, end, breaths] of [[132, 118, 30], [150, 136, 34], [112, 104, 26]]) {
    it(`tracks a post-exercise heart rate (${start} -> ${end} bpm) without halving it`, () => {
      const f2 = breaths / 60;
      const { samples } = simulate({
        bpm: start,
        bpmEnd: end,
        seconds: 30,
        breathsPerMin: breaths,
        disturbances: [[f2, 0.004], [2 * f2, 0.003], [(start + end) / 240, 0.0025], [0.35, 0.003]],
        seed: start,
      });
      const est = new VitalsEstimator();
      const seen: number[] = [];
      for (const s of samples) {
        est.push(s);
        if (s.t > 8 && Math.round(s.t * 30) % 8 === 0) {
          const v = est.estimate();
          if (v?.heartRate) seen.push(v.heartRate);
        }
      }
      const v = est.estimate()!;
      const truth = end + (start - end) * (5 / 30); // average over the last ~10 s
      expect(Math.abs(v.heartRate! - truth)).toBeLessThan(6);
      // No estimate in the last 15 s may fall near half the true rate.
      expect(Math.min(...seen.slice(-Math.floor(seen.length / 2)))).toBeGreaterThan(end * 0.75);
    });
  }

  for (const bpm of [124, 150]) {
    it(`measures a fast ${bpm} bpm pulse from a 15 fps camera`, () => {
      const { samples } = simulate({ bpm, seconds: 25, flicker: 0.01, seed: bpm + 1 });
      const est = new VitalsEstimator();
      let next = 0;
      let v = null;
      for (const s of samples) {
        if (s.t < next) continue;
        next += 1 / 15;
        est.push(s);
        v = est.estimate(15);
      }
      expect(Math.abs(v!.heartRate! - bpm)).toBeLessThan(3);
    });
  }

  // Heavy breathing rocks the head, and the light on the skin changes with it at the breathing
  // rate and twice it. Without the head pose, 32 breaths/min reads as a 64 bpm "pulse".
  for (const [bpm, brpm, shading] of [
    [125, 32, 0.016],
    [105, 26, 0.012],
  ]) {
    it(`measures ${bpm} bpm through heavy breathing at ${brpm}/min, using head pose`, () => {
      const run = (withPose: boolean) => {
        const { samples } = simulate({ bpm, seconds: 30, breathsPerMin: brpm, heave: { pitch: 0.05, shading }, flicker: 0.005, seed: brpm });
        const est = new VitalsEstimator();
        let v = null;
        for (const s of samples) {
          est.push(withPose ? s : { ...s, pose: undefined });
          if (Math.round(s.t * 30) % 8 === 0) v = est.estimate();
        }
        return v!;
      };
      const without = run(false);
      expect(Math.abs(without.heartRate! - 2 * brpm)).toBeLessThan(4); // the artefact wins
      const v = run(true);
      expect(Math.abs(v.heartRate! - bpm)).toBeLessThan(3);
      expect(v.motion!.active).toBe(true);
      expect(Math.abs(v.motion!.freq! * 60 - brpm)).toBeLessThan(2);
    });
  }

  for (const [name, o, bpm] of [
    ['a hand-held camera drifting', { bpm: 60, breathsPerMin: 14, drift: 0.05 }, 60],
    ['breathing at 24/min with slight head motion', { bpm: 72, breathsPerMin: 24, heave: { pitch: 0.02, shading: 0.002 } }, 72],
  ] as const) {
    it(`motion compensation keeps resting readings right: ${name}`, () => {
      const { samples } = simulate({ ...o, seconds: 30, flicker: 0.005, seed: 2 });
      const est = new VitalsEstimator();
      let v = null;
      for (const s of samples) {
        est.push(s);
        if (Math.round(s.t * 30) % 8 === 0) v = est.estimate();
      }
      expect(Math.abs(v!.heartRate! - bpm)).toBeLessThan(2.5);
    });
  }

  it('recovers quickly when the first seconds were disturbed', () => {
    // Heavy disturbance at 0.95 Hz (57 "bpm") for the first 9 s, then a clean 124 bpm pulse.
    const noisy = simulate({ bpm: 124, seconds: 9, disturbances: [[0.95, 0.02]], seed: 21 }).samples;
    const clean = simulate({ bpm: 124, seconds: 16, seed: 22 }).samples.map((s) => ({ ...s, t: s.t + 9.02 }));
    const est = new VitalsEstimator();
    let at: number | null = null;
    for (const s of [...noisy, ...clean]) {
      est.push(s);
      if (Math.round(s.t * 30) % 8 !== 0) continue;
      const v = est.estimate();
      if (s.t > 9 && at === null && v?.heartRate && Math.abs(v.heartRate - 124) < 5) at = s.t;
    }
    expect(at).not.toBeNull();
    expect(at! - 9).toBeLessThan(10); // locked on within 10 s of the signal clearing up
  });

  it('ignores pure brightness flicker (no pulse)', () => {
    const { samples } = simulate({ bpm: 72, seconds: 20, flicker: 0.03, pulseAmplitude: 0, seed: 9 });
    // Brightness flicker at 0.7 Hz would look like 42 bpm to a naive green-channel method.
    const est = new VitalsEstimator();
    for (const s of samples) est.push(s);
    const v = est.estimate()!;
    expect(v.confidence).toBeLessThan(0.45);
  });

  it('withholds HRV when the signal is too noisy for beat timing', () => {
    const { samples } = simulate({ bpm: 66, seconds: 40, rrJitterMs: 30, noise: 0.6, seed: 3 });
    const est = new VitalsEstimator();
    for (const s of samples) est.push(s);
    const v = est.estimate()!;
    expect(Math.abs(v.heartRate! - 66)).toBeLessThan(3);
    expect(v.hrv).toBeNull();
  });

  it('measures HRV over the whole scan from its clean stretches', () => {
    // 60 s scan: noisy first 18 s and last 15 s (e.g. talking, shifting), clean in between.
    const { samples, beats } = simulate({ bpm: 70, seconds: 60, rrJitterMs: 35, noise: 0.2, noisyBetween: [[0, 18, 1.4], [45, 60, 1.4]], seed: 12 });
    const est = new VitalsEstimator(10, 70);
    for (const s of samples) est.push(s);
    expect(est.estimate()!.hrv).toBeNull(); // the last window is noisy
    const h = est.scanHrv()!;
    expect(h).not.toBeNull();
    const truth = hrvFromBeats(beats.filter((t) => t > 18 && t < 45))!;
    expect(h.rmssd).toBeGreaterThan(truth.rmssd * 0.7);
    expect(h.rmssd).toBeLessThan(truth.rmssd * 1.4);
    expect(h.cleanSeconds).toBeGreaterThan(15);
    expect(h.cleanSeconds).toBeLessThan(40);
  });

  it('gives no whole-scan HRV when no stretch is clean', () => {
    const { samples } = simulate({ bpm: 66, seconds: 60, rrJitterMs: 30, noise: 1.4, seed: 3 });
    const est = new VitalsEstimator(10, 70);
    for (const s of samples) est.push(s);
    expect(est.scanHrv()).toBeNull();
  });

  it('estimates HRV and breathing rate from a clean signal', () => {
    const { samples, beats } = simulate({ bpm: 66, seconds: 40, rrJitterMs: 30, breathsPerMin: 14, noise: 0.2, seed: 3 });
    const est = new VitalsEstimator();
    for (const s of samples) est.push(s);
    const v = est.estimate()!;
    expect(Math.abs(v.heartRate! - 66)).toBeLessThan(3);
    expect(v.respiration).not.toBeNull();
    expect(Math.abs(v.respiration! - 14)).toBeLessThan(2);
    const truth = hrvFromBeats(beats.filter((t) => t > 10 && t < 40))!;
    expect(v.hrv).not.toBeNull();
    // Camera frame timing limits beat precision; RMSSD should still be in the right range.
    expect(v.hrv!.rmssd).toBeGreaterThan(truth.rmssd * 0.7);
    expect(v.hrv!.rmssd).toBeLessThan(truth.rmssd * 1.4);
  });
});
