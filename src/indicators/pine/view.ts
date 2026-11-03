// One Pine script on one chart: its plots as series (on the price pane, or in a pane of its own below), the
// layer painting everything else, its legend line, and its last result (for the inputs and the strategy
// report). Built again from each run's result; series only get what changed (a live tick: the last point).

import {
  AreaSeries,
  HistogramSeries,
  LineSeries,
  LineType,
  type IChartApi,
  type ISeriesApi,
  type PriceFormat,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "../../core/api.ts";
import { el } from "../../ui/dom.ts";
import { cssColor, DEFAULT_BLUE } from "../../pine/runtime.ts";
import { DISPLAY, type PlotOut } from "../../pine/outputs.ts";
import type { RunResult, ScriptInfo } from "../../pine/index.ts";
import { emptyScene, PineLayer, type PineScene } from "./layer.ts";

export type ViewHost = {
  chart: IChartApi;
  candles: ISeriesApi<"Candlestick">;
  /** The element the pane legends go in (positioned over the chart). */
  legendBox: HTMLElement;
  bars(): Candle[];
  times(): number[];
  barSec(): number;
  toChartTime(t: number): UTCTimestamp;
  fmtPrice(p: number): string;
  tick(): number;
};

type Kind = "line" | "hist" | "area";
type Point = { time: Time; value?: number; color?: string; lineColor?: string; topColor?: string; bottomColor?: string };
type PlotSeries = { key: string; kind: Kind; series: ISeriesApi<SeriesType>; data: Point[]; plot: PlotOut };

const TRANSPARENT = "rgba(0,0,0,0)";
const kindOf = (style: string): Kind => (style === "histogram" || style === "columns" ? "hist" : style === "area" || style === "areabr" ? "area" : "line");
const LEGEND_FONT_PX = 12;

/** "RSI 14 close" → shown in the legend; values formatted like the series. */
export type LegendItem = { text: string; color: string | null };

export class ScriptView {
  readonly id: string;
  name = "";
  result: RunResult | null = null;
  info: ScriptInfo | null = null;
  /** The script can't run (with why), or is waiting for other timeframes' bars. */
  error: string | null = null;
  loading = false;
  private overlay = true;
  private plots: PlotSeries[] = [];
  /** Paints on the price pane (overlay scripts, and every strategy's trade marks). */
  private mainLayer: PineLayer | null = null;
  /** Paints on the script's own pane, attached to its first plot (or an invisible anchor). */
  private paneLayer: PineLayer | null = null;
  private paneHost: ISeriesApi<SeriesType> | null = null;
  private anchor: ISeriesApi<"Line"> | null = null;
  private legendEl: HTMLElement | null = null;
  private fmt: (v: number) => string;
  private readonly h: ViewHost;

  constructor(h: ViewHost, id: string) {
    this.h = h;
    this.id = id;
    this.fmt = h.fmtPrice;
  }

  /** Show a run's result (null with an error: show nothing but the error). */
  update(result: RunResult | null, info: ScriptInfo | null, name: string, error: string | null, loading: boolean) {
    this.name = name;
    this.info = info;
    this.error = error;
    this.loading = loading;
    if (!result || !result.ok) {
      this.result = result;
      this.clear();
      return;
    }
    this.result = result;
    const overlay = result.decl.overlay;
    if (overlay !== this.overlay) {
      this.clear();
      this.overlay = overlay;
    }
    this.fmt = formatterOf(result, this.h);
    this.syncPlots(result);
    this.syncLayers(result);
  }

  /** Remove everything from the chart. */
  destroy() {
    this.clear();
    this.legendEl?.remove();
    this.legendEl = null;
  }

  private clear() {
    const { chart, candles } = this.h;
    if (this.mainLayer) candles.detachPrimitive(this.mainLayer);
    this.mainLayer = null;
    if (this.paneLayer && this.paneHost) this.paneHost.detachPrimitive(this.paneLayer);
    this.paneLayer = null;
    this.paneHost = null;
    for (const p of this.plots) chart.removeSeries(p.series);
    this.plots = [];
    if (this.anchor) chart.removeSeries(this.anchor);
    this.anchor = null;
  }

  // ------------------------------------------------------------------- plots
  /** Index of the script's own pane (made with its first series). */
  private paneIndex(): number {
    const first = this.plots[0]?.series ?? this.anchor;
    return first ? first.getPane().paneIndex() : this.h.chart.panes().length;
  }

  private syncPlots(r: RunResult) {
    const { chart } = this.h;
    const shown = r.out.plots.filter((p) => p.display & DISPLAY.pane);
    // series of plots that are gone (or changed kind)
    this.plots = this.plots.filter((ps) => {
      const p = shown.find((x) => x.key === ps.key);
      if (p && kindOf(p.style) === ps.kind) return true;
      chart.removeSeries(ps.series);
      return false;
    });
    const fresh = !this.overlay && !this.plots.length && !this.anchor;
    for (const p of shown) {
      const kind = kindOf(p.style);
      let ps = this.plots.find((x) => x.key === p.key);
      if (!ps) {
        const pane = this.overlay || p.overlay ? 0 : this.paneIndex();
        const series = (kind === "hist" ? chart.addSeries(HistogramSeries, {}, pane) : kind === "area" ? chart.addSeries(AreaSeries, {}, pane) : chart.addSeries(LineSeries, {}, pane)) as ISeriesApi<SeriesType>;
        ps = { key: p.key, kind, series, data: [], plot: p };
        this.plots.push(ps);
        if (fresh && this.plots.length === 1) series.getPane().setStretchFactor(0.3);
      }
      ps.plot = p;
      ps.series.applyOptions(this.optionsFor(p, kind, r));
      this.push(ps, this.points(p, kind));
    }
  }

  private optionsFor(p: PlotOut, kind: Kind, r: RunResult) {
    const c = firstColor(p) ?? cssColor(DEFAULT_BLUE)!;
    const priceFormat: PriceFormat =
      p.format === "volume" || r.decl.format === "volume"
        ? { type: "volume", precision: 2, minMove: 0.01 }
        : { type: "custom", minMove: minMoveOf(p, r, this.h.tick()), formatter: this.fmtFor(p) };
    // the last value on the price scale: not for plots kept off it, or whose newest color is see-through
    const lastColor = cssColor(lastValid(p));
    const common = { title: "", lastValueVisible: !!(p.display & DISPLAY.scale) && !!lastColor, priceLineVisible: p.trackprice, priceFormat };
    if (kind === "hist") return { ...common, color: c, base: p.histbase };
    if (kind === "area") return { ...common, lineColor: c, topColor: withAlpha(c, 0.28), bottomColor: withAlpha(c, 0.02), lineWidth: lw(p.linewidth) };
    const dots = p.style === "circles" || p.style === "cross";
    const step = p.style.startsWith("stepline");
    return {
      ...common,
      color: c,
      lineWidth: lw(p.linewidth),
      lineType: step ? LineType.WithSteps : LineType.Simple,
      lineVisible: !dots,
      pointMarkersVisible: dots,
      pointMarkersRadius: dots ? Math.max(1.5, p.linewidth + 0.5) : undefined,
      crosshairMarkerVisible: !dots,
    };
  }

  private fmtFor(p: PlotOut): (v: number) => string {
    if (p.precision != null) {
      const d = Math.max(0, Math.min(10, p.precision));
      return (v) => v.toFixed(d);
    }
    if (p.format === "percent") return (v) => `${v.toFixed(2)}%`;
    return this.fmt;
  }

  /** The plot's values as chart points: shifted by its offset, na as a gap (line breaks) or skipped (lines
   *  join across), colors per bar. A line's segment into a bar takes that bar's color, as on TradingView. */
  private points(p: PlotOut, kind: Kind): Point[] {
    const times = this.h.times();
    const n = Math.min(times.length, p.values.length);
    const sec = this.h.barSec();
    const toT = this.h.toChartTime;
    const out: Point[] = [];
    const breaks = p.style === "linebr" || p.style === "steplinebr" || p.style === "areabr" || kind === "hist";
    const dots = p.style === "circles" || p.style === "cross";
    for (let i = 0; i < n; i++) {
      const d = i + p.offset;
      if (d < 0) continue;
      const t = d < n ? times[d] : times[n - 1] + (d - n + 1) * sec;
      const v = p.values[i];
      if (!(v === v)) {
        if (breaks || dots) out.push({ time: toT(t) });
        continue;
      }
      const c = cssColor(p.colors[i]) ?? TRANSPARENT;
      if (kind === "area") out.push({ time: toT(t), value: v, lineColor: c, topColor: withAlpha(c, 0.28), bottomColor: withAlpha(c, 0.02) });
      else out.push({ time: toT(t), value: v, color: c });
    }
    if (kind === "line" && !dots) {
      // the segment from point k to k+1 is drawn in point k's color: give each point the color of the next one
      for (let k = 0; k < out.length - 1; k++) {
        const next = out[k + 1];
        if (next.value !== undefined && out[k].value !== undefined) out[k].color = next.color;
      }
    }
    return out;
  }

  /** New points to a series: only the last point when that is all that changed (a live tick, a new bar). */
  private push(ps: PlotSeries, data: Point[]) {
    const old = ps.data;
    ps.data = data;
    const same = (a: Point, b: Point) => a.time === b.time && a.value === b.value && a.color === b.color && a.lineColor === b.lineColor;
    const n = data.length;
    const m = old.length;
    if (m && (n === m || n === m + 1)) {
      const fixed = n === m ? n - 1 : m; // these must not have changed
      let k = 0;
      while (k < fixed && same(old[k], data[k])) k++;
      if (k === fixed) {
        if (n === m && same(old[n - 1], data[n - 1])) return;
        ps.series.update(data[n - 1] as never);
        return;
      }
    }
    ps.series.setData(data as never);
  }

  // ------------------------------------------------------------------- layers
  private syncLayers(r: RunResult) {
    const o = r.out;
    const trades = r.strategy?.fills ?? [];
    const scene = (onPrice: boolean, forced = false): PineScene => ({
      ...emptyScene(onPrice),
      bgs: o.bgs.filter((b) => b.kind === "bg" && b.overlay === forced),
      fills: o.fills,
      shapes: o.shapes.filter((s) => s.overlay === forced),
      arrows: o.arrows,
      candles: o.candles,
      hlines: o.hlines,
      lines: o.lines,
      labels: o.labels,
      boxes: o.boxes,
      tables: o.tables,
      linefills: o.linefills,
      polylines: o.polylines,
      fmtQty: fmtQty,
    });
    const { candles, chart } = this.h;
    const layerHost = { chart, bars: this.h.bars, times: this.h.times, barSec: this.h.barSec };
    if (this.overlay) {
      const all = scene(true);
      const s = { ...all, bgs: o.bgs.filter((b) => b.kind === "bg"), shapes: o.shapes, trades };
      if (!this.mainLayer) {
        this.mainLayer = new PineLayer(layerHost, s);
        candles.attachPrimitive(this.mainLayer);
      } else this.mainLayer.set(s);
      return;
    }
    // own pane: everything there; the trade marks (and what is forced on the price pane) go on the price pane
    const forced = scene(true, true);
    if (trades.length || forced.bgs.length || forced.shapes.length) {
      const marks = { ...emptyScene(true), bgs: forced.bgs, shapes: forced.shapes, trades, fmtQty };
      if (!this.mainLayer) {
        this.mainLayer = new PineLayer(layerHost, marks);
        candles.attachPrimitive(this.mainLayer);
      } else this.mainLayer.set(marks);
    } else if (this.mainLayer) {
      candles.detachPrimitive(this.mainLayer);
      this.mainLayer = null;
    }
    const own = scene(false);
    const hasPlots = this.plots.length > 0;
    if (!hasPlots && !this.anchor) {
      // nothing plotted: an invisible series holds the pane and its price scale
      this.anchor = chart.addSeries(LineSeries, { lineVisible: false, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, pointMarkersVisible: false }, chart.panes().length);
      this.anchor.getPane().setStretchFactor(0.3);
    }
    if (hasPlots && this.anchor) {
      chart.removeSeries(this.anchor);
      this.anchor = null;
    }
    if (this.anchor) {
      const range = sceneRange(own);
      const times = this.h.times();
      const mid = range ? (range[0] + range[1]) / 2 : 0;
      this.anchor.setData(times.map((t) => ({ time: this.h.toChartTime(t), value: mid })));
    }
    const host = this.plots[0]?.series ?? this.anchor;
    if (!host) return;
    if (this.paneHost !== host) {
      if (this.paneLayer && this.paneHost) this.paneHost.detachPrimitive(this.paneLayer);
      this.paneLayer = new PineLayer(layerHost, own, true);
      host.attachPrimitive(this.paneLayer);
      this.paneHost = host;
    } else this.paneLayer!.set(own);
  }

  // ------------------------------------------------------------------- legend
  /** Name (with the inputs, like TradingView) and values at bar i. */
  legend(i: number): LegendItem[] {
    const items: LegendItem[] = [];
    const r = this.result;
    const title = r?.decl.shorttitle || r?.decl.title || this.info?.title || this.name || "Pine";
    const args = r ? legendInputs(r) : "";
    items.push({ text: args ? `${title} ${args}` : title, color: null });
    if (this.error) {
      items.push({ text: `⚠ ${this.error}`, color: "#ef5350" });
      return items;
    }
    if (this.loading) items.push({ text: "載入中…", color: null });
    if (!r) return items;
    for (const w of r.warnings.slice(0, 1)) items.push({ text: `⚠ ${w}`, color: "#f0b90b" });
    for (const ps of this.plots) {
      const p = ps.plot;
      if (!(p.display & DISPLAY.legend)) continue;
      const j = i - p.offset;
      const v = j >= 0 && j < p.values.length ? p.values[j] : NaN;
      items.push({ text: v === v ? this.fmtFor(p)(v) : "∅", color: cssColor(p.colors[j]) ?? firstColor(p) });
    }
    return items;
  }

  /** Overlay scripts: its legend line goes in the chart's legend; scripts in their own pane get it at the
   *  top of that pane. */
  get inOwnPane(): boolean {
    return !this.overlay && (this.plots.length > 0 || !!this.anchor);
  }

  renderPaneLegend(i: number) {
    if (!this.inOwnPane) {
      this.legendEl?.remove();
      this.legendEl = null;
      return;
    }
    const pane = (this.plots[0]?.series ?? this.anchor)!.getPane();
    const paneEl = pane.getHTMLElement();
    const box = this.h.legendBox;
    if (!this.legendEl) {
      this.legendEl = el("div", "legend pine-pane-legend");
      box.append(this.legendEl);
    }
    const top = paneEl ? paneEl.getBoundingClientRect().top - box.getBoundingClientRect().top : 0;
    this.legendEl.style.top = `${Math.round(top + 4)}px`;
    fillLegend(this.legendEl, this.legend(i));
  }
}

/** The inputs shown after a script's name: numbers, texts, sources and timeframes ("14 close"). */
function legendInputs(r: RunResult): string {
  const parts: string[] = [];
  for (const d of r.inputs) {
    if (!d.legend || !["int", "float", "string", "source", "timeframe", "enum", "symbol"].includes(d.kind)) continue;
    const v = d.value;
    parts.push(typeof v === "number" ? String(Number(v.toFixed(6))) : v == null ? "" : String(v));
    if (parts.length >= 6) break;
  }
  return parts.filter(Boolean).join(" ");
}

/** Write legend items into an element: the name, then the values in their colors. */
export function fillLegend(box: HTMLElement, items: LegendItem[]) {
  box.replaceChildren();
  items.forEach((it, k) => {
    const s = el("span", k === 0 ? "name" : "", k === 0 ? it.text : `${it.text}  `);
    if (it.color) s.style.color = it.color;
    box.append(s);
  });
  box.style.fontSize = `${LEGEND_FONT_PX}px`;
}

function lw(w: number): 1 | 2 | 3 | 4 {
  return Math.max(1, Math.min(4, Math.round(w))) as 1 | 2 | 3 | 4;
}
/** Color of the newest bar that has a value. */
function lastValid(p: PlotOut): number {
  for (let i = p.values.length - 1; i >= 0; i--) if (p.values[i] === p.values[i]) return p.colors[i];
  return NaN;
}
function firstColor(p: PlotOut): string | null {
  for (let i = p.colors.length - 1; i >= 0; i--) {
    const c = cssColor(p.colors[i]);
    if (c) return c;
  }
  return null;
}
function withAlpha(css: string, k: number): string {
  const m = /rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\)/.exec(css.replace(/\s/g, ""));
  if (!m) return css;
  const a = m[4] === undefined ? 1 : Number(m[4]);
  return `rgba(${m[1]},${m[2]},${m[3]},${Math.round(a * k * 1000) / 1000})`;
}
function fmtQty(q: number): string {
  return Number(q.toFixed(q >= 100 ? 2 : q >= 1 ? 4 : 6)).toString();
}
function minMoveOf(p: PlotOut, r: RunResult, tick: number): number {
  const prec = p.precision ?? r.decl.precision;
  if (prec != null) return 10 ** -Math.max(0, Math.min(10, prec));
  return tick > 0 ? tick : 0.01;
}
function formatterOf(r: RunResult, h: ViewHost): (v: number) => string {
  const prec = r.decl.precision;
  if (prec != null) {
    const d = Math.max(0, Math.min(10, prec));
    return (v) => v.toFixed(d);
  }
  if (r.decl.format === "percent") return (v) => `${v.toFixed(2)}%`;
  return h.fmtPrice;
}

/** Prices drawn by a scene (hlines, drawings), for a pane that has no plots. */
function sceneRange(s: PineScene): [number, number] | null {
  const v: number[] = [];
  for (const h of s.hlines) if (h.price === h.price) v.push(h.price);
  for (const l of s.lines) v.push(l.y1, l.y2);
  for (const l of s.labels) v.push(l.y);
  for (const b of s.boxes) v.push(b.top, b.bottom);
  const ok = v.filter((x) => x === x && Number.isFinite(x));
  if (!ok.length) return null;
  return [Math.min(...ok), Math.max(...ok)];
}
