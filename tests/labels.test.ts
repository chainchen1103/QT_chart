// Labels on a chart making room for each other (LabelSpace): what slides, what moves to another place, who goes
// first; a position's labels, the bells of alerts, and the text size settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LabelSpace, layout, PRIO, type Box, type LabelAsk } from "../src/chart/labelspace.ts";
import { computeGeo, type Projector } from "../src/drawings/geo.ts";
import { labelPlans, type PaintOptions } from "../src/drawings/paint.ts";
import { chainPositions } from "../src/drawings/trade.ts";
import { drawingBellAsk, priceBellAsk } from "../src/alerts/layer.ts";
import { cleanAppearance, cleanPosition, DEFAULT_APPEARANCE, DEFAULT_POSITION, type Drawing, type FibSettings, type PositionDrawing } from "../src/settings/model.ts";
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

test("a position's info: past the stop line at the right, the stop label at the left; the result past the edge handle", () => {
  const narrow = { ...pos, b: { t: 24000, p: 178 } }; // to x 400: too narrow for the stop label and the info side by side
  const { geo, at } = planned([narrow], paint("下單"));
  const p = geo[0].pos!;
  const info = at("p:info");
  const sl = at("p:sl");
  assert.equal(sl.x, p.x0 + 10); // the stop label at the left end of its row, past the handle
  assert.equal(sl.y, p.stopY + 4); // a long: under the stop line, outside the box
  assert.equal(info.x + info.w, p.x1 - 4); // the info at the right end
  assert.equal(info.y, sl.y + sl.h + 3); // a row further out
  const result = at("p:result");
  assert.ok(result.x >= p.x1 + 10, `${result.x} < ${p.x1 + 10}`);
  // nothing the position writes covers anything else it writes
  const boxes = ["p:info", "p:tp", "p:sl", "p:result", "p:R0", "p:R1"].map(at);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlaps(boxes[i], boxes[j]), `${i} / ${j}`);
  // wide enough: on the stop label's row; a short: over its stop line
  const wide = planned([{ ...pos, a: { t: 6000, p: 180 }, b: { t: 42000, p: 182 }, target: 175 }], paint(null));
  const q = wide.geo[0].pos!;
  const wi = wide.at("p:info");
  assert.equal(wi.x + wi.w, q.x1 - 4);
  assert.equal(wi.y + wi.h, q.stopY - 4);
  assert.ok(!overlaps(wi, wide.at("p:sl")));
});

test("the info shows all the time, or only while the position is pointed at", () => {
  const hover = { ...paint(null), position: { ...DEFAULT_POSITION, infoHover: true } };
  const geo = computeGeo([pos], pr, { fib, rLevels: [1, 2], fmtPrice: hover.fmtPrice, trades, active: () => false });
  assert.ok(!labelPlans(geo, hover, 800, 400).some((x) => x.ask.key === "p:info"));
  assert.ok(labelPlans(geo, paint(null), 800, 400).some((x) => x.ask.key === "p:info"));
  assert.equal(DEFAULT_POSITION.infoHover, false);
});

test("a position closed on OKX: its result shows as the info box does", () => {
  const closed: PositionDrawing = {
    ...pos,
    order: {
      ordId: "1", clOrdId: "c", demo: true, side: "buy", ordType: "limit", px: 180, sz: 1, at: 6000, state: "filled", avgPx: 180, fillSz: 1,
      posKey: "1:1", closed: { t: 20000, px: 183, pnl: 3 },
    },
  };
  const keys = (infoHover: boolean, active: boolean) => {
    const o = { ...paint("已成交 1 張 @ 180.0"), position: { ...DEFAULT_POSITION, infoHover } };
    const geo = computeGeo([closed], pr, { fib, rLevels: [1, 2], fmtPrice: o.fmtPrice, trades, active: () => active });
    return labelPlans(geo, o, 800, 400).map((x) => x.ask.key);
  };
  assert.ok(keys(false, false).includes("p:result")); // 一直顯示資訊框: there all the time
  assert.ok(!keys(true, false).includes("p:result")); // only while pointed at or selected
  assert.ok(keys(true, true).includes("p:result"));
  // the black info box of a record: only when asked for, as before
  assert.ok(!keys(false, false).includes("p:info"));
  assert.ok(keys(true, true).includes("p:info"));
  // a position still open keeps its result (and its order button) whatever the setting
  const open = { ...paint("下單"), position: { ...DEFAULT_POSITION, infoHover: true } };
  const geo = computeGeo([pos], pr, { fib, rLevels: [1, 2], fmtPrice: open.fmtPrice, trades, active: () => false });
  assert.ok(labelPlans(geo, open, 800, 400).some((x) => x.ask.key === "p:result"));
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

test("bells make way: next to a drawing's first point where its labels leave room; a price alert's left of the 高 tag", () => {
  const { geo, plans } = planned([pos], paint(null));
  const g = geo[0];
  const at = place({
    scale: [ask("hi", 782, 92, 18, 16, PRIO.fixed)],
    // something already above right of the entry: the bell goes left of it
    other: [ask("x", g.ax, g.ay - 30, 60, 26, PRIO.pinned)],
    drawings: plans.map((p) => p.ask),
    alerts: [drawingBellAsk("0", g.ax, g.ay), priceBellAsk("1", 800, 100)],
  });
  const bell = at("alerts", "0");
  for (const key of ["p:info", "p:tp", "p:sl", "p:result"]) assert.ok(!overlaps(bell, at("drawings", key)), key);
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

test("顯示歷史倉位: on unless turned off, kept when other settings are saved", () => {
  assert.equal(DEFAULT_POSITION.showClosed, true);
  assert.equal(cleanPosition(undefined).showClosed, true);
  assert.equal(cleanPosition({}).showClosed, true); // saved before the setting existed
  assert.equal(cleanPosition({ showClosed: false }).showClosed, false);
  assert.equal(cleanPosition({ showClosed: "no" }).showClosed, true);
  assert.equal(cleanPosition({ ...DEFAULT_POSITION, showClosed: false, infoHover: true }).showClosed, false);
});
