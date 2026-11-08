// An indicator as an alert or an AI app names it: its kind and numbers ("RSI 14", "MACD 12 26 9"), its lines,
// their values on a list of bars, and how many bars before those it needs. A Pine script is one too: named by
// its id, with its title and plots as they were when the alert was made (it runs as the script is now). Pure
// (no DOM, no chart).

import type { Candle } from "../core/api.ts";
import { MA_KINDS, MA_LEN, type MaConf, type MaKind } from "../settings/model.ts";
import { IND_LIMITS, type IndKind, type IndSettings } from "../settings/indicators.ts";
import { movingAverage, warmupBars } from "./ma.ts";
import { atr, bollinger, kd, macd, rsi, warmup, type Num } from "./osc.ts";

/** A line of an indicator: its key, and its name in sentences. */
export type IndLine = { key: string; name: string };
/** A Pine script: `overlay` when it draws on the prices (then alerts compare the price with its plots). */
export type PineSpec = { type: "pine"; id: string; name: string; overlay: boolean; lines: IndLine[] };
export type IndSpec =
  | { type: "rsi"; length: number }
  | { type: "macd"; fast: number; slow: number; signal: number }
  | { type: "kd"; length: number; smoothK: number; smoothD: number }
  | { type: "atr"; length: number }
  | { type: "boll"; length: number; mult: number }
  | { type: "ma"; kind: MaKind; length: number }
  | PineSpec;
export type IndType = IndSpec["type"];
export type BuiltinType = Exclude<IndType, "pine">;
export const IND_TYPES: BuiltinType[] = ["rsi", "macd", "kd", "atr", "boll", "ma"];
/** Bars a Pine script runs on for an alert (it may need any number: enough for the usual ones). */
export const PINE_BARS = 600;
const MAX_PINE_LINES = 64;

/** Each built-in kind's lines (key, name); the first is the main one. */
export const LINES: Record<BuiltinType, IndLine[]> = {
  rsi: [{ key: "rsi", name: "RSI" }],
  macd: [{ key: "macd", name: "MACD" }, { key: "signal", name: "訊號線" }, { key: "hist", name: "柱狀體" }],
  kd: [{ key: "k", name: "K" }, { key: "d", name: "D" }],
  atr: [{ key: "atr", name: "ATR" }],
  boll: [{ key: "upper", name: "上軌" }, { key: "basis", name: "中軌" }, { key: "lower", name: "下軌" }],
  ma: [{ key: "ma", name: "均線" }],
};

/** An indicator's lines: a Pine script's plots, as they were when the alert was made. */
export const linesOf = (s: IndSpec): IndLine[] => (s.type === "pine" ? s.lines : LINES[s.type]);
/** Drawn on the prices: an alert compares the price with its lines. The others are compared with a number or
 *  with another of their own lines. */
export const onPrices = (s: IndSpec) => (s.type === "pine" ? s.overlay : s.type === "boll" || s.type === "ma");
export const hasLine = (s: IndSpec, key: string) => linesOf(s).some((l) => l.key === key);

/** "RSI 14", "MACD 12 26 9", "KD 9 3 3", "ATR 14", "布林 20 2", "EMA20". */
export function specName(s: IndSpec): string {
  switch (s.type) {
    case "rsi":
      return `RSI ${s.length}`;
    case "macd":
      return `MACD ${s.fast} ${s.slow} ${s.signal}`;
    case "kd":
      return `KD ${s.length} ${s.smoothK} ${s.smoothD}`;
    case "atr":
      return `ATR ${s.length}`;
    case "boll":
      return `布林 ${s.length} ${s.mult}`;
    case "ma":
      return `${s.kind}${s.length}`;
    case "pine":
      return s.name;
  }
}

/** A line as a sentence names it: "RSI", "MACD", "訊號線", "K", "布林上軌", "EMA20". */
export function lineName(s: IndSpec, key: string): string {
  if (s.type === "ma") return `${s.kind}${s.length}`;
  const name = linesOf(s).find((l) => l.key === key)?.name ?? key;
  return s.type === "boll" ? `布林${name}` : name;
}

/** Every line's values on `bars`, one per bar (a Pine script's come from running it: none here). */
export function computeLines(s: IndSpec, bars: readonly Candle[]): Record<string, Num[]> {
  const closes = bars.map((b) => b.close);
  switch (s.type) {
    case "rsi":
      return { rsi: rsi(closes, s.length) };
    case "macd":
      return macd(closes, s.fast, s.slow, s.signal);
    case "kd":
      return kd(bars, s.length, s.smoothK, s.smoothD);
    case "atr":
      return { atr: atr(bars, s.length) };
    case "boll":
      return bollinger(closes, s.length, s.mult);
    case "ma":
      return { ma: movingAverage(s.kind, s.length, closes) };
    case "pine":
      return {};
  }
}

/** Bars needed before the first one whose values must be right. */
export function warmupOf(s: IndSpec): number {
  switch (s.type) {
    case "rsi":
      return warmup.rsi(s.length);
    case "macd":
      return warmup.macd(s.fast, s.slow, s.signal);
    case "kd":
      return warmup.kd(s.length, s.smoothK, s.smoothD);
    case "atr":
      return warmup.atr(s.length);
    case "boll":
      return warmup.boll(s.length);
    case "ma":
      return warmupBars(s.kind, s.length);
    case "pine":
      return PINE_BARS;
  }
}

/** The indicator as set now. */
export function specFor(kind: IndKind, set: IndSettings): IndSpec {
  switch (kind) {
    case "rsi":
      return { type: "rsi", length: set.rsi.length };
    case "macd":
      return { type: "macd", fast: set.macd.fast, slow: set.macd.slow, signal: set.macd.signal };
    case "kd":
      return { type: "kd", length: set.kd.length, smoothK: set.kd.smoothK, smoothD: set.kd.smoothD };
    case "atr":
      return { type: "atr", length: set.atr.length };
    case "boll":
      return { type: "boll", length: set.boll.length, mult: set.boll.mult };
  }
}
export const maSpec = (m: MaConf): IndSpec => ({ type: "ma", kind: m.kind, length: m.length });
/** The same indicator with the same numbers (specs are always built with their fields in one order); the same
 *  Pine script, whatever its plots were called then. */
export function sameSpec(a: IndSpec, b: IndSpec): boolean {
  if (a.type === "pine" || b.type === "pine") return a.type === "pine" && b.type === "pine" && a.id === b.id;
  return JSON.stringify(a) === JSON.stringify(b);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const int = (v: unknown, r: { min: number; max: number }): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= r.min && v <= r.max ? v : null;

/** A valid spec from saved data or an AI app, with its fields in a fixed order; null when it isn't one. */
export function cleanSpec(raw: unknown): IndSpec | null {
  if (!isObj(raw)) return null;
  const L = IND_LIMITS.length;
  switch (raw.type) {
    case "rsi":
    case "atr": {
      const length = int(raw.length, L);
      return length == null ? null : { type: raw.type, length };
    }
    case "macd": {
      const fast = int(raw.fast, L);
      const slow = int(raw.slow, L);
      const signal = int(raw.signal, L);
      return fast == null || slow == null || signal == null ? null : { type: "macd", fast, slow, signal };
    }
    case "kd": {
      const length = int(raw.length, L);
      const smoothK = int(raw.smoothK, IND_LIMITS.smooth);
      const smoothD = int(raw.smoothD, IND_LIMITS.smooth);
      return length == null || smoothK == null || smoothD == null ? null : { type: "kd", length, smoothK, smoothD };
    }
    case "boll": {
      const length = int(raw.length, L);
      const m = raw.mult;
      const ok = typeof m === "number" && Number.isFinite(m) && m >= IND_LIMITS.mult.min && m <= IND_LIMITS.mult.max;
      return length == null || !ok ? null : { type: "boll", length, mult: m as number };
    }
    case "ma": {
      const kind = MA_KINDS.find((k) => k === raw.kind);
      const length = int(raw.length, MA_LEN);
      return !kind || length == null ? null : { type: "ma", kind, length };
    }
    case "pine": {
      const text = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
      const id = text(raw.id, 80);
      const name = text(raw.name, 80);
      if (!id || !name || typeof raw.overlay !== "boolean" || !Array.isArray(raw.lines)) return null;
      const lines: IndLine[] = [];
      for (const l of raw.lines.slice(0, MAX_PINE_LINES)) {
        const key = isObj(l) ? text(l.key, 120) : null;
        const lname = isObj(l) ? text(l.name, 120) : null;
        if (!key || !lname || lines.some((x) => x.key === key)) return null;
        lines.push({ key, name: lname });
      }
      return lines.length ? { type: "pine", id, name, overlay: raw.overlay, lines } : null;
    }
  }
  return null;
}

/** A value of an indicator for text: RSI and KD with 2 decimals, the rest with 4 significant digits (MACD of a
 *  coin worth cents is tiny), or as a price when it is one (`fmtPrice`). */
export function fmtValue(s: IndSpec, v: number, fmtPrice: (p: number) => string): string {
  if (s.type === "rsi" || s.type === "kd") return v.toFixed(2);
  if (onPrices(s)) return fmtPrice(v);
  return fmtSig(v);
}
export function fmtSig(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (a >= 1) return v.toFixed(2);
  if (a === 0) return "0";
  return Number(v.toPrecision(4)).toString();
}
