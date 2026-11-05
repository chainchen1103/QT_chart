// Undo and redo of the drawings: steps, merged changes, redo cleared by a new change, orders left alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DrawingHistory, MAX_STEPS, MERGE_MS } from "../src/drawings/history.ts";
import type { Drawing, PositionDrawing, PositionOrder } from "../src/settings/model.ts";

const line = (id: string, p: number): Drawing => ({
  id, kind: "trend", a: { t: 0, p }, b: { t: 60, p: p + 1 }, style: { color: "#ffffff", width: 1, dash: "solid" },
});
const pos = (id: string, entry: number, order?: PositionOrder): PositionDrawing => ({
  id, kind: "position", a: { t: 0, p: entry }, b: { t: 600, p: entry - 1 }, target: entry + 2,
  capital: null, risk: 1, riskMode: "pct", leverage: 10, ...(order ? { order } : {}),
});
const order = (state: string): PositionOrder => ({
  ordId: "1", clOrdId: "qtc1", demo: true, side: "buy", ordType: "limit", px: 100, sz: 1, at: 0, state, avgPx: null, fillSz: 0,
});
const prices = (list: Drawing[] | null) => list?.map((d) => d.a.p) ?? null;

test("undo and redo step through the changes; a new change drops what was undone", () => {
  const h = new DrawingHistory(() => 0);
  h.start("BTC", []);
  h.record("BTC", [line("a", 1)]); // added
  h.record("BTC", [line("a", 2)]); // moved
  h.record("BTC", [line("a", 2), line("b", 5)]); // another
  assert.deepEqual(prices(h.undo("BTC")), [2]);
  assert.deepEqual(prices(h.undo("BTC")), [1]);
  assert.deepEqual(prices(h.redo("BTC")), [2]);
  h.record("BTC", [line("a", 3)]); // a new change: the undone one is gone
  assert.equal(h.redo("BTC"), null);
  assert.deepEqual(prices(h.undo("BTC")), [2]);
  assert.deepEqual(prices(h.undo("BTC")), [1]);
  assert.deepEqual(h.undo("BTC"), []);
  assert.equal(h.undo("BTC"), null); // back at the start
  // each symbol on its own; a symbol that has a history keeps it when its drawings are loaded again
  h.start("ETH", [line("e", 9)]);
  assert.equal(h.undo("ETH"), null);
  h.start("BTC", [line("x", 7)]);
  assert.deepEqual(prices(h.redo("BTC")), [1]);
});

test("what is returned is a copy; no step for nothing changed", () => {
  const h = new DrawingHistory(() => 0);
  const list = [line("a", 1)];
  h.start("BTC", list);
  list[0].a.p = 4; // the chart moves its own objects
  h.record("BTC", list);
  const back = h.undo("BTC")!;
  assert.deepEqual(prices(back), [1]);
  back[0].a.p = 99;
  const again = h.redo("BTC")!;
  assert.deepEqual(prices(again), [4]);
  h.record("BTC", again); // the same as now: no step
  assert.deepEqual(prices(h.undo("BTC")), [1]);
});

test("a change that goes on is one step; after a pause, or another change, a new one", () => {
  let now = 0;
  const h = new DrawingHistory(() => now);
  h.start("BTC", [line("a", 1)]);
  for (let i = 2; i <= 6; i++) {
    now += 50;
    h.record("BTC", [line("a", i)], "style:a"); // a color dragged across the picker
  }
  now += MERGE_MS + 1;
  h.record("BTC", [line("a", 7)], "style:a"); // after a pause: a step of its own
  now += 10;
  h.record("BTC", [line("a", 8)]); // no name: always a step
  assert.deepEqual(prices(h.undo("BTC")), [7]);
  assert.deepEqual(prices(h.undo("BTC")), [6]);
  assert.deepEqual(prices(h.undo("BTC")), [1]);
});

test("orders from the exchange are not undone; only so many steps are kept", () => {
  const h = new DrawingHistory(() => 0);
  h.start("BTC", [pos("p", 100)]);
  h.quiet("BTC", [pos("p", 100, order("live"))]); // order placed: no step
  assert.equal(h.undo("BTC"), null);
  h.record("BTC", [pos("p", 101, order("live"))]); // moved
  h.quiet("BTC", [pos("p", 101, order("filled"))]); // filled meanwhile
  const back = h.undo("BTC")!;
  assert.equal(back[0].a.p, 100);
  assert.equal((back[0] as PositionDrawing).order?.state, "filled");
  // deleted, then brought back: with the order it had
  h.record("BTC", []);
  assert.equal((h.undo("BTC")![0] as PositionDrawing).order?.state, "filled");

  const many = new DrawingHistory(() => 0);
  many.start("BTC", []);
  for (let i = 1; i <= MAX_STEPS + 20; i++) many.record("BTC", [line("a", i)]);
  let n = 0;
  while (many.undo("BTC")) n++;
  assert.equal(n, MAX_STEPS);
});

test("the 還原 / 重做 buttons: whether there is a step each way, told when that may have changed", () => {
  let told = 0;
  const h = new DrawingHistory(() => 0, () => told++);
  assert.equal(h.canUndo("BTC"), false); // nothing loaded yet
  h.start("BTC", []);
  assert.deepEqual([h.canUndo("BTC"), h.canRedo("BTC")], [false, false]);
  h.record("BTC", [line("a", 1)]);
  assert.deepEqual([h.canUndo("BTC"), h.canRedo("BTC"), told], [true, false, 1]);
  h.record("BTC", [line("a", 1)]); // nothing changed: no step, nothing told
  assert.equal(told, 1);
  h.undo("BTC");
  assert.deepEqual([h.canUndo("BTC"), h.canRedo("BTC"), told], [false, true, 2]);
  h.quiet("BTC", [line("o", 4)]); // an order's state: no step of its own
  assert.deepEqual([h.canUndo("BTC"), h.canRedo("BTC"), told], [false, true, 2]);
  h.redo("BTC");
  assert.deepEqual([h.canUndo("BTC"), h.canRedo("BTC"), told], [true, false, 3]);
  assert.equal(h.canUndo("ETH"), false); // each symbol its own
});
