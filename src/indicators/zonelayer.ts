// Draws price zones (FVG, order blocks) as boxes under the candles: from the bar where a zone starts to the
// bar that ended it, or to the right edge while it is still running. Levels (support and resistance) are lines
// named at their right end; the names make way for other labels on the chart (LabelSpace), moving left along
// their line past the 高 / 低 tags, drawings' labels and each other.

import type { IChartApi, ISeriesApi, ISeriesPrimitive, IPrimitivePaneView, SeriesAttachedParameter, Time } from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";
import { xOfLogical } from "../chart/coords.ts";
import { PRIO, textWidth, type LabelAsk, type LabelSpace } from "../chart/labelspace.ts";
import { hexToRgba, timeToIndex } from "../drawings/geometry.ts";
import { UI_FONT } from "../ui/theme.ts";

/** A box from `from` to `to` (or the right edge); with `line`, a level drawn as a line at `top`. */
export type DrawZone = { from: number; to: number | null; top: number; bottom: number; color: string; label: string; line?: boolean };

type Geo = { x0: number; x1: number; y0: number; y1: number; color: string; ended: boolean; label: string; line: boolean };

export type ZoneHost = {
  chart: IChartApi;
  series: ISeriesApi<"Candlestick">;
  /** Start times (UTC seconds, ascending) of the chart's bars. */
  times(): number[];
  barSec(): number;
  space: LabelSpace;
  /** Size of the chart's labels, px (zones are named a pixel smaller). */
  textSize(): number;
};

export class ZoneLayer implements ISeriesPrimitive<Time> {
  private zones: DrawZone[] = [];
  private geo: Geo[] = [];
  private font = "";
  private requestUpdate: (() => void) | null = null;
  private readonly views: IPrimitivePaneView[] = [
    { zOrder: () => "bottom", renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => this.draw(t) }) },
    { zOrder: () => "normal", renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => this.drawLines(t) }) },
  ];

  constructor(private readonly host: ZoneHost) {}

  attached(p: SeriesAttachedParameter<Time>) {
    this.requestUpdate = p.requestUpdate;
  }
  detached() {
    this.requestUpdate = null;
  }
  paneViews() {
    return this.views;
  }

  set(zones: DrawZone[]) {
    this.zones = zones;
    this.requestUpdate?.();
  }

  updateAllViews() {
    const { chart, series } = this.host;
    const times = this.host.times();
    const out: Geo[] = [];
    if (times.length) {
      const bs = this.host.barSec();
      const width = chart.timeScale().width();
      for (const z of this.zones) {
        const x0 = xOfLogical(chart, timeToIndex(times, z.from, bs));
        const x1 = z.to == null ? width : xOfLogical(chart, timeToIndex(times, z.to, bs));
        const y0 = series.priceToCoordinate(z.top);
        const y1 = series.priceToCoordinate(z.bottom);
        if (x0 == null || x1 == null || y0 == null || y1 == null) continue;
        if (x1 < 0 || x0 > width) continue; // off screen
        out.push({ x0, x1: Math.max(x1, x0 + 2), y0, y1, color: z.color, ended: z.to != null, label: z.label, line: !!z.line });
      }
    }
    this.geo = out;
    // levels' names: over the right end of the line (under it when that is off the top), else further left along it
    const px = this.host.textSize() - 1;
    this.font = `${px}px ${UI_FONT}`;
    const h = Math.round(px * 1.3);
    const asks: LabelAsk[] = [];
    out.forEach((g, i) => {
      if (!g.line || !g.label) return;
      const w = textWidth(this.font, g.label);
      const x = g.x1 - 4 - w;
      asks.push({
        key: String(i), w, h, prio: PRIO.indicator,
        at: [{ x, y: g.y0 - 2 - h }, { x, y: g.y0 + 2 }],
        slide: "left",
        range: { min: Math.max(g.x0, 0) + 2, max: x },
      });
    });
    this.host.space.set("zones", asks);
  }

  private draw(target: CanvasRenderingTarget2D) {
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const lw = Math.max(1, Math.floor(hr));
      for (const g of this.geo) {
        if (g.line) continue;
        const x = Math.round(g.x0 * hr);
        const y = Math.round(Math.min(g.y0, g.y1) * vr);
        const w = Math.max(1, Math.round(g.x1 * hr) - x);
        const h = Math.max(1, Math.round(Math.abs(g.y1 - g.y0) * vr));
        ctx.fillStyle = hexToRgba(g.color, g.ended ? 0.06 : 0.15);
        ctx.fillRect(x, y, w, h);
        ctx.lineWidth = lw;
        ctx.strokeStyle = hexToRgba(g.color, g.ended ? 0.3 : 0.6);
        ctx.setLineDash(g.ended ? [Math.round(3 * hr), Math.round(3 * hr)] : []);
        ctx.strokeRect(x + lw / 2, y + lw / 2, Math.max(0, w - lw), Math.max(0, h - lw));
      }
      ctx.setLineDash([]);
    });
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.font = this.font;
      ctx.textBaseline = "top";
      const thin = parseFloat(this.font) + 2;
      for (const g of this.geo) {
        if (g.line || !g.label || Math.abs(g.y1 - g.y0) < thin) continue; // too thin to label
        ctx.fillStyle = hexToRgba(g.color, g.ended ? 0.55 : 0.95);
        // at the start of the box; when that is off screen, at its right end (clear of the legend)
        const atStart = g.x0 >= 0;
        ctx.textAlign = atStart ? "left" : "right";
        ctx.fillText(g.label, atStart ? g.x0 + 3 : g.x1 - 3, Math.min(g.y0, g.y1) + 1);
      }
    });
  }

  /** Levels: a line from the swing bar to where it was broken (dashed) or to the right edge, named at the right. */
  private drawLines(target: CanvasRenderingTarget2D) {
    const lines = this.geo.filter((g) => g.line);
    if (!lines.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const lw = Math.max(1, Math.round(1.5 * vr));
      const off = lw % 2 ? 0.5 : 0;
      ctx.lineWidth = lw;
      for (const g of lines) {
        const y = Math.round(g.y0 * vr) + off;
        ctx.strokeStyle = hexToRgba(g.color, g.ended ? 0.45 : 0.9);
        ctx.setLineDash(g.ended ? [Math.round(4 * hr), Math.round(4 * hr)] : []);
        ctx.beginPath();
        ctx.moveTo(Math.round(g.x0 * hr), y);
        ctx.lineTo(Math.round(g.x1 * hr), y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    });
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.font = this.font;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      this.geo.forEach((g, i) => {
        if (!g.line || !g.label) return;
        const b = this.host.space.at("zones", String(i));
        if (!b) return;
        ctx.fillStyle = hexToRgba(g.color, g.ended ? 0.6 : 1);
        ctx.fillText(g.label, b.x, b.y + b.h / 2);
      });
    });
  }
}
