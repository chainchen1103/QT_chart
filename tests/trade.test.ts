// Position sizing, outcome of a position on bars, and capital carried from one position to the next.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chainPositions, checkPrices, fmtQty, planTrade, settleTrade, tradePnl } from "../src/drawings/trade.ts";
import type { Candle } from "../src/core/api.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const bar = (time: number, low: number, high: number, closePx = (low + high) / 2): Candle => ({
  time, open: closePx, high, low, close: closePx, volume: 1, confirmed: true,
});

test("size from risk: % of capital or a fixed amount; margin and the leverage cap", () => {
  // capital 1000, risk 1 % = 10, stop 2 away -> 5 coins; notional 500; margin at 10x = 50
  const p = planTrade(100, 98, 104, 1000, 1, "pct", 10);
  assert.equal(p.dir, 1);
  close(p.riskAmount, 10);
  close(p.qty, 5);
  close(p.notional, 500);
  close(p.margin, 50);
  close(p.reward, 20);
  close(p.rr, 2);
  assert.equal(p.capped, false);
  // fixed 25 risk on a short
  const s = planTrade(100, 101, 97, 1000, 25, "amount", 5);
  assert.equal(s.dir, -1);
  close(s.qty, 25);
  close(s.reward, 75);
  // at 1x, 1000 of capital carries only 10 coins (1000 notional): the size is cut, and the risk with it
  const c = planTrade(100, 99.8, 101, 1000, 10, "pct", 1); // wants 100 risk / 0.2 = 500 coins = 50,000 notional
  assert.equal(c.capped, true);
  close(c.qty, 10);
  close(c.margin, 1000);
  close(c.riskAmount, 2);
});

test("outcome: resting entry, then stop or take-profit; same bar counts as the stop", () => {
  const s = 60;
  const bars = [bar(0, 101, 103), bar(60, 99.5, 101.5), bar(120, 100.5, 102), bar(180, 101, 104.5), bar(240, 104, 105)];
  // long: entry 100, stop 98, take-profit 104; filled at 60, take-profit at 180
  assert.deepEqual(settleTrade(bars, s, 0, 600, 100, 98, 104), { status: "tp", exit: 104, exitT: 180 });
  // long with the stop at 99.6: the fill bar (low 99.5) reaches it too -> stop
  assert.deepEqual(settleTrade(bars, s, 0, 600, 100, 99.6, 104), { status: "sl", exit: 99.6, exitT: 60 });
  // a bar reaching both: stop first
  const both = [bar(0, 99.5, 100.5), bar(60, 97, 105)];
  assert.equal(settleTrade(both, s, 0, 600, 100, 98, 104).status, "sl");
  // never filled: pending while the box runs, unfilled after it
  assert.equal(settleTrade(bars, s, 0, 600, 90, 88, 95).status, "pending");
  assert.equal(settleTrade(bars, s, 0, 120, 90, 88, 95).status, "unfilled");
  // filled, neither: open (marked at the last close) or expired when the box ended
  const flat = [bar(0, 99.5, 100.5), bar(60, 100, 101, 100.8), bar(120, 100.2, 101.2, 101)];
  assert.deepEqual(settleTrade(flat, s, 0, 600, 100, 98, 104), { status: "open", exit: 101, exitT: null });
  assert.deepEqual(settleTrade(flat, s, 0, 60, 100, 98, 104), { status: "expired", exit: 100.8, exitT: 60 });
  // short: entry 100, stop 102, take-profit 97
  const down = [bar(0, 99.8, 100.4), bar(60, 96.5, 99.9)];
  assert.equal(settleTrade(down, s, 0, 600, 100, 102, 97).status, "tp");
  // entry before the loaded bars
  assert.equal(settleTrade(bars, s, -600, 600, 100, 98, 104).status, "nodata");
});

test("pnl and capital carried to the next position", () => {
  const s = 60;
  const bars = [bar(0, 99.5, 100.5), bar(60, 100, 104.5), bar(120, 103, 104), bar(180, 101, 103.5), bar(240, 97, 102)];
  const base = { riskMode: "pct" as const, leverage: 10, risk: 1 };
  const r = chainPositions(
    [
      // second in time but listed first: order follows the entry time
      { id: "b", entryT: 180, endT: 600, entry: 102, stop: 98, target: 110, capital: null, ...base },
      { id: "a", entryT: 0, endT: 600, entry: 100, stop: 98, target: 104, capital: null, ...base },
    ],
    bars, s, 1000, true,
  );
  const a = r.get("a")!;
  const b = r.get("b")!;
  assert.equal(a.outcome.status, "tp"); // 5 coins x 4 = +20
  close(a.pnl, 20);
  close(a.endCapital, 1020);
  assert.equal(b.auto, true);
  assert.equal(b.chained, true);
  assert.equal(a.chained, false); // the first one has nothing before it: the default capital
  close(b.capital, 1020); // starts with what "a" ended with
  assert.equal(b.outcome.status, "sl"); // 1 % of 1020 = 10.2 lost
  close(b.pnl, -10.2);
  close(b.endCapital, 1009.8);
  // a capital typed in wins; without chaining every position starts from the default
  const fixed = chainPositions([{ id: "x", entryT: 0, endT: 600, entry: 100, stop: 98, target: 104, capital: 500, ...base }], bars, s, 1000, true);
  close(fixed.get("x")!.capital, 500);
  const free = chainPositions(
    [
      { id: "a", entryT: 0, endT: 600, entry: 100, stop: 98, target: 104, capital: null, ...base },
      { id: "b", entryT: 180, endT: 600, entry: 102, stop: 98, target: 110, capital: null, ...base },
    ],
    bars, s, 1000, false,
  );
  close(free.get("b")!.capital, 1000);
  assert.equal(free.get("b")!.chained, false);
  // a running position sized from the real account doesn't take an earlier what-if's result
  const live = chainPositions(
    [
      { id: "a", entryT: 0, endT: 600, entry: 100, stop: 98, target: 104, capital: null, ...base },
      { id: "b", entryT: 180, endT: 600, entry: 102, stop: 98, target: 110, capital: null, ...base, fresh: true },
    ],
    bars, s, 1234.56, true,
  );
  close(live.get("b")!.capital, 1234.56);
  assert.equal(live.get("b")!.chained, false);
  close(tradePnl(planTrade(100, 98, 104, 1000, 1, "pct", 10), 100, { status: "pending", exit: null, exitT: null }), 0);
  assert.equal(fmtQty(0.039123), "0.0391");
  assert.equal(fmtQty(12.3456), "12.346");
});

test("typed prices: above 0, stop and take-profit on either side of the entry", () => {
  assert.equal(checkPrices({ entry: 100, stop: 98, target: 104 }), null); // long
  assert.equal(checkPrices({ entry: 100, stop: 102, target: 97 }), null); // short
  assert.match(checkPrices({ entry: 100, stop: 98, target: 99 }) ?? "", /兩邊/); // both below
  assert.match(checkPrices({ entry: 100, stop: 101, target: 104 }) ?? "", /兩邊/); // both above
  assert.match(checkPrices({ entry: 100, stop: 100, target: 104 }) ?? "", /止損不能等於進場價/);
  assert.match(checkPrices({ entry: 100, stop: 98, target: 100 }) ?? "", /止盈不能等於進場價/);
  assert.match(checkPrices({ entry: 0, stop: -2, target: 4 }) ?? "", /大於 0/);
  assert.match(checkPrices({ entry: NaN, stop: 98, target: 104 }) ?? "", /大於 0/);
});

test("scaling in: an add filled while the first is open is sized on the whole position", () => {
  const s = 60;
  const base = { riskMode: "pct" as const, leverage: 10, risk: 1, capital: null };
  const bars = [bar(0, 99, 101), bar(60, 100, 106), bar(120, 105, 111), bar(180, 108, 115), bar(240, 97, 109)];
  // long 100 / stop 95 (2 coins for 1 % of 1000), then an add at 110 moving the stop to 98
  const r = chainPositions(
    [
      { id: "a", entryT: 0, endT: 6000, entry: 100, stop: 95, target: 120, ...base },
      { id: "b", entryT: 120, endT: 6000, entry: 110, stop: 98, target: 130, ...base },
    ],
    bars, s, 1000, true,
  );
  const a = r.get("a")!;
  const b = r.get("b")!;
  close(a.plan.qty, 2);
  close(b.plan.qty, 0.5); // the first part loses 4 at 98, so the add may lose 6: 6 / 12
  const w = b.scale!;
  assert.equal(w.step, 2);
  assert.equal(w.count, 2);
  close(w.qty, 2.5);
  close(w.avg, 102);
  close(w.risk, 10); // (102 - 98) x 2.5: still 1 %
  close(w.reward, 70);
  assert.equal(w.full, false);
  assert.equal(a.scale!.step, 1);
  // the whole position leaves at the add's stop, 98
  assert.deepEqual(a.outcome, { status: "sl", exit: 98, exitT: 240 });
  assert.deepEqual(b.outcome, a.outcome);
  close(a.pnl, -4);
  close(b.pnl, -6);
  close(w.pnl, -10);
  close(a.endCapital, 990);
  close(b.endCapital, 990);

  // the stop moved above the first entry: its locked-in profit lets the add be bigger
  const up = chainPositions(
    [
      { id: "a", entryT: 0, endT: 6000, entry: 100, stop: 95, target: 120, ...base },
      { id: "b", entryT: 120, endT: 6000, entry: 110, stop: 105, target: 130, ...base },
    ],
    bars, s, 1000, true,
  );
  close(up.get("b")!.plan.qty, 4); // (10 + 2 x 5) / 5
  close(up.get("b")!.scale!.avg, 640 / 6);
  close(up.get("b")!.scale!.risk, 10);

  // a stop so far that the first part alone already loses more: nothing is added
  const full = chainPositions(
    [
      { id: "a", entryT: 0, endT: 6000, entry: 100, stop: 95, target: 120, ...base },
      { id: "b", entryT: 120, endT: 6000, entry: 110, stop: 90, target: 130, ...base },
    ],
    bars, s, 1000, true,
  );
  close(full.get("b")!.plan.qty, 0);
  assert.equal(full.get("b")!.scale!.full, true);
  close(full.get("b")!.scale!.risk, 20);
});

test("scaling in: not after an exit, not the other direction; capital goes on after the whole", () => {
  const s = 60;
  const base = { riskMode: "pct" as const, leverage: 10, risk: 1, capital: null };
  // the first reaches its take-profit (104) before the second fills: two positions on their own
  const bars = [bar(0, 99, 101), bar(60, 100, 104.5), bar(120, 101, 103), bar(180, 101.5, 103), bar(240, 97, 102)];
  const r = chainPositions(
    [
      { id: "a", entryT: 0, endT: 6000, entry: 100, stop: 98, target: 104, ...base },
      { id: "b", entryT: 120, endT: 6000, entry: 102, stop: 98, target: 110, ...base },
    ],
    bars, s, 1000, true,
  );
  assert.equal(r.get("a")!.scale, null);
  assert.equal(r.get("b")!.scale, null);
  close(r.get("b")!.capital, 1020); // after the first's +20
  // a short while a long is open: each on its own
  const both = chainPositions(
    [
      { id: "l", entryT: 0, endT: 6000, entry: 100, stop: 95, target: 120, ...base },
      { id: "s", entryT: 60, endT: 6000, entry: 102, stop: 106, target: 90, ...base },
    ],
    [bar(0, 99, 101), bar(60, 100, 103), bar(120, 101, 103)], s, 1000, true,
  );
  assert.equal(both.get("l")!.scale, null);
  assert.equal(both.get("s")!.scale, null);
  // the whole position counts as one for the capital that comes after it
  const later = chainPositions(
    [
      { id: "a", entryT: 0, endT: 6000, entry: 100, stop: 95, target: 120, ...base },
      { id: "b", entryT: 120, endT: 6000, entry: 110, stop: 98, target: 130, ...base },
      { id: "c", entryT: 300, endT: 6000, entry: 100, stop: 99, target: 103, ...base },
    ],
    [bar(0, 99, 101), bar(60, 100, 106), bar(120, 105, 111), bar(180, 108, 115), bar(240, 97, 109), bar(300, 99.5, 100.5)],
    s, 1000, true,
  );
  close(later.get("c")!.capital, 990);
  assert.equal(later.get("c")!.chained, true);
});

test("scaling in: an add waiting to fill is sized on the position open now; leverage caps an add", () => {
  const s = 60;
  const base = { riskMode: "pct" as const, leverage: 10, risk: 1, capital: null };
  const bars = [bar(0, 99, 101), bar(60, 100, 106), bar(120, 104, 108)];
  const r = chainPositions(
    [
      { id: "a", entryT: 0, endT: 6000, entry: 100, stop: 95, target: 120, ...base },
      { id: "b", entryT: 120, endT: 6000, entry: 110, stop: 98, target: 130, ...base }, // 110 not reached yet
    ],
    bars, s, 1000, true,
  );
  assert.equal(r.get("a")!.scale, null); // nothing added yet
  assert.equal(r.get("a")!.outcome.status, "open");
  const b = r.get("b")!;
  assert.equal(b.outcome.status, "pending");
  close(b.plan.qty, 0.5);
  assert.equal(b.scale!.step, 2);
  close(b.scale!.avg, 102);
  // at 1x the first part takes all the capital: no room for an add
  const tight = chainPositions(
    [
      { id: "a", entryT: 0, endT: 6000, entry: 100, stop: 99, target: 120, riskMode: "pct", risk: 1, leverage: 1, capital: null },
      { id: "b", entryT: 120, endT: 6000, entry: 105, stop: 103, target: 130, riskMode: "pct", risk: 1, leverage: 1, capital: null },
    ],
    [bar(0, 99.5, 101), bar(60, 100, 104), bar(120, 104, 106), bar(180, 104, 107)], s, 1000, true,
  );
  close(tight.get("a")!.plan.qty, 10);
  close(tight.get("b")!.plan.qty, 0);
  assert.equal(tight.get("b")!.plan.capped, true);
});

test("an order of ours that filled: its real size, and what that risks and makes at the prices now", () => {
  const s = 60;
  const bars = [bar(0, 99, 101), bar(60, 100, 103), bar(120, 101, 104)];
  const base = { risk: 1, riskMode: "pct" as const, leverage: 10 };
  // planned at 100 with the stop at 98: 1% of 1000 makes 5 coins; it filled at 101 with those 5 coins
  const r = chainPositions([{ id: "f", entryT: 0, endT: 600, entry: 101, stop: 98, target: 107, capital: null, ...base, qty: 5 }], bars, s, 1000, true);
  const p = r.get("f")!.plan;
  assert.deepEqual([p.qty, p.riskAmount, p.reward, p.margin, p.capped], [5, 15, 30, 50.5, false]);
  assert.equal(p.rr, 2);
  // not filled: sized from the risk setting at its own prices
  const q = chainPositions([{ id: "w", entryT: 0, endT: 600, entry: 101, stop: 98, target: 107, capital: null, ...base }], bars, s, 1000, true);
  assert.equal(q.get("w")!.plan.riskAmount, 10);
});
