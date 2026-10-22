import { describe, expect, it } from 'vitest';
import { bandpass, dominantFrequency, fft, hrvFromBeats } from '../src/rppg/dsp';
import { VitalsEstimator } from '../src/rppg/estimator';

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
  seed?: number;
}

/** Simulates the mean skin colour of a face under a camera, frame by frame. */
function simulate(o: SimOptions) {
  const r = rng(o.seed ?? 1);
  // Beat times with optional variability.
  const beats: number[] = [];
  let t = 0;
  const rr0 = 60 / o.bpm;
  while (t < o.seconds + 2) {
    beats.push(t);
    t += rr0 + ((o.rrJitterMs ?? 0) / 1000) * (r() * 2 - 1) * Math.sqrt(3);
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
  const samples: { t: number; rgb: [number, number, number]; motionY: number }[] = [];
  let ft = 0;
  while (ft < o.seconds) {
    const p = pulseAt(ft);
    const breath = o.breathsPerMin ? Math.sin((2 * Math.PI * o.breathsPerMin * ft) / 60) : 0;
    const light = 1 + (o.flicker ?? 0) * Math.sin(2 * Math.PI * 0.7 * ft) + 0.002 * breath + 0.003 * (r() - 0.5);
    // The region mean averages thousands of pixels: small noise, no integer quantisation.
    const rgb = base.map((v, c) => v * light * (1 - a * pbv[c] * p) + (r() - 0.5) * (o.noise ?? 0.5)) as [number, number, number];
    samples.push({ t: ft, rgb, motionY: 0.002 * breath + 0.0005 * (r() - 0.5) });
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
