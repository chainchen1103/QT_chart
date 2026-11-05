// Backtesting strategy() scripts the way TradingView's broker emulator does: orders placed when a bar closes
// are filled on the next bar, market orders at its open, stop and limit orders where the price inside the bar
// reaches them (open → nearer of high/low → the other → close; a gap past the price fills at the open).
// Entries the other way reverse the position; strategy.exit() keeps a take-profit and a stop-loss on the open
// trades until one of them fills.

import { PineError, isNa, type Runtime } from "./runtime.ts";
import { num, toInt, type Lib } from "./lib/types.ts";

export type Fill = { bar: number; time: number; price: number; qty: number; dir: 1 | -1; id: string; comment: string; entry: boolean };

export type Trade = {
  entryId: string;
  dir: 1 | -1;
  qty: number;
  /** Quantity when opened (exits by percent are of this). */
  qty0: number;
  price: number;
  bar: number;
  time: number;
  comment: string;
  /** Commission paid on entry, per unit. */
  feePer: number;
  /** Best and worst price seen while open. */
  hi: number;
  lo: number;
  /** strategy.exit() orders that already closed a part of it. */
  spent: Set<string>;
  /** Trailing stops that have started: the best price since, by exit. */
  trail: Map<string, number>;
};

export type ClosedTrade = {
  entryId: string;
  exitId: string;
  dir: 1 | -1;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryBar: number;
  exitBar: number;
  entryTime: number;
  exitTime: number;
  entryComment: string;
  exitComment: string;
  profit: number;
  commission: number;
  runup: number;
  drawdown: number;
};

type Order = {
  kind: "entry" | "order" | "close";
  id: string;
  dir: 1 | -1;
  /** null: worked out when it fills (close: the open quantity of that entry). */
  qty: number | null;
  pct: number;
  limit: number;
  stop: number;
  stopHit: boolean;
  comment: string;
  oca: string;
  ocaType: string;
  /** Close orders: which entry (empty: everything). */
  of: string;
  bar: number;
};

type Exit = {
  id: string;
  from: string;
  qty: number;
  pct: number;
  profit: number;
  limit: number;
  loss: number;
  stop: number;
  trailPrice: number;
  trailPoints: number;
  trailOffset: number;
  comment: string;
  commentProfit: string;
  commentLoss: string;
  commentTrailing: string;
  bar: number;
};

export type StrategyReport = {
  initialCapital: number;
  currency: string;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  commission: number;
  openProfit: number;
  trades: ClosedTrade[];
  open: Trade[];
  fills: Fill[];
  equity: Float64Array;
  /** Bar times (ms) of the equity values. */
  equityTimes: Float64Array;
  maxDrawdown: number;
  maxDrawdownPct: number;
  maxRunup: number;
  buyHold: number;
  /** The same capital bought at the first bar's open and held, at each bar's close (NaN without bars). */
  buyHoldEquity: Float64Array;
  maxHeld: number;
};

export class Broker {
  readonly R: Runtime;
  readonly initial: number;
  readonly qtyType: string;
  readonly qtyValue: number;
  readonly pyramiding: number;
  readonly commType: string;
  readonly commValue: number;
  readonly slippage: number;
  readonly onClose: boolean;
  readonly everyTick: boolean;
  readonly currency: string;
  readonly limitTicks: number;
  allow: "all" | "long" | "short" = "all";

  open: Trade[] = [];
  closed: ClosedTrade[] = [];
  fills: Fill[] = [];
  private orders: Order[] = [];
  private exits = new Map<string, Exit>();
  netProfit = 0;
  grossProfit = 0;
  grossLoss = 0;
  commission = 0;
  equity: Float64Array;
  private peak = NaN;
  maxDD = 0;
  maxDDPct = 0;
  maxRunup = 0;
  private trough = NaN;
  maxHeld = 0;
  wins = 0;
  losses = 0;
  evens = 0;

  constructor(R: Runtime, o: Record<string, unknown>) {
    this.R = R;
    this.initial = num(o.initial_capital, 1000000);
    this.qtyType = typeof o.default_qty_type === "string" ? o.default_qty_type : "fixed";
    this.qtyValue = num(o.default_qty_value, 1);
    this.pyramiding = Math.max(1, toInt(o.pyramiding ?? 0) || 0);
    this.commType = typeof o.commission_type === "string" ? o.commission_type : "percent";
    this.commValue = num(o.commission_value, 0);
    this.slippage = num(o.slippage, 0);
    this.onClose = !!o.process_orders_on_close;
    this.everyTick = !!o.calc_on_every_tick;
    this.currency = typeof o.currency === "string" && o.currency !== "NONE" ? o.currency : "USD";
    this.limitTicks = num(o.backtest_fill_limits_assumption, 0);
    this.equity = new Float64Array(R.n).fill(NaN);
    if (o.calc_on_order_fills) R.warn("calc_on_order_fills 不支援");
    if (o.use_bar_magnifier) R.warn("use_bar_magnifier 不支援");
  }

  // ------------------------------------------------------------------- the position
  get size(): number {
    let s = 0;
    for (const t of this.open) s += t.dir * t.qty;
    return Math.abs(s) < 1e-12 ? 0 : s;
  }
  avgPrice(): number {
    let q = 0;
    let v = 0;
    for (const t of this.open) {
      q += t.qty;
      v += t.qty * t.price;
    }
    return q > 0 ? v / q : NaN;
  }
  openProfit(price = this.R.c[this.R.i]): number {
    let p = 0;
    for (const t of this.open) p += (price - t.price) * t.dir * t.qty;
    return p;
  }
  equityNow(): number {
    return this.initial + this.netProfit + this.openProfit();
  }

  // ------------------------------------------------------------------- orders from the script
  /** Orders are placed when a bar closes (the forming bar places none, unless calc_on_every_tick). */
  private placing(): boolean {
    const R = this.R;
    return !!R.conf[R.i] || this.everyTick;
  }

  private qtyFor(qty: unknown, price: number): number {
    if (qty !== undefined && !isNa(qty)) return Math.max(0, num(qty));
    const v = this.qtyValue;
    switch (this.qtyType) {
      case "cash":
        return floorQty(v / price);
      case "percent_of_equity":
        return floorQty((this.equityNow() * v) / 100 / price);
      default:
        return v;
    }
  }

  entry(id: string, dir: 1 | -1, qty: unknown, limit: unknown, stop: unknown, comment: string, oca: string, ocaType: string) {
    if (!this.placing()) return;
    if (this.allow !== "all" && (dir === 1 ? "long" : "short") !== this.allow) {
      // entries the other way only close the position
      if (this.size * dir < 0) this.closeOrder("", comment || id, undefined, 100, false);
      return;
    }
    const q = this.qtyFor(qty, this.R.c[this.R.i]);
    if (!(q > 0)) return;
    this.orders = this.orders.filter((o) => !(o.id === id && o.kind === "entry"));
    this.orders.push({ kind: "entry", id, dir, qty: q, pct: 100, limit: num(limit), stop: num(stop), stopHit: false, comment, oca, ocaType, of: "", bar: this.R.i });
  }

  order(id: string, dir: 1 | -1, qty: unknown, limit: unknown, stop: unknown, comment: string, oca: string, ocaType: string) {
    if (!this.placing()) return;
    const q = this.qtyFor(qty, this.R.c[this.R.i]);
    if (!(q > 0)) return;
    this.orders = this.orders.filter((o) => !(o.id === id && o.kind === "order"));
    this.orders.push({ kind: "order", id, dir, qty: q, pct: 100, limit: num(limit), stop: num(stop), stopHit: false, comment, oca, ocaType, of: "", bar: this.R.i });
  }

  closeOrder(of: string, comment: string, qty: unknown, pct: unknown, now: boolean) {
    if (!this.placing()) return;
    const has = this.open.some((t) => !of || t.entryId === of);
    if (!has) return;
    const o: Order = { kind: "close", id: of, dir: 1, qty: qty === undefined || isNa(qty) ? null : num(qty), pct: num(pct, 100), limit: NaN, stop: NaN, stopHit: false, comment, oca: "", ocaType: "", of, bar: this.R.i };
    if (now || this.onClose) this.closeNow(o, this.R.c[this.R.i]);
    else {
      this.orders = this.orders.filter((x) => !(x.kind === "close" && x.of === of));
      this.orders.push(o);
    }
  }

  exit(a: Record<string, unknown>) {
    if (!this.placing()) return;
    const id = String(a.id ?? "");
    const e: Exit = {
      id,
      from: typeof a.from_entry === "string" ? a.from_entry : "",
      qty: a.qty === undefined || isNa(a.qty) ? NaN : num(a.qty),
      pct: a.qty_percent === undefined || isNa(a.qty_percent) ? 100 : num(a.qty_percent),
      profit: num(a.profit),
      limit: num(a.limit),
      loss: num(a.loss),
      stop: num(a.stop),
      trailPrice: num(a.trail_price),
      trailPoints: num(a.trail_points),
      trailOffset: num(a.trail_offset),
      comment: typeof a.comment === "string" ? a.comment : "",
      commentProfit: typeof a.comment_profit === "string" ? a.comment_profit : "",
      commentLoss: typeof a.comment_loss === "string" ? a.comment_loss : "",
      commentTrailing: typeof a.comment_trailing === "string" ? a.comment_trailing : "",
      bar: this.R.i,
    };
    const any = [e.profit, e.limit, e.loss, e.stop, e.trailPrice, e.trailPoints].some((x) => x === x);
    if (!any) {
      this.R.warn(`strategy.exit("${id}") 沒有出場價`);
      return;
    }
    this.exits.set(id, e);
  }

  cancel(id: string) {
    this.orders = this.orders.filter((o) => o.id !== id || o.kind === "close");
    this.exits.delete(id);
  }
  cancelAll() {
    this.orders = this.orders.filter((o) => o.kind === "close");
    this.exits.clear();
  }

  // ------------------------------------------------------------------- the emulator
  /** Before the script runs on bar i: fill what the bar's prices reach. */
  barOpen(i: number) {
    const R = this.R;
    const o = R.o[i];
    const h = R.h[i];
    const l = R.l[i];
    const c = R.c[i];
    // market orders at the open, in the order they were placed
    for (const ord of this.orders.slice()) {
      if (!this.orders.includes(ord)) continue;
      if (ord.kind === "close") {
        this.orders.splice(this.orders.indexOf(ord), 1);
        this.closeNow(ord, this.slip(o, -this.size > 0 ? 1 : -1));
        continue;
      }
      if (ord.limit === ord.limit || ord.stop === ord.stop) continue;
      this.orders.splice(this.orders.indexOf(ord), 1);
      this.fillOrder(ord, this.slip(o, ord.dir));
    }
    const path = h - o <= o - l ? [o, h, l, c] : [o, l, h, c];
    this.walk(o, o);
    for (let k = 0; k < 3; k++) this.walk(path[k], path[k + 1]);
    for (const t of this.open) {
      if (h > t.hi) t.hi = h;
      if (l < t.lo) t.lo = l;
    }
  }

  /** After the script ran on bar i: orders filled at the close (process_orders_on_close), the equity. */
  barClose(i: number) {
    const R = this.R;
    if (this.onClose) {
      const c = R.c[i];
      for (const ord of this.orders.slice()) {
        if (ord.bar !== i || ord.limit === ord.limit || ord.stop === ord.stop) continue;
        this.orders.splice(this.orders.indexOf(ord), 1);
        if (ord.kind === "close") this.closeNow(ord, c);
        else this.fillOrder(ord, this.slip(c, ord.dir));
      }
    }
    const eq = this.equityNow();
    this.equity[i] = eq;
    if (!(this.peak === this.peak) || eq > this.peak) this.peak = eq;
    const dd = this.peak - eq;
    if (dd > this.maxDD) {
      this.maxDD = dd;
      this.maxDDPct = this.peak > 0 ? (dd / this.peak) * 100 : 0;
    }
    if (!(this.trough === this.trough) || eq < this.trough) this.trough = eq;
    this.maxRunup = Math.max(this.maxRunup, eq - this.trough);
    this.maxHeld = Math.max(this.maxHeld, Math.abs(this.size));
  }

  private slip(price: number, dir: number): number {
    return price + dir * this.slippage * this.R.sym.mintick;
  }

  /** Price moves from a to b: fill the orders it reaches, nearest first. */
  private walk(a: number, b: number) {
    const tick = this.R.sym.mintick;
    for (let guard = 0; guard < 200; guard++) {
      let best: { at: number; run: () => void } | null = null;
      const consider = (level: number, side: "above" | "below", fillAt: (p: number) => number, run: (p: number) => void) => {
        if (!(level === level)) return;
        // already beyond the level where the move starts: fills at a; else where the move reaches it
        let at: number;
        if (side === "above" ? a >= level : a <= level) at = a;
        else if (side === "above" ? b >= level : b <= level) at = level;
        else return;
        const d = Math.abs(at - a);
        if (!best || d < Math.abs(best.at - a)) best = { at, run: () => run(fillAt(at)) };
      };
      for (const ord of this.orders) {
        if (ord.kind === "close") continue;
        const buy = ord.dir === 1;
        if (ord.stop === ord.stop && !ord.stopHit) {
          consider(ord.stop, buy ? "above" : "below", (p) => this.slip(p, ord.dir), (p) => {
            if (ord.limit === ord.limit) {
              ord.stopHit = true; // stop-limit: now a limit order
            } else {
              this.orders.splice(this.orders.indexOf(ord), 1);
              this.fillOrder(ord, p);
            }
          });
        } else if (ord.limit === ord.limit) {
          const lim = ord.limit + (buy ? -1 : 1) * this.limitTicks * tick;
          consider(lim, buy ? "below" : "above", (p) => (p === a ? (buy ? Math.min(ord.limit, a) : Math.max(ord.limit, a)) : ord.limit), (p) => {
            this.orders.splice(this.orders.indexOf(ord), 1);
            this.fillOrder(ord, p);
          });
        }
      }
      for (const e of this.exits.values()) {
        for (const t of this.open) {
          if ((e.from && t.entryId !== e.from) || t.spent.has(e.id)) continue;
          const [tp, sl] = this.levels(e, t);
          const sell = t.dir === 1; // closing a long sells
          consider(tp, sell ? "above" : "below", (p) => (p === a ? a : tp), (p) => this.exitFill(e, t, p, e.commentProfit || e.comment));
          consider(sl, sell ? "below" : "above", (p) => this.slip(p, -t.dir), (p) => this.exitFill(e, t, p, e.commentLoss || e.comment));
          // trailing stop: starts when the price reaches its level, then follows the best price by the offset
          const act = e.trailPrice === e.trailPrice ? e.trailPrice : e.trailPoints === e.trailPoints ? t.price + t.dir * e.trailPoints * tick : NaN;
          if (act === act && e.trailOffset === e.trailOffset) {
            const ext = t.trail.get(e.id);
            if (ext === undefined) consider(act, sell ? "above" : "below", (p) => p, (p) => t.trail.set(e.id, p));
            else consider(ext - t.dir * e.trailOffset * tick, sell ? "below" : "above", (p) => this.slip(p, -t.dir), (p) => this.exitFill(e, t, p, e.commentTrailing || e.comment));
          }
        }
      }
      if (!best) break;
      const chosen: { at: number; run: () => void } = best;
      chosen.run();
      a = chosen.at;
    }
    // started trailing stops follow the best price of the move
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    for (const t of this.open)
      for (const [id, ext] of t.trail) {
        const better = t.dir === 1 ? Math.max(ext, hi) : Math.min(ext, lo);
        if (better !== ext) t.trail.set(id, better);
      }
  }

  /** Take-profit and stop-loss prices of an exit for a trade (v6: of absolute and relative, the nearer). */
  private levels(e: Exit, t: Trade): [number, number] {
    const tick = this.R.sym.mintick;
    const rel = (ticks: number, sign: number) => (ticks === ticks ? t.price + sign * t.dir * ticks * tick : NaN);
    const tpRel = rel(e.profit, 1);
    const slRel = rel(e.loss, -1);
    let tp = e.limit === e.limit ? e.limit : tpRel;
    let sl = e.stop === e.stop ? e.stop : slRel;
    if (this.R.version >= 6) {
      if (e.limit === e.limit && tpRel === tpRel) tp = t.dir === 1 ? Math.min(e.limit, tpRel) : Math.max(e.limit, tpRel);
      if (e.stop === e.stop && slRel === slRel) sl = t.dir === 1 ? Math.max(e.stop, slRel) : Math.min(e.stop, slRel);
    }
    return [tp, sl];
  }

  private fee(qty: number, price: number): number {
    switch (this.commType) {
      case "cash_per_contract":
        return this.commValue * qty;
      case "cash_per_order":
        return this.commValue;
      default:
        return (this.commValue / 100) * qty * price;
    }
  }

  private fillOrder(o: Order, price: number) {
    if (o.oca && o.ocaType === "cancel") this.orders = this.orders.filter((x) => x.oca !== o.oca);
    if (o.kind === "entry") {
      const size = this.size;
      if (size * o.dir > 0) {
        // pyramiding: one more entry the same way, if allowed
        const same = this.open.filter((t) => t.dir === o.dir).length;
        if (same >= this.pyramiding) return;
        this.openTrade(o.id, o.dir, o.qty ?? 0, price, o.comment);
        return;
      }
      if (size * o.dir < 0) this.closeTrades(this.open.slice(), price, o.id, o.comment, Infinity);
      this.openTrade(o.id, o.dir, o.qty ?? 0, price, o.comment);
      return;
    }
    // strategy.order: buys or sells the quantity; against the position it closes trades first
    let q = o.qty ?? 0;
    if (this.size * o.dir < 0) {
      const closed = this.closeTrades(this.open.slice(), price, o.id, o.comment, q);
      q -= closed;
    }
    if (q > 1e-12) this.openTrade(o.id, o.dir, q, price, o.comment);
  }

  private closeNow(o: Order, price: number) {
    const ts = this.open.filter((t) => !o.of || t.entryId === o.of);
    if (!ts.length) return;
    const total = ts.reduce((s, t) => s + t.qty, 0);
    const q = o.qty != null ? Math.min(total, o.qty) : (total * Math.min(100, Math.max(0, o.pct))) / 100;
    this.closeTrades(ts, price, o.comment || (o.of ? `Close entry(s) order ${o.of}` : "Close position order"), "", q, o.comment);
  }

  private exitFill(e: Exit, t: Trade, price: number, comment: string) {
    if (!this.open.includes(t)) return;
    const want = e.qty === e.qty ? e.qty : (t.qty0 * Math.min(100, Math.max(0, e.pct))) / 100;
    const q = Math.min(t.qty, want);
    t.spent.add(e.id);
    this.closeTrades([t], price, e.id, comment, q);
  }

  private openTrade(id: string, dir: 1 | -1, qty: number, price: number, comment: string) {
    if (!(qty > 0)) return;
    const R = this.R;
    const fee = this.fee(qty, price);
    this.commission += fee; // booked in the trade's profit when it closes
    this.open.push({ entryId: id, dir, qty, qty0: qty, price, bar: R.i, time: R.t[R.i], comment, feePer: fee / qty, hi: price, lo: price, spent: new Set(), trail: new Map() });
    this.fills.push({ bar: R.i, time: R.t[R.i], price, qty, dir, id, comment, entry: true });
    if (this.fills.length > 9000) this.fills.splice(0, this.fills.length - 9000);
  }

  /** Close up to `max` units of these trades (oldest first) at `price`. Returns how many units closed. */
  private closeTrades(ts: Trade[], price: number, exitId: string, comment: string, max: number, exitComment = comment): number {
    const R = this.R;
    let left = max;
    let done = 0;
    for (const t of ts) {
      if (!(left > 1e-12)) break;
      const q = Math.min(t.qty, left);
      const exitFee = this.fee(q, price);
      const entryFee = t.feePer * q;
      this.commission += exitFee;
      const gross = (price - t.price) * t.dir * q;
      const profit = gross - exitFee - entryFee;
      this.netProfit += profit;
      if (profit > 0) {
        this.grossProfit += profit;
        this.wins++;
      } else if (profit < 0) {
        this.grossLoss -= profit;
        this.losses++;
      } else this.evens++;
      const runup = Math.max(0, (t.dir === 1 ? Math.max(t.hi, price) - t.price : t.price - Math.min(t.lo, price)) * q);
      const drawdown = Math.max(0, (t.dir === 1 ? t.price - Math.min(t.lo, price) : Math.max(t.hi, price) - t.price) * q);
      this.closed.push({
        entryId: t.entryId, exitId, dir: t.dir, qty: q, entryPrice: t.price, exitPrice: price, entryBar: t.bar, exitBar: R.i,
        entryTime: t.time, exitTime: R.t[R.i], entryComment: t.comment, exitComment, profit, commission: exitFee + entryFee, runup, drawdown,
      });
      if (this.closed.length > 9000) this.closed.splice(0, this.closed.length - 9000);
      t.qty -= q;
      left -= q;
      done += q;
      if (t.qty <= 1e-12) this.open.splice(this.open.indexOf(t), 1);
    }
    if (done > 0) {
      const dir = (ts[0]?.dir === 1 ? -1 : 1) as 1 | -1;
      this.fills.push({ bar: R.i, time: R.t[R.i], price, qty: done, dir, id: exitId, comment, entry: false });
    }
    return done;
  }

  report(): StrategyReport {
    const R = this.R;
    const first = R.n ? R.o[0] : NaN;
    const last = R.n ? R.c[R.n - 1] : NaN;
    const hold = new Float64Array(R.n).fill(NaN);
    if (first > 0) for (let i = 0; i < R.n; i++) hold[i] = (this.initial * R.c[i]) / first;
    return {
      initialCapital: this.initial,
      currency: this.currency,
      netProfit: this.netProfit,
      grossProfit: this.grossProfit,
      grossLoss: this.grossLoss,
      commission: this.commission,
      openProfit: R.n ? this.openProfit(last) : 0,
      trades: this.closed,
      open: this.open,
      fills: this.fills,
      equity: this.equity,
      equityTimes: R.t,
      maxDrawdown: this.maxDD,
      maxDrawdownPct: this.maxDDPct,
      maxRunup: this.maxRunup,
      buyHold: first > 0 ? ((last - first) / first) * 100 : NaN,
      buyHoldEquity: hold,
      maxHeld: this.maxHeld,
    };
  }
}

const floorQty = (q: number) => (q > 0 ? Math.floor(q * 1e8 + 1e-6) / 1e8 : 0);

// ----------------------------------------------------------------------------- strategy.* for scripts

function broker(R: Runtime): Broker | null {
  return R.strat;
}
const dirOf = (v: unknown): 1 | -1 => {
  if (v === "long" || v === 1 || v === true) return 1;
  if (v === "short" || v === -1 || v === false) return -1;
  throw new PineError("方向要是 strategy.long 或 strategy.short");
};
const s = (v: unknown) => (typeof v === "string" ? v : "");
function args(pos: unknown[], named: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const o: Record<string, unknown> = { ...named };
  for (let i = 0; i < pos.length && i < names.length; i++) if (pos[i] !== undefined && o[names[i]] === undefined) o[names[i]] = pos[i];
  return o;
}

const ENTRY = ["id", "direction", "qty", "limit", "stop", "oca_name", "oca_type", "comment", "alert_message", "disable_alert"];
const EXIT = ["id", "from_entry", "qty", "qty_percent", "profit", "limit", "loss", "stop", "trail_price", "trail_points", "trail_offset", "oca_name", "comment", "comment_profit", "comment_loss", "comment_trailing", "alert_message", "alert_profit", "alert_loss", "alert_trailing", "disable_alert"];
const CLOSE = ["id", "comment", "qty", "qty_percent", "alert_message", "immediately", "disable_alert"];

const trade = (pick: (t: ClosedTrade) => unknown) => ({
  p: ["trade_num"],
  f: (R: Runtime, a: unknown[]) => {
    const b = broker(R);
    const t = b?.closed[toInt(a[0])];
    return t ? pick(t) : NaN;
  },
});
const openTrade = (pick: (t: Trade, b: Broker) => unknown) => ({
  p: ["trade_num"],
  f: (R: Runtime, a: unknown[]) => {
    const b = broker(R);
    const t = b?.open[toInt(a[0])];
    return t && b ? pick(t, b) : NaN;
  },
});

export const STRATEGY: Lib = {
  "strategy.entry": {
    p: ENTRY,
    n: (R, pos, named) => {
      const b = broker(R);
      if (!b) return NaN;
      const a = args(pos, named, ENTRY);
      if (a.when !== undefined && !a.when) return NaN;
      b.entry(String(a.id ?? ""), dirOf(a.direction), a.qty, a.limit, a.stop, s(a.comment), s(a.oca_name), s(a.oca_type));
      return NaN;
    },
  },
  "strategy.order": {
    p: ENTRY,
    n: (R, pos, named) => {
      const b = broker(R);
      if (!b) return NaN;
      const a = args(pos, named, ENTRY);
      if (a.when !== undefined && !a.when) return NaN;
      b.order(String(a.id ?? ""), dirOf(a.direction), a.qty, a.limit, a.stop, s(a.comment), s(a.oca_name), s(a.oca_type));
      return NaN;
    },
  },
  "strategy.exit": {
    p: EXIT,
    n: (R, pos, named) => {
      const b = broker(R);
      if (!b) return NaN;
      const a = args(pos, named, EXIT);
      if (a.when !== undefined && !a.when) return NaN;
      b.exit(a);
      return NaN;
    },
  },
  "strategy.close": {
    p: CLOSE,
    n: (R, pos, named) => {
      const b = broker(R);
      if (!b) return NaN;
      const a = args(pos, named, CLOSE);
      if (a.when !== undefined && !a.when) return NaN;
      b.closeOrder(String(a.id ?? ""), s(a.comment), a.qty, a.qty_percent, !!a.immediately);
      return NaN;
    },
  },
  "strategy.close_all": {
    p: ["comment", "alert_message", "immediately", "disable_alert"],
    n: (R, pos, named) => {
      const b = broker(R);
      if (!b) return NaN;
      const a = args(pos, named, ["comment", "alert_message", "immediately", "disable_alert"]);
      if (a.when !== undefined && !a.when) return NaN;
      b.closeOrder("", s(a.comment), undefined, 100, !!a.immediately);
      return NaN;
    },
  },
  "strategy.cancel": {
    p: ["id"],
    f: (R, a) => {
      broker(R)?.cancel(String(a[0] ?? ""));
      return NaN;
    },
  },
  "strategy.cancel_all": {
    p: [],
    f: (R) => {
      broker(R)?.cancelAll();
      return NaN;
    },
  },
  "strategy.risk.allow_entry_in": {
    p: ["value"],
    f: (R, a) => {
      const b = broker(R);
      if (b) b.allow = a[0] === "long" ? "long" : a[0] === "short" ? "short" : "all";
      return NaN;
    },
  },
  "strategy.risk.max_drawdown": { p: ["value", "type", "alert_message"], f: (R) => (R.warn("strategy.risk.max_drawdown 不支援"), NaN) },
  "strategy.risk.max_intraday_loss": { p: ["value", "type", "alert_message"], f: (R) => (R.warn("strategy.risk.max_intraday_loss 不支援"), NaN) },
  "strategy.risk.max_position_size": { p: ["contracts"], f: (R) => (R.warn("strategy.risk.max_position_size 不支援"), NaN) },
  "strategy.risk.max_cons_loss_days": { p: ["count", "alert_message"], f: () => NaN },
  "strategy.risk.max_intraday_filled_orders": { p: ["count", "alert_message"], f: () => NaN },

  "strategy.closedtrades.entry_price": trade((t) => t.entryPrice),
  "strategy.closedtrades.exit_price": trade((t) => t.exitPrice),
  "strategy.closedtrades.entry_bar_index": trade((t) => t.entryBar),
  "strategy.closedtrades.exit_bar_index": trade((t) => t.exitBar),
  "strategy.closedtrades.entry_time": trade((t) => t.entryTime),
  "strategy.closedtrades.exit_time": trade((t) => t.exitTime),
  "strategy.closedtrades.entry_id": trade((t) => t.entryId),
  "strategy.closedtrades.exit_id": trade((t) => t.exitId),
  "strategy.closedtrades.entry_comment": trade((t) => t.entryComment),
  "strategy.closedtrades.exit_comment": trade((t) => t.exitComment),
  "strategy.closedtrades.size": trade((t) => t.dir * t.qty),
  "strategy.closedtrades.profit": trade((t) => t.profit),
  "strategy.closedtrades.profit_percent": trade((t) => (t.profit / (t.entryPrice * t.qty)) * 100),
  "strategy.closedtrades.commission": trade((t) => t.commission),
  "strategy.closedtrades.max_runup": trade((t) => t.runup),
  "strategy.closedtrades.max_drawdown": trade((t) => t.drawdown),
  "strategy.opentrades.entry_price": openTrade((t) => t.price),
  "strategy.opentrades.entry_bar_index": openTrade((t) => t.bar),
  "strategy.opentrades.entry_time": openTrade((t) => t.time),
  "strategy.opentrades.entry_id": openTrade((t) => t.entryId),
  "strategy.opentrades.entry_comment": openTrade((t) => t.comment),
  "strategy.opentrades.size": openTrade((t) => t.dir * t.qty),
  "strategy.opentrades.profit": openTrade((t, b) => (b.R.c[b.R.i] - t.price) * t.dir * t.qty - t.feePer * t.qty),
  "strategy.opentrades.commission": openTrade((t) => t.feePer * t.qty),
  "strategy.opentrades.max_runup": openTrade((t) => Math.max(0, (t.dir === 1 ? t.hi - t.price : t.price - t.lo) * t.qty)),
  "strategy.opentrades.max_drawdown": openTrade((t) => Math.max(0, (t.dir === 1 ? t.price - t.lo : t.hi - t.price) * t.qty)),
  "strategy.convert_to_account": { p: ["value"], f: (_R, a) => num(a[0]) },
  "strategy.convert_to_symbol": { p: ["value"], f: (_R, a) => num(a[0]) },
  "strategy.default_entry_qty": {
    p: ["fill_price"],
    f: (R, a) => {
      const b = broker(R);
      if (!b) return NaN;
      const p = num(a[0]);
      return b.qtyType === "cash" ? floorQty(b.qtyValue / p) : b.qtyType === "percent_of_equity" ? floorQty((b.equityNow() * b.qtyValue) / 100 / p) : b.qtyValue;
    },
  },
};

/** strategy.position_size and the other variables. */
export function strategyVar(R: Runtime, name: string): unknown {
  const b = R.strat;
  if (!b) return name === "strategy.position_size" || name.endsWith("trades") ? 0 : NaN;
  switch (name) {
    case "strategy.position_size":
      return b.size;
    case "strategy.position_avg_price":
      return b.avgPrice();
    case "strategy.position_entry_name":
      return b.open[0]?.entryId ?? "";
    case "strategy.equity":
      return b.equityNow();
    case "strategy.netprofit":
      return b.netProfit;
    case "strategy.netprofit_percent":
      return (b.netProfit / b.initial) * 100;
    case "strategy.openprofit":
      return b.openProfit();
    case "strategy.openprofit_percent":
      return (b.openProfit() / b.initial) * 100;
    case "strategy.grossprofit":
      return b.grossProfit;
    case "strategy.grossloss":
      return b.grossLoss;
    case "strategy.closedtrades":
      return b.closed.length;
    case "strategy.opentrades":
      return b.open.length;
    case "strategy.wintrades":
      return b.wins;
    case "strategy.losstrades":
      return b.losses;
    case "strategy.eventrades":
      return b.evens;
    case "strategy.initial_capital":
      return b.initial;
    case "strategy.max_drawdown":
      return b.maxDD;
    case "strategy.max_drawdown_percent":
      return b.maxDDPct;
    case "strategy.max_runup":
      return b.maxRunup;
    case "strategy.max_contracts_held_all":
    case "strategy.max_contracts_held_long":
    case "strategy.max_contracts_held_short":
      return b.maxHeld;
    case "strategy.avg_trade":
      return b.closed.length ? b.netProfit / b.closed.length : NaN;
    case "strategy.avg_winning_trade":
      return b.wins ? b.grossProfit / b.wins : NaN;
    case "strategy.avg_losing_trade":
      return b.losses ? b.grossLoss / b.losses : NaN;
    case "strategy.account_currency":
      return b.currency;
    case "strategy.closedtrades.first_index":
      return 0;
    case "strategy.margin_liquidation_price":
      return NaN;
  }
  return NaN;
}
