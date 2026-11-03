// Laying a larger timeframe onto the chart's bars, and folding live candles into larger bars.
import { test } from "node:test";
import assert from "node:assert/strict";
import { alignToChart, DEFAULT_TF_BAR, findTf, foldTick, tfLabel, tfName, tfSec, TIMEFRAMES } from "../src/core/timeframes.ts";
import { pineTf } from "../src/pine/runtime.ts";
import type { Candle } from "../src/core/api.ts";

const bar = (time: number, close: number, confirmed = true, extra: Partial<Candle> = {}): Candle => ({
  time, open: close, high: close, low: close, close, volume: 1, confirmed, ...extra,
});

test("timeframe names: OKX's own, put-together ones, and the one name of each length", () => {
  assert.equal(tfSec("1Wutc"), 604800);
  assert.equal(tfSec("nope"), 0);
  assert.equal(tfLabel("10s"), "10秒");
  assert.equal(tfLabel("45m"), "45分");
  assert.equal(tfLabel("3H"), "3時");
  assert.equal(tfLabel("1Dutc"), "日");
  assert.equal(tfLabel("2Wutc"), "2週");
  assert.equal(tfLabel("6H"), "6時"); // OKX's Hong Kong 6-hour bars, saved by older versions
  // the one name of a length
  assert.equal(tfName(90, "m"), "90m");
  assert.equal(tfName(120, "m"), "2H");
  assert.equal(tfName(6, "H"), "6Hutc");
  assert.equal(tfName(24, "H"), "1Dutc");
  assert.equal(tfName(14, "D"), "2Wutc");
  assert.equal(tfName(60, "s"), "1m");
  // lengths the app can't make
  assert.equal(tfName(61, "s"), null);
  assert.equal(tfName(1439, "m"), null); // only 1-minute bars divide it: 1439 of them
  assert.equal(tfName(13, "W"), null);
  assert.equal(tfName(0, "m"), null);
  assert.equal(findTf("15M"), undefined);
  // every named one is valid, and the default toolbar nests
  for (const t of TIMEFRAMES) assert.ok(findTf(t.bar), t.bar);
  for (let k = 1; k < DEFAULT_TF_BAR.length; k++) assert.equal(tfSec(DEFAULT_TF_BAR[k]) % tfSec(DEFAULT_TF_BAR[k - 1]), 0);
  // Pine timeframes to the app's
  assert.equal(pineTf("5S")?.okx, "5s");
  assert.equal(pineTf("10")?.okx, "10m");
  assert.equal(pineTf("180")?.okx, "3H");
  assert.equal(pineTf("M")?.okx ?? null, null);
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
