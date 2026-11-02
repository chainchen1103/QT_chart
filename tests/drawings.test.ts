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
