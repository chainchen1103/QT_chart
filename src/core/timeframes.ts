// Timeframes, and how a series from one timeframe is laid onto the bars of another.
// Pure functions (no DOM), unit-tested in tests/timeframes.test.ts.

import type { Candle } from "./api.ts";

export type Tf = { bar: string; label: string; sec: number };

/**
 * Timeframe names: a count and a unit — "10s", "15m", "3H", "6Hutc", "1Dutc", "2Wutc" (OKX's names where OKX
 * has the bar; from 6 hours up on UTC boundaries, weeks from Monday). OKX's own bars are loaded as they are,
 * any other length is put together from the largest OKX bar that divides it (src-tauri/src/bars.rs, which
 * this mirrors: the same units, limits and parts).
 */
type Unit = { sec: number; max: number; parts: string[]; label: (n: number) => string };
const OKX_SEC: Record<string, number> = {
  "1s": 1, "5s": 5, "15s": 15, "30s": 30, "1m": 60, "2m": 120, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
  "1H": 3600, "2H": 7200, "4H": 14400, "6Hutc": 21600, "12Hutc": 43200, "1Dutc": 86400, "2Dutc": 172800,
  "3Dutc": 259200, "5Dutc": 432000, "1Wutc": 604800,
};
const HOURS: Unit = { sec: 3600, max: 23, parts: ["12Hutc", "6Hutc", "4H", "2H", "1H"], label: (n) => `${n}時` };
const UNITS: Record<string, Unit> = {
  s: { sec: 1, max: 59, parts: ["30s", "15s", "5s", "1s"], label: (n) => `${n}秒` },
  m: { sec: 60, max: 1439, parts: ["4H", "2H", "1H", "30m", "15m", "5m", "3m", "2m", "1m"], label: (n) => `${n}分` },
  H: HOURS,
  Hutc: HOURS,
  Dutc: { sec: 86400, max: 90, parts: ["1Dutc"], label: (n) => (n === 1 ? "日" : `${n}日`) },
  Wutc: { sec: 604800, max: 12, parts: ["1Wutc"], label: (n) => (n === 1 ? "週" : `${n}週`) },
};
/** At most this many OKX bars make one bar. */
const MAX_PARTS = 240;
/** OKX's 6- and 12-hour bars on Hong Kong boundaries (offered before the UTC ones; saved charts may use them). */
const LEGACY: Record<string, Tf> = {
  "6H": { bar: "6H", label: "6時", sec: 21600 },
  "12H": { bar: "12H", label: "12時", sec: 43200 },
};

/** The timeframe a name stands for, or undefined when the app can't show it. */
export function findTf(bar: string): Tf | undefined {
  if (LEGACY[bar]) return LEGACY[bar];
  const m = /^([1-9]\d{0,3})(s|m|H|Hutc|Dutc|Wutc)$/.exec(bar);
  if (!m) return undefined;
  const n = Number(m[1]);
  const u = UNITS[m[2]];
  if (n > u.max) return undefined;
  const sec = n * u.sec;
  if (!OKX_SEC[bar]) {
    const part = u.parts.find((p) => sec % OKX_SEC[p] === 0);
    if (!part || sec / OKX_SEC[part] > MAX_PARTS) return undefined;
  }
  return { bar, label: u.label(n), sec };
}
export const tfSec = (bar: string): number => findTf(bar)?.sec ?? 0;
export const tfLabel = (bar: string): string => findTf(bar)?.label ?? bar;

export type TfUnit = "s" | "m" | "H" | "D" | "W";
export const TF_UNITS: { unit: TfUnit; label: string }[] = [
  { unit: "s", label: "秒" },
  { unit: "m", label: "分" },
  { unit: "H", label: "時" },
  { unit: "D", label: "日" },
  { unit: "W", label: "週" },
];

/** The one name of `n` of a unit ("90分" is "90m", "120分" is "2H", "24時" is "日", "14日" is "2週"),
 *  or null when the app can't show it. */
export function tfName(n: number, unit: TfUnit): string | null {
  if (!Number.isInteger(n) || n < 1) return null;
  return barForSec(n * { s: 1, m: 60, H: 3600, D: 86400, W: 604800 }[unit]);
}

/** The name of a timeframe `sec` seconds long, or null when the app can't show it. */
export function barForSec(sec: number): string | null {
  let bar: string;
  if (sec % 604800 === 0) bar = `${sec / 604800}Wutc`;
  else if (sec % 86400 === 0) bar = `${sec / 86400}Dutc`;
  else if (sec % 3600 === 0) bar = sec === 21600 || sec === 43200 ? `${sec / 3600}Hutc` : `${sec / 3600}H`;
  else if (sec % 60 === 0) bar = `${sec / 60}m`;
  else bar = `${sec}s`;
  return findTf(bar) ? bar : null;
}

/** Every timeframe the picker offers by name, in groups. Others can be added by count and unit. */
export const TF_GROUPS: { name: string; bars: string[] }[] = [
  { name: "秒", bars: ["1s", "5s", "10s", "15s", "30s", "45s"] },
  { name: "分鐘", bars: ["1m", "2m", "3m", "5m", "10m", "15m", "30m", "45m"] },
  { name: "小時", bars: ["1H", "2H", "3H", "4H", "6Hutc", "8H", "12Hutc"] },
  { name: "日和週", bars: ["1Dutc", "2Dutc", "3Dutc", "1Wutc"] },
];
/** The ones on the toolbar until the user picks others. */
export const DEFAULT_TF_BAR = ["1m", "5m", "15m", "1H", "4H", "1Dutc", "1Wutc"];

/** Every named timeframe (the picker's, in order). */
export const TIMEFRAMES: Tf[] = TF_GROUPS.flatMap((g) => g.bars.map((b) => findTf(b)!));

/**
 * Values computed on `src` bars (one value per bar), placed on each chart bar.
 * - waitClose false (and the chart's own timeframe): the source bar that contains the chart bar; the newest
 *   one moves with price.
 * - waitClose true: the newest source bar that had closed by the end of the chart bar, so history never
 *   repaints and the line only steps when a source bar closes (TradingView's "wait for timeframe closes").
 */
export function alignToChart(
  chartTimes: ArrayLike<number>,
  chartSec: number,
  src: ArrayLike<{ time: number; confirmed: boolean }>,
  srcSec: number,
  values: ArrayLike<number | null>,
  waitClose: boolean,
): (number | null)[] {
  const out: (number | null)[] = new Array(chartTimes.length).fill(null);
  let j = -1;
  for (let i = 0; i < chartTimes.length; i++) {
    const t = chartTimes[i];
    if (waitClose) {
      const end = t + chartSec;
      while (j + 1 < src.length && src[j + 1].time + srcSec <= end && src[j + 1].confirmed) j++;
    } else {
      while (j + 1 < src.length && src[j + 1].time <= t) j++;
    }
    out[i] = j >= 0 ? values[j] ?? null : null;
  }
  return out;
}

/**
 * Fold a live candle of the chart's timeframe (`cSec`) into a series of the same or a larger timeframe
 * (`sec`), in place: it updates the newest bar, or closes it and starts the next one. The newest bar is
 * marked closed as soon as its last small bar closes. Returns true when a new bar was started.
 */
export function foldTick(series: Candle[], sec: number, c: Candle, cSec: number): boolean {
  const last = series[series.length - 1];
  if (!last || c.time < last.time) return false;
  if (c.time < last.time + sec) {
    if (sec === cSec) {
      last.open = c.open;
      last.high = c.high;
      last.low = c.low;
      last.volume = c.volume;
    } else {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
    }
    last.close = c.close;
    if (c.confirmed && c.time + cSec >= last.time + sec) last.confirmed = true;
    return false;
  }
  last.confirmed = true;
  const start = last.time + Math.floor((c.time - last.time) / sec) * sec;
  series.push({ ...c, time: start, confirmed: c.confirmed && c.time + cSec >= start + sec });
  return true;
}

/** Time left until the bar closes: "00:42", "02:41", "1:02:41", "3天 4時". */
export function fmtCountdown(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天 ${h}時`;
  if (h > 0) return `${h}:${pad(m)}:${pad(s % 60)}`;
  return `${pad(m)}:${pad(s % 60)}`;
}
