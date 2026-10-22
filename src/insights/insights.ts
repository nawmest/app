/**
 * Plain-language wellness insights from one scan: stress, sleepiness and sport. These are
 * general-population estimates for a wellness app, not diagnoses; each one says what it is
 * based on.
 */
import type { Person } from '../profile';
import type { ScanResult } from '../scan';

const NOBODY: Person = { age: null, sex: null, weightKg: null };

export type Tone = 'good' | 'ok' | 'warn' | 'muted';

export interface Insight {
  key: 'stress' | 'sleep' | 'sport';
  title: string;
  /** One or two words for the tile, e.g. "Low". */
  value: string;
  /** What it is based on, e.g. "from HRV". */
  caption: string;
  tone: Tone;
  /** Position on a low-to-high bar (0..1) and its end labels; null when not measured. */
  gauge: { value: number; from: string; to: string } | null;
  summary: string;
  /** Measurements behind the insight: [label, value]. */
  facts: [string, string][];
  tip: string;
  /** Heart-rate training zones (bpm), when the age is known. */
  zones?: { name: string; range: string; current: boolean }[];
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));

const median = (x: number[]) => {
  const s = x.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Heart-rate change over the settled part of the scan (bpm per minute; negative = falling), or
 * null when there is no consistent trend. Uses the median of pairwise slopes (Theil–Sen), so a
 * brief glitch can't fake a fast recovery, and checks it against the change between the first
 * and last thirds.
 */
export function heartRateSlope(trend: [number, number][]): number | null {
  const pts = trend.filter(([t]) => t >= 8);
  if (pts.length < 10 || pts[pts.length - 1][0] - pts[0][0] < 10) return null;
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) if (pts[j][0] - pts[i][0] > 1) slopes.push((pts[j][1] - pts[i][1]) / (pts[j][0] - pts[i][0]));
  if (!slopes.length) return null;
  const slope = median(slopes) * 60;
  const third = Math.floor(pts.length / 3);
  const a = pts.slice(0, third);
  const b = pts.slice(-third);
  const dt = median(b.map((p) => p[0])) - median(a.map((p) => p[0]));
  const thirds = ((median(b.map((p) => p[1])) - median(a.map((p) => p[1]))) / dt) * 60;
  return Math.abs(thirds - slope) <= Math.max(6, 0.5 * Math.abs(slope)) ? slope : null;
}

/** A raised heart rate, or one clearly falling during the scan, means the person just exercised. */
export function isAfterExercise(r: ScanResult): boolean {
  const slope = heartRateSlope(r.trend);
  return r.heartRate >= 100 || (slope !== null && slope <= -6 && r.heartRate >= 85);
}

/** Age-predicted maximum heart rate (Tanaka, Monahan & Seals 2001). */
export const maxHeartRate = (age: number) => 208 - 0.7 * age;

const ZONES = [
  { name: 'Zone 1 · Very light', lo: 0.5, hi: 0.6 },
  { name: 'Zone 2 · Light', lo: 0.6, hi: 0.7 },
  { name: 'Zone 3 · Moderate', lo: 0.7, hi: 0.8 },
  { name: 'Zone 4 · Hard', lo: 0.8, hi: 0.9 },
  { name: 'Zone 5 · Maximum', lo: 0.9, hi: 1.0 },
];

/**
 * Typical resting RMSSD (ms) for an age: short-term HRV falls by roughly a fifth per decade in
 * adults. Without an age, a general adult value.
 */
export const typicalRmssd = (age: number | null) => (age === null ? 45 : 50 * Math.exp(-0.02 * (age - 30)));

/**
 * Energy use during exercise from heart rate, weight, age and sex (Keytel et al. 2005, without
 * VO2max), in kcal per minute. Meant for exercise heart rates (~90-150 bpm).
 */
export function exerciseKcalPerMin(hr: number, p: Person): number | null {
  if (!p.sex || !p.weightKg || p.age === null) return null;
  const kj =
    p.sex === 'male'
      ? -55.0969 + 0.6309 * hr + 0.1988 * p.weightKg + 0.2017 * p.age
      : -20.4022 + 0.4472 * hr - 0.1263 * p.weightKg + 0.074 * p.age;
  return kj > 0 ? kj / 4.184 : null;
}

export function zoneOf(hr: number, age: number): string {
  const pct = hr / maxHeartRate(age);
  if (pct < 0.5) return 'Resting';
  return (ZONES.find((z) => pct < z.hi) ?? ZONES[4]).name;
}

function level4(v: number, labels: [string, string, string, string]): { value: string; tone: Tone } {
  if (v < 0.3) return { value: labels[0], tone: 'good' };
  if (v < 0.55) return { value: labels[1], tone: 'ok' };
  if (v < 0.75) return { value: labels[2], tone: 'warn' };
  return { value: labels[3], tone: 'warn' };
}

export function stressInsight(r: ScanResult, exercised = isAfterExercise(r), who: Person = NOBODY): Insight {
  const base = { key: 'stress' as const, title: 'Stress' };
  const facts: [string, string][] = [
    ['HRV (RMSSD)', r.hrv ? `${Math.round(r.hrv.rmssd)} ms` : 'Not measured'],
    ['Heart rate', `${Math.round(r.heartRate)} bpm`],
    ['Breathing', r.respiration ? `${Math.round(r.respiration)} /min` : 'Not measured'],
  ];
  if (exercised) {
    return {
      ...base,
      value: 'Rest first',
      caption: 'after exercise',
      tone: 'muted',
      gauge: null,
      summary:
        'Your heart rate is still up from activity, which would look like stress. Stress is read from a body at rest.',
      facts,
      tip: 'Sit quietly for 5–10 minutes, then scan again.',
    };
  }
  // Under stress, the nervous system speeds the heart and breathing and makes beat-to-beat
  // timing more regular (lower HRV). HRV is the strongest sign, when it could be measured.
  const hrS = clamp((r.heartRate - 68) / 40);
  const respS = r.respiration ? clamp((r.respiration - 12) / 12) : null;
  // HRV is judged against what is typical for the person's age (HRV falls with age).
  const typical = typicalRmssd(who.age);
  const hrvS = r.hrv ? clamp(Math.log((1.55 * typical) / r.hrv.rmssd) / Math.log(1.55 / 0.35)) : null;
  // Without HRV, calm breathing counts most: a raised pulse alone has many causes (activity,
  // coffee), so it is weighted less.
  const v =
    hrvS !== null ? 0.6 * hrvS + 0.25 * hrS + 0.15 * (respS ?? hrS) : respS !== null ? 0.35 * hrS + 0.65 * respS : 0.8 * hrS;
  const l = level4(v, ['Low', 'Moderate', 'High', 'Very high']);
  const summaries = [
    'Your heart rate, breathing and heart rhythm look relaxed.',
    'Some signs of tension, within what is normal on a busy day.',
    'Your body shows signs of stress: a faster pulse and breathing, and a more rigid heart rhythm.',
    'Strong signs of stress right now. If this lasts, consider talking to someone you trust.',
  ];
  return {
    ...base,
    ...l,
    caption: hrvS !== null ? (who.age !== null ? 'HRV for your age' : 'from HRV') : 'rough estimate',
    gauge: { value: v, from: 'Relaxed', to: 'Stressed' },
    summary:
      summaries[['Low', 'Moderate', 'High', 'Very high'].indexOf(l.value)] +
      (hrvS === null ? ' HRV could not be measured, so this is based on heart rate and breathing only.' : ''),
    facts,
    tip:
      v < 0.3
        ? 'Keep it up: regular movement and good sleep keep stress low.'
        : 'Try a minute of slow breathing, in for 4 seconds and out for 6, then scan again.',
  };
}

export function sleepInsight(r: ScanResult): Insight {
  const base = { key: 'sleep' as const, title: 'Sleep', caption: 'from your eyes' };
  const e = r.eyes;
  const intro = 'PulseLens can’t see how you slept, but tiredness shows in the eyes: slower blinks, drooping lids and yawns.';
  if (!e || e.issue === 'eyes-closed') {
    return {
      ...base,
      value: 'Not measured',
      tone: 'muted',
      gauge: null,
      summary: `${intro} ${e ? 'Your eyes looked closed for most of the scan.' : 'Your eyes weren’t visible long enough.'}`,
      facts: [],
      tip: 'Look at the screen with your eyes open during the scan.',
    };
  }
  const coarse = e.issue === 'low-fps';
  const durS = e.meanBlinkMs !== null && !coarse ? clamp((e.meanBlinkMs - 130) / 220) : 0;
  const perclosS = clamp((e.perclos - 0.03) / 0.12);
  const extra = Math.min(0.3, 0.15 * e.longClosures) + Math.min(0.3, 0.2 * e.yawns);
  const v = clamp((coarse ? 0.8 * perclosS : 0.45 * durS + 0.45 * perclosS) + extra);
  const l = level4(v, ['Rested', 'A bit tired', 'Tired', 'Very sleepy']);
  const verdicts = [
    'Your eyes look alert.',
    'Slight signs of tiredness.',
    'Clear signs of tiredness.',
    'Strong signs of sleepiness.',
  ];
  return {
    ...base,
    ...l,
    caption: coarse ? 'rough estimate' : base.caption,
    gauge: { value: v, from: 'Alert', to: 'Sleepy' },
    summary: `${verdicts[['Rested', 'A bit tired', 'Tired', 'Very sleepy'].indexOf(l.value)]} ${intro}`,
    facts: [
      ['Blinks', `${Math.round(e.blinksPerMin)} /min`],
      ['Average blink', e.meanBlinkMs !== null && !coarse ? `${Math.round(e.meanBlinkMs)} ms` : '—'],
      ['Eyes closed', `${(e.perclos * 100).toFixed(1)}% of the time`],
      ['Yawns', String(e.yawns)],
    ],
    tip:
      v < 0.3
        ? 'Most adults need 7–9 hours of sleep to feel like this every day.'
        : v < 0.75
          ? 'A short 10–20 minute nap or an earlier night helps. Daylight and a walk can perk you up.'
          : 'Don’t drive while this sleepy. Rest, then scan again.',
  };
}

export function sportInsight(r: ScanResult, who: Person = NOBODY, exercised = isAfterExercise(r)): Insight {
  const base = { key: 'sport' as const, title: 'Sport' };
  const hr = r.heartRate;
  const age = who.age;
  const hrMax = age ? maxHeartRate(age) : null;
  const zones = hrMax
    ? ZONES.map((z) => ({
        name: z.name,
        range: `${Math.round(z.lo * hrMax)}–${Math.round(z.hi * hrMax)} bpm`,
        current: hr >= z.lo * hrMax && hr < z.hi * hrMax,
      }))
    : undefined;
  const facts: [string, string][] = [['Heart rate', `${Math.round(hr)} bpm`]];

  if (exercised) {
    if (age && hrMax) facts.push(['Intensity', `${zoneOf(hr, age)} · ${Math.round((hr / hrMax) * 100)}% of max`]);
    const slope = heartRateSlope(r.trend);
    const drop = slope === null ? null : -slope;
    if (drop !== null) facts.push(['Recovery', drop > 0 ? `falling ${Math.round(drop)} bpm/min` : 'not falling yet']);
    if (r.respiration) facts.push(['Breathing', `${Math.round(r.respiration)} /min`]);
    const kcal = hr >= 90 ? exerciseKcalPerMin(hr, who) : null;
    if (kcal) facts.push(['Burn at this pulse', `~${Math.round(kcal)} kcal/min`]);
    // How fast the heart rate drops after exercise is a well-known sign of cardio fitness.
    const rec =
      drop === null
        ? { value: 'After workout', tone: 'ok' as Tone, text: 'Your heart rate is raised from activity.' }
        : drop >= 20
          ? { value: 'Fast recovery', tone: 'good' as Tone, text: 'Your heart rate is dropping quickly, a sign of good cardio fitness.' }
          : drop >= 10
            ? { value: 'Recovering', tone: 'good' as Tone, text: 'Your heart rate is coming down at a healthy pace.' }
            : { value: 'Still high', tone: 'ok' as Tone, text: 'Your heart rate is coming down slowly. Keep moving gently to cool down.' };
    return {
      ...base,
      value: rec.value,
      tone: rec.tone,
      caption: 'after workout',
      gauge: hrMax ? { value: clamp((hr / hrMax - 0.5) / 0.5), from: 'Rest', to: 'Max' } : null,
      summary: rec.text + (hrMax ? '' : ' Add your birth year to your profile to see your training zone.'),
      facts,
      tip: 'Cool down until you can talk easily and your heart rate is under 100. Scanning right after a workout shows how fast you recover.',
      zones,
    };
  }

  // At rest: a lower resting heart rate usually means a fitter heart. Adult bands; women's and
  // older adults' resting rates run a few beats higher (as in common fitness charts).
  const shift = (who.sex === 'female' ? 4 : 0) + (age !== null && age >= 46 ? 2 : 0);
  const bands: [number, string, Tone][] = [
    [55 + shift, 'Excellent', 'good'],
    [65 + shift, 'Good', 'good'],
    [75 + shift, 'Average', 'ok'],
    [85 + shift, 'Fair', 'ok'],
    [Infinity, 'Raised', 'warn'],
  ];
  const [, value, tone] = bands.find(([max]) => hr < max)!;
  const raised = value === 'Raised';
  if (hrMax) facts.push(['Max heart rate', `~${Math.round(hrMax)} bpm`]);
  return {
    ...base,
    value: raised ? 'Pulse raised' : `${value} fitness`,
    tone,
    caption: who.sex || age !== null ? 'resting pulse, for you' : 'resting pulse',
    gauge: { value: clamp((hr - 45) / 45), from: 'Athletic', to: 'Raised' },
    summary: raised
      ? 'Your pulse is above a typical resting rate. That is often temporary: recent activity, coffee, stress or a short night all raise it.'
      : 'A lower resting heart rate usually means a fitter heart. Caffeine, stress, illness and a recent workout raise it for a while.',
    facts,
    tip: raised
      ? 'For your resting fitness, sit quietly for 5 minutes and scan again. Just exercised? Switch to “Just exercised” above.'
      : 'Scan right after a workout to see your training zone and how fast your heart recovers.',
    zones,
  };
}

/** `exercised`: whether the scan was right after exercise (detected when not given). */
export function insights(r: ScanResult, who: Person = NOBODY, exercised = isAfterExercise(r)): Insight[] {
  return [stressInsight(r, exercised, who), sleepInsight(r), sportInsight(r, who, exercised)];
}
