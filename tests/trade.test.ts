// Position sizing, outcome of a position on bars, and capital carried from one position to the next.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chainPositions, fmtQty, planTrade, settleTrade, tradePnl } from "../src/drawings/trade.ts";
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
