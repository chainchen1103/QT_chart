// Channels: parallel channel, regression trend, flat top/bottom, disjoint channel; their lines in proportion to
// the width, where they are on screen, what the mouse is over, the saved data, and alerts on them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGeo, extendSeg, hitTest, type Projector } from "../src/drawings/geo.ts";
import { fitLine, lowerUpper, secondLine, secondThrough, widthLine, type Anchor } from "../src/drawings/geometry.ts";
import { cleanDrawStyles, cleanDrawings, defaultChannelStyle, type ChannelDrawing, type ChannelKind, type ChannelStyle, type FibSettings } from "../src/settings/model.ts";
import { describe, evaluate, shapeAt } from "../src/alerts/engine.ts";
import { condsFor, type Alert } from "../src/alerts/model.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const A = (t: number, p: number): Anchor => ({ t, p });

// 1 px per minute from t = 0, 1 px per price unit downward from 200
const pr: Projector = { x: (t) => t / 60, y: (p) => 200 - p, width: 800, height: 400 };
const fib: FibSettings = { levels: [], extend: false, fill: false, showPrice: false, reverse: false };
const opts = { fib, rLevels: [], fmtPrice: (p: number) => p.toFixed(1), trades: new Map(), active: () => false };
const channel = (kind: ChannelKind, a: Anchor, b: Anchor, c: Anchor, style: Partial<ChannelStyle> = {}): ChannelDrawing => ({
  id: kind, kind, a, b, c, style: { ...defaultChannelStyle(kind), ...style },
});

test("the second line: parallel, level or mirrored, through the point placed", () => {
  const a = A(0, 100);
  const b = A(100, 200); // rises 1 per second
  assert.deepEqual(secondLine("channel", a, b, A(0, 120)), [A(0, 120), A(100, 220)]);
  assert.deepEqual(secondLine("flat", a, b, A(0, 120)), [A(0, 120), A(100, 120)]);
  assert.deepEqual(secondLine("disjoint", a, b, A(0, 120)), [A(0, 120), A(100, 20)]); // the same move the other way
  // where c goes so the second line passes through (50, 170)
  assert.equal(secondThrough("channel", a, b, A(50, 170)), 120);
  assert.equal(secondThrough("flat", a, b, A(50, 170)), 170);
  assert.equal(secondThrough("disjoint", a, b, A(50, 170)), 220);
  for (const k of ["channel", "flat", "disjoint"] as const) {
    const [c0, c1] = secondLine(k, a, b, A(0, secondThrough(k, a, b, A(50, 170))));
    close(c0.p + ((c1.p - c0.p) * 50) / 100, 170);
  }
  assert.equal(secondThrough("channel", a, A(0, 150), A(70, 130)), 130); // a first line standing up counts as level
});

test("lines in proportion to the width, counted up from the lower line", () => {
  const lower: [Anchor, Anchor] = [A(0, 100), A(100, 110)];
  const upper: [Anchor, Anchor] = [A(0, 120), A(100, 130)];
  assert.deepEqual(lowerUpper(upper, lower), [lower, upper]);
  assert.deepEqual(widthLine(lower, upper, 0.5), [A(0, 110), A(100, 120)]); // halfway
  assert.deepEqual(widthLine(lower, upper, 1), upper); // on the upper line
  assert.deepEqual(widthLine(lower, upper, 0), lower);
  assert.deepEqual(widthLine(lower, upper, -1), [A(0, 80), A(100, 90)]); // one width under the lower line
  assert.deepEqual(widthLine(lower, upper, 2), [A(0, 140), A(100, 150)]); // one width over the upper line
  // lines that cross: the one lower halfway along is the lower one; a level follows the width at each end
  const rising: [Anchor, Anchor] = [A(0, 90), A(100, 150)];
  const level: [Anchor, Anchor] = [A(0, 110), A(100, 110)];
  assert.deepEqual(lowerUpper(rising, level), [level, rising]);
  assert.deepEqual(widthLine(level, rising, 0.5), [A(0, 100), A(100, 130)]);
});

test("regression: least squares through the closes, standard deviation and Pearson's R", () => {
  const closes = [1, 3, 2, 5, 4];
  const f = fitLine(closes.length, (i) => closes[i], 0, 4)!;
  close(f.p0, 1.4);
  close(f.p1, 4.6);
  close(f.sd, Math.sqrt(3.6 / 4)); // residuals −0.4, 0.8, −1, 1.2, −0.6
  close(f.r, 0.8);
  const back = fitLine(closes.length, (i) => closes[i], 4, 0)!; // drawn right to left
  close(back.p0, 4.6);
  close(back.p1, 1.4);
  const down = fitLine(4, (i) => 10 - 2 * i, 0, 3)!; // on a straight line
  close(down.sd, 0);
  close(down.r, -1);
  close(down.p1, 4);
  // past the newest bar: fitted on the bars there are, the line goes on
  const on = fitLine(4, (i) => 10 + i, 1, 6)!;
  close(on.p0, 11);
  close(on.p1, 16);
  assert.equal(fitLine(5, (i) => closes[i], -2, 3), null); // its first bar isn't loaded
  assert.equal(fitLine(5, (i) => closes[i], 2, 2), null); // one bar
  assert.equal(fitLine(5, (i) => closes[i], 6, 9), null); // all after the newest bar
});

test("extending a line to the pane's edges", () => {
  assert.deepEqual(extendSeg({ x0: 100, y0: 50, x1: 10, y1: 140 }, false, false, 800), { x0: 10, y0: 140, x1: 100, y1: 50 });
  const e = extendSeg({ x0: 10, y0: 100, x1: 100, y1: 10 }, true, true, 800);
  assert.deepEqual([e.x0, e.x1], [-8, 808]);
  close(e.y0, 118);
  close(e.y1, -698);
  assert.deepEqual(extendSeg({ x0: 5, y0: 1, x1: 5, y1: 9 }, true, true, 800), { x0: 5, y0: 1, x1: 5, y1: 9 }); // standing up
});

test("a parallel channel on screen: handles, lower and upper line, its proportional lines", () => {
  const d = channel("channel", A(600, 100), A(6000, 150), A(600, 140), { levels: [{ value: -1, on: true }, { value: 2, on: false }] });
  const [g] = computeGeo([d], pr, opts);
  assert.deepEqual(g.handles.map((h) => [h.part, h.x, h.y]), [["a", 10, 100], ["b", 100, 50], ["c", 10, 60], ["d", 100, 10]]);
  assert.deepEqual(g.ch?.lines, [{ x0: 10, y0: 100, x1: 100, y1: 50 }, { x0: 10, y0: 60, x1: 100, y1: 10 }]);
  assert.deepEqual(g.ch?.mid, { x0: 10, y0: 80, x1: 100, y1: 30 });
  assert.deepEqual(g.ch?.levels, [{ seg: { x0: 10, y0: 140, x1: 100, y1: 90 }, value: -1 }]); // 2 is off
  assert.deepEqual(g.ch?.marks.map((m) => m.p), [100, 150, 140, 190]);
  // being placed, before its second line: only the first line and its ends
  const [p] = computeGeo([d], pr, { ...opts, firstOnly: d.id });
  assert.deepEqual(p.handles.map((h) => h.part), ["a", "b"]);
  assert.equal(p.ch?.mid, null);
  assert.deepEqual(p.ch?.levels, []);
});

test("flat top/bottom and disjoint channel on screen", () => {
  const [f, j] = computeGeo([
    channel("flat", A(600, 100), A(6000, 150), A(600, 160)),
    channel("disjoint", A(600, 100), A(6000, 150), A(600, 90)),
  ], pr, opts);
  assert.deepEqual(f.ch?.lines, [{ x0: 10, y0: 100, x1: 100, y1: 50 }, { x0: 10, y0: 40, x1: 100, y1: 40 }]);
  // the mirrored line falls as much as the first rises, and it is the lower one
  assert.deepEqual(j.ch?.lines, [{ x0: 10, y0: 110, x1: 100, y1: 160 }, { x0: 10, y0: 100, x1: 100, y1: 50 }]);
  assert.deepEqual(j.handles.map((h) => [h.part, h.y]), [["a", 100], ["b", 50], ["c", 110], ["d", 160]]);
});

test("a regression trend on screen: fitted to the bars, or as last fitted", () => {
  const d: ChannelDrawing = { ...channel("regression", A(600, 0), A(6000, 0), A(600, 0), { dev: 2 }), fit: { sd: 1, r: 0.5 } };
  const [g] = computeGeo([d], pr, { ...opts, fit: () => ({ p0: 100, p1: 150, sd: 5, r: 0.9 }) });
  assert.deepEqual(g.handles.map((h) => [h.part, h.x, h.y]), [["a", 10, 100], ["b", 100, 50]]); // on the fitted line
  assert.deepEqual(g.ch?.lines, [{ x0: 10, y0: 110, x1: 100, y1: 60 }, { x0: 10, y0: 90, x1: 100, y1: 40 }]); // ±2 × 5
  assert.equal(g.ch?.r, 0.9);
  assert.deepEqual(g.ch?.marks.map((m) => m.p), [100, 150]);
  const kept = { ...d, a: A(600, 120), b: A(6000, 130) };
  const [h] = computeGeo([kept], pr, { ...opts, fit: () => null }); // the bars don't reach back to it
  assert.deepEqual(h.ch?.lines, [{ x0: 10, y0: 82, x1: 100, y1: 72 }, { x0: 10, y0: 78, x1: 100, y1: 68 }]); // ±2 × 1
  assert.equal(h.ch?.r, 0.5);
});

test("what the mouse is over on a channel", () => {
  const d = channel("channel", A(600, 100), A(6000, 150), A(600, 140), { levels: [{ value: -1, on: true }] });
  const geo = computeGeo([d], pr, opts);
  // at x = 55: lower line y 75, middle 55, upper 35, the −1 line 115 (one width of 40 under the lower line)
  assert.deepEqual(hitTest(geo, 55, 65, 800, null), { id: d.id, part: "body" }); // in the fill
  assert.deepEqual(hitTest(geo, 55, 115, 800, null), { id: d.id, part: "body" }); // on the −1 line
  assert.equal(hitTest(geo, 55, 95, 800, null), null); // between the lower line and the −1 line
  assert.equal(hitTest(geo, 200, 0, 800, null), null); // past its end
  assert.deepEqual(hitTest(geo, 10, 60, 800, null), { id: d.id, part: "c" });
  const clear = computeGeo([{ ...d, style: { ...d.style, transparency: 100 } }], pr, opts);
  assert.equal(hitTest(clear, 55, 65, 800, null), null); // no fill: only its lines
  assert.deepEqual(hitTest(clear, 55, 56, 800, null), { id: d.id, part: "body" }); // the middle line
  const long = computeGeo([{ ...d, style: { ...d.style, extendRight: true } }], pr, opts);
  assert.deepEqual(hitTest(long, 200, -20, 800, null), { id: d.id, part: "body" }); // extended: in the fill further on
});

test("channels as saved: the third point at the first one's time, styles checked", () => {
  const [c, bare, reg, odd] = cleanDrawings([
    {
      id: "c", kind: "channel", a: { t: 600, p: 100 }, b: { t: 6000, p: 150 }, c: { t: 999, p: 120 },
      style: { color: "#ff0000", width: 9, levels: [{ value: 2 }, { value: 0.5, on: false }, { value: 0.5 }, { value: "x" }, { value: 11 }] },
    },
    { id: "f", kind: "flat", a: { t: 600, p: 100 }, b: { t: 6000, p: 150 } },
    { id: "r", kind: "regression", a: { t: 600, p: 100 }, b: { t: 6000, p: 150 }, fit: { sd: 3, r: 2 }, style: { dev: 50, pearson: false } },
    { id: "d", kind: "disjoint", a: { t: 600, p: 100 }, b: { t: 6000, p: 150 }, fit: { sd: 3, r: 0.5 } },
  ]) as ChannelDrawing[];
  assert.deepEqual(c.c, { t: 600, p: 120 });
  assert.equal(c.style.color, "#ff0000");
  assert.equal(c.style.width, 1); // 9 px isn't offered
  assert.deepEqual(c.style.levels, [{ value: 0.5, on: false }, { value: 2, on: true }]); // sorted, no repeats, in range
  assert.deepEqual(bare.c, { t: 600, p: 100 });
  assert.equal(bare.style.middle, false);
  assert.deepEqual(reg.fit, { sd: 3, r: 1 });
  assert.equal(reg.style.dev, 2); // out of range
  assert.equal(reg.style.pearson, false);
  assert.equal(reg.style.middle, true);
  assert.equal(odd.fit, undefined); // only regression trends are fitted
  const styles = cleanDrawStyles({ channel: { color: "#00ff00", levels: [{ value: -1 }] }, flat: 5 });
  assert.equal(styles.channel?.color, "#00ff00");
  assert.deepEqual(styles.channel?.levels, [{ value: -1, on: true }]);
  assert.equal(styles.flat, undefined);
});

test("alerts on channels: their lines, or the space between them", () => {
  const name = (k: string) => ({ channel: "平行通道", regression: "迴歸趨勢" })[k] ?? k;
  // 100 -> 110 over 10 bars of 15 minutes, the second line 20 over it; read at the start of the current bar
  const d = channel("channel", A(0, 100), A(9000, 110), A(0, 120), { levels: [{ value: -1, on: true }, { value: 3, on: false }] });
  const s = shapeAt(d, 4500 + 300, "15m", fib, name, "touch");
  assert.equal(s?.type, "levels");
  if (s?.type === "levels") {
    assert.deepEqual(s.levels.map((l) => l.name), ["平行通道下緣", "平行通道上緣", "平行通道中線", "平行通道 -1"]);
    [105, 125, 115, 85].forEach((p, k) => close(s.levels[k].price, p));
  }
  assert.deepEqual(shapeAt(d, 4800, "15m", fib, name, "exit"), { type: "box", top: 125, bottom: 105, name: "平行通道" });
  const later = shapeAt(d, 18000 + 100, "15m", fib, name, "enter"); // continued past its end
  assert.ok(later?.type === "box" && Math.abs(later.top - 140) < 1e-9 && Math.abs(later.bottom - 120) < 1e-9);
  assert.equal(shapeAt(d, -5, "15m", fib, name, "touch"), null);
  assert.equal(shapeAt({ ...d, b: A(0, 110) }, 4800, "15m", fib, name, "touch"), null); // standing straight up
  // a regression trend: as last fitted, its outer lines dev standard deviations away
  const r: ChannelDrawing = { ...channel("regression", A(0, 100), A(9000, 110), A(0, 100), { dev: 2, middle: false }), fit: { sd: 2, r: 0.9 } };
  const rs = shapeAt(r, 4800, "15m", fib, name, "touch");
  assert.ok(rs?.type === "levels" && rs.levels.length === 2);
  if (rs?.type === "levels") [101, 109].forEach((p, k) => close(rs.levels[k].price, p));
  // leaving it goes off, and says which drawing
  const alert: Alert = {
    id: "a", instId: "BTC-USDT-SWAP", target: { kind: "drawing", id: d.id }, cond: "exit", repeat: "once", tf: "15m",
    note: "", on: true, created: 0, fired: null, count: 0,
  };
  const out = evaluate(alert, { type: "box", top: 125, bottom: 105, name: "平行通道" }, { from: 110, lo: 104, hi: 110, price: 104 }, 1);
  assert.equal(out.events.length, 1);
  assert.equal(describe(out.events[0], (p) => p.toFixed(1), String), "離開平行通道（105.0～125.0）");
  assert.deepEqual(condsFor("disjoint"), ["exit", "enter", "touch", "up", "down"]);
});
