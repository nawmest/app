/**
 * Scan history, kept on this device only (localStorage): one compact entry per scan, for trends
 * and "compared with last time".
 */
import type { ScanResult } from './scan';

export interface HistoryEntry {
  /** Finish time (ms since epoch); also the entry's id. */
  at: number;
  heartRate: number;
  respiration: number | null;
  rmssd: number | null;
  quality: number;
  durationSec: number;
  /** Scanned right after exercise (as detected, or as the person set it). */
  exercised: boolean;
}

const KEY = 'pulselens-history';
const MAX = 300;

export function loadHistory(): HistoryEntry[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as HistoryEntry[];
    return Array.isArray(list) ? list.filter((e) => typeof e?.at === 'number' && typeof e.heartRate === 'number') : [];
  } catch {
    return [];
  }
}

function store(list: HistoryEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch {
    // Storage full or blocked: history isn't kept.
  }
}

export function entryFrom(r: ScanResult, exercised: boolean): HistoryEntry {
  return {
    at: r.finishedAt.getTime(),
    heartRate: Math.round(r.heartRate * 10) / 10,
    respiration: r.respiration === null ? null : Math.round(r.respiration * 10) / 10,
    rmssd: r.hrv ? Math.round(r.hrv.rmssd) : null,
    quality: Math.round(r.quality * 100) / 100,
    durationSec: r.durationSec,
    exercised,
  };
}

/** Adds or replaces (same `at`) an entry. */
export function saveEntry(e: HistoryEntry): void {
  const list = loadHistory().filter((x) => x.at !== e.at);
  list.push(e);
  list.sort((a, b) => a.at - b.at);
  store(list);
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Ignore.
  }
}

/**
 * Compares a scan with the previous one in the same context (rest with rest, workout with
 * workout). Resting heart rate changes of 3 bpm or less are within day-to-day noise.
 */
export function compareWithLast(e: HistoryEntry, list = loadHistory()): string | null {
  const prev = list.filter((x) => x.at < e.at && x.exercised === e.exercised).pop();
  if (!prev) return null;
  const d = Math.round(e.heartRate - prev.heartRate);
  const when = sinceText(prev.at, e.at);
  const last = e.exercised ? 'after your last workout' : 'your last resting scan';
  if (Math.abs(d) <= 3) return `About the same as ${last} (${when}).`;
  return `${Math.abs(d)} bpm ${d < 0 ? 'lower' : 'higher'} than ${last} (${when}).`;
}

export function sinceText(then: number, now = Date.now()): string {
  const min = Math.round((now - then) / 60000);
  if (min < 60) return min <= 1 ? 'a minute ago' : `${min} min ago`;
  const days = Math.floor((startOfDay(now) - startOfDay(then)) / 86400000);
  if (days === 0) return 'earlier today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(then).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Average resting heart rate over the last `days` days, with how many scans it uses. */
export function restingAverage(list: HistoryEntry[], days = 7, now = Date.now()): { bpm: number; scans: number } | null {
  const rest = list.filter((e) => !e.exercised && e.at > now - days * 86400000);
  if (!rest.length) return null;
  return { bpm: rest.reduce((s, e) => s + e.heartRate, 0) / rest.length, scans: rest.length };
}
