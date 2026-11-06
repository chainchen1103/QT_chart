// Matching the OKX account to the positions on the chart: positions opened elsewhere, orders of ours, stop-losses
// moved on OKX, positions closed, an add moving the earlier stops, the chart's edits going to OKX.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SyncAlgo, SyncOrder, SyncPos } from "../src/core/api.ts";
import type { Drawing, PositionDrawing, PositionOrder } from "../src/settings/model.ts";
import {
  applyClosed, applySync, findClosed, isLive, posKeyOf, priceArg, stepDecimals, stopEdits, stopMoves, type SymbolState,
} from "../src/trade/syncmodel.ts";

const NOW = 1_793_700_000; // s
const pos = (o: Partial<SyncPos> = {}): SyncPos => ({
  instId: "BTC-USDT-SWAP", posId: "101", posSide: "net", pos: 3, avgPx: 78000, upl: 12, markPx: 78040, liqPx: null,
  lever: 10, mgnMode: "isolated", cTime: 1_793_600_000_000, uTime: 1_793_600_000_000, ...o,
});
const algo = (o: Partial<SyncAlgo> = {}): SyncAlgo => ({
  instId: "BTC-USDT-SWAP", algoId: "9001", algoClOrdId: "", ordType: "conditional", side: "sell", posSide: "net", sz: 3,
  closeFraction: false, sl: 77000, tp: 80000, cTime: 1, ...o,
});
const state = (positions: SyncPos[], algos: SyncAlgo[]): SymbolState => ({ instId: "BTC-USDT-SWAP", demo: true, positions, algos, tick: 0.1, ctVal: 0.01 });
const order = (o: Partial<PositionOrder> = {}): PositionOrder => ({
  ordId: "700", clOrdId: "qtc1", demo: true, side: "buy", ordType: "limit", px: 78000, sz: 3, at: 1_793_599_000, state: "live",
  avgPx: null, fillSz: 0, sl: 77000, tp: 80000, algoClOrdId: "qts1", ...o,
});
const drawn = (id: string, o?: PositionOrder, entry = 78000, stop = 77000, target = 80000): PositionDrawing => ({
  id, kind: "position", a: { t: 1_793_599_000, p: entry }, b: { t: 1_793_700_000, p: stop }, target, capital: null, risk: 1,
  riskMode: "pct", leverage: 10, ...(o ? { order: o } : {}),
});
const upd = (o: Partial<SyncOrder>): SyncOrder => ({
  instId: "BTC-USDT-SWAP", ordId: "700", clOrdId: "qtc1", state: "filled", side: "buy", px: 78000, sz: 3, accFillSz: 3, avgPx: 78000,
  fillTime: 1_793_600_000_100, uTime: 1_793_600_000_100, sl: null, tp: null, attachAlgoClOrdId: "qts1", ...o,
});
const fmt = (p: number) => p.toFixed(1);

test("a position opened elsewhere is drawn, kept up to date, and ends when it closes", () => {
  const list: Drawing[] = [];
  const s = state([pos()], [algo()]);
  const r = applySync(list, s, [], NOW);
  assert.equal(r.changed, true);
  const d = list[0] as PositionDrawing;
  assert.equal(d.okx!.side, "long");
  assert.equal(d.okx!.coins, 0.03); // 3 contracts of 0.01 BTC
  assert.deepEqual([d.a.p, d.b.p, d.target, d.dir, d.okx!.noSl], [78000, 77000, 80000, 1, false]);
  assert.equal(d.a.t, 1_793_600_000);
  assert.ok(d.b.t > NOW); // open: the box runs past now
  // nothing new: no change
  assert.equal(applySync(list, s, [], NOW).changed, false);
  // OKX: the stop moved above the entry (a profit locked in), an add moved the average
  const later = state([pos({ avgPx: 78100, pos: 5 })], [algo({ sl: 78300 })]);
  assert.equal(applySync(list, later, [], NOW).changed, true);
  assert.deepEqual([d.a.p, d.b.p, d.dir, d.okx!.coins], [78100, 78300, 1, 0.05]);
  // a short with no stop-loss and no take-profit: stand-ins next to the entry, not drawn
  const short = applySync([], state([pos({ pos: -2 })], []), [], NOW);
  assert.equal(short.changed, true);
  // gone from OKX: how it ended is looked up; then the box ends there
  const r2 = applySync(list, state([], []), [], NOW);
  assert.deepEqual(r2.gone, [{ posId: "101", cTime: 1_793_600_000_000 }]);
  const end = findClosed([{ instId: "BTC-USDT-SWAP", posId: "101", direction: "long", cTime: 1_793_600_000_000, uTime: 1_793_650_000_000, openAvgPx: 78100, closeAvgPx: 78300, realizedPnl: 9.8, kind: "2" }], r2.gone[0])!;
  assert.deepEqual(end, { t: 1_793_650_000, px: 78300, pnl: 9.8 });
  assert.equal(applyClosed(list, posKeyOf(r2.gone[0]), end), true);
  assert.deepEqual([d.okx!.closed, d.b.t], [end, 1_793_650_000]);
  assert.equal(applySync(list, state([], []), [], NOW).gone.length, 0); // closed: not looked up again
});

test("orders of ours: attached stops, the position they go into, stops moved on OKX", () => {
  const d = drawn("p1", order());
  const list: Drawing[] = [d];
  // waiting to fill: its attached stop moved on OKX
  applySync(list, state([], []), [upd({ state: "live", accFillSz: 0, sl: 77200, tp: 80000 })], NOW);
  assert.deepEqual([d.b.p, d.dir, d.order!.state], [77200, 1, "live"]);
  // filled: it went into the open long; its TP/SL order is found by the id it was given; OKX moved the stop
  const s = state([pos()], [algo({ algoClOrdId: "qts1", sl: 77500 })]);
  applySync(list, s, [upd({})], NOW);
  assert.equal(d.order!.state, "filled");
  assert.equal(d.order!.fillT, 1_793_600_000_100);
  assert.equal(d.order!.posKey, "101:1793600000000");
  assert.equal(d.order!.algoId, "9001");
  assert.equal(d.b.p, 77500);
  assert.equal(list.length, 1); // not drawn a second time as a position of its own
  assert.equal(isLive(d, s), true);
  // the stop to above the entry: a profit locked in; the direction stays long
  applySync(list, state([pos()], [algo({ algoClOrdId: "qts1", sl: 78200 })]), [], NOW);
  assert.deepEqual([d.b.p, d.dir], [78200, 1]);
  // closed on OKX: looked up, kept on the order
  const r = applySync(list, state([], []), [], NOW);
  assert.deepEqual(r.gone, [{ posId: "101", cTime: 1_793_600_000_000 }]);
  applyClosed(list, "101:1793600000000", { t: 1, px: 78200, pnl: 6 });
  assert.equal(d.order!.closed!.pnl, 6);
  assert.equal(isLive(d, state([pos()], [])), false);
  // an order from before ids were given: its TP/SL found by the stop price, when it is the only one
  const old = drawn("p2", order({ ordId: "701", algoClOrdId: undefined, sl: undefined, state: "filled", fillSz: 3, fillT: 1_793_600_000_100 }), 78000, 77000);
  const two: Drawing[] = [old];
  applySync(two, state([pos()], [algo({ algoId: "77", sl: 77000 }), algo({ algoId: "78", sl: 76000 })]), [], NOW);
  assert.equal(old.order!.algoId, "77");
  const twice: Drawing[] = [drawn("p3", order({ ordId: "702", algoClOrdId: undefined, sl: undefined, state: "filled", fillSz: 3 }))];
  applySync(twice, state([pos()], [algo({ algoId: "77", sl: 77000 }), algo({ algoId: "79", sl: 77000 })]), [], NOW);
  assert.equal((twice[0] as PositionDrawing).order!.algoId, undefined); // two at that price: not guessed
});

test("a market order: its position may show before the order is known, and is drawn once", () => {
  const opened = pos({ cTime: NOW * 1000 - 1_000 });
  // the order is being sent, the position already shows: not drawn on its own
  const list: Drawing[] = [drawn("p1")];
  const held = applySync(list, { ...state([opened], []), placing: ["long"] }, [], NOW);
  assert.equal(list.length, 1);
  assert.equal(held.until, opened.cTime + 15_000); // matched again then, drawn if no order of ours went into it
  assert.equal(applySync([], state([opened], []), [], NOW).until, null);
  // the other side being sent doesn't hold it back
  const other: Drawing[] = [];
  applySync(other, { ...state([opened], []), placing: ["short"] }, [], NOW);
  assert.equal(other.length, 1);
  // the answer came: the order is kept as filled (read from OKX, no report of its own): matched to the position
  const d = list[0] as PositionDrawing;
  d.order = order({ ordType: "market", px: null, state: "filled", fillSz: 3, avgPx: 78000, fillT: NOW * 1000 - 1_000 });
  applySync(list, state([opened], []), [], NOW);
  assert.equal(d.order!.posKey, posKeyOf(opened));
  assert.equal(list.length, 1);
  // drawn on its own before the order was known: taken away once the order is read as filled
  const twice: Drawing[] = [drawn("p2")];
  applySync(twice, state([opened], []), [], NOW);
  assert.equal(twice.length, 2);
  (twice[0] as PositionDrawing).order = order({ ordType: "market", px: null, state: "filled", fillSz: 3, avgPx: 78000, fillT: NOW * 1000 - 1_000 });
  applySync(twice, state([opened], []), [], NOW + 5);
  assert.deepEqual(twice.map((x) => x.id), ["p2"]);
});

test("a waiting order changed on OKX (or by us): the position's entry, stops and size follow", () => {
  const d = drawn("p1", order());
  const list: Drawing[] = [d];
  // moved up as a whole: the new price is outside the old stops, all three move together
  applySync(list, state([], []), [upd({ state: "live", accFillSz: 0, avgPx: null, px: 81000, sz: 2, sl: 80000, tp: 83000 })], NOW);
  assert.deepEqual([d.a.p, d.b.p, d.target, d.order!.px, d.order!.sz], [81000, 80000, 83000, 81000, 2]);
  // OKX's answer agrees with the chart already: nothing changes
  assert.equal(applySync(list, state([], []), [upd({ state: "live", accFillSz: 0, avgPx: null, px: 81000, sz: 2, sl: 80000, tp: 83000 })], NOW).changed, false);
  // prices that don't make a long any more (stop above the price) are not taken
  applySync(list, state([], []), [upd({ state: "live", accFillSz: 0, avgPx: null, px: 79000, sz: 2, sl: 80000, tp: 83000 })], NOW);
  assert.deepEqual([d.a.p, d.b.p], [81000, 80000]);
  assert.equal(d.order!.px, 79000); // the record still says what OKX has
});

test("an add that fills moves the earlier stops; stops moved on the chart go to OKX", () => {
  const first = drawn("a", order({ ordId: "700", state: "filled", fillSz: 3, fillT: 1_793_600_000_100, algoClOrdId: "qts1", tp: 80000 }));
  const add = drawn("b", order({ ordId: "701", clOrdId: "qtc2", algoClOrdId: "qts2", at: 1_793_610_000, state: "filled", fillSz: 1, fillT: 1_793_610_000_100, sl: 77800, tp: 81000, moveOnFill: true }), 78500, 77800, 81000);
  const list: Drawing[] = [first, add];
  const s = state([pos({ pos: 4 })], [algo({ algoId: "9001", algoClOrdId: "qts1", sl: 77000, tp: 80000 }), algo({ algoId: "9002", algoClOrdId: "qts2", sz: 1, sl: 77800, tp: 81000 })]);
  const moves = stopMoves(list, s);
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0].amends, [{ instId: "BTC-USDT-SWAP", kind: "algo", algoId: "9001", sl: "77800.0", tp: "81000.0" }]);
  assert.deepEqual(moves[0].notes, []);
  add.order = { ...add.order!, moved: { at: 1, ok: true, note: "" } };
  assert.equal(stopMoves(list, s).length, 0); // done once
  // the earlier one has no take-profit on OKX: only the stop
  add.order = { ...add.order!, moved: undefined };
  const noTp = stopMoves(list, state(s.positions, [algo({ algoId: "9001", algoClOrdId: "qts1", sl: 77000, tp: null })]));
  assert.deepEqual(noTp[0].amends, [{ instId: "BTC-USDT-SWAP", kind: "algo", algoId: "9001", sl: "77800.0" }]);
  assert.equal(noTp[0].notes.length, 1);
  // the chart's stop for the whole position: every stop-loss order closing it
  const e = stopEdits(add, s, { sl: 77900 }, fmt)!;
  assert.deepEqual(e.amends.map((a) => [a.algoId, a.sl]), [["9001", "77900.0"], ["9002", "77900.0"]]);
  assert.deepEqual(e.lines, ["止損 77000.0 → 77900.0", "止損 77800.0 → 77900.0"]);
  // an order still waiting: its attached ones
  const waiting = drawn("w", order({ ordId: "703", algoClOrdId: "qts3", state: "live" }));
  const w = stopEdits(waiting, state([], []), { sl: 77100, tp: 80500 }, fmt)!;
  assert.deepEqual(w.amends, [{ instId: "BTC-USDT-SWAP", kind: "attached", ordId: "703", algoClOrdId: "qts3", sl: "77100.0", tp: "80500.0" }]);
  // nothing on OKX: nothing to send
  assert.equal(stopEdits(drawn("x"), state([], []), { sl: 1 }, fmt), null);
  assert.equal(isLive(drawn("x"), s), false);
});

test("prices as OKX takes them", () => {
  assert.equal(stepDecimals(0.1), 1);
  assert.equal(stepDecimals(0.25), 2);
  assert.equal(stepDecimals(5), 0);
  assert.equal(stepDecimals(0.0000001), 7);
  assert.equal(priceArg(77800.04, 0.1), "77800.0");
  assert.equal(priceArg(0.00001234, 0.0000001), "0.0000123");
});

test("our order filling: the position OKX reports first is not drawn a second time", () => {
  const d = drawn("p1", order());
  const list: Drawing[] = [d];
  const opened = pos({ cTime: NOW * 1000 - 2_000 }); // opened 2 s ago, while our order still shows as waiting
  applySync(list, state([opened], []), [upd({ state: "live", accFillSz: 0 })], NOW);
  assert.equal(list.length, 1); // waits for the order
  // the order shows filled: it is matched to the position, still one drawing
  applySync(list, state([opened], []), [upd({ fillTime: NOW * 1000 - 2_000, uTime: NOW * 1000 - 2_000 })], NOW);
  assert.equal(d.order!.posKey, posKeyOf(opened));
  assert.equal(list.length, 1);
  // a drawing made from it before the order showed (an older version, or after the wait) goes once matched
  const twice: Drawing[] = [drawn("p2", order({ ordId: "701" }))];
  applySync(twice, state([opened], []), [], NOW + 30); // the order never showed in time: drawn on its own
  assert.equal(twice.length, 2);
  assert.ok((twice[1] as PositionDrawing).okx);
  applySync(twice, state([opened], []), [upd({ ordId: "701", fillTime: NOW * 1000 - 2_000, uTime: NOW * 1000 - 2_000 })], NOW + 31);
  assert.deepEqual(twice.map((x) => x.id), ["p2"]);
  // with no order of ours waiting, a new position is drawn at once
  const other: Drawing[] = [];
  applySync(other, state([opened], []), [], NOW);
  assert.equal(other.length, 1);
});

test("filled: the entry moves to where the order filled, as OKX has it", () => {
  // a market order planned at 78000 filled at 78040
  const d = drawn("p1", order({ ordType: "market", px: null, state: "filled", fillSz: 3, avgPx: 78040, fillT: NOW * 1000 - 1_000 }));
  const list: Drawing[] = [d];
  const opened = pos({ avgPx: 78040, cTime: NOW * 1000 - 1_000 });
  assert.equal(applySync(list, state([opened], []), [], NOW).changed, true);
  assert.deepEqual([d.a.p, d.b.p, d.target, d.order!.posKey], [78040, 77000, 80000, posKeyOf(opened)]);
  assert.equal(applySync(list, state([opened], []), [], NOW).changed, false); // once
  // a report of the fill does the same
  const e = drawn("p2", order());
  applySync([e], state([opened], []), [upd({ avgPx: 78040, fillTime: NOW * 1000 - 1_000 })], NOW);
  assert.equal(e.a.p, 78040);
  // part filled: the rest still waits at its price, the entry stays
  const f = drawn("p3", order({ state: "partially_filled", fillSz: 1, avgPx: 77990 }));
  applySync([f], state([opened], []), [], NOW);
  assert.equal(f.a.p, 78000);
  // closed before (a record): left as it was
  const g = drawn("p4", order({ state: "filled", fillSz: 3, avgPx: 78040, closed: { t: NOW, px: 78500, pnl: 13.8 } }));
  applySync([g], state([], []), [], NOW);
  assert.equal(g.a.p, 78000);
});
