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
/**
 * A position built up by adds (scaling in): same direction, each add filled while the whole position was
 * still open. After an add the whole position takes that add's stop-loss, take-profit and box end; the add's
 * size is what keeps the whole position's loss at that stop to the add's risk (the earlier part's profit or
 * loss at the new stop counted in, through the average entry).
 */
export type ScaleIn = {
  /** 1: the position that opened it, 2: the first add, ... */
  step: number;
  /** How many positions it is made of (an add still waiting to fill counts itself). */
  count: number;
  /** After the last of them: whole quantity, average entry, the stop and take-profit in force, the loss at
   *  that stop (below 0: a profit locked in) and the profit at the take-profit. */
  qty: number;
  avg: number;
  stop: number;
  target: number;
  risk: number;
  reward: number;
  /** The whole position's result (so far, while it runs). */
  pnl: number;
  /** This add found the whole position at or past its risk at the new stop already: it adds nothing. */
  full: boolean;
};

export type PositionResult = {
  capital: number;
  /** No capital of its own (takes the previous result, or the default when there is none). */
  auto: boolean;
  /** The capital really came from an earlier position. */
  chained: boolean;
  /** Its own part: for an add, the quantity added. */
  plan: TradePlan;
  /** For a position built up by adds: how the whole of it turned out. */
  outcome: TradeOutcome;
  /** Its own part of the result. */
  pnl: number;
  /** After the whole position. */
  endCapital: number;
  /** Part of a position built up by adds (null: on its own). */
  scale: ScaleIn | null;
};

const sideOf = (p: PositionInput): 1 | -1 => (p.stop <= p.entry ? 1 : -1);

/** Index of the bar that holds time t (or the first one after it). */
function barAt(bars: Candle[], barSec: number, t: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time + barSec > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Bar index where the resting entry fills inside the box; -1: it doesn't (yet); null: the bars don't reach
 *  back to the entry. */
function fillAt(bars: Candle[], barSec: number, p: PositionInput): number | null {
  if (!bars.length || p.entryT < bars[0].time) return null;
  for (let i = barAt(bars, barSec, p.entryT); i < bars.length; i++) {
    const c = bars[i];
    if (c.time > p.endT) break;
    if (c.low <= p.entry && p.entry <= c.high) return i;
  }
  return -1;
}

type Member = { p: PositionInput; fill: number };
/** How a position (or a position built up by adds) ends; `at`: the bar of the exit (null: still open). */
type Exit = { outcome: TradeOutcome; at: number | null };
type Group = { dir: 1 | -1; members: Member[]; exit: Exit };

/**
 * Bar by bar from the first fill, as settleTrade does for one position: from each add's fill on, its stop,
 * take-profit and box end are the ones in force; a bar where something fills counts its stop but not its
 * take-profit (the worse case).
 */
function settleGroup(bars: Candle[], members: Member[], dir: 1 | -1): Exit {
  let k = 0;
  let lastFill = members[0].fill;
  let last: Candle | null = null;
  let lastAt = -1;
  let ended = false;
  for (let i = members[0].fill; i < bars.length; i++) {
    while (k + 1 < members.length && members[k + 1].fill <= i) {
      k++;
      lastFill = i;
    }
    const p = members[k].p;
    const c = bars[i];
    if (c.time > p.endT) {
      ended = true;
      break;
    }
    last = c;
    lastAt = i;
    if (dir === 1 ? c.low <= p.stop : c.high >= p.stop) return { outcome: { status: "sl", exit: p.stop, exitT: c.time }, at: i };
    if (i > lastFill && (dir === 1 ? c.high >= p.target : c.low <= p.target)) return { outcome: { status: "tp", exit: p.target, exitT: c.time }, at: i };
  }
  const close = last ? last.close : members[0].p.entry;
  return ended
    ? { outcome: { status: "expired", exit: close, exitT: last ? last.time : null }, at: lastAt }
    : { outcome: { status: "open", exit: close, exitT: null }, at: null };
}

/** The position is still open when something fills on bar f (an exit on that same bar comes first, except
 *  the box running out, which happens at the bar's close). */
function holds(g: Group, f: number): boolean {
  if (f < g.members[g.members.length - 1].fill) return false;
  const { outcome, at } = g.exit;
  if (at == null) return true;
  return outcome.status === "expired" ? f <= at : f < at;
}

/** Quantity, notional and average entry of a position built up so far. */
type Whole = { qty: number; notional: number; avg: number };

/**
 * Size of an add: what keeps the whole position's loss at the add's stop to the add's risk. The part bought
 * before counts with its profit (or loss) at that stop. Never below 0, and no more than the capital can carry
 * at the add's leverage together with what is open.
 */
export function addPlan(w: Whole, p: Pick<PositionInput, "entry" | "stop" | "target" | "risk" | "riskMode" | "leverage">, capital: number): { plan: TradePlan; full: boolean } {
  const dir: 1 | -1 = p.stop <= p.entry ? 1 : -1;
  const dist = Math.abs(p.entry - p.stop);
  const budget = Math.max(0, p.riskMode === "pct" ? (capital * p.risk) / 100 : p.risk);
  const locked = w.qty * (p.stop - w.avg) * dir;
  const want = dist > 0 ? (budget + locked) / dist : 0;
  const full = want <= 0;
  let qty = Math.max(0, want);
  const room = Math.max(0, Math.max(0, capital) * Math.max(1, p.leverage) - w.notional);
  const maxQty = p.entry > 0 ? room / p.entry : 0;
  const capped = qty > maxQty;
  if (capped) qty = maxQty;
  const notional = qty * p.entry;
  return {
    plan: {
      dir,
      riskAmount: qty * dist,
      qty,
      notional,
      margin: notional / Math.max(1, p.leverage),
      capped,
      reward: qty * Math.abs(p.target - p.entry),
      rr: dist > 0 ? Math.abs(p.target - p.entry) / dist : 0,
    },
    full,
  };
}

const grow = (w: Whole, qty: number, entry: number): Whole => {
  const q = w.qty + qty;
  const n = w.notional + qty * entry;
  return { qty: q, notional: n, avg: q > 0 ? n / q : entry };
};

/** The whole position after its last part: quantity, average, its loss at the stop and profit at the
 *  take-profit. */
function wholeAt(w: Whole, dir: 1 | -1, stop: number, target: number) {
  return { qty: w.qty, avg: w.avg, stop, target, risk: w.qty * (w.avg - stop) * dir, reward: w.qty * (target - w.avg) * dir };
}

/**
 * Size and outcome of every position. Same-direction positions filled while an earlier one is still open
 * build it up (ScaleIn); a same-direction position still waiting to fill is sized as an add to the one open
 * now. Positions (a built-up one as one) in entry-time order; each one with capital null starts with what the
 * one before it ended with (`chain`), or with `defaultCapital`; an add's risk is of the capital the whole
 * position started with.
 */
export function chainPositions(
  list: PositionInput[], bars: Candle[], barSec: number, defaultCapital: number, chain: boolean,
): Map<string, PositionResult> {
  const out = new Map<string, PositionResult>();
  const byTime = (a: PositionInput, b: PositionInput) => a.entryT - b.entryT || (a.id < b.id ? -1 : 1);
  const sorted = [...list].sort(byTime);

  // which positions build up which: by when they fill (only prices matter here)
  const fills = new Map<string, number | null>();
  for (const p of sorted) fills.set(p.id, fillAt(bars, barSec, p));
  const filled = sorted.filter((p) => (fills.get(p.id) ?? -1) >= 0);
  filled.sort((a, b) => fills.get(a.id)! - fills.get(b.id)! || byTime(a, b));
  const groups: Group[] = [];
  for (const p of filled) {
    const f = fills.get(p.id)!;
    const dir = sideOf(p);
    let g: Group | undefined;
    for (let k = groups.length - 1; k >= 0 && !g; k--) if (groups[k].dir === dir && holds(groups[k], f)) g = groups[k];
    if (g) {
      g.members.push({ p, fill: f });
      g.exit = settleGroup(bars, g.members, dir);
    } else {
      const members = [{ p, fill: f }];
      groups.push({ dir, members, exit: settleGroup(bars, members, dir) });
    }
  }
  // a same-direction position still waiting, while a position is open now: an add to it once it fills
  const openNow = (dir: 1 | -1) => [...groups].reverse().find((g) => g.dir === dir && g.exit.at == null);
  const waiting = new Map<string, Group>();
  for (const p of sorted) {
    if (fills.get(p.id) !== -1) continue;
    const g = openNow(sideOf(p));
    if (g && settleTrade(bars, barSec, p.entryT, p.endT, p.entry, p.stop, p.target).status === "pending") waiting.set(p.id, g);
  }

  // sizes and capital, in entry-time order of what stands on its own
  type Unit = { t: number; id: string; g?: Group; p?: PositionInput };
  const units: Unit[] = [
    ...groups.map((g) => ({ t: g.members[0].p.entryT, id: g.members[0].p.id, g })),
    ...sorted.filter((p) => (fills.get(p.id) ?? -1) < 0 && !waiting.has(p.id)).map((p) => ({ t: p.entryT, id: p.id, p })),
  ].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  const wholeOf = new Map<Group, { w: Whole; capital: number; pnl: number }>();
  let prevEnd: number | null = null;
  const startCapital = (p: PositionInput) => {
    const auto = p.capital == null;
    const chained = auto && chain && prevEnd != null && !p.fresh;
    return { auto, chained, capital: p.capital ?? (chained && prevEnd != null ? prevEnd : defaultCapital) };
  };
  for (const u of units) {
    if (u.p) {
      const p = u.p;
      const { auto, chained, capital } = startCapital(p);
      const plan = planTrade(p.entry, p.stop, p.target, capital, p.risk, p.riskMode, p.leverage);
      const outcome = settleTrade(bars, barSec, p.entryT, p.endT, p.entry, p.stop, p.target);
      out.set(p.id, { capital, auto, chained, plan, outcome, pnl: 0, endCapital: capital, scale: null });
      prevEnd = capital;
      continue;
    }
    const g = u.g!;
    const base = g.members[0].p;
    const { auto, chained, capital } = startCapital(base);
    let w: Whole = { qty: 0, notional: 0, avg: base.entry };
    const parts = g.members.map(({ p }, j) => {
      const own = p.capital ?? capital;
      const { plan, full } = j === 0 ? { plan: planTrade(p.entry, p.stop, p.target, capital, p.risk, p.riskMode, p.leverage), full: false } : addPlan(w, p, own);
      w = grow(w, plan.qty, p.entry);
      return { p, own, plan, full };
    });
    const { outcome } = g.exit;
    const pnls = parts.map(({ p, plan }) => (outcome.exit == null ? 0 : plan.qty * (outcome.exit - p.entry) * g.dir));
    const pnl = pnls.reduce((a, b) => a + b, 0);
    const endCapital = capital + pnl;
    const lastP = parts[parts.length - 1].p;
    const whole = wholeAt(w, g.dir, lastP.stop, lastP.target);
    parts.forEach(({ p, own, plan, full }, j) => {
      out.set(p.id, {
        capital: j === 0 ? capital : own,
        auto: j === 0 ? auto : p.capital == null,
        chained: j === 0 && chained,
        plan,
        outcome,
        pnl: pnls[j],
        endCapital,
        scale: parts.length > 1 ? { step: j + 1, count: parts.length, ...whole, pnl, full } : null,
      });
    });
    wholeOf.set(g, { w, capital, pnl });
    prevEnd = endCapital;
  }

  // adds still waiting: sized on the whole position as it is now
  for (const [id, g] of waiting) {
    const p = sorted.find((x) => x.id === id)!;
    const now = wholeOf.get(g)!;
    const own = p.capital ?? now.capital;
    const { plan, full } = addPlan(now.w, p, own);
    const w = grow(now.w, plan.qty, p.entry);
    const count = g.members.length + 1;
    out.set(id, {
      capital: own,
      auto: p.capital == null,
      chained: false,
      plan,
      outcome: { status: "pending", exit: null, exitT: null },
      pnl: 0,
      endCapital: own,
      scale: { step: count, count, ...wholeAt(w, g.dir, p.stop, p.target), pnl: now.pnl, full },
    });
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
