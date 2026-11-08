// RSI, MACD, KD, ATR and Bollinger Bands from bars, as TradingView computes them: RSI and ATR with Wilder's
// average (RMA), MACD with exponential averages, KD as TradingView's Stochastic (%K and %D smoothed with simple
// averages), Bollinger Bands with the standard deviation of the whole population. Averages skip missing values
// and start from the mean of their first `n` values, as Pine's ta functions do. Output arrays line up with the
// bars, null where there aren't enough bars yet.

import type { Candle } from "../core/api.ts";

export type Num = number | null;

/** An average that starts from the mean of its first n values, then goes alpha * v + (1 - alpha) * previous. */
function smoothed(values: readonly Num[], n: number, alpha: number): Num[] {
  const out: Num[] = new Array(values.length).fill(null);
  if (!(n >= 1)) return out;
  let prev: number | null = null;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) {
      out[i] = prev;
      continue;
    }
    if (prev != null) prev = alpha * v + (1 - alpha) * prev;
    else {
      sum += v;
      if (++count === n) prev = sum / n;
    }
    out[i] = prev;
  }
  return out;
}

/** Wilder's average (Pine's ta.rma). */
export const rma = (values: readonly Num[], n: number): Num[] => smoothed(values, n, 1 / n);
/** Exponential average (Pine's ta.ema). */
export const emaOf = (values: readonly Num[], n: number): Num[] => smoothed(values, n, 2 / (n + 1));

/** Mean of the last n values that are there (Pine's ta.sma). */
export function smaOf(values: readonly Num[], n: number): Num[] {
  const out: Num[] = new Array(values.length).fill(null);
  if (!(n >= 1)) return out;
  const win: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) {
      win.push(v);
      sum += v;
      if (win.length > n) sum -= win.shift()!;
    }
    out[i] = win.length >= n ? sum / n : null;
  }
  return out;
}

export function rsi(closes: readonly number[], n: number): Num[] {
  const up: Num[] = closes.map((c, i) => (i === 0 ? null : Math.max(c - closes[i - 1], 0)));
  const down: Num[] = closes.map((c, i) => (i === 0 ? null : Math.max(closes[i - 1] - c, 0)));
  const u = rma(up, n);
  const d = rma(down, n);
  return u.map((a, i) => {
    const b = d[i];
    if (a == null || b == null) return null;
    return b === 0 ? 100 : a === 0 ? 0 : 100 - 100 / (1 + a / b);
  });
}

export type Macd = { macd: Num[]; signal: Num[]; hist: Num[] };
export function macd(closes: readonly number[], fast: number, slow: number, signal: number): Macd {
  const f = emaOf(closes, fast);
  const s = emaOf(closes, slow);
  const m = f.map((a, i) => (a == null || s[i] == null ? null : a - s[i]!));
  const sig = emaOf(m, signal);
  return { macd: m, signal: sig, hist: m.map((a, i) => (a == null || sig[i] == null ? null : a - sig[i]!)) };
}

/** TradingView's Stochastic: raw %K over `length` bars, %K its `smoothK` average, %D the `smoothD` average of %K. */
export type Kd = { k: Num[]; d: Num[] };
export function kd(bars: readonly Candle[], length: number, smoothK: number, smoothD: number): Kd {
  const raw: Num[] = bars.map((b, i) => {
    if (i < length - 1) return null;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - length + 1; j <= i; j++) {
      hh = Math.max(hh, bars[j].high);
      ll = Math.min(ll, bars[j].low);
    }
    return hh === ll ? null : (100 * (b.close - ll)) / (hh - ll);
  });
  const k = smaOf(raw, smoothK);
  return { k, d: smaOf(k, smoothD) };
}

/** Average true range, Wilder's average of the true range (the first bar's is its high - low). */
export function atr(bars: readonly Candle[], n: number): Num[] {
  const tr = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
  return rma(tr, n);
}

export type Bands = { basis: Num[]; upper: Num[]; lower: Num[] };
export function bollinger(closes: readonly number[], n: number, mult: number): Bands {
  const basis = smaOf(closes, n);
  const upper: Num[] = new Array(closes.length).fill(null);
  const lower: Num[] = new Array(closes.length).fill(null);
  for (let i = n - 1; i < closes.length; i++) {
    const m = basis[i];
    if (m == null) continue;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (closes[j] - m) ** 2;
    const dev = mult * Math.sqrt(s / n);
    upper[i] = m + dev;
    lower[i] = m - dev;
  }
  return { basis, upper, lower };
}

/**
 * Bars needed before the first bar on screen so the values there are what a run over the whole history gives
 * (TradingView). The simple averages need their length. Wilder's and exponential averages remember every
 * earlier bar: this many more shrink the starting mean's weight below 0.01 %.
 */
export const warmup = {
  rsi: (n: number) => 10 * n,
  macd: (fast: number, slow: number, signal: number) => 5 * Math.max(fast, slow) + 5 * signal,
  kd: (length: number, smoothK: number, smoothD: number) => length + smoothK + smoothD,
  atr: (n: number) => 10 * n,
  boll: (n: number) => n,
};
