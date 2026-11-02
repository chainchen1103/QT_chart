// Alerts on the chart: a dashed line with its price on the price scale for each price alert that is on, and a
// small bell next to every drawing that has an alert.

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
import { xOfLogical } from "../coords.ts";
import { timeToIndex } from "../fibmath.ts";
import type { Drawing } from "../settings.ts";
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
};

export const ALERT_COLOR = "#f7a600";

type Line = { y: number; price: number };
type Bell = { x: number; y: number };

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
    this.lines = [];
    this.bells = [];
    for (const a of this.host.alerts()) {
      if (!a.on) continue;
      if (a.target.kind === "price") {
        const y = series.priceToCoordinate(a.target.price);
        if (y != null) this.lines.push({ y, price: a.target.price });
        continue;
      }
      const d = this.host.drawing(a);
      if (!d || !times.length) continue;
      const x = xOfLogical(chart, timeToIndex(times, d.a.t, bs));
      const y = series.priceToCoordinate(d.a.p);
      if (x != null && y != null) this.bells.push({ x, y });
    }
    this.axis = this.lines.map((l) => ({
      coordinate: () => l.y,
      text: () => this.host.fmtPrice(l.price),
      textColor: () => "#131722",
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
      for (const l of this.lines) bell(ctx, mediaSize.width - 12, l.y - 9);
      for (const b of this.bells) bell(ctx, b.x + 10, b.y - 14);
      ctx.restore();
    });
  }
}

/** A small bell centered on (x, y), on a dark disc. */
function bell(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(19,23,34,0.85)";
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
