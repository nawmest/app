import { beforeEach, describe, expect, it } from 'vitest';
import { clearHistory, compareWithLast, type HistoryEntry, loadHistory, restingAverage, saveEntry, sinceText } from '../src/history';

// Minimal localStorage for the Node test environment.
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const day = 86400000;
const now = new Date(2026, 9, 22, 21, 0).getTime();
const entry = (o: Partial<HistoryEntry>): HistoryEntry => ({ at: now, heartRate: 64, respiration: 14, rmssd: 45, quality: 0.7, durationSec: 60, exercised: false, ...o });

describe('history', () => {
  beforeEach(() => clearHistory());

  it('saves, replaces and orders entries', () => {
    saveEntry(entry({ at: now }));
    saveEntry(entry({ at: now - day }));
    saveEntry(entry({ at: now, exercised: true }));
    const list = loadHistory();
    expect(list.map((e) => e.at)).toEqual([now - day, now]);
    expect(list[1].exercised).toBe(true);
  });

  it('compares with the last scan in the same context', () => {
    const list = [entry({ at: now - day, heartRate: 70 }), entry({ at: now - 3600000, heartRate: 120, exercised: true })];
    expect(compareWithLast(entry({ heartRate: 62 }), list)).toBe('8 bpm lower than your last resting scan (yesterday).');
    expect(compareWithLast(entry({ heartRate: 71 }), list)).toBe('About the same as your last resting scan (yesterday).');
    expect(compareWithLast(entry({ heartRate: 110, exercised: true }), list)).toBe('10 bpm lower than after your last workout (earlier today).');
    expect(compareWithLast(entry({}), [])).toBeNull();
  });

  it('describes elapsed time', () => {
    expect(sinceText(now - 20 * 60000, now)).toBe('20 min ago');
    expect(sinceText(now - 2 * day, now)).toBe('2 days ago');
  });

  it('averages resting scans of the last week', () => {
    const list = [entry({ at: now - 10 * day, heartRate: 80 }), entry({ at: now - day, heartRate: 60 }), entry({ at: now, heartRate: 64 }), entry({ at: now, heartRate: 120, exercised: true })];
    expect(restingAverage(list, 7, now)).toEqual({ bpm: 62, scans: 2 });
  });
});
