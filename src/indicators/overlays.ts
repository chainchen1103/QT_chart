// Indicators computed from the bars: moving averages, and FVG / order-block zones. Each one runs on the
// chart's timeframe (the default) or on a timeframe of its own; SourceStore supplies the bars.

import { LineSeries, LineType, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Candle } from "../core/api.ts";
import { movingAverage, warmupBars } from "./ma.ts";
import type { FvgConf, Groups, MaConf, MaOptions, ObConf, ScaleLabels, SrConf } from "../settings/model.ts";
import { SourceStore } from "./sources.ts";
import { alignToChart, tfLabel, tfSec } from "../core/timeframes.ts";
import { ZoneLayer, type DrawZone } from "./zonelayer.ts";
import { findFvgs, findLevels, findOrderBlocks, pickZones, type Zone } from "./zones.ts";

/** ok; loading (bars on the way); lower (timeframe smaller than the chart's: not shown); error. */
export type IndState = "ok" | "loading" | "lower" | "error";

export type OverlaySettings = {
  groups: Groups; mas: MaConf[]; maOptions: MaOptions; fvgs: FvgConf[]; obs: ObConf[]; srs: SrConf[]; labels: ScaleLabels;
};

export type MaLegend = { label: string; color: string; state: IndState; value: number | null };
/** One FVG / OB / support-resistance set: how many are running each way ("多 3 空 2", "撐 3 阻 2"). */
export type ZoneLegend = {
  label: string; state: IndState; up: number; down: number; upColor: string; downColor: string; upText: string; downText: string;
};

type MaLine = { conf: MaConf; series: ISeriesApi<"Line">; values: (number | null)[]; state: IndState; stepped: boolean };

/** "EMA20", or "EMA50 4時" when the average runs on its own timeframe. */
const maName = (m: MaConf) => `${m.kind}${m.length}${m.tf ? " " + tfLabel(m.tf) : ""}`;

/** Bars of the zone's timeframe loaded before the chart's first bar, to find zones still running from there. */
const ZONE_WARMUP = 300;

export type OverlayHost = {
  chart: IChartApi;
  series: ISeriesApi<"Candlestick">;
  toChartTime: (t: number) => UTCTimestamp;
  fmtPrice: (p: number) => string;
  settings: () => OverlaySettings;
  /** Values changed outside a live tick (bars arrived, settings changed): refresh the legend. */
  changed: () => void;
};

export class Overlays {
  readonly sources: SourceStore;
  private bar = "";
  private candles: Candle[] = [];
  private times: number[] = [];
  private lines: MaLine[] = [];
  private zoneLegend: ZoneLegend[] = [];
  private readonly zoneLayer: ZoneLayer;
  private redrawTimer = 0;
  private queued = false;

  constructor(private readonly h: OverlayHost) {
    this.sources = new SourceStore(() => this.queueRefresh());
    this.zoneLayer = new ZoneLayer({ chart: h.chart, series: h.series, times: () => this.times, barSec: () => tfSec(this.bar) });
    h.series.attachPrimitive(this.zoneLayer);
  }

  // ------------------------------------------------------------------- chart lifecycle
  setSymbol(inst: string) {
    this.sources.reset(inst);
  }
  setBar(bar: string) {
    this.bar = bar;
    this.sources.dropBelow(tfSec(bar));
  }
  /** New chart data (first load, older history, after a gap). `candles` stays shared with the chart. */
  setData(candles: Candle[]) {
    this.candles = candles;
    this.times = candles.map((c) => c.time);
    this.sources.seed(this.bar, candles);
    this.refresh(true);
  }
  /** After a gap in the live feed: other timeframes may have missed bars, so they are fetched again. */
  resyncOthers() {
    this.sources.dropExcept(this.bar);
  }
  /** A live candle, after the chart has applied it to the shared `candles`. `draw` false (window hidden): only
   *  keep the other timeframes' bars current; setData redraws everything later. */
  tick(c: Candle, draw = true) {
    if (!this.times.length || c.time > this.times[this.times.length - 1]) this.times.push(c.time);
    this.sources.tick(c, this.bar);
    if (draw) this.refresh(false);
  }

  // ------------------------------------------------------------------- legend
  maLegend(i: number): MaLegend[] {
    return this.lines.map((l) => ({
      label: maName(l.conf),
      color: l.conf.color,
      state: l.state,
      value: l.state === "ok" ? l.values[i] ?? null : null,
    }));
  }
  zonesLegend(): ZoneLegend[] {
    return this.zoneLegend;
  }

  // ------------------------------------------------------------------- refresh
  /** Settings changed: one line series per moving average that is switched on, then recompute all. */
  syncLines() {
    const s = this.h.settings();
    const want = s.groups.ma ? s.mas.filter((m) => m.on) : [];
    for (const l of this.lines) if (!want.some((m) => m.id === l.conf.id)) this.h.chart.removeSeries(l.series);
    const lab = s.labels;
    this.lines = want.map((conf) => {
      const style = { color: conf.color, lastValueVisible: lab.maValues, title: lab.maNames ? maName(conf) : "" };
      const old = this.lines.find((l) => l.conf.id === conf.id);
      if (old) {
        old.conf = conf;
        old.series.applyOptions(style);
        return old;
      }
      const series = this.h.chart.addSeries(LineSeries, {
        ...style, lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false,
      });
      return { conf, series, values: [], state: "loading", stepped: false };
    });
    this.refresh(true);
  }

  /** Recompute everything; `full` redraws every line, otherwise only what a live tick changed. */
  refresh(full: boolean) {
    this.refreshLines(full);
    this.refreshZones();
    if (full) this.h.changed();
  }

  /** Bars arrived for some timeframe: refresh once, on the next frame. */
  private queueRefresh() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.refresh(true);
    });
  }

  private scheduleRedraw() {
    if (this.redrawTimer) return;
    this.redrawTimer = window.setTimeout(() => {
      this.redrawTimer = 0;
      this.refresh(true);
    }, 1000);
  }

  // ------------------------------------------------------------------- moving averages
  private refreshLines(full: boolean) {
    const s = this.h.settings();
    const chartSec = tfSec(this.bar);
    for (const l of this.lines) {
      const src = l.conf.tf || this.bar;
      const srcSec = tfSec(src);
      const stepped = src !== this.bar;
      if (l.stepped !== stepped) {
        l.stepped = stepped;
        l.series.applyOptions({ lineType: stepped ? LineType.WithSteps : LineType.Simple });
      }
      if (srcSec < chartSec) {
        this.clear(l, "lower");
        continue;
      }
      if (this.candles.length) this.sources.ensure(src, this.candles[0].time - warmupBars(l.conf.kind, l.conf.length) * srcSec);
      const bars = this.sources.get(src);
      if (!bars) {
        this.clear(l, this.sources.status(src) === "error" ? "error" : "loading");
        continue;
      }
      const vals = movingAverage(l.conf.kind, l.conf.length, bars.map((c) => c.close));
      const mapped = alignToChart(this.times, chartSec, bars, srcSec, vals, stepped && s.maOptions.waitClose);
      l.state = "ok";
      this.push(l, mapped, full);
    }
  }

  private clear(l: MaLine, state: IndState) {
    l.state = state;
    if (l.values.length) {
      l.values = [];
      l.series.setData([]);
    }
  }

  private point(j: number, v: number | null) {
    const time = this.h.toChartTime(this.times[j]);
    return v == null ? { time } : { time, value: v };
  }

  /** Send new values to a line: only the newest point when that is all that changed. */
  private push(l: MaLine, mapped: (number | null)[], full: boolean) {
    const old = l.values;
    const n = mapped.length;
    if (!full && n > 0 && (n === old.length || n === old.length + 1)) {
      let k = 0;
      const m = Math.min(old.length, n);
      while (k < m && old[k] === mapped[k]) k++;
      if (k === n) return; // nothing changed
      if (k >= n - 1) {
        l.values = mapped;
        l.series.update(this.point(n - 1, mapped[n - 1]));
        return;
      }
      // older points changed too (a larger bar still forming, not waiting for closes): at most once a second
      this.scheduleRedraw();
      return;
    }
    l.values = mapped;
    l.series.setData(mapped.map((v, j) => this.point(j, v)));
  }

  // ------------------------------------------------------------------- zones
  private refreshZones() {
    const s = this.h.settings();
    const chartSec = tfSec(this.bar);
    const draw: DrawZone[] = [];
    const legend: ZoneLegend[] = [];
    const run = (kind: "FVG" | "OB" | "支撐阻力", c: FvgConf | ObConf | SrConf, find: (bars: Candle[]) => Zone[]) => {
      const src = c.tf || this.bar;
      const srcSec = tfSec(src);
      const tfPart = c.tf && c.tf !== this.bar ? ` ${tfLabel(c.tf)}` : "";
      const label = kind + tfPart;
      const levels = kind === "支撐阻力";
      const item: ZoneLegend = {
        label, state: "ok", up: 0, down: 0, upColor: c.up, downColor: c.down, upText: levels ? "撐" : "多", downText: levels ? "阻" : "空",
      };
      legend.push(item);
      if (srcSec < chartSec) {
        item.state = "lower";
        return;
      }
      if (this.candles.length) this.sources.ensure(src, this.candles[0].time - ZONE_WARMUP * srcSec);
      const bars = this.sources.get(src);
      if (!bars) {
        item.state = this.sources.status(src) === "error" ? "error" : "loading";
        return;
      }
      for (const z of pickZones(find(bars), c.maxCount, c.showEnded)) {
        const color = z.dir === 1 ? c.up : c.down;
        if (levels) {
          const name = (z.dir === 1 ? "支撐" : "阻力") + tfPart;
          draw.push({ from: z.from, to: z.to, top: z.top, bottom: z.bottom, color, label: `${name} ${this.h.fmtPrice(z.top)}`, line: true });
        } else {
          draw.push({ from: z.from, to: z.to, top: z.top, bottom: z.bottom, color, label });
        }
        if (z.to == null) {
          if (z.dir === 1) item.up++;
          else item.down++;
        }
      }
    };
    if (s.groups.fvg) for (const c of s.fvgs) if (c.on) run("FVG", c, (b) => findFvgs(b, { body: c.body, minPct: c.minPct }));
    if (s.groups.ob) for (const c of s.obs) if (c.on) run("OB", c, (b) => findOrderBlocks(b, { swing: c.swing, lookback: c.lookback }));
    if (s.groups.sr) for (const c of s.srs) if (c.on) run("支撐阻力", c, (b) => findLevels(b, { swing: c.swing }));
    this.zoneLegend = legend;
    this.zoneLayer.set(draw);
  }
}
