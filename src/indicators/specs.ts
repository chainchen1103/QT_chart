// An indicator as an alert or an AI app names it: its kind and numbers ("RSI 14", "MACD 12 26 9"), its lines,
// their values on a list of bars, and how many bars before those it needs. Pure (no DOM, no chart).

import type { Candle } from "../core/api.ts";
import { MA_KINDS, MA_LEN, type MaConf, type MaKind } from "../settings/model.ts";
import { IND_LIMITS, type IndKind, type IndSettings } from "../settings/indicators.ts";
import { movingAverage, warmupBars } from "./ma.ts";
import { atr, bollinger, kd, macd, rsi, warmup, type Num } from "./osc.ts";

export type IndSpec =
  | { type: "rsi"; length: number }
  | { type: "macd"; fast: number; slow: number; signal: number }
  | { type: "kd"; length: number; smoothK: number; smoothD: number }
  | { type: "atr"; length: number }
  | { type: "boll"; length: number; mult: number }
  | { type: "ma"; kind: MaKind; length: number };
export type IndType = IndSpec["type"];
export const IND_TYPES: IndType[] = ["rsi", "macd", "kd", "atr", "boll", "ma"];

/** Each kind's lines (key, name); the first is the main one. */
export const LINES: Record<IndType, { key: string; name: string }[]> = {
  rsi: [{ key: "rsi", name: "RSI" }],
  macd: [{ key: "macd", name: "MACD" }, { key: "signal", name: "訊號線" }, { key: "hist", name: "柱狀體" }],
  kd: [{ key: "k", name: "K" }, { key: "d", name: "D" }],
  atr: [{ key: "atr", name: "ATR" }],
  boll: [{ key: "upper", name: "上軌" }, { key: "basis", name: "中軌" }, { key: "lower", name: "下軌" }],
  ma: [{ key: "ma", name: "均線" }],
};

/** Drawn on the prices: an alert compares the price with its lines. The others are compared with a number or
 *  with another of their own lines. */
export const onPrices = (t: IndType) => t === "boll" || t === "ma";
export const hasLine = (t: IndType, key: string) => LINES[t].some((l) => l.key === key);

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
  }
}

/** A line as a sentence names it: "RSI", "MACD", "訊號線", "K", "布林上軌", "EMA20". */
export function lineName(s: IndSpec, key: string): string {
  if (s.type === "ma") return `${s.kind}${s.length}`;
  const name = LINES[s.type].find((l) => l.key === key)?.name ?? key;
  return s.type === "boll" ? `布林${name}` : name;
}

/** Every line's values on `bars`, one per bar. */
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
/** The same indicator with the same numbers (specs are always built with their fields in one order). */
export const sameSpec = (a: IndSpec, b: IndSpec) => JSON.stringify(a) === JSON.stringify(b);

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
  }
  return null;
}

/** A value of an indicator for text: RSI and KD with 2 decimals, the rest with 4 significant digits (MACD of a
 *  coin worth cents is tiny), or as a price when it is one (`fmtPrice`). */
export function fmtValue(s: IndSpec, v: number, fmtPrice: (p: number) => string): string {
  if (s.type === "rsi" || s.type === "kd") return v.toFixed(2);
  if (onPrices(s.type)) return fmtPrice(v);
  return fmtSig(v);
}
export function fmtSig(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (a >= 1) return v.toFixed(2);
  if (a === 0) return "0";
  return Number(v.toPrecision(4)).toString();
}
