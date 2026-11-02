// Laying a larger timeframe onto the chart's bars, and folding live candles into larger bars.
import { test } from "node:test";
import assert from "node:assert/strict";
import { alignToChart, foldTick, tfSec, TIMEFRAMES } from "../src/timeframes.ts";
import type { Candle } from "../src/api.ts";

const bar = (time: number, close: number, confirmed = true, extra: Partial<Candle> = {}): Candle => ({
  time, open: close, high: close, low: close, close, volume: 1, confirmed, ...extra,
});

test("timeframes nest and weekly bars are a week long", () => {
  assert.equal(tfSec("1Wutc"), 604800);
  assert.equal(tfSec("nope"), 0);
  for (let k = 1; k < TIMEFRAMES.length; k++) assert.equal(TIMEFRAMES[k].sec % TIMEFRAMES[k - 1].sec, 0);
});

test("align: live uses the larger bar holding each chart bar; waiting uses the last closed one", () => {
  // 15-minute chart from 00:00 to 02:45; 1-hour source bars at 00:00, 01:00, 02:00 (the last still forming)
  const chart = Array.from({ length: 12 }, (_, i) => i * 900);
  const src = [bar(0, 10), bar(3600, 11), bar(7200, 12, false)];
  const vals = [100, 101, 102];
  const live = alignToChart(chart, 900, src, 3600, vals, false);
  assert.deepEqual(live, [100, 100, 100, 100, 101, 101, 101, 101, 102, 102, 102, 102]);
  const wait = alignToChart(chart, 900, src, 3600, vals, true);
  // the 00:00 hour is known from the close of the 00:45 bar (ends 01:00); the 02:00 hour isn't closed
  assert.deepEqual(wait, [null, null, null, 100, 100, 100, 100, 101, 101, 101, 101, 101]);
  // once the 02:00 hour is closed, the last chart bar (ends 03:00) shows it
  src[2].confirmed = true;
  assert.equal(alignToChart(chart, 900, src, 3600, vals, true)[11], 102);
  // same timeframe: one to one
  assert.deepEqual(alignToChart([0, 60, 120], 60, [bar(0, 1), bar(60, 2), bar(120, 3, false)], 60, [1, 2, 3], false), [1, 2, 3]);
  // chart bars before the first source bar get nothing
  assert.deepEqual(alignToChart([-900, 0], 900, [bar(0, 1)], 3600, [5], false), [null, 5]);
});

test("fold: a live 15-minute candle updates, closes and starts 1-hour bars", () => {
  const h: Candle[] = [bar(0, 10, false, { open: 9, high: 11, low: 8 })];
  assert.equal(foldTick(h, 3600, bar(2700, 12, false, { high: 13, low: 10 }), 900), false);
  assert.deepEqual([h[0].high, h[0].low, h[0].close, h[0].confirmed], [13, 8, 12, false]);
  // the last 15 minutes of the hour closes: the hour is closed too
  foldTick(h, 3600, bar(2700, 12.5, true, { high: 13, low: 10 }), 900);
  assert.equal(h[0].confirmed, true);
  assert.equal(h[0].close, 12.5);
  // next hour starts
  assert.equal(foldTick(h, 3600, bar(3600, 14, false), 900), true);
  assert.deepEqual([h.length, h[1].time, h[1].close, h[1].confirmed], [2, 3600, 14, false]);
  // a gap: the next candle lands two hours later
  assert.equal(foldTick(h, 3600, bar(3 * 3600 + 900, 15, false), 900), true);
  assert.deepEqual([h[1].confirmed, h[2].time], [true, 3 * 3600]);
  // older candles are ignored
  assert.equal(foldTick(h, 3600, bar(0, 1), 900), false);
  assert.equal(h[0].close, 12.5);
});

test("fold: same timeframe copies the candle", () => {
  const s: Candle[] = [bar(0, 10, false)];
  foldTick(s, 60, bar(0, 11, true, { open: 10, high: 12, low: 9, volume: 5 }), 60);
  assert.deepEqual(s[0], { time: 0, open: 10, high: 12, low: 9, close: 11, volume: 5, confirmed: true });
  assert.equal(foldTick(s, 60, bar(60, 13, false), 60), true);
  assert.deepEqual([s.length, s[1].time, s[1].close], [2, 60, 13]);
});
