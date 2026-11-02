// The chart: candles and volume, time labels, colors and the background picture, and the price-scale labels
// the library draws itself. Indicators, drawings and alerts attach to `candles` from outside.

import {
  createChart,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts";
import type { Candle } from "../core/api.ts";
import { fmtChartTime, fmtTick, toChartTime } from "../core/format.ts";
import type { Setting } from "../core/setting.ts";
import { hexToRgba } from "../drawings/geometry.ts";
import type { Appearance, ScaleLabels } from "../settings/model.ts";

export type ChartViewOptions = {
  /** The chart's own element, the box around it (background color) and the background picture layer. */
  el: HTMLElement;
  wrap: HTMLElement;
  picture: HTMLElement;
  appearance: Setting<Appearance>;
  labels: Setting<ScaleLabels>;
  /** True for daily and weekly bars: times then show the day only. */
  daily(): boolean;
};

export class ChartView {
  readonly chart: IChartApi;
  readonly candles: ISeriesApi<"Candlestick">;
  readonly volume: ISeriesApi<"Histogram">;
  private bars: Candle[] = [];
  private pictureUrl = "";
  private readonly o: ChartViewOptions;

  constructor(o: ChartViewOptions) {
    this.o = o;
    const a = o.appearance.get();
    this.chart = createChart(o.el, {
      autoSize: true,
      layout: {
        // see-through: the background color and picture are behind the chart
        background: { type: ColorType.Solid, color: "rgba(0,0,0,0)" },
        textColor: a.text,
        fontSize: 12,
        panes: { separatorColor: "#2a2e39", separatorHoverColor: "#363a45", enableResize: true },
        attributionLogo: false, // the credit TradingView's licence asks for is in the status bar instead
      },
      grid: { vertLines: { color: a.grid }, horzLines: { color: a.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#2a2e39" },
      timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 8, tickMarkFormatter: fmtTick },
      localization: { timeFormatter: (t: Parameters<typeof fmtChartTime>[0]) => fmtChartTime(t, o.daily()) },
    });
    this.candles = this.chart.addSeries(CandlestickSeries, {
      upColor: a.up, downColor: a.down, borderVisible: false, wickUpColor: a.up, wickDownColor: a.down,
    });
    this.volume = this.chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false }, 1);
    this.chart.panes()[1]?.setHeight(110);
  }

  private bar = (c: Candle) => ({ time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close });
  private vol = (c: Candle) => {
    const a = this.o.appearance.get();
    return { time: toChartTime(c.time), value: c.volume, color: hexToRgba(c.close >= c.open ? a.up : a.down, 0.5) };
  };

  /** All bars (first load, older history, after a gap). The array stays the feed's. */
  setBars(bars: Candle[]) {
    this.bars = bars;
    this.candles.setData(bars.map(this.bar));
    this.volume.setData(bars.map(this.vol));
  }
  /** The newest bar changed, or a new one started. */
  update(c: Candle) {
    this.candles.update(this.bar(c));
    this.volume.update(this.vol(c));
  }

  /** Price step and formatting of the symbol on screen (the volume pane keeps its own K / M format). */
  setPriceFormat(minMove: number, fmt: (p: number) => string) {
    this.candles.applyOptions({ priceFormat: { type: "custom", minMove, formatter: fmt } });
  }

  /** Show the last `n` bars with some room on the right (first load). */
  showLatest(n = 160) {
    const len = this.bars.length;
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - n), to: len + 8 });
  }
  /** Keep the same bars on screen after `added` bars were put in front. */
  keepView(added: number, range: { from: number; to: number } | null) {
    if (range) this.chart.timeScale().setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
  }

  /** Price at a y inside the chart element, when that y is in the price pane. */
  priceAt(y: number): number | null {
    const h = this.chart.panes()[0]?.getHeight() ?? 0;
    if (y < 0 || y > h) return null;
    const p = this.candles.coordinateToPrice(y);
    return p == null || !(p > 0) ? null : p;
  }

  /** Colors, and the background picture (shown from a blob: URL, so the page doesn't keep a second copy of the
   *  long data URL in its styles). */
  applyAppearance(picture: string) {
    const a = this.o.appearance.get();
    this.o.wrap.style.backgroundColor = a.bg;
    this.setPicture(picture);
    const pic = this.o.picture.style;
    pic.backgroundSize = a.imageFit === "stretch" ? "100% 100%" : a.imageFit;
    pic.opacity = String(1 - a.imageTransparency / 100);
    this.chart.applyOptions({ layout: { textColor: a.text }, grid: { vertLines: { color: a.grid }, horzLines: { color: a.grid } } });
    this.candles.applyOptions({ upColor: a.up, downColor: a.down, wickUpColor: a.up, wickDownColor: a.down });
    this.volume.setData(this.bars.map(this.vol));
    document.documentElement.style.setProperty("--up", a.up);
    document.documentElement.style.setProperty("--down", a.down);
  }

  private setPicture(dataUrl: string) {
    if (this.pictureUrl) URL.revokeObjectURL(this.pictureUrl);
    this.pictureUrl = dataUrl ? URL.createObjectURL(dataUrlToBlob(dataUrl)) : "";
    this.o.picture.style.backgroundImage = this.pictureUrl ? `url("${this.pictureUrl}")` : "none";
  }

  /** The library's own labels: last price and its line, volume, crosshair price. */
  applyLabels() {
    const l = this.o.labels.get();
    this.candles.applyOptions({ lastValueVisible: l.last, priceLineVisible: l.last });
    this.volume.applyOptions({ lastValueVisible: l.volume });
    this.chart.applyOptions({ crosshair: { horzLine: { labelVisible: l.crosshair } } });
  }
}

/** "data:image/jpeg;base64,…" → Blob, without fetch (the page's content policy allows no fetching). */
function dataUrlToBlob(url: string): Blob {
  const comma = url.indexOf(",");
  const type = url.slice(5, url.indexOf(";")) || "image/jpeg";
  const bin = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
