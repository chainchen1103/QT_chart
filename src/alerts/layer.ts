// Alerts on the chart: a dashed line with its price on the price scale for each price alert that is on, and a
// small bell next to every drawing that has an alert. The bells take room among the chart's labels
// (LabelSpace): a price alert's at the right end of its line, moving left past the 高 / 低 tags; a drawing's
// next to its first point, on whichever side its labels leave free.

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
import { xOfLogical } from "../chart/coords.ts";
import { PRIO, type LabelAsk, type LabelSpace } from "../chart/labelspace.ts";
import { timeToIndex } from "../drawings/geometry.ts";
import type { Drawing } from "../settings/model.ts";
import type { Alert } from "./model.ts";

export type AlertLayerHost = {
  chart: IChartApi;
  series: ISeriesApi<"Candlestick">;
  /** Alerts of the symbol on screen. */
  alerts(): readonly Alert[];
  drawing(a: Alert): Drawing | undefined;
  times(): number[];
  barSec(): number;
  fmtPrice(p: number): string;
  space: LabelSpace;
};

export const ALERT_COLOR = "#f7a600";
/** A bell's disc. */
const BELL = 16;

/** A price alert's bell: over the right end of its line, else further left along it. */
export function priceBellAsk(key: string, width: number, y: number): LabelAsk {
  return { key, w: BELL, h: BELL, at: [{ x: width - 4 - BELL, y: y - 1 - BELL }], slide: "left", prio: PRIO.scaleBell };
}
/** A drawing's bell: above right of its first point (x, y); else left of it, below right, above left. */
export function drawingBellAsk(key: string, x: number, y: number): LabelAsk {
  return {
    key, w: BELL, h: BELL, prio: PRIO.bell,
    at: [{ x: x + 2, y: y - 6 - BELL }, { x: x - 10 - BELL, y: y - BELL / 2 }, { x: x + 2, y: y + 6 }, { x: x - 10 - BELL, y: y - 6 - BELL }],
  };
}

type Line = { y: number; price: number };
type Bell = { key: string };

export class AlertLayer implements ISeriesPrimitive<Time> {
  private readonly host: AlertLayerHost;
  private requestUpdate: (() => void) | null = null;
  private lines: Line[] = [];
  private bells: Bell[] = [];
  private axis: ISeriesPrimitiveAxisView[] = [];
  private readonly views: IPrimitivePaneView[] = [
    { zOrder: () => "top", renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => this.draw(t) }) },
  ];

  constructor(host: AlertLayerHost) {
    this.host = host;
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
  priceAxisViews() {
    return this.axis;
  }
  redraw() {
    this.requestUpdate?.();
  }

  updateAllViews() {
    const { series, chart } = this.host;
    const times = this.host.times();
    const bs = this.host.barSec();
    const width = chart.timeScale().width();
    this.lines = [];
    this.bells = [];
    const asks: LabelAsk[] = [];
    for (const a of this.host.alerts()) {
      if (!a.on) continue;
      if (a.target.kind === "price") {
        const y = series.priceToCoordinate(a.target.price);
        if (y == null) continue;
        this.lines.push({ y, price: a.target.price });
        const key = String(asks.length);
        this.bells.push({ key });
        asks.push(priceBellAsk(key, width, y));
        continue;
      }
      const d = this.host.drawing(a);
      if (!d || !times.length) continue;
      const x = xOfLogical(chart, timeToIndex(times, d.a.t, bs));
      const y = series.priceToCoordinate(d.a.p);
      if (x == null || y == null) continue;
      const key = String(asks.length);
      this.bells.push({ key });
      asks.push(drawingBellAsk(key, x, y));
    }
    this.host.space.set("alerts", asks);
    this.axis = this.lines.map((l) => ({
      coordinate: () => l.y,
      text: () => this.host.fmtPrice(l.price),
      textColor: () => "#141415",
      backColor: () => ALERT_COLOR,
    }));
  }

  private draw(target: CanvasRenderingTarget2D) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.strokeStyle = ALERT_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      for (const l of this.lines) {
        const y = Math.round(l.y) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(mediaSize.width, y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      for (const { key } of this.bells) {
        const b = this.host.space.at("alerts", key);
        if (b) bell(ctx, b.x + b.w / 2, b.y + b.h / 2);
      }
      ctx.restore();
    });
  }
}

/** A small bell centered on (x, y), on a dark disc. */
function bell(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(20,20,21,0.85)";
  ctx.fill();
  ctx.fillStyle = ALERT_COLOR;
  ctx.beginPath();
  ctx.moveTo(x - 4.5, y + 2.5);
  ctx.quadraticCurveTo(x - 4.5, y - 5, x, y - 5);
  ctx.quadraticCurveTo(x + 4.5, y - 5, x + 4.5, y + 2.5);
  ctx.lineTo(x + 5.5, y + 3.5);
  ctx.lineTo(x - 5.5, y + 3.5);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y + 5, 1.6, 0, Math.PI * 2);
  ctx.fill();
}
