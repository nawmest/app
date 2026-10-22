import { describe, expect, it } from 'vitest';
import type { EyeStats } from '../src/insights/eyes';
import { exerciseKcalPerMin, heartRateSlope, isAfterExercise, sleepInsight, sportInsight, stressInsight, zoneOf } from '../src/insights/insights';
import type { Person } from '../src/profile';
import type { ScanResult } from '../src/scan';

const aged = (age: number, o: Partial<Person> = {}): Person => ({ age, sex: null, weightKg: null, ...o });

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
    fps: 30,
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
    expect(sportInsight(result({ heartRate: 110, trend: t })).value).not.toBe('Fast recovery');
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
    const s = sportInsight(result({ heartRate: 128, trend: trend(136, 124) }), aged(30));
    expect(s.value).toBe('Fast recovery');
    expect(s.zones!.filter((z) => z.current)).toHaveLength(1);
    expect(sportInsight(result({ heartRate: 128, trend: trend(130, 126) })).value).toBe('Still high');
  });

  it('reads a raised pulse without HRV gently (a real post-gym scan: 91 bpm, 11 breaths/min)', () => {
    const r = result({ heartRate: 91, respiration: 11, hrv: null });
    expect(stressInsight(r).value).toBe('Low'); // calm breathing; another app said "Low" too
    expect(sportInsight(r).value).toBe('Pulse raised');
    // The person says they just exercised: no stress reading, recovery view instead.
    expect(stressInsight(r, true).value).toBe('Rest first');
    expect(sportInsight(r, aged(30), true).caption).toBe('after workout');
  });

  it('judges HRV against what is typical for the age', () => {
    const r = result({ heartRate: 64, respiration: 13, hrv: { rmssd: 30, sdnn: 40, beats: 30 } });
    // 30 ms is on the low side at 22 but typical at 60.
    expect(stressInsight(r, false, aged(22)).gauge!.value).toBeGreaterThan(stressInsight(r, false, aged(60)).gauge!.value + 0.2);
    expect(stressInsight(r, false, aged(60)).value).toBe('Low');
    expect(stressInsight(r, false, aged(60)).caption).toBe('HRV for your age');
  });

  it('uses sex- and age-adjusted resting norms', () => {
    const r = result({ heartRate: 67 });
    expect(sportInsight(r, aged(30, { sex: 'male' }), false).value).toBe('Average fitness');
    expect(sportInsight(r, aged(30, { sex: 'female' }), false).value).toBe('Good fitness');
  });

  it('estimates workout calories with weight, age and sex', () => {
    expect(exerciseKcalPerMin(130, aged(31, { sex: 'male', weightKg: 82 }))!).toBeCloseTo(11.8, 0);
    expect(exerciseKcalPerMin(130, aged(31, { sex: 'female', weightKg: 62 }))!).toBeCloseTo(7.4, 0);
    expect(exerciseKcalPerMin(130, aged(31))).toBeNull();
    const s = sportInsight(result({ heartRate: 128, trend: trend(136, 124) }), aged(31, { sex: 'male', weightKg: 82 }));
    expect(s.facts.some(([k]) => k === 'Burn at this pulse')).toBe(true);
  });

  it('rates resting fitness from the resting heart rate', () => {
    expect(sportInsight(result({ heartRate: 52 })).value).toBe('Excellent fitness');
    expect(sportInsight(result({ heartRate: 72 })).value).toBe('Average fitness');
    expect(sportInsight(result({ heartRate: 72 })).zones).toBeUndefined();
  });
});
