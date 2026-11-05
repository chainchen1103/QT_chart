// Painting the drawings: fills under the candles (Fib bands, rectangles, position zones), and lines, labels and
// handles over them. Pure drawing from the geometry in geo.ts; nothing here changes any state. The labels are
// planned when the views update (labelPlans: what each drawing writes and the places it may go), get their
// places among all the chart's labels (LabelSpace), and are painted there; the handles of the drawing being
// edited go over them.

import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { isChannelDrawing, type Dash, type FibSettings, type PositionDrawing, type PositionSettings } from "../settings/model.ts";
import { extendSeg, type Geo, type Seg } from "./geo.ts";
import { fmtLevel, fmtSpan, hexToRgba, posDir, rewardRisk, screenAngle, timeToIndex, type Anchor } from "./geometry.ts";
import { fmtMoney, fmtQty, type PositionResult } from "./trade.ts";
import { fmtVol, signed } from "../core/format.ts";
import type { Candle } from "../core/api.ts";
import type { LiveInfo } from "../trade/sync.ts";
import { MONO_FONT, THEME } from "../ui/theme.ts";
import { PRIO, textWidth, type Box, type LabelAsk, type Spot } from "../chart/labelspace.ts";

/** The button at the right of a position: 下單, or the order placed from it. */
/** `fg`: the text color (white when not given). */
export type OrderTag = { text: string; bg: string; fg?: string };
/** Where something clickable was painted (chart pixels), and the drawing it belongs to. */
export type HotSpot = { id: string; x: number; y: number; w: number; h: number };

export type PaintOptions = {
  fib: FibSettings;
  position: PositionSettings;
  fmtPrice(p: number): string;
  /** The coin of the symbol, e.g. BTC. */
  base: string;
  times: number[];
  barSec: number;
  trades: ReadonlyMap<string, PositionResult>;
  orderTag(d: PositionDrawing): OrderTag | null;
  /** A position on OKX: what OKX says of it (size, average, unrealized PnL, or how it ended). */
  live(d: PositionDrawing): LiveInfo | null;
  /** Size of the labels' text, px. */
  textPx: number;
  /** Does a box (chart pixels) cover the high–low of a bar on screen? */
  covers(b: Box): boolean;
};

/** A drawing's label: the room it asks for among the chart's labels, and how it is painted where it went. */
export type LabelPlan = {
  ask: LabelAsk;
  paint(ctx: CanvasRenderingContext2D, b: Box): void;
  /** An order button at the label's right end: where it starts from the label's left, and how wide it is. */
  spot?: { id: string; dx: number; w: number };
};

export const labelFont = (px: number) => `${px}px ${MONO_FONT}`;
/** The labels' font and what goes with its size: line height in boxes, height of a bare text, text width. */
type Type = { font: string; lh: number; th: number; tw(s: string): number };
function typeOf(px: number): Type {
  const font = labelFont(px);
  return { font, lh: Math.round((px * 15) / 11), th: Math.round(px * 1.3), tw: (s) => textWidth(font, s) };
}
/** Handles and axis labels of the drawing being edited. */
export const ACCENT = THEME.data;
const FAR = 100000; // px: endless lines are drawn this far out and the canvas clips them

function dashOf(dash: Dash, width: number, hr: number): number[] {
  if (dash === "dash") return [Math.round(6 * hr), Math.round(4 * hr)];
  if (dash === "dot") return [Math.max(1, Math.round(width * hr)), Math.round(3 * hr)];
  return [];
}

/** Fills under the candles: Fib bands and rectangles. */
export function paintUnder(target: CanvasRenderingTarget2D, geo: readonly Geo[], o: PaintOptions) {
  const fibFill = o.fib.fill;
  target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr, bitmapSize }) => {
    for (const g of geo) {
      const d = g.d;
      if (d.kind === "fib" && fibFill && g.fib) {
        const x0 = Math.round(g.fib.xl * hr);
        const x1 = Math.round(g.fib.xr * hr);
        const lv = g.fib.levels;
        for (let k = 1; k < lv.length; k++) {
          const y0 = Math.round(lv[k - 1].y * vr);
          const y1 = Math.round(lv[k].y * vr);
          ctx.fillStyle = hexToRgba(lv[k].color, 0.07);
          ctx.fillRect(x0, Math.min(y0, y1), x1 - x0, Math.abs(y1 - y0));
        }
      } else if (d.kind === "position" && g.pos) {
        const ps = o.position;
        if (ps.transparency >= 100) continue;
        const alpha = 1 - ps.transparency / 100;
        const x0 = Math.round(g.pos.x0 * hr);
        const x1 = Math.round(g.pos.x1 * hr);
        const e = Math.round(g.pos.entryY * vr);
        if (g.pos.closed) {
          // closed on OKX: entry to close only, in the color of how it went
          const c = Math.round(g.pos.closed.y * vr);
          ctx.fillStyle = hexToRgba(g.pos.closed.profit ? ps.profit : ps.loss, alpha);
          ctx.fillRect(x0, Math.min(e, c), x1 - x0, Math.max(1, Math.abs(c - e)));
          continue;
        }
        const t = Math.round(g.pos.targetY * vr);
        const sl = Math.round(g.pos.stopY * vr);
        const lossSide = d.dir == null || (d.a.p - d.b.p) * d.dir > 0;
        if (!d.okx?.noTp) {
          ctx.fillStyle = hexToRgba(ps.profit, alpha);
          ctx.fillRect(x0, Math.min(e, t), x1 - x0, Math.abs(t - e));
        }
        if (!d.okx?.noSl && lossSide) {
          ctx.fillStyle = hexToRgba(ps.loss, alpha);
          ctx.fillRect(x0, Math.min(e, sl), x1 - x0, Math.abs(sl - e));
        }
      } else if (d.kind === "rect") {
        const s = d.style;
        if (s.transparency >= 100) continue;
        const x0 = Math.round(Math.min(g.ax, g.bx) * hr);
        const x1 = s.extend ? bitmapSize.width : Math.round(Math.max(g.ax, g.bx) * hr);
        const y0 = Math.round(Math.min(g.ay, g.by) * vr);
        const y1 = Math.round(Math.max(g.ay, g.by) * vr);
        ctx.fillStyle = hexToRgba(s.fill, 1 - s.transparency / 100);
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      } else if ((d.kind === "channel" || d.kind === "regression" || d.kind === "flat" || d.kind === "disjoint") && g.ch) {
        // between the lower and the upper line, as far as they are extended
        const s = d.style;
        if (s.transparency >= 100) continue;
        const w = bitmapSize.width / hr;
        const lo = extendSeg(g.ch.lines[0], s.extendLeft, s.extendRight, w);
        const up = extendSeg(g.ch.lines[1], s.extendLeft, s.extendRight, w);
        ctx.fillStyle = hexToRgba(s.fill, 1 - s.transparency / 100);
        ctx.beginPath();
        ctx.moveTo(lo.x0 * hr, lo.y0 * vr);
        ctx.lineTo(lo.x1 * hr, lo.y1 * vr);
        ctx.lineTo(up.x1 * hr, up.y1 * vr);
        ctx.lineTo(up.x0 * hr, up.y0 * vr);
        ctx.closePath();
        ctx.fill();
      }
    }
  });
}

/** Lines, labels and handles over the candles; returns where the order buttons were painted. `at`: where each
 *  label went (LabelSpace). */
export function paintOver(
  target: CanvasRenderingTarget2D,
  geo: readonly Geo[],
  plans: readonly LabelPlan[],
  at: (key: string) => Box | null,
  o: PaintOptions,
): HotSpot[] {
  const spots: HotSpot[] = [];
  target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr, bitmapSize }) => {
    const W = bitmapSize.width;
    const H = bitmapSize.height;
    const crisp = (v: number, lw: number) => Math.round(v) + (lw % 2 ? 0.5 : 0);
    const path = (pts: [number, number][], style: { color: string; width: number; dash: Dash }) => {
      const lw = Math.max(1, Math.round(style.width * hr));
      ctx.strokeStyle = style.color;
      ctx.lineWidth = lw;
      ctx.setLineDash(dashOf(style.dash, style.width, hr));
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    for (const g of geo) {
      const d = g.d;
      const ax = g.ax * hr;
      const ay = g.ay * vr;
      const bx = g.bx * hr;
      const by = g.by * vr;
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      const ux = len ? (dx / len) * FAR : 0;
      const uy = len ? (dy / len) * FAR : 0;
      switch (d.kind) {
        case "fib":
          fibLines(ctx, g, hr, vr);
          break;
        case "trend":
        case "info":
          path([[ax, ay], [bx, by]], d.style);
          break;
        case "angle": {
          path([[ax, ay], [bx, by]], d.style);
          const ref = Math.max(40 * hr, Math.min(Math.abs(dx), 120 * hr));
          path([[ax, ay], [ax + ref, ay]], { color: d.style.color, width: 1, dash: "dot" });
          const r = 26 * hr;
          const deg = screenAngle(g.ax, g.ay, g.bx, g.by);
          ctx.strokeStyle = d.style.color;
          ctx.lineWidth = Math.max(1, Math.round(hr));
          ctx.beginPath();
          ctx.arc(ax, ay, r, 0, (-deg * Math.PI) / 180, deg > 0);
          ctx.stroke();
          break;
        }
        case "ray":
          if (len) path([[ax, ay], [ax + ux, ay + uy]], d.style);
          break;
        case "extended":
          if (len) path([[ax - ux, ay - uy], [ax + ux, ay + uy]], d.style);
          break;
        case "hline":
        case "hray":
        case "cross": {
          const lw = Math.max(1, Math.round(d.style.width * hr));
          const y = crisp(ay, lw);
          path([[d.kind === "hray" ? ax : 0, y], [W, y]], d.style);
          if (d.kind === "cross") path([[crisp(ax, lw), 0], [crisp(ax, lw), H]], d.style);
          break;
        }
        case "vline": {
          const lw = Math.max(1, Math.round(d.style.width * hr));
          path([[crisp(ax, lw), 0], [crisp(ax, lw), H]], d.style);
          break;
        }
        case "position": {
          if (!g.pos) break;
          const ps = o.position;
          const x0 = g.pos.x0 * hr;
          const x1 = g.pos.x1 * hr;
          const lw = Math.max(1, Math.round(hr));
          const hl = (y: number, color: string, dash: Dash) => path([[x0, crisp(y * vr, lw)], [x1, crisp(y * vr, lw)]], { color, width: 1, dash });
          const t = o.trades.get(d.id);
          const sc = t?.scale;
          const dim = sc && sc.step < sc.count ? 0.4 : 1; // an earlier part: a later add's stop and take-profit rule
          if (g.pos.closed) {
            // closed on OKX: the entry and where it was closed, nothing of the plan beyond
            hl(g.pos.closed.y, g.pos.closed.profit ? ps.profit : ps.loss, "solid");
          } else {
            for (const l of g.pos.levels) hl(l.y, hexToRgba(ps.profit, 0.9 * dim), "dash");
            if (!d.okx?.noTp) hl(g.pos.targetY, hexToRgba(ps.profit, dim), "solid");
            if (!d.okx?.noSl) hl(g.pos.stopY, hexToRgba(ps.loss, dim), "solid");
          }
          hl(g.pos.entryY, "#b2b5be", "solid");
          // where it went out: as closed on OKX, else as worked out on the bars (an open one on OKX: none yet)
          const real = d.okx?.closed ?? d.order?.closed;
          if (g.pos.exit && (real || (t && !o.live(d)))) {
            const color = real
              ? real.pnl >= 0 ? ps.profit : ps.loss
              : t?.outcome.status === "tp" ? ps.profit : t?.outcome.status === "sl" ? ps.loss : "#b2b5be";
            ctx.beginPath();
            ctx.arc(g.pos.exit.x * hr, g.pos.exit.y * vr, 5 * hr, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.lineWidth = Math.max(1, Math.round(1.5 * hr));
            ctx.strokeStyle = "#ffffff";
            ctx.stroke();
          }
          break;
        }
        case "rect": {
          const s = d.style;
          const lw = Math.max(1, Math.round(s.width * hr));
          const x0 = crisp(Math.min(ax, bx), lw);
          const x1 = s.extend ? W + lw : crisp(Math.max(ax, bx), lw);
          const y0 = crisp(Math.min(ay, by), lw);
          const y1 = crisp(Math.max(ay, by), lw);
          path([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], { color: s.border, width: s.width, dash: s.dash });
          break;
        }
        case "channel":
        case "regression":
        case "flat":
        case "disjoint": {
          const ch = g.ch;
          if (!ch) break;
          const s = d.style;
          const line = (l: Seg, st: { color: string; width: number; dash: Dash }) => {
            const e = extendSeg(l, s.extendLeft, s.extendRight, W / hr);
            path([[e.x0 * hr, e.y0 * vr], [e.x1 * hr, e.y1 * vr]], st);
          };
          for (const l of ch.levels) line(l.seg, { color: hexToRgba(s.color, 0.85), width: 1, dash: "solid" });
          if (s.middle && ch.mid) line(ch.mid, { color: s.color, width: 1, dash: "dash" });
          line(ch.lines[0], s);
          line(ch.lines[1], s);
          break;
        }
      }
    }
  });
  target.useMediaCoordinateSpace(({ context: ctx }) => {
    ctx.font = labelFont(o.textPx);
    for (const p of plans) {
      const b = at(p.ask.key);
      if (!b) continue; // left out: no room for it
      p.paint(ctx, b);
      if (p.spot) spots.push({ id: p.spot.id, x: b.x + p.spot.dx, y: b.y, w: p.spot.w, h: b.h });
    }
  });
  // the handles of what is being edited, over every label: they can always be seen and grabbed
  target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
    for (const g of geo) {
      if (!g.active) continue;
      for (const h of g.handles) {
        ctx.beginPath();
        ctx.arc(h.x * hr, h.y * vr, 4.5 * hr, 0, Math.PI * 2);
        ctx.fillStyle = "#131722";
        ctx.fill();
        ctx.lineWidth = Math.max(1, Math.round(1.5 * hr));
        ctx.strokeStyle = ACCENT;
        ctx.stroke();
      }
    }
  });
  return spots;
}

function fibLines(ctx: CanvasRenderingContext2D, g: Geo, hr: number, vr: number) {
  if (!g.fib) return;
  const lw = Math.max(1, Math.floor(vr));
  const off = lw % 2 ? 0.5 : 0;
  const x0 = Math.round(g.fib.xl * hr);
  const x1 = Math.round(g.fib.xr * hr);
  ctx.lineWidth = lw;
  for (const l of g.fib.levels) {
    const y = Math.round(l.y * vr) + off;
    ctx.strokeStyle = l.color;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(178,181,190,0.55)";
  ctx.setLineDash([Math.round(4 * hr), Math.round(4 * hr)]);
  ctx.beginPath();
  ctx.moveTo(g.ax * hr, g.ay * vr);
  ctx.lineTo(g.bx * hr, g.by * vr);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ----------------------------------------------------------------------------- labels
/** What every drawing writes on the chart, as labels to be placed and painted. `width` × `height`: the pane. */
export function labelPlans(geo: readonly Geo[], o: PaintOptions, width: number, height: number): LabelPlan[] {
  const T = typeOf(o.textPx);
  const out: LabelPlan[] = [];
  for (const g of geo) {
    const k = g.d.kind;
    if (k === "fib") fibPlans(out, g, T, height);
    else if (k === "info") infoPlans(out, g, T, width, height, o);
    else if (k === "angle") anglePlans(out, g, T);
    else if (k === "position") positionPlans(out, g, T, o, width);
    else if (g.ch) channelPlans(out, g, T, width, height);
  }
  return out;
}

/** Text with no backing. */
const bare = (text: string, color: string) => (ctx: CanvasRenderingContext2D, b: Box) => {
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, b.x, b.y + b.h / 2);
};
/** Lines of text on a filled box. */
function boxed(ctx: CanvasRenderingContext2D, T: Type, lines: readonly string[], b: Box, bg: string, fg: string) {
  ctx.fillStyle = bg;
  ctx.fillRect(b.x, b.y, b.w, b.h);
  ctx.fillStyle = fg;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  lines.forEach((s, k) => ctx.fillText(s, b.x + 5, b.y + (T.lh + 3) / 2 + k * T.lh));
}

/** A level's name at the left end of its line: outside the drawing when there is room, as on TradingView. */
function levelName(out: LabelPlan[], key: string, T: Type, text: string, color: string, x: number, y: number) {
  const w = T.tw(text);
  const outside = x - 6 - w >= 0;
  out.push({
    ask: { key, w, h: T.th, at: [{ x: outside ? x - 6 - w : x + 6, y: (outside ? y : y - 8) - T.th / 2 }], prio: PRIO.pinned },
    paint: bare(text, color),
  });
}

function fibPlans(out: LabelPlan[], g: Geo, T: Type, height: number) {
  if (!g.fib) return;
  const left = Math.max(g.fib.xl, 0); // drawing starts off screen: keep the labels at the pane's left edge
  g.fib.levels.forEach((l, k) => {
    if (l.y < -10 || l.y > height + 10) return;
    levelName(out, `${g.d.id}:f${k}`, T, l.label, l.color, left, l.y);
  });
}

/** A channel: the value of each line in proportion to its width, at the left end (outside it when there is
 *  room, as Fib labels), and a regression trend's Pearson's R under the start of its lower line. */
function channelPlans(out: LabelPlan[], g: Geo, T: Type, width: number, height: number) {
  const d = g.d;
  const ch = g.ch;
  if (!ch || !isChannelDrawing(d)) return;
  const s = d.style;
  /** The left end of a line on screen, or where it comes in from the left edge. */
  const leftEnd = (l: Seg) => {
    const e = extendSeg(l, s.extendLeft, s.extendRight, width);
    const x = Math.max(e.x0, 0);
    return { x, y: e.x1 === e.x0 ? e.y0 : e.y0 + ((e.y1 - e.y0) * (x - e.x0)) / (e.x1 - e.x0) };
  };
  ch.levels.forEach((l, k) => {
    const { x, y } = leftEnd(l.seg);
    if (y < -10 || y > height + 10) return;
    levelName(out, `${d.id}:c${k}`, T, fmtLevel(l.value), s.color, x, y);
  });
  if (d.kind === "regression" && s.pearson && ch.r != null) {
    // under the start of the lower line, on a dark backing so it reads over the candles
    const { x, y } = leftEnd(ch.lines[0]);
    const text = `R ${ch.r >= 0 ? "" : "−"}${Math.abs(ch.r).toFixed(3)}`;
    const w = T.tw(text) + 8;
    const h = T.lh + 1;
    const at = { x: Math.max(0, Math.min(x + 2, width - w - 2)), y: Math.max(0, Math.min(y + 5, height - h - 2)) };
    out.push({
      ask: { key: `${d.id}:r`, w, h, at: [at], prio: PRIO.pinned },
      paint: (ctx, b) => {
        ctx.fillStyle = "rgba(20,20,21,0.85)";
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.fillStyle = s.color;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(text, b.x + 4, b.y + b.h / 2);
      },
    });
  }
}

/** Info line: change in price and %, bars and time, in a box next to the second point (above right of it, else
 *  below it or on its left). */
function infoPlans(out: LabelPlan[], g: Geo, T: Type, width: number, height: number, o: PaintOptions) {
  const d = g.d;
  if (d.kind !== "info") return;
  const times = o.times;
  const bs = o.barSec;
  const dp = d.b.p - d.a.p;
  const sign = dp >= 0 ? "+" : "−";
  const pct = d.a.p ? (Math.abs(dp) / d.a.p) * 100 : 0;
  const bars = Math.abs(Math.round(timeToIndex(times, d.b.t, bs) - timeToIndex(times, d.a.t, bs)));
  const lines = [`${sign}${o.fmtPrice(Math.abs(dp))} (${sign}${pct.toFixed(2)}%)`, `${bars} 根，${fmtSpan(d.b.t - d.a.t)}`];
  const pad = 6;
  const w = Math.max(...lines.map(T.tw)) + pad * 2;
  const h = lines.length * T.lh + pad * 2 - 3;
  const fit = (x: number, y: number) => ({ x: Math.min(Math.max(0, x), width - w - 2), y: Math.min(Math.max(0, y), height - h - 2) });
  const color = d.style.color;
  out.push({
    ask: {
      key: `${d.id}:i`, w, h, prio: PRIO.drawing,
      at: [fit(g.bx + 10, g.by - h - 8), fit(g.bx + 10, g.by + 8), fit(g.bx - 10 - w, g.by - h - 8), fit(g.bx - 10 - w, g.by + 8)],
    },
    paint: (ctx, b) => {
      ctx.fillStyle = "rgba(19,23,34,0.9)";
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
      ctx.fillStyle = "#d1d4dc";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      lines.forEach((s, k) => ctx.fillText(s, b.x + pad, b.y + pad + k * T.lh));
    },
  });
}

/** Trend angle: the angle as drawn on screen, next to the arc. */
function anglePlans(out: LabelPlan[], g: Geo, T: Type) {
  const d = g.d;
  if (d.kind !== "angle") return;
  const deg = screenAngle(g.ax, g.ay, g.bx, g.by);
  const text = `${deg.toFixed(1)}°`;
  out.push({
    ask: { key: `${d.id}:a`, w: T.tw(text), h: T.th, at: [{ x: g.ax + 32, y: deg >= 0 ? g.ay - 3 - T.th : g.ay + 3 }], prio: PRIO.pinned },
    paint: bare(text, d.style.color),
  });
}

/** Position: take-profit and stop labels, the info beyond the stop line (all the time, or while the position is
 *  pointed at, selected or placed), the result and the order button, and the R lines' names. The info, the
 *  result and the order button stay on screen when the box runs past the right edge (a position drawn at the
 *  newest bar usually does), and keep clear of the box's handles; the result goes where it covers no candles
 *  when it can, and so does the info: past the stop line the price has not been while the trade is on.
 *  A position built up by adds: the last add carries the whole position's numbers (average entry, quantity,
 *  risk, result); earlier parts show only their own part. */
function positionPlans(out: LabelPlan[], g: Geo, T: Type, o: PaintOptions, width: number) {
  const d = g.d;
  const p = g.pos;
  if (d.kind !== "position" || !p) return;
  const ps = o.position;
  const fp = (v: number) => o.fmtPrice(v);
  const pct = (v: number) => {
    const x = ((v - d.a.p) / d.a.p) * 100;
    return `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}%`;
  };
  const dir = posDir(d);
  const rr = rewardRisk(d.a.p, d.b.p, d.target);
  const t = o.trades.get(d.id);
  const size = (lines: string[]) => ({ w: Math.max(...lines.map(T.tw)) + 10, h: lines.length * T.lh + 3 });
  const filled = (lines: string[], bg: string, fg = "#ffffff") => (ctx: CanvasRenderingContext2D, b: Box) => boxed(ctx, T, lines, b, bg, fg);
  const left = Math.max(p.x0, 0);
  const right = Math.min(p.x1, width);
  const mid = (left + right) / 2; // the middle of what is on screen (an open OKX position runs on)
  const fitX = (x: number, w: number) => Math.max(2, Math.min(x, width - w - 2));
  const up = dir === 1 ? -1 : 1; // screen direction of the take-profit
  /** Top of a box `h` tall on the `sign` side of a line at `y` (−1: above it), 4 px off it. */
  const beside = (y: number, sign: number, h: number) => (sign < 0 ? y - 4 - h : y + 4);
  /** A take-profit or stop label: past its line outside the box, in the middle of it (`leftFirst`: at its left end,
   *  as the stop's, with the info box at the right); else just inside the box, or at the other places along the
   *  line. Where it goes when it can, and its size. */
  const lineTag = (key: string, text: string, y: number, sign: number, bg: string, leftFirst = false) => {
    const s = size([text]);
    const cx = fitX(mid - s.w / 2, s.w);
    const lx = fitX(left + 10, s.w);
    const mids = [{ x: cx, y: beside(y, sign, s.h) }, { x: cx, y: beside(y, -sign, s.h) }];
    const ends = [{ x: lx, y: beside(y, sign, s.h) }, { x: fitX(right - 10 - s.w, s.w), y: beside(y, sign, s.h) }];
    out.push({
      ask: { key: `${d.id}:${key}`, w: s.w, h: s.h, prio: PRIO.drawing, at: leftFirst ? [ends[0], ...mids, ends[1]] : [...mids, ...ends] },
      paint: filled([text], bg),
    });
    return { x: leftFirst ? lx : cx, w: s.w, h: s.h };
  };
  /** The info box past the stop line, outside the box, at the right end of what is on screen: on the stop label's
   *  row when both fit, else one row further out; failing those, inside the box by the stop line, or on the entry
   *  row clear of the entry's handle (also where it goes with no stop drawn). Left out unless it is to show all
   *  the time or the position is pointed at, selected or placed. */
  const infoBox = (lines: string[], sl: { x: number; w: number; h: number } | null, fg = "#ffffff") => {
    if ((ps.infoHover || p.closed) && !g.active) return; // closed on OKX: a record, its info when asked for
    const s = size(lines);
    const side = -up; // the stop's side: 1 below the entry, −1 above
    const rx = fitX(right - 4 - s.w, s.w);
    const at: Spot[] = [];
    if (sl) {
      const row = { x: rx, y: beside(p.stopY, side, s.h) };
      const beyond = { x: rx, y: side > 0 ? p.stopY + 4 + sl.h + 3 : p.stopY - 4 - sl.h - 3 - s.h };
      at.push(...(sl.x + sl.w + 8 <= rx ? [row, beyond] : [beyond, row]), { x: rx, y: beside(p.stopY, -side, s.h) });
    }
    const fits = (x: number) => x >= 0 && x + s.w <= width - 4;
    const after = p.x0 + 10;
    const before = p.x0 - 10 - s.w;
    at.push({ x: fits(after) ? after : fits(before) ? before : Math.max(0, Math.min(after, width - 4 - s.w)), y: p.entryY - s.h / 2 });
    out.push({ ask: { key: `${d.id}:info`, w: s.w, h: s.h, at, prio: PRIO.anchored }, paint: filled(lines, "rgba(25,25,27,0.92)", fg) });
  };
  /** What it came to, and the order button after it, on the row at `y`, off the candles when it can be: right of
   *  the box (past its handle); else at the right end of the row, or just inside the take-profit or the stop
   *  line, moving left along them as far as the box goes; under or over the row, or before the entry. */
  const resultRow = (text: string, bg: string, y: number, order: OrderTag | null) => {
    const r = size([text]);
    const ow = order ? size([order.text]).w : 0;
    const w = r.w + (order ? 4 + ow : 0);
    const h = r.h;
    const lx = fitX(left + 10, w);
    const rx = fitX(right - 4 - w, w);
    const along = { slide: "left" as const, range: { min: Math.min(rx, Math.max(0, p.x0 + 10)), max: rx } };
    // closed on OKX: around entry to close (the rest isn't drawn): right of it, past the close or the entry line
    const c = p.closed;
    const away = c && c.y >= p.entryY ? 1 : -1; // from the entry towards the close
    const at: Spot[] = c
      ? [
          { x: p.x1 + 10, y: y - h / 2 },
          { x: p.x1 + 10, y: c.y - h / 2 },
          { x: rx, y: beside(c.y, away, h), ...along },
          { x: rx, y: beside(p.entryY, -away, h), ...along },
          { x: p.x0 - 10 - w, y: y - h / 2 },
        ]
      : [
          { x: p.x1 + 10, y: y - h / 2 },
          { x: rx, y: y - h / 2, ...along },
          { x: rx, y: beside(p.targetY, -up, h), ...along },
          { x: rx, y: beside(p.stopY, up, h), ...along },
          { x: lx, y: y + h / 2 + 4 },
          { x: lx, y: y - h / 2 - 4 - h },
          { x: p.x0 - 10 - w, y: y - h / 2 },
        ];
    out.push({
      ask: { key: `${d.id}:result`, w, h, prio: PRIO.drawing, avoid: o.covers, at },
      paint: (ctx, b) => {
        boxed(ctx, T, [text], { x: b.x, y: b.y, w: r.w, h }, bg, "#ffffff");
        if (!order) return;
        const ob = { x: b.x + r.w + 4, y: b.y, w: ow, h };
        boxed(ctx, T, [order.text], ob, order.bg, order.fg ?? "#ffffff");
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1;
        ctx.strokeRect(ob.x + 0.5, ob.y + 0.5, ob.w - 1, ob.h - 1);
      },
      ...(order ? { spot: { id: d.id, dx: r.w + 4, w: ow } } : {}),
    });
  };
  const show = ps.showPrices;
  const money = (v: number) => `${v >= 0 ? "+" : "−"}${fmtMoney(Math.abs(v))} U`;
  const live = o.live(d);
  const gray = "rgba(45,45,48,0.95)";
  if (d.okx) {
    // drawn from OKX: its stops when set (what they make or lose now), size, average, and the PnL now or at the end
    const k = d.okx;
    const v = live ?? { coins: k.coins, avg: d.a.p, lever: k.lever, upl: null, closed: k.closed ?? null, demo: k.demo };
    const vs = (x: number) => {
      const r = ((x - v.avg) / v.avg) * 100;
      return `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}%`;
    };
    const open = !v.closed;
    if (!k.noTp && !p.closed) lineTag("tp", `止盈 ${fp(d.target)} (${vs(d.target)})${open ? "  " + money(v.coins * (d.target - v.avg) * dir) : ""}`, p.targetY, up, ps.profit);
    const sl = k.noSl || p.closed ? null : lineTag("sl", `止損 ${fp(d.b.p)} (${vs(d.b.p)})${open ? "  " + money(v.coins * (d.b.p - v.avg) * dir) : ""}`, p.stopY, -up, ps.loss, true);
    infoBox(
      [
        `OKX 持倉${v.demo ? "（模擬）" : ""}  ${dir === 1 ? "多單" : "空單"}  ${fmtQty(v.coins)} ${o.base}  ${Math.round(v.lever)}x`,
        `均價 ${fp(v.avg)}${k.noSl ? "  沒有設止損" : ""}${k.noTp ? "  沒有設止盈" : ""}`,
      ],
      sl,
    );
    const [text, bg] = v.closed
      ? [`已平倉${v.closed.px ? ` @ ${fp(v.closed.px)}  ${money(v.closed.pnl)}` : ""}`, v.closed.px ? (v.closed.pnl >= 0 ? ps.profit : ps.loss) : gray]
      : [v.upl != null ? `持倉中 ${money(v.upl)}` : "持倉中", gray];
    resultRow(text, bg, p.entryY, null);
    return;
  }
  const sc = t?.scale ?? null;
  const earlier = !!sc && sc.step < sc.count; // a later add's stop and take-profit are the ones in force
  // the risk and reward the R and money are of: the whole position for the last add, else this one
  const risk = sc ? sc.risk : (t?.plan.riskAmount ?? 0);
  const reward = sc ? sc.reward : (t?.plan.reward ?? 0);
  // results in R (multiples of the risk) next to the money: the stop is −1.00R, the take-profit +reward/risk
  const tpR = sc ? (risk > 0 ? `  ${signed(reward / risk)}R` : "") : `  ${signed(rr)}R`;
  const slR = risk > 0 || !sc ? "  −1.00R" : "";
  const tpText = `止盈 ${show ? fp(d.target) + " " : ""}(${pct(d.target)})${earlier ? "" : `${tpR}${t ? "  " + money(reward) : ""}`}`;
  const slText = `止損 ${show ? fp(d.b.p) + " " : ""}(${pct(d.b.p)})${earlier ? "" : `${slR}${t ? "  " + money(-risk) : ""}`}`;
  // closed on OKX: a record of entry to close, without the plan's take-profit and stop
  if (!p.closed) lineTag("tp", tpText, p.targetY, up, earlier ? hexToRgba(ps.profit, 0.45) : ps.profit);
  const sl = p.closed ? null : lineTag("sl", slText, p.stopY, -up, earlier ? hexToRgba(ps.loss, 0.45) : ps.loss, true);
  if (t) {
    const pl = t.plan;
    const side = dir === 1 ? "多單" : "空單";
    const capped = pl.capped ? "（保證金不夠，已減量）" : "";
    const infoLines = !sc
      ? [
          `${side}  ${fmtQty(pl.qty)} ${o.base}  ${d.leverage}x  保證金 ${fmtMoney(pl.margin)} U${capped}`,
          `資金 ${fmtMoney(t.capital)} U${t.chained ? "（接續）" : ""}  風險 ${fmtMoney(pl.riskAmount)} U  盈虧比 ${rr.toFixed(2)}`,
        ]
      : earlier
        ? [
            `${side}${sc.step > 1 ? `加倉（第 ${sc.step} 筆）` : ""}  ${fmtQty(pl.qty)} ${o.base}  ${d.leverage}x  保證金 ${fmtMoney(pl.margin)} U${capped}`,
            `已加倉：整筆改用第 ${sc.count} 筆的止損、止盈`,
          ]
        : [
            `${side}加倉${sc.count > 2 ? `（第 ${sc.step} 筆）` : ""}  ${fmtQty(pl.qty)} ${o.base}  ${d.leverage}x  保證金 ${fmtMoney(pl.margin)} U${sc.full ? "（風險已滿，不加）" : capped}`,
            `${t.outcome.status === "pending" ? "成交後" : "合併"} ${fmtQty(sc.qty)} ${o.base}  均價 ${fp(sc.avg)}  ${risk > 0 ? `整筆風險 ${fmtMoney(risk)} U` : `止損時 ${money(-risk)}`}`,
          ];
    const warn = pl.capped || (!!sc && sc.full && !earlier);
    // an earlier part's labels go to the stop side of its entry: later adds sit on the profit side, close by
    const rowY = earlier ? p.entryY - up * (size(infoLines).h / 2 + 3) : p.entryY;
    infoBox(infoLines, sl, warn ? THEME.down : "#ffffff");
    const pnl = sc ? sc.pnl : t.pnl;
    const inR = risk > 0 ? `${signed(pnl / risk)}R  ` : "";
    const result: Record<string, [string, string]> = {
      tp: [`止盈出場 ${inR}${money(pnl)} → ${fmtMoney(t.endCapital)} U`, ps.profit],
      sl: [`止損出場 ${inR}${money(pnl)} → ${fmtMoney(t.endCapital)} U`, ps.loss],
      expired: [`到期出場 ${inR}${money(pnl)} → ${fmtMoney(t.endCapital)} U`, gray],
      open: [`持倉中 ${inR}${money(pnl)}`, gray],
      pending: ["等待進場", gray],
      unfilled: ["沒有成交", gray],
      nodata: ["K 線不夠，無法結算", gray],
    };
    // on OKX: what OKX says wins over the what-if
    const real: [string, string] | null =
      live && !earlier
        ? live.closed
          ? [`OKX 已平倉${live.closed.px ? ` @ ${fp(live.closed.px)}  ${money(live.closed.pnl)}` : ""}`, live.closed.px ? (live.closed.pnl >= 0 ? ps.profit : ps.loss) : gray]
          : live.upl != null
            ? [`OKX 持倉中 ${money(live.upl)}`, gray]
            : null
        : null;
    const [text, bg] = earlier ? [`已加倉，結果看第 ${sc.count} 筆`, gray] : real ?? result[t.outcome.status];
    resultRow(text, bg, rowY, o.orderTag(d));
  }
  // R lines' names over the right end of each line on screen, or under it, else further left along it, inside the
  // box; left out when there is no room (the line still shows); none on a closed record
  if (!p.closed) p.levels.forEach((l, k) => {
    const text = `${l.k}R${show ? "  " + fp(l.price) : ""}`;
    const w = T.tw(text);
    const x = right - 4 - w;
    out.push({
      ask: {
        key: `${d.id}:R${k}`, w, h: T.th, prio: PRIO.minor,
        at: [{ x, y: l.y - 2 - T.th }, { x, y: l.y + 2 }],
        slide: "left",
        range: { min: left + 4, max: x },
        optional: true,
      },
      paint: bare(text, ps.profit),
    });
  });
}

// ----------------------------------------------------------------------------- measuring
/** A measurement on screen (the ruler, or Shift + click): from (ax, ay) to (bx, by), and what it says. */
export type MeasureGeo = { ax: number; ay: number; bx: number; by: number; up: boolean; lines: string[] };
const MEASURE_UP = "#2962ff";
const MEASURE_DOWN = "#f23645";

/** What a measurement from `a` to `b` says: the change in price and in %, how many bars and how long, and the
 *  volume traded in the bars it spans (those loaded). */
export function measureLines(
  a: Anchor,
  b: Anchor,
  o: { times: number[]; barSec: number; bars: readonly Candle[]; fmtPrice(p: number): string },
): string[] {
  const dp = b.p - a.p;
  const sign = dp >= 0 ? "+" : "−";
  const pct = a.p ? (Math.abs(dp) / a.p) * 100 : 0;
  const ia = Math.round(timeToIndex(o.times, a.t, o.barSec));
  const ib = Math.round(timeToIndex(o.times, b.t, o.barSec));
  let vol = 0;
  for (let i = Math.max(0, Math.min(ia, ib)); i <= Math.min(o.bars.length - 1, Math.max(ia, ib)); i++) vol += o.bars[i].volume;
  return [
    `${sign}${o.fmtPrice(Math.abs(dp))} (${sign}${pct.toFixed(2)}%)`,
    `${Math.abs(ib - ia)} 根，${fmtSpan(b.t - a.t)}`,
    `成交量 ${fmtVol(vol)}`,
  ];
}

/** A measurement: a shaded box blue going up, red going down, arrows through its middle the way price and time
 *  went, and its numbers past the end it went to. Over everything else, while it shows. */
export function paintMeasure(target: CanvasRenderingTarget2D, g: MeasureGeo | null, textPx: number) {
  if (!g) return;
  const color = g.up ? MEASURE_UP : MEASURE_DOWN;
  target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
    const x0 = Math.min(g.ax, g.bx);
    const x1 = Math.max(g.ax, g.bx);
    const y0 = Math.min(g.ay, g.by);
    const y1 = Math.max(g.ay, g.by);
    ctx.save();
    ctx.fillStyle = hexToRgba(color, 0.18);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    const mx = Math.round((g.ax + g.bx) / 2) + 0.5;
    const my = Math.round((g.ay + g.by) / 2) + 0.5;
    arrow(ctx, mx, g.ay, mx, g.by);
    arrow(ctx, g.ax, my, g.bx, my);
    const T = typeOf(textPx);
    ctx.font = T.font;
    const pad = 7;
    const w = Math.max(...g.lines.map(T.tw)) + pad * 2;
    const h = g.lines.length * T.lh + pad * 2 - 3;
    const bx = Math.max(2, Math.min((g.ax + g.bx) / 2 - w / 2, mediaSize.width - w - 2));
    const by = Math.max(2, Math.min(g.up ? y0 - 8 - h : y1 + 8, mediaSize.height - h - 2));
    ctx.fillStyle = hexToRgba(color, 0.92);
    ctx.fillRect(bx, by, w, h);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    g.lines.forEach((s, k) => ctx.fillText(s, bx + w / 2, by + pad + (T.lh - 3) / 2 + k * T.lh));
    ctx.restore();
  });
}

/** A line from (x0, y0) to (x1, y1) with a head at its end; nothing when it is too short to see. */
function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 10) return;
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  const s = 6;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - ux * s - uy * s * 0.55, y1 - uy * s + ux * s * 0.55);
  ctx.lineTo(x1 - ux * s + uy * s * 0.55, y1 - uy * s - ux * s * 0.55);
  ctx.closePath();
  ctx.fill();
}
