// Matching the OKX account (src-tauri/src/sync.rs) to the positions drawn on the charts. Pure (no DOM, no
// calls), unit-tested in tests/sync.test.ts.
//
// - An order placed from a position belongs to the OKX position of its side once it has filled (posKey). Its
//   stop-loss / take-profit order is found by the id it was given (algoClOrdId), by the id found before
//   (algoId), or, for an order from before ids were given, by its stop price (the only one there).
// - When OKX moves a stop-loss or take-profit, the drawing follows.
// - A position on OKX with no order of ours in it is drawn on its own (OkxPos) and kept up to date. One that
//   opens while an order of ours on its side is still waiting is most likely that order filling (OKX can report
//   the position before the order): it is drawn only if no order of ours is in it after a few seconds, and a
//   drawing made from it before the order showed goes once the order is matched to it.
// - When a position is gone from OKX, how it ended is looked up (closed positions) and kept on its drawings.
// - An add that fills moves the earlier orders' stop-loss / take-profit to its own (stopMoves); a stop-loss or
//   take-profit moved on the chart goes to OKX after a confirmation (stopEdits).

import type { AmendReq, ClosedPos, SyncAlgo, SyncOrder, SyncPos } from "../core/api.ts";
import { newId, type Drawing, type OkxClosed, type OkxPos, type PositionDrawing, type PositionOrder } from "../settings/model.ts";

export type Side = "long" | "short";

/** One symbol's part of the account, and what is needed to draw from it. */
export type SymbolState = {
  instId: string;
  /** The account followed is OKX's demo trading. */
  demo: boolean;
  positions: readonly SyncPos[];
  algos: readonly SyncAlgo[];
  /** Price step; coins per contract. */
  tick: number;
  ctVal: number;
};

const WEEK = 7 * 86_400;
/** How long a new position waits for an order of ours to show up in it before it is drawn on its own, ms. */
const ORDER_GRACE = 15_000;
const ORDER_STATES = new Set(["live", "partially_filled", "filled", "canceled", "mmp_canceled"]);

export const sideOfPos = (p: SyncPos): Side => (p.posSide === "short" || (p.posSide === "net" && p.pos < 0) ? "short" : "long");
export const posKeyOf = (p: { posId: string; cTime: number }) => `${p.posId}:${p.cTime}`;
const sideOfOrder = (o: PositionOrder): Side => (o.side === "buy" ? "long" : "short");
const dirOf = (s: Side): 1 | -1 => (s === "long" ? 1 : -1);
/** The side of an order that closes a position of this side. */
const closingSide = (s: Side) => (s === "long" ? "sell" : "buy");
export const isFilled = (o: PositionOrder) => o.state === "filled" || o.state === "partially_filled";
const isPosition = (d: Drawing): d is PositionDrawing => d.kind === "position";

/** The same price, to half a price step. */
export const samePrice = (a: number, b: number, tick: number) => Math.abs(a - b) <= Math.max(tick, Math.abs(b) * 1e-9) * 0.51;

/** Decimals of a price step (0.1 → 1, 0.25 → 2, 5 → 0). */
export function stepDecimals(tick: number): number {
  for (let d = 0; d <= 12; d++) {
    const v = tick * 10 ** d;
    if (Math.abs(v - Math.round(v)) < 1e-9 * Math.max(1, v)) return d;
  }
  return 12;
}
/** A price as OKX takes it: plain digits on the price step. */
export const priceArg = (v: number, tick: number) => (tick > 0 ? Math.round(v / tick) * tick : v).toFixed(stepDecimals(tick));

/** The stop-loss / take-profit orders that close position p. */
export function algosOf(p: SyncPos, algos: readonly SyncAlgo[]): SyncAlgo[] {
  const close = closingSide(sideOfPos(p));
  return algos.filter((a) => a.instId === p.instId && a.side === close && a.posSide === p.posSide);
}

/** Its stop-loss and take-profit as drawn: of the order that closes all of it, else of the largest one. */
export function stopsOf(p: SyncPos, algos: readonly SyncAlgo[]): { sl: number | null; tp: number | null } {
  const mine = algosOf(p, algos);
  const pick = (f: (a: SyncAlgo) => number | null): number | null => {
    const all = mine.filter((a) => f(a) != null);
    const whole = all.find((a) => a.closeFraction);
    if (whole) return f(whole);
    const big = [...all].sort((a, b) => b.sz - a.sz)[0];
    return big ? f(big) : null;
  };
  return { sl: pick((a) => a.sl), tp: pick((a) => a.tp) };
}

/** The open position an order of ours went into: its side's, opened before the order filled (an order from
 *  before fill times were kept: placed at most a day before it opened). */
export function positionOfOrder(o: PositionOrder, s: SymbolState): SyncPos | undefined {
  if (!isFilled(o) || o.demo !== s.demo || o.closed) return undefined;
  const side = sideOfOrder(o);
  if (o.posKey) return s.positions.find((x) => posKeyOf(x) === o.posKey);
  const p = s.positions.find((x) => x.instId === s.instId && sideOfPos(x) === side);
  if (!p) return undefined;
  if (o.fillT != null) return o.fillT >= p.cTime - 5_000 ? p : undefined;
  return o.at * 1000 >= p.cTime - 86_400_000 ? p : undefined;
}

/** The TP/SL order of an order of ours that filled: by its ids, or, for an order from before ids were given, the
 *  only one of its side at its stop price that has no id of its own and isn't another order's (`taken`). */
export function algoOfOrder(o: PositionOrder, stop: number, s: SymbolState, taken: ReadonlySet<string>): SyncAlgo | undefined {
  const mine = s.algos.filter((a) => a.instId === s.instId);
  if (o.algoClOrdId) {
    const a = mine.find((x) => x.algoClOrdId === o.algoClOrdId);
    if (a || !o.algoId) return a;
  }
  if (o.algoId) return mine.find((x) => x.algoId === o.algoId);
  const close = closingSide(sideOfOrder(o));
  const want = o.sl ?? stop;
  const cands = mine.filter((x) => !taken.has(x.algoId) && !x.algoClOrdId && x.side === close && x.sl != null && samePrice(x.sl, want, s.tick));
  return cands.length === 1 ? cands[0] : undefined;
}

/** Set a drawing's stop-loss / take-profit to OKX's (the take-profit only on the profit side); true when moved. */
function follow(d: PositionDrawing, sl: number | null, tp: number | null, tick: number): boolean {
  const dir = d.dir ?? (d.b.p <= d.a.p ? 1 : -1);
  let moved = false;
  if (sl != null && !samePrice(d.b.p, sl, tick) && !samePrice(sl, d.a.p, tick)) {
    d.b = { ...d.b, p: sl };
    moved = true;
  }
  if (tp != null && !samePrice(d.target, tp, tick) && (tp - d.a.p) * dir > 0) {
    d.target = tp;
    moved = true;
  }
  return moved;
}

export type SyncResult = {
  changed: boolean;
  /** Positions that are gone from OKX: how they ended is to be looked up. */
  gone: { posId: string; cTime: number }[];
};

/**
 * Bring one symbol's drawings in line with the account: order changes, which position each filled order went
 * into, stop-losses and take-profits moved on OKX, positions opened elsewhere (drawn, kept up to date),
 * positions gone. Changes `list` in place. `now`: UTC seconds.
 */
export function applySync(list: Drawing[], s: SymbolState, orders: readonly SyncOrder[], now: number): SyncResult {
  let changed = false;
  const gone = new Map<string, { posId: string; cTime: number }>();
  const positions = list.filter(isPosition);

  // orders of ours: what OKX says about them now
  for (const d of positions) {
    const o = d.order;
    if (!o || o.demo !== s.demo) continue;
    if (d.dir == null) {
      d.dir = dirOf(sideOfOrder(o)); // on OKX now: its direction is that of its order
      changed = true;
    }
    for (const u of orders) {
      if (u.ordId !== o.ordId) continue;
      const fillT = u.accFillSz > 0 ? u.fillTime || u.uTime || undefined : undefined;
      const next: PositionOrder = {
        ...d.order!,
        state: ORDER_STATES.has(u.state) ? u.state : d.order!.state,
        fillSz: u.accFillSz,
        avgPx: u.avgPx ?? d.order!.avgPx,
        ...(fillT ? { fillT } : {}),
      };
      if (JSON.stringify(next) !== JSON.stringify(d.order)) {
        d.order = next;
        changed = true;
      }
      // still waiting to fill: its attached stop-loss and take-profit as they are now
      if (u.state === "live") changed = follow(d, u.sl, u.tp, s.tick) || changed;
    }
  }

  // filled ones: the position they went into, and their stop-loss / take-profit order
  const taken = new Set<string>();
  const byId = [...positions].sort((a, b) => Number(!a.order?.algoClOrdId) - Number(!b.order?.algoClOrdId)); // ids first
  for (const d of byId) {
    let o = d.order;
    if (!o || o.demo !== s.demo || o.closed || !isFilled(o)) continue;
    if (o.posKey && !s.positions.some((p) => posKeyOf(p) === o!.posKey)) {
      const [posId, cTime] = o.posKey.split(":");
      gone.set(o.posKey, { posId, cTime: Number(cTime) });
      continue;
    }
    if (!o.posKey) {
      const p = positionOfOrder(o, s);
      if (!p) continue;
      o = d.order = { ...o, posKey: posKeyOf(p) };
      changed = true;
    }
    const a = algoOfOrder(o, d.b.p, s, taken);
    if (!a) continue;
    taken.add(a.algoId);
    if (o.algoId !== a.algoId) {
      d.order = { ...o, algoId: a.algoId };
      changed = true;
    }
    changed = follow(d, a.sl, a.tp, s.tick) || changed;
  }

  // positions opened elsewhere: drawn on their own, kept up to date
  for (const p of s.positions) {
    if (p.instId !== s.instId) continue;
    const key = posKeyOf(p);
    const fromIt = (x: PositionDrawing) => !!x.okx && !x.okx.closed && x.okx.demo === s.demo && posKeyOf(x.okx) === key;
    if (positions.some((d) => d.order?.posKey === key)) {
      // orders of ours are in it and show it; drawn from it before they were known: not twice
      if (removeWhere(list, positions, fromIt)) changed = true;
      continue;
    }
    const side = sideOfPos(p);
    const dir = dirOf(side);
    const { sl, tp } = stopsOf(p, s.algos);
    const okx: OkxPos = {
      posId: p.posId, cTime: p.cTime, side, demo: s.demo,
      coins: Math.abs(p.pos) * s.ctVal, lever: p.lever > 0 ? p.lever : 1, noSl: sl == null, noTp: tp == null,
    };
    // without a stop-loss or take-profit on OKX, a stand-in one step from the entry (not drawn)
    const stop = sl ?? p.avgPx - dir * s.tick;
    const target = tp ?? p.avgPx + dir * s.tick;
    const d = positions.find((x) => x.okx && posKeyOf(x.okx) === key && x.okx.demo === s.demo);
    if (!d) {
      const waiting = positions.some((x) => {
        const o = x.order;
        return !!o && o.demo === s.demo && !o.closed && !o.posKey && sideOfOrder(o) === side && (o.state === "live" || isFilled(o));
      });
      if (waiting && now * 1000 - p.cTime < ORDER_GRACE) continue; // likely that order filling: see shortly
      const nd: PositionDrawing = {
        id: newId("okx"), kind: "position", a: { t: Math.floor(p.cTime / 1000), p: p.avgPx }, b: { t: now + WEEK, p: stop }, target,
        capital: null, risk: 1, riskMode: "pct", leverage: Math.min(125, Math.max(1, Math.round(okx.lever))), okx, dir,
      };
      list.push(nd);
      positions.push(nd);
      changed = true;
      continue;
    }
    const before = JSON.stringify(d);
    d.okx = { ...okx, ...(d.okx?.closed ? { closed: d.okx.closed } : {}) };
    d.dir = dir;
    if (!samePrice(d.a.p, p.avgPx, s.tick)) d.a = { ...d.a, p: p.avgPx }; // adds and partial closes move the average
    if (!samePrice(d.b.p, stop, s.tick)) d.b = { ...d.b, p: stop };
    if (!samePrice(d.target, target, s.tick)) d.target = target;
    if (d.b.t < now + 86_400) d.b = { ...d.b, t: now + WEEK }; // the box runs past now while it is open
    if (JSON.stringify(d) !== before) changed = true;
  }

  // drawn from a position that is gone: how it ended is to be looked up
  for (const d of positions) {
    const k = d.okx;
    if (!k || k.closed || k.demo !== s.demo) continue;
    if (!s.positions.some((p) => posKeyOf(p) === posKeyOf(k))) gone.set(posKeyOf(k), { posId: k.posId, cTime: k.cTime });
  }
  return { changed, gone: [...gone.values()] };
}

/** Take out the positions `f` picks, from the list and from `positions`; true when any went. */
function removeWhere(list: Drawing[], positions: PositionDrawing[], f: (d: PositionDrawing) => boolean): boolean {
  let removed = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    if (isPosition(d) && f(d)) {
      list.splice(i, 1);
      removed = true;
    }
  }
  for (let i = positions.length - 1; i >= 0; i--) if (f(positions[i])) positions.splice(i, 1);
  return removed;
}

/** How a position ended (OKX's position history, or unknown: px 0) onto the drawings that show it; true when any
 *  changed. A position drawn from OKX ends its box there; one with orders of ours shows it ended there. */
export function applyClosed(list: Drawing[], key: string, end: OkxClosed): boolean {
  let changed = false;
  for (const d of list) {
    if (d.kind !== "position") continue;
    if (d.order?.posKey === key && !d.order.closed) {
      d.order = { ...d.order, closed: end };
      changed = true;
    }
    if (d.okx && posKeyOf(d.okx) === key && !d.okx.closed) {
      d.okx = { ...d.okx, closed: end };
      d.b = { ...d.b, t: end.t || d.b.t };
      changed = true;
    }
  }
  return changed;
}

/** The record of a closed position in OKX's history. */
export function findClosed(history: readonly ClosedPos[], g: { posId: string; cTime: number }): OkxClosed | null {
  const c = history.find((h) => h.posId === g.posId && h.cTime === g.cTime);
  return c ? { t: Math.floor(c.uTime / 1000), px: c.closeAvgPx, pnl: c.realizedPnl } : null;
}

/** Is it on OKX now: a position open there (drawn from it, or with an order of ours in it), or an order of ours
 *  still waiting? Its entry is then OKX's, and a stop-loss / take-profit moved on the chart goes to OKX. */
export function isLive(d: PositionDrawing, s: SymbolState | null): boolean {
  if (!s) return false;
  if (d.okx) return !d.okx.closed && d.okx.demo === s.demo && s.positions.some((p) => posKeyOf(p) === posKeyOf(d.okx!));
  const o = d.order;
  if (!o || o.demo !== s.demo || o.closed) return false;
  return o.state === "live" || !!positionOfOrder(o, s);
}

export type Amends = { amends: AmendReq[]; lines: string[] };

/**
 * A stop-loss and / or take-profit moved on the chart, as changes on OKX: for a position open there, every
 * stop-loss / take-profit order closing it (the whole position, as the chart shows it); for an order still
 * waiting, the ones attached to it. null: nothing there to change.
 */
export function stopEdits(d: PositionDrawing, s: SymbolState, change: { sl?: number; tp?: number }, fmt: (p: number) => string): Amends | null {
  const amends: AmendReq[] = [];
  const lines: string[] = [];
  const arg = (v: number) => priceArg(v, s.tick);
  const p = d.okx
    ? s.positions.find((x) => posKeyOf(x) === posKeyOf(d.okx!))
    : d.order && isFilled(d.order)
      ? positionOfOrder(d.order, s)
      : undefined;
  if (p) {
    for (const a of algosOf(p, s.algos)) {
      const r: AmendReq = { instId: s.instId, kind: "algo", algoId: a.algoId };
      if (change.sl != null && a.sl != null && !samePrice(a.sl, change.sl, s.tick)) {
        r.sl = arg(change.sl);
        lines.push(`止損 ${fmt(a.sl)} → ${fmt(change.sl)}`);
      }
      if (change.tp != null && a.tp != null && !samePrice(a.tp, change.tp, s.tick)) {
        r.tp = arg(change.tp);
        lines.push(`止盈 ${fmt(a.tp)} → ${fmt(change.tp)}`);
      }
      if (r.sl || r.tp) amends.push(r);
    }
  } else if (d.order && d.order.state === "live" && d.order.demo === s.demo && d.order.algoClOrdId) {
    const r: AmendReq = { instId: s.instId, kind: "attached", ordId: d.order.ordId, algoClOrdId: d.order.algoClOrdId };
    if (change.sl != null) {
      r.sl = arg(change.sl);
      lines.push(`掛單的止損 → ${fmt(change.sl)}`);
    }
    if (change.tp != null && d.order.tp != null) {
      r.tp = arg(change.tp);
      lines.push(`掛單的止盈 → ${fmt(change.tp)}`);
    }
    if (r.sl || r.tp) amends.push(r);
  }
  return amends.length ? { amends, lines } : null;
}

export type Move = { drawingId: string; amends: AmendReq[]; notes: string[] };

/**
 * Adds that filled and still have to move the earlier orders' stop-loss / take-profit to their own: for each,
 * the changes on OKX. Earlier orders: of the same side, placed before it, in a position open now (or still
 * waiting: their attached ones); the take-profit only where there is one already.
 */
export function stopMoves(list: readonly Drawing[], s: SymbolState): Move[] {
  const out: Move[] = [];
  const positions = list.filter(isPosition);
  const arg = (v: number) => priceArg(v, s.tick);
  for (const d of positions) {
    const o = d.order;
    if (!o || !o.moveOnFill || o.moved || !isFilled(o) || o.sl == null || o.demo !== s.demo) continue;
    const amends: AmendReq[] = [];
    const notes: string[] = [];
    const taken = new Set<string>();
    let noTp = false;
    for (const e of positions) {
      const eo = e.order;
      if (e === d || !eo || eo.demo !== s.demo || eo.closed || sideOfOrder(eo) !== sideOfOrder(o) || eo.at >= o.at) continue;
      if (eo.state === "live") {
        if (!eo.algoClOrdId) continue;
        const r: AmendReq = { instId: s.instId, kind: "attached", ordId: eo.ordId, algoClOrdId: eo.algoClOrdId, sl: arg(o.sl) };
        if (o.tp != null && eo.tp != null) r.tp = arg(o.tp);
        amends.push(r);
        continue;
      }
      if (!isFilled(eo) || !positionOfOrder(eo, s)) continue;
      const a = algoOfOrder(eo, e.b.p, s, taken);
      if (!a) {
        notes.push(`找不到 ${eo.ordId} 這張單在 OKX 上的止損單，請到 OKX 自己改`);
        continue;
      }
      taken.add(a.algoId);
      const r: AmendReq = { instId: s.instId, kind: "algo", algoId: a.algoId };
      if (a.sl != null && !samePrice(a.sl, o.sl, s.tick)) r.sl = arg(o.sl);
      if (o.tp != null && a.tp != null && !samePrice(a.tp, o.tp, s.tick)) r.tp = arg(o.tp);
      if (o.tp != null && a.tp == null) noTp = true;
      if (r.sl || r.tp) amends.push(r);
    }
    if (noTp) notes.push("前面那筆在 OKX 上沒有止盈，只移了止損");
    out.push({ drawingId: d.id, amends, notes });
  }
  return out;
}
