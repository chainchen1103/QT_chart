// Bollinger Bands, RSI, MACD, KD and ATR: what is saved for each, the defaults, the limits, and the check that
// turns whatever was saved into valid settings. Pure: saving and reading is settings/store.ts.

import { findTf } from "../core/timeframes.ts";

/** `tf`: "" = the chart's timeframe, otherwise an OKX bar such as "4H". */
export type BollConf = { on: boolean; tf: string; length: number; mult: number; color: string; fill: boolean };
export type RsiConf = { on: boolean; tf: string; length: number; color: string; upper: number; lower: number };
export type MacdConf = {
  on: boolean; tf: string; fast: number; slow: number; signal: number; macdColor: string; signalColor: string; up: string; down: string;
};
/** TradingView's Stochastic: raw %K over `length` bars, smoothed into K (`smoothK`) and D (`smoothD`). */
export type KdConf = {
  on: boolean; tf: string; length: number; smoothK: number; smoothD: number; kColor: string; dColor: string; upper: number; lower: number;
};
export type AtrConf = { on: boolean; tf: string; length: number; color: string };
export type IndSettings = { boll: BollConf; rsi: RsiConf; macd: MacdConf; kd: KdConf; atr: AtrConf };
export type IndKind = keyof IndSettings;
/** The ones drawn in a pane of their own, top to bottom. */
export const PANE_KINDS = ["rsi", "macd", "kd", "atr"] as const;
export type PaneKind = (typeof PANE_KINDS)[number];

export const IND_LIMITS = {
  length: { min: 1, max: 500 },
  mult: { min: 0.1, max: 10 },
  level: { min: 0, max: 100 },
  smooth: { min: 1, max: 50 },
};

export const DEFAULT_INDS: IndSettings = {
  boll: { on: false, tf: "", length: 20, mult: 2, color: "#2962ff", fill: true },
  rsi: { on: false, tf: "", length: 14, color: "#7e57c2", upper: 70, lower: 30 },
  macd: { on: false, tf: "", fast: 12, slow: 26, signal: 9, macdColor: "#2962ff", signalColor: "#ff6d00", up: "#26a69a", down: "#ef5350" },
  kd: { on: false, tf: "", length: 9, smoothK: 3, smoothD: 3, kColor: "#2962ff", dColor: "#ff6d00", upper: 80, lower: 20 },
  atr: { on: false, tf: "", length: 14, color: "#f06292" },
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isColor = (c: unknown): c is string => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c);
const color = (v: unknown, fallback: string) => (isColor(v) ? v : fallback);
const tf = (v: unknown): string => (typeof v === "string" && findTf(v) ? v : "");
/** A number in [min, max] (rounded when `int`), or the fallback. */
const num = (v: unknown, r: { min: number; max: number }, fallback: number, int = true): number =>
  typeof v === "number" && Number.isFinite(v) && v >= r.min && v <= r.max ? (int ? Math.round(v) : v) : fallback;

/** Valid settings from whatever was saved: each field that is missing or off falls back to its default. */
export function cleanInds(raw: unknown): IndSettings {
  const r = isObj(raw) ? raw : {};
  const part = (k: IndKind) => (isObj(r[k]) ? (r[k] as Record<string, unknown>) : {});
  const L = IND_LIMITS;
  const D = DEFAULT_INDS;
  const b = part("boll");
  const s = part("rsi");
  const m = part("macd");
  const k = part("kd");
  const a = part("atr");
  return {
    boll: {
      on: b.on === true, tf: tf(b.tf), length: num(b.length, L.length, D.boll.length), mult: num(b.mult, L.mult, D.boll.mult, false),
      color: color(b.color, D.boll.color), fill: b.fill !== false,
    },
    rsi: {
      on: s.on === true, tf: tf(s.tf), length: num(s.length, L.length, D.rsi.length), color: color(s.color, D.rsi.color),
      upper: num(s.upper, L.level, D.rsi.upper, false), lower: num(s.lower, L.level, D.rsi.lower, false),
    },
    macd: {
      on: m.on === true, tf: tf(m.tf), fast: num(m.fast, L.length, D.macd.fast), slow: num(m.slow, L.length, D.macd.slow),
      signal: num(m.signal, L.length, D.macd.signal), macdColor: color(m.macdColor, D.macd.macdColor),
      signalColor: color(m.signalColor, D.macd.signalColor), up: color(m.up, D.macd.up), down: color(m.down, D.macd.down),
    },
    kd: {
      on: k.on === true, tf: tf(k.tf), length: num(k.length, L.length, D.kd.length), smoothK: num(k.smoothK, L.smooth, D.kd.smoothK),
      smoothD: num(k.smoothD, L.smooth, D.kd.smoothD), kColor: color(k.kColor, D.kd.kColor), dColor: color(k.dColor, D.kd.dColor),
      upper: num(k.upper, L.level, D.kd.upper, false), lower: num(k.lower, L.level, D.kd.lower, false),
    },
    atr: { on: a.on === true, tf: tf(a.tf), length: num(a.length, L.length, D.atr.length), color: color(a.color, D.atr.color) },
  };
}
