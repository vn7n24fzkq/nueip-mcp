#!/usr/bin/env node
// Punch bot: plans today's clock-in/out from NUEiP, asks on Telegram, and
// punches only after an explicit button press. All rules live in plan.ts;
// this file is I/O (Telegram, NUEiP, state file) plus the schedule loop.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { NueipClient } from "./client.js";
import { summarizeAttendance, summarizeLeaves } from "./format.js";
import {
  actualClockIn, allowed, alreadyPunched, clockInSlot, clockOutSlot, dayOf, fmt,
  taipei, workSpan, type Place, type Slot, type Span,
} from "./plan.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const TOKEN = need("TELEGRAM_BOT_TOKEN");
const CHAT_ID = Number(need("TELEGRAM_CHAT_ID"));
const DRY_RUN = process.env.PUNCH_DRY_RUN === "1";
const STATE_PATH = join(process.env.STATE_DIRECTORY ?? ".", "punch-bot-state.json");

const PLAN_AT = 7 * 60 + 30;
const ASK_BEFORE = 20;
const OUT_PLAN_BEFORE = 60; // read the actual clock-in an hour before the span ends
const MISSED_GRACE = 10; // approved, but we're this late (bot was down) → don't punch

const PLACE_LABEL: Record<Place, string> = { home: "🏠 家", office: "🏢 公司" };
const KIND_LABEL = { in: "上班卡", out: "下班卡" } as const;
const WEEKDAYS = "日一二三四五六";

type Status = "planned" | "asked" | "approved" | "punching" | "done" | "declined" | "expired" | "failed";
interface Item extends Slot { askAt: number; status: Status; messageId?: number; chosen?: Place }
interface State { date: string; offset: number; planned: boolean; span: Span | null; outPlanned: boolean; items: Item[] }
interface CallbackQuery { id: string; from?: { id: number }; data?: string }
interface Update { update_id: number; callback_query?: CallbackQuery }

const config = loadConfig();
const client = new NueipClient(config);
const coords = (p: Place) => {
  const preset = config.presets.find(x => x.name === p);
  if (!preset) throw new Error(`location preset "${p}" missing from NUEIP_PRESETS_PATH`);
  return preset;
};
coords("home"); coords("office"); // fail fast at startup, not at 08:50

const state: State = (() => {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as State; }
  catch { return { date: "", offset: 0, planned: false, span: null, outPlanned: false, items: [] }; }
})();
function save(): void {
  writeFileSync(`${STATE_PATH}.tmp`, JSON.stringify(state));
  renameSync(`${STATE_PATH}.tmp`, STATE_PATH);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// api.telegram.org is ~330ms TCP-connect away from Taiwan, past Node's 250ms
// Happy Eyeballs per-attempt timeout → every fetch fails with ETIMEDOUT.
setDefaultAutoSelectFamilyAttemptTimeout(1000);

// ── Telegram ────────────────────────────────────────────────────────────

async function tg<T>(method: string, body: object): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json() as { ok: boolean; result: T; description?: string };
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description}`);
  return j.result;
}

const send = (text: string, buttons?: { text: string; callback_data: string }[]) =>
  tg<{ message_id: number }>("sendMessage", {
    chat_id: CHAT_ID, text, ...(buttons && { reply_markup: { inline_keyboard: [buttons] } }),
  });

function header(it: Item): string {
  const wd = WEEKDAYS[new Date(`${state.date}T12:00:00Z`).getUTCDay()];
  return `${DRY_RUN ? "🧪 " : ""}⏰ ${KIND_LABEL[it.kind]}\n日期：${state.date}（${wd}）\n` +
    `時間：${fmt(it.at)}\n建議地點：${PLACE_LABEL[it.place]}`;
}

// Replace the question (and its buttons) with the outcome.
async function resolve(it: Item, outcome: string): Promise<void> {
  const text = `${header(it)}\n\n${outcome}`;
  if (it.messageId) await tg("editMessageText", { chat_id: CHAT_ID, message_id: it.messageId, text });
  else await send(text);
}

// ── NUEiP ───────────────────────────────────────────────────────────────

async function attendance(date: string) {
  return dayOf(summarizeAttendance(await client.listAttendance({ startDate: date, endDate: date })), date);
}

async function leaves(date: string) {
  // Look back two weeks so a multi-day leave that started earlier is included.
  const from = new Date(Date.parse(date) - 14 * 86400_000).toISOString().slice(0, 10);
  return summarizeLeaves(await client.listLeaves({ startDate: from, endDate: date })).records;
}

async function punch(it: Item, now: number): Promise<string> {
  it.status = "failed"; // anything short of the final line below is a non-punch
  if (now > it.at + MISSED_GRACE) return "⌛ 錯過預定時間，未打卡";
  const day = await attendance(state.date);
  if (alreadyPunched(day, it.kind)) {
    it.status = "done";
    return "ℹ️ NUEiP 已有這張卡的紀錄，未重複打卡";
  }
  if (!state.span || !allowed(it.kind, now, state.span, actualClockIn(day)))
    return `🛑 ${fmt(now)} 不在允許的打卡時間內，未打卡`;
  const place = it.chosen ?? it.place;
  if (!DRY_RUN) {
    const { lat, lng } = coords(place);
    await client.punch({ section: it.kind === "in" ? "clockin" : "clockout", lat, lng });
  }
  it.status = "done";
  return `✅ 已打卡 ${fmt(now)} @ ${PLACE_LABEL[place]}${DRY_RUN ? "（DRY RUN，未實際送出）" : ""}`;
}

// ── Schedule ────────────────────────────────────────────────────────────

function add(slot: Slot, now: number): void {
  // Started late (e.g. bot restarted)? Still ask, just not in the past.
  const at = Math.max(slot.at, now + ASK_BEFORE);
  state.items.push({ ...slot, at, askAt: at - ASK_BEFORE, status: "planned" });
}

async function tick(): Promise<void> {
  const { date, min: now } = taipei(Date.now());
  if (state.date !== date) Object.assign(state, { date, planned: false, span: null, outPlanned: false, items: [] });

  if (!state.planned && now >= PLAN_AT) {
    state.span = workSpan(date, await attendance(date), await leaves(date));
    state.planned = true; // only after both fetches succeeded; errors retry next tick
    if (state.span) add(clockInSlot(state.span, Math.random), now);
  }

  if (state.span && !state.outPlanned && now >= state.span.end - OUT_PLAN_BEFORE) {
    const actualIn = actualClockIn(await attendance(date));
    state.outPlanned = true;
    if (actualIn !== null) add(clockOutSlot(date, state.span, actualIn, Math.random), now);
    else if (!state.items.some(i => i.kind === "in" && i.status === "declined"))
      await send(`⚠️ ${date} 沒有上班卡紀錄，今天不排下班卡`);
  }

  for (const it of state.items) {
    if (it.status === "planned" && now >= it.askAt) {
      it.status = "asked";
      const btn = (text: string, choice: string) => ({ text, callback_data: `${date}|${it.kind}|${choice}` });
      it.messageId = (await send(header(it), [
        btn(PLACE_LABEL.home, "home"), btn(PLACE_LABEL.office, "office"), btn("❌ 否", "no"),
      ])).message_id;
    } else if (it.status === "asked" && now >= it.at) {
      it.status = "expired";
      await resolve(it, "⌛ 未確認，已取消");
    } else if (it.status === "approved" && now >= it.at) {
      it.status = "punching"; // persisted: a crash mid-punch never retries (no double punch)
      let outcome: string;
      try { outcome = await punch(it, now); }
      catch (e) { it.status = "failed"; outcome = `❌ 打卡失敗：${e instanceof Error ? e.message : e}`; }
      await resolve(it, outcome);
    }
  }
}

async function onCallback(q: CallbackQuery): Promise<void> {
  const answer = (text: string) => tg("answerCallbackQuery", { callback_query_id: q.id, text });
  if (q.from?.id !== CHAT_ID) return void await answer("無權限");
  const [date, kind, choice] = (q.data ?? "").split("|");
  const it = state.items.find(i => date === state.date && i.kind === kind && i.status === "asked");
  if (!it || !["home", "office", "no"].includes(choice ?? "")) return void await answer("這張卡已經失效");

  if (choice === "no") {
    it.status = "declined";
    await resolve(it, "❌ 已取消（你選了否）");
  } else {
    it.status = "approved";
    it.chosen = choice as Place;
    await resolve(it, `👍 已確認，${fmt(it.at)} 在 ${PLACE_LABEL[it.chosen]} 打${KIND_LABEL[it.kind]}`);
  }
  save();
  await answer("收到");
}

// ── Main ────────────────────────────────────────────────────────────────

async function pollLoop(): Promise<never> {
  for (;;) {
    try {
      const updates = await tg<Update[]>("getUpdates", {
        offset: state.offset, timeout: 50, allowed_updates: ["callback_query"],
      });
      for (const u of updates) {
        state.offset = u.update_id + 1;
        if (u.callback_query) await onCallback(u.callback_query);
      }
      save();
    } catch (e) {
      console.error("poll:", e);
      await sleep(5000);
    }
  }
}

async function tickLoop(): Promise<never> {
  let lastError = "";
  for (;;) {
    try {
      await tick();
      lastError = "";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("tick:", e);
      if (msg !== lastError) { // notify once per distinct error, not every 30s
        lastError = msg;
        await send(`⚠️ 打卡 bot 錯誤（未打卡）：${msg}`).catch(() => {});
      }
    }
    save();
    await sleep(30_000);
  }
}

console.log(`punch-bot started${DRY_RUN ? " (DRY RUN)" : ""}, state ${STATE_PATH}`);
void pollLoop();
void tickLoop();
