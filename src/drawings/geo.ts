// Where each drawing is on screen (from its stored points), and what the mouse is over. No chart objects:
// a Projector turns times and prices into pixels, so this works the same for any chart and can be tested.

import type { Drawing, FibSettings } from "../settings/model.ts";
import { distToLine, distToRay, distToSegment, fibPrice, fmtLevel, rLevels } from "./geometry.ts";
import type { PositionResult } from "./trade.ts";

export type Part = "a" | "b" | "c2" | "c3" | "stop" | "target" | "edge" | "body";
export type Handle = { x: number; y: number; part: Part };
export type LevelGeo = { y: number; color: string; label: string };
export type Geo = {
  d: Drawing;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  handles: Handle[];
  /** Selected, hovered or being placed: handles show. */
  active: boolean;
  fib?: { xl: number; xr: number; levels: LevelGeo[] };
  pos?: {
    x0: number; x1: number; entryY: number; stopY: number; targetY: number;
    levels: { k: number; price: number; y: number }[];
    /** Where it was closed (take-profit, stop or the end of the box). */
    exit: { x: number; y: number } | null;
  };
};
export type Hit = { id: string; part: Part };

/** Bar time (UTC seconds) → x, price → y, in the price pane; null when it can't be placed. */
export type Projector = {
  x(t: number): number | null;
  y(p: number): number | null;
  /** Size of the price pane. */
  width: number;
  height: number;
};

export type GeoOptions = {
  fib: FibSettings;
  /** R multiples to draw on positions. */
  rLevels: number[];
  fmtPrice(p: number): string;
  trades: ReadonlyMap<string, PositionResult>;
  active(d: Drawing): boolean;
};

export const HANDLE_R = 7; // px: grab distance for the end points
export const LINE_HIT = 5; // px: grab distance for lines

export function computeGeo(items: readonly Drawing[], pr: Projector, o: GeoOptions): Geo[] {
  const fibLevels = o.fib.levels.filter((l) => l.on);
  const out: Geo[] = [];
  for (const d of items) {
    const ax = pr.x(d.a.t);
    const bx = pr.x(d.b.t);
    const ay = pr.y(d.a.p);
    const by = pr.y(d.b.p);
    if (ax == null || bx == null || ay == null || by == null) continue;
    const g: Geo = { d, ax, ay, bx, by, handles: [], active: o.active(d) };
    const A: Handle = { x: ax, y: ay, part: "a" };
    const B: Handle = { x: bx, y: by, part: "b" };
    switch (d.kind) {
      case "fib": {
        const levels: LevelGeo[] = [];
        for (const l of fibLevels) {
          const price = fibPrice(d.a, d.b, l.value, o.fib.reverse);
          const y = pr.y(price);
          if (y == null) continue;
          levels.push({ y, color: l.color, label: o.fib.showPrice ? `${fmtLevel(l.value)} (${o.fmtPrice(price)})` : fmtLevel(l.value) });
        }
        g.fib = { xl: Math.min(ax, bx), xr: o.fib.extend ? Math.max(pr.width, ax, bx) : Math.max(ax, bx), levels };
        g.handles = [A, B];
        break;
      }
      case "rect":
        g.handles = [A, B, { x: ax, y: by, part: "c2" }, { x: bx, y: ay, part: "c3" }];
        break;
      case "position": {
        const targetY = pr.y(d.target);
        if (targetY == null) continue;
        // a stop past the entry (a profit locked in, on OKX) leaves no R to count in
        const lossSide = d.dir == null || (d.a.p - d.b.p) * d.dir > 0;
        const levels = (lossSide && !d.okx ? rLevels(d.a.p, d.b.p, d.target, o.rLevels) : []).flatMap((l) => {
          const y = pr.y(l.price);
          return y == null ? [] : [{ ...l, y }];
        });
        const x1 = Math.max(bx, ax + 10);
        const t = o.trades.get(d.id);
        let exit: { x: number; y: number } | null = null;
        if (t && t.outcome.exit != null && t.outcome.exitT != null) {
          const ex = pr.x(t.outcome.exitT);
          const ey = pr.y(t.outcome.exit);
          if (ex != null && ey != null) exit = { x: ex, y: ey };
        }
        g.pos = { x0: ax, x1, entryY: ay, stopY: by, targetY, levels, exit };
        g.handles = [
          { x: ax, y: ay, part: "a" },
          { x: ax, y: by, part: "stop" },
          { x: ax, y: targetY, part: "target" },
          { x: x1, y: ay, part: "edge" },
        ];
        // drawn from OKX: only the stops OKX has can be moved, and none once it is closed
        const k = d.okx;
        if (k) g.handles = k.closed ? [] : g.handles.filter((h) => (h.part === "stop" && !k.noSl) || (h.part === "target" && !k.noTp));
        break;
      }
      case "hline":
        g.handles = [{ x: ax >= 0 && ax <= pr.width ? ax : pr.width / 2, y: ay, part: "a" }];
        break;
      case "vline":
        g.handles = [{ x: ax, y: ay >= 0 && ay <= pr.height ? ay : pr.height / 2, part: "a" }];
        break;
      case "hray":
      case "cross":
        g.handles = [A];
        break;
      default:
        g.handles = [A, B];
    }
    out.push(g);
  }
  return out;
}

/** Is (x, y) on the drawing itself (not a handle)? `paneWidth` is where rectangles extended to the right end. */
export function onBody(g: Geo, x: number, y: number, paneWidth: number): boolean {
  const d = g.d;
  const { ax, ay, bx, by } = g;
  switch (d.kind) {
    case "fib": {
      const f = g.fib;
      const onLevel = !!f && x >= f.xl - LINE_HIT && x <= f.xr + LINE_HIT && f.levels.some((l) => Math.abs(l.y - y) <= LINE_HIT);
      return onLevel || distToSegment(x, y, ax, ay, bx, by) <= LINE_HIT;
    }
    case "trend":
    case "info":
    case "angle":
      return distToSegment(x, y, ax, ay, bx, by) <= LINE_HIT;
    case "ray":
      return distToRay(x, y, ax, ay, bx, by) <= LINE_HIT;
    case "extended":
      return distToLine(x, y, ax, ay, bx, by) <= LINE_HIT;
    case "hline":
      return Math.abs(y - ay) <= LINE_HIT;
    case "hray":
      return Math.abs(y - ay) <= LINE_HIT && x >= ax - LINE_HIT;
    case "vline":
      return Math.abs(x - ax) <= LINE_HIT;
    case "cross":
      return Math.abs(y - ay) <= LINE_HIT || Math.abs(x - ax) <= LINE_HIT;
    case "position": {
      const p = g.pos;
      if (!p) return false;
      const top = Math.min(p.stopY, p.targetY);
      const bottom = Math.max(p.stopY, p.targetY);
      return x >= p.x0 - LINE_HIT && x <= p.x1 + LINE_HIT && y >= top - LINE_HIT && y <= bottom + LINE_HIT;
    }
    case "rect": {
      const x1 = d.style.extend ? paneWidth : Math.max(ax, bx);
      return x >= Math.min(ax, bx) - LINE_HIT && x <= x1 + LINE_HIT && y >= Math.min(ay, by) - LINE_HIT && y <= Math.max(ay, by) + LINE_HIT;
    }
  }
}

/** The handle or drawing under (x, y), the topmost (last drawn) first; handles before bodies. */
export function hitTest(geo: readonly Geo[], x: number, y: number, paneWidth: number, skip: Drawing | null): Hit | null {
  const items = geo.filter((g) => g.d !== skip);
  for (let k = items.length - 1; k >= 0; k--) {
    for (const h of items[k].handles) if (Math.hypot(x - h.x, y - h.y) <= HANDLE_R) return { id: items[k].d.id, part: h.part };
  }
  for (let k = items.length - 1; k >= 0; k--) if (onBody(items[k], x, y, paneWidth)) return { id: items[k].d.id, part: "body" };
  return null;
}
