import { describe, expect, it } from 'vitest';
import type { EyeStats } from '../src/insights/eyes';
import { heartRateSlope, isAfterExercise, sleepInsight, sportInsight, stressInsight, zoneOf } from '../src/insights/insights';
import type { ScanResult } from '../src/scan';

const trend = (from: number, to: number): [number, number][] => Array.from({ length: 100 }, (_, i) => [i * 0.3, from + ((to - from) * i) / 99]);
const eyes = (o: Partial<EyeStats> = {}): EyeStats => ({
  seconds: 30,
  blinks: 8,
  blinksPerMin: 16,
  meanBlinkMs: 120,
  perclos: 0.02,
  longClosures: 0,
  yawns: 0,
  issue: null,
  ...o,
});
function result(o: Partial<ScanResult> = {}): ScanResult {
  const hr = o.heartRate ?? 66;
  return {
    heartRate: hr,
    heartRateRange: [hr - 2, hr + 2],
    respiration: 14,
    hrv: { rmssd: 45, sdnn: 50, beats: 30 },
    quality: 0.7,
    trend: trend(hr, hr),
    durationSec: 30,
    finishedAt: new Date(),
    eyes: eyes(),
    ...o,
  };
}

describe('insights', () => {
  it('measures the heart-rate slope in bpm per minute', () => {
    expect(heartRateSlope(trend(130, 118))!).toBeCloseTo(-24, 0);
    expect(heartRateSlope(trend(70, 70))!).toBeCloseTo(0, 5);
  });

  it('ignores a brief glitch at the end of the scan', () => {
    const t = trend(112, 112).map(([s, h]): [number, number] => [s, s > 27 ? h - 25 * ((s - 27) / 3) : h]);
    const slope = heartRateSlope(t);
    expect(slope === null || Math.abs(slope) < 6).toBe(true);
    expect(sportInsight(result({ heartRate: 110, trend: t }), null).value).not.toBe('Fast recovery');
  });

  it('recognises a scan right after exercise', () => {
    expect(isAfterExercise(result({ heartRate: 120, trend: trend(125, 118) }))).toBe(true);
    expect(isAfterExercise(result({ heartRate: 92, trend: trend(98, 90) }))).toBe(true);
    expect(isAfterExercise(result({ heartRate: 88 }))).toBe(false);
  });

  it('rates stress from HRV, heart rate and breathing', () => {
    expect(stressInsight(result()).value).toBe('Low');
    const tense = stressInsight(result({ heartRate: 92, respiration: 22, hrv: { rmssd: 14, sdnn: 20, beats: 30 } }));
    expect(['High', 'Very high']).toContain(tense.value);
    expect(tense.caption).toBe('from HRV');
    expect(stressInsight(result({ hrv: null })).caption).toBe('rough estimate');
  });

  it('asks to rest before reading stress after exercise', () => {
    const s = stressInsight(result({ heartRate: 125, trend: trend(132, 120) }));
    expect(s.value).toBe('Rest first');
    expect(s.gauge).toBeNull();
  });

  it('reads tiredness from the eyes', () => {
    expect(sleepInsight(result()).value).toBe('Rested');
    expect(sleepInsight(result({ eyes: eyes({ meanBlinkMs: 380, perclos: 0.14, yawns: 1 }) })).value).toBe('Very sleepy');
    expect(sleepInsight(result({ eyes: eyes({ meanBlinkMs: 220, perclos: 0.07 }) })).value).toBe('A bit tired');
    expect(sleepInsight(result({ eyes: null })).gauge).toBeNull();
    expect(sleepInsight(result({ eyes: eyes({ issue: 'eyes-closed' }) })).value).toBe('Not measured');
  });

  it('gives training zones and recovery after a workout', () => {
    expect(zoneOf(140, 30)).toBe('Zone 3 · Moderate'); // max ~187
    const s = sportInsight(result({ heartRate: 128, trend: trend(136, 124) }), 30);
    expect(s.value).toBe('Fast recovery');
    expect(s.zones!.filter((z) => z.current)).toHaveLength(1);
    expect(sportInsight(result({ heartRate: 128, trend: trend(130, 126) }), null).value).toBe('Still high');
  });

  it('rates resting fitness from the resting heart rate', () => {
    expect(sportInsight(result({ heartRate: 52 }), null).value).toBe('Excellent fitness');
    expect(sportInsight(result({ heartRate: 72 }), null).value).toBe('Average fitness');
    expect(sportInsight(result({ heartRate: 72 }), null).zones).toBeUndefined();
  });
});
