// Painting the drawings: fills under the candles (Fib bands, rectangles, position zones), and lines, handles
// and labels over them. Pure drawing from the geometry in geo.ts; nothing here changes any state.

import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { Dash, FibSettings, PositionDrawing, PositionSettings } from "../settings/model.ts";
import type { Geo } from "./geo.ts";
import { fmtSpan, hexToRgba, positionDir, rewardRisk, screenAngle, timeToIndex } from "./geometry.ts";
import { fmtMoney, fmtQty, type PositionResult } from "./trade.ts";
import { signed } from "../core/format.ts";
import { MONO_FONT, THEME } from "../ui/theme.ts";

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
};

const FONT = `11px ${MONO_FONT}`;
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
        const t = Math.round(g.pos.targetY * vr);
        const sl = Math.round(g.pos.stopY * vr);
        ctx.fillStyle = hexToRgba(ps.profit, alpha);
        ctx.fillRect(x0, Math.min(e, t), x1 - x0, Math.abs(t - e));
        ctx.fillStyle = hexToRgba(ps.loss, alpha);
        ctx.fillRect(x0, Math.min(e, sl), x1 - x0, Math.abs(sl - e));
      } else if (d.kind === "rect") {
        const s = d.style;
        if (s.transparency >= 100) continue;
        const x0 = Math.round(Math.min(g.ax, g.bx) * hr);
        const x1 = s.extend ? bitmapSize.width : Math.round(Math.max(g.ax, g.bx) * hr);
        const y0 = Math.round(Math.min(g.ay, g.by) * vr);
        const y1 = Math.round(Math.max(g.ay, g.by) * vr);
        ctx.fillStyle = hexToRgba(s.fill, 1 - s.transparency / 100);
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
  });
}

/** Lines, borders, labels and handles over the candles. */
/** Lines, handles and labels over the candles; returns where the order buttons were painted. */
export function paintOver(target: CanvasRenderingTarget2D, geo: readonly Geo[], o: PaintOptions): HotSpot[] {
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
          for (const l of g.pos.levels) hl(l.y, hexToRgba(ps.profit, 0.9), "dash");
          hl(g.pos.targetY, ps.profit, "solid");
          hl(g.pos.stopY, ps.loss, "solid");
          hl(g.pos.entryY, "#b2b5be", "solid");
          const t = o.trades.get(d.id);
          if (g.pos.exit && t) {
            const color = t.outcome.status === "tp" ? ps.profit : t.outcome.status === "sl" ? ps.loss : "#b2b5be";
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
      }
      if (g.active) {
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
    }
  });
  target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
    ctx.font = FONT;
    for (const g of geo) {
      if (g.d.kind === "fib") fibLabels(ctx, g, mediaSize.height);
      else if (g.d.kind === "info") infoBox(ctx, g, mediaSize.width, mediaSize.height, o);
      else if (g.d.kind === "angle") angleLabel(ctx, g);
      else if (g.d.kind === "position") positionLabels(ctx, g, o, spots, mediaSize.width);
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

function fibLabels(ctx: CanvasRenderingContext2D, g: Geo, height: number) {
  if (!g.fib) return;
  ctx.textBaseline = "middle";
  const left = Math.max(g.fib.xl, 0); // drawing starts off screen: keep the labels at the pane's left edge
  for (const l of g.fib.levels) {
    if (l.y < -10 || l.y > height + 10) continue;
    const w = ctx.measureText(l.label).width;
    const outside = left - 6 - w >= 0; // to the left of the drawing, as on TradingView
    ctx.textAlign = outside ? "right" : "left";
    ctx.fillStyle = l.color;
    ctx.fillText(l.label, outside ? left - 6 : left + 6, outside ? l.y : l.y - 8);
  }
}

/** Info line: change in price and %, bars and time, in a box next to the second point. */
function infoBox(ctx: CanvasRenderingContext2D, g: Geo, width: number, height: number, o: PaintOptions) {
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
  const lh = 15;
  const w = Math.max(...lines.map((s) => ctx.measureText(s).width)) + pad * 2;
  const h = lines.length * lh + pad * 2 - 3;
  const x = Math.min(Math.max(0, g.bx + 10), width - w - 2);
  const y = Math.min(Math.max(0, g.by - h - 8), height - h - 2);
  ctx.fillStyle = "rgba(19,23,34,0.9)";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = d.style.color;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = "#d1d4dc";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  lines.forEach((s, k) => ctx.fillText(s, x + pad, y + pad + k * lh));
}

/** Position: take-profit, stop and entry labels, the result, the order button, and the R lines' names. The
 *  info, the result and the order button stay on screen when the box runs past the right edge (a position
 *  drawn at the newest bar usually does). */
function positionLabels(ctx: CanvasRenderingContext2D, g: Geo, o: PaintOptions, spots: HotSpot[], width: number) {
  const d = g.d;
  const p = g.pos;
  if (d.kind !== "position" || !p) return;
  const ps = o.position;
  const fp = (v: number) => o.fmtPrice(v);
  const pct = (v: number) => {
    const x = ((v - d.a.p) / d.a.p) * 100;
    return `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}%`;
  };
  const dir = positionDir(d.a.p, d.b.p);
  const rr = rewardRisk(d.a.p, d.b.p, d.target);
  const t = o.trades.get(d.id);
  const size = (lines: string[]) => ({ w: Math.max(...lines.map((s) => ctx.measureText(s).width)) + 10, h: lines.length * 15 + 3 });
  /** A box of text lines; `align` says which side of x the box goes. Returns the box. */
  const box = (lines: string[], x: number, y: number, bg: string, align: "center" | "left" = "center", fg = "#ffffff") => {
    const { w, h } = size(lines);
    const left = align === "center" ? x - w / 2 : x;
    ctx.fillStyle = bg;
    ctx.fillRect(left, y - h / 2, w, h);
    ctx.fillStyle = fg;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    lines.forEach((s, k) => ctx.fillText(s, left + 5, y - h / 2 + 9 + k * 15));
    return { x: left, y: y - h / 2, w, h };
  };
  const tag = (...a: Parameters<typeof box>) => {
    const b = box(...a);
    return b.x + b.w;
  };
  const mid = (p.x0 + p.x1) / 2;
  const show = ps.showPrices;
  const money = (v: number) => `${v >= 0 ? "+" : "−"}${fmtMoney(Math.abs(v))} U`;
  // labels sit just outside the box, past the take-profit and the stop
  const outward = (y: number, sign: number) => y + sign * 13;
  const up = dir === 1 ? -1 : 1; // screen direction of the take-profit
  // results in R (multiples of the risk) next to the money: the stop is −1.00R, the take-profit +reward/risk
  tag([`止盈 ${show ? fp(d.target) + " " : ""}(${pct(d.target)})  ${signed(rr)}R${t ? "  " + money(t.plan.reward) : ""}`], mid, outward(p.targetY, up), ps.profit);
  tag([`止損 ${show ? fp(d.b.p) + " " : ""}(${pct(d.b.p)})  −1.00R${t ? "  " + money(-t.plan.riskAmount) : ""}`], mid, outward(p.stopY, -up), ps.loss);
  if (!t) return;
  const pl = t.plan;
  const side = dir === 1 ? "多單" : "空單";
  const infoLines = [
    `${side}  ${fmtQty(pl.qty)} ${o.base}  ${d.leverage}x  保證金 ${fmtMoney(pl.margin)} U${pl.capped ? "（保證金不夠，已減量）" : ""}`,
    `資金 ${fmtMoney(t.capital)} U${t.chained ? "（接續）" : ""}  風險 ${fmtMoney(pl.riskAmount)} U  盈虧比 ${rr.toFixed(2)}`,
  ];
  const infoX = Math.max(0, Math.min(p.x0 + 4, width - 4 - size(infoLines).w));
  const info = box(infoLines, infoX, p.entryY, "rgba(25,25,27,0.92)", "left", pl.capped ? THEME.down : "#ffffff");
  const infoRight = info.x + info.w;
  const inR = pl.riskAmount > 0 ? `${signed(t.pnl / pl.riskAmount)}R  ` : "";
  const result: Record<string, [string, string]> = {
    tp: [`止盈出場 ${inR}${money(t.pnl)} → ${fmtMoney(t.endCapital)} U`, ps.profit],
    sl: [`止損出場 ${inR}${money(t.pnl)} → ${fmtMoney(t.endCapital)} U`, ps.loss],
    expired: [`到期出場 ${inR}${money(t.pnl)} → ${fmtMoney(t.endCapital)} U`, "rgba(45,45,48,0.95)"],
    open: [`持倉中 ${inR}${money(t.pnl)}`, "rgba(45,45,48,0.95)"],
    pending: ["等待進場", "rgba(45,45,48,0.95)"],
    unfilled: ["沒有成交", "rgba(45,45,48,0.95)"],
    nodata: ["K 線不夠，無法結算", "rgba(45,45,48,0.95)"],
  };
  const [text, bg] = result[t.outcome.status];
  const order = o.orderTag(d);
  const total = size([text]).w + (order ? 4 + size([order.text]).w : 0);
  let x = Math.max(p.x1, infoRight) + 6; // past the info box when that is wider than the position
  let y = p.entryY;
  if (x + total > width - 4) {
    // past the right edge: pull them back on screen, after the info box, or under it when there is no room
    x = width - 4 - total;
    if (x < infoRight + 6) {
      x = Math.max(0, Math.min(info.x, width - 4 - total));
      y = info.y + info.h + 11;
    }
  }
  const resultRight = tag([text], x, y, bg, "left");
  if (order) {
    const b = box([order.text], resultRight + 4, y, order.bg, "left", order.fg);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
    spots.push({ id: d.id, ...b });
  }
  ctx.font = FONT;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = ps.profit;
  for (const l of p.levels) ctx.fillText(`${l.k}R${show ? "  " + fp(l.price) : ""}`, p.x1 - 4, l.y - 2);
}

/** Trend angle: the angle as drawn on screen, next to the arc. */
function angleLabel(ctx: CanvasRenderingContext2D, g: Geo) {
  const d = g.d;
  if (d.kind !== "angle") return;
  const deg = screenAngle(g.ax, g.ay, g.bx, g.by);
  ctx.fillStyle = d.style.color;
  ctx.textAlign = "left";
  ctx.textBaseline = deg >= 0 ? "bottom" : "top";
  ctx.fillText(`${deg.toFixed(1)}°`, g.ax + 32, deg >= 0 ? g.ay - 3 : g.ay + 3);
}
