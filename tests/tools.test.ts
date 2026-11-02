// Unit tests for the pure parts of the drawing tools and the moving averages.
// Run: npm test   (Node 22+, which can run TypeScript files directly)

import { test } from "node:test";
import assert from "node:assert/strict";
import { distToSegment, fibPrice, fmtLevel, hexToRgba, indexToTime, parseLevel, timeToIndex } from "../src/fibmath.ts";
import { ema, movingAverage, sma, warmupBars, wma } from "../src/indicators.ts";
import { fmtCountdown } from "../src/timeframes.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test("fib levels: 1 on the first point, 0 on the second; reverse swaps", () => {
  const low = { t: 0, p: 100 };
  const high = { t: 60, p: 200 };
  close(fibPrice(low, high, 0), 200);
  close(fibPrice(low, high, 1), 100);
  close(fibPrice(low, high, 0.618), 138.2); // pullback from the high
  close(fibPrice(low, high, 1.618), 38.2);
  close(fibPrice(low, high, 0, true), 100);
  close(fibPrice(low, high, 0.618, true), 161.8);
});

test("time to bar index: containing bar inside, bar lengths outside", () => {
  const t = [1000, 1060, 1120, 1240]; // a missing bar between 1120 and 1240
  assert.equal(timeToIndex(t, 1000, 60), 0);
  assert.equal(timeToIndex(t, 1059, 60), 0);
  assert.equal(timeToIndex(t, 1060, 60), 1);
  assert.equal(timeToIndex(t, 1200, 60), 2); // inside the gap: the bar before it
  assert.equal(timeToIndex(t, 1240, 60), 3);
  assert.equal(timeToIndex(t, 1360, 60), 5); // two bars past the end
  assert.equal(timeToIndex(t, 880, 60), -2);
  close(timeToIndex(t, 1270, 60), 3.5);
  assert.ok(Number.isNaN(timeToIndex([], 5, 60)));
});

test("bar index to time and back", () => {
  const t = [1000, 1060, 1120, 1180];
  assert.equal(indexToTime(t, 2, 60), 1120);
  assert.equal(indexToTime(t, 5, 60), 1300);
  assert.equal(indexToTime(t, -3, 60), 820);
  for (let i = -5; i < 10; i++) assert.equal(timeToIndex(t, indexToTime(t, i, 60), 60), i);
  // a point drawn on 1-minute bars lands on the 15-minute bar holding it
  const m15 = [0, 900, 1800];
  assert.equal(timeToIndex(m15, 7 * 60, 900), 0);
  assert.equal(timeToIndex(m15, 16 * 60, 900), 1);
});

test("typed levels", () => {
  assert.deepEqual(parseLevel("0.705"), { value: 0.705 });
  assert.deepEqual(parseLevel(" -0.27 "), { value: -0.27 });
  assert.deepEqual(parseLevel("61.8%"), { value: 0.618 });
  assert.deepEqual(parseLevel("161.8％"), { value: 1.618 });
  assert.deepEqual(parseLevel("1.6180000001"), { value: 1.618 });
  for (const bad of ["", "%", "abc", "61.8", "-11", "1e999"]) assert.ok("error" in parseLevel(bad), bad);
});

test("small helpers", () => {
  assert.equal(fmtLevel(0.618), "0.618");
  assert.equal(fmtLevel(1), "1");
  assert.equal(fmtLevel(0.50000001), "0.5");
  assert.equal(hexToRgba("#2962ff", 0.1), "rgba(41,98,255,0.1)");
  close(distToSegment(5, 5, 0, 0, 10, 0), 5);
  close(distToSegment(-3, 4, 0, 0, 10, 0), 5);
  close(distToSegment(3, 4, 0, 0, 0, 0), 5);
});

test("moving averages: known values", () => {
  const v = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(sma(v, 3), [null, null, 2, 3, 4, 5]);
  const w = wma(v, 3); // (1*1 + 2*2 + 3*3) / 6 = 14/6
  assert.equal(w[1], null);
  close(w[2] as number, 14 / 6);
  close(w[5] as number, (4 + 10 + 18) / 6);
  const e = ema(v, 3); // seed 2, then k = 0.5
  assert.deepEqual(e, [null, null, 2, 3, 4, 5]);
  assert.deepEqual(sma(v, 10), new Array(6).fill(null));
  assert.deepEqual(wma(v, 10), new Array(6).fill(null));
});

test("warm-up bars", () => {
  assert.equal(warmupBars("SMA", 200), 200);
  assert.equal(warmupBars("WMA", 30), 30);
  assert.equal(warmupBars("EMA", 50), 250);
  // an EMA started 5 n bars earlier from a wrong seed ends up within 0.05 % of one with the right seed
  const closes = Array.from({ length: 600 }, (_, i) => 100 + 10 * Math.sin(i / 17) + i * 0.05);
  const n = 50;
  const long = movingAverage("EMA", n, closes);
  const short = movingAverage("EMA", n, closes.slice(600 - 5 * n - 1));
  const a = long[599] as number;
  const b = short[short.length - 1] as number;
  assert.ok(Math.abs(a - b) / a < 5e-4, `${a} vs ${b}`);
});

test("bar-close countdown text", () => {
  assert.equal(fmtCountdown(42), "00:42");
  assert.equal(fmtCountdown(161.9), "02:41");
  assert.equal(fmtCountdown(3600 + 161), "1:02:41");
  assert.equal(fmtCountdown(3 * 86400 + 4 * 3600 + 59), "3天 4時");
  assert.equal(fmtCountdown(-5), "00:00");
});

test("ray and line distances, time spans, angles", async () => {
  const { distToRay, distToLine, fmtSpan, screenAngle } = await import("../src/fibmath.ts");
  close(distToRay(20, 5, 0, 0, 10, 0), 5); // beyond b: still on the ray
  close(distToRay(-3, 4, 0, 0, 10, 0), 5); // behind a: measured to a
  close(distToLine(-30, 4, 0, 0, 10, 0), 4); // the line goes both ways
  close(distToLine(3, 4, 1, 1, 1, 1), Math.hypot(2, 3));
  assert.equal(fmtSpan(45 * 60), "45分");
  assert.equal(fmtSpan(3 * 3600 + 45 * 60), "3時 45分");
  assert.equal(fmtSpan(2 * 3600), "2時");
  assert.equal(fmtSpan(-(3 * 86400 + 4 * 3600)), "3天 4時");
  close(screenAngle(0, 0, 10, -10), 45);
  close(screenAngle(0, 0, 10, 10), -45);
  close(screenAngle(0, 0, -10, 0), 180);
});

test("position: direction, R lines up to the take-profit, reward/risk", async () => {
  const { positionDir, clampTarget, rewardRisk, rLevels, parseR } = await import("../src/fibmath.ts");
  // long: entry 100, stop 98 (R = 2), take-profit 104.5
  assert.equal(positionDir(100, 98), 1);
  assert.equal(positionDir(100, 102), -1);
  assert.deepEqual(rLevels(100, 98, 104.5, [2, 1, 1.5, 3]).map((l) => [l.k, l.price]), [[1, 102], [1.5, 103], [2, 104]]);
  assert.deepEqual(rLevels(100, 98, 104, [1, 1.5, 2]).map((l) => l.k), [1, 1.5]); // 2R is the take-profit itself
  // short: entry 100, stop 101 (R = 1), take-profit 98.5
  assert.deepEqual(rLevels(100, 101, 98.5, [1, 1.5, 2]).map((l) => [l.k, l.price]), [[1, 99]]);
  assert.deepEqual(rLevels(100, 100, 110, [1]), []); // no risk, no R
  close(rewardRisk(100, 98, 104.5), 2.25);
  close(rewardRisk(100, 101, 98.5), 1.5);
  assert.equal(clampTarget(100, 98, 97), 100); // long take-profit can't go under the entry
  assert.equal(clampTarget(100, 101, 103), 100);
  assert.equal(clampTarget(100, 98, 105), 105);
  assert.deepEqual(parseR("3R"), { value: 3 });
  assert.deepEqual(parseR(" 1.5 "), { value: 1.5 });
  for (const bad of ["", "R", "0", "-1", "25", "abc"]) assert.ok("error" in parseR(bad), bad);
});
