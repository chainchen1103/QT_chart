// Timeframes, and how a series from one timeframe is laid onto the bars of another.
// Pure functions (no DOM), unit-tested in tests/timeframes.test.ts.

import type { Candle } from "./api";

export type Tf = { bar: string; label: string; sec: number };

/** OKX bar names. Daily and weekly bars start at 00:00 UTC (weekly on Monday); smaller ones nest inside. */
export const TIMEFRAMES: Tf[] = [
  { bar: "1m", label: "1分", sec: 60 },
  { bar: "5m", label: "5分", sec: 300 },
  { bar: "15m", label: "15分", sec: 900 },
  { bar: "1H", label: "1時", sec: 3600 },
  { bar: "4H", label: "4時", sec: 14400 },
  { bar: "1Dutc", label: "日", sec: 86400 },
  { bar: "1Wutc", label: "週", sec: 604800 },
];

export const findTf = (bar: string): Tf | undefined => TIMEFRAMES.find((t) => t.bar === bar);
export const tfSec = (bar: string): number => findTf(bar)?.sec ?? 0;
export const tfLabel = (bar: string): string => findTf(bar)?.label ?? bar;

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
