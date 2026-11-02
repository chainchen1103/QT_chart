// Moving averages over closes. Output arrays align with the input; null where there aren't enough bars yet.

import type { MaKind } from "../settings/model.ts";

export function sma(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < n) return out;
  const k = 2 / (n + 1);
  let prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n; // seeded with the SMA of the first n
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Weighted moving average: the newest bar weighs n, the oldest 1. */
export function wma(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < n) return out;
  const denom = (n * (n + 1)) / 2;
  let sum = 0; // plain sum of the window
  let wsum = 0; // weighted sum of the window
  for (let j = 0; j < n; j++) {
    sum += values[j];
    wsum += (j + 1) * values[j];
  }
  out[n - 1] = wsum / denom;
  for (let i = n; i < values.length; i++) {
    wsum += n * values[i] - sum; // every older bar loses one weight, the new one gets n
    sum += values[i] - values[i - n];
    out[i] = wsum / denom;
  }
  return out;
}

export function movingAverage(kind: MaKind, n: number, closes: number[]): (number | null)[] {
  if (kind === "EMA") return ema(closes, n);
  if (kind === "WMA") return wma(closes, n);
  return sma(closes, n);
}

/**
 * Bars needed before the first bar on screen so the line is right from there. SMA and WMA need n - 1.
 * EMA depends on every earlier bar: after the SMA seed, 4 n more bars shrink the seed's effect to e^-8
 * (about 0.03 %), so it matches a line computed over the whole history (TradingView).
 */
export function warmupBars(kind: MaKind, n: number): number {
  return kind === "EMA" ? 5 * n : n;
}
