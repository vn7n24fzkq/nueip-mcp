// Formatters that turn nueip's raw, HTML-laden, field-duplicating responses
// into compact JSON the MCP client can read without burning tokens.

function stripHtml(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// nueip wraps real values in popover anchors like `<a data-content="忘記打卡">說明</a>`.
// The visible text ("說明") is just the popover trigger; the actual content lives in
// the data-content attribute. Prefer it when present.
function popoverText(s: unknown): string {
  if (typeof s !== "string") return "";
  const m = s.match(/data-content=(?:"([^"]*)"|'([^']*)')/);
  if (m) return (m[1] ?? m[2] ?? "").trim();
  return stripHtml(s);
}

interface RawBatch {
  v_sn: number;
  v_name: string;
  v_type: string;
  time_period: string;
  period_s_date: string;
  period_e_date: string;
  ava_hours: number | string;
  remain_hours: number | string;
  used_hours: number | string;
  pending_hours: number | string;
  resource_hours: number | string;
  prev_left: number | string;
  bind_info?: { has_bind: boolean; leave_name: string };
}

export interface LeaveBatchSummary {
  type: string;
  r_sn: number;
  remain_hours: number | string;
  used_hours: number | string;
  pending_hours: number | string;
  granted_hours: number | string;
  period_start: string;
  expires: string;
  prev_left: number | string;
  bound_to?: string;
}

export interface LeaveBalanceSummary {
  batches: LeaveBatchSummary[];
  totals_by_type: Record<string, { remain: number; used: number; pending: number }>;
  expiring_soon: LeaveBatchSummary[];
}

export function summarizeLeaveBalance(raw: unknown): LeaveBalanceSummary {
  const top = (raw as { data?: { v_resource?: Record<string, RawBatch> }[] }).data?.[0];
  const vres = top?.v_resource ?? {};
  const batches: LeaveBatchSummary[] = Object.values(vres).map(b => ({
    type: b.v_name,
    r_sn: b.v_sn,
    remain_hours: b.remain_hours,
    used_hours: b.used_hours,
    pending_hours: b.pending_hours,
    granted_hours: b.resource_hours,
    period_start: b.period_s_date,
    expires: b.period_e_date,
    prev_left: b.prev_left,
    bound_to: b.bind_info?.has_bind ? b.bind_info.leave_name : undefined,
  }));

  const totals: Record<string, { remain: number; used: number; pending: number }> = {};
  for (const b of batches) {
    const remain = typeof b.remain_hours === "number" ? b.remain_hours : 0;
    const used = typeof b.used_hours === "number" ? b.used_hours : 0;
    const pending = typeof b.pending_hours === "number" ? b.pending_hours : 0;
    const t = totals[b.type] ?? { remain: 0, used: 0, pending: 0 };
    t.remain += remain;
    t.used += used;
    t.pending += pending;
    totals[b.type] = t;
  }

  const now = Date.now();
  const ninetyDays = 90 * 24 * 60 * 60 * 1000;
  const expiringSoon = batches.filter(b => {
    if (typeof b.remain_hours !== "number" || b.remain_hours <= 0) return false;
    const expiresMs = new Date(b.expires).getTime();
    return Number.isFinite(expiresMs) && expiresMs - now < ninetyDays;
  });

  return { batches, totals_by_type: totals, expiring_soon: expiringSoon };
}

interface RawApprovalItem {
  s_sn: string;
  u_sn: string;
  qry_no: string;
  usr_name_str?: string;
  usr_name?: string;
  dept_name?: string;
  title_name?: string;
  date?: string;
  belong_date?: string;
  worktime?: string;
  section_typ?: string;
  work_time?: string;
  remark?: string;
  c_date?: string;
  audit_status?: string;
  is_deniable?: boolean;
  correctioncount?: string;
}

export interface ApprovalItemSummary {
  s_sn: string;
  qry_no: string;
  applicant: string;
  applicant_u_sn: string;
  dept: string;
  date: string;
  section: string;
  claimed_time: string;
  scheduled_time: string;
  reason: string;
  submitted_at: string;
  deniable: boolean;
  monthly_correction_count?: string;
}

export interface ApprovalListSummary {
  pending_total: number | string;
  by_applicant: Record<string, number>;
  items: ApprovalItemSummary[];
}

export function summarizeApprovals(raw: unknown): ApprovalListSummary {
  const r = raw as { data?: RawApprovalItem[]; awaiting_total?: number | string };
  const rows = r.data ?? [];
  const items: ApprovalItemSummary[] = rows.map(it => ({
    s_sn: it.s_sn,
    qry_no: it.qry_no,
    applicant: it.usr_name_str ?? stripHtml(it.usr_name),
    applicant_u_sn: it.u_sn,
    dept: `${it.dept_name ?? ""} ${it.title_name ?? ""}`.trim(),
    date: it.belong_date ?? it.date ?? "",
    section: it.section_typ ?? "",
    claimed_time: it.work_time ?? "",
    scheduled_time: it.worktime ?? "",
    reason: popoverText(it.remark),
    submitted_at: stripHtml(it.c_date),
    deniable: it.is_deniable ?? false,
    monthly_correction_count: it.correctioncount,
  }));
  const byApplicant: Record<string, number> = {};
  for (const it of items) {
    byApplicant[it.applicant] = (byApplicant[it.applicant] ?? 0) + 1;
  }
  return { pending_total: r.awaiting_total ?? items.length, by_applicant: byApplicant, items };
}

interface RawAttendanceDay {
  user: { u_sn: number; u_no: string; name: string; deptname: string };
  dateInfo: { date: string; date_off?: boolean; daytype?: string; holiday?: string };
  attendance?: { tag?: string; latemin?: string; leaveearlymin?: string; absentmin?: string } | null;
  worktime?: string;
  punch?: { onPunch?: RawPunch[]; offPunch?: RawPunch[] };
  inout?: unknown[];
}

interface RawPunch {
  s_sn: string;
  section: string;
  work_time: string;
  work_way: string;
  gps?: string;
  address?: string;
  remark?: string;
  sign_status?: string;
}

export interface AttendanceDaySummary {
  date: string;
  weekday: string;
  scheduled: string;
  status: string;
  is_off: boolean;
  holiday?: string;
  late_min?: number;
  punches: {
    s_sn: string;
    section: "上班" | "下班" | string;
    time: string;
    source: string;
    location?: string;
    pending_approval: boolean;
  }[];
}

const WORK_WAY: Record<string, string> = {
  "1": "網路打卡",
  "2": "批次匯入",
  "3": "手動新增",
  "4": "外出登記",
  "5": "補卡",
  "6": "GPS打卡",
};

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function weekdayOf(date: string): string {
  const ms = Date.parse(`${date}T00:00:00+08:00`);
  return Number.isFinite(ms) ? (WEEKDAYS[new Date(ms).getDay()] ?? "") : "";
}

export function summarizeAttendance(raw: unknown): AttendanceDaySummary[] {
  const r = raw as { data?: Record<string, Record<string, RawAttendanceDay>> };
  const out: AttendanceDaySummary[] = [];
  for (const [date, users] of Object.entries(r.data ?? {})) {
    for (const day of Object.values(users)) {
      const punches: AttendanceDaySummary["punches"] = [];
      for (const p of day.punch?.onPunch ?? []) {
        punches.push({
          s_sn: p.s_sn,
          section: "上班",
          time: p.work_time,
          source: WORK_WAY[p.work_way] ?? p.work_way,
          location: p.address || undefined,
          pending_approval: p.sign_status === "1",
        });
      }
      for (const p of day.punch?.offPunch ?? []) {
        punches.push({
          s_sn: p.s_sn,
          section: "下班",
          time: p.work_time,
          source: WORK_WAY[p.work_way] ?? p.work_way,
          location: p.address || undefined,
          pending_approval: p.sign_status === "1",
        });
      }
      const holiday = day.dateInfo?.holiday?.trim();
      const daytype = day.dateInfo?.daytype?.trim();
      const isOff = !!day.dateInfo?.date_off;
      const weekday = weekdayOf(date);
      let status: string;
      if (holiday) status = holiday;
      else if (daytype) status = daytype;
      else if (isOff) status = weekday === "六" || weekday === "日" ? "週末" : "休假";
      else status = stripHtml(day.attendance?.tag) || "正常";

      out.push({
        date,
        weekday,
        scheduled: day.worktime ?? "",
        status,
        is_off: isOff,
        holiday: holiday || undefined,
        late_min: day.attendance?.latemin ? Number(day.attendance.latemin) : undefined,
        punches,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

interface RawLeave {
  qry_no: string;
  s_sn: string;
  u_sn: string;
  usr_name: string;
  v_sn: string;
  rule_name: string;
  start_date: string;
  hr_start: string;
  min_start: string;
  end_date: string;
  hr_end: string;
  min_end: string;
  total_time: string;
  total_hours: string;
  agent: string;
  agent_name: string;
  remark: string;
  remarkpure?: string;
  sign_status: string;
  isCancelable?: boolean;
  c_date: string;
}

const SIGN_STATUS: Record<string, string> = {
  "-1": "草稿",
  "0": "簽核中",
  "1": "簽核中",
  "2": "已通過",
  "3": "不通過",
  "4": "已銷假",
};

export interface LeaveRecordSummary {
  qry_no: string;
  s_sn: string;
  applicant: string;
  type: string;
  r_sn: string;
  start: string;
  end: string;
  total_hours: string;
  agent: string;
  reason: string;
  status: string;
  cancelable: boolean;
  submitted_at: string;
}

export function summarizeLeaves(raw: unknown): { count: number; records: LeaveRecordSummary[]; badges?: unknown } {
  const r = raw as { result?: RawLeave[]; badges?: unknown };
  const records: LeaveRecordSummary[] = (r.result ?? []).map(l => ({
    qry_no: l.qry_no,
    s_sn: l.s_sn,
    applicant: stripHtml(l.usr_name),
    type: l.rule_name,
    r_sn: l.v_sn,
    start: `${l.start_date} ${l.hr_start}:${l.min_start}`,
    end: `${l.end_date} ${l.hr_end}:${l.min_end}`,
    total_hours: l.total_hours,
    agent: stripHtml(l.agent_name),
    reason: l.remarkpure ?? popoverText(l.remark),
    status: SIGN_STATUS[l.sign_status] ?? l.sign_status,
    cancelable: l.isCancelable ?? false,
    submitted_at: l.c_date,
  }));
  return { count: records.length, records, badges: r.badges };
}
