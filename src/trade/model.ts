// Turning a position on the chart into an OKX order: contracts from the planned quantity (whole steps,
// rounded down), prices on the tick, the margin and risk of what is actually sent, and what stops the order
// or deserves a warning. Pure functions (no DOM), unit-tested in tests/order.test.ts.

import type { OrderReq } from "../core/api.ts";

export type OrdType = OrderReq["ordType"];
export type TdMode = OrderReq["tdMode"];
/** What the order window starts with (the last choices). */
export type OrderPrefs = { ordType: OrdType; tdMode: TdMode; attachTp: boolean };
export const DEFAULT_ORDER_PREFS: OrderPrefs = { ordType: "limit", tdMode: "isolated", attachTp: true };

export const ORD_TYPE_TEXT: Record<OrdType, string> = { limit: "掛單（限價）", post_only: "只做 Maker", market: "市價" };
export const TD_MODE_TEXT: Record<TdMode, string> = { isolated: "逐倉", cross: "全倉" };

export function cleanOrderPrefs(raw: unknown): OrderPrefs {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_ORDER_PREFS;
  return {
    ordType: r.ordType === "post_only" || r.ordType === "market" ? r.ordType : d.ordType,
    tdMode: r.tdMode === "cross" ? "cross" : d.tdMode,
    attachTp: r.attachTp !== false,
  };
}

/** Contract size and limits of a symbol (from the symbol list). */
export type ContractSpec = { ctVal: number; lotSz: string; minSz: string; maxLever: number; tickSz: string };

/** Decimals of a step such as "0.01" (2), "1" (0) or "0.0000000001" (10). */
export function stepDecimals(step: string): number {
  const i = step.indexOf(".");
  return i < 0 ? 0 : step.slice(i + 1).replace(/0+$/, "").length;
}
/** v in whole steps, rounded down (a hair of float error counts as a whole step), as text. */
export function floorStep(v: number, step: string): string {
  const s = Number(step);
  if (!(s > 0) || !(v > 0)) return (0).toFixed(stepDecimals(step));
  return (Math.floor(v / s + 1e-9) * s).toFixed(stepDecimals(step));
}
/** v on the nearest step, as text. */
export function roundStep(v: number, step: string): string {
  const s = Number(step);
  if (!(s > 0)) return String(v);
  return (Math.round(v / s) * s).toFixed(stepDecimals(step));
}

export type OrderInput = {
  instId: string;
  entry: number;
  stop: number;
  target: number;
  /** Planned quantity in coins (the position's sizing). */
  qty: number;
  leverage: number;
  /** Latest price, and USDT free for margin (null: unknown). */
  last: number | null;
  avail: number | null;
  spec: ContractSpec;
  prefs: OrderPrefs;
};

export type OrderPlan = {
  side: "buy" | "sell";
  px: string | null;
  sz: string;
  contracts: number;
  coins: number;
  /** At the order price (market: the latest price). */
  notional: number;
  margin: number;
  /** Lost at the stop. */
  risk: number;
  sl: string;
  tp: string | null;
  /** Anything here blocks the order. */
  problems: string[];
  warnings: string[];
};

export function planOrder(i: OrderInput): OrderPlan {
  const { spec, prefs } = i;
  const long = i.stop < i.entry;
  const side = long ? "buy" : "sell";
  const market = prefs.ordType === "market";
  const problems: string[] = [];
  const warnings: string[] = [];

  const px = market ? null : roundStep(i.entry, spec.tickSz);
  const ref = market ? i.last ?? i.entry : Number(px);
  const sl = roundStep(i.stop, spec.tickSz);
  const tp = prefs.attachTp ? roundStep(i.target, spec.tickSz) : null;
  const sz = spec.ctVal > 0 ? floorStep(i.qty / spec.ctVal, spec.lotSz) : "0";
  const contracts = Number(sz);
  const coins = contracts * spec.ctVal;
  const notional = coins * ref;
  const margin = notional / Math.max(1, i.leverage);
  const risk = coins * Math.abs(ref - Number(sl));

  if (!(spec.ctVal > 0)) problems.push("讀不到這個幣種的合約大小，請稍後再試");
  else if (contracts < Number(spec.minSz)) {
    problems.push(`數量太小：最少 ${spec.minSz} 張，這個倉位只有 ${fmtCoins(i.qty)}`);
  }
  if (spec.maxLever > 0 && i.leverage > spec.maxLever) problems.push(`這個幣種最高 ${spec.maxLever} 倍，倉位設了 ${i.leverage} 倍`);
  if (!Number.isInteger(i.leverage)) problems.push("OKX 的槓桿要是整數倍");
  if (long ? Number(sl) >= ref : Number(sl) <= ref) problems.push(market ? "現價已經到止損另一邊了" : "止損要在進場價的另一邊");
  if (tp != null && (long ? Number(tp) <= ref : Number(tp) >= ref)) {
    if (market) problems.push("現價已經過了止盈");
    else problems.push("止盈要在進場價的獲利那一邊");
  }

  if (!market && i.last != null && i.last > 0) {
    const crosses = long ? Number(px) > i.last : Number(px) < i.last;
    if (crosses && prefs.ordType === "post_only") problems.push("只做 Maker 不能吃單，請改掛單或市價");
    else if (crosses) warnings.push(`掛單價${long ? "高於" : "低於"}現價，送出後會馬上成交（吃單）`);
    const away = Math.abs(Number(px) / i.last - 1);
    if (away > 0.05) warnings.push(`掛單價離現價 ${(away * 100).toFixed(1)}%`);
  }
  if (i.avail != null && margin > i.avail) warnings.push(`保證金約 ${margin.toFixed(2)} U，超過可用的 ${i.avail.toFixed(2)} U，交易所可能拒單`);
  if (contracts > 0 && Math.abs(coins - i.qty) / i.qty > 0.02) {
    warnings.push(`數量取整為 ${fmtCoins(coins)}，風險約 ${risk.toFixed(2)} U`);
  }
  return { side, px, sz, contracts, coins, notional, margin, risk, sl, tp, problems, warnings };
}

/** A waiting order as kept on its position (the fields the change needs). */
export type WaitingOrder = { side: "buy" | "sell"; ordType: OrdType; px: number | null; sz: number; sl?: number; tp?: number | null; algoClOrdId?: string; algoId?: string };

/** A waiting order's position changed on the chart, as the change of the order on OKX: only what differs, the
 *  lines old → new for the window, the new size and risk, what blocks it and what to know. */
export type AmendPlan = {
  change: { px?: string; sz?: string; sl?: string; tp?: string };
  lines: string[];
  contracts: number;
  coins: number;
  risk: number;
  margin: number;
  problems: string[];
  warnings: string[];
};

/**
 * The order `o` with the position's prices as they are now (`i`) and the size worked out again from its risk,
 * as placing it would have (planOrder). Its side, type and leverage stay: what changes them needs a new order.
 */
export function planAmend(o: WaitingOrder, i: Omit<OrderInput, "prefs">, fmt: (p: number) => string): AmendPlan {
  const plan = planOrder({ ...i, prefs: { ordType: o.ordType, tdMode: "isolated", attachTp: o.tp != null } });
  const problems = [...plan.problems];
  const warnings = [...plan.warnings];
  if (o.ordType === "market") problems.push("市價單不能改");
  if (plan.side !== o.side) problems.push("多空方向不能改，要改請撤單重下");
  const half = (Number(i.spec.tickSz) || 0) / 2;
  const differs = (now: number | null | undefined, next: string) => now == null || Math.abs(now - Number(next)) > half;
  const change: AmendPlan["change"] = {};
  const lines: string[] = [];
  if (plan.px != null && differs(o.px, plan.px)) {
    change.px = plan.px;
    lines.push(`掛單價 ${o.px == null ? "—" : fmt(o.px)} → ${fmt(Number(plan.px))}`);
  }
  if (plan.contracts !== o.sz) {
    change.sz = plan.sz;
    lines.push(`張數 ${fmtCoins(o.sz)} → ${plan.sz}`);
  }
  if (differs(o.sl, plan.sl)) {
    change.sl = plan.sl;
    lines.push(`止損 ${o.sl == null ? "—" : fmt(o.sl)} → ${fmt(Number(plan.sl))}`);
  }
  if (plan.tp != null && differs(o.tp, plan.tp)) {
    change.tp = plan.tp;
    lines.push(`止盈 ${o.tp == null ? "—" : fmt(o.tp)} → ${fmt(Number(plan.tp))}`);
  }
  if ((change.sl || change.tp) && !o.algoClOrdId && !o.algoId) problems.push("找不到這張單附帶的止損止盈，請撤單重下");
  return { change, lines, contracts: plan.contracts, coins: plan.coins, risk: plan.risk, margin: plan.margin, problems, warnings };
}

/** Coins without trailing zeros, up to 8 decimals. */
export function fmtCoins(v: number): string {
  return v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(Number(v.toFixed(8)));
}

/** A client order id: "qtc" + time + random, letters and digits only (OKX allows up to 32). */
export function newClOrdId(now = Date.now(), rnd = Math.random): string {
  return `qtc${now.toString(36)}${Math.floor(rnd() * 36 ** 6).toString(36).padStart(6, "0")}`;
}

/** Order states that can still change (worth asking the exchange about). */
export const isOpenState = (s: string) => s === "live" || s === "partially_filled" || s === "unknown";
