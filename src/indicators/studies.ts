// Bollinger Bands on the prices, and RSI, MACD, KD and ATR each in a pane of its own below the volume: their
// series, the levels across their panes (RSI 70 / 30, KD 80 / 20, alerts), and their legends with a bell (a new
// alert) and a gear (settings). Each runs on the chart's timeframe or one of its own, like the moving averages,
// with bars from the overlays' SourceStore; it is refreshed whenever the overlays are.

import {
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  type AutoscaleInfo,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesPrimitive,
  type IPrimitivePaneView,
  type SeriesAttachedParameter,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { alignToChart, tfLabel, tfSec } from "../core/timeframes.ts";
import { hexToRgba } from "../drawings/geometry.ts";
import { PANE_KINDS, type IndKind, type IndSettings, type PaneKind } from "../settings/indicators.ts";
import { el } from "../ui/dom.ts";
import type { IndState } from "./overlays.ts";
import type { Num } from "./osc.ts";
import type { SourceStore } from "./sources.ts";
import { computeLines, fmtSig, LINES, specFor, specName, warmupOf, type IndSpec } from "./specs.ts";

export const ALERT_LINE = "#f7a600";
const LEVEL_LINE = "rgba(150,150,160,0.55)";

export type StudiesHost = {
  chart: IChartApi;
  candles: ISeriesApi<"Candlestick">;
  sources: SourceStore;
  /** The chart's box: pane legends go in it, at their pane's top. */
  paneBox: HTMLElement;
  settings(): IndSettings;
  /** Lines from a larger timeframe move only when its bar closes. */
  waitClose(): boolean;
  /** Indicator values on the price scale (the setting for the moving averages' values). */
  valuesOnScale(): boolean;
  bar(): string;
  times(): number[];
  toChartTime(t: number): UTCTimestamp;
  fmtPrice(p: number): string;
  /** Alert levels to draw across an indicator's pane. */
  alertLevels(kind: PaneKind): number[];
  /** The legend's bell (a new alert) and gear (settings) of an indicator. */
  bell(kind: IndKind, at: HTMLElement): void;
  gear(kind: IndKind, at: HTMLElement): void;
  /** Panes came, went or changed size: draw the legends again (in their new places). */
  moved(): void;
};

type Line = { key: string; series: ISeriesApi<"Line"> | ISeriesApi<"Histogram">; values: Num[]; color: string };
type Study = {
  kind: IndKind;
  spec: IndSpec;
  lines: Line[];
  state: IndState;
  stepped: boolean;
  levels: IPriceLine[];
  levelKey: string;
  /** Levels the scale always takes in: RSI and KD's bands and alert levels. */
  keep: number[];
  fill: BandFill | null;
  legend: HTMLElement | null;
};

const STATE_TEXT: Record<IndState, string> = { ok: "", loading: "載入中…", lower: "比圖表週期小，不顯示", error: "載入失敗，稍後重試" };

/** Colors of each line, from the settings. */
function colorsOf(kind: IndKind, s: IndSettings): Record<string, string> {
  switch (kind) {
    case "boll":
      return { upper: s.boll.color, basis: s.boll.color, lower: s.boll.color };
    case "rsi":
      return { rsi: s.rsi.color };
    case "macd":
      return { hist: s.macd.up, macd: s.macd.macdColor, signal: s.macd.signalColor };
    case "kd":
      return { k: s.kd.kColor, d: s.kd.dColor };
    case "atr":
      return { atr: s.atr.color };
  }
}

/** The bands drawn across a pane besides alerts: RSI and KD's upper and lower lines. */
function bandsOf(kind: IndKind, s: IndSettings): [number, number] | null {
  if (kind === "rsi") return [s.rsi.upper, s.rsi.lower];
  if (kind === "kd") return [s.kd.upper, s.kd.lower];
  return null;
}

const fmt2 = (v: number) => v.toFixed(2);

export class Studies {
  private readonly h: StudiesHost;
  private readonly studies = new Map<IndKind, Study>();
  private times: number[] = [];

  private readonly resized: ResizeObserver;
  private frame = 0;

  constructor(h: StudiesHost) {
    this.h = h;
    this.resized = new ResizeObserver(() => this.moved());
    this.resized.observe(h.paneBox);
  }

  destroy() {
    this.resized.disconnect();
    cancelAnimationFrame(this.frame);
    for (const k of [...this.studies.keys()]) this.remove(k);
  }

  /** Once the chart has laid its panes out again. */
  private moved() {
    if (this.frame || !this.studies.size) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.h.moved();
    });
  }

  // ------------------------------------------------------------------- refresh
  /** Settings or bars changed (`full`), or a live tick: series made or removed as switched, values recomputed. */
  refresh(full: boolean) {
    const s = this.h.settings();
    this.times = this.h.times();
    for (const kind of ["boll", ...PANE_KINDS] as IndKind[]) {
      if (!s[kind].on) {
        if (this.studies.has(kind)) {
          this.remove(kind);
          this.moved();
        }
        continue;
      }
      const spec = specFor(kind, s);
      let st = this.studies.get(kind);
      if (!st) {
        st = this.make(kind, spec);
        this.studies.set(kind, st);
        full = true;
        this.moved();
      }
      st.spec = spec;
      if (full) this.style(st, s);
      this.compute(st, s[kind].tf, full);
      this.syncLevels(st, s);
    }
  }

  /** The values at chart bar i (AI apps, the legends): each line's, by key. */
  valuesAt(kind: IndKind, i?: number): { spec: IndSpec; state: IndState; values: Record<string, number | null> } | null {
    const st = this.studies.get(kind);
    if (!st) return null;
    const values: Record<string, number | null> = {};
    for (const l of st.lines) values[l.key] = st.state === "ok" ? l.values[i ?? l.values.length - 1] ?? null : null;
    return { spec: st.spec, state: st.state, values };
  }

  /** The indicator pane at this height of the screen (clientY), and the value there. */
  paneAt(clientY: number): { kind: PaneKind; value: number } | null {
    for (const st of this.studies.values()) {
      if (st.kind === "boll") continue;
      const paneEl = st.lines[0].series.getPane().getHTMLElement();
      if (!paneEl) continue;
      const r = paneEl.getBoundingClientRect();
      if (clientY < r.top || clientY > r.bottom) continue;
      const v = st.lines[0].series.coordinateToPrice(clientY - r.top);
      return v == null ? null : { kind: st.kind as PaneKind, value: v };
    }
    return null;
  }

  // ------------------------------------------------------------------- series
  private make(kind: IndKind, spec: IndSpec): Study {
    const { chart } = this.h;
    const st: Study = { kind, spec, lines: [], state: "loading", stepped: false, levels: [], levelKey: "", keep: [], fill: null, legend: null };
    const line = (key: string, pane: number) => ({
      key,
      series: chart.addSeries(LineSeries, { lineWidth: kind === "boll" && key !== "basis" ? 1 : 2, priceLineVisible: false, crosshairMarkerVisible: kind !== "boll" }, pane),
      values: [],
      color: "",
    });
    if (kind === "boll") {
      st.lines = LINES.boll.map((l) => line(l.key, 0));
      st.fill = new BandFill(chart, () => this.bandData(st));
      st.lines[0].series.attachPrimitive(st.fill);
      return st;
    }
    const pane = chart.panes().length; // a pane of its own, at the bottom
    if (kind === "macd") {
      const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false }, pane);
      const at = hist.getPane().paneIndex();
      st.lines = [{ key: "hist", series: hist, values: [], color: "" }, line("macd", at), line("signal", at)];
    } else {
      const first = line(LINES[kind][0].key, pane);
      const at = first.series.getPane().paneIndex();
      st.lines = [first, ...LINES[kind].slice(1).map((l) => line(l.key, at))];
    }
    st.lines[0].series.getPane().setStretchFactor(0.25);
    if (kind === "rsi" || kind === "kd") {
      st.fill = new BandFill(chart, () => this.bandData(st));
      st.lines[0].series.attachPrimitive(st.fill);
      // as TradingView's: the scale takes in the bands and alert levels, so none of them sits off the pane
      st.lines[0].series.applyOptions({
        autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => {
          const r = base();
          if (!r?.priceRange || !st.keep.length) return r;
          return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...st.keep), maxValue: Math.max(r.priceRange.maxValue, ...st.keep) } };
        },
      });
    }
    return st;
  }

  private remove(kind: IndKind) {
    const st = this.studies.get(kind);
    if (!st) return;
    this.studies.delete(kind);
    if (st.fill) st.lines[0].series.detachPrimitive(st.fill);
    for (const l of st.lines) this.h.chart.removeSeries(l.series);
    st.legend?.remove();
  }

  private style(st: Study, s: IndSettings) {
    const colors = colorsOf(st.kind, s);
    const onScale = this.h.valuesOnScale();
    const fmt = st.kind === "rsi" || st.kind === "kd" ? fmt2 : st.kind === "boll" ? this.h.fmtPrice : fmtSig;
    for (const l of st.lines) {
      l.color = colors[l.key];
      if (st.kind === "boll") {
        l.series.applyOptions({ color: hexToRgba(l.color, l.key === "basis" ? 0.9 : 0.8), lastValueVisible: onScale, title: "" });
        continue;
      }
      const priceFormat = { type: "custom" as const, minMove: st.kind === "rsi" || st.kind === "kd" ? 0.01 : 1e-8, formatter: fmt };
      if (l.key === "hist") l.series.applyOptions({ priceFormat, lastValueVisible: false });
      else l.series.applyOptions({ color: l.color, priceFormat, lastValueVisible: true });
    }
  }

  private compute(st: Study, tf: string, full: boolean) {
    const bar = this.h.bar();
    const chartSec = tfSec(bar);
    const src = tf || bar;
    const srcSec = tfSec(src);
    const stepped = src !== bar;
    if (st.stepped !== stepped || full) {
      st.stepped = stepped;
      for (const l of st.lines) if (l.key !== "hist") (l.series as ISeriesApi<"Line">).applyOptions({ lineType: stepped ? LineType.WithSteps : LineType.Simple });
    }
    const times = this.times;
    if (srcSec < chartSec) return this.clear(st, "lower");
    if (times.length) this.h.sources.ensure(src, times[0] - warmupOf(st.spec) * srcSec);
    const bars = this.h.sources.get(src);
    if (!bars) return this.clear(st, this.h.sources.status(src) === "error" ? "error" : "loading");
    const vals = computeLines(st.spec, bars);
    st.state = "ok";
    for (const l of st.lines) {
      const mapped = alignToChart(times, chartSec, bars, srcSec, vals[l.key], stepped && this.h.waitClose());
      this.push(l, mapped, full);
    }
    st.fill?.redraw();
  }

  private clear(st: Study, state: IndState) {
    st.state = state;
    for (const l of st.lines) {
      if (!l.values.length) continue;
      l.values = [];
      l.series.setData([]);
    }
  }

  /** A point of a line: MACD's histogram colored by side, lighter while it shrinks (as TradingView). */
  private point(l: Line, j: number, v: Num, prev: Num) {
    const time = this.h.toChartTime(this.times[j]);
    if (v == null) return { time };
    if (l.key !== "hist") return { time, value: v };
    const s = this.h.settings().macd;
    const grows = prev == null || Math.abs(v) >= Math.abs(prev);
    return { time, value: v, color: hexToRgba(v >= 0 ? s.up : s.down, grows ? 1 : 0.5) };
  }

  /** New values to a line: only the newest point when that is all that changed. */
  private push(l: Line, mapped: Num[], full: boolean) {
    const old = l.values;
    const n = mapped.length;
    l.values = mapped;
    if (!full && n > 0 && (n === old.length || n === old.length + 1)) {
      let k = 0;
      const m = Math.min(old.length, n);
      while (k < m && old[k] === mapped[k]) k++;
      if (k === n) return;
      if (k >= n - 1) {
        l.series.update(this.point(l, n - 1, mapped[n - 1], mapped[n - 2] ?? null) as never);
        return;
      }
    }
    l.series.setData(mapped.map((v, j) => this.point(l, j, v, j > 0 ? mapped[j - 1] : null)) as never);
  }

  // ------------------------------------------------------------------- levels and bands
  /** RSI / KD bands and alert levels across the pane, as price lines on its main series. */
  private syncLevels(st: Study, s: IndSettings) {
    if (st.kind === "boll") return;
    const bands = bandsOf(st.kind, s);
    const alerts = this.h.alertLevels(st.kind as PaneKind);
    const key = JSON.stringify([bands, alerts, st.kind === "macd"]);
    if (key === st.levelKey) return;
    st.levelKey = key;
    const main = st.lines[0].series;
    for (const p of st.levels) main.removePriceLine(p);
    st.levels = [];
    const add = (price: number, color: string, style: LineStyle, label: boolean) =>
      st.levels.push(main.createPriceLine({ price, color, lineStyle: style, lineWidth: 1, axisLabelVisible: label, title: "" }));
    if (bands) for (const b of bands) add(b, LEVEL_LINE, LineStyle.Dashed, false);
    if (st.kind === "macd") add(0, LEVEL_LINE, LineStyle.Dotted, false);
    for (const a of alerts) add(a, ALERT_LINE, LineStyle.Dashed, true);
    st.fill?.redraw();
    const keep = st.kind === "rsi" || st.kind === "kd" ? [...(bands ?? []), ...alerts] : [];
    if (JSON.stringify(keep) !== JSON.stringify(st.keep)) {
      st.keep = keep;
      this.rescale(st);
    }
  }

  /** The scale takes in new levels now, not at the next tick: the newest point again makes it measure anew. */
  private rescale(st: Study) {
    const l = st.lines[0];
    const n = l.values.length;
    if (n) l.series.update(this.point(l, n - 1, l.values[n - 1], l.values[n - 2] ?? null) as never);
  }

  /** Alerts changed: their levels again. */
  alertsChanged() {
    const s = this.h.settings();
    for (const st of this.studies.values()) this.syncLevels(st, s);
  }

  /** What a study's fill covers: Bollinger's space between its bands, RSI and KD's between their levels. */
  private bandData(st: Study): FillData | null {
    const s = this.h.settings();
    if (st.kind === "boll") {
      if (!s.boll.fill || st.state !== "ok") return null;
      const up = st.lines.find((l) => l.key === "upper")!;
      const lo = st.lines.find((l) => l.key === "lower")!;
      return { series: up.series, times: this.times, top: up.values, bottom: lo.values, color: hexToRgba(s.boll.color, 0.06) };
    }
    const bands = bandsOf(st.kind, s);
    if (!bands) return null;
    const color = st.kind === "rsi" ? s.rsi.color : s.kd.kColor;
    return { series: st.lines[0].series, times: this.times, top: Math.max(...bands), bottom: Math.min(...bands), color: hexToRgba(color, 0.06) };
  }

  // ------------------------------------------------------------------- legends
  /**
   * Legends for bar i: Bollinger's line goes in the chart's legend (`box`); the others sit at the top of their
   * own pane. Each ends with a bell (a new alert) and a gear (settings).
   */
  legend(i: number, box: HTMLElement) {
    const s = this.h.settings();
    for (const st of this.studies.values()) {
      const line = el("span", "ma study-line");
      this.fillLegend(line, st, i, s);
      if (st.kind === "boll") {
        box.append(line);
        continue;
      }
      if (!st.legend) {
        st.legend = el("div", "legend study-legend");
        this.h.paneBox.append(st.legend);
      }
      const paneEl = st.lines[0].series.getPane().getHTMLElement();
      const top = paneEl ? paneEl.getBoundingClientRect().top - this.h.paneBox.getBoundingClientRect().top : 0;
      st.legend.style.top = `${Math.round(top + 4)}px`;
      st.legend.replaceChildren(line);
    }
  }

  private fillLegend(line: HTMLElement, st: Study, i: number, s: IndSettings) {
    const tf = s[st.kind].tf;
    const name = specName(st.spec) + (tf && tf !== this.h.bar() ? ` ${tfLabel(tf)}` : "");
    line.append(el("span", "k study-name", name + " "));
    if (st.state !== "ok") line.append(el("span", "muted", STATE_TEXT[st.state] + " "));
    else {
      const fmt = st.kind === "rsi" || st.kind === "kd" ? fmt2 : st.kind === "boll" ? this.h.fmtPrice : fmtSig;
      for (const l of st.lines) {
        const v = l.values[Math.min(i, l.values.length - 1)];
        const name = st.kind === "boll" ? LINES.boll.find((x) => x.key === l.key)!.name.slice(0, 1) + " " : "";
        const t = el("span", "", `${name}${v == null ? "—" : fmt(v)}  `);
        t.style.color = l.key === "hist" && v != null ? (v >= 0 ? s.macd.up : s.macd.down) : l.color;
        line.append(t);
      }
    }
    line.append(legendButton("bell", "新增提醒", (b) => this.h.bell(st.kind, b)), legendButton("gear", "設定", (b) => this.h.gear(st.kind, b)));
  }
}

/** A small icon button in a legend (the legend itself lets the mouse through to the chart). */
export function legendButton(icon: "bell" | "gear", title: string, onClick: (b: HTMLElement) => void): HTMLElement {
  const b = el("button", `legend-btn legend-${icon}`);
  b.type = "button";
  b.title = title;
  b.onmousedown = (e) => e.stopPropagation(); // not a press on the chart
  b.onclick = (e) => {
    e.stopPropagation();
    onClick(b);
  };
  return b;
}

// ----------------------------------------------------------------------------- band fill
type FillData = {
  series: ISeriesApi<SeriesType>;
  times: number[];
  top: Num[] | number;
  bottom: Num[] | number;
  color: string;
};

/** A see-through fill between two lines (or two levels) of a series, under everything else in its pane. */
class BandFill implements ISeriesPrimitive<Time> {
  private requestUpdate: (() => void) | null = null;
  private readonly views: IPrimitivePaneView[];
  private readonly chart: IChartApi;
  private readonly data: () => FillData | null;

  constructor(chart: IChartApi, data: () => FillData | null) {
    this.chart = chart;
    this.data = data;
    this.views = [{ zOrder: () => "bottom", renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => this.draw(t) }) }];
  }
  attached(p: SeriesAttachedParameter<Time>) {
    this.requestUpdate = p.requestUpdate;
  }
  detached() {
    this.requestUpdate = null;
  }
  paneViews() {
    return this.views;
  }
  redraw() {
    this.requestUpdate?.();
  }

  private draw(target: CanvasRenderingTarget2D) {
    const d = this.data();
    if (!d) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const y = (v: number) => d.series.priceToCoordinate(v);
      if (typeof d.top === "number" && typeof d.bottom === "number") {
        const a = y(d.top);
        const b = y(d.bottom);
        if (a == null || b == null) return;
        ctx.fillStyle = d.color;
        ctx.fillRect(0, Math.min(a, b), mediaSize.width, Math.abs(b - a));
        return;
      }
      const top = d.top as Num[];
      const bottom = d.bottom as Num[];
      const ts = this.chart.timeScale();
      const r = ts.getVisibleLogicalRange();
      if (!r) return;
      const from = Math.max(0, Math.floor(r.from) - 1);
      const to = Math.min(d.times.length - 1, Math.ceil(r.to) + 1);
      const up: [number, number][] = [];
      const down: [number, number][] = [];
      const flush = () => {
        if (up.length > 1) {
          ctx.beginPath();
          ctx.moveTo(up[0][0], up[0][1]);
          for (const p of up) ctx.lineTo(p[0], p[1]);
          for (let k = down.length - 1; k >= 0; k--) ctx.lineTo(down[k][0], down[k][1]);
          ctx.closePath();
          ctx.fill();
        }
        up.length = 0;
        down.length = 0;
      };
      ctx.fillStyle = d.color;
      for (let i = from; i <= to; i++) {
        const t = top[i];
        const b = bottom[i];
        const x = ts.logicalToCoordinate(i as never);
        const yt = t == null ? null : y(t);
        const yb = b == null ? null : y(b);
        if (x == null || yt == null || yb == null) {
          flush();
          continue;
        }
        up.push([x, yt]);
        down.push([x, yb]);
      }
      flush();
    });
  }
}

