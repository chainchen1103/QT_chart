// Price-scale labels the chart library doesn't draw by itself: the countdown to the bar close (under the
// last price label) and the highest / lowest price of the bars on screen, with dotted lines and a 高 / 低 tag,
// as on TradingView. Which labels show is set by right-clicking the price scale. The tags take their room on
// the chart first (LabelSpace): other labels make way for them.

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
import { MONO_FONT, THEME } from "../ui/theme.ts";
import { PRIO, textWidth, type Box, type LabelSpace } from "./labelspace.ts";

export type ScaleLabelHost = {
  chart: IChartApi;
  series: ISeriesApi<"Candlestick">;
  candles(): Candle[];
  barSec(): number;
  fmtPrice(p: number): string;
  labels(): ScaleLabels;
  colors(): { up: string; down: string };
  /** False in a bar replay: no countdown (the newest bar shown is in the past). */
  live(): boolean;
  space: LabelSpace;
  /** Size of the chart's labels and of the axis text, px. */
  textSize(): number;
  axisSize(): number;
};

/** Height of a price label: the axis font and 2.5 px for every 12 px of it above and below, as the library draws them. */
const priceLabelHeight = (axisPx: number) => Math.round((axisPx * 17) / 12);
const TAG_BG = THEME.hover;
const TAG_TEXT = THEME.text;

export class ScaleLabelLayer implements ISeriesPrimitive<Time> {
  private requestUpdate: (() => void) | null = null;
  private readonly timer: number;
  private cd = { y: 0, text: "", color: "", visible: false, countdown: false };
  private hl = { hi: 0, lo: 0, hiY: 0, loY: 0, visible: false };
  private tagFont = "";

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
        this.cd = { y, text, color, visible: true, countdown: o.countdown && this.host.live() };
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

    // the 高 / 低 tags just left of the price scale, as tall as its labels (or the text, when that is larger)
    const px = this.host.textSize();
    this.tagFont = `${px}px ${MONO_FONT}`;
    const w = Math.max(18, Math.ceil(textWidth(this.tagFont, "高")) + 7);
    const h = Math.max(priceLabelHeight(this.host.axisSize()) - 1, px + 5);
    const x = this.host.chart.timeScale().width() - w;
    const tag = (key: string, y: number) => ({ key, w, h, at: [{ x, y: Math.round(y - h / 2) }], prio: PRIO.fixed });
    this.host.space.set("scale", this.hl.visible ? [tag("hi", this.hl.hiY), tag("lo", this.hl.loY)] : []);
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
      ctx.font = this.tagFont;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const [key, t] of [["hi", "高"], ["lo", "低"]] as const) {
        const b: Box | null = this.host.space.at("scale", key);
        if (!b) continue;
        ctx.fillStyle = TAG_BG;
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.fillStyle = TAG_TEXT;
        ctx.fillText(t, b.x + b.w / 2, b.y + b.h / 2 + 0.5);
      }
      ctx.restore();
    });
  }
}
