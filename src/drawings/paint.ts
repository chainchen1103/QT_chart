// Painting the drawings: fills under the candles (Fib bands, rectangles, position zones), and lines, handles
// and labels over them. Pure drawing from the geometry in geo.ts; nothing here changes any state.

import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { Dash, FibSettings, PositionDrawing, PositionSettings } from "../settings/model.ts";
import { extendSeg, type Geo, type Seg } from "./geo.ts";
import { fmtLevel, fmtSpan, hexToRgba, posDir, rewardRisk, screenAngle, timeToIndex } from "./geometry.ts";
import { fmtMoney, fmtQty, type PositionResult } from "./trade.ts";
import { signed } from "../core/format.ts";
import type { LiveInfo } from "../trade/sync.ts";
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
  /** A position on OKX: what OKX says of it (size, average, unrealized PnL, or how it ended). */
  live(d: PositionDrawing): LiveInfo | null;
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
          const t = o.trades.get(d.id);
          const sc = t?.scale;
          const dim = sc && sc.step < sc.count ? 0.4 : 1; // an earlier part: a later add's stop and take-profit rule
          for (const l of g.pos.levels) hl(l.y, hexToRgba(ps.profit, 0.9 * dim), "dash");
          if (!d.okx?.noTp) hl(g.pos.targetY, hexToRgba(ps.profit, dim), "solid");
          if (!d.okx?.noSl) hl(g.pos.stopY, hexToRgba(ps.loss, dim), "solid");
          hl(g.pos.entryY, "#b2b5be", "solid");
          if (g.pos.exit && t && !o.live(d)) { // on OKX: how it really went is in the labels
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
      else if (g.ch) channelLabels(ctx, g, mediaSize.width, mediaSize.height);
    }
  });
  return spots;
}

/** A channel: the value of each line in proportion to its width, at the left end (outside it when there is
 *  room, as Fib labels), and a regression trend's Pearson's R under the start of its lower line. */
function channelLabels(ctx: CanvasRenderingContext2D, g: Geo, width: number, height: number) {
  const d = g.d;
  const ch = g.ch;
  if (!ch || !(d.kind === "channel" || d.kind === "regression" || d.kind === "flat" || d.kind === "disjoint")) return;
  const s = d.style;
  /** The left end of a line on screen, or where it comes in from the left edge. */
  const leftEnd = (l: Seg) => {
    const e = extendSeg(l, s.extendLeft, s.extendRight, width);
    const x = Math.max(e.x0, 0);
    return { x, y: e.x1 === e.x0 ? e.y0 : e.y0 + ((e.y1 - e.y0) * (x - e.x0)) / (e.x1 - e.x0) };
  };
  ctx.fillStyle = s.color;
  ctx.textBaseline = "middle";
  for (const l of ch.levels) {
    const { x, y } = leftEnd(l.seg);
    if (y < -10 || y > height + 10) continue;
    const text = fmtLevel(l.value);
    const outside = x - 6 - ctx.measureText(text).width >= 0;
    ctx.textAlign = outside ? "right" : "left";
    ctx.fillText(text, outside ? x - 6 : x + 6, outside ? y : y - 8);
  }
  if (d.kind === "regression" && s.pearson && ch.r != null) {
    // under the start of the lower line, on a dark backing so it reads over the candles
    const { x, y } = leftEnd(ch.lines[0]);
    const text = `R ${ch.r >= 0 ? "" : "−"}${Math.abs(ch.r).toFixed(3)}`;
    const w = ctx.measureText(text).width + 8;
    const left = Math.max(0, Math.min(x + 2, width - w - 2));
    const top = Math.max(0, Math.min(y + 5, height - 18));
    ctx.fillStyle = "rgba(20,20,21,0.85)";
    ctx.fillRect(left, top, w, 16);
    ctx.fillStyle = s.color;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, left + 4, top + 8);
  }
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
 *  drawn at the newest bar usually does). A position built up by adds: the last add carries the whole
 *  position's numbers (average entry, quantity, risk, result); earlier parts show only their own part. */
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
  const dir = posDir(d);
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
  const mid = (Math.max(p.x0, 0) + Math.min(p.x1, width)) / 2; // the middle of what is on screen (an open OKX position runs on)
  const show = ps.showPrices;
  const money = (v: number) => `${v >= 0 ? "+" : "−"}${fmtMoney(Math.abs(v))} U`;
  // labels sit just outside the box, past the take-profit and the stop
  const outward = (y: number, sign: number) => y + sign * 13;
  const up = dir === 1 ? -1 : 1; // screen direction of the take-profit
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
    if (!k.noTp) tag([`止盈 ${fp(d.target)} (${vs(d.target)})${open ? "  " + money(v.coins * (d.target - v.avg) * dir) : ""}`], mid, outward(p.targetY, up), ps.profit);
    if (!k.noSl) tag([`止損 ${fp(d.b.p)} (${vs(d.b.p)})${open ? "  " + money(v.coins * (d.b.p - v.avg) * dir) : ""}`], mid, outward(p.stopY, -up), ps.loss);
    const lines = [
      `OKX 持倉${v.demo ? "（模擬）" : ""}  ${dir === 1 ? "多單" : "空單"}  ${fmtQty(v.coins)} ${o.base}  ${Math.round(v.lever)}x`,
      `均價 ${fp(v.avg)}${k.noSl ? "  沒有設止損" : ""}${k.noTp ? "  沒有設止盈" : ""}`,
    ];
    const bx = box(lines, Math.max(0, Math.min(p.x0 + 4, width - 4 - size(lines).w)), p.entryY, "rgba(25,25,27,0.92)", "left");
    const [text, bg] = v.closed
      ? [`已平倉${v.closed.px ? ` @ ${fp(v.closed.px)}  ${money(v.closed.pnl)}` : ""}`, v.closed.px ? (v.closed.pnl >= 0 ? ps.profit : ps.loss) : gray]
      : [v.upl != null ? `持倉中 ${money(v.upl)}` : "持倉中", gray];
    const w = size([text]).w;
    let x = Math.max(p.x1, bx.x + bx.w) + 6;
    let y = p.entryY;
    if (x + w > width - 4) {
      x = width - 4 - w;
      if (x < bx.x + bx.w + 6) {
        x = Math.max(0, Math.min(bx.x, width - 4 - w));
        y = bx.y + bx.h + 11;
      }
    }
    tag([text], x, y, bg, "left");
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
  tag([tpText], mid, outward(p.targetY, up), earlier ? hexToRgba(ps.profit, 0.45) : ps.profit);
  tag([slText], mid, outward(p.stopY, -up), earlier ? hexToRgba(ps.loss, 0.45) : ps.loss);
  if (!t) return;
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
  const infoX = Math.max(0, Math.min(p.x0 + 4, width - 4 - size(infoLines).w));
  const warn = pl.capped || (!!sc && sc.full && !earlier);
  // an earlier part's labels go to the stop side of its entry: later adds sit on the profit side, close by
  const rowY = earlier ? p.entryY - up * (size(infoLines).h / 2 + 3) : p.entryY;
  const info = box(infoLines, infoX, rowY, "rgba(25,25,27,0.92)", "left", warn ? THEME.down : "#ffffff");
  const infoRight = info.x + info.w;
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
  const order = o.orderTag(d);
  const total = size([text]).w + (order ? 4 + size([order.text]).w : 0);
  let x = Math.max(p.x1, infoRight) + 6; // past the info box when that is wider than the position
  let y = rowY;
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
