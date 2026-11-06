// Where each drawing is on screen (from its stored points), and what the mouse is over. No chart objects:
// a Projector turns times and prices into pixels, so this works the same for any chart and can be tested.

import type { ChannelDrawing, Drawing, FibSettings } from "../settings/model.ts";
import {
  bandLines, distToLine, distToRay, distToSegment, fibPrice, fmtLevel, lowerUpper, rLevels, secondLine, widthLine,
  type Anchor, type Fit, type Line2,
} from "./geometry.ts";
import type { PositionResult } from "./trade.ts";

/** c, d: a channel's second line at its first and second point's time. */
export type Part = "a" | "b" | "c" | "d" | "c2" | "c3" | "stop" | "target" | "edge" | "body";
export type Handle = { x: number; y: number; part: Part };
export type LevelGeo = { y: number; color: string; label: string };
/** A line on screen. */
export type Seg = { x0: number; y0: number; x1: number; y1: number };
export type ChannelGeo = {
  /** The lower and the upper line, from the first point's time to the second's (painting and hit tests extend
   *  them as the style says). */
  lines: [Seg, Seg];
  /** Halfway between them (a regression trend's fitted line; null while only the first line is placed), and
   *  the lines in proportion to the width. */
  mid: Seg | null;
  levels: { seg: Seg; value: number }[];
  /** The end points' prices, for the axis labels while it is selected. */
  marks: { y: number; p: number }[];
  /** A regression trend's Pearson's R (undefined: never fitted). */
  r?: number;
};
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
  ch?: ChannelGeo;
  pos?: {
    x0: number; x1: number; entryY: number; stopY: number; targetY: number;
    levels: { k: number; price: number; y: number }[];
    /** Where it was closed (take-profit, stop or the end of the box). */
    exit: { x: number; y: number } | null;
    /** Closed on OKX at a known price: only entry to close is drawn (a record), `profit` or not. */
    closed?: { y: number; profit: boolean };
  };
};
/** `inside`: in a shape (a rectangle, a position's box, a channel's fill) that doesn't take the press there, so
 *  the chart pans as usual and a click selects the shape. */
export type Hit = { id: string; part: Part; inside?: true };

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
  /** A regression trend fitted to the chart's bars (null: they don't reach back to it; what it keeps is used). */
  fit?(d: ChannelDrawing): Fit | null;
  /** A channel being placed whose second line isn't placed yet: only its first line shows. */
  firstOnly?: string | null;
};

export const HANDLE_R = 7; // px: grab distance for the end points
export const LINE_HIT = 5; // px: grab distance for lines

/** A segment run on to the left and/or right edge of a pane `width` wide (one standing straight up stays as it
 *  is), with its ends in order from left to right. */
export function extendSeg(s: Seg, left: boolean, right: boolean, width: number): Seg {
  const o = s.x0 <= s.x1 ? s : { x0: s.x1, y0: s.y1, x1: s.x0, y1: s.y0 };
  if (o.x1 === o.x0 || (!left && !right)) return o;
  const k = (o.y1 - o.y0) / (o.x1 - o.x0);
  const L = -8;
  const R = width + 8;
  const x0 = left ? Math.min(o.x0, L) : o.x0;
  const x1 = right ? Math.max(o.x1, R) : o.x1;
  return { x0, y0: o.y0 + k * (x0 - o.x0), x1, y1: o.y0 + k * (x1 - o.x0) };
}

/** A channel's lines on screen, its handles, and for a regression trend where its fitted line is. */
function channelGeo(d: ChannelDrawing, pr: Projector, o: GeoOptions, g: Geo): boolean {
  const only = o.firstOnly === d.id;
  let first: Line2;
  let second: Line2;
  let r: number | undefined;
  if (d.kind === "regression") {
    const f = o.fit?.(d) ?? null;
    const a = { t: d.a.t, p: f ? f.p0 : d.a.p };
    const b = { t: d.b.t, p: f ? f.p1 : d.b.p };
    [first, second] = bandLines(a, b, (f ? f.sd : (d.fit?.sd ?? 0)) * d.style.dev);
    r = f ? f.r : d.fit?.r;
    const ay = pr.y(a.p);
    const by = pr.y(b.p);
    if (ay == null || by == null) return false;
    g.ay = ay;
    g.by = by;
    g.handles = [{ x: g.ax, y: ay, part: "a" }, { x: g.bx, y: by, part: "b" }];
  } else {
    first = [d.a, d.b];
    second = only ? first : secondLine(d.kind, d.a, d.b, d.c);
    const cy = pr.y(second[0].p);
    const dy = pr.y(second[1].p);
    if (cy == null || dy == null) return false;
    g.handles = [{ x: g.ax, y: g.ay, part: "a" }, { x: g.bx, y: g.by, part: "b" }];
    if (!only) g.handles.push({ x: g.ax, y: cy, part: "c" }, { x: g.bx, y: dy, part: "d" });
  }
  const seg = (l: Line2): Seg | null => {
    const x0 = pr.x(l[0].t);
    const x1 = pr.x(l[1].t);
    const y0 = pr.y(l[0].p);
    const y1 = pr.y(l[1].p);
    return x0 == null || x1 == null || y0 == null || y1 == null ? null : { x0, y0, x1, y1 };
  };
  const [lo, up] = lowerUpper(first, second);
  const L = seg(lo);
  const U = seg(up);
  if (!L || !U) return false;
  const half = widthLine(lo, up, 0.5);
  const levels: ChannelGeo["levels"] = [];
  if (!only) {
    for (const l of d.style.levels) {
      if (!l.on) continue;
      const s = seg(widthLine(lo, up, l.value));
      if (s) levels.push({ seg: s, value: l.value });
    }
  }
  const ends: Anchor[] = d.kind === "regression" ? half : only ? [d.a, d.b] : [d.a, d.b, ...second];
  const marks = ends.flatMap((e) => {
    const y = pr.y(e.p);
    return y == null ? [] : [{ y, p: e.p }];
  });
  g.ch = { lines: [L, U], mid: only ? null : seg(half), levels, marks, ...(r != null ? { r } : {}) };
  return true;
}

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
        // R multiples: of the plan, or of a position drawn from OKX with a stop-loss there while it is open; a stop
        // past the entry (a profit locked in, on OKX) leaves no R to count in
        const lossSide = d.dir == null || (d.a.p - d.b.p) * d.dir > 0;
        const withR = lossSide && (!d.okx || (!d.okx.noSl && !d.okx.closed));
        const levels = (withR ? rLevels(d.a.p, d.b.p, d.target, o.rLevels) : []).flatMap((l) => {
          const y = pr.y(l.price);
          return y == null ? [] : [{ ...l, y }];
        });
        // closed on OKX: the box ends when it was closed, and the exit is where (OKX's own record)
        const real = d.okx?.closed ?? d.order?.closed;
        const realX = real && real.t > 0 ? pr.x(real.t) : null;
        const x1 = Math.max(realX ?? bx, ax + 10);
        const t = o.trades.get(d.id);
        let exit: { x: number; y: number } | null = null;
        if (real) {
          const ey = real.px > 0 ? pr.y(real.px) : null;
          if (realX != null && ey != null) exit = { x: realX, y: ey };
        } else if (t && t.outcome.exit != null && t.outcome.exitT != null) {
          const ex = pr.x(t.outcome.exitT);
          const ey = pr.y(t.outcome.exit);
          if (ex != null && ey != null) exit = { x: ex, y: ey };
        }
        g.pos = { x0: ax, x1, entryY: ay, stopY: by, targetY, levels, exit };
        if (real && exit) g.pos.closed = { y: exit.y, profit: real.pnl >= 0 };
        g.handles = [
          { x: ax, y: ay, part: "a" },
          { x: ax, y: by, part: "stop" },
          { x: ax, y: targetY, part: "target" },
          { x: x1, y: ay, part: "edge" },
        ];
        // drawn from OKX: only the stops OKX has can be moved, and none once it is closed; closed on OKX, a record
        const k = d.okx;
        if (k) g.handles = k.closed ? [] : g.handles.filter((h) => (h.part === "stop" && !k.noSl) || (h.part === "target" && !k.noTp));
        else if (d.order?.closed) g.handles = [];
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
      case "channel":
      case "regression":
      case "flat":
      case "disjoint":
        if (!channelGeo(d, pr, o, g)) continue;
        break;
      default:
        g.handles = [A, B];
    }
    out.push(g);
  }
  return out;
}

/** Where (x, y) is on the drawing itself (not a handle): on one of its lines (a border, a level, the entry), inside
 *  a shape it fills, or off it. `paneWidth` is where rectangles extended to the right end. */
export function bodyPart(g: Geo, x: number, y: number, paneWidth: number): "line" | "inside" | null {
  const d = g.d;
  const { ax, ay, bx, by } = g;
  const line = (on: boolean) => (on ? "line" : null);
  switch (d.kind) {
    case "fib": {
      const f = g.fib;
      const onLevel = !!f && x >= f.xl - LINE_HIT && x <= f.xr + LINE_HIT && f.levels.some((l) => Math.abs(l.y - y) <= LINE_HIT);
      return line(onLevel || distToSegment(x, y, ax, ay, bx, by) <= LINE_HIT);
    }
    case "trend":
    case "info":
    case "angle":
      return line(distToSegment(x, y, ax, ay, bx, by) <= LINE_HIT);
    case "ray":
      return line(distToRay(x, y, ax, ay, bx, by) <= LINE_HIT);
    case "extended":
      return line(distToLine(x, y, ax, ay, bx, by) <= LINE_HIT);
    case "hline":
      return line(Math.abs(y - ay) <= LINE_HIT);
    case "hray":
      return line(Math.abs(y - ay) <= LINE_HIT && x >= ax - LINE_HIT);
    case "vline":
      return line(Math.abs(x - ax) <= LINE_HIT);
    case "cross":
      return line(Math.abs(y - ay) <= LINE_HIT || Math.abs(x - ax) <= LINE_HIT);
    case "position": {
      const p = g.pos;
      if (!p) return null;
      // closed on OKX: only what is drawn, entry to close
      const ys = p.closed ? [p.entryY, p.closed.y] : [p.stopY, p.targetY, p.entryY];
      const top = Math.min(...ys);
      const bottom = Math.max(...ys);
      if (x < p.x0 - LINE_HIT || x > p.x1 + LINE_HIT || y < top - LINE_HIT || y > bottom + LINE_HIT) return null;
      const near = Math.abs(x - p.x0) <= LINE_HIT || Math.abs(x - p.x1) <= LINE_HIT || ys.some((v) => Math.abs(y - v) <= LINE_HIT);
      return near ? "line" : "inside";
    }
    case "rect": {
      const x0 = Math.min(ax, bx);
      const x1 = d.style.extend ? paneWidth : Math.max(ax, bx);
      const y0 = Math.min(ay, by);
      const y1 = Math.max(ay, by);
      if (x < x0 - LINE_HIT || x > x1 + LINE_HIT || y < y0 - LINE_HIT || y > y1 + LINE_HIT) return null;
      return x <= x0 + LINE_HIT || x >= x1 - LINE_HIT || y <= y0 + LINE_HIT || y >= y1 - LINE_HIT ? "line" : "inside";
    }
    case "channel":
    case "regression":
    case "flat":
    case "disjoint": {
      const ch = g.ch;
      if (!ch) return null;
      const s = d.style;
      const ext = (l: Seg) => extendSeg(l, s.extendLeft, s.extendRight, paneWidth);
      const near = (l: Seg) => {
        const e = ext(l);
        return distToSegment(x, y, e.x0, e.y0, e.x1, e.y1) <= LINE_HIT;
      };
      if (near(ch.lines[0]) || near(ch.lines[1]) || (s.middle && ch.mid && near(ch.mid)) || ch.levels.some((l) => near(l.seg))) return "line";
      if (s.transparency >= 100) return null; // no fill: only the lines
      const lo = ext(ch.lines[0]);
      const up = ext(ch.lines[1]);
      if (lo.x1 === lo.x0 || x < lo.x0 || x > lo.x1) return null;
      const at = (e: Seg) => e.y0 + ((e.y1 - e.y0) * (x - e.x0)) / (e.x1 - e.x0);
      const y0 = at(lo);
      const y1 = at(up);
      return y >= Math.min(y0, y1) && y <= Math.max(y0, y1) ? "inside" : null;
    }
  }
}

/** Is (x, y) on the drawing itself (not a handle)? */
export const onBody = (g: Geo, x: number, y: number, paneWidth: number): boolean => bodyPart(g, x, y, paneWidth) != null;

/**
 * What is at (x, y): a handle of any drawing, else the topmost drawing there. With `grabsInside`, the inside of
 * a shape that doesn't take presses there gives way to a line or the inside of another drawing under it, and is
 * the hit (marked `inside`) only when there is nothing else.
 */
export function hitTest(geo: readonly Geo[], x: number, y: number, paneWidth: number, skip: Drawing | null, grabsInside?: (d: Drawing) => boolean): Hit | null {
  const items = geo.filter((g) => g.d !== skip);
  for (let k = items.length - 1; k >= 0; k--) {
    for (const h of items[k].handles) if (Math.hypot(x - h.x, y - h.y) <= HANDLE_R) return { id: items[k].d.id, part: h.part };
  }
  let inside: Hit | null = null;
  for (let k = items.length - 1; k >= 0; k--) {
    const at = bodyPart(items[k], x, y, paneWidth);
    if (!at) continue;
    if (at === "inside" && grabsInside && !grabsInside(items[k].d)) {
      inside ??= { id: items[k].d.id, part: "body", inside: true };
      continue;
    }
    return { id: items[k].d.id, part: "body" };
  }
  return inside;
}
