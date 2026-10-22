/**
 * Optional personal details, kept on this device only (localStorage). They turn general adult
 * ranges into personal ones: age for heart-rate zones and HRV norms, sex and age for resting
 * heart-rate norms, and weight (with age and sex) for workout calorie estimates.
 */
export interface Profile {
  sex: 'female' | 'male' | null;
  birthYear: number | null;
  heightCm: number | null;
  weightKg: number | null;
}

/** What the assessments use from the profile. */
export interface Person {
  age: number | null;
  sex: 'female' | 'male' | null;
  weightKg: number | null;
}

const KEY = 'pulselens-profile';
const ASKED_KEY = 'pulselens-profile-asked';
/** Older builds stored only an age for the training zones. */
const OLD_AGE_KEY = 'pulselens-age';

export const EMPTY: Profile = { sex: null, birthYear: null, heightCm: null, weightKg: null };

const inRange = (v: unknown, lo: number, hi: number): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
};

/** Cleans a profile: out-of-range values become null. */
export function sanitize(p: Partial<Profile>, year = new Date().getFullYear()): Profile {
  return {
    sex: p.sex === 'female' || p.sex === 'male' ? p.sex : null,
    birthYear: inRange(p.birthYear, year - 100, year - 10),
    heightCm: inRange(p.heightCm, 100, 230),
    weightKg: inRange(p.weightKg, 30, 250),
  };
}

export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return sanitize(JSON.parse(raw) as Partial<Profile>);
    const age = inRange(localStorage.getItem(OLD_AGE_KEY), 10, 100);
    if (age) return { ...EMPTY, birthYear: new Date().getFullYear() - age };
  } catch {
    // Storage blocked or corrupt: no profile.
  }
  return { ...EMPTY };
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sanitize(p)));
    localStorage.removeItem(OLD_AGE_KEY);
  } catch {
    // Storage blocked: the profile applies to this visit only.
  }
}

/** Whether the profile was already offered once (before the first scan). */
export function profileOffered(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === '1' || localStorage.getItem(KEY) !== null;
  } catch {
    return true;
  }
}

export function markProfileOffered(): void {
  try {
    localStorage.setItem(ASKED_KEY, '1');
  } catch {
    // Ignore.
  }
}

export function person(p: Profile, year = new Date().getFullYear()): Person {
  return { age: p.birthYear ? year - p.birthYear : null, sex: p.sex, weightKg: p.weightKg };
}

export function bmi(p: Profile): number | null {
  return p.heightCm && p.weightKg ? p.weightKg / (p.heightCm / 100) ** 2 : null;
}

/** Short summary for the start screen, e.g. "Male · 31 y · 187 cm · 82 kg". */
export function profileSummary(p: Profile): string | null {
  const parts = [
    p.sex === 'female' ? 'Female' : p.sex === 'male' ? 'Male' : null,
    p.birthYear ? `${person(p).age} y` : null,
    p.heightCm ? `${p.heightCm} cm` : null,
    p.weightKg ? `${p.weightKg} kg` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
