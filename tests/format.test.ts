import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  summarizeApprovals,
  summarizeAttendance,
  summarizeLeaveBalance,
} from "../src/format.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(here, "fixtures", name), "utf-8"));

test("summarizeLeaveBalance: extracts batches with expiry and totals_by_type", () => {
  const summary = summarizeLeaveBalance(fixture("leave_balance.json"));
  assert.equal(summary.batches.length, 3);

  const tx = summary.batches.find(b => b.type === "特休" && b.expires === "2026-09-30");
  assert.ok(tx, "expected the 9/30-expiring 特休 batch");
  assert.equal(tx.remain_hours, 45);
  assert.equal(tx.used_hours, 19);

  assert.equal(summary.totals_by_type["特休"]?.remain, 141, "特休 totals should sum across batches");
  assert.equal(summary.totals_by_type["家庭照顧假"]?.remain, 56);

  const familyCare = summary.batches.find(b => b.type === "家庭照顧假");
  assert.equal(familyCare?.bound_to, "事假", "bind_info.leave_name should propagate to bound_to");
});

test("summarizeApprovals: pulls reason from popover data-content (not the label '說明')", () => {
  const summary = summarizeApprovals(fixture("approvals.json"));
  assert.equal(summary.pending_total, 15);
  assert.equal(summary.items.length, 2);
  assert.equal(summary.items[0]?.reason, "忘記打卡", "must NOT be the popover label '說明'");
  assert.equal(summary.items[0]?.applicant, "Alice Tester");
  assert.equal(summary.items[0]?.s_sn, "10000001");
  assert.equal(summary.by_applicant["Alice Tester"], 1);
  assert.equal(summary.by_applicant["Bob Sample"], 1);
});

test("summarizeAttendance: holiday, weekend, and weekday with punches", () => {
  const days = summarizeAttendance(fixture("attendance.json"));
  assert.equal(days.length, 3, "expected 3 days");

  const holiday = days.find(d => d.date === "2026-05-01");
  assert.equal(holiday?.status, "勞動節", "5/1 should surface holiday name");
  assert.equal(holiday?.is_off, true);

  const weekend = days.find(d => d.date === "2026-05-10");
  assert.equal(weekend?.weekday, "日");
  assert.equal(weekend?.status, "週末");
  assert.equal(weekend?.is_off, true);

  const workday = days.find(d => d.date === "2026-05-11");
  assert.equal(workday?.status, "遲到");
  assert.equal(workday?.late_min, 234);
  assert.equal(workday?.punches.length, 2);
  assert.equal(workday?.punches[0]?.source, "補卡");
  assert.equal(workday?.punches[1]?.source, "GPS打卡");
  assert.equal(workday?.punches[0]?.pending_approval, true);
});
