// Labels on a chart making room for each other (LabelSpace): what slides, what moves to another place, who goes
// first; a position's labels, the bells of alerts, and the text size settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LabelSpace, layout, PRIO, type Box, type LabelAsk } from "../src/chart/labelspace.ts";
import { computeGeo, type Projector } from "../src/drawings/geo.ts";
import { labelPlans, type PaintOptions } from "../src/drawings/paint.ts";
import { chainPositions } from "../src/drawings/trade.ts";
import { drawingBellAsk, priceBellAsk } from "../src/alerts/layer.ts";
import { cleanAppearance, DEFAULT_APPEARANCE, DEFAULT_POSITION, type Drawing, type FibSettings, type PositionDrawing } from "../src/settings/model.ts";
import type { Candle } from "../src/core/api.ts";

const size = { width: 800, height: 400 };
const ask = (key: string, x: number, y: number, w: number, h: number, prio: number, more: Partial<LabelAsk> = {}): LabelAsk => ({
  key, w, h, at: [{ x, y }], prio, ...more,
});
const place = (layers: Record<string, LabelAsk[]>) => {
  const m = layout(new Map(Object.entries(layers)), size);
  return (layer: string, key: string) => m.get(layer)?.get(key) as Box;
};
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("an indicator line's name slides left past the 高 tag and past another name", () => {
  const at = place({
    // asked first, placed after the tag: priority decides, not the order of the layers
    zones: [
      ask("r1", 800 - 4 - 100, 88, 100, 13, PRIO.indicator, { slide: "left" }),
      ask("r4", 800 - 4 - 80, 90, 80, 13, PRIO.indicator, { slide: "left" }),
    ],
    scale: [ask("hi", 782, 92, 18, 16, PRIO.fixed)],
  });
  assert.deepEqual(at("scale", "hi"), { x: 782, y: 92, w: 18, h: 16 }); // the tag stays
  assert.equal(at("zones", "r1").x, 782 - 2 - 100); // just left of the tag, 2 px apart
  assert.equal(at("zones", "r1").y, 88); // still on its line
  assert.equal(at("zones", "r4").x, 680 - 2 - 80); // and the next one left of that
  assert.ok(!overlaps(at("zones", "r1"), at("zones", "r4")));
});

test("the first free place; with none, the one covering least; off the pane counts double", () => {
  const at = place({
    a: [ask("x", 100, 100, 100, 20, 0)],
    b: [
      { key: "free", w: 50, h: 20, prio: 1, at: [{ x: 120, y: 105 }, { x: 120, y: 140 }] },
      { key: "least", w: 50, h: 20, prio: 2, at: [{ x: 110, y: 100 }, { x: 180, y: 100 }] }, // both cover x; the second less
      { key: "seen", w: 50, h: 20, prio: 3, at: [{ x: 790, y: 300 }, { x: 600, y: 300 }] }, // the first runs off the right edge
    ],
  });
  assert.deepEqual(at("b", "free"), { x: 120, y: 140, w: 50, h: 20 });
  assert.equal(at("b", "least").x, 180);
  assert.equal(at("b", "seen").x, 600);
});

test("places are handed out again after a layer changes", () => {
  let width = 800;
  const space = new LabelSpace(() => ({ width, height: 400 }));
  space.set("zones", [ask("n", 700, 50, 70, 13, PRIO.indicator, { slide: "left" })]);
  assert.equal(space.at("zones", "n")?.x, 700);
  space.set("scale", [ask("hi", 782, 45, 18, 16, PRIO.fixed)]);
  assert.equal(space.at("zones", "n")?.x, 700); // not in the way: 700 + 70 is more than 2 px left of 782
  space.set("scale", [ask("hi", 770, 45, 30, 16, PRIO.fixed)]);
  assert.equal(space.at("zones", "n")?.x, 770 - 2 - 70);
  width = 400;
  assert.equal(space.at("missing", "n"), null);
});

// ----------------------------------------------------------------------------- a position
const pr: Projector = { x: (t) => t / 60, y: (p) => 2000 - p * 10, width: 800, height: 400 };
const fib: FibSettings = { levels: [], extend: false, fill: false, showPrice: false, reverse: false };
const bar = (time: number, low: number, high: number): Candle => ({ time, open: low, high, low, close: high, volume: 1, confirmed: true });
// a long from 180 at 100 (stop 98, take-profit 105), drawn from x 100 to 700
const pos: PositionDrawing = {
  id: "p", kind: "position", a: { t: 6000, p: 180 }, b: { t: 42000, p: 178 }, target: 185, capital: null, risk: 1, riskMode: "pct", leverage: 10,
};
const bars = Array.from({ length: 12 }, (_, i) => bar(6000 + i * 3600, 179.5, 180.5));
const trades = chainPositions(
  [{ id: "p", entryT: 6000, endT: 42000, entry: 180, stop: 178, target: 185, dir: undefined, capital: null, risk: 1, riskMode: "pct", leverage: 10 }],
  bars, 3600, 1000, false,
);
const paint = (orderText: string | null): PaintOptions => ({
  fib, position: DEFAULT_POSITION, fmtPrice: (p) => p.toFixed(1), base: "ETH", times: bars.map((b) => b.time), barSec: 3600, trades,
  orderTag: () => (orderText ? { text: orderText, bg: "#2962ff" } : null), live: () => null, textPx: 11, covers: () => false,
});
const planned = (list: Drawing[], o: PaintOptions, extra: Record<string, LabelAsk[]> = {}) => {
  const geo = computeGeo(list, pr, { fib, rLevels: [1, 2], fmtPrice: o.fmtPrice, trades, active: () => true });
  const plans = labelPlans(geo, o, pr.width, pr.height);
  const at = place({ drawings: plans.map((p) => p.ask), ...extra });
  return { geo, plans, at: (key: string) => at("drawings", key) };
};

test("a position's info starts past its entry handle; the result row past its edge handle", () => {
  const short = { ...pos, b: { t: 24000, p: 178 } }; // to x 400
  const { geo, at } = planned([short], paint("下單"));
  const p = geo[0].pos!;
  assert.equal(at("p:info").x, p.x0 + 10);
  assert.equal(at("p:info").y + at("p:info").h / 2, p.entryY); // on the entry line
  const result = at("p:result");
  assert.ok(result.x >= p.x1 + 10, `${result.x} < ${p.x1 + 10}`);
  assert.ok(result.x >= at("p:info").x + at("p:info").w + 6);
  // nothing the position writes covers anything else it writes
  const boxes = ["p:info", "p:tp", "p:sl", "p:result", "p:R0", "p:R1"].map(at);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]), `${i} / ${j}`);
});

test("a position past the right edge: the result row comes back on screen, clear of the info and the 高 tag", () => {
  const wide = { ...pos, b: { t: 90000, p: 178 } }; // to x 1500, past the 800 px pane
  const tag = ask("hi", 782, 200 - 8, 18, 16, PRIO.fixed); // the visible high at the entry's height
  const { at } = planned([wide], paint("已成交 0.2 張 @ 180.0"), { scale: [tag] });
  const result = at("p:result");
  assert.ok(result.x >= 0 && result.x + result.w <= 800, "on screen");
  assert.ok(!overlaps(result, at("p:info")));
  assert.ok(!overlaps(result, { x: 782, y: 192, w: 18, h: 16 }));
  // R lines' names stay in the pane, at the right end of what is on screen
  assert.ok(at("p:R0").x + at("p:R0").w <= 800 - 4);
});

test("bells make way: a position's bell goes left of its entry; a price alert's slides left of the 高 tag", () => {
  const { geo, plans } = planned([pos], paint(null));
  const g = geo[0];
  const at = place({
    scale: [ask("hi", 782, 92, 18, 16, PRIO.fixed)],
    drawings: plans.map((p) => p.ask),
    alerts: [drawingBellAsk("0", g.ax, g.ay), priceBellAsk("1", 800, 100)],
  });
  const bell = at("alerts", "0");
  assert.ok(!overlaps(bell, at("drawings", "p:info")));
  assert.equal(bell.x + bell.w, g.ax - 10); // left of the entry, clear of its handle
  assert.equal(at("alerts", "1").x, 782 - 2 - 16);
});

test("text sizes: saved, kept in range, older settings get the defaults", () => {
  const old = cleanAppearance({ bg: "#000000" });
  assert.equal(old.labelSize, DEFAULT_APPEARANCE.labelSize);
  assert.equal(old.axisSize, DEFAULT_APPEARANCE.axisSize);
  assert.equal(cleanAppearance({ labelSize: 14, axisSize: 13 }).labelSize, 14);
  assert.equal(cleanAppearance({ labelSize: 40 }).labelSize, 11);
  assert.equal(cleanAppearance({ axisSize: 13.4 }).axisSize, 13);
});

test("what a label keeps off: the next free place first, then sliding past it", () => {
  // keeps off x 600..800 (say, candles); its first place is there, its second free
  const candles = (b: Box) => b.x + b.w > 600;
  const at = place({
    d: [{ key: "r", w: 100, h: 18, prio: PRIO.drawing, avoid: candles, at: [{ x: 680, y: 100 }, { x: 680, y: 300 }, { x: 100, y: 100, slide: "none" }] }],
  });
  assert.deepEqual(at("d", "r"), { x: 100, y: 100, w: 100, h: 18 }); // the third place: the only free one as it is
  // none free as it is: slides left from the first until clear of what it keeps off
  const slid = place({
    d: [{ key: "r", w: 100, h: 18, prio: PRIO.drawing, avoid: candles, at: [{ x: 680, y: 100, slide: "left", range: { min: 300, max: 680 } }] }],
  });
  assert.ok(slid("d", "r").x + 100 <= 600 && slid("d", "r").x >= 300, String(slid("d", "r").x));
});
