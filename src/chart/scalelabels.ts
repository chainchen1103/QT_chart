// Price-scale labels the chart library doesn't draw by itself: the countdown to the bar close (under the
// last price label) and the highest / lowest price of the bars on screen, with dotted lines and a 高 / 低 tag,
// as on TradingView. Which labels show is set by right-clicking the price scale.

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
import type { ScaleLabels } from "../settings/model.ts";
import { fmtCountdown } from "../core/timeframes.ts";

export type ScaleLabelHost = {
  chart: IChartApi;
  series: ISeriesApi<"Candlestick">;
  candles(): Candle[];
  barSec(): number;
  fmtPrice(p: number): string;
  labels(): ScaleLabels;
  colors(): { up: string; down: string };
};

const LABEL_H = 17; // height of a price label with the 12 px axis font (font + 2.5 px padding above and below)
const TAG_BG = "#363a45";
const TAG_TEXT = "#d1d4dc";
const TAG_FONT = "11px -apple-system, 'Segoe UI', 'Microsoft JhengHei', sans-serif";

export class ScaleLabelLayer implements ISeriesPrimitive<Time> {
  private requestUpdate: (() => void) | null = null;
  private readonly timer: number;
  private cd = { y: 0, text: "", color: "", visible: false, countdown: false };
  private hl = { hi: 0, lo: 0, hiY: 0, loY: 0, visible: false };

  private readonly axis: ISeriesPrimitiveAxisView[] = [
    {
      // A hair below the last price: the library stacks labels outward from the last price label, so the
      // countdown lands right under it and the other labels (moving averages) are pushed past both.
      coordinate: () => this.cd.y + 0.01,
      text: () => this.cd.text,
      textColor: () => "#ffffff",
      backColor: () => this.cd.color,
      visible: () => this.cd.visible && this.cd.countdown,
      tickVisible: () => false,
    },
    {
      coordinate: () => this.hl.hiY,
      text: () => this.host.fmtPrice(this.hl.hi),
      textColor: () => TAG_TEXT,
      backColor: () => TAG_BG,
      visible: () => this.hl.visible,
    },
    {
      coordinate: () => this.hl.loY,
      text: () => this.host.fmtPrice(this.hl.lo),
      textColor: () => TAG_TEXT,
      backColor: () => TAG_BG,
      visible: () => this.hl.visible,
    },
  ];
  private readonly pane: IPrimitivePaneView[] = [
    { zOrder: () => "normal", renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => this.drawHighLow(t) }) },
  ];

  constructor(private readonly host: ScaleLabelHost) {
    // the countdown ticks every second
    this.timer = window.setInterval(() => {
      const o = this.host.labels();
      if (o.countdown && o.last) this.requestUpdate?.();
    }, 1000);
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.requestUpdate = p.requestUpdate;
  }
  detached() {
    this.requestUpdate = null;
    clearInterval(this.timer);
  }
  priceAxisViews() {
    return this.axis;
  }
  paneViews() {
    return this.pane;
  }
  refresh() {
    this.requestUpdate?.();
  }

  updateAllViews() {
    const o = this.host.labels();
    const cs = this.host.candles();
    const { series } = this.host;
    const last = cs[cs.length - 1];

    this.cd.visible = false;
    if (o.last && last) {
      const y = series.priceToCoordinate(last.close);
      if (y != null) {
        const left = last.time + this.host.barSec() - Date.now() / 1000;
        const colors = this.host.colors();
        const color = last.close >= last.open ? colors.up : colors.down;
        // pad with figure spaces so the countdown is as wide as the price label above it
        const cd = fmtCountdown(left);
        const text = cd + "\u2007".repeat(Math.max(0, this.host.fmtPrice(last.close).length - cd.length));
        this.cd = { y, text, color, visible: true, countdown: o.countdown };
      }
    }

    this.hl.visible = false;
    const r = o.highLow && cs.length ? this.host.chart.timeScale().getVisibleLogicalRange() : null;
    if (r) {
      const from = Math.max(0, Math.ceil(r.from));
      const to = Math.min(cs.length - 1, Math.floor(r.to));
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = from; i <= to; i++) {
        if (cs[i].high > hi) hi = cs[i].high;
        if (cs[i].low < lo) lo = cs[i].low;
      }
      const hiY = to >= from ? series.priceToCoordinate(hi) : null;
      const loY = to >= from ? series.priceToCoordinate(lo) : null;
      if (hiY != null && loY != null) this.hl = { hi, lo, hiY, loY, visible: true };
    }
  }

  private drawHighLow(target: CanvasRenderingTarget2D) {
    if (!this.hl.visible) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.strokeStyle = "rgba(178,181,190,0.45)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      for (const y of [this.hl.hiY, this.hl.loY]) {
        const yy = Math.round(y) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(mediaSize.width, yy);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // 高 / 低 tag just left of the price scale, as on TradingView
      ctx.font = TAG_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const w = 18;
      const h = LABEL_H - 1;
      for (const [y, t] of [[this.hl.hiY, "高"], [this.hl.loY, "低"]] as const) {
        const x = mediaSize.width - w;
        ctx.fillStyle = TAG_BG;
        ctx.fillRect(x, Math.round(y - h / 2), w, h);
        ctx.fillStyle = TAG_TEXT;
        ctx.fillText(t, x + w / 2, y + 0.5);
      }
      ctx.restore();
    });
  }
}
