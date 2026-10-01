// Pure punch-planning rules for the punch bot. No I/O: callers pass today's
// date, NUEiP data (already run through format.ts) and a random source.
// All times are minutes since 00:00 Asia/Taipei.
import type { AttendanceDaySummary, LeaveRecordSummary } from "./format.js";

export type Kind = "in" | "out";
export type Place = "home" | "office";
export interface Span { start: number; end: number }
export interface Slot { kind: Kind; at: number; place: Place }

const WORK_START = 9 * 60;
const WORK_END = 18 * 60;
const LUNCH_START = 12 * 60;
const LUNCH_END = 13 * 60;
const FULL_DAY = 9 * 60; // 8h work + 1h lunch
const IN_WINDOW = { from: 8 * 60, to: 14 * 60 };
const OUT_LATEST = 21 * 60;
const LEAVE_STATUSES = new Set(["已通過", "簽核中"]);

export const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
export const fmt = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// Taiwan wall clock from epoch ms, independent of the host TZ (no DST in Taiwan).
export function taipei(ms: number): { date: string; min: number } {
  const iso = new Date(ms + 8 * 3600_000).toISOString();
  return { date: iso.slice(0, 10), min: toMin(iso.slice(11, 16)) };
}

const randInt =(rand: () => number, lo: number, hi: number) =>
  lo + Math.floor(rand() * (hi - lo + 1));

// 0=Sun … 6=Sat, independent of the host timezone.
const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

// NUEiP can return several entries for one date; merge them into one.
export function dayOf(days: AttendanceDaySummary[], date: string): AttendanceDaySummary {
  const same = days.filter(d => d.date === date);
  const [first] = same;
  if (!first) throw new Error(`NUEiP returned no attendance entry for ${date}`);
  return {
    ...first,
    is_off: same.some(d => d.is_off),
    holiday: same.find(d => d.holiday)?.holiday,
    punches: same.flatMap(d => d.punches),
  };
}

// Today's working span after trimming leave off the head and tail.
// Leaves in the middle of the day don't change it (one clock-in/out per day).
// Returns null when there's nothing to punch: weekend, day off, full-day leave.
export function workSpan(date: string, day: AttendanceDaySummary, leaves: LeaveRecordSummary[]): Span | null {
  const wd = weekdayOf(date);
  if (wd === 0 || wd === 6 || day.is_off || day.holiday) return null;

  const clip = (stamp: string, edge: number) => {
    const [d = "", t = ""] = stamp.split(" ");
    return d < date ? 0 : d > date ? 24 * 60 : t ? toMin(t) : edge;
  };
  const ranges = leaves
    .filter(l => LEAVE_STATUSES.has(l.status))
    .map(l => ({ start: clip(l.start, 0), end: clip(l.end, 24 * 60) }))
    .filter(r => r.end > r.start);

  let { start, end } = { start: WORK_START, end: WORK_END };
  for (const r of [...ranges].sort((a, b) => a.start - b.start))
    if (r.start <= start && r.end > start) start = r.end;
  for (const r of [...ranges].sort((a, b) => b.end - a.end))
    if (r.end >= end && r.start < end) end = r.start;

  if (start >= LUNCH_START && start < LUNCH_END) start = LUNCH_END;
  if (end > LUNCH_START && end <= LUNCH_END) end = LUNCH_START;
  return start < end ? { start, end } : null;
}

export function clockInSlot(span: Span, rand: () => number): Slot {
  return { kind: "in", at: span.start - randInt(rand, 2, 12), place: "home" };
}

// Earliest legal clock-out. The 8h rule only applies to a full working day;
// on a leave day the span end (leave start / 18:00) is the target.
export function earliestOut(span: Span, actualIn: number): number {
  const fullDay = span.start === WORK_START && span.end === WORK_END;
  return fullDay ? Math.max(WORK_END, actualIn + FULL_DAY) : span.end;
}

export function clockOutSlot(date: string, span: Span, actualIn: number, rand: () => number): Slot {
  const wd = weekdayOf(date);
  return {
    kind: "out",
    at: earliestOut(span, actualIn) + randInt(rand, 3, 15),
    place: wd === 1 || wd === 5 ? "home" : "office",
  };
}

// Earliest 上班 punch of the day, in minutes; null if none yet.
export function actualClockIn(day: AttendanceDaySummary): number | null {
  const times = day.punches
    .filter(p => p.section === "上班")
    .map(p => toMin(p.time.split(" ")[1] ?? ""));
  return times.length ? Math.min(...times) : null;
}

export function alreadyPunched(day: AttendanceDaySummary, kind: Kind): boolean {
  return day.punches.some(p => p.section === (kind === "in" ? "上班" : "下班"));
}

// Hard guard, checked right before every punch regardless of how we got there.
export function allowed(kind: Kind, now: number, span: Span, actualIn: number | null): boolean {
  if (kind === "in") return now >= IN_WINDOW.from && now <= IN_WINDOW.to;
  if (actualIn === null) return false;
  return now >= earliestOut(span, actualIn) && now <= OUT_LATEST;
}
