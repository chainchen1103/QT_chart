// Drawing geometry and hit-testing without a chart (a straight-line projector stands in for it), and formatting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGeo, hitTest, type Projector } from "../src/drawings/geo.ts";
import { fmtFixed, fmtTick, fmtVol } from "../src/core/format.ts";
import type { Drawing, FibSettings } from "../src/settings/model.ts";

// 1 px per minute from t = 0, 1 px per price unit downward from 200
const pr: Projector = { x: (t) => t / 60, y: (p) => 200 - p, width: 800, height: 400 };
const fib: FibSettings = {
  levels: [{ value: 0, color: "#000000", on: true }, { value: 0.5, color: "#000000", on: true }, { value: 1, color: "#000000", on: true }],
  extend: false, fill: true, showPrice: false, reverse: false,
};
const opts = { fib, rLevels: [1, 2], fmtPrice: (p: number) => p.toFixed(1), trades: new Map(), active: () => false };
const style = { color: "#2962ff", width: 1, dash: "solid" as const };

test("geometry from stored points", () => {
  const list: Drawing[] = [
    { id: "t", kind: "trend", a: { t: 600, p: 100 }, b: { t: 6000, p: 150 }, style },
    { id: "f", kind: "fib", a: { t: 0, p: 100 }, b: { t: 600, p: 200 } },
    { id: "p", kind: "position", a: { t: 6000, p: 100 }, b: { t: 12000, p: 98 }, target: 105, capital: null, risk: 1, riskMode: "pct", leverage: 10 },
  ];
  const [t, f, p] = computeGeo(list, pr, opts);
  assert.deepEqual([t.ax, t.ay, t.bx, t.by], [10, 100, 100, 50]);
  assert.deepEqual(f.fib?.levels.map((l) => l.y), [0, 50, 100]); // levels 0 (second point), 0.5, 1 (first point)
  assert.equal(f.fib?.xr, 10); // not extended: ends at the right point
  // R lines up to the take-profit only: 1R = 102, 2R = 104 (both under 105)
  assert.deepEqual(p.pos?.levels.map((l) => l.price), [102, 104]);
  assert.deepEqual(p.handles.map((h) => h.part), ["a", "stop", "target", "edge"]);
});

test("what the mouse is over", () => {
  const list: Drawing[] = [
    { id: "h", kind: "hline", a: { t: 600, p: 100 }, b: { t: 600, p: 100 }, style },
    { id: "r", kind: "rect", a: { t: 6000, p: 150 }, b: { t: 12000, p: 120 }, style: { border: "#000000", width: 1, dash: "solid", fill: "#000000", transparency: 80, extend: false } },
  ];
  const geo = computeGeo(list, pr, opts);
  assert.deepEqual(hitTest(geo, 400, 103, 800, null), { id: "h", part: "body" }); // 3 px from the line
  assert.equal(hitTest(geo, 400, 110, 800, null), null);
  assert.deepEqual(hitTest(geo, 100, 50, 800, null), { id: "r", part: "a" }); // a corner handle
  assert.deepEqual(hitTest(geo, 150, 65, 800, null), { id: "r", part: "body" });
  assert.equal(hitTest(geo, 150, 65, 800, list[1]), null); // the one being placed is skipped
});

test("formatting", () => {
  assert.equal(fmtFixed(78123.456, 1), "78,123.5");
  assert.equal(fmtVol(1234567), "1.23M");
  assert.equal(fmtVol(42), "42.00");
  const t = Date.UTC(2026, 10, 2, 16, 15) / 1000;
  assert.equal(fmtTick(t as never, 2), "11/2");
  assert.equal(fmtTick(t as never, 3), "16:15");
});

test("Shift: horizontal, vertical, 45°, squares, one axis", async () => {
  const { lockAxis, snapAngle, snapSquare } = await import("../src/drawings/geometry.ts");
  assert.deepEqual(snapAngle(0, 0, 100, 8), { x: 100, y: 0, dir: "h" });
  assert.deepEqual(snapAngle(0, 0, -6, -90), { x: 0, y: -90, dir: "v" });
  assert.deepEqual(snapAngle(0, 0, 100, -80), { x: 90, y: -90, dir: "d" }); // up and to the right, 45°
  assert.deepEqual(snapAngle(10, 10, -50, 80), { x: -55, y: 75, dir: "d" }); // down and to the left
  assert.deepEqual(snapAngle(5, 5, 5, 5), { x: 5, y: 5, dir: "h" });
  assert.deepEqual(snapSquare(0, 0, 100, 40), { x: 100, y: 100 });
  assert.deepEqual(snapSquare(0, 0, -30, 70), { x: -70, y: 70 });
  assert.equal(lockAxis(30, -10), "h");
  assert.equal(lockAxis(3, -10), "v");
});

test("old localStorage data carried over to the files", async () => {
  const { fromLocalStorage } = await import("../src/core/storage.ts");
  const m = fromLocalStorage([
    ["qtchart.drawings.BTC-USDT-SWAP", '[{"id":"a"}]'],
    ["qtchart.instId", "ETH-USDT-SWAP"], // plain text in localStorage, JSON in the files
    ["qtchart.bgimage", "data:image/jpeg;base64,AAAA"],
    ["qtchart.fib", "{broken"], // skipped
    ["qtchart.../x", "1"], // a name the files would refuse
    ["other.key", "1"], // not ours
  ]);
  assert.deepEqual([...m.keys()].sort(), ["bgimage", "drawings.BTC-USDT-SWAP", "instId"]);
  assert.equal(m.get("instId"), '"ETH-USDT-SWAP"');
  assert.equal(m.get("drawings.BTC-USDT-SWAP"), '[{"id":"a"}]');
});

test("a measurement: change in price and %, bars and time, volume of the bars it spans", async () => {
  const { measureLines } = await import("../src/drawings/paint.ts");
  const times = [0, 3600, 7200, 10800, 14400];
  const bars = times.map((time, i) => ({ time, open: 100, high: 101, low: 99, close: 100, volume: 1000 * (i + 1), confirmed: true }));
  const o = { times, barSec: 3600, bars, fmtPrice: (p: number) => p.toFixed(2) };
  // up 5 from 100, bar 1 to bar 3: 2 bars, 2 hours, volume of bars 1..3 = 2000 + 3000 + 4000
  assert.deepEqual(measureLines({ t: 3600, p: 100 }, { t: 10800, p: 105 }, o), ["+5.00 (+5.00%)", "2 根，2時", "成交量 9.00K"]);
  // backwards and down: the same span, the sign of the move
  assert.deepEqual(measureLines({ t: 10800, p: 105 }, { t: 3600, p: 100 }, o), ["−5.00 (−4.76%)", "2 根，2時", "成交量 9.00K"]);
  // past the newest bar: only the bars that are there count
  assert.deepEqual(measureLines({ t: 14400, p: 100 }, { t: 21600, p: 100 }, o), ["+0.00 (+0.00%)", "2 根，2時", "成交量 5.00K"]);
});

test("closed on OKX: the box ends at the close, the exit is OKX's, no handles", () => {
  const closed = { t: 9000, px: 103, pnl: 6 };
  const order = {
    ordId: "1", clOrdId: "c", demo: true, side: "buy" as const, ordType: "limit" as const, px: 100, sz: 1, at: 6000, state: "filled",
    avgPx: 100, fillSz: 1, posKey: "1:1", closed,
  };
  const list: Drawing[] = [
    { id: "p", kind: "position", a: { t: 6000, p: 100 }, b: { t: 30000, p: 80 }, target: 130, capital: null, risk: 1, riskMode: "pct", leverage: 10, order },
  ];
  const [p] = computeGeo(list, pr, opts);
  assert.equal(p.pos?.x1, 150); // 9000 s at 1 px a minute, not the drawn 30000
  assert.deepEqual(p.pos?.exit, { x: 150, y: 97 });
  assert.deepEqual(p.handles, []);
  // only entry to close is drawn, and only that is the drawing under the mouse
  assert.deepEqual(p.pos?.closed, { y: 97, profit: true });
  assert.equal(hitTest([p], 120, 99, 800, null)?.id, "p"); // between the entry (100) and the close (103)
  assert.equal(hitTest([p], 120, 115, 800, null), null); // in the stop zone, no longer drawn
  assert.equal(hitTest([p], 120, 80, 800, null), null); // in the take-profit zone past the close
});

test("inside a shape: the chart pans unless it is selected; its lines, handles and lines under it take the press", () => {
  const rectStyle = { border: "#000000", width: 1, dash: "solid" as const, fill: "#000000", transparency: 80, extend: false };
  const list: Drawing[] = [
    { id: "t", kind: "trend", a: { t: 6600, p: 140 }, b: { t: 11400, p: 140 }, style }, // under the rectangle: y 60
    { id: "r", kind: "rect", a: { t: 6000, p: 150 }, b: { t: 12000, p: 120 }, style: rectStyle }, // x 100 to 200, y 50 to 80
    { id: "p", kind: "position", a: { t: 24000, p: 100 }, b: { t: 36000, p: 90 }, target: 130, capital: null, risk: 1, riskMode: "pct", leverage: 10 },
  ];
  const geo = computeGeo(list, pr, opts);
  const none = () => false;
  assert.deepEqual(hitTest(geo, 150, 70, 800, null, none), { id: "r", part: "body", inside: true }); // pans, a click selects it
  assert.deepEqual(hitTest(geo, 150, 60, 800, null, none), { id: "t", part: "body" }); // the line under it
  assert.deepEqual(hitTest(geo, 150, 52, 800, null, none), { id: "r", part: "body" }); // its border
  assert.deepEqual(hitTest(geo, 100, 50, 800, null, none), { id: "r", part: "a" }); // a corner
  assert.deepEqual(hitTest(geo, 150, 70, 800, null, (d) => d.id === "r"), { id: "r", part: "body" }); // selected: moved from inside
  // a position: entry 100 at y 100, stop 90 at y 110, take-profit 130 at y 70, x 400 to 600
  assert.deepEqual(hitTest(geo, 500, 85, 800, null, none), { id: "p", part: "body", inside: true });
  assert.deepEqual(hitTest(geo, 500, 72, 800, null, none), { id: "p", part: "body" }); // on the take-profit line
  assert.deepEqual(hitTest(geo, 500, 101, 800, null, none), { id: "p", part: "body" }); // on the entry line
  assert.equal(hitTest(geo, 500, 140, 800, null, none), null);
});

test("R lines on a position drawn from OKX: while it is open, with a stop-loss there", () => {
  const okx = { posId: "1", cTime: 0, side: "long" as const, demo: true, coins: 1, lever: 10, noSl: false, noTp: false };
  const at = { a: { t: 6000, p: 100 }, b: { t: 12000, p: 98 }, target: 105, capital: null, risk: 1, riskMode: "pct" as const, leverage: 10, dir: 1 as const };
  const [open, noSl, closed] = computeGeo(
    [
      { id: "o", kind: "position", ...at, okx },
      { id: "n", kind: "position", ...at, okx: { ...okx, noSl: true } },
      { id: "c", kind: "position", ...at, okx: { ...okx, closed: { t: 9000, px: 104, pnl: 4 } } },
    ],
    pr,
    opts,
  );
  assert.deepEqual(open.pos?.levels.map((l) => l.price), [102, 104]);
  assert.deepEqual(noSl.pos?.levels, []); // its stop is a stand-in next to the entry
  assert.deepEqual(closed.pos?.levels, []);
});
