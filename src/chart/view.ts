// One chart: candles and volume, time labels, colors, and the price-scale labels the library draws itself.
// Indicators, drawings and alerts attach to `candles` from outside. The chart is see-through: the background
// color and picture behind it are the same for every chart (backdrop.ts).

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
import { MONO_FONT, THEME } from "../ui/theme.ts";

export type ChartViewOptions = {
  /** The chart's own element. */
  el: HTMLElement;
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
  /** Candle colors set by Pine scripts (barcolor), by bar; null: the usual up / down colors. */
  private barColors: (string | null)[] | null = null;
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
        fontFamily: MONO_FONT, // figures on the axes, like every price in the app
        panes: { separatorColor: THEME.line, separatorHoverColor: THEME.hover, enableResize: true },
        attributionLogo: false, // the credit TradingView's licence asks for is in the status bar instead
      },
      grid: { vertLines: { color: a.grid }, horzLines: { color: a.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: THEME.line },
      timeScale: { borderColor: THEME.line, timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 8, tickMarkFormatter: fmtTick },
      localization: { timeFormatter: (t: Parameters<typeof fmtChartTime>[0]) => fmtChartTime(t, o.daily()) },
    });
    this.candles = this.chart.addSeries(CandlestickSeries, {
      upColor: a.up, downColor: a.down, borderVisible: false, wickUpColor: a.up, wickDownColor: a.down,
    });
    this.volume = this.chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false }, 1);
    // volume takes a share of the height (a fixed height would crowd a small chart in a split layout)
    const [prices, volume] = this.chart.panes();
    prices?.setStretchFactor(0.85);
    volume?.setStretchFactor(0.15);
  }

  private bar = (c: Candle, i: number) => {
    const color = this.barColors?.[i];
    const b = { time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close };
    return color ? { ...b, color, wickColor: color, borderColor: color } : b;
  };
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
    this.candles.update(this.bar(c, this.bars.length - 1));
    this.volume.update(this.vol(c));
  }

  /** Candle colors from Pine scripts' barcolor() (null: none). Redraws only what changed. */
  setBarColors(colors: (string | null)[] | null) {
    const old = this.barColors;
    const n = this.bars.length;
    if (!old && !colors) return;
    this.barColors = colors;
    if (old && colors && old.length === colors.length && colors.length === n) {
      let k = 0;
      while (k < n - 1 && old[k] === colors[k]) k++;
      if (k >= n - 1) {
        if (n && old[n - 1] !== colors[n - 1]) this.candles.update(this.bar(this.bars[n - 1], n - 1));
        return;
      }
    }
    this.candles.setData(this.bars.map(this.bar));
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
  /** Pixels per bar right now: the zoom. (The library keeps it to itself; its visible range spans
   *  width / spacing bars, counted from the first to the last bar inclusive.) */
  barSpacing(): number | null {
    const ts = this.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    const w = ts.width();
    return r && w > 0 ? w / (r.to - r.from + 1) : null;
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

  /** Text, grid and candle colors. */
  applyAppearance() {
    const a = this.o.appearance.get();
    this.chart.applyOptions({ layout: { textColor: a.text }, grid: { vertLines: { color: a.grid }, horzLines: { color: a.grid } } });
    this.candles.applyOptions({ upColor: a.up, downColor: a.down, wickUpColor: a.up, wickDownColor: a.down });
    this.volume.setData(this.bars.map(this.vol));
  }

  /** The library's own labels: last price and its line, volume, crosshair price. */
  applyLabels() {
    const l = this.o.labels.get();
    this.candles.applyOptions({ lastValueVisible: l.last, priceLineVisible: l.last });
    this.volume.applyOptions({ lastValueVisible: l.volume });
    this.chart.applyOptions({ crosshair: { horzLine: { labelVisible: l.crosshair } } });
  }
}
