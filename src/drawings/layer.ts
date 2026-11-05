// Drawing tools on the price pane: Fibonacci retracement; lines (trend line, ray, info line, extended line,
// trend angle, horizontal line, horizontal ray, vertical line, cross line); channels (parallel channel,
// regression trend, flat top/bottom, disjoint channel); rectangles; positions.
//
// This file holds the drawings and what the mouse and keys do with them. Where they are on screen is geo.ts,
// how they look is paint.ts, position sizing is trade.ts. The layer is a lightweight-charts series primitive
// on the candle series; horizontal lines show their price on the price scale and vertical lines their time on
// the time scale (a selected drawing shows all its points there).
// Mouse: listeners on the chart element in the capture phase, so a press on a drawing (or while placing one)
// never reaches the chart and never starts a pan. Points are stored as (bar start time, price), so drawings
// stay put across timeframes, history loading and restarts. With several charts on screen, only the chart in
// use (active) takes the keys: Esc, Delete, the tool shortcuts, Ctrl+Z / Ctrl+Y (undo is history.ts, kept by the
// charts for each symbol).

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
import type { Candle } from "../core/api.ts";
import { xOfLogical } from "../chart/coords.ts";
import { chainPositions, type PositionPrices, type PositionResult } from "./trade.ts";
import type { LiveInfo } from "../trade/sync.ts";
import {
  clampTarget, fitLine, indexToTime, lockAxis, posDir, positionDir, secondThrough, snapAngle, snapSquare, timeToIndex,
  type Anchor, type Fit,
} from "./geometry.ts";
import { computeGeo, hitTest, type Geo, type Hit, type Projector } from "./geo.ts";
import {
  ACCENT, labelPlans, measureLines, paintMeasure, paintOver, paintUnder, type HotSpot, type LabelPlan, type MeasureGeo, type OrderTag,
  type PaintOptions,
} from "./paint.ts";
import type { LabelSpace } from "../chart/labelspace.ts";
import { isTyping } from "../ui/dom.ts";
import {
  clone,
  isChannel,
  isChannelDrawing,
  magnetKeyLabel,
  newId,
  TOOL_INFO,
  type ChannelDrawing,
  type ChannelStyle,
  type DrawKind,
  type Drawing,
  type FibSettings,
  type LineStyle,
  type MagnetSettings,
  type PositionDrawing,
  type PositionOrder,
  type PositionSettings,
  type RectStyle,
} from "../settings/model.ts";

/** "measure": the ruler (a measurement, not a drawing: nothing is kept). */
export type Tool = "cursor" | "measure" | DrawKind;

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
  /** A price on the symbol's price step. */
  roundPrice(p: number): number;
  /** A price as plain digits with the symbol's decimals, for a number box ("68123.5"). */
  priceText(p: number): string;
  /** A bar time (UTC seconds) as the time axis shows it. */
  fmtTime(t: number): string;
  fib(): FibSettings;
  magnet(): MagnetSettings;
  position(): PositionSettings;
  /** The starting capital of positions: the default one, or the trading account's equity (`live`). */
  capital(): { amount: number; live: boolean };
  /** The button at the right of a position (null: none). */
  orderTag(d: PositionDrawing): OrderTag | null;
  /** That button was clicked, at screen point (x, y). */
  orderClicked(d: PositionDrawing, x: number, y: number): void;
  /** The style a new drawing of this kind starts with. */
  styleFor(kind: Exclude<DrawKind, "fib" | "position">): LineStyle | RectStyle | ChannelStyle;
  /** The list changed (added, moved, restyled, deleted): save it. `step`, for undo: the name of a change that
   *  goes on (a color being picked: one step), or false for a change that is no step of its own (an order's
   *  state). */
  changed(list: Drawing[], step?: string | false): void;
  /** Ctrl+Z, Ctrl+Y: the drawings one step back, or the step undone last again. */
  undo(): void;
  redo(): void;
  /** A position on OKX now (its entry is OKX's; moving its stops asks to change OKX), and what it shows. */
  isLive(d: PositionDrawing): boolean;
  live(d: PositionDrawing): LiveInfo | null;
  /** The stop-loss / take-profit of a position on OKX was moved on the chart (`before`: what they were), at
   *  screen point (x, y): ask whether to change OKX. */
  stopsEdited(d: PositionDrawing, before: { stop: number; target: number }, x: number, y: number): void;
  toolChanged(tool: Tool): void;
  /** The magnet is in effect right now (always on, or the hold key is down). */
  magnetActive(active: boolean): void;
  /** Double-click or right-click on a drawing, at screen point (x, y). */
  openSettings(d: Drawing, x: number, y: number): void;
  /** Status bar hint; null restores the default. */
  hint(text: string | null): void;
  /** Room for the labels on the chart, and their size in px. */
  space: LabelSpace;
  textSize(): number;
};

type Drag = Hit & { x0: number; y0: number; start: Anchor | null; orig: { a: Anchor; b: Anchor; c: Anchor; target: number }; moved: boolean };
type Mouse = { x: number; y: number; inside: boolean };
type AxisLabel = { pos: number; text: string; color: string };
/** A measurement from `a` to `b`: `done` once its end is set (it then shows until the next click or Esc);
 *  `pressed`: where the mouse went down for its start, while it is held. */
type Measure = { a: Anchor; b: Anchor; done: boolean; pressed: { x0: number; y0: number } | null };

const SNAP_PX = 30; // px: the magnet only pulls a point this close to an open/high/low/close

const SHORTCUTS: Record<string, DrawKind> = {
  KeyF: "fib", KeyT: "trend", KeyH: "hline", KeyJ: "hray", KeyV: "vline", KeyC: "cross", KeyP: "position",
};
const MIN_BOX_BARS = 5; // a position box is at least this many bars wide
const NEW_BOX_BARS = 20; // and this wide when placed without dragging to the right

export class DrawingLayer implements ISeriesPrimitive<Time> {
  private list: Drawing[] = [];
  private draft: Drawing | null = null;
  private placing: { x0: number; y0: number; pressed: boolean } | null = null;
  /** Placing a position: 1 = the stop follows the mouse, 2 = the take-profit does. Placing a channel: 1 = the
   *  end of its first line, 2 = its second line. */
  private stage: 1 | 2 = 1;
  /** Regression trends fitted to the bars, by drawing (fitted again when the bars or its ends change). */
  private fits = new Map<string, { key: string; fit: Fit | null }>();
  private selected: string | null = null;
  private hovered: string | null = null;
  private tool: Tool = "cursor";
  private drag: Drag | null = null;
  private geo: Geo[] = [];
  private mouse: Mouse | null = null;
  private holdDown = false;
  /** Shift is down: lines go horizontal, vertical or 45°, rectangles square, moves along one axis. */
  private shiftDown = false;
  private requestUpdate: (() => void) | null = null;
  private priceLabels: ISeriesPrimitiveAxisView[] = [];
  /** Size and outcome of every position (see trade.ts), recomputed with each redraw. */
  private trades = new Map<string, PositionResult>();
  private timeLabels: ISeriesPrimitiveAxisView[] = [];
  /** The chart in use: the one the keys go to. */
  private active = true;
  /** Order buttons as last painted. */
  private spots: HotSpot[] = [];
  /** What the drawings write on the chart, planned with their geometry. */
  private plans: LabelPlan[] = [];
  private measure: Measure | null = null;
  private measureGeo: MeasureGeo | null = null;
  private readonly offs: (() => void)[] = [];

  private readonly views: IPrimitivePaneView[] = [
    { zOrder: () => "bottom", renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => paintUnder(t, this.geo, this.paintOptions()) }) },
    {
      zOrder: () => "normal",
      renderer: () => ({
        draw: (t: CanvasRenderingTarget2D) => {
          this.spots = paintOver(t, this.geo, this.plans, (key) => this.host.space.at("drawings", key), this.paintOptions());
        },
      }),
    },
    { zOrder: () => "top", renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => paintMeasure(t, this.measureGeo, this.host.textSize()) }) },
  ];
  private readonly host: DrawingHost;

  constructor(host: DrawingHost) {
    this.host = host;
    host.el.addEventListener("mousedown", (e) => this.onDown(e), true);
    host.el.addEventListener("dblclick", (e) => this.onDblClick(e), true);
    host.el.addEventListener("contextmenu", (e) => this.onContext(e), true);
    this.onWindow("mousemove", (e) => this.onMove(e), true);
    this.onWindow("mouseup", (e) => this.onUp(e), true);
    this.onWindow("keydown", (e) => this.onKey(e, true));
    this.onWindow("keyup", (e) => this.onKey(e, false));
    this.onWindow("blur", () => {
      this.setHold(false);
      this.setShift(false);
    });
  }

  private onWindow<K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, capture = false) {
    window.addEventListener(type, fn, capture);
    this.offs.push(() => window.removeEventListener(type, fn, capture));
  }

  /** The chart is going away: stop listening to the window. */
  destroy() {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  /** In use or not; a chart that is left drops the drawing being placed and its selection. */
  setActive(on: boolean) {
    if (this.active === on) return;
    this.active = on;
    if (on) return;
    if (this.measure) {
      this.measure = null;
      this.redraw();
    }
    if (this.tool !== "cursor") this.setTool("cursor");
    if (this.selected) {
      this.selected = null;
      this.redraw();
    }
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
    const { chart } = this.host;
    this.plans = labelPlans(this.geo, this.paintOptions(), chart.timeScale().width(), chart.panes()[0]?.getHeight() ?? 0);
    this.host.space.set("drawings", this.plans.map((p) => p.ask));
    this.measureGeo = this.computeMeasure();
  }

  private computeMeasure(): MeasureGeo | null {
    const ms = this.measure;
    if (!ms) return null;
    const ax = this.xOfTime(ms.a.t);
    const bx = this.xOfTime(ms.b.t);
    const ay = this.host.series.priceToCoordinate(ms.a.p);
    const by = this.host.series.priceToCoordinate(ms.b.p);
    if (ax == null || bx == null || ay == null || by == null) return null;
    const lines = measureLines(ms.a, ms.b, { times: this.host.times(), barSec: this.host.barSec(), bars: this.host.bars(), fmtPrice: this.host.fmtPrice });
    return { ax, ay, bx, by, up: ms.b.p >= ms.a.p, lines };
  }

  /** Size and outcome of one position, as last drawn (for the settings window). */
  tradeOf(id: string): PositionResult | undefined {
    return this.trades.get(id);
  }
  /** The same from the bars and settings as they are now, drawn or not (an AI app's order: the window may be
   *  hidden, when nothing is drawn). */
  tradeNow(id: string): PositionResult | undefined {
    this.trades = this.computeTrades();
    return this.trades.get(id);
  }

  private computeTrades(): Map<string, PositionResult> {
    const ps = this.host.position();
    const cap = this.host.capital();
    const bars = this.host.bars();
    const newest = bars.length ? bars[bars.length - 1].time : Infinity;
    const items = this.draft ? [...this.list, this.draft] : this.list;
    const inputs = [];
    for (const d of items) {
      if (d.kind !== "position" || d.okx) continue;
      inputs.push({
        id: d.id, entryT: d.a.t, endT: d.order?.closed?.t || d.b.t, entry: d.a.p, stop: d.b.p, target: d.target, dir: d.dir,
        capital: d.capital, risk: d.risk, riskMode: d.riskMode, leverage: d.leverage,
        fresh: cap.live && d.b.t >= newest, // a position still running sizes from the real account
      });
    }
    return chainPositions(inputs, bars, this.host.barSec(), cap.amount, ps.chain);
  }

  // ------------------------------------------------------------------- public
  getTool(): Tool {
    return this.tool;
  }
  setTool(t: Tool) {
    this.tool = t;
    this.draft = null;
    this.placing = null;
    this.measure = null;
    if (t !== "cursor") this.selected = null;
    this.host.el.classList.toggle("drawing", t !== "cursor");
    this.host.el.classList.remove("over-drawing");
    this.host.toolChanged(t);
    this.refreshHint();
    this.redraw();
  }
  /** Show another symbol's drawings (does not save). `keep`: the same symbol's, changed elsewhere (another
   *  chart, OKX): what is selected, hovered or dragged stays so when it is still there. */
  setDrawings(list: Drawing[], keep = false) {
    const has = (id: string | null) => keep && id != null && list.some((d) => d.id === id);
    this.list = list;
    this.draft = null;
    this.placing = null;
    if (!keep) this.measure = null;
    this.fits.clear();
    if (!(this.drag && has(this.drag.id))) this.drag = null;
    if (!has(this.selected)) this.selected = null;
    if (!has(this.hovered)) this.hovered = null;
    this.refreshHint();
    this.redraw();
  }
  count(): number {
    return this.list.length;
  }
  /** The positions (the objects themselves: read only). */
  positions(): PositionDrawing[] {
    return this.list.filter((d): d is PositionDrawing => d.kind === "position");
  }
  /** The order placed from a position (undefined forgets it); saved at once. */
  setOrder(id: string, order: PositionOrder | undefined) {
    const d = this.find(id);
    if (!d || d.kind !== "position") return;
    if (order) {
      d.order = order;
      d.dir ??= order.side === "buy" ? 1 : -1; // on OKX: the direction is the order's from now on
    } else delete d.order;
    this.host.changed(this.list, false); // what the exchange did is not undone
    this.redraw();
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
  /** New style for a line, channel or rectangle; saved at once. */
  setStyle(id: string, style: LineStyle | RectStyle | ChannelStyle) {
    const d = this.find(id);
    if (!d || d.kind === "fib" || d.kind === "position") return;
    (d as { style: LineStyle | RectStyle | ChannelStyle }).style = style;
    this.host.changed(this.list, `style:${id}`); // a color dragged across the picker is one step
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
  /** Entry, stop-loss and take-profit of one position, typed in its settings (checked there); saved at once. */
  setPrices(id: string, p: PositionPrices, at?: { x: number; y: number }) {
    const d = this.find(id);
    if (!d || d.kind !== "position") return;
    const before = { stop: d.b.p, target: d.target };
    const live = this.host.isLive(d);
    if (!live && !d.okx) d.a = { ...d.a, p: p.entry }; // on OKX the entry is OKX's
    d.b = { ...d.b, p: p.stop };
    d.target = p.target;
    this.host.changed(this.list);
    this.redraw();
    if (live && (before.stop !== d.b.p || before.target !== d.target)) {
      this.host.stopsEdited(d, before, at?.x ?? window.innerWidth / 2, at?.y ?? window.innerHeight / 3);
    }
  }
  /** A position closed on OKX (drawn from it, or with an order of ours in it): a record now. */
  private closedOnOkx(id: string): boolean {
    const d = this.find(id);
    return d?.kind === "position" && !!(d.okx?.closed || d.order?.closed);
  }
  /** Is this position on OKX now (see DrawingHost.isLive)? */
  isLive(id: string): boolean {
    const d = this.find(id);
    return d?.kind === "position" && (!!(d.okx && !d.okx.closed) || this.host.isLive(d));
  }
  /** Put a position's stops back (not sent to OKX), not as a step to undo. */
  setStops(id: string, s: { stop: number; target: number }) {
    const d = this.find(id);
    if (!d || d.kind !== "position") return;
    d.b = { ...d.b, p: s.stop };
    d.target = s.target;
    this.host.changed(this.list, false);
    this.redraw();
  }
  roundPrice(p: number): number {
    return this.host.roundPrice(p);
  }
  priceText(p: number): string {
    return this.host.priceText(p);
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
  private projector(): Projector | null {
    const times = this.host.times();
    if (!times.length) return null;
    const { series, chart } = this.host;
    const bs = this.host.barSec();
    return {
      x: (t) => xOfLogical(chart, timeToIndex(times, t, bs)),
      y: (p) => series.priceToCoordinate(p),
      width: chart.timeScale().width(),
      height: chart.panes()[0]?.getHeight() ?? 0,
    };
  }

  private computeGeo(): Geo[] {
    const pr = this.projector();
    if (!pr) return [];
    const items = this.draft ? [...this.list, this.draft] : this.list;
    return computeGeo(items, pr, {
      fib: this.host.fib(),
      rLevels: this.host.position().levels.filter((l) => l.on).map((l) => l.value),
      fmtPrice: this.host.fmtPrice,
      trades: this.trades,
      active: (d) => d === this.draft || d.id === this.selected || d.id === this.hovered,
      fit: (d) => this.fitOf(d),
      firstOnly: this.draft && isChannelDrawing(this.draft) && this.draft.kind !== "regression" && this.stage === 1 ? this.draft.id : null,
    });
  }

  /** A regression trend fitted to the closes of the loaded bars from its first point to its second (null when
   *  the bars don't reach back to its first point). */
  private fitOf(d: ChannelDrawing): Fit | null {
    const bars = this.host.bars();
    const n = bars.length;
    const key = n ? `${d.a.t}|${d.b.t}|${n}|${bars[0].time}|${bars[n - 1].time}|${bars[n - 1].close}` : "";
    const known = this.fits.get(d.id);
    if (known && known.key === key) return known.fit;
    const times = this.host.times();
    const bs = this.host.barSec();
    const fit = n ? fitLine(n, (i) => bars[i].close, timeToIndex(times, d.a.t, bs), timeToIndex(times, d.b.t, bs)) : null;
    this.fits.set(d.id, { key, fit });
    return fit;
  }

  /** Keep a regression trend's fit on the bars now in it (alerts and other timeframes read it). */
  private refit(d: Drawing) {
    if (d.kind !== "regression") return;
    const f = this.fitOf(d);
    if (!f) return;
    d.a = { t: d.a.t, p: f.p0 };
    d.b = { t: d.b.t, p: f.p1 };
    d.c = { ...d.a };
    d.fit = { sd: f.sd, r: f.r };
  }

  private paintOptions(): PaintOptions {
    return {
      fib: this.host.fib(),
      position: this.host.position(),
      fmtPrice: this.host.fmtPrice,
      base: this.host.base(),
      times: this.host.times(),
      barSec: this.host.barSec(),
      trades: this.trades,
      orderTag: (d) => this.host.orderTag(d),
      live: (d) => this.host.live(d),
      textPx: this.host.textSize(),
      covers: (b) => this.coversBars(b),
    };
  }

  /** Does a box (chart pixels) cover the high–low of a bar on screen? */
  private coversBars(b: { x: number; y: number; w: number; h: number }): boolean {
    const { chart, series } = this.host;
    const ts = chart.timeScale();
    const l0 = ts.coordinateToLogical(b.x);
    const l1 = ts.coordinateToLogical(b.x + b.w);
    if (l0 == null || l1 == null) return false;
    const bars = this.host.bars();
    for (let i = Math.max(0, Math.round(l0)); i <= Math.min(bars.length - 1, Math.round(l1)); i++) {
      const hi = series.priceToCoordinate(bars[i].high);
      const lo = series.priceToCoordinate(bars[i].low);
      if (hi != null && lo != null && hi < b.y + b.h && lo > b.y) return true;
    }
    return false;
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
      if (isChannelDrawing(d)) {
        for (const k of g.ch?.marks ?? []) price.push({ pos: k.y, text: fp(k.p), color: ACCENT });
        time.push({ pos: g.ax, text: ft(d.a.t), color: ACCENT }, { pos: g.bx, text: ft(d.b.t), color: ACCENT });
      } else if (d.kind === "position") {
        const ps = this.host.position();
        const real = d.okx?.closed ?? d.order?.closed;
        if (g.pos?.closed && g.pos.exit && real) {
          // closed on OKX: entry and close
          price.push({ pos: g.ay, text: fp(d.a.p), color: "#787b86" }, { pos: g.pos.closed.y, text: fp(real.px), color: g.pos.closed.profit ? ps.profit : ps.loss });
          time.push({ pos: g.ax, text: ft(d.a.t), color: ACCENT }, { pos: g.pos.exit.x, text: ft(real.t), color: ACCENT });
          continue;
        }
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
    return m.holdKey === "Control" ? e.ctrlKey : e.altKey;
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

  /** x of a bar time; the bar time at an x (whole bars). */
  private xOfTime(t: number): number | null {
    return xOfLogical(this.host.chart, timeToIndex(this.host.times(), t, this.host.barSec()));
  }
  private timeAtX(x: number): number | null {
    const logical = this.host.chart.timeScale().coordinateToLogical(x);
    const times = this.host.times();
    if (logical == null || !times.length) return null;
    return indexToTime(times, Math.round(logical), this.host.barSec());
  }

  /**
   * Shift: the point under the mouse, moved so the line from `from` runs horizontal, vertical or at 45°
   * (`square`: on the 45° diagonal, a rectangle's corner). Whole bars across; at 45°, exactly as many pixels
   * up or down as across at the current zoom. The magnet stays out of it.
   */
  private constrained(from: Anchor, m: Mouse, square: boolean): Anchor | null {
    const { series } = this.host;
    const fx = this.xOfTime(from.t);
    const fy = series.priceToCoordinate(from.p);
    if (fx == null || fy == null) return this.pointAt(m.x, m.y, false);
    const s = square ? { ...snapSquare(fx, fy, m.x, m.y), dir: "d" as const } : snapAngle(fx, fy, m.x, m.y);
    if (s.dir === "v") {
      const p = series.coordinateToPrice(s.y);
      return p == null ? null : { t: from.t, p };
    }
    const t = this.timeAtX(s.x);
    if (t == null) return null;
    if (s.dir === "h") return { t, p: from.p };
    const xq = this.xOfTime(t) ?? s.x;
    const p = series.coordinateToPrice(fy + Math.sign(s.y - fy || 1) * Math.abs(xq - fx));
    return p == null ? null : { t, p };
  }

  /** The next point of a drawing being placed: under the mouse (with the magnet), or with Shift held, kept
   *  horizontal / vertical / 45° from the first point (a square for a rectangle; price only for a position). */
  private draftPoint(d: Drawing, m: Mouse, snap: boolean, shift: boolean): Anchor | null {
    if (!shift || (isChannelDrawing(d) && this.stage === 2)) return this.pointAt(m.x, m.y, snap);
    if (d.kind === "position") {
      const pt = this.pointAt(m.x, m.y, false);
      return pt && { t: d.b.t, p: pt.p }; // the box keeps its width
    }
    return this.constrained(d.a, m, d.kind === "rect");
  }

  /** Shift while dragging a point: a line stays horizontal / vertical / 45° from its other end, a rectangle
   *  square around the opposite corner, a one-point drawing moves along one axis only. */
  private shiftedHandle(d: Drawing, dr: Drag, m: Mouse): Anchor | null {
    if (TOOL_INFO[d.kind].points === 1) {
      const pt = this.pointAt(m.x, m.y, false);
      if (!pt) return null;
      return lockAxis(m.x - dr.x0, m.y - dr.y0) === "h" ? { t: pt.t, p: dr.orig.a.p } : { t: dr.orig.a.t, p: pt.p };
    }
    if (d.kind === "rect") {
      const o = dr.orig;
      const opposite: Anchor = dr.part === "a" ? o.b : dr.part === "b" ? o.a : dr.part === "c2" ? { t: o.b.t, p: o.a.p } : { t: o.a.t, p: o.b.p };
      return this.constrained(opposite, m, true);
    }
    return this.constrained(dr.part === "a" ? d.b : d.a, m, false);
  }

  private spotAt(x: number, y: number): PositionDrawing | null {
    for (let k = this.spots.length - 1; k >= 0; k--) {
      const s = this.spots[k];
      if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
        const d = this.find(s.id);
        return d?.kind === "position" ? d : null;
      }
    }
    return null;
  }

  private hit(x: number, y: number): Hit | null {
    return hitTest(this.geo, x, y, this.host.chart.timeScale().width(), this.draft);
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
    if (isChannel(kind)) return { id, kind, a, b, c: { ...pt }, style: clone(this.host.styleFor(kind) as ChannelStyle) };
    return { id, kind, a, b, style: clone(this.host.styleFor(kind) as LineStyle) };
  }

  /** Placing a channel: the end of its first line follows the point (stage 1; a regression trend's end), then
   *  its second line goes through it (stage 2). */
  private placeChannel(d: ChannelDrawing, pt: Anchor) {
    if (this.stage === 2 && d.kind !== "regression") d.c = { t: d.a.t, p: secondThrough(d.kind, d.a, d.b, pt) };
    else {
      d.b = pt;
      d.c = { t: d.a.t, p: d.c.p };
    }
  }

  /** A three-point channel's first line is down (its ends at different times): on to its second line. */
  private firstLineDone(d: ChannelDrawing): boolean {
    if (d.b.t === d.a.t) return false; // standing straight up: keep placing its end
    this.stage = 2;
    return true;
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
    if (this.measureDown(e, m) || this.tool === "measure") return;
    if (this.tool !== "cursor") {
      e.preventDefault();
      e.stopPropagation();
      const pt = this.draft ? this.draftPoint(this.draft, m, this.snapping(e), e.shiftKey) : this.pointAt(m.x, m.y, this.snapping(e));
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
        this.stage = 1;
        this.placing = { x0: m.x, y0: m.y, pressed: true };
        this.refreshHint();
        this.redraw();
      } else if (isChannelDrawing(this.draft)) {
        const d = this.draft;
        this.placeChannel(d, pt);
        if (TOOL_INFO[d.kind].points === 3 && this.stage === 1) {
          if (this.firstLineDone(d)) this.placeChannel(d, pt); // the second line starts through this point
          this.refreshHint();
          this.redraw();
          return;
        }
        this.finishDraft();
      } else {
        this.draft.b = pt;
        this.finishDraft();
      }
      return;
    }
    const spot = this.spotAt(m.x, m.y);
    if (spot) {
      e.preventDefault();
      e.stopPropagation();
      this.host.orderClicked(spot, e.clientX, e.clientY);
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
    const target = d.kind === "position" ? d.target : 0;
    const c = isChannelDrawing(d) ? { ...d.c } : { ...d.a };
    this.drag = { ...h, x0: m.x, y0: m.y, start: this.pointAt(m.x, m.y, false), orig: { a: { ...d.a }, b: { ...d.b }, c, target }, moved: false };
    this.host.el.classList.add("dragging");
    this.refreshHint();
    this.redraw();
  }

  /**
   * The ruler, or Shift + click on the chart where there is no drawing: the first click sets where a measurement
   * starts, the second (or letting go after dragging) where it ends; the next click takes it away and then does
   * what it would have. True when the click was the measurement's.
   */
  private measureDown(e: MouseEvent, m: Mouse): boolean {
    const ms = this.measure;
    if (ms && !ms.done) {
      e.preventDefault();
      e.stopPropagation();
      const pt = this.pointAt(m.x, m.y, this.snapping(e));
      if (pt) ms.b = pt;
      this.endMeasure();
      return true;
    }
    if (ms) {
      this.measure = null;
      this.refreshHint();
      this.redraw();
    }
    const start = this.tool === "measure" || (this.tool === "cursor" && e.shiftKey && !this.spotAt(m.x, m.y) && !this.hit(m.x, m.y));
    if (!start) return false;
    e.preventDefault();
    e.stopPropagation();
    const pt = this.pointAt(m.x, m.y, this.snapping(e));
    if (!pt) return true;
    if (this.tool !== "measure") this.setTool("measure");
    this.measure = { a: pt, b: { ...pt }, done: false, pressed: { x0: m.x, y0: m.y } };
    this.refreshHint();
    this.redraw();
    return true;
  }

  /** The end of the measurement is set: it stays on screen, and the tool goes back to the cursor. */
  private endMeasure() {
    const ms = this.measure;
    if (!ms) return;
    this.setTool("cursor"); // (which takes the measurement away)
    this.measure = { ...ms, done: true, pressed: null };
    this.refreshHint();
    this.redraw();
  }

  private onMove(e: MouseEvent) {
    const m = this.local(e);
    this.mouse = m;
    if (this.measure && !this.measure.done) {
      const pt = this.pointAt(m.x, m.y, this.snapping(e));
      if (pt) this.measure.b = pt;
      this.redraw();
      return;
    }
    if (this.drag) {
      this.dragTo(m, this.snapping(e), e.shiftKey);
      return;
    }
    if (this.tool !== "cursor") {
      if (this.draft) this.moveDraft(m, this.snapping(e), e.shiftKey);
      return;
    }
    const h = m.inside ? this.hit(m.x, m.y) : null;
    const id = h ? h.id : null;
    this.host.el.classList.toggle("over-drawing", !!h || (m.inside && !!this.spotAt(m.x, m.y)));
    if (id !== this.hovered) {
      this.hovered = id;
      this.redraw();
    }
  }

  private onUp(e: MouseEvent) {
    if (e.button !== 0) return;
    const ms = this.measure;
    if (ms && !ms.done && ms.pressed) {
      const m = this.local(e);
      const moved = Math.hypot(m.x - ms.pressed.x0, m.y - ms.pressed.y0) > 6;
      ms.pressed = null;
      if (moved) {
        // pressed, dragged, released: that's both ends
        const pt = this.pointAt(m.x, m.y, this.snapping(e));
        if (pt) ms.b = pt;
        this.endMeasure();
      }
      return; // a click: the end follows the mouse until the next click
    }
    if (this.drag) {
      const dr = this.drag;
      this.drag = null;
      this.host.el.classList.remove("dragging");
      if (!dr.moved) return;
      const moved = this.find(dr.id);
      if (moved) this.refit(moved);
      this.host.changed(this.list);
      const d = this.find(dr.id);
      if (d?.kind === "position" && (dr.part === "stop" || dr.part === "target") && this.host.isLive(d)) {
        this.host.stopsEdited(d, { stop: dr.orig.b.p, target: dr.orig.target }, e.clientX, e.clientY);
      }
      return;
    }
    if (this.tool !== "cursor" && this.draft && this.placing?.pressed) {
      this.placing.pressed = false;
      const m = this.local(e);
      if (Math.hypot(m.x - this.placing.x0, m.y - this.placing.y0) > 6) {
        // pressed, dragged, released: that's both points (for a position: entry and stop)
        const pt = this.draftPoint(this.draft, m, this.snapping(e), e.shiftKey);
        if (this.draft.kind === "position") {
          if (pt) this.placePosition(this.draft, pt);
          if (this.draft.b.p !== this.draft.a.p) this.stage = 2;
          this.refreshHint();
          this.redraw();
          return;
        }
        if (isChannelDrawing(this.draft) && TOOL_INFO[this.draft.kind].points === 3) {
          // pressed, dragged, released: that's the first line; its second line follows the mouse now
          if (pt) this.placeChannel(this.draft, pt);
          if (this.firstLineDone(this.draft) && pt) this.placeChannel(this.draft, pt);
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

  private moveDraft(m: Mouse, snap: boolean, shift: boolean) {
    if (!this.draft) return;
    const pt = this.draftPoint(this.draft, m, snap, shift);
    if (!pt) return;
    if (this.draft.kind === "position") this.placePosition(this.draft, pt);
    else if (isChannelDrawing(this.draft)) this.placeChannel(this.draft, pt);
    else this.draft.b = pt;
    this.redraw();
  }

  private dragTo(m: Mouse, snap: boolean, shift: boolean) {
    const dr = this.drag;
    if (!dr) return;
    const d = this.find(dr.id);
    if (!d) return;
    if (!dr.moved && Math.hypot(m.x - dr.x0, m.y - dr.y0) < 3) return;
    if (d.kind === "position" && (d.okx?.closed || d.order?.closed)) {
      this.host.hint("在 OKX 上已經平倉：照 OKX 的紀錄，不能移動。可以按 Delete 刪除");
      return;
    }
    if (d.kind === "position" && (d.okx || this.host.isLive(d)) && dr.part !== "stop" && dr.part !== "target") {
      this.host.hint("OKX 上的倉位：進場和位置照 OKX，只能拖止損、止盈（放開後確認才會改 OKX）");
      return;
    }
    dr.moved = true;
    if (dr.part === "body") {
      const cur = this.pointAt(m.x, m.y, false);
      if (!cur || !dr.start) return;
      const times = this.host.times();
      const bs = this.host.barSec();
      let di = Math.round(timeToIndex(times, cur.t, bs) - timeToIndex(times, dr.start.t, bs));
      let dp = cur.p - dr.start.p;
      if (shift) {
        // only across (same prices) or only up and down (same times)
        if (lockAxis(m.x - dr.x0, m.y - dr.y0) === "h") dp = 0;
        else di = 0;
      }
      if (d.kind === "regression") dp = 0; // the bars it is fitted to set its prices
      const move = (a: Anchor): Anchor => ({ t: indexToTime(times, timeToIndex(times, a.t, bs) + di, bs), p: a.p + dp });
      const b0 = d.b.p;
      d.a = move(dr.orig.a);
      d.b = move(dr.orig.b);
      if (d.kind === "position") d.target += d.b.p - b0;
      if (isChannelDrawing(d)) d.c = { t: d.a.t, p: dr.orig.c.p + dp };
    } else if (isChannelDrawing(d)) {
      if (!this.dragChannel(d, dr, m, snap, shift)) return;
    } else if (d.kind === "position") {
      let pt = this.pointAt(m.x, m.y, snap && !shift);
      if (!pt) return;
      if (shift && dr.part === "a") pt = lockAxis(m.x - dr.x0, m.y - dr.y0) === "h" ? { t: pt.t, p: dr.orig.a.p } : { t: dr.orig.a.t, p: pt.p };
      const dir = posDir(d);
      const tiny = Math.abs(d.a.p) * 1e-6;
      if (dr.part === "stop") {
        // stays on its side; with a direction of its own (on OKX) it may go past the entry (a profit locked in)
        if (d.dir != null) d.b.p = Math.abs(pt.p - d.a.p) < tiny ? d.a.p - dir * tiny : pt.p;
        else d.b.p = dir === 1 ? Math.min(pt.p, d.a.p - tiny) : Math.max(pt.p, d.a.p + tiny);
      } else if (dr.part === "target") {
        d.target = dir === 1 ? Math.max(pt.p, d.a.p) : Math.min(pt.p, d.a.p); // on the profit side
      } else if (dr.part === "edge") {
        d.b.t = Math.max(pt.t, this.barsLater(d.a.t, 1));
      } else {
        // the entry moves between the stop and the take-profit
        const lo = Math.min(d.b.p, d.target);
        const hi = Math.max(d.b.p, d.target);
        d.a = { t: Math.min(pt.t, this.barsLater(d.b.t, -1)), p: Math.min(Math.max(pt.p, lo + tiny), hi - tiny) };
      }
    } else {
      const pt = shift ? this.shiftedHandle(d, dr, m) : this.pointAt(m.x, m.y, snap);
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

  /**
   * Dragging a channel's handle. A regression trend's ends change only the bars it is fitted to. The second line's
   * handles move that line up or down, through the mouse. The first line's ends move as a line's do (Shift: level,
   * upright or 45°); a parallel channel's second line keeps its distance, a level or mirrored one its starting
   * price. False when the mouse is off the chart.
   */
  private dragChannel(d: ChannelDrawing, dr: Drag, m: Mouse, snap: boolean, shift: boolean): boolean {
    if (d.kind === "regression") {
      const pt = this.pointAt(m.x, m.y, false);
      if (!pt) return false;
      if (dr.part === "a") d.a = { t: pt.t, p: d.a.p };
      else d.b = { t: pt.t, p: d.b.p };
      d.c = { ...d.a };
      return true;
    }
    if (dr.part === "c" || dr.part === "d") {
      const pt = this.pointAt(m.x, m.y, snap);
      if (!pt) return false;
      d.c = { t: d.a.t, p: secondThrough(d.kind, d.a, d.b, pt) };
      return true;
    }
    const pt = shift ? this.constrained(dr.part === "a" ? d.b : d.a, m, false) : this.pointAt(m.x, m.y, snap);
    if (!pt) return false;
    if (dr.part === "a") d.a = pt;
    else d.b = pt;
    d.c = { t: d.a.t, p: d.kind === "channel" ? d.a.p + (dr.orig.c.p - dr.orig.a.p) : dr.orig.c.p };
    return true;
  }

  private finishDraft() {
    const d = this.draft;
    this.draft = null;
    this.placing = null;
    // a channel needs its ends at different times; other drawings two different points
    const ok = d && (isChannelDrawing(d) ? d.a.t !== d.b.t : !(d.a.t === d.b.t && d.a.p === d.b.p));
    if (d && ok) {
      this.refit(d);
      this.list.push(d);
      this.selected = d.id;
      this.host.changed(this.list);
    }
    this.setTool("cursor"); // one drawing per pick of the tool, as on TradingView
  }

  // ------------------------------------------------------------------- keys
  private onKey(e: KeyboardEvent, down: boolean) {
    if (e.key === "Shift") {
      this.setShift(down);
      return;
    }
    const hold = this.host.magnet().holdKey;
    if (e.key === hold || (hold === "Alt" && e.key === "AltGraph")) {
      if (hold === "Alt") e.preventDefault(); // keep Alt from moving focus to the window menu
      this.setHold(down);
      return;
    }
    if (!down || !this.active || isTyping(document.activeElement)) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === "KeyZ" || e.code === "KeyY")) {
      e.preventDefault();
      if (this.drag) return;
      const redo = e.code === "KeyY" || e.shiftKey;
      if (this.draft && !redo) this.cancel(); // the drawing being placed goes first
      else if (redo) this.host.redo();
      else this.host.undo();
    } else if (e.key === "Escape") {
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
    if (this.drag && this.drag.part !== "body") this.dragTo(m, snap, this.shiftDown);
    else if (this.tool !== "cursor" && this.draft) this.moveDraft(m, snap, this.shiftDown);
    else if (this.measure && !this.measure.done) {
      const pt = this.pointAt(m.x, m.y, snap);
      if (pt) this.measure.b = pt;
      this.redraw();
    }
  }

  /** Shift pressed or released: apply it to the point under the mouse right away. */
  private setShift(down: boolean) {
    if (this.shiftDown === down) return;
    this.shiftDown = down;
    const m = this.mouse;
    if (!m) return;
    if (this.drag) this.dragTo(m, this.snapping(), down);
    else if (this.tool !== "cursor" && this.draft) this.moveDraft(m, this.snapping(), down);
  }

  /** Esc: take a measurement away, drop the drawing being placed, leave the tool, or clear the selection. */
  cancel() {
    if (this.measure) {
      this.measure = null;
      if (this.tool !== "cursor") this.setTool("cursor");
      else {
        this.refreshHint();
        this.redraw();
      }
    } else if (this.tool !== "cursor") {
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
    if (this.measure?.done) {
      this.host.hint("點一下圖表或按 Esc 清除測量");
    } else if (this.measure) {
      this.host.hint(`測量：點終點，${snap}，Esc 取消`);
    } else if (this.tool === "measure") {
      this.host.hint(`測量：點起點，或按住拖到終點。也可以直接按住 Shift 點圖表，${snap}，Esc 取消`);
    } else if (this.tool === "position") {
      if (!this.draft) this.host.hint(`倉位：點進場價，${snap}，Esc 取消`);
      else if (this.stage === 1) this.host.hint(`倉位：點止損價，在進場下面是多單、上面是空單。按住 Shift 只改價格，${snap}，Esc 取消`);
      else this.host.hint(`倉位：點止盈價，畫面會顯示到止盈為止的 R 線。按住 Shift 只改價格，${snap}，Esc 取消`);
    } else if (this.tool === "regression") {
      const dev = this.host.styleFor("regression") as ChannelStyle;
      if (!this.draft) this.host.hint(`迴歸趨勢：點起點的 K 線，或按住拖到終點。用收盤價算迴歸線，上下各 ${dev.dev} 個標準差。Esc 取消`);
      else this.host.hint("迴歸趨勢：點終點的 K 線，Esc 取消");
    } else if (isChannel(this.tool)) {
      const name = TOOL_INFO[this.tool].name;
      const second = this.tool === "channel" ? "平行的第二條線" : this.tool === "flat" ? "水平的第二條線" : "反方向對稱的第二條線";
      if (!this.draft) this.host.hint(`${name}：點第一條線的起點，或按住拖到終點。${snap}，Esc 取消`);
      else if (this.stage === 1) this.host.hint(`${name}：點第一條線的終點，按住 Shift 畫水平或 45° 線，${snap}，Esc 取消`);
      else this.host.hint(`${name}：移動滑鼠放${second}，點一下完成。${snap}，Esc 取消`);
    } else if (this.tool !== "cursor") {
      const info = TOOL_INFO[this.tool];
      const shift = this.tool === "rect" ? "按住 Shift 畫正方形" : "按住 Shift 畫水平、垂直或 45° 線";
      if (info.points === 1) this.host.hint(`${info.name}：點一下放置，${snap}，Esc 取消`);
      else if (this.draft) this.host.hint(`${info.name}：點第二個點，${shift}，${snap}，Esc 取消`);
      else this.host.hint(`${info.name}：點第一個點，或按住拖到第二個點。${shift}，${snap}，Esc 取消`);
    } else if (this.selected && this.closedOnOkx(this.selected)) {
      this.host.hint("在 OKX 上已經平倉：框停在平倉時間，出場點是實際平倉價。雙擊或右鍵看設定，Delete 刪除");
    } else if (this.selected && this.isLive(this.selected)) {
      this.host.hint("OKX 上的倉位：進場照 OKX，拖止損、止盈放開後會問要不要一起改 OKX，雙擊或右鍵看設定");
    } else if (this.selected && this.find(this.selected)?.kind === "position") {
      this.host.hint("拖曳進場、止損、止盈或右邊的把手調整，拖曳框移動。雙擊或右鍵直接輸入價格、資金和風險，Delete 刪除");
    } else if (this.selected && this.find(this.selected)?.kind === "regression") {
      this.host.hint("拖曳兩端改計算的 K 線範圍，拖曳通道左右移動。雙擊或右鍵改標準差、等比線和外觀，Delete 刪除");
    } else if (this.selected && isChannel(this.find(this.selected)?.kind ?? "")) {
      this.host.hint("拖曳第一條線的端點調整，拖曳第二條線的端點改寬度，拖曳通道移動。雙擊或右鍵加等比線、改外觀，Delete 刪除");
    } else if (this.selected) {
      this.host.hint("拖曳端點調整、拖曳線條移動，按住 Shift 只水平或垂直。Delete 刪除，雙擊或右鍵開設定");
    } else {
      this.host.hint(null);
    }
  }
}
