import { z } from "zod";
import type { ApprovalType, NueipClient } from "./client.js";
import type { LocationPreset } from "./config.js";
import {
  summarizeApprovals,
  summarizeAttendance,
  summarizeLeaveBalance,
  summarizeLeaves,
} from "./format.js";

const approvalType: z.ZodType<ApprovalType> = z.enum([
  "attendance",
  "leave",
  "cancel_leave",
  "overtime",
  "preovertime",
  "outing",
  "expense",
  "flextime",
]);

export interface ToolContext {
  client: NueipClient;
  presets: LocationPreset[];
}

export interface ToolDef<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  handler: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

function findPreset(presets: LocationPreset[], name: string): LocationPreset {
  const p = presets.find(p => p.name === name);
  if (!p) {
    throw new Error(
      `Unknown location preset "${name}". Available: ${
        presets.map(p => p.name).join(", ") || "(none configured)"
      }`,
    );
  }
  return p;
}

export const tools = [
  {
    name: "clock_in",
    description:
      "Clock in (上班打卡). Pass a preset name (from configured location presets) OR raw lat/lng. " +
      "Uses GPS-based punching (check_type=1).",
    schema: z.object({
      preset: z.string().optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
    }).refine(v => v.preset || (v.lat !== undefined && v.lng !== undefined), {
      message: "must supply either preset or both lat+lng",
    }),
    handler: async (input, ctx) => {
      const { lat, lng } = input.preset
        ? findPreset(ctx.presets, input.preset)
        : { lat: input.lat!, lng: input.lng! };
      return await ctx.client.punch({ section: "clockin", lat, lng });
    },
  } satisfies ToolDef<z.ZodTypeAny>,

  {
    name: "clock_out",
    description: "Clock out (下班打卡). Same input shape as clock_in.",
    schema: z.object({
      preset: z.string().optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
    }).refine(v => v.preset || (v.lat !== undefined && v.lng !== undefined), {
      message: "must supply either preset or both lat+lng",
    }),
    handler: async (input, ctx) => {
      const { lat, lng } = input.preset
        ? findPreset(ctx.presets, input.preset)
        : { lat: input.lat!, lng: input.lng! };
      return await ctx.client.punch({ section: "clockout", lat, lng });
    },
  } satisfies ToolDef<z.ZodTypeAny>,

  {
    name: "punch_status",
    description: "Get the current punch widget state (in-range status, GPS rule, today's punches if any).",
    schema: z.object({}),
    handler: async (_input, ctx) => await ctx.client.getPunchView(),
  } satisfies ToolDef<z.ZodTypeAny>,

  {
    name: "list_location_presets",
    description: "List the configured location presets (name, lat, lng).",
    schema: z.object({}),
    handler: async (_input, ctx) => ctx.presets,
  } satisfies ToolDef<z.ZodTypeAny>,

  {
    name: "whoami",
    description: "Return the logged-in user's identity (u_sn, ud_sn, d_sn, c_sn, name, dept, title).",
    schema: z.object({}),
    handler: async (_input, ctx) => await ctx.client.whoami(),
  } satisfies ToolDef<z.ZodTypeAny>,

  {
    name: "list_colleagues",
    description:
      "List visible colleagues with their u_sn / ud_sn / dept / title. Use this to pick a substitute (職代) for apply_leave — you need both u_sn and ud_sn. " +
      "Pass same_dept_only=true to scope to the caller's department.",
    schema: z.object({
      same_dept_only: z.boolean().optional(),
    }),
    handler: async (input, ctx) =>
      await ctx.client.listColleagues({ sameDeptOnly: input.same_dept_only }),
  } satisfies ToolDef<z.ZodTypeAny>,

  {
    name: "list_attendance",
    description:
      "List attendance records (punches, schedule, anomalies) for a date range. " +
      "Returns a compact per-day summary with each punch's s_sn so you can correct/edit it later.",
    schema: z.object({
      start_date: isoDate,
      end_date: isoDate,
    }),
    handler: async (input, ctx) => {
      const raw = await ctx.client.listAttendance({
        startDate: input.start_date,
        endDate: input.end_date,
      });
      return summarizeAttendance(raw);
    },
  } satisfies ToolDef<z.ZodTypeAny>,

  {
    name: "list_leaves",
    description: "List leave applications (since start_date, optionally to end_date).",
    schema: z.object({
      start_date: isoDate,
      end_date: isoDate.optional(),
    }),
    handler: async (input, ctx) => {
      const raw = await ctx.client.listLeaves({
        startDate: input.start_date,
        endDate: input.end_date,
      });
      return summarizeLeaves(raw);
    },
  } satisfies ToolDef<z.ZodTypeAny>,

  {
    name: "leave_balance",
    description:
      "Leave balances grouped by batch with expiry dates. " +
      "Returns `batches` (per-period), `totals_by_type` (summed across batches), and `expiring_soon` (batches expiring within 90 days). " +
      "Default: current year. Specify start_date+end_date to filter by date range instead.",
    schema: z.object({
      year: z.number().int().optional(),
      start_date: isoDate.optional(),
      end_date: isoDate.optional(),
    }),
    handler: async (input, ctx) => {
      const raw = await ctx.client.listLeaveResources({
        year: input.year,
        startDate: input.start_date,
        endDate: input.end_date,
      });
      return summarizeLeaveBalance(raw);
    },
  } satisfies ToolDef<z.ZodTypeAny>,

  {
    name: "leave_types",
    description: "List leave types available to the user, including rule serial numbers (r_sn).",
    schema: z.object({}),
    handler: async (_input, ctx) => await ctx.client.getLeaveTypes(),
  } satisfies ToolDef<z.ZodTypeAny>,

  {
    name: "remaining_leave_hours",
    description:
      "Get remaining hours for a single leave rule (r_sn) on a date range. " +
      "For batch-level expiry use leave_balance instead.",
    schema: z.object({
      r_sn: z.string(),
      start_date: isoDate,
      end_date: isoDate,
    }),
    handler: async (input, ctx) =>
      await ctx.client.getRemainHours({
        r_sn: input.r_sn,
        startDate: input.start_date,
        endDate: input.end_date,
      }),
  } satisfies ToolDef<z.ZodTypeAny>,

  {
    name: "list_pending_approvals",
    description:
      "List pending approval requests as a manager. type=attendance for 補卡, leave/overtime/etc for those. " +
      "Returns a summary with `pending_total`, `by_applicant` count, and per-item `s_sn` (use for respond_to_approvals), applicant, date, section, claimed_time, reason.",
    schema: z.object({
      type: approvalType,
      filt_method: z.enum(["ongoing", "pass", "fail", "all"]).optional(),
    }),
    handler: async (input, ctx) => {
      const raw = await ctx.client.listPendingApprovals({
        type: input.type,
        filtMethod: input.filt_method,
      });
      return summarizeApprovals(raw);
    },
  } satisfies ToolDef<z.ZodTypeAny>,

  {
    name: "respond_to_approvals",
    description:
      "Approve (agree) or reject (deny) one or more pending requests. " +
      "⚠️ This is irreversible — once agreed, the server refuses to revert. " +
      "Pass s_sn values from list_pending_approvals.",
    schema: z.object({
      type: approvalType,
      act: z.enum(["agree", "deny"]),
      targets: z.array(z.object({
        s_sn: z.string(),
        remark: z.string().optional(),
      })).min(1),
    }),
    handler: async (input, ctx) =>
      await ctx.client.respondToApprovals({
        type: input.type,
        act: input.act,
        targets: input.targets,
      }),
  } satisfies ToolDef<z.ZodTypeAny>,

  {
    name: "apply_leave",
    description:
      "Submit a leave application (請假). " +
      "Workflow: (1) call `leave_types` to find r_sn, (2) call `list_colleagues` to find substitute_u_sn + substitute_ud_sn, (3) call this tool. " +
      "Each day in `days` covers one calendar date; for half-day or partial-day leaves set start/end and hour/min accordingly. " +
      "⚠️ Creates a pending approval record. Use delete_pending_leaves to retract while still 簽核中.",
    schema: z.object({
      r_sn: z.string(),
      days: z.array(z.object({
        date: isoDate,
        start: z.string().regex(/^\d{2}:\d{2}$/, "expected HH:mm"),
        end: z.string().regex(/^\d{2}:\d{2}$/, "expected HH:mm"),
        hour: z.number().int().nonnegative(),
        min: z.number().int().min(0).max(59),
      })).min(1),
      substitute_u_sn: z.string(),
      substitute_ud_sn: z.string(),
      remark: z.string().min(1, "remark is required"),
    }),
    handler: async (input, ctx) =>
      await ctx.client.applyLeave({
        r_sn: input.r_sn,
        days: input.days,
        substitute_u_sn: input.substitute_u_sn,
        substitute_ud_sn: input.substitute_ud_sn,
        remark: input.remark,
      }),
  } satisfies ToolDef<z.ZodTypeAny>,

  {
    name: "delete_pending_leaves",
    description:
      "Delete one or more PENDING (簽核中) leave applications by their s_sn. " +
      "Runs validate_delete first and surfaces warnings; pass reconfirm=true to commit through warnings. " +
      "For already-APPROVED leaves use cancel_leave (銷假) instead — this tool will fail on those.",
    schema: z.object({
      s_sns: z.array(z.string()).min(1),
      reconfirm: z.boolean().optional(),
    }),
    handler: async (input, ctx) => {
      const validation = await ctx.client.validateDeleteLeaves(input.s_sns);
      if (!input.reconfirm) {
        return { validation, hint: "Pass reconfirm=true to commit the delete." };
      }
      const result = await ctx.client.deletePendingLeaves({
        s_sns: input.s_sns,
        reconfirm: true,
      });
      return { validation, result };
    },
  } satisfies ToolDef<z.ZodTypeAny>,

  {
    name: "correct_punch",
    description:
      "Add a missed punch (補卡). Manager role can submit directly without approval. " +
      "section: 1=clock-in, 2=clock-out, 3=next-day clock-out.",
    schema: z.object({
      date: isoDate,
      section: z.enum(["1", "2", "3"]),
      hour: z.string().regex(/^\d{2}$/),
      min: z.string().regex(/^\d{2}$/),
      remark: z.string(),
      target_u_sn: z.string().optional(),
    }),
    handler: async (input, ctx) =>
      await ctx.client.addCorrectionPunch({
        u_sn: input.target_u_sn ?? ctx.client.userSn,
        date: input.date,
        section: input.section,
        hour: input.hour,
        min: input.min,
        remark: input.remark,
      }),
  } satisfies ToolDef<z.ZodTypeAny>,
] as const;
