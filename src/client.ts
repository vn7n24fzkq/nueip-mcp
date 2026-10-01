import { Buffer } from "node:buffer";

const CLOUD = "https://cloud.nueip.com";
const SSO = "https://api.nueip.com";

export interface PunchSection {
  s_sn: string;
  type_code: string;
  code: string; // "1"=clockin, "2"=clockout
  lang_key: string;
}

export interface PunchViewData {
  status: string;
  display: boolean;
  flag: boolean;
  gps_rule: string;
  enabled_gps: boolean;
  section: PunchSection[];
  token: string;
  zone: string;
  user: { u_no: string; day: string };
}

export interface PunchResult {
  code?: number;
  status?: string;
  message: string;
  data?: { rulesn: string };
}

export interface RemainHours {
  code: number;
  remain_hr: number;
  used_hr: number;
  pending_hr: number;
  msg: string;
}

export interface LeaveTypeMap {
  [typeCode: string]: { [r_sn: string]: string } | string[];
}

export interface JwtPayload {
  role: string;
  account: string;
  company_id: string;
  sub: string; // u_sn
  exp: number;
  [key: string]: unknown;
}

interface LoginCredentials {
  companyCode: string;
  employeeId: string;
  password: string;
}

function decodeJwt(token: string): JwtPayload {
  const part = token.split(".")[1];
  if (!part) throw new Error("Invalid JWT");
  const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
}

/**
 * Thrown when nueip returns `{status:"fail", message:"..."}` at the body level
 * (the request was 2xx but the operation failed — e.g. permission denied,
 * 30-second cooldown, validation rejection).
 */
export class NueipError extends Error {
  constructor(public override message: string, public raw: unknown) {
    super(message);
    this.name = "NueipError";
  }
}

function assertOk(json: unknown): void {
  if (json && typeof json === "object" && (json as { status?: string }).status === "fail") {
    const msg = (json as { message?: string }).message || "nueip request failed";
    throw new NueipError(msg, json);
  }
}

export class NueipClient {
  private cookies = new Map<string, string>();
  private bearer: string | null = null;
  private bearerExp = 0;
  private csrf = "";
  private uSn = "";
  private cSn = "";
  private dSn = "";
  private udSn = "";
  private creds: LoginCredentials;

  constructor(creds: LoginCredentials) {
    this.creds = creds;
  }

  get userSn(): string {
    return this.uSn;
  }

  get companyId(): string {
    return this.cSn;
  }

  get deptSn(): string {
    return this.dSn;
  }

  get userDeptSn(): string {
    return this.udSn;
  }

  private async fetchUserDeptMap(): Promise<Record<string, RawUserDept>> {
    const res = await this.raw(`${CLOUD}/widget/deptChain/getUserDeptMap`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: "",
    });
    return await res.json() as Record<string, RawUserDept>;
  }

  private async resolveIdentity(): Promise<void> {
    if (this.dSn && this.udSn) return;
    const j = await this.fetchUserDeptMap();
    const me = j[this.uSn];
    if (!me) throw new Error(`Identity not found for u_sn=${this.uSn}`);
    if (me.d_sn) this.dSn = String(me.d_sn);
    if (me.s_sn) this.udSn = String(me.s_sn); // s_sn in this response is the user-dept SN
  }

  async whoami(): Promise<Identity> {
    await this.ensureSession();
    const j = await this.fetchUserDeptMap();
    const me = j[this.uSn];
    return {
      u_sn: this.uSn,
      ud_sn: this.udSn,
      d_sn: this.dSn,
      c_sn: this.cSn,
      name: me?.c_name ?? "",
      dept_name: me?.d_name ?? "",
      title_name: me?.title_name ?? "",
    };
  }

  async listColleagues(args: { sameDeptOnly?: boolean } = {}): Promise<Colleague[]> {
    await this.ensureSession();
    const j = await this.fetchUserDeptMap();
    const out: Colleague[] = [];
    for (const u of Object.values(j)) {
      if (!u || u.u_sn === this.uSn) continue; // exclude self
      if (args.sameDeptOnly && u.d_sn !== this.dSn) continue;
      out.push({
        u_sn: u.u_sn,
        ud_sn: u.s_sn,
        d_sn: u.d_sn,
        name: u.c_name,
        dept_name: u.d_name,
        title_name: u.title_name,
      });
    }
    return out;
  }

  /**
   * Build the {company}_{dept}_{userDept} triple that nueip uses everywhere as the
   * "employee" filter value. Pass a different user's `ud_sn` to scope to them.
   */
  private layerTriple(targetUdSn?: string): string {
    return `${this.cSn}_${this.dSn}_${targetUdSn ?? this.udSn}`;
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorbSetCookie(res: Response): void {
    const list = res.headers.getSetCookie();
    for (const sc of list) {
      const semi = sc.indexOf(";");
      const pair = semi >= 0 ? sc.slice(0, semi) : sc;
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1);
      const lower = sc.toLowerCase();
      const expired = lower.includes("max-age=0") ||
        lower.includes("expires=thu, 01-jan-1970") ||
        value === "deleted";
      if (expired) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
    const csrf = this.cookies.get("csrf_token");
    if (csrf) this.csrf = csrf;
  }

  private buildHeaders(init: RequestInit & { auth?: boolean }): Headers {
    const headers = new Headers(init.headers);
    headers.set("X-Requested-With", "XMLHttpRequest");
    headers.set("Accept", "application/json, text/plain, */*");
    if (this.cookies.size) headers.set("Cookie", this.cookieHeader());
    if (this.csrf && !headers.has("X-Csrf-Token")) headers.set("X-Csrf-Token", this.csrf);
    if (init.auth !== false && this.bearer) {
      headers.set("Authorization", `Bearer ${this.bearer}`);
    }
    return headers;
  }

  private async raw(
    url: string,
    init: RequestInit & { auth?: boolean } = {},
  ): Promise<Response> {
    const res = await fetch(url, {
      ...init,
      headers: this.buildHeaders(init),
      redirect: "manual",
    });
    this.absorbSetCookie(res);
    // nueip idles sessions at ~600s. If a logged-in call comes back 401, drop
    // cached session state and retry once with a fresh login.
    if (res.status === 401 && init.auth !== false && this.bearer) {
      this.bearer = null;
      this.bearerExp = 0;
      this.cookies.clear();
      this.csrf = "";
      await this.ensureSession();
      const retry = await fetch(url, {
        ...init,
        headers: this.buildHeaders(init),
        redirect: "manual",
      });
      this.absorbSetCookie(retry);
      return retry;
    }
    return res;
  }

  async ensureSession(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    if (this.bearer && now < this.bearerExp - 60) return;

    // Step 1: bootstrap PHPSESSID + csrf by hitting the login page
    if (!this.cookies.has("PHPSESSID")) {
      await this.raw("https://portal.nueip.com/login", { method: "GET", auth: false });
    }

    // Step 2: SSO verify (sets sso_session cookie; server expects this prelude)
    await this.raw(`${SSO}/sso/auth/verify`, {
      method: "POST",
      auth: false,
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ company_code: this.creds.companyCode }),
    });

    // Step 3: credential POST → session cookies
    const loginBody = new URLSearchParams({
      inputCompany: this.creds.companyCode,
      inputID: this.creds.employeeId,
      inputPassword: this.creds.password,
    });
    const loginRes = await this.raw(`${CLOUD}/login/index/param`, {
      method: "POST",
      auth: false,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: loginBody.toString(),
    });
    const loginJson = await loginRes.json() as { status: string; message: string };
    if (loginJson.status !== "success") {
      throw new Error(`Login failed: ${loginJson.message}`);
    }

    // Step 4: fetch OAuth2 bearer
    const tokRes = await this.raw(`${CLOUD}/oauth2/token/api`, {
      method: "GET",
      auth: false,
    });
    const tok = await tokRes.json() as {
      token_access_token: string;
      token_expires_in: number;
      token_createtime: number;
    };
    this.bearer = tok.token_access_token;
    const payload = decodeJwt(this.bearer);
    this.bearerExp = payload.exp;
    this.uSn = payload.sub;
    this.cSn = payload.company_id;
    await this.resolveIdentity();
  }

  private async postForm(path: string, body: Record<string, string>): Promise<unknown> {
    await this.ensureSession();
    const res = await this.raw(`${CLOUD}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
    return res.json();
  }

  private async get(path: string): Promise<unknown> {
    await this.ensureSession();
    const res = await this.raw(`${CLOUD}${path}`, { method: "GET" });
    return res.json();
  }

  // ── Clock in/out ────────────────────────────────────────────────────

  async getPunchView(): Promise<PunchViewData> {
    const j = await this.get("/portal/Portal_punch_clock/ajax?type=view") as
      { code: number; message: string; data: PunchViewData };
    return j.data;
  }

  async punch(args: {
    section: "clockin" | "clockout";
    lat: number;
    lng: number;
    attendanceTime?: Date;
  }): Promise<PunchResult> {
    const view = await this.getPunchView();
    const sec = view.section.find(s => s.lang_key === args.section);
    if (!sec) throw new Error(`section ${args.section} not available`);
    const when = args.attendanceTime ?? new Date();
    const stamp = formatLocal(when);
    const result = await this.postForm("/portal/Portal_punch_clock/ajax", {
      check_type: "1",
      id: sec.code,
      token: view.token,
      attendance_time: stamp,
      lat: String(args.lat),
      lng: String(args.lng),
    });
    assertOk(result);
    return result as PunchResult;
  }

  // ── Attendance ──────────────────────────────────────────────────────

  async listAttendance(args: { startDate: string; endDate: string }): Promise<unknown> {
    await this.ensureSession();
    const filterCookies: Record<string, string> = {
      Search_124_date_start: args.startDate,
      Search_124_date_end: args.endDate,
      Search_124_work_status: "1",
      Search_124_FLayer: this.cSn,
      Search_124_SLayer: `${this.cSn}_${this.dSn}`,
      Search_124_TLayer: this.layerTriple(),
      Search_124_showByBelongDate: "1",
      Search_124_filterModify: "0",
    };
    for (const [k, v] of Object.entries(filterCookies)) {
      if (v) this.cookies.set(k, v);
    }
    const res = await this.raw(`${CLOUD}/attendance_record/ajax`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "fe-pno": "124",
      },
      body: "action=attendance&loadInBatch=1&loadBatchGroupNum=1000&loadBatchNumber=1&work_status=1",
    });
    return res.json();
  }

  // ── 補卡 (correction) ──────────────────────────────────────────────

  async getCorrectionPrefill(args: { u_sn: string; date: string }): Promise<unknown> {
    return await this.get(
      `/attendance_record/ajax_get_correction_data?u_sn=${args.u_sn}&date=${args.date}`,
    );
  }

  async addCorrectionPunch(args: {
    u_sn: string;
    date: string;
    section: "1" | "2" | "3"; // 1=上班, 2=下班, 3=跨日下班
    hour: string; // "08"
    min: string; // "50"
    remark: string;
    apply_date?: string;
  }): Promise<unknown> {
    await this.ensureSession();
    const body = new URLSearchParams({
      section: args.section,
      hour: args.hour,
      min: args.min,
      remark: args.remark,
      u_sn: args.u_sn,
      date: args.date,
      apply_date: args.apply_date ?? args.date,
    });
    const res = await this.raw(`${CLOUD}/attendance_record/addCorrectionPunch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "fe-pno": "124",
      },
      body: body.toString(),
    });
    const j = await res.json();
    assertOk(j);
    return j;
  }

  // ── Leave ─────────────────────────────────────────────────────────

  async listLeaves(args: { startDate: string; endDate?: string }): Promise<unknown> {
    await this.ensureSession();
    const body = new URLSearchParams({
      action: "list",
      s_date: args.startDate,
      e_date: args.endDate ?? "",
      employee: this.layerTriple(),
      resource: "all",
      work_status: "1",
      qry_no: "",
      filtMethod: "all",
    });
    const res = await this.raw(`${CLOUD}/leave_application/personal_leave_application_user/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "fe-pno": "40",
      },
      body: body.toString(),
    });
    return res.json();
  }

  async getLeaveTypes(applicantUSn?: string): Promise<LeaveTypeMap> {
    const j = await this.get(
      `/leave_application/personal_leave_application_user/getLeaveList?applicant=${applicantUSn ?? this.uSn}`,
    ) as { code: number; data: LeaveTypeMap };
    return j.data;
  }

  async getLeaveRules(): Promise<unknown> {
    return await this.get("/leave_application/personal_leave_application_user/getLeaveRule");
  }

  async getRemainHours(args: {
    r_sn: string;
    u_sn?: string;
    startDate: string;
    endDate: string;
  }): Promise<RemainHours> {
    return await this.postForm("/api/leave/resource/remainHours", {
      v_sn: args.r_sn,
      u_sn: args.u_sn ?? this.uSn,
      s_date: args.startDate,
      d_date: args.endDate,
      work_status: "1",
    }) as RemainHours;
  }

  async listLeaveResources(args: {
    year?: number;
    startDate?: string;
    endDate?: string;
    target_ud_sn?: string;
  } = {}): Promise<unknown> {
    await this.ensureSession();
    const useDateRange = args.startDate && args.endDate;
    const body = new URLSearchParams({
      action: "list",
      FLayer: this.cSn,
      SLayer: `${this.cSn}_${this.dSn}`,
      TLayer: this.layerTriple(args.target_ud_sn),
      VLayer: "all",
      ov2leaveCombine: "on",
      annual: String(args.year ?? new Date().getFullYear()),
      filter_mode: useDateRange ? "1" : "0",
      start_date: args.startDate ?? "",
      end_date: args.endDate ?? "",
      displayDetail: "off",
      work_status: "1",
    });
    const res = await this.raw(`${CLOUD}/personal_leave_resource`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "fe-pno": "44",
      },
      body: body.toString(),
    });
    return res.json();
  }

  async applyLeave(args: {
    r_sn: string;
    days: { date: string; start: string; end: string; hour: number; min: number }[];
    substitute_u_sn: string;
    substitute_ud_sn: string;
    remark: string;
  }): Promise<unknown> {
    await this.ensureSession();
    if (args.days.length === 0) throw new Error("days is empty");
    const fd = new FormData();
    fd.set("action", "add");
    fd.set("pageType", "leave");
    fd.set("applicant", this.layerTriple());
    fd.set("myFLayer", args.r_sn);
    fd.set("s_date", args.days[0]!.date);
    fd.set("d_date", args.days[args.days.length - 1]!.date);
    args.days.forEach((d, i) => {
      fd.append(`leave[${i}][date]`, d.date);
      fd.append(`leave[${i}][start]`, d.start);
      fd.append(`leave[${i}][end]`, d.end);
      fd.append(`leave[${i}][hour]`, String(d.hour));
      fd.append(`leave[${i}][min]`, String(d.min));
    });
    // Layer3 = the applicant's u_sn (not ud_sn) — nueip quirk
    fd.set("FLayer3", this.cSn);
    fd.set("SLayer3", this.dSn);
    fd.set("TLayer3", this.uSn);
    // Layer2 = substitute
    fd.set("FLayer2", this.cSn);
    fd.set("SLayer2", this.dSn);
    fd.set("sub_usn", args.substitute_u_sn);
    fd.set("TLayer2", `${this.cSn}_${this.dSn}_${args.substitute_ud_sn}`);
    fd.set("remark", args.remark);

    // Run the attachment pre-check first; bail out with its message on failure
    const fdCheck = new FormData();
    for (const [k, v] of fd.entries()) fdCheck.append(k, v);
    const checkRes = await this.raw(
      `${CLOUD}/leave_application/personal_leave_application_user/check_attachment_setting`,
      { method: "POST", body: fdCheck, headers: { "fe-pno": "40" } },
    );
    const checkJson = await checkRes.json().catch(() => null) as {
      status?: string;
      message?: string;
    } | null;
    if (checkJson?.status === "fail") {
      throw new Error(`Attachment pre-check failed: ${checkJson.message}`);
    }

    const res = await this.raw(`${CLOUD}/leave_application/personal_leave_application_user/`, {
      method: "POST",
      body: fd,
      headers: { "fe-pno": "40" },
    });
    const j = await res.json();
    assertOk(j);
    return j;
  }

  async validateDeleteLeaves(s_sns: string[]): Promise<unknown> {
    await this.ensureSession();
    const body = new URLSearchParams();
    for (const s of s_sns) body.append("s_sn[]", s);
    const res = await this.raw(
      `${CLOUD}/leave_application/personal_leave_application_user/validate_delete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "fe-pno": "40",
        },
        body: body.toString(),
      },
    );
    return res.json();
  }

  async deletePendingLeaves(args: {
    s_sns: string[];
    reconfirm?: boolean;
  }): Promise<unknown> {
    await this.ensureSession();
    const body = new URLSearchParams();
    body.set("action", "delete");
    for (const s of args.s_sns) body.append("s_sn[]", s);
    body.set("reconfirm", args.reconfirm ? "true" : "false");
    const res = await this.raw(`${CLOUD}/leave_application/personal_leave_application_user/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "fe-pno": "40",
      },
      body: body.toString(),
    });
    const j = await res.json();
    assertOk(j);
    return j;
  }

  async getWorksHours(args: { dates: string[]; employee?: string }): Promise<unknown> {
    await this.ensureSession();
    const body = new URLSearchParams();
    body.set("action", "getWorksHours");
    for (const d of args.dates) body.append("dates[]", d);
    body.set("employee", args.employee ?? this.layerTriple());
    body.set("printeveryday", "0");
    const res = await this.raw(`${CLOUD}/leave_application/personal_leave_application_user/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "fe-pno": "40",
      },
      body: body.toString(),
    });
    return res.json();
  }

  // ── Manager approvals (簽核作業) ─────────────────────────────────

  /**
   * `type` corresponds to the URL segment in `/leader_audit_work_list/index/{type}`.
   * Common values: `attendance` = 補卡, `leave` = 請假, `cancel_leave` = 銷假,
   * `overtime` = 加班, `preovertime` = 事先加班, `outing` = 外出, `expense` = 費用.
   */
  async listPendingApprovals(args: {
    type: ApprovalType;
    filtMethod?: "ongoing" | "pass" | "fail" | "all";
    startDate?: string;
    endDate?: string;
  }): Promise<unknown> {
    await this.ensureSession();
    const body = new URLSearchParams({
      action: "list",
      s_date: args.startDate ?? "",
      e_date: args.endDate ?? "",
      employee: this.layerTriple(),
      work_status: "1",
      filtMethod: args.filtMethod ?? "ongoing",
      audit_show_dept_title: "on",
    });
    const res = await this.raw(`${CLOUD}/leader_audit_work_list/index/${args.type}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "fe-pno": "225",
      },
      body: body.toString(),
    });
    return res.json();
  }

  async respondToApprovals(args: {
    type: ApprovalType;
    act: "agree" | "deny";
    targets: { s_sn: string; remark?: string }[];
  }): Promise<{ status: string; message: string }> {
    if (args.targets.length === 0) throw new Error("targets is empty");
    await this.ensureSession();
    const body = new URLSearchParams();
    body.set("action", "approval");
    body.set("act", args.act);
    args.targets.forEach((t, i) => {
      body.append(`target[${i}][s_sn]`, t.s_sn);
      body.append(`target[${i}][remark]`, t.remark ?? "");
    });
    const res = await this.raw(`${CLOUD}/leader_audit_work_list/index/${args.type}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "fe-pno": "225",
      },
      body: body.toString(),
    });
    const j = await res.json() as { status: string; message: string };
    assertOk(j);
    return j;
  }
}

export interface Identity {
  u_sn: string;
  ud_sn: string;
  d_sn: string;
  c_sn: string;
  name: string;
  dept_name: string;
  title_name: string;
}

export interface Colleague {
  u_sn: string;
  ud_sn: string;
  d_sn: string;
  name: string;
  dept_name: string;
  title_name: string;
}

interface RawUserDept {
  s_sn: string;
  c_sn: string;
  u_sn: string;
  d_sn: string;
  c_name: string;
  d_name: string;
  title_name: string;
}

export type ApprovalType =
  | "attendance"
  | "leave"
  | "cancel_leave"
  | "overtime"
  | "preovertime"
  | "outing"
  | "expense"
  | "flextime";

// NUEiP wants Taiwan wall-clock time. Don't use the host TZ: a UTC container
// would stamp punches 8h off. Taiwan has no DST, so a fixed +8h is exact.
function formatLocal(d: Date): string {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
}
