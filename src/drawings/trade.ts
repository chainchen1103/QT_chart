// Position sizing and outcome for the position tool. Pure functions (no DOM), unit-tested in tests/trade.test.ts.
//
// Size: the risk (a % of the capital, or a fixed amount) divided by the distance to the stop gives the
// quantity; quantity × entry is the notional, and notional / leverage the margin. When the margin would be more
// than the capital, the quantity is cut to what the capital can carry at that leverage.
// Outcome: the entry is a resting order, filled by the first bar from the entry bar on whose range reaches it.
// After that the first bar to reach the stop or the take-profit decides; when one bar reaches both, or the
// fill bar reaches the stop, the stop counts (the worse case). Fees and funding are not included.

import type { Candle } from "../core/api.ts";

export type RiskMode = "pct" | "amount";

export type TradePlan = {
  dir: 1 | -1;
  /** Money lost at the stop. */
  riskAmount: number;
  /** In coins (e.g. BTC). */
  qty: number;
  notional: number;
  margin: number;
  /** The quantity was cut because the margin would exceed the capital. */
  capped: boolean;
  /** Money made at the take-profit. */
  reward: number;
  rr: number;
};

export function planTrade(entry: number, stop: number, target: number, capital: number, risk: number, mode: RiskMode, leverage: number): TradePlan {
  const dir: 1 | -1 = stop <= entry ? 1 : -1;
  const dist = Math.abs(entry - stop);
  const wanted = Math.max(0, mode === "pct" ? (capital * risk) / 100 : risk);
  let qty = dist > 0 ? wanted / dist : 0;
  const maxQty = entry > 0 ? (Math.max(0, capital) * Math.max(1, leverage)) / entry : 0;
  const capped = qty > maxQty;
  if (capped) qty = maxQty;
  const notional = qty * entry;
  return {
    dir,
    riskAmount: qty * dist,
    qty,
    notional,
    margin: notional / Math.max(1, leverage),
    capped,
    reward: qty * Math.abs(target - entry),
    rr: dist > 0 ? Math.abs(target - entry) / dist : 0,
  };
}

/**
 * pending: the entry hasn't been reached and the box hasn't ended; unfilled: the box ended first;
 * open: filled and still running (marked at the last close); tp / sl: closed there;
 * expired: filled, and the box ended without either (closed at the last close inside it);
 * nodata: the bars on the chart don't reach back to the entry.
 */
export type TradeStatus = "pending" | "unfilled" | "open" | "tp" | "sl" | "expired" | "nodata";
export type TradeOutcome = { status: TradeStatus; exit: number | null; exitT: number | null };

export function settleTrade(bars: Candle[], barSec: number, entryT: number, endT: number, entry: number, stop: number, target: number): TradeOutcome {
  const dir = stop <= entry ? 1 : -1;
  if (!bars.length || entryT < bars[0].time) return { status: "nodata", exit: null, exitT: null };
  const ended = bars[bars.length - 1].time > endT; // the bars have moved past the end of the box
  let filled = false;
  let last: Candle | null = null;
  for (const c of bars) {
    if (c.time + barSec <= entryT) continue; // before the entry bar
    if (c.time > endT) break; // past the box
    last = c;
    if (!filled) {
      if (c.low <= entry && entry <= c.high) {
        filled = true;
        if (dir === 1 ? c.low <= stop : c.high >= stop) return { status: "sl", exit: stop, exitT: c.time };
      }
      continue; // the take-profit counts from the bar after the fill
    }
    if (dir === 1 ? c.low <= stop : c.high >= stop) return { status: "sl", exit: stop, exitT: c.time };
    if (dir === 1 ? c.high >= target : c.low <= target) return { status: "tp", exit: target, exitT: c.time };
  }
  if (!filled) return { status: ended ? "unfilled" : "pending", exit: null, exitT: null };
  const close = last ? last.close : entry;
  return ended ? { status: "expired", exit: close, exitT: last ? last.time : null } : { status: "open", exit: close, exitT: null };
}

/** Entry, stop-loss and take-profit of a position. */
export type PositionPrices = { entry: number; stop: number; target: number };

/**
 * What keeps three prices from making a position (null: nothing does): each one above 0, the stop on one side
 * of the entry and the take-profit on the other (below and above it for a long, the other way round for a
 * short).
 */
export function checkPrices(p: PositionPrices): string | null {
  if (![p.entry, p.stop, p.target].every((v) => Number.isFinite(v) && v > 0)) return "價格要是大於 0 的數字";
  if (p.stop === p.entry) return "止損不能等於進場價";
  if (p.target === p.entry) return "止盈不能等於進場價";
  if ((p.stop < p.entry) === (p.target < p.entry)) return "止損和止盈要在進場價的兩邊：多單止損在下、止盈在上，空單相反";
  return null;
}

/** Profit or loss of an outcome for this plan (0 before a fill). */
export function tradePnl(plan: TradePlan, entry: number, o: TradeOutcome): number {
  if (o.exit == null) return 0;
  return plan.qty * (o.exit - entry) * plan.dir;
}

export type PositionInput = {
  id: string; entryT: number; endT: number; entry: number; stop: number; target: number;
  /** null: take the capital the previous position ended with (or the default when there is none). */
  capital: number | null;
  risk: number; riskMode: RiskMode; leverage: number;
  /** Starts from the default capital whatever came before (still running while the default is the
   *  trading account's real equity: earlier positions on the chart are only what-ifs). */
  fresh?: boolean;
};
export type PositionResult = {
  capital: number;
  /** No capital of its own (takes the previous result, or the default when there is none). */
  auto: boolean;
  /** The capital really came from an earlier position. */
  chained: boolean;
  plan: TradePlan; outcome: TradeOutcome; pnl: number; endCapital: number;
};

/**
 * Positions in entry-time order; each one with capital null starts with what the one before it ended with
 * (`chain`), or with `defaultCapital`.
 */
export function chainPositions(
  list: PositionInput[], bars: Candle[], barSec: number, defaultCapital: number, chain: boolean,
): Map<string, PositionResult> {
  const out = new Map<string, PositionResult>();
  const sorted = [...list].sort((a, b) => a.entryT - b.entryT || (a.id < b.id ? -1 : 1));
  let prevEnd: number | null = null;
  for (const p of sorted) {
    const auto = p.capital == null;
    const chained = auto && chain && prevEnd != null && !p.fresh;
    const capital: number = p.capital ?? (chained && prevEnd != null ? prevEnd : defaultCapital);
    const plan = planTrade(p.entry, p.stop, p.target, capital, p.risk, p.riskMode, p.leverage);
    const outcome = settleTrade(bars, barSec, p.entryT, p.endT, p.entry, p.stop, p.target);
    const pnl = tradePnl(plan, p.entry, outcome);
    const endCapital: number = capital + pnl;
    out.set(p.id, { capital, auto, chained, plan, outcome, pnl, endCapital });
    prevEnd = endCapital;
  }
  return out;
}

/** A coin quantity with sensible decimals: 0.0391, 12.35, 1,250. */
export function fmtQty(q: number): string {
  const a = Math.abs(q);
  const d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 3 : a >= 0.01 ? 4 : 6;
  return q.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });
}

/** Money: "1,025.70". */
export function fmtMoney(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
