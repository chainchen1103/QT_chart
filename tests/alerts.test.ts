// Price alerts: price ranges between snapshots, drawings read as levels, zones, times and trades.
import { test } from "node:test";
import assert from "node:assert/strict";
import { barStart, describe, evaluate, levelHit, moveSince, shapeAt, tradeStep, type Move } from "../src/alerts/engine.ts";
import { cleanAlerts, condsFor, type Alert } from "../src/alerts/model.ts";
import type { Drawing, FibSettings } from "../src/settings.ts";

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
