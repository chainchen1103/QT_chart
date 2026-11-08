// Price alerts: price ranges between snapshots, drawings read as levels, zones, times and trades.
import { test } from "node:test";
import assert from "node:assert/strict";
import { barStart, describe, evaluate, levelHit, moveSince, shapeAt, tradeStep, type Move } from "../src/alerts/engine.ts";
import { cleanAlerts, cleanOptions, condsFor, type Alert } from "../src/alerts/model.ts";
import type { Drawing, FibSettings } from "../src/settings/model.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const name = (k: string) => ({ trend: "趨勢線", hline: "水平線", ray: "射線", hray: "水平射線" })[k] ?? k;
const fib: FibSettings = {
  levels: [{ value: 0, color: "#000000", on: true }, { value: 0.5, color: "#000000", on: true }, { value: 1, color: "#000000", on: false }],
  extend: true, fill: true, showPrice: true, reverse: false,
};
const alert = (p: Partial<Alert>): Alert => ({
  id: "a", instId: "BTC-USDT-SWAP", target: { kind: "price", price: 100 }, cond: "touch", repeat: "once", tf: "15m",
  note: "", on: true, created: 0, fired: null, count: 0, ...p,
});
const mv = (from: number | null, lo: number, hi: number): Move => ({ from, lo, hi, price: hi });
const line = (kind: string, a: [number, number], b: [number, number]) =>
  ({ id: "d", kind, a: { t: a[0], p: a[1] }, b: { t: b[0], p: b[1] }, style: { color: "#2962ff", width: 1, dash: "solid" } }) as Drawing;

test("the range covered between two snapshots", () => {
  assert.deepEqual(moveSince(null, { time: 60, high: 101, low: 99, close: 100 }), { from: null, lo: 100, hi: 100, price: 100 });
  // same bar: the close moved 100 -> 100.5, and the bar made a new high of 102 in between
  assert.deepEqual(moveSince({ time: 60, high: 101, low: 99, close: 100 }, { time: 60, high: 102, low: 99, close: 100.5 }), {
    from: 100, lo: 100, hi: 102, price: 100.5,
  });
  // the old low (99) is not new: it was before the previous snapshot
  assert.equal(moveSince({ time: 60, high: 101, low: 99, close: 100 }, { time: 60, high: 101, low: 99, close: 99.8 })!.lo, 99.8);
  // a new bar: its whole range so far counts, joined to the old close
  assert.deepEqual(moveSince({ time: 60, high: 101, low: 99, close: 100 }, { time: 120, high: 100.4, low: 98.5, close: 99 }), {
    from: 100, lo: 98.5, hi: 100.4, price: 99,
  });
  assert.equal(moveSince({ time: 120, high: 1, low: 1, close: 1 }, { time: 60, high: 1, low: 1, close: 1 }), null);
});

test("bar starts, weekly bars on Monday", () => {
  assert.equal(barStart(1000, 900), 900);
  const mon = Date.UTC(2026, 10, 2) / 1000; // 2026-11-02 is a Monday
  assert.equal(barStart(Date.UTC(2026, 10, 5, 13) / 1000, 604800), mon);
  assert.equal(barStart(mon, 604800), mon);
});

test("touch, cross up, cross down", () => {
  assert.ok(levelHit(100, "touch", mv(99, 99, 100)));
  assert.ok(levelHit(100, "touch", mv(101, 99.5, 101)));
  assert.ok(!levelHit(100, "touch", mv(98, 98, 99.9)));
  assert.ok(!levelHit(100, "touch", mv(null, 100, 100))); // first snapshot: no side yet
  assert.ok(levelHit(100, "up", mv(99, 99, 100)));
  assert.ok(!levelHit(100, "up", mv(101, 99, 101))); // came from above
  assert.ok(levelHit(100, "down", mv(101, 99.9, 101)));
  assert.ok(!levelHit(100, "down", mv(99, 99, 100.2)));
});

test("price alerts: once, and at most once a minute", () => {
  const a = alert({});
  assert.equal(evaluate(a, { type: "levels", levels: [{ name: "", price: 100 }] }, mv(99, 99, 100.1), 500).events.length, 1);
  assert.equal(evaluate({ ...a, on: false }, { type: "levels", levels: [{ name: "", price: 100 }] }, mv(99, 99, 100.1), 500).events.length, 0);
  const every = alert({ repeat: "every", fired: 480 });
  const s = { type: "levels" as const, levels: [{ name: "", price: 100 }] };
  assert.equal(evaluate(every, s, mv(99, 99, 100.1), 500).events.length, 0); // 20 s after the last one
  assert.equal(evaluate(every, s, mv(99, 99, 100.1), 541).events.length, 1);
});

test("drawings as alerts see them", () => {
  // trend line 100 -> 110 over 10 bars of 15 minutes, read at the start of the current bar, past its end too
  const tr = line("trend", [0, 100], [9000, 110]);
  const s1 = shapeAt(tr, 4500 + 300, "15m", fib, name);
  assert.equal(s1?.type, "levels");
  if (s1?.type === "levels") close(s1.levels[0].price, 105);
  const s2 = shapeAt(tr, 18000 + 899, "15m", fib, name); // twice as far: continued past the second point
  if (s2?.type === "levels") close(s2.levels[0].price, 120);
  assert.equal(shapeAt(tr, -10, "15m", fib, name), null); // before it starts
  assert.equal(shapeAt(line("ray", [9000, 110], [0, 100]), 20000, "15m", fib, name), null); // ray pointing left
  assert.equal(shapeAt(line("hray", [9000, 110], [9000, 110]), 8000, "15m", fib, name), null);
  assert.deepEqual(shapeAt(line("hray", [9000, 110], [9000, 110]), 9500, "15m", fib, name), { type: "levels", levels: [{ name: "水平射線", price: 110 }] });
  assert.deepEqual(shapeAt(line("vline", [9000, 110], [9000, 110]), 1, "15m", fib, name), { type: "time", t: 9000 });
  const rect = { id: "r", kind: "rect", a: { t: 100, p: 90 }, b: { t: 200, p: 80 }, style: {} } as unknown as Drawing;
  assert.deepEqual(shapeAt(rect, 5000, "15m", fib, name), { type: "box", top: 90, bottom: 80 }); // past its right edge still
  const f = { id: "f", kind: "fib", a: { t: 0, p: 100 }, b: { t: 900, p: 200 } } as Drawing;
  const fs = shapeAt(f, 5000, "15m", fib, name);
  assert.deepEqual(fs, { type: "levels", levels: [{ name: "Fib 0", price: 200 }, { name: "Fib 0.5", price: 150 }] }); // level 1 is off
  const pos = { id: "p", kind: "position", a: { t: 900, p: 100 }, b: { t: 9000, p: 98 }, target: 105 } as Drawing;
  assert.equal(shapeAt(pos, 800, "15m", fib, name), null);
  assert.deepEqual(shapeAt(pos, 1000, "15m", fib, name), { type: "trade", entry: 100, stop: 98, target: 105 });
});

test("rectangles: coming in, going out", () => {
  const box = { type: "box" as const, top: 110, bottom: 100 };
  assert.equal(evaluate(alert({ cond: "enter" }), box, mv(99, 99, 100), 1).events.length, 1);
  assert.equal(evaluate(alert({ cond: "enter" }), box, mv(105, 104, 106), 1).events.length, 0); // was inside already
  assert.equal(evaluate(alert({ cond: "exit" }), box, mv(105, 104, 110.5), 1).events.length, 1);
  assert.equal(evaluate(alert({ cond: "exit" }), box, mv(99, 98, 99.5), 1).events.length, 0);
});

test("vertical line: its time, if it was still ahead", () => {
  const s = { type: "time" as const, t: 1000 };
  assert.equal(evaluate(alert({ cond: "time", created: 900 }), s, mv(1, 1, 1), 999).events.length, 0);
  assert.equal(evaluate(alert({ cond: "time", created: 900 }), s, mv(1, 1, 1), 1000).events.length, 1);
  assert.equal(evaluate(alert({ cond: "time", created: 1100 }), s, mv(1, 1, 1), 1200).events.length, 0);
});

test("positions: entry, then stop or take-profit", () => {
  const s = { entry: 100, stop: 98, target: 105 };
  assert.deepEqual(tradeStep("wait", s, mv(101, 100.5, 101)), { events: [] });
  assert.deepEqual(tradeStep("wait", s, mv(101, 99.5, 101)), { events: [{ type: "entry", price: 100 }], stage: "open" });
  // one move from above through the entry down to the stop: in, then out at the stop
  assert.deepEqual(tradeStep("wait", s, mv(101, 97.5, 101)).stage, "done");
  // coming up from under the stop: the stop was passed before the entry, so only the entry counts
  assert.deepEqual(tradeStep("wait", s, mv(97, 97, 100.2)), { events: [{ type: "entry", price: 100 }], stage: "open" });
  assert.deepEqual(tradeStep("open", s, mv(101, 101, 105.5)).events, [{ type: "exit", how: "target", price: 105, r: 2.5 }]);
  assert.deepEqual(tradeStep("open", s, mv(99, 97.9, 105.5)).events[0], { type: "exit", how: "stop", price: 98, r: -1 }); // both: stop
  assert.deepEqual(tradeStep("done", s, mv(99, 90, 110)), { events: [] });
  // a short: stop above
  assert.equal(tradeStep("open", { entry: 100, stop: 102, target: 95 }, mv(97, 94.9, 97)).events[0].type, "exit");
});

test("messages", () => {
  const fmt = (p: number) => p.toFixed(1);
  assert.equal(describe({ type: "level", cond: "touch", name: "", price: 78500 }, fmt, String), "觸及 78500.0");
  assert.equal(describe({ type: "level", cond: "up", name: "趨勢線", price: 1 }, fmt, String), "向上突破趨勢線（1.0）");
  assert.equal(describe({ type: "exit", how: "target", price: 105, r: 2.5 }, fmt, String), "倉位止盈（105.0，+2.50R）");
  assert.equal(describe({ type: "box", cond: "enter", top: 2, bottom: 1 }, fmt, String), "進入矩形（1.0～2.0）");
});

test("stored alerts are checked", () => {
  const isTf = (b: string) => b === "15m" || b === "1H";
  const ok = { id: "x", instId: "ETH-USDT-SWAP", target: { kind: "price", price: 2000 }, cond: "up", tf: "1H" };
  const list = cleanAlerts(
    [
      ok,
      { ...ok }, // same id twice
      { ...ok, id: "y", instId: "eth usdt" },
      { ...ok, id: "z", cond: "enter" }, // a price can't be entered
      { ...ok, id: "w", target: { kind: "drawing", id: "d1" }, cond: "trade", tf: "2D", note: "x".repeat(500) },
      "junk",
    ],
    isTf,
  );
  assert.deepEqual(list.map((a) => a.id), ["x", "w"]);
  assert.equal(list[0].repeat, "once");
  assert.equal(list[1].tf, "15m");
  assert.equal(list[1].stage, "wait");
  assert.equal(list[1].note.length, 120);
  assert.deepEqual(condsFor("rect"), ["enter", "exit"]);
});

test("alert options: on unless turned off, the in-window message too", () => {
  assert.deepEqual(cleanOptions(undefined), { sound: true, system: true, popup: true });
  assert.deepEqual(cleanOptions({ sound: false, system: true }), { sound: false, system: true, popup: true }); // saved before it existed
  assert.deepEqual(cleanOptions({ popup: false, system: false }), { sound: true, system: false, popup: false });
});

// ----------------------------------------------------------------------------- indicator alerts
import { crossed, indicatorStep, signalOf } from "../src/alerts/engine.ts";
import { AlertBars } from "../src/alerts/bars.ts";
import { AlertService } from "../src/alerts/service.ts";
import type { Candle } from "../src/core/api.ts";
import type { IndTarget } from "../src/alerts/model.ts";

const rsiAt = (value: number): IndTarget => ({ kind: "indicator", spec: { type: "rsi", length: 14 }, line: "rsi", value });

test("indicator alerts are checked when read back", () => {
  const ok = (target: unknown, cond = "up") => cleanAlerts([{ id: "x", instId: "ETH-USDT-SWAP", target, cond }], () => true).length === 1;
  assert.ok(ok(rsiAt(80)));
  assert.ok(ok({ kind: "indicator", spec: { type: "macd", fast: 12, slow: 26, signal: 9 }, line: "macd", other: "signal" }));
  assert.ok(ok({ kind: "indicator", spec: { type: "ma", kind: "EMA", length: 20 }, line: "ma" })); // with the price
  assert.ok(!ok({ kind: "indicator", spec: { type: "ma", kind: "EMA", length: 20 }, line: "ma", value: 5 })); // a price line takes no number
  assert.ok(!ok({ kind: "indicator", spec: { type: "rsi", length: 14 }, line: "rsi" })); // nothing to compare with
  assert.ok(!ok({ kind: "indicator", spec: { type: "rsi", length: 0 }, line: "rsi", value: 80 }));
  assert.ok(!ok({ kind: "indicator", spec: { type: "kd", length: 9, smoothK: 3, smoothD: 3 }, line: "k", other: "k" }));
  assert.ok(!ok(rsiAt(80), "enter"));
  const [a] = cleanAlerts([{ id: "x", instId: "ETH-USDT-SWAP", target: rsiAt(80), cond: "up", close: true, tf: "1H" }], () => true);
  assert.equal(a.close, true);
  assert.equal(cleanAlerts([{ id: "x", instId: "ETH-USDT-SWAP", target: { kind: "price", price: 1 }, cond: "up", close: true }], () => true)[0].close, undefined);
  assert.deepEqual(condsFor("indicator"), ["touch", "up", "down"]);
});

test("indicator lines: crossing a number, another line, or the price", () => {
  const lines = { rsi: [60, 75, 82], k: [10, 30, 50], d: [20, 25, 55] };
  assert.deepEqual(signalOf(rsiAt(80), lines, []), [-20, -5, 2]);
  assert.deepEqual(signalOf({ kind: "indicator", spec: { type: "kd", length: 9, smoothK: 3, smoothD: 3 }, line: "k", other: "d" }, lines, []), [-10, 5, -5]);
  assert.deepEqual(signalOf({ kind: "indicator", spec: { type: "ma", kind: "SMA", length: 2 }, line: "ma" }, { ma: [null, 100] }, [99, 101]), [null, 1]);
  assert.ok(crossed("up", -1, 0) && crossed("up", -1, 3) && !crossed("up", 1, 3) && !crossed("up", null, 3));
  assert.ok(crossed("down", 1, -1) && crossed("touch", 1, -1) && crossed("touch", -1, 1) && !crossed("touch", 1, 2));
});

test("an indicator alert goes off as its line crosses, on the bar still moving or only once a bar closes", () => {
  const t = rsiAt(80);
  const a = alert({ target: t, cond: "up" });
  const sig = [-20, -5, 2]; // RSI 60, 75, 82: the bar still moving went over 80
  assert.equal(indicatorStep(a, t, sig, [], false, undefined, null, 100).hit, false); // the first time it only looks: that cross came before
  assert.equal(indicatorStep(a, t, sig, [], false, undefined, null, 100).next, 2);
  assert.equal(indicatorStep(a, t, sig, [], false, -1, null, 100).hit, true); // under 80 at the last update, over now
  assert.equal(indicatorStep(a, t, sig, [], false, 1, null, 100).hit, false); // it was over 80 at the last update already
  assert.equal(indicatorStep(a, t, sig, [], false, -1, null, 100).next, 2);
  // only at the close: the bar that closed (index 1) against the one before (index 0); none while a bar moves
  const c = alert({ target: t, cond: "up", close: true });
  assert.equal(indicatorStep(c, t, [-5, 2, 3], [], false, undefined, null, 100).hit, false);
  assert.equal(indicatorStep(c, t, [-5, 2, 3], [], true, undefined, null, 100).hit, true);
  assert.equal(indicatorStep(c, t, [2, 3, -1], [], true, undefined, null, 100).hit, false);
  // at most once a minute when it stays on
  assert.equal(indicatorStep(alert({ target: t, cond: "up", repeat: "every", fired: 60 }), t, sig, [], false, -1, null, 100).hit, false);
  // a moving average: the price moving through it, highs and lows in between too
  const ma: IndTarget = { kind: "indicator", spec: { type: "ma", kind: "EMA", length: 20 }, line: "ma" };
  const p = alert({ target: ma, cond: "touch" });
  assert.equal(indicatorStep(p, ma, [-1], [100], false, undefined, mv(99, 98.5, 100.2), 100).hit, true);
  assert.equal(indicatorStep(p, ma, [-1], [100], false, undefined, mv(99, 98.5, 99.9), 100).hit, false);
});

const bar1m = (time: number, close: number, confirmed = false): Candle => ({ time, open: close, high: close, low: close, close, volume: 1, confirmed });

test("alert bars: fetched once, kept current from 1-minute bars, fetched again after a gap", async () => {
  const asked: string[] = [];
  const hist = (bar: string) => [0, 3600, 7200].map((t) => ({ ...bar1m(t, 100 + t / 3600, t < 7200), high: 105, low: 95 }));
  const b = new AlertBars(async (id, bar, n) => {
    asked.push(`${id} ${bar} ${n}`);
    return hist(bar);
  });
  assert.equal(b.get("ETH-USDT-SWAP", "1H", 40), null);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(asked, ["ETH-USDT-SWAP 1H 45"]);
  const got = b.get("ETH-USDT-SWAP", "1H", 40)!;
  assert.equal(got.length, 3);
  assert.equal(b.fold("ETH-USDT-SWAP", bar1m(7260, 110)).size, 0); // into the bar still moving
  assert.equal(got[2].close, 110);
  assert.equal(got[2].high, 110);
  assert.deepEqual([...b.fold("ETH-USDT-SWAP", bar1m(10800, 111))], ["1H"]); // the next hour: one closed
  assert.equal(got.length, 4);
  assert.equal(b.fold("BTC-USDT-SWAP", bar1m(10860, 1)).size, 0); // another symbol's
  b.fold("ETH-USDT-SWAP", bar1m(10800 + 3 * 3600, 112)); // hours later: asleep, so again
  assert.equal(b.get("ETH-USDT-SWAP", "1H", 40), null);
  b.keep(new Set());
  assert.equal(b.get("ETH-USDT-SWAP", "1H", 40), null);
});

test("an RSI alert goes off in the service as the price climbs", async () => {
  // 60 minutes up and down around 100 (RSI near 50), then a run up: RSI goes over 70
  const hist: Candle[] = Array.from({ length: 60 }, (_, i) => bar1m(i * 60, 100 + (i % 2 ? 0.5 : -0.5), true));
  hist.push(bar1m(3600, 100));
  const notes: string[] = [];
  const store: Record<string, unknown> = {};
  let now = 3600;
  const s = new AlertService({
    watch: () => {}, loadDrawings: () => [], fib: () => fib, kindName: (k) => k, fmtPrice: (_i, p) => p.toFixed(1), fmtTime: String,
    notify: (n) => notes.push(n.title), isTf: () => true, read: (k) => store[k], write: (k, v) => (store[k] = v), now: () => now,
    candles: async () => hist,
  });
  s.start();
  const r = s.add({ instId: "ETH-USDT-SWAP", target: rsiAt(70), cond: "up", repeat: "once", tf: "1m", note: "" });
  assert.equal(typeof r, "object");
  assert.equal(s.label(r as Alert), "RSI 14 1分 · 向上突破 70");
  assert.deepEqual(s.indicatorLevels("ETH-USDT-SWAP", { type: "rsi", length: 14 }, "1m"), [70]);
  assert.deepEqual(s.indicatorLevels("ETH-USDT-SWAP", { type: "rsi", length: 14 }, "1H"), []); // another timeframe's pane
  assert.deepEqual(s.indicatorLevels("ETH-USDT-SWAP", { type: "rsi", length: 21 }, "1m"), []); // other numbers
  s.onCandle("ETH-USDT-SWAP", bar1m(3600, 100)); // the bars are asked for
  await Promise.resolve();
  await Promise.resolve();
  let p = 100;
  for (let k = 0; k < 6 && !notes.length; k++) {
    now += 60;
    p += 1.5;
    s.onCandle("ETH-USDT-SWAP", bar1m(3600 + (k + 1) * 60, p));
  }
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^ETHUSDT\.P RSI 14 1分：向上突破 70（現值 7\d\.\d\d）$/);
  assert.equal(s.all()[0].on, false); // once: off now
});

test("indicator alert texts: a space where Latin meets Chinese", () => {
  const s = new AlertService({
    watch: () => {}, loadDrawings: () => [], fib: () => fib, kindName: (k) => k, fmtPrice: (_i, p) => p.toFixed(1), fmtTime: String,
    notify: () => {}, isTf: () => true, read: () => undefined, write: () => {}, now: () => 0, candles: async () => [],
  });
  const add = (target: IndTarget, cond: "up" | "touch") => s.add({ instId: "ETH-USDT-SWAP", target, cond, repeat: "once", tf: "1H", note: "" }) as Alert;
  assert.equal(s.label(add({ kind: "indicator", spec: { type: "macd", fast: 12, slow: 26, signal: 9 }, line: "macd", other: "signal" }, "up")), "MACD 12 26 9 1時 · MACD 向上突破訊號線");
  assert.equal(s.label(add({ kind: "indicator", spec: { type: "kd", length: 9, smoothK: 3, smoothD: 3 }, line: "k", other: "d" }, "up")), "KD 9 3 3 1時 · K 向上突破 D");
  assert.equal(s.label(add({ kind: "indicator", spec: { type: "ma", kind: "EMA", length: 20 }, line: "ma" }, "touch")), "EMA20 1時 · 價格觸及 EMA20");
  assert.equal(s.label(add({ kind: "indicator", spec: { type: "boll", length: 20, mult: 2 }, line: "upper" }, "touch")), "布林 20 2 1時 · 價格觸及布林上軌");
});
