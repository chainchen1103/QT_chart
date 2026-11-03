// Paints what a Pine script shows besides its plot lines: background colors, fills between plots or lines,
// shapes and characters, arrows, candles, horizontal lines, and the script's drawing objects (lines, labels,
// boxes, line fills, polylines, tables), plus a strategy's trade marks. One layer per pane a script draws in;
// it is attached to a series of that pane, whose price scale places the prices.

import type { AutoscaleInfo, IChartApi, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Logical, SeriesAttachedParameter, SeriesType, Time } from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { xOfLogical } from "../../chart/coords.ts";
import { timeToIndex } from "../../drawings/geometry.ts";
import type { Candle } from "../../core/api.ts";
import { cssColor } from "../../pine/runtime.ts";
import type { ArrowOut, BgOut, CandleOut, FillOut, HlineOut, PBox, PLabel, PLine, PLinefill, PPolyline, PTable, PlotOut, ShapeOut } from "../../pine/outputs.ts";
import type { Fill } from "../../pine/strategy.ts";
import { UI_FONT } from "../../ui/theme.ts";

export type PineScene = {
  /** In the price pane: abovebar / belowbar are measured from the candles. */
  onPrice: boolean;
  bgs: BgOut[];
  fills: FillOut[];
  shapes: ShapeOut[];
  arrows: ArrowOut[];
  candles: CandleOut[];
  hlines: HlineOut[];
  lines: PLine[];
  labels: PLabel[];
  boxes: PBox[];
  tables: PTable[];
  linefills: PLinefill[];
  polylines: PPolyline[];
  trades: Fill[];
  fmtQty: (q: number) => string;
};

export const emptyScene = (onPrice: boolean): PineScene => ({
  onPrice, bgs: [], fills: [], shapes: [], arrows: [], candles: [], hlines: [], lines: [], labels: [], boxes: [], tables: [], linefills: [], polylines: [], trades: [],
  fmtQty: (q) => String(q),
});

export type LayerHost = {
  chart: IChartApi;
  bars(): Candle[];
  times(): number[];
  barSec(): number;
};

const FONT = UI_FONT;
const TEXT_PX: Record<string, number> = { tiny: 9, small: 11, normal: 13, large: 16, huge: 22, auto: 12 };
const SHAPE_PX: Record<string, number> = { tiny: 7, small: 10, normal: 14, large: 20, huge: 28, auto: 10 };
const BUY = "#2962FF";
/** display.pane */
const PANE = 1;
const SELL = "#E91E63";

type Ctx = CanvasRenderingContext2D;

export class PineLayer implements ISeriesPrimitive<Time> {
  private scene: PineScene;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly host: LayerHost;
  private readonly views: IPrimitivePaneView[];
  /** In a script's own pane: its horizontal lines and drawings count for the price scale's range. */
  private readonly scales: boolean;

  constructor(host: LayerHost, scene: PineScene, scales = false) {
    this.host = host;
    this.scene = scene;
    this.scales = scales;
    this.views = [
      { zOrder: () => "bottom", renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => this.paint(t, "bottom") }) },
      { zOrder: () => "normal", renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => this.paint(t, "normal") }) },
      { zOrder: () => "top", renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => this.paint(t, "top") }) },
    ];
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.series = p.series as ISeriesApi<SeriesType>;
    this.requestUpdate = p.requestUpdate;
  }
  detached() {
    this.series = null;
    this.requestUpdate = null;
  }
  paneViews() {
    return this.views;
  }
  set(scene: PineScene) {
    this.scene = scene;
    this.requestUpdate?.();
  }

  autoscaleInfo(from: Logical, to: Logical): AutoscaleInfo | null {
    if (!this.scales) return null;
    let lo = Infinity;
    let hi = -Infinity;
    const take = (p: number) => {
      if (p === p && Number.isFinite(p)) {
        lo = Math.min(lo, p);
        hi = Math.max(hi, p);
      }
    };
    const s = this.scene;
    for (const h of s.hlines) if (h.display & PANE) take(h.price);
    const inView = (a: number, b: number, xloc: string) => {
      const x1 = this.bx(a, xloc);
      const x2 = this.bx(b, xloc);
      return Math.max(x1, x2) >= from && Math.min(x1, x2) <= to;
    };
    for (const l of s.lines) if (inView(l.x1, l.x2, l.xloc)) (take(l.y1), take(l.y2));
    for (const b of s.boxes) if (inView(b.left, b.right, b.xloc)) (take(b.top), take(b.bottom));
    for (const l of s.labels) if (l.yloc === "price" && inView(l.x, l.x, l.xloc)) take(l.y);
    return lo <= hi ? { priceRange: { minValue: lo, maxValue: hi } } : null;
  }

  // ------------------------------------------------------------------- coordinates
  private x(i: number): number | null {
    return xOfLogical(this.host.chart, i);
  }
  private y(p: number): number | null {
    if (!(p === p) || !this.series) return null;
    return this.series.priceToCoordinate(p);
  }
  /** Bar index of an x position given as a bar index or a time (ms). */
  private bx(x: number, xloc: string): number {
    if (xloc !== "bar_time") return x;
    return timeToIndex(this.host.times(), x / 1000, this.host.barSec());
  }
  private visible(): { from: number; to: number; spacing: number } | null {
    const r = this.host.chart.timeScale().getVisibleLogicalRange();
    if (!r) return null;
    const x0 = this.x(0);
    const x1 = this.x(1);
    const spacing = x0 != null && x1 != null ? x1 - x0 : 6;
    return { from: Math.floor(r.from) - 2, to: Math.ceil(r.to) + 2, spacing };
  }

  // ------------------------------------------------------------------- painting
  private paint(target: CanvasRenderingTarget2D, layer: "bottom" | "normal" | "top") {
    const v = this.visible();
    if (!v || !this.series) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const W = mediaSize.width;
      const H = mediaSize.height;
      ctx.save();
      try {
        if (layer === "bottom") {
          this.paintBg(ctx, v, H);
          this.paintFills(ctx, v, W);
          for (const f of this.scene.linefills) this.paintLinefill(ctx, f, W);
          for (const b of this.scene.boxes) this.paintBox(ctx, b, W, true);
          for (const p of this.scene.polylines) this.paintPolyline(ctx, p, true);
        } else if (layer === "normal") {
          for (const h of this.scene.hlines) this.paintHline(ctx, h, W);
          for (const c of this.scene.candles) this.paintCandles(ctx, c, v);
          for (const b of this.scene.boxes) this.paintBox(ctx, b, W, false);
          for (const p of this.scene.polylines) this.paintPolyline(ctx, p, false);
          for (const l of this.scene.lines) this.paintLine(ctx, l, W);
          for (const s of this.scene.shapes) this.paintShapes(ctx, s, v, H);
          for (const a of this.scene.arrows) this.paintArrows(ctx, a, v);
          for (const l of this.scene.labels) this.paintLabel(ctx, l);
          this.paintTrades(ctx, v);
        } else {
          for (const t of this.scene.tables) this.paintTable(ctx, t, W, H);
        }
      } finally {
        ctx.restore();
      }
    });
  }

  private paintBg(ctx: Ctx, v: { from: number; to: number; spacing: number }, H: number) {
    const half = v.spacing / 2;
    for (const bg of this.scene.bgs) {
      if (!(bg.display & PANE)) continue;
      const n = bg.colors.length;
      let runColor: string | null = null;
      let runStart = 0;
      let runEnd = 0;
      const flush = () => {
        if (runColor) {
          ctx.fillStyle = runColor;
          ctx.fillRect(runStart, 0, runEnd - runStart, H);
        }
      };
      for (let d = Math.max(0, v.from); d <= v.to; d++) {
        const i = d - bg.offset;
        const c = i >= 0 && i < n ? cssColor(bg.colors[i]) : null;
        const x = this.x(d);
        if (x == null) continue;
        const l = Math.round(x - half);
        const r = Math.round(x + half);
        if (c && c === runColor && Math.abs(l - runEnd) <= 1) {
          runEnd = r;
          continue;
        }
        flush();
        runColor = c;
        runStart = l;
        runEnd = r;
      }
      flush();
    }
  }

  private valueAt(p: PlotOut | HlineOut, d: number): number {
    if (p.kind === "hline") return p.price;
    const i = d - p.offset;
    return i >= 0 && i < p.values.length ? p.values[i] : NaN;
  }

  private paintFills(ctx: Ctx, v: { from: number; to: number }, W: number) {
    for (const f of this.scene.fills) {
      if (!(f.display & PANE)) continue;
      if (f.a.kind === "hline" && f.b.kind === "hline") {
        const c = cssColor(f.colors[f.colors.length - 1]);
        const y1 = this.y(f.a.price);
        const y2 = this.y(f.b.price);
        if (!c || y1 == null || y2 == null) continue;
        ctx.fillStyle = c;
        ctx.fillRect(0, Math.min(y1, y2), W, Math.abs(y2 - y1));
        continue;
      }
      const off = f.a.kind === "plot" ? f.a.offset : f.b.kind === "plot" ? f.b.offset : 0;
      let prev: { x: number; ya: number; yb: number } | null = null;
      for (let d = Math.max(0, v.from); d <= v.to; d++) {
        const a = this.valueAt(f.a, d);
        const b = this.valueAt(f.b, d);
        const x = this.x(d);
        const ya = this.y(a);
        const yb = this.y(b);
        if (x == null || ya == null || yb == null) {
          if (!f.fillgaps) prev = null;
          continue;
        }
        if (prev) {
          const i = d - off;
          let style: string | CanvasGradient | null = null;
          if (f.grad) {
            const yt = this.y(f.grad.top[i]);
            const yb2 = this.y(f.grad.bottom[i]);
            const ct = cssColor(f.grad.topColor[i]) ?? "rgba(0,0,0,0)";
            const cb = cssColor(f.grad.bottomColor[i]) ?? "rgba(0,0,0,0)";
            if (yt != null && yb2 != null && yt !== yb2) {
              const g = ctx.createLinearGradient(0, yt, 0, yb2);
              g.addColorStop(0, ct);
              g.addColorStop(1, cb);
              style = g;
            }
          } else style = i >= 0 && i < f.colors.length ? cssColor(f.colors[i]) : null;
          if (style) {
            ctx.fillStyle = style;
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.ya);
            ctx.lineTo(x, ya);
            ctx.lineTo(x, yb);
            ctx.lineTo(prev.x, prev.yb);
            ctx.closePath();
            ctx.fill();
          }
        }
        prev = { x, ya, yb };
      }
    }
  }

  private dash(ctx: Ctx, style: string, w: number) {
    ctx.setLineDash(style === "dotted" ? [w, w * 2] : style === "dashed" ? [w * 4, w * 3] : []);
  }

  private paintHline(ctx: Ctx, h: HlineOut, W: number) {
    if (!(h.display & PANE)) return;
    const y = this.y(h.price);
    const c = cssColor(h.color);
    if (y == null || !c) return;
    ctx.strokeStyle = c;
    ctx.lineWidth = h.width;
    this.dash(ctx, h.style, h.width);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(W, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private paintCandles(ctx: Ctx, c: CandleOut, v: { from: number; to: number; spacing: number }) {
    if (!(c.display & PANE)) return;
    const w = Math.max(1, v.spacing * 0.6);
    for (let i = Math.max(0, v.from); i <= Math.min(v.to, c.o.length - 1); i++) {
      const x = this.x(i);
      const yo = this.y(c.o[i]);
      const yh = this.y(c.h[i]);
      const yl = this.y(c.l[i]);
      const yc = this.y(c.c[i]);
      if (x == null || yo == null || yh == null || yl == null || yc == null) continue;
      const body = cssColor(c.colors[i]) ?? (c.c[i] >= c.o[i] ? "#26a69a" : "#ef5350");
      ctx.strokeStyle = cssColor(c.wicks[i]) ?? body;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, yh);
      ctx.lineTo(Math.round(x) + 0.5, yl);
      if (c.kind === "bar") {
        ctx.moveTo(x - w / 2, yo);
        ctx.lineTo(x, yo);
        ctx.moveTo(x, yc);
        ctx.lineTo(x + w / 2, yc);
      }
      ctx.stroke();
      if (c.kind === "candle") {
        ctx.fillStyle = body;
        ctx.fillRect(x - w / 2, Math.min(yo, yc), w, Math.max(1, Math.abs(yc - yo)));
        const border = cssColor(c.borders[i]);
        if (border && border !== body) {
          ctx.strokeStyle = border;
          ctx.strokeRect(x - w / 2, Math.min(yo, yc), w, Math.max(1, Math.abs(yc - yo)));
        }
      }
    }
  }

  /** The two ends of a line in pixels, extended to the pane's edges when asked. */
  private lineEnds(l: { x1: number; y1: number; x2: number; y2: number; xloc: string; extend: string }, W: number): [number, number, number, number] | null {
    const x1 = this.x(this.bx(l.x1, l.xloc));
    const x2 = this.x(this.bx(l.x2, l.xloc));
    const y1 = this.y(l.y1);
    const y2 = this.y(l.y2);
    if (x1 == null || x2 == null || y1 == null || y2 == null) return null;
    let a = [x1, y1];
    let b = [x2, y2];
    if (l.extend !== "none") {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const at = (x: number) => (dx === 0 ? null : [x, y1 + (dy * (x - x1)) / dx]);
      const left = x1 <= x2 ? a : b;
      const right = x1 <= x2 ? b : a;
      if (l.extend === "left" || l.extend === "both") {
        const p = dx === 0 ? [left[0], left === a ? (dy > 0 ? -1e4 : 1e4) : left[1]] : at(-10);
        if (p) left.splice(0, 2, p[0], p[1]);
      }
      if (l.extend === "right" || l.extend === "both") {
        const p = dx === 0 ? [right[0], dy > 0 ? 1e4 : -1e4] : at(W + 10);
        if (p) right.splice(0, 2, p[0], p[1]);
      }
      a = x1 <= x2 ? left : right;
      b = x1 <= x2 ? right : left;
    }
    return [a[0], a[1], b[0], b[1]];
  }

  private paintLine(ctx: Ctx, l: PLine, W: number) {
    const c = cssColor(l.color);
    const e = this.lineEnds(l, W);
    if (!c || !e) return;
    const [ax, ay, bx, by] = e;
    ctx.strokeStyle = c;
    ctx.lineWidth = l.width;
    this.dash(ctx, l.style, l.width);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.setLineDash([]);
    const head = (fx: number, fy: number, tx: number, ty: number) => {
      const ang = Math.atan2(ty - fy, tx - fx);
      const s = 6 + l.width * 2;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - s * Math.cos(ang - 0.4), ty - s * Math.sin(ang - 0.4));
      ctx.lineTo(tx - s * Math.cos(ang + 0.4), ty - s * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();
    };
    if (l.style === "arrow_right" || l.style === "arrow_both") head(ax, ay, bx, by);
    if (l.style === "arrow_left" || l.style === "arrow_both") head(bx, by, ax, ay);
  }

  private paintLinefill(ctx: Ctx, f: PLinefill, W: number) {
    const c = cssColor(f.color);
    const a = this.lineEnds(f.l1, W);
    const b = this.lineEnds(f.l2, W);
    if (!c || !a || !b) return;
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(a[2], a[3]);
    ctx.lineTo(b[2], b[3]);
    ctx.lineTo(b[0], b[1]);
    ctx.closePath();
    ctx.fill();
  }

  private paintBox(ctx: Ctx, b: PBox, W: number, back: boolean) {
    let x1 = this.x(this.bx(b.left, b.xloc));
    let x2 = this.x(this.bx(b.right, b.xloc));
    const y1 = this.y(b.top);
    const y2 = this.y(b.bottom);
    if (x1 == null || x2 == null || y1 == null || y2 == null) return;
    if (b.extend === "left" || b.extend === "both") x1 = -10;
    if (b.extend === "right" || b.extend === "both") x2 = W + 10;
    const l = Math.min(x1, x2);
    const t = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);
    if (back) {
      const bg = cssColor(b.bgcolor);
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(l, t, w, h);
      }
      return;
    }
    const bc = cssColor(b.border_color);
    if (bc && b.border_width > 0) {
      ctx.strokeStyle = bc;
      ctx.lineWidth = b.border_width;
      this.dash(ctx, b.border_style, b.border_width);
      ctx.strokeRect(l, t, w, h);
      ctx.setLineDash([]);
    }
    if (b.text) {
      const tc = cssColor(b.text_color);
      if (!tc) return;
      const size = b.text_size === "auto" ? Math.max(8, Math.min(14, h * 0.5)) : TEXT_PX[b.text_size] ?? 12;
      ctx.font = `${size}px ${FONT}`;
      ctx.fillStyle = tc;
      const lines = b.text_wrap === "auto" ? wrap(ctx, b.text, w - 6) : b.text.split("\n");
      const lh = size * 1.25;
      const total = lines.length * lh;
      let y0 = b.text_valign === "top" ? t + 3 : b.text_valign === "bottom" ? t + h - total - 3 : t + (h - total) / 2;
      ctx.textBaseline = "top";
      ctx.textAlign = b.text_halign === "left" ? "left" : b.text_halign === "right" ? "right" : "center";
      const tx = b.text_halign === "left" ? l + 4 : b.text_halign === "right" ? l + w - 4 : l + w / 2;
      for (const line of lines) {
        ctx.fillText(line, tx, y0);
        y0 += lh;
      }
    }
  }

  private paintPolyline(ctx: Ctx, p: PPolyline, back: boolean) {
    const pts: [number, number][] = [];
    for (const q of p.pts) {
      const x = this.x(this.bx(q.x, p.xloc));
      const y = this.y(q.y);
      if (x != null && y != null) pts.push([x, y]);
    }
    if (pts.length < 2) return;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      if (p.curved && pts.length > 2) {
        for (let k = 1; k < pts.length - 1; k++) {
          const mx = (pts[k][0] + pts[k + 1][0]) / 2;
          const my = (pts[k][1] + pts[k + 1][1]) / 2;
          ctx.quadraticCurveTo(pts[k][0], pts[k][1], mx, my);
        }
        ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      } else for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
      if (p.closed) ctx.closePath();
    };
    if (back) {
      const fc = cssColor(p.fill_color);
      if (!fc) return;
      path();
      ctx.fillStyle = fc;
      ctx.fill();
      return;
    }
    const lc = cssColor(p.line_color);
    if (!lc) return;
    path();
    ctx.strokeStyle = lc;
    ctx.lineWidth = p.line_width;
    this.dash(ctx, p.line_style, p.line_width);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Where shapes and labels sit on a bar: above its high / below its low (in the price pane), else the pane's edge. */
  private barY(d: number, above: boolean, H: number): number {
    if (this.scene.onPrice) {
      const bars = this.host.bars();
      const b = bars[Math.max(0, Math.min(bars.length - 1, Math.round(d)))];
      const y = b ? this.y(above ? b.high : b.low) : null;
      if (y != null) return y;
    }
    return above ? 0 : H;
  }

  private paintShapes(ctx: Ctx, s: ShapeOut, v: { from: number; to: number; spacing: number }, H: number) {
    if (!(s.display & PANE)) return;
    const size = SHAPE_PX[s.size] ?? 10;
    const gap = 4;
    for (let d = Math.max(0, v.from); d <= v.to; d++) {
      const i = d - s.offset;
      if (i < 0 || i >= s.on.length || !s.on[i]) continue;
      const x = this.x(d);
      if (x == null) continue;
      const c = cssColor(s.colors[i]);
      let y: number;
      let up = true; // text goes above the shape
      switch (s.location) {
        case "belowbar":
          y = this.barY(d, false, H) + gap + size / 2;
          up = false;
          break;
        case "top":
          y = gap + size / 2;
          up = false;
          break;
        case "bottom":
          y = H - gap - size / 2;
          break;
        case "absolute": {
          const yy = this.y(s.y[i]);
          if (yy == null) continue;
          y = yy;
          break;
        }
        default:
          y = this.barY(d, true, H) - gap - size / 2;
      }
      if (c) {
        if (s.shape === "char") {
          ctx.font = `${Math.round(size * 1.2)}px ${FONT}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = c;
          ctx.fillText(s.char, x, y);
        } else drawShape(ctx, s.shape, x, y, size, c, s.text);
      }
      if (s.text && !(s.shape === "labelup" || s.shape === "labeldown")) {
        const tc = cssColor(s.textcolors[i]);
        if (!tc) continue;
        ctx.font = `${TEXT_PX.small}px ${FONT}`;
        ctx.textAlign = "center";
        ctx.fillStyle = tc;
        const lines = s.text.split("\n");
        const lh = TEXT_PX.small * 1.2;
        ctx.textBaseline = up ? "bottom" : "top";
        lines.forEach((t, k) => {
          const yy = up ? y - size / 2 - 2 - (lines.length - 1 - k) * lh : y + size / 2 + 2 + k * lh;
          ctx.fillText(t, x, yy);
        });
      } else if (s.text && c) {
        const tc = cssColor(s.textcolors[i]) ?? "#fff";
        labelBox(ctx, s.text, x, y + (s.shape === "labelup" ? -size / 2 : size / 2), s.shape === "labelup" ? "label_up" : "label_down", c, tc, TEXT_PX.small, "center");
      }
    }
  }

  private paintArrows(ctx: Ctx, a: ArrowOut, v: { from: number; to: number; spacing: number }) {
    if (!(a.display & PANE)) return;
    let maxAbs = 0;
    for (let d = Math.max(0, v.from); d <= v.to; d++) {
      const i = d - a.offset;
      if (i >= 0 && i < a.values.length && a.values[i] === a.values[i]) maxAbs = Math.max(maxAbs, Math.abs(a.values[i]));
    }
    if (!maxAbs) return;
    const w = Math.max(4, Math.min(12, v.spacing * 0.7));
    for (let d = Math.max(0, v.from); d <= v.to; d++) {
      const i = d - a.offset;
      const val = i >= 0 && i < a.values.length ? a.values[i] : NaN;
      if (!(val === val) || val === 0) continue;
      const x = this.x(d);
      if (x == null) continue;
      const up = val > 0;
      const c = cssColor(up ? a.up[i] : a.down[i]);
      if (!c) continue;
      const len = a.minh + ((a.maxh - a.minh) * Math.abs(val)) / maxAbs;
      const y0 = this.barY(d, !up, 0) + (up ? 4 : -4);
      const tip = up ? y0 : y0;
      const tail = up ? y0 + len : y0 - len;
      ctx.strokeStyle = c;
      ctx.fillStyle = c;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, tail);
      ctx.lineTo(x, tip + (up ? w : -w));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, tip);
      ctx.lineTo(x - w / 2, tip + (up ? w : -w));
      ctx.lineTo(x + w / 2, tip + (up ? w : -w));
      ctx.closePath();
      ctx.fill();
    }
  }

  private paintLabel(ctx: Ctx, l: PLabel) {
    const d = this.bx(l.x, l.xloc);
    const x = this.x(d);
    if (x == null) return;
    let y: number | null;
    if (l.yloc === "abovebar") y = this.barY(d, true, 0) - 2;
    else if (l.yloc === "belowbar") y = this.barY(d, false, 0) + 2;
    else y = this.y(l.y);
    if (y == null) return;
    const bg = cssColor(l.color);
    const tc = cssColor(l.textcolor);
    const size = TEXT_PX[l.size] ?? 13;
    const box = l.style.startsWith("label_") || l.style === "none" || l.style === "text_outline";
    if (box) {
      labelBox(ctx, l.text, x, y, l.style, bg, tc, size, l.textalign);
      return;
    }
    const shapeSize = SHAPE_PX[l.size] ?? 10;
    const below = l.style === "triangleup" || l.style === "arrowup";
    if (bg) drawShape(ctx, l.style === "label_up" ? "labelup" : l.style, x, y, shapeSize, bg, "");
    if (l.text && tc) {
      ctx.font = `${size}px ${FONT}`;
      ctx.fillStyle = tc;
      ctx.textAlign = "center";
      const lines = l.text.split("\n");
      const lh = size * 1.2;
      ctx.textBaseline = below ? "top" : "bottom";
      lines.forEach((t, k) => {
        const yy = below ? y! + shapeSize / 2 + 3 + k * lh : y! - shapeSize / 2 - 3 - (lines.length - 1 - k) * lh;
        ctx.fillText(t, x, yy);
      });
    }
  }

  private paintTrades(ctx: Ctx, v: { from: number; to: number; spacing: number }) {
    const trades = this.scene.trades;
    if (!trades.length) return;
    const size = 6;
    // several fills on one bar stack away from it
    const stack = new Map<string, number>();
    ctx.font = `10px ${FONT}`;
    ctx.textAlign = "center";
    for (const f of trades) {
      if (f.bar < v.from || f.bar > v.to) continue;
      const x = this.x(f.bar);
      if (x == null) continue;
      const buy = f.dir === 1;
      const key = `${f.bar}|${buy}`;
      const k = stack.get(key) ?? 0;
      stack.set(key, k + 1);
      const c = buy ? BUY : SELL;
      const base = this.barY(f.bar, !buy, 0) + (buy ? 6 : -6) + (buy ? 1 : -1) * k * 28;
      ctx.fillStyle = c;
      ctx.beginPath();
      if (buy) {
        ctx.moveTo(x, base);
        ctx.lineTo(x - size, base + size + 2);
        ctx.lineTo(x + size, base + size + 2);
      } else {
        ctx.moveTo(x, base);
        ctx.lineTo(x - size, base - size - 2);
        ctx.lineTo(x + size, base - size - 2);
      }
      ctx.closePath();
      ctx.fill();
      const text = `${f.id || (f.entry ? "Entry" : "Exit")} ${buy ? "+" : "−"}${this.scene.fmtQty(f.qty)}`;
      ctx.textBaseline = buy ? "top" : "bottom";
      const ty = buy ? base + size + 4 : base - size - 4;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(19,23,34,0.85)";
      ctx.strokeText(text, x, ty);
      ctx.fillText(text, x, ty);
    }
  }

  private paintTable(ctx: Ctx, t: PTable, W: number, H: number) {
    if (t.columns <= 0 || t.rows <= 0) return;
    const covered = new Set<string>();
    const spans = new Map<string, [number, number]>();
    for (const [c0, r0, c1, r1] of t.merges) {
      spans.set(`${c0},${r0}`, [c1 - c0 + 1, r1 - r0 + 1]);
      for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) if (c !== c0 || r !== r0) covered.add(`${c},${r}`);
    }
    const pad = 4;
    const colW = new Array(t.columns).fill(0);
    const rowH = new Array(t.rows).fill(0);
    const fontOf = (size: string) => TEXT_PX[size] ?? 13;
    for (const [key, cell] of t.cells) {
      if (covered.has(key) || spans.has(key)) continue;
      const [c, r] = key.split(",").map(Number);
      const size = fontOf(cell.text_size);
      ctx.font = `${size}px ${FONT}`;
      const lines = cell.text.split("\n");
      const tw = Math.max(0, ...lines.map((x) => ctx.measureText(x).width));
      const w = cell.width > 0 ? (cell.width / 100) * W : tw + pad * 2;
      const h = cell.height > 0 ? (cell.height / 100) * H : lines.length * size * 1.25 + pad * 2;
      colW[c] = Math.max(colW[c], w);
      rowH[r] = Math.max(rowH[r], h);
    }
    for (let c = 0; c < t.columns; c++) if (!colW[c]) colW[c] = 0;
    for (let r = 0; r < t.rows; r++) if (!rowH[r]) rowH[r] = 0;
    const tw = colW.reduce((s, x) => s + x, 0);
    const th = rowH.reduce((s, x) => s + x, 0);
    if (!tw || !th) return;
    const m = 8;
    const [vpos, hpos] = t.position.split("_");
    const x0 = hpos === "left" ? m : hpos === "center" ? (W - tw) / 2 : W - tw - m;
    const y0 = vpos === "top" ? m : vpos === "middle" ? (H - th) / 2 : H - th - m;
    const bg = cssColor(t.bgcolor);
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(x0, y0, tw, th);
    }
    const colX = [x0];
    for (let c = 0; c < t.columns; c++) colX.push(colX[c] + colW[c]);
    const rowY = [y0];
    for (let r = 0; r < t.rows; r++) rowY.push(rowY[r] + rowH[r]);
    const border = cssColor(t.border_color);
    for (const [key, cell] of t.cells) {
      if (covered.has(key)) continue;
      const [c, r] = key.split(",").map(Number);
      const [sc, sr] = spans.get(key) ?? [1, 1];
      const cx = colX[c];
      const cy = rowY[r];
      const cw = colX[Math.min(t.columns, c + sc)] - cx;
      const ch = rowY[Math.min(t.rows, r + sr)] - cy;
      const cbg = cssColor(cell.bgcolor);
      if (cbg) {
        ctx.fillStyle = cbg;
        ctx.fillRect(cx, cy, cw, ch);
      }
      if (border && t.border_width > 0) {
        ctx.strokeStyle = border;
        ctx.lineWidth = t.border_width;
        ctx.strokeRect(cx, cy, cw, ch);
      }
      const tc = cssColor(cell.text_color);
      if (!cell.text || !tc) continue;
      const size = fontOf(cell.text_size);
      ctx.font = `${size}px ${FONT}`;
      ctx.fillStyle = tc;
      ctx.textAlign = cell.text_halign === "left" ? "left" : cell.text_halign === "right" ? "right" : "center";
      ctx.textBaseline = "middle";
      const tx = cell.text_halign === "left" ? cx + pad : cell.text_halign === "right" ? cx + cw - pad : cx + cw / 2;
      const lines = cell.text.split("\n");
      const lh = size * 1.25;
      const total = lines.length * lh;
      const ty0 = cell.text_valign === "top" ? cy + pad + lh / 2 : cell.text_valign === "bottom" ? cy + ch - pad - total + lh / 2 : cy + (ch - total) / 2 + lh / 2;
      lines.forEach((line, k) => ctx.fillText(line, tx, ty0 + k * lh));
    }
    const frame = cssColor(t.frame_color);
    if (frame && t.frame_width > 0) {
      ctx.strokeStyle = frame;
      ctx.lineWidth = t.frame_width;
      ctx.strokeRect(x0, y0, tw, th);
    }
  }
}

/** Text broken into lines that fit `width` pixels. */
function wrap(ctx: Ctx, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const ch of para.split(/(\s+)/)) {
      const next = line + ch;
      if (line && ctx.measureText(next).width > width) {
        out.push(line.trimEnd());
        line = ch.trimStart();
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** A label: text in a colored box, with a pointer at (x, y) on the side its style names. */
function labelBox(ctx: Ctx, text: string, x: number, y: number, style: string, bg: string | null, fg: string | null, size: number, align: string) {
  ctx.font = `${size}px ${FONT}`;
  const lines = text.split("\n");
  const lh = size * 1.25;
  const pad = 4;
  const tw = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
  const w = tw + pad * 2;
  const h = lines.length * lh + pad * 2 - (lh - size);
  const ptr = 5;
  let bx = x - w / 2;
  let by = y - h / 2;
  switch (style) {
    case "label_down":
      by = y - ptr - h;
      break;
    case "label_up":
      by = y + ptr;
      break;
    case "label_left":
      bx = x + ptr;
      break;
    case "label_right":
      bx = x - ptr - w;
      break;
    case "label_lower_left":
      bx = x + ptr;
      by = y - ptr - h;
      break;
    case "label_lower_right":
      bx = x - ptr - w;
      by = y - ptr - h;
      break;
    case "label_upper_left":
      bx = x + ptr;
      by = y + ptr;
      break;
    case "label_upper_right":
      bx = x - ptr - w;
      by = y + ptr;
      break;
  }
  const boxed = style.startsWith("label_");
  if (boxed && bg && text) {
    ctx.fillStyle = bg;
    ctx.beginPath();
    roundRect(ctx, bx, by, w, h, 3);
    ctx.fill();
    ctx.beginPath();
    if (style === "label_down") {
      ctx.moveTo(x - ptr, by + h);
      ctx.lineTo(x, y);
      ctx.lineTo(x + ptr, by + h);
    } else if (style === "label_up") {
      ctx.moveTo(x - ptr, by);
      ctx.lineTo(x, y);
      ctx.lineTo(x + ptr, by);
    } else if (style === "label_left") {
      ctx.moveTo(bx, y - ptr);
      ctx.lineTo(x, y);
      ctx.lineTo(bx, y + ptr);
    } else if (style === "label_right") {
      ctx.moveTo(bx + w, y - ptr);
      ctx.lineTo(x, y);
      ctx.lineTo(bx + w, y + ptr);
    }
    ctx.closePath();
    ctx.fill();
  } else if (boxed && bg && !text) {
    // an empty label is just its pointer mark
    drawShape(ctx, style === "label_up" ? "triangleup" : "triangledown", x, style === "label_up" ? y + 5 : y - 5, 8, bg, "");
  }
  if (!fg || !text) return;
  ctx.fillStyle = fg;
  ctx.textBaseline = "top";
  ctx.textAlign = align === "left" ? "left" : align === "right" ? "right" : "center";
  const tx = align === "left" ? bx + pad : align === "right" ? bx + w - pad : bx + w / 2;
  if (style === "text_outline") {
    ctx.lineWidth = 3;
    ctx.strokeStyle = bg ?? "rgba(0,0,0,0.6)";
    lines.forEach((l, k) => ctx.strokeText(l, tx, by + pad + k * lh));
  }
  lines.forEach((l, k) => ctx.fillText(l, tx, by + pad + k * lh));
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

/** shape.* (and label shapes) of `size` pixels centered at (x, y). */
function drawShape(ctx: Ctx, shape: string, x: number, y: number, size: number, color: string, text: string) {
  const s = size / 2;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, size / 7);
  ctx.beginPath();
  switch (shape) {
    case "triangleup":
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y + s);
      ctx.lineTo(x - s, y + s);
      ctx.closePath();
      ctx.fill();
      return;
    case "triangledown":
      ctx.moveTo(x, y + s);
      ctx.lineTo(x + s, y - s);
      ctx.lineTo(x - s, y - s);
      ctx.closePath();
      ctx.fill();
      return;
    case "arrowup":
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x + s / 2.5, y);
      ctx.lineTo(x + s / 2.5, y + s);
      ctx.lineTo(x - s / 2.5, y + s);
      ctx.lineTo(x - s / 2.5, y);
      ctx.lineTo(x - s, y);
      ctx.closePath();
      ctx.fill();
      return;
    case "arrowdown":
      ctx.moveTo(x, y + s);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x + s / 2.5, y);
      ctx.lineTo(x + s / 2.5, y - s);
      ctx.lineTo(x - s / 2.5, y - s);
      ctx.lineTo(x - s / 2.5, y);
      ctx.lineTo(x - s, y);
      ctx.closePath();
      ctx.fill();
      return;
    case "circle":
      ctx.arc(x, y, s, 0, Math.PI * 2);
      ctx.fill();
      return;
    case "square":
      ctx.fillRect(x - s, y - s, size, size);
      return;
    case "diamond":
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x, y + s);
      ctx.lineTo(x - s, y);
      ctx.closePath();
      ctx.fill();
      return;
    case "cross":
      ctx.moveTo(x - s, y);
      ctx.lineTo(x + s, y);
      ctx.moveTo(x, y - s);
      ctx.lineTo(x, y + s);
      ctx.stroke();
      return;
    case "flag":
      ctx.moveTo(x - s * 0.6, y + s);
      ctx.lineTo(x - s * 0.6, y - s);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - s * 0.6, y - s);
      ctx.lineTo(x + s, y - s * 0.5);
      ctx.lineTo(x - s * 0.6, y);
      ctx.closePath();
      ctx.fill();
      return;
    case "labelup":
    case "labeldown":
      if (text) return; // drawn with its text by labelBox
      drawShape(ctx, shape === "labelup" ? "triangleup" : "triangledown", x, y, size, color, "");
      return;
    default:
      // xcross
      ctx.moveTo(x - s, y - s);
      ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y - s);
      ctx.lineTo(x - s, y + s);
      ctx.stroke();
  }
}
