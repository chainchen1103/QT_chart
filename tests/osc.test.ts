// RSI, MACD, KD, ATR and Bollinger Bands: against Pine's ta functions (TradingView's numbers) on the same bars,
// and a few values worked out by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { load, type Bar } from "../src/pine/index.ts";
import { atr, bollinger, emaOf, kd, macd, rma, rsi, smaOf, type Num } from "../src/indicators/osc.ts";

const bars: Bar[] = Array.from({ length: 400 }, (_, i) => {
  const c = 100 + 12 * Math.sin(i / 7) + 4 * Math.cos(i / 3) + i * 0.05;
  const o = 100 + 12 * Math.sin((i - 1) / 7) + 4 * Math.cos((i - 1) / 3) + (i - 1) * 0.05;
  return { time: 1700006400 + i * 900, open: o, high: Math.max(o, c) + 1 + (i % 5) * 0.3, low: Math.min(o, c) - 1 - (i % 3) * 0.4, close: c, volume: 10, confirmed: true };
});
const closes = bars.map((b) => b.close);

/** Values of every plot of a Pine script run on `bars`, by title (na as null). */
function pine(src: string): Record<string, Num[]> {
  const l = load(`//@version=5\nindicator("t")\n${src}`);
  if (!l.ok) throw new Error(l.error.message);
  const r = l.program.run({ bars, sec: 900, instId: "BTC-USDT-SWAP", mintick: 0.01 }, { inputs: {} });
  if (r.error) throw new Error(r.error.message);
  return Object.fromEntries(r.out.plots.map((p) => [p.title, Array.from(p.values, (v) => (Number.isNaN(v) ? null : v))]));
}

function same(a: Num[], b: Num[], what: string) {
  assert.equal(a.length, b.length, what);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x == null || y == null) assert.equal(x, y, `${what} bar ${i}: ${x} vs ${y}`);
    else assert.ok(Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(y)), `${what} bar ${i}: ${x} vs ${y}`);
  }
}

test("averages: Wilder's and exponential start from the mean of the first values; simple skips missing ones", () => {
  assert.deepEqual(rma([null, 2, 4, 6, 8], 2), [null, null, 3, 4.5, 6.25]);
  assert.deepEqual(emaOf([1, 2, 3, 4], 3), [null, null, 2, 3]);
  assert.deepEqual(smaOf([1, null, 3, 5], 2), [null, null, 2, 4]);
});

test("RSI, MACD, KD, ATR and Bollinger Bands give TradingView's numbers", () => {
  const p = pine(`
plot(ta.rsi(close, 14), "rsi")
[m, s, h] = ta.macd(close, 12, 26, 9)
plot(m, "macd"), plot(s, "signal"), plot(h, "hist")
k = ta.sma(ta.stoch(close, high, low, 9), 3)
plot(k, "k"), plot(ta.sma(k, 3), "d")
plot(ta.atr(14), "atr")
[b, u, lo] = ta.bb(close, 20, 2)
plot(b, "basis"), plot(u, "upper"), plot(lo, "lower")
`);
  same(rsi(closes, 14), p.rsi, "RSI");
  const m = macd(closes, 12, 26, 9);
  same(m.macd, p.macd, "MACD");
  same(m.signal, p.signal, "signal");
  same(m.hist, p.hist, "histogram");
  const s = kd(bars, 9, 3, 3);
  same(s.k, p.k, "K");
  same(s.d, p.d, "D");
  same(atr(bars, 14), p.atr, "ATR");
  const bb = bollinger(closes, 20, 2);
  same(bb.basis, p.basis, "basis");
  same(bb.upper, p.upper, "upper band");
  same(bb.lower, p.lower, "lower band");
});

test("RSI: all up is 100, all down 0; KD: no range is missing", () => {
  assert.equal(rsi([1, 2, 3, 4], 3)[3], 100);
  assert.equal(rsi([4, 3, 2, 1], 3)[3], 0);
  const flat = [0, 1, 2].map((i) => ({ time: i, open: 5, high: 5, low: 5, close: 5, volume: 0, confirmed: true }));
  assert.deepEqual(kd(flat, 2, 1, 1).k, [null, null, null]);
});

import { cleanInds, DEFAULT_INDS } from "../src/settings/indicators.ts";
import { cleanSpec, specName } from "../src/indicators/specs.ts";

test("settings: all off at first; a bad number or color falls back to its default, the rest is kept", () => {
  assert.deepEqual(cleanInds(undefined), DEFAULT_INDS);
  const s = cleanInds({ rsi: { on: true, length: 21, upper: 80, lower: -5, color: "red", tf: "4H" }, macd: { fast: 0, slow: 30.4 }, kd: "x" });
  assert.deepEqual(s.rsi, { on: true, tf: "4H", length: 21, color: DEFAULT_INDS.rsi.color, upper: 80, lower: DEFAULT_INDS.rsi.lower });
  assert.deepEqual([s.macd.fast, s.macd.slow, s.macd.on], [12, 30, false]);
  assert.deepEqual(s.kd, DEFAULT_INDS.kd);
  assert.equal(cleanInds({ boll: { tf: "7Q", mult: 2.5 } }).boll.tf, "");
  assert.equal(cleanInds({ boll: { tf: "7Q", mult: 2.5 } }).boll.mult, 2.5);
});

test("an indicator as alerts name it", () => {
  assert.equal(specName(cleanSpec({ type: "macd", fast: 12, slow: 26, signal: 9 })!), "MACD 12 26 9");
  assert.equal(specName(cleanSpec({ type: "ma", kind: "EMA", length: 20 })!), "EMA20");
  assert.equal(specName(cleanSpec({ type: "boll", length: 20, mult: 2 })!), "布林 20 2");
  assert.equal(cleanSpec({ type: "kd", length: 9, smoothK: 3 }), null);
  assert.equal(cleanSpec({ type: "rsi", length: 14.5 }), null);
});
