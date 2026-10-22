import { describe, expect, it } from 'vitest';
import { bmi, person, profileSummary, sanitize } from '../src/profile';

describe('profile', () => {
  it('keeps plausible values and drops the rest', () => {
    const p = sanitize({ sex: 'male', birthYear: 1995, heightCm: 187, weightKg: 82 }, 2026);
    expect(p).toEqual({ sex: 'male', birthYear: 1995, heightCm: 187, weightKg: 82 });
    expect(sanitize({ birthYear: 2024, heightCm: 20, weightKg: 900, sex: 'x' as never }, 2026)).toEqual({ sex: null, birthYear: null, heightCm: null, weightKg: null });
  });

  it('derives age, BMI and a summary', () => {
    const p = sanitize({ sex: 'male', birthYear: 1995, heightCm: 187, weightKg: 82 }, 2026);
    expect(person(p, 2026)).toEqual({ age: 31, sex: 'male', weightKg: 82 });
    expect(bmi(p)!).toBeCloseTo(23.4, 1);
    expect(profileSummary({ sex: null, birthYear: null, heightCm: null, weightKg: null })).toBeNull();
  });
});
