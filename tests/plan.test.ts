import { test } from "node:test";
import assert from "node:assert/strict";
import type { AttendanceDaySummary, LeaveRecordSummary } from "../src/format.ts";
import {
  actualClockIn, allowed, alreadyPunched, clockInSlot, clockOutSlot,
  dayOf, taipei, toMin, workSpan,
} from "../src/plan.ts";

test("taipei(): UTC 00:48 on 9/28 is 08:48 on 9/28; UTC 16:30 rolls to next day", () => {
  assert.deepEqual(taipei(Date.parse("2026-09-28T00:48:00Z")), { date: "2026-09-28", min: toMin("08:48") });
  assert.deepEqual(taipei(Date.parse("2026-09-28T16:30:00Z")), { date: "2026-09-29", min: toMin("00:30") });
});

const MON = "2026-09-28", TUE = "2026-09-29", FRI = "2026-10-02", SAT = "2026-10-03";
const lo = () => 0, hi = () => 0.999;

const day = (date: string, extra: Partial<AttendanceDaySummary> = {}): AttendanceDaySummary => ({
  date, weekday: "", scheduled: "", status: "正常", is_off: false, punches: [], ...extra,
});
const leave = (start: string, end: string, status = "已通過") =>
  ({ start, end, status }) as LeaveRecordSummary;
const punch = (section: string, time: string) =>
  ({ s_sn: "1", section, time, source: "GPS打卡", pending_approval: false });

test("no punching on weekend, day off, holiday, or full-day leave", () => {
  assert.equal(workSpan(SAT, day(SAT), []), null);
  assert.equal(workSpan(TUE, day(TUE, { is_off: true }), []), null);
  assert.equal(workSpan(TUE, day(TUE, { holiday: "國慶日" }), []), null);
  assert.equal(workSpan(TUE, day(TUE), [leave(`${TUE} 09:00`, `${TUE} 18:00`)]), null);
  assert.equal(workSpan(TUE, day(TUE), [leave("2026-09-28 09:00", "2026-09-30 18:00")]), null,
    "multi-day leave covering today");
});

test("normal day: clock-in 08:48–08:58 at home", () => {
  const span = workSpan(TUE, day(TUE), [])!;
  assert.deepEqual(span, { start: toMin("09:00"), end: toMin("18:00") });
  assert.equal(clockInSlot(span, lo).at, toMin("08:58"));
  assert.equal(clockInSlot(span, hi).at, toMin("08:48"));
  assert.equal(clockInSlot(span, lo).place, "home");
});

test("leave trims head/tail across lunch; middle leave ignored", () => {
  const am = (end: string, status?: string) => workSpan(TUE, day(TUE), [leave(`${TUE} 09:00`, `${TUE} ${end}`, status)]);
  assert.equal(am("12:00")!.start, toMin("13:00"), "AM leave to 12:00 → work starts 13:00");
  assert.equal(am("13:00")!.start, toMin("13:00"));
  assert.equal(am("12:00", "簽核中")!.start, toMin("13:00"), "pending leave counts");
  assert.equal(am("12:00", "不通過")!.start, toMin("09:00"), "rejected leave ignored");
  assert.equal(am("12:00", "已銷假")!.start, toMin("09:00"), "cancelled leave ignored");

  const pm = workSpan(TUE, day(TUE), [leave(`${TUE} 13:00`, `${TUE} 18:00`)])!;
  assert.equal(pm.end, toMin("12:00"), "PM leave from 13:00 → off at 12:00");
  const pm14 = workSpan(TUE, day(TUE), [leave(`${TUE} 14:00`, `${TUE} 18:00`)])!;
  assert.equal(pm14.end, toMin("14:00"));

  const mid = workSpan(TUE, day(TUE), [leave(`${TUE} 10:00`, `${TUE} 11:00`)])!;
  assert.deepEqual(mid, { start: toMin("09:00"), end: toMin("18:00") });
});

test("clock-out: full day needs 9h span; leave day uses span end; place by weekday", () => {
  const full = workSpan(TUE, day(TUE), [])!;
  assert.equal(clockOutSlot(TUE, full, toMin("08:52"), lo).at, toMin("18:03"), "never before 18:00");
  assert.equal(clockOutSlot(TUE, full, toMin("09:10"), lo).at, toMin("18:13"), "late 09:10 → ≥ 18:10");
  assert.equal(clockOutSlot(TUE, full, toMin("09:10"), hi).at, toMin("18:25"));

  const pm = workSpan(TUE, day(TUE), [leave(`${TUE} 14:00`, `${TUE} 18:00`)])!;
  assert.equal(clockOutSlot(TUE, pm, toMin("08:55"), lo).at, toMin("14:03"), "no 8h rule on leave day");

  assert.equal(clockOutSlot(TUE, full, 540, lo).place, "office");
  assert.equal(clockOutSlot(MON, full, 540, lo).place, "home");
  assert.equal(clockOutSlot(FRI, full, 540, lo).place, "home");
});

test("hard guard: rejects the 9/29 00:48 and 10/01 05:01 punches", () => {
  const span = workSpan(TUE, day(TUE), [])!;
  assert.equal(allowed("in", toMin("00:48"), span, null), false);
  assert.equal(allowed("in", toMin("05:01"), span, null), false);
  assert.equal(allowed("in", toMin("08:53"), span, null), true);
  assert.equal(allowed("in", toMin("08:44"), span, null), false, "too early");
  assert.equal(allowed("in", toMin("09:31"), span, null), false, "too late");

  const leaveTo15 = workSpan(TUE, day(TUE), [leave(`${TUE} 09:00`, `${TUE} 15:00`)])!;
  assert.equal(allowed("in", clockInSlot(leaveTo15, hi).at, leaveTo15, null), true,
    "leave ending 15:00 → 14:48 clock-in must be allowed");
  assert.equal(allowed("in", toMin("08:53"), leaveTo15, null), false, "but not at 08:53 that day");

  assert.equal(allowed("out", toMin("18:30"), span, null), false, "no clock-in → no clock-out");
  assert.equal(allowed("out", toMin("17:59"), span, toMin("08:50")), false);
  assert.equal(allowed("out", toMin("18:05"), span, toMin("09:10")), false, "8h not met");
  assert.equal(allowed("out", toMin("18:12"), span, toMin("09:10")), true);
  assert.equal(allowed("out", toMin("21:01"), span, toMin("09:10")), false);
});

test("dayOf merges duplicate NUEiP entries; punch helpers", () => {
  const d = dayOf([
    day(TUE, { punches: [] }),
    day(TUE, { punches: [punch("上班", `${TUE} 09:02:00`), punch("上班", `${TUE} 08:51:30`)] }),
    day(MON, { punches: [punch("下班", `${MON} 18:10:00`)] }),
  ], TUE);
  assert.equal(d.punches.length, 2);
  assert.equal(actualClockIn(d), toMin("08:51"), "earliest 上班 punch");
  assert.equal(alreadyPunched(d, "in"), true);
  assert.equal(alreadyPunched(d, "out"), false);
  assert.throws(() => dayOf([], TUE), /no attendance entry/, "missing data must fail, not pass silently");
});
