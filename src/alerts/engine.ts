// Price alerts: when one goes off. Pure functions (no DOM, no Tauri), unit-tested in tests/alerts.test.ts.
//
// Prices arrive as snapshots of the current 1-minute bar. Between two snapshots the price passed through every
// level from the old close to the new one, and through any new high or low the bar made in between (prices
// move continuously), so a level counts as touched when it lies in that range: nothing is missed between
// updates. Drawings are read where the chart draws them: sloped lines at the start of the current bar of the
// timeframe the alert was made on, continued past their last point (as TradingView does); rectangles and Fib
// levels from their left edge on, whatever their width; positions from their entry time on.

import { fibPrice, fmtLevel, positionDir, rewardRisk, type Anchor } from "../drawings/geometry.ts";
import type { Drawing, DrawKind, FibSettings } from "../settings/model.ts";
import { tfSec } from "../core/timeframes.ts";
import { oneShot, REARM_SEC, type Alert, type BoxCond, type LevelCond, type TradeStage } from "./model.ts";

export type Snapshot = { time: number; high: number; low: number; close: number };
/** The range the price covered since the previous snapshot; `from` is null the first time (no side known). */
export type Move = { from: number | null; lo: number; hi: number; price: number };

/** What the price did since `prev`; null for a stale snapshot (an older bar). */
export function moveSince(prev: Snapshot | null, c: Snapshot): Move | null {
  if (!prev) return { from: null, lo: c.close, hi: c.close, price: c.close };
  if (c.time < prev.time) return null;
  let lo = Math.min(prev.close, c.close);
  let hi = Math.max(prev.close, c.close);
  if (c.time > prev.time) {
    // a new bar: everything it traded so far came after the old close
    lo = Math.min(lo, c.low);
    hi = Math.max(hi, c.high);
  } else {
    if (c.low < prev.low) lo = Math.min(lo, c.low);
    if (c.high > prev.high) hi = Math.max(hi, c.high);
  }
  return { from: prev.close, lo, hi, price: c.close };
}

const WEEK = 604800;
const MONDAY = 4 * 86400; // 1970-01-05 was a Monday: weekly bars start on Mondays (UTC)

/** Start of the bar of `sec` seconds that holds time t. */
export function barStart(t: number, sec: number): number {
  if (!(sec > 0)) return t;
  const off = sec === WEEK ? MONDAY : 0;
  return Math.floor((t - off) / sec) * sec + off;
}

export type Level = { name: string; price: number };
/** What an alert watches at a moment: price levels, a price zone, a time, or a trade. */
export type Shape =
  | { type: "levels"; levels: Level[] }
  | { type: "box"; top: number; bottom: number }
  | { type: "time"; t: number }
  | { type: "trade"; entry: number; stop: number; target: number };

const lineAt = (a: Anchor, b: Anchor, t: number) => a.p + ((b.p - a.p) * (t - a.t)) / (b.t - a.t);

/**
 * A drawing as an alert sees it at time `now` (UTC seconds), for an alert made on timeframe `tf`. null when it
 * isn't there: starts later, a ray pointing left, a line standing straight up, a Fib with every level off.
 */
export function shapeAt(d: Drawing, now: number, tf: string, fib: FibSettings, name: (k: DrawKind) => string): Shape | null {
  const t = barStart(now, tfSec(tf));
  const first = Math.min(d.a.t, d.b.t);
  const one = (price: number): Shape => ({ type: "levels", levels: [{ name: name(d.kind), price }] });
  switch (d.kind) {
    case "hline":
    case "cross":
      return one(d.a.p);
    case "hray":
      return now >= d.a.t ? one(d.a.p) : null;
    case "vline":
      return { type: "time", t: d.a.t };
    case "trend":
    case "info":
    case "angle":
      return d.a.t === d.b.t || now < first ? null : one(lineAt(d.a, d.b, t));
    case "ray":
      return d.b.t <= d.a.t || now < d.a.t ? null : one(lineAt(d.a, d.b, t));
    case "extended":
      return d.a.t === d.b.t ? null : one(lineAt(d.a, d.b, t));
    case "rect":
      return now < first ? null : { type: "box", top: Math.max(d.a.p, d.b.p), bottom: Math.min(d.a.p, d.b.p) };
    case "fib": {
      if (now < first) return null;
      const levels = fib.levels
        .filter((l) => l.on)
        .map((l) => ({ name: `Fib ${fmtLevel(l.value)}`, price: fibPrice(d.a, d.b, l.value, fib.reverse) }));
      return levels.length ? { type: "levels", levels } : null;
    }
    case "position":
      return now < d.a.t ? null : { type: "trade", entry: d.a.p, stop: d.b.p, target: d.target };
  }
}

/** What an alert watches now; "gone" when its drawing was deleted. */
export function targetShape(
  a: Alert, find: (id: string) => Drawing | undefined, now: number, fib: FibSettings, name: (k: DrawKind) => string,
): Shape | null | "gone" {
  if (a.target.kind === "price") return { type: "levels", levels: [{ name: "", price: a.target.price }] };
  const d = find(a.target.id);
  return d ? shapeAt(d, now, a.tf, fib, name) : "gone";
}

export type AlertEvent =
  | { type: "level"; cond: LevelCond; name: string; price: number }
  | { type: "box"; cond: BoxCond; top: number; bottom: number }
  | { type: "time"; t: number }
  | { type: "entry"; price: number }
  | { type: "exit"; how: "stop" | "target"; price: number; r: number };

export type Outcome = { events: AlertEvent[]; stage?: TradeStage };
const NONE: Outcome = { events: [] };
const inRange = (p: number, m: Move) => m.lo <= p && p <= m.hi;

export function levelHit(level: number, cond: LevelCond, m: Move): boolean {
  if (m.from == null) return false;
  if (cond === "up") return m.from < level && m.hi >= level;
  if (cond === "down") return m.from > level && m.lo <= level;
  return inRange(level, m);
}

/** What one alert does on one move at time `now` (UTC seconds). */
export function evaluate(a: Alert, shape: Shape | null, m: Move, now: number): Outcome {
  if (!a.on || !shape) return NONE;
  if (a.repeat === "every" && !oneShot(a.cond) && a.fired != null && now - a.fired < REARM_SEC) return NONE;
  switch (shape.type) {
    case "levels": {
      const cond = a.cond;
      if (cond !== "touch" && cond !== "up" && cond !== "down") return NONE;
      const events: AlertEvent[] = shape.levels
        .filter((l) => levelHit(l.price, cond, m))
        .map((l) => ({ type: "level", cond, name: l.name, price: l.price }));
      return { events };
    }
    case "box": {
      const cond = a.cond;
      if (m.from == null || (cond !== "enter" && cond !== "exit")) return NONE;
      const was = m.from >= shape.bottom && m.from <= shape.top;
      const hit = cond === "enter" ? !was && m.hi >= shape.bottom && m.lo <= shape.top : was && (m.lo < shape.bottom || m.hi > shape.top);
      return hit ? { events: [{ type: "box", cond, top: shape.top, bottom: shape.bottom }] } : NONE;
    }
    case "time":
      // only a time still ahead when the alert was made
      return a.cond === "time" && now >= shape.t && a.created < shape.t ? { events: [{ type: "time", t: shape.t }] } : NONE;
    case "trade":
      return a.cond === "trade" ? tradeStep(a.stage ?? "wait", shape, m) : NONE;
  }
}

/**
 * A position: the entry first, then whichever of stop and take-profit the price reaches first; the stop when
 * one move reaches both (the worse case, as the chart's settlement does). In the move that fills the entry the
 * stop counts only when the price came from the take-profit side, so it went through the entry to the stop.
 */
export function tradeStep(stage: TradeStage, s: { entry: number; stop: number; target: number }, m: Move): Outcome {
  if (stage === "done" || m.from == null) return NONE;
  const stopOut = (): AlertEvent => ({ type: "exit", how: "stop", price: s.stop, r: -1 });
  if (stage === "wait") {
    if (!inRange(s.entry, m)) return NONE;
    const dir = positionDir(s.entry, s.stop);
    const cameFromProfitSide = dir === 1 ? m.from >= s.entry : m.from <= s.entry;
    if (cameFromProfitSide && inRange(s.stop, m)) return { events: [{ type: "entry", price: s.entry }, stopOut()], stage: "done" };
    return { events: [{ type: "entry", price: s.entry }], stage: "open" };
  }
  if (inRange(s.stop, m)) return { events: [stopOut()], stage: "done" };
  if (inRange(s.target, m)) {
    return { events: [{ type: "exit", how: "target", price: s.target, r: rewardRisk(s.entry, s.stop, s.target) }], stage: "done" };
  }
  return NONE;
}

/** Entry, stop and take-profit as one string: when they change, a position alert starts over. */
export const tradeSig = (s: { entry: number; stop: number; target: number }) => `${s.entry}|${s.stop}|${s.target}`;

/** One line for an event, e.g. "向上突破 78,500.0", "碰到趨勢線（77,950.2）", "倉位止盈（78,482.8，+2.50R）". */
export function describe(e: AlertEvent, fmt: (p: number) => string, fmtTime: (t: number) => string): string {
  switch (e.type) {
    case "level": {
      const verb = e.cond === "up" ? "向上突破" : e.cond === "down" ? "向下跌破" : e.name ? "碰到" : "觸及";
      return e.name ? `${verb}${e.name}（${fmt(e.price)}）` : `${verb} ${fmt(e.price)}`;
    }
    case "box":
      return `${e.cond === "enter" ? "進入" : "離開"}矩形（${fmt(e.bottom)}～${fmt(e.top)}）`;
    case "time":
      return `到了垂直線的時間（${fmtTime(e.t)}）`;
    case "entry":
      return `倉位進場（${fmt(e.price)}）`;
    case "exit":
      return e.how === "stop" ? `倉位止損（${fmt(e.price)}，−1R）` : `倉位止盈（${fmt(e.price)}，+${e.r.toFixed(2)}R）`;
  }
}
