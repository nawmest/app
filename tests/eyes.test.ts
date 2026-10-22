import { describe, expect, it } from 'vitest';
import { EyeAnalyzer } from '../src/insights/eyes';

/** Eyelid closure over time: open level, blinks of a given length (s), optional droop. */
function eyes(o: { seconds: number; fps?: number; open?: number; blinkEvery: number; blinkSec: number; droop?: number; yawnAt?: number[]; seed?: number }) {
  const a = new EyeAnalyzer();
  const fps = o.fps ?? 30;
  let seed = o.seed ?? 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const blinks: number[] = [];
  for (let b = 1; b < o.seconds; b += o.blinkEvery * (0.7 + 0.6 * rnd())) blinks.push(b);
  for (let t = 0; t < o.seconds; t += 1 / fps) {
    let c = (o.open ?? 0.08) + (o.droop ?? 0) * (0.5 + 0.5 * Math.sin(t * 0.7)) + (rnd() - 0.5) * 0.04;
    for (const b of blinks) {
      // Smooth lid closure lasting ~2x the time above half closure.
      const x = (t - b) / o.blinkSec;
      if (x > -1 && x < 1) c = Math.max(c, 0.95 * Math.cos((x * Math.PI) / 2) ** 2 + 0.05);
    }
    const jaw = o.yawnAt?.some((y) => t >= y && t < y + 2.5) ? 0.8 : 0.05;
    a.push(t, Math.min(1, c), jaw);
  }
  return a.stats()!;
}

describe('EyeAnalyzer', () => {
  it('measures quick blinks of an alert person', () => {
    const s = eyes({ seconds: 30, blinkEvery: 3.5, blinkSec: 0.12 });
    expect(s.blinksPerMin).toBeGreaterThan(12);
    expect(s.blinksPerMin).toBeLessThan(24);
    expect(s.meanBlinkMs!).toBeGreaterThan(90);
    expect(s.meanBlinkMs!).toBeLessThan(150);
    expect(s.perclos).toBeLessThan(0.05);
    expect(s.longClosures).toBe(0);
    expect(s.issue).toBeNull();
  });

  it('sees slow blinks, drooping lids and yawns of a tired person', () => {
    const s = eyes({ seconds: 30, blinkEvery: 3, blinkSec: 0.45, droop: 0.15, yawnAt: [12] });
    expect(s.meanBlinkMs!).toBeGreaterThan(350);
    expect(s.perclos).toBeGreaterThan(0.08);
    expect(s.yawns).toBe(1);
  });

  it('counts eyes resting shut as long closures', () => {
    const s = eyes({ seconds: 30, blinkEvery: 6, blinkSec: 0.8 });
    expect(s.longClosures).toBeGreaterThan(1);
  });

  it('adapts to a higher open level (looking down at the phone)', () => {
    const s = eyes({ seconds: 30, open: 0.35, blinkEvery: 3.5, blinkSec: 0.12 });
    expect(s.blinksPerMin).toBeGreaterThan(12);
    expect(s.perclos).toBeLessThan(0.05);
  });

  it('flags eyes that stay closed and a slow camera', () => {
    expect(eyes({ seconds: 30, open: 0.8, blinkEvery: 100, blinkSec: 0.1 }).issue).toBe('eyes-closed');
    expect(eyes({ seconds: 30, fps: 8, blinkEvery: 3.5, blinkSec: 0.12 }).issue).toBe('low-fps');
  });

  it('needs at least 10 s', () => {
    const a = new EyeAnalyzer();
    for (let t = 0; t < 5; t += 1 / 30) a.push(t, 0.1, 0);
    expect(a.stats()).toBeNull();
  });
});
