// Drawing tools on the price pane: Fibonacci retracement; lines (trend line, ray, info line, extended line,
// trend angle, horizontal line, horizontal ray, vertical line, cross line); rectangles.
//
// Drawing: a lightweight-charts series primitive attached to the candle series. Rectangle and Fib fills go
// under the candles, lines and labels over them; horizontal lines show their price on the price scale and
// vertical lines their time on the time scale (a selected drawing shows all its points there).
// Mouse: listeners on the chart element in the capture phase, so a press on a drawing (or while placing one)
// never reaches the chart and never starts a pan. Points are stored as (bar start time, price), so drawings
// stay put across timeframes, history loading and restarts.

import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitiveAxisView,
  IPrimitivePaneView,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import type { Candle } from "./api";
import { xOfLogical } from "./coords";
import { chainPositions, fmtMoney, fmtQty, type PositionResult } from "./trade";
import {
  clampTarget,
  distToLine,
  distToRay,
  distToSegment,
  positionDir,
  rewardRisk,
  rLevels,
  fibPrice,
  fmtLevel,
  fmtSpan,
  hexToRgba,
  indexToTime,
  screenAngle,
  timeToIndex,
  type Anchor,
} from "./fibmath";
import {
  clone,
  magnetKeyLabel,
  newId,
  TOOL_INFO,
  type Dash,
  type DrawKind,
  type Drawing,
  type FibSettings,
  type LineStyle,
  type MagnetSettings,
  type PositionDrawing,
  type PositionSettings,
  type RectStyle,
} from "./settings";

export type Tool = "cursor" | DrawKind;

export type DrawingHost = {
  chart: IChartApi;
  series: ISeriesApi<"Candlestick">;
  /** The chart element: mouse events and cursor classes. */
  el: HTMLElement;
  /** Start times (UTC seconds, ascending) of the loaded bars. */
  times(): number[];
  /** The loaded bars themselves (positions are settled on them). */
  bars(): Candle[];
  /** The coin of the symbol, e.g. BTC. */
  base(): string;
  barSec(): number;
  /** [open, high, low, close] of the bar at a logical index, for the magnet. */
  ohlcAt(i: number): number[] | null;
  fmtPrice(p: number): string;
  /** A bar time (UTC seconds) as the time axis shows it. */
  fmtTime(t: number): string;
  fib(): FibSettings;
  magnet(): MagnetSettings;
  position(): PositionSettings;
  /** The style a new drawing of this kind starts with. */
  styleFor(kind: Exclude<DrawKind, "fib" | "position">): LineStyle | RectStyle;
  /** The list changed (added, moved, restyled, deleted): save it. */
  changed(list: Drawing[]): void;
  toolChanged(tool: Tool): void;
  /** The magnet is in effect right now (always on, or the hold key is down). */
  magnetActive(active: boolean): void;
  /** Double-click or right-click on a drawing, at screen point (x, y). */
  openSettings(d: Drawing, x: number, y: number): void;
  /** Status bar hint; null restores the default. */
  hint(text: string | null): void;
};

type Part = "a" | "b" | "c2" | "c3" | "stop" | "target" | "edge" | "body";
type Handle = { x: number; y: number; part: Part };
type LevelGeo = { y: number; color: string; label: string };
type Geo = {
  d: Drawing;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  handles: Handle[];
  active: boolean;
  fib?: { xl: number; xr: number; levels: LevelGeo[] };
  pos?: {
    x0: number; x1: number; entryY: number; stopY: number; targetY: number;
    levels: { k: number; price: number; y: number }[];
    /** Where it was closed (take-profit, stop or the end of the box). */
    exit: { x: number; y: number } | null;
  };
};
type Hit = { id: string; part: Part };
type Drag = Hit & { x0: number; y0: number; start: Anchor | null; orig: { a: Anchor; b: Anchor }; moved: boolean };
type Mouse = { x: number; y: number; inside: boolean };
type AxisLabel = { pos: number; text: string; color: string };

const HANDLE_R = 7; // px: grab distance for the end points
const SNAP_PX = 30; // px: the magnet only pulls a point this close to an open/high/low/close
const LINE_HIT = 5; // px: grab distance for lines
const FONT = "11px -apple-system, 'Segoe UI', 'Microsoft JhengHei', sans-serif";
const ACCENT = "#2962ff";
const FAR = 100000; // px: endless lines are drawn this far out and the canvas clips them

function isTyping(el: Element | null): boolean {
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el as HTMLElement).isContentEditable);
}

function dashOf(dash: Dash, width: number, hr: number): number[] {
  if (dash === "dash") return [Math.round(6 * hr), Math.round(4 * hr)];
  if (dash === "dot") return [Math.max(1, Math.round(width * hr)), Math.round(3 * hr)];
  return [];
}

const SHORTCUTS: Record<string, DrawKind> = {
  KeyF: "fib", KeyT: "trend", KeyH: "hline", KeyJ: "hray", KeyV: "vline", KeyC: "cross", KeyP: "position",
};
const MIN_BOX_BARS = 5; // a position box is at least this many bars wide
const NEW_BOX_BARS = 20; // and this wide when placed without dragging to the right

export class DrawingLayer implements ISeriesPrimitive<Time> {
  private list: Drawing[] = [];
  private draft: Drawing | null = null;
  private placing: { x0: number; y0: number; pressed: boolean } | null = null;
  /** Placing a position: 1 = the stop follows the mouse, 2 = the take-profit does. */
  private stage: 1 | 2 = 1;
  private selected: string | null = null;
  private hovered: string | null = null;
  private tool: Tool = "cursor";
  private drag: Drag | null = null;
  private geo: Geo[] = [];
  private mouse: Mouse | null = null;
  private holdDown = false;
  private requestUpdate: (() => void) | null = null;
  private priceLabels: ISeriesPrimitiveAxisView[] = [];
  /** Size and outcome of every position (see trade.ts), recomputed with each redraw. */
  private trades = new Map<string, PositionResult>();
  private timeLabels: ISeriesPrimitiveAxisView[] = [];

  private readonly views: IPrimitivePaneView[] = [
    { zOrder: () => "bottom", renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => this.drawUnder(t) }) },
    { zOrder: () => "normal", renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => this.drawOver(t) }) },
  ];

  constructor(private readonly host: DrawingHost) {
    host.el.addEventListener("mousedown", (e) => this.onDown(e), true);
    host.el.addEventListener("dblclick", (e) => this.onDblClick(e), true);
    host.el.addEventListener("contextmenu", (e) => this.onContext(e), true);
    window.addEventListener("mousemove", (e) => this.onMove(e), true);
    window.addEventListener("mouseup", (e) => this.onUp(e), true);
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
    window.addEventListener("blur", () => this.setHold(false));
  }

  // ------------------------------------------------------------------- primitive interface
  attached(p: SeriesAttachedParameter<Time>) {
    this.requestUpdate = p.requestUpdate;
  }
  detached() {
    this.requestUpdate = null;
  }
  paneViews() {
    return this.views;
  }
  priceAxisViews() {
    return this.priceLabels;
  }
  timeAxisViews() {
    return this.timeLabels;
  }
  updateAllViews() {
    this.trades = this.computeTrades();
    this.geo = this.computeGeo();
    this.buildAxisLabels();
  }

  /** Size and outcome of one position, as last drawn (for the settings window). */
  tradeOf(id: string): PositionResult | undefined {
    return this.trades.get(id);
  }

  private computeTrades(): Map<string, PositionResult> {
    const ps = this.host.position();
    const items = this.draft ? [...this.list, this.draft] : this.list;
    const inputs = [];
    for (const d of items) {
      if (d.kind !== "position") continue;
      inputs.push({
        id: d.id, entryT: d.a.t, endT: d.b.t, entry: d.a.p, stop: d.b.p, target: d.target,
        capital: d.capital, risk: d.risk, riskMode: d.riskMode, leverage: d.leverage,
      });
    }
    return chainPositions(inputs, this.host.bars(), this.host.barSec(), ps.capital, ps.chain);
  }

  // ------------------------------------------------------------------- public
  getTool(): Tool {
    return this.tool;
  }
  setTool(t: Tool) {
    this.tool = t;
    this.draft = null;
    this.placing = null;
    if (t !== "cursor") this.selected = null;
    this.host.el.classList.toggle("drawing", t !== "cursor");
    this.host.el.classList.remove("over-drawing");
    this.host.toolChanged(t);
    this.refreshHint();
    this.redraw();
  }
  /** Show another symbol's drawings (does not save). */
  setDrawings(list: Drawing[]) {
    this.list = list;
    this.draft = null;
    this.placing = null;
    this.drag = null;
    this.selected = null;
    this.hovered = null;
    this.refreshHint();
    this.redraw();
  }
  count(): number {
    return this.list.length;
  }
  find(id: string): Drawing | undefined {
    return this.list.find((d) => d.id === id);
  }
  clearAll() {
    this.list = [];
    this.selected = null;
    this.hovered = null;
    this.host.changed(this.list);
    this.refreshHint();
    this.redraw();
  }
  remove(id: string) {
    this.list = this.list.filter((d) => d.id !== id);
    if (this.selected === id) this.selected = null;
    if (this.hovered === id) this.hovered = null;
    this.host.el.classList.remove("over-drawing");
    this.host.changed(this.list);
    this.refreshHint();
    this.redraw();
  }
  /** New style for a line or rectangle; saved at once. */
  setStyle(id: string, style: LineStyle | RectStyle) {
    const d = this.find(id);
    if (!d || d.kind === "fib" || d.kind === "position") return;
    (d as { style: LineStyle | RectStyle }).style = style;
    this.host.changed(this.list);
    this.redraw();
  }
  /** Capital, risk or leverage of one position changed; saved at once. */
  updatePosition(id: string, p: Partial<Pick<PositionDrawing, "capital" | "risk" | "riskMode" | "leverage">>) {
    const d = this.find(id);
    if (!d || d.kind !== "position") return;
    Object.assign(d, p);
    this.host.changed(this.list);
    this.redraw();
  }
  /** Settings changed (Fib levels, magnet key): redraw and refresh the hint. */
  refresh() {
    this.refreshHint();
    this.host.magnetActive(this.host.magnet().on || this.holdDown);
    this.redraw();
  }
  redraw() {
    this.requestUpdate?.();
  }

  // ------------------------------------------------------------------- geometry
  private xOf(i: number): number | null {
    return xOfLogical(this.host.chart, i);
  }

  private computeGeo(): Geo[] {
    const times = this.host.times();
    if (!times.length) return [];
    const { series, chart } = this.host;
    const bs = this.host.barSec();
    const width = chart.timeScale().width();
    const height = chart.panes()[0]?.getHeight() ?? 0;
    const fibOpts = this.host.fib();
    const fibLevels = fibOpts.levels.filter((l) => l.on);
    const items = this.draft ? [...this.list, this.draft] : this.list;
    const out: Geo[] = [];
    for (const d of items) {
      const ax = this.xOf(timeToIndex(times, d.a.t, bs));
      const bx = this.xOf(timeToIndex(times, d.b.t, bs));
      const ay = series.priceToCoordinate(d.a.p);
      const by = series.priceToCoordinate(d.b.p);
      if (ax == null || bx == null || ay == null || by == null) continue;
      const active = d === this.draft || d.id === this.selected || d.id === this.hovered;
      const g: Geo = { d, ax, ay, bx, by, handles: [], active };
      const A: Handle = { x: ax, y: ay, part: "a" };
      const B: Handle = { x: bx, y: by, part: "b" };
      switch (d.kind) {
        case "fib": {
          const levels: LevelGeo[] = [];
          for (const l of fibLevels) {
            const price = fibPrice(d.a, d.b, l.value, fibOpts.reverse);
            const y = series.priceToCoordinate(price);
            if (y == null) continue;
            const label = fibOpts.showPrice ? `${fmtLevel(l.value)} (${this.host.fmtPrice(price)})` : fmtLevel(l.value);
            levels.push({ y, color: l.color, label });
          }
          g.fib = { xl: Math.min(ax, bx), xr: fibOpts.extend ? Math.max(width, ax, bx) : Math.max(ax, bx), levels };
          g.handles = [A, B];
          break;
        }
        case "rect":
          g.handles = [A, B, { x: ax, y: by, part: "c2" }, { x: bx, y: ay, part: "c3" }];
          break;
        case "position": {
          const targetY = series.priceToCoordinate(d.target);
          if (targetY == null) continue;
          const levels = rLevels(d.a.p, d.b.p, d.target, this.host.position().levels.filter((l) => l.on).map((l) => l.value))
            .map((l) => ({ ...l, y: series.priceToCoordinate(l.price) as number }))
            .filter((l) => l.y != null);
          const x1 = Math.max(bx, ax + 10);
          const t = this.trades.get(d.id);
          let exit: { x: number; y: number } | null = null;
          if (t && t.outcome.exit != null && t.outcome.exitT != null) {
            const ex = this.xOf(timeToIndex(times, t.outcome.exitT, bs));
            const ey = series.priceToCoordinate(t.outcome.exit);
            if (ex != null && ey != null) exit = { x: ex, y: ey };
          }
          g.pos = { x0: ax, x1, entryY: ay, stopY: by, targetY, levels, exit };
          g.handles = [
            { x: ax, y: ay, part: "a" },
            { x: ax, y: by, part: "stop" },
            { x: ax, y: targetY, part: "target" },
            { x: x1, y: ay, part: "edge" },
          ];
          break;
        }
        case "hline":
          g.handles = [{ x: ax >= 0 && ax <= width ? ax : width / 2, y: ay, part: "a" }];
          break;
        case "vline":
          g.handles = [{ x: ax, y: ay >= 0 && ay <= height ? ay : height / 2, part: "a" }];
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

  /** Prices of horizontal lines on the price scale, times of vertical lines on the time scale; all the points
   *  of the selected drawing (or the one being placed). */
  private buildAxisLabels() {
    const price: AxisLabel[] = [];
    const time: AxisLabel[] = [];
    const fp = (p: number) => this.host.fmtPrice(p);
    const ft = (t: number) => this.host.fmtTime(t);
    for (const g of this.geo) {
      const d = g.d;
      if (d.kind !== "fib" && d.kind !== "rect") {
        if (d.kind === "hline" || d.kind === "hray" || d.kind === "cross") price.push({ pos: g.ay, text: fp(d.a.p), color: d.style.color });
        if (d.kind === "vline" || d.kind === "cross") time.push({ pos: g.ax, text: ft(d.a.t), color: d.style.color });
      }
      if (d.id !== this.selected && d !== this.draft) continue;
      if (d.kind === "position") {
        const ps = this.host.position();
        price.push(
          { pos: g.ay, text: fp(d.a.p), color: "#787b86" },
          { pos: g.by, text: fp(d.b.p), color: ps.loss },
          { pos: g.pos?.targetY ?? g.ay, text: fp(d.target), color: ps.profit },
        );
        time.push({ pos: g.ax, text: ft(d.a.t), color: ACCENT });
      } else if (TOOL_INFO[d.kind].points === 2) {
        price.push({ pos: g.ay, text: fp(d.a.p), color: ACCENT }, { pos: g.by, text: fp(d.b.p), color: ACCENT });
        time.push({ pos: g.ax, text: ft(d.a.t), color: ACCENT }, { pos: g.bx, text: ft(d.b.t), color: ACCENT });
      } else if (d.kind === "hray") {
        time.push({ pos: g.ax, text: ft(d.a.t), color: ACCENT });
      }
    }
    const view = (l: AxisLabel): ISeriesPrimitiveAxisView => ({
      coordinate: () => l.pos,
      text: () => l.text,
      textColor: () => "#ffffff",
      backColor: () => l.color,
    });
    this.priceLabels = price.map(view);
    this.timeLabels = time.map(view);
  }

  // ------------------------------------------------------------------- painting
  /** Fills under the candles: Fib bands and rectangles. */
  private drawUnder(target: CanvasRenderingTarget2D) {
    const fibFill = this.host.fib().fill;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr, bitmapSize }) => {
      for (const g of this.geo) {
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
          const ps = this.host.position();
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
  private drawOver(target: CanvasRenderingTarget2D) {
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
      for (const g of this.geo) {
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
            this.paintFibLines(ctx, g, hr, vr);
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
            const ps = this.host.position();
            const x0 = g.pos.x0 * hr;
            const x1 = g.pos.x1 * hr;
            const lw = Math.max(1, Math.round(hr));
            const hl = (y: number, color: string, dash: Dash) => path([[x0, crisp(y * vr, lw)], [x1, crisp(y * vr, lw)]], { color, width: 1, dash });
            for (const l of g.pos.levels) hl(l.y, hexToRgba(ps.profit, 0.9), "dash");
            hl(g.pos.targetY, ps.profit, "solid");
            hl(g.pos.stopY, ps.loss, "solid");
            hl(g.pos.entryY, "#b2b5be", "solid");
            const t = this.trades.get(d.id);
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
      for (const g of this.geo) {
        if (g.d.kind === "fib") this.paintFibLabels(ctx, g, mediaSize.height);
        else if (g.d.kind === "info") this.paintInfo(ctx, g, mediaSize.width, mediaSize.height);
        else if (g.d.kind === "angle") this.paintAngle(ctx, g);
        else if (g.d.kind === "position") this.paintPosition(ctx, g);
      }
    });
  }

  private paintFibLines(ctx: CanvasRenderingContext2D, g: Geo, hr: number, vr: number) {
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

  private paintFibLabels(ctx: CanvasRenderingContext2D, g: Geo, height: number) {
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
  private paintInfo(ctx: CanvasRenderingContext2D, g: Geo, width: number, height: number) {
    const d = g.d;
    if (d.kind !== "info") return;
    const times = this.host.times();
    const bs = this.host.barSec();
    const dp = d.b.p - d.a.p;
    const sign = dp >= 0 ? "+" : "−";
    const pct = d.a.p ? (Math.abs(dp) / d.a.p) * 100 : 0;
    const bars = Math.abs(Math.round(timeToIndex(times, d.b.t, bs) - timeToIndex(times, d.a.t, bs)));
    const lines = [`${sign}${this.host.fmtPrice(Math.abs(dp))} (${sign}${pct.toFixed(2)}%)`, `${bars} 根，${fmtSpan(d.b.t - d.a.t)}`];
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

  /** Position: take-profit, stop and entry labels, and the R lines' names. */
  private paintPosition(ctx: CanvasRenderingContext2D, g: Geo) {
    const d = g.d;
    const p = g.pos;
    if (d.kind !== "position" || !p) return;
    const ps = this.host.position();
    const fp = (v: number) => this.host.fmtPrice(v);
    const pct = (v: number) => {
      const x = ((v - d.a.p) / d.a.p) * 100;
      return `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}%`;
    };
    const dir = positionDir(d.a.p, d.b.p);
    const rr = rewardRisk(d.a.p, d.b.p, d.target);
    const t = this.trades.get(d.id);
    /** A box of text lines; `align` says which side of x the box goes. Returns the box's right edge. */
    const tag = (lines: string[], x: number, y: number, bg: string, align: "center" | "left" = "center", fg = "#ffffff") => {
      const w = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 10;
      const h = lines.length * 15 + 3;
      const left = align === "center" ? x - w / 2 : x;
      ctx.fillStyle = bg;
      ctx.fillRect(left, y - h / 2, w, h);
      ctx.fillStyle = fg;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      lines.forEach((s, k) => ctx.fillText(s, left + 5, y - h / 2 + 9 + k * 15));
      return left + w;
    };
    const mid = (p.x0 + p.x1) / 2;
    const show = ps.showPrices;
    const money = (v: number) => `${v >= 0 ? "+" : "−"}${fmtMoney(Math.abs(v))} U`;
    // labels sit just outside the box, past the take-profit and the stop
    const outward = (y: number, sign: number) => y + sign * 13;
    const up = dir === 1 ? -1 : 1; // screen direction of the take-profit
    tag([`止盈 ${show ? fp(d.target) + " " : ""}(${pct(d.target)})  ${rr.toFixed(2)}R${t ? "  " + money(t.plan.reward) : ""}`], mid, outward(p.targetY, up), ps.profit);
    tag([`止損 ${show ? fp(d.b.p) + " " : ""}(${pct(d.b.p)})${t ? "  " + money(-t.plan.riskAmount) : ""}`], mid, outward(p.stopY, -up), ps.loss);
    if (!t) return;
    const pl = t.plan;
    const side = dir === 1 ? "多單" : "空單";
    const infoRight = tag(
      [
        `${side}  ${fmtQty(pl.qty)} ${this.host.base()}  ${d.leverage}x  保證金 ${fmtMoney(pl.margin)} U${pl.capped ? "（保證金不夠，已減量）" : ""}`,
        `資金 ${fmtMoney(t.capital)} U${t.chained ? "（接續）" : ""}  風險 ${fmtMoney(pl.riskAmount)} U  盈虧比 ${rr.toFixed(2)}`,
      ],
      p.x0 + 4,
      p.entryY,
      "rgba(30,34,45,0.92)",
      "left",
      pl.capped ? "#f7a600" : "#ffffff",
    );
    const o = t.outcome;
    const result: Record<string, [string, string]> = {
      tp: [`止盈出場 ${money(t.pnl)} → ${fmtMoney(t.endCapital)} U`, ps.profit],
      sl: [`止損出場 ${money(t.pnl)} → ${fmtMoney(t.endCapital)} U`, ps.loss],
      expired: [`到期出場 ${money(t.pnl)} → ${fmtMoney(t.endCapital)} U`, "rgba(54,58,69,0.95)"],
      open: [`持倉中 ${money(t.pnl)}`, "rgba(54,58,69,0.95)"],
      pending: ["等待進場", "rgba(54,58,69,0.95)"],
      unfilled: ["沒有成交", "rgba(54,58,69,0.95)"],
      nodata: ["K 線不夠，無法結算", "rgba(54,58,69,0.95)"],
    };
    const [text, bg] = result[o.status];
    tag([text], Math.max(p.x1, infoRight) + 6, p.entryY, bg, "left"); // past the info box when that is wider than the position
    ctx.font = FONT;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = ps.profit;
    for (const l of p.levels) ctx.fillText(`${l.k}R${show ? "  " + fp(l.price) : ""}`, p.x1 - 4, l.y - 2);
  }

  /** Trend angle: the angle as drawn on screen, next to the arc. */
  private paintAngle(ctx: CanvasRenderingContext2D, g: Geo) {
    const d = g.d;
    if (d.kind !== "angle") return;
    const deg = screenAngle(g.ax, g.ay, g.bx, g.by);
    ctx.fillStyle = d.style.color;
    ctx.textAlign = "left";
    ctx.textBaseline = deg >= 0 ? "bottom" : "top";
    ctx.fillText(`${deg.toFixed(1)}°`, g.ax + 32, deg >= 0 ? g.ay - 3 : g.ay + 3);
  }

  // ------------------------------------------------------------------- mouse
  private local(e: MouseEvent): Mouse {
    const r = this.host.el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const w = this.host.chart.timeScale().width();
    const h = this.host.chart.panes()[0]?.getHeight() ?? r.height;
    return { x, y, inside: x >= 0 && y >= 0 && x < w && y < h };
  }

  /** The magnet is in effect: always-on, or the hold key is down (read from the event when there is one). */
  private snapping(e?: MouseEvent): boolean {
    const m = this.host.magnet();
    if (m.on) return true;
    if (!e) return this.holdDown;
    return m.holdKey === "Control" ? e.ctrlKey : m.holdKey === "Shift" ? e.shiftKey : e.altKey;
  }

  /** Chart point under the mouse; with the magnet, the nearest open/high/low/close of that bar when it is
   *  close by (so a take-profit can still go in empty space while the magnet is always on). */
  private pointAt(x: number, y: number, snap: boolean): Anchor | null {
    const { chart, series } = this.host;
    const times = this.host.times();
    const logical = chart.timeScale().coordinateToLogical(x);
    const price = series.coordinateToPrice(y);
    if (logical == null || price == null || !times.length) return null;
    const i = Math.round(logical);
    let p = price as number;
    if (snap) {
      let best = SNAP_PX;
      for (const v of this.host.ohlcAt(i) ?? []) {
        const vy = series.priceToCoordinate(v);
        if (vy != null && Math.abs(vy - y) <= best) {
          best = Math.abs(vy - y);
          p = v;
        }
      }
    }
    return { t: indexToTime(times, i, this.host.barSec()), p };
  }

  private onBody(g: Geo, x: number, y: number): boolean {
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
        const x1 = d.style.extend ? this.host.chart.timeScale().width() : Math.max(ax, bx);
        return x >= Math.min(ax, bx) - LINE_HIT && x <= x1 + LINE_HIT && y >= Math.min(ay, by) - LINE_HIT && y <= Math.max(ay, by) + LINE_HIT;
      }
    }
  }

  private hit(x: number, y: number): Hit | null {
    const items = this.geo.filter((g) => g.d !== this.draft);
    for (let k = items.length - 1; k >= 0; k--) {
      for (const h of items[k].handles) if (Math.hypot(x - h.x, y - h.y) <= HANDLE_R) return { id: items[k].d.id, part: h.part };
    }
    for (let k = items.length - 1; k >= 0; k--) if (this.onBody(items[k], x, y)) return { id: items[k].d.id, part: "body" };
    return null;
  }

  private make(kind: DrawKind, pt: Anchor): Drawing {
    const id = newId(kind);
    const a = { ...pt };
    const b = { ...pt };
    if (kind === "fib") return { id, kind, a, b };
    if (kind === "position") {
      const ps = this.host.position();
      b.t = this.barsLater(pt.t, NEW_BOX_BARS);
      return { id, kind, a, b, target: pt.p, capital: null, risk: ps.risk, riskMode: ps.riskMode, leverage: ps.leverage };
    }
    if (kind === "rect") return { id, kind, a, b, style: clone(this.host.styleFor(kind) as RectStyle) };
    return { id, kind, a, b, style: clone(this.host.styleFor(kind) as LineStyle) };
  }

  /** The bar time `n` bars after `t`. */
  private barsLater(t: number, n: number): number {
    const times = this.host.times();
    const bs = this.host.barSec();
    return indexToTime(times, timeToIndex(times, t, bs) + n, bs);
  }

  /** While placing a position: the stop (stage 1) or the take-profit (stage 2) follows the point. */
  private placePosition(d: PositionDrawing, pt: Anchor) {
    const times = this.host.times();
    const bs = this.host.barSec();
    const right = timeToIndex(times, pt.t, bs) - timeToIndex(times, d.a.t, bs);
    if (right >= MIN_BOX_BARS) d.b.t = pt.t;
    if (this.stage === 1) {
      d.b.p = pt.p;
      const r = Math.abs(d.a.p - d.b.p);
      d.target = d.a.p + positionDir(d.a.p, d.b.p) * 2 * r; // previewed at 2R until the take-profit is placed
    } else {
      d.target = clampTarget(d.a.p, d.b.p, pt.p);
    }
  }

  private onDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const m = this.local(e);
    this.mouse = m;
    if (!m.inside) return;
    if (this.tool !== "cursor") {
      e.preventDefault();
      e.stopPropagation();
      const pt = this.pointAt(m.x, m.y, this.snapping(e));
      if (!pt) return;
      const kind = this.tool;
      if (kind === "position") {
        if (!this.draft) {
          this.draft = this.make(kind, pt);
          this.stage = 1;
          this.placing = { x0: m.x, y0: m.y, pressed: true };
        } else if (this.draft.kind === "position") {
          this.placePosition(this.draft, pt);
          if (this.stage === 1) {
            if (this.draft.b.p !== this.draft.a.p) this.stage = 2; // a stop at the entry is no stop: keep placing it
          } else {
            this.finishDraft();
            return;
          }
        }
        this.refreshHint();
        this.redraw();
        return;
      }
      if (TOOL_INFO[kind].points === 1) {
        const d = this.make(kind, pt);
        this.list.push(d);
        this.selected = d.id;
        this.host.changed(this.list);
        this.setTool("cursor");
        return;
      }
      if (!this.draft) {
        this.draft = this.make(kind, pt);
        this.placing = { x0: m.x, y0: m.y, pressed: true };
        this.refreshHint();
        this.redraw();
      } else {
        this.draft.b = pt;
        this.finishDraft();
      }
      return;
    }
    const h = this.hit(m.x, m.y);
    if (!h) {
      if (this.selected) {
        this.selected = null;
        this.refreshHint();
        this.redraw();
      }
      return; // the chart pans as usual
    }
    e.preventDefault();
    e.stopPropagation();
    const d = this.find(h.id);
    if (!d) return;
    this.selected = h.id;
    this.drag = { ...h, x0: m.x, y0: m.y, start: this.pointAt(m.x, m.y, false), orig: { a: { ...d.a }, b: { ...d.b } }, moved: false };
    this.host.el.classList.add("dragging");
    this.refreshHint();
    this.redraw();
  }

  private onMove(e: MouseEvent) {
    const m = this.local(e);
    this.mouse = m;
    if (this.drag) {
      this.dragTo(m, this.snapping(e));
      return;
    }
    if (this.tool !== "cursor") {
      if (this.draft) this.moveDraft(m, this.snapping(e));
      return;
    }
    const h = m.inside ? this.hit(m.x, m.y) : null;
    const id = h ? h.id : null;
    this.host.el.classList.toggle("over-drawing", !!h);
    if (id !== this.hovered) {
      this.hovered = id;
      this.redraw();
    }
  }

  private onUp(e: MouseEvent) {
    if (e.button !== 0) return;
    if (this.drag) {
      const moved = this.drag.moved;
      this.drag = null;
      this.host.el.classList.remove("dragging");
      if (moved) this.host.changed(this.list);
      return;
    }
    if (this.tool !== "cursor" && this.draft && this.placing?.pressed) {
      this.placing.pressed = false;
      const m = this.local(e);
      if (Math.hypot(m.x - this.placing.x0, m.y - this.placing.y0) > 6) {
        // pressed, dragged, released: that's both points (for a position: entry and stop)
        const pt = this.pointAt(m.x, m.y, this.snapping(e));
        if (this.draft.kind === "position") {
          if (pt) this.placePosition(this.draft, pt);
          if (this.draft.b.p !== this.draft.a.p) this.stage = 2;
          this.refreshHint();
          this.redraw();
          return;
        }
        if (pt) this.draft.b = pt;
        this.finishDraft();
      }
      // otherwise it was a click: wait for the second click
    }
  }

  private onDblClick(e: MouseEvent) {
    if (this.tool !== "cursor") return;
    const m = this.local(e);
    const h = m.inside ? this.hit(m.x, m.y) : null;
    const d = h ? this.find(h.id) : undefined;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    this.selected = d.id;
    this.redraw();
    this.host.openSettings(d, e.clientX, e.clientY);
  }

  /** Right-click on a drawing: its settings (anywhere else falls through to the chart's own menus). */
  private onContext(e: MouseEvent) {
    if (this.tool !== "cursor") {
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
      return;
    }
    const m = this.local(e);
    const h = m.inside ? this.hit(m.x, m.y) : null;
    const d = h ? this.find(h.id) : undefined;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    this.selected = d.id;
    this.refreshHint();
    this.redraw();
    this.host.openSettings(d, e.clientX, e.clientY);
  }

  private moveDraft(m: Mouse, snap: boolean) {
    if (!this.draft) return;
    const pt = this.pointAt(m.x, m.y, snap);
    if (!pt) return;
    if (this.draft.kind === "position") this.placePosition(this.draft, pt);
    else this.draft.b = pt;
    this.redraw();
  }

  private dragTo(m: Mouse, snap: boolean) {
    const dr = this.drag;
    if (!dr) return;
    const d = this.find(dr.id);
    if (!d) return;
    if (!dr.moved && Math.hypot(m.x - dr.x0, m.y - dr.y0) < 3) return;
    dr.moved = true;
    if (dr.part === "body") {
      const cur = this.pointAt(m.x, m.y, false);
      if (!cur || !dr.start) return;
      const times = this.host.times();
      const bs = this.host.barSec();
      const di = Math.round(timeToIndex(times, cur.t, bs) - timeToIndex(times, dr.start.t, bs));
      const dp = cur.p - dr.start.p;
      const shift = (a: Anchor): Anchor => ({ t: indexToTime(times, timeToIndex(times, a.t, bs) + di, bs), p: a.p + dp });
      const b0 = d.b.p;
      d.a = shift(dr.orig.a);
      d.b = shift(dr.orig.b);
      if (d.kind === "position") d.target += d.b.p - b0;
    } else if (d.kind === "position") {
      const pt = this.pointAt(m.x, m.y, snap);
      if (!pt) return;
      const dir = positionDir(d.a.p, d.b.p);
      const tiny = Math.abs(d.a.p) * 1e-6;
      if (dr.part === "stop") {
        d.b.p = dir === 1 ? Math.min(pt.p, d.a.p - tiny) : Math.max(pt.p, d.a.p + tiny); // stays on its side
      } else if (dr.part === "target") {
        d.target = clampTarget(d.a.p, d.b.p, pt.p);
      } else if (dr.part === "edge") {
        d.b.t = Math.max(pt.t, this.barsLater(d.a.t, 1));
      } else {
        // the entry moves between the stop and the take-profit
        const lo = Math.min(d.b.p, d.target);
        const hi = Math.max(d.b.p, d.target);
        d.a = { t: Math.min(pt.t, this.barsLater(d.b.t, -1)), p: Math.min(Math.max(pt.p, lo + tiny), hi - tiny) };
      }
    } else {
      const pt = this.pointAt(m.x, m.y, snap);
      if (!pt) return;
      if (dr.part === "a") {
        d.a = pt;
        if (TOOL_INFO[d.kind].points === 1) d.b = { ...pt };
      } else if (dr.part === "b") {
        d.b = pt;
      } else if (dr.part === "c2") {
        d.a = { t: pt.t, p: d.a.p };
        d.b = { t: d.b.t, p: pt.p };
      } else {
        d.b = { t: pt.t, p: d.b.p };
        d.a = { t: d.a.t, p: pt.p };
      }
    }
    this.redraw();
  }

  private finishDraft() {
    const d = this.draft;
    this.draft = null;
    this.placing = null;
    if (d && !(d.a.t === d.b.t && d.a.p === d.b.p)) {
      this.list.push(d);
      this.selected = d.id;
      this.host.changed(this.list);
    }
    this.setTool("cursor"); // one drawing per pick of the tool, as on TradingView
  }

  // ------------------------------------------------------------------- keys
  private onKey(e: KeyboardEvent, down: boolean) {
    const hold = this.host.magnet().holdKey;
    if (e.key === hold || (hold === "Alt" && e.key === "AltGraph")) {
      if (hold === "Alt") e.preventDefault(); // keep Alt from moving focus to the window menu
      this.setHold(down);
      return;
    }
    if (!down || isTyping(document.activeElement)) return;
    if (e.key === "Escape") {
      this.cancel();
    } else if ((e.key === "Delete" || e.key === "Backspace") && this.selected && !this.drag) {
      e.preventDefault();
      this.remove(this.selected);
    } else if (e.altKey && !e.ctrlKey) {
      const kind = e.shiftKey ? (e.code === "KeyR" ? "rect" : null) : SHORTCUTS[e.code];
      if (kind) {
        e.preventDefault();
        this.setTool(kind);
      }
    }
  }

  private setHold(down: boolean) {
    if (this.holdDown === down) return;
    this.holdDown = down;
    this.host.magnetActive(this.host.magnet().on || down);
    // move the point under the mouse right away instead of waiting for the next mouse move
    const m = this.mouse;
    if (!m) return;
    const snap = this.snapping();
    if (this.drag && this.drag.part !== "body") this.dragTo(m, snap);
    else if (this.tool !== "cursor" && this.draft) this.moveDraft(m, snap);
  }

  /** Esc: drop the drawing being placed, leave the tool, or clear the selection. */
  cancel() {
    if (this.tool !== "cursor") {
      this.setTool("cursor");
    } else if (this.selected) {
      this.selected = null;
      this.refreshHint();
      this.redraw();
    }
  }

  private refreshHint() {
    const m = this.host.magnet();
    const snap = m.on ? "吸附：常開" : `按住 ${magnetKeyLabel(m.holdKey)} 吸附到 K 線開高低收`;
    if (this.tool === "position") {
      if (!this.draft) this.host.hint(`倉位：點進場價；${snap}；Esc 取消`);
      else if (this.stage === 1) this.host.hint(`倉位：點止損價，在進場下面是多單、上面是空單；${snap}；Esc 取消`);
      else this.host.hint(`倉位：點止盈價，畫面會顯示到止盈為止的 R 線；${snap}；Esc 取消`);
    } else if (this.tool !== "cursor") {
      const info = TOOL_INFO[this.tool];
      if (info.points === 1) this.host.hint(`${info.name}：點一下放置；${snap}；Esc 取消`);
      else if (this.draft) this.host.hint(`${info.name}：點第二個點；${snap}；Esc 取消`);
      else this.host.hint(`${info.name}：點第一個點，或按住拖到第二個點；${snap}；Esc 取消`);
    } else if (this.selected) {
      this.host.hint("拖曳端點調整、拖曳線條移動；Delete 刪除；雙擊或右鍵開設定");
    } else {
      this.host.hint(null);
    }
  }
}
