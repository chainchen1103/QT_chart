// Price alerts: what is stored, and the checks that make stored data safe to use. Pure (no DOM, no Tauri).

import type { DrawKind } from "../settings/model.ts";

/** touch: the price reaches the level from either side; up / down: it crosses it in that direction. */
export type LevelCond = "touch" | "up" | "down";
/** A rectangle: the price comes into it, or leaves it. */
export type BoxCond = "enter" | "exit";
/** time: a vertical line's time arrives; trade: a position's entry, then its stop or take-profit. */
export type AlertCond = LevelCond | BoxCond | "time" | "trade";
/** once: switch off after going off; every: stay on, at most once a minute. */
export type Repeat = "once" | "every";
export type TradeStage = "wait" | "open" | "done";

export type AlertTarget = { kind: "price"; price: number } | { kind: "drawing"; id: string };

export type Alert = {
  id: string;
  instId: string;
  target: AlertTarget;
  cond: AlertCond;
  repeat: Repeat;
  /** The chart timeframe it was made on: sloped lines are read at the start of this timeframe's current bar,
   *  which is where the chart draws them. */
  tf: string;
  note: string;
  on: boolean;
  /** UTC seconds. */
  created: number;
  fired: number | null;
  count: number;
  /** Position alerts: where the trade is, and the entry/stop/target that stage belongs to. */
  stage?: TradeStage;
  sig?: string;
};

export type LogEntry = { t: number; instId: string; text: string; note: string; alertId: string };
export type AlertOptions = { sound: boolean; system: boolean };

export const MAX_ALERTS = 200;
export const MAX_LOG = 100;
export const MAX_NOTE = 120;
/** "every": quiet this long after going off. */
export const REARM_SEC = 60;
export const DEFAULT_OPTIONS: AlertOptions = { sound: true, system: true };

export const COND_TEXT: Record<AlertCond, string> = {
  touch: "觸及",
  up: "向上突破",
  down: "向下跌破",
  enter: "進入",
  exit: "離開",
  time: "時間到",
  trade: "進場、止盈、止損",
};
export const REPEAT_TEXT: Record<Repeat, string> = { once: "只提醒一次", every: "每次（最多每分鐘一次）" };

/** The conditions that make sense for a price or a kind of drawing. */
export function condsFor(kind: "price" | DrawKind): AlertCond[] {
  if (kind === "rect") return ["enter", "exit"];
  if (kind === "vline") return ["time"];
  if (kind === "position") return ["trade"];
  return ["touch", "up", "down"];
}

/** Ends after going off once, whatever the repeat setting says. */
export const oneShot = (c: AlertCond) => c === "time" || c === "trade";

// ----------------------------------------------------------------------------- stored data
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const INST = /^[A-Z0-9-]{1,40}$/;
const CONDS = Object.keys(COND_TEXT) as AlertCond[];

export function cleanAlerts(raw: unknown, isTf: (bar: string) => boolean): Alert[] {
  if (!Array.isArray(raw)) return [];
  const out: Alert[] = [];
  const ids = new Set<string>();
  for (const r of raw) {
    if (out.length >= MAX_ALERTS) break;
    if (!isObj(r) || typeof r.id !== "string" || !r.id || ids.has(r.id)) continue;
    if (typeof r.instId !== "string" || !INST.test(r.instId)) continue;
    const t = r.target;
    let target: AlertTarget;
    if (isObj(t) && t.kind === "price" && isNum(t.price) && t.price > 0) target = { kind: "price", price: t.price };
    else if (isObj(t) && t.kind === "drawing" && typeof t.id === "string" && t.id) target = { kind: "drawing", id: t.id };
    else continue;
    const cond = CONDS.find((c) => c === r.cond);
    if (!cond || (target.kind === "price" && !condsFor("price").includes(cond))) continue;
    const a: Alert = {
      id: r.id,
      instId: r.instId,
      target,
      cond,
      repeat: r.repeat === "every" ? "every" : "once",
      tf: typeof r.tf === "string" && isTf(r.tf) ? r.tf : "15m",
      note: typeof r.note === "string" ? r.note.slice(0, MAX_NOTE) : "",
      on: r.on !== false,
      created: isNum(r.created) ? r.created : 0,
      fired: isNum(r.fired) ? r.fired : null,
      count: isNum(r.count) && r.count >= 0 ? Math.floor(r.count) : 0,
    };
    if (cond === "trade") {
      a.stage = r.stage === "open" || r.stage === "done" ? r.stage : "wait";
      if (typeof r.sig === "string") a.sig = r.sig;
    }
    ids.add(a.id);
    out.push(a);
  }
  return out;
}

export function cleanLog(raw: unknown): LogEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: LogEntry[] = [];
  for (const r of raw) {
    if (out.length >= MAX_LOG) break;
    if (!isObj(r) || !isNum(r.t) || typeof r.instId !== "string" || !INST.test(r.instId) || typeof r.text !== "string") continue;
    out.push({
      t: r.t,
      instId: r.instId,
      text: r.text.slice(0, 300),
      note: typeof r.note === "string" ? r.note.slice(0, MAX_NOTE) : "",
      alertId: typeof r.alertId === "string" ? r.alertId : "",
    });
  }
  return out;
}

export function cleanOptions(raw: unknown): AlertOptions {
  const r = isObj(raw) ? raw : {};
  return { sound: r.sound !== false, system: r.system !== false };
}
