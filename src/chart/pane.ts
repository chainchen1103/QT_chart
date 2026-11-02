// One chart of the workspace with all its parts: bars (feed), the chart itself (view), indicators, price-scale
// labels, drawings, the alerts on it, its legend and menus. Made when its tab is shown and destroyed when the
// tab is left or the layout drops it, so only the charts on screen take memory. What every chart shares
// (symbols, settings, alerts, toolbars, status bar) comes in through PaneShared; what happens to it goes out
// through PaneEvents.

import type { Candle, Pair } from "../core/api.ts";
import { fmtChartTime, fmtClock, fromChartTime, toChartTime } from "../core/format.ts";
import { AlertLayer } from "../alerts/layer.ts";
import type { TradeStage } from "../alerts/model.ts";
import { drawingAlertSection, type AlertUi } from "../alerts/panel.ts";
import type { AlertService } from "../alerts/service.ts";
import { DrawingLayer } from "../drawings/layer.ts";
import { Overlays } from "../indicators/overlays.ts";
import type { Cell } from "../layout/model.ts";
import { DEFAULT_LINE_STYLE, DEFAULT_RECT_STYLE, type Drawing } from "../settings/model.ts";
import { loadDrawings, saveDrawings, type Settings } from "../settings/store.ts";
import { el } from "../ui/dom.ts";
import { PaneMenus } from "../ui/menus.ts";
import type { StatusBar } from "../ui/statusbar.ts";
import type { Tools } from "../ui/tools.ts";
import type { OrderTarget, Trading } from "../trade/trading.ts";
import type { Catalog } from "./catalog.ts";
import { MarketFeed } from "./feed.ts";
import { Legend } from "./legend.ts";
import { ScaleLabelLayer } from "./scalelabels.ts";
import { ChartView } from "./view.ts";

export type PaneShared = {
  catalog: Catalog;
  settings: Settings;
  alerts: AlertService;
  status: StatusBar;
  tools: Tools;
  trading: Trading;
  /** Open the appearance window at a screen point. */
  appearanceAt(x: number, y: number): void;
};

export type PaneEvents = {
  /** Is this the chart in use (the one the toolbars act on)? */
  inUse(p: ChartPane): boolean;
  /** A press anywhere on the chart: it becomes the chart in use (before the press itself is handled). */
  pressed(p: ChartPane): void;
  /** Its symbol or timeframe changed (its bars are on the way). */
  switched(p: ChartPane): void;
  /** Its latest price changed (live, or bars loaded). */
  priced(p: ChartPane): void;
  /** Its drawings changed (already saved). */
  drawingsChanged(p: ChartPane): void;
  /** Its zoom changed. */
  zoomed(p: ChartPane): void;
};

export class ChartPane {
  readonly el: HTMLElement;
  readonly feed: MarketFeed;
  readonly view: ChartView;
  readonly drawings: DrawingLayer;
  readonly menus: PaneMenus;
  /** The alert windows opened from this chart work on its symbol. */
  readonly alertUi: AlertUi;
  /** This chart's positions and their orders, for the trading parts. */
  readonly orders: OrderTarget;
  private readonly overlays: Overlays;
  private readonly scaleLabels: ScaleLabelLayer;
  private readonly alertLayer: AlertLayer;
  private readonly legend: Legend;
  private readonly s: PaneShared;
  private readonly ev: PaneEvents;
  private readonly offs: (() => void)[] = [];
  /** Bar spacing in pixels (null: the default view). */
  private zoom: number | null;
  private zoomTimer = 0;
  private drawingsFor = ""; // symbol whose drawings are on screen
  private hovering = false; // the crosshair is on a bar: the legend shows that bar
  private stale = false; // live bars came while the window was hidden: redraw once it shows again
  private dead = false;

  /** Made inside `parent` (the grid) at grid `area`, showing `cell`; start() loads it. */
  constructor(parent: HTMLElement, area: string, cell: Cell, shared: PaneShared, events: PaneEvents) {
    this.s = shared;
    this.ev = events;
    this.zoom = cell.zoom;
    const { settings, catalog } = shared;

    this.el = el("div", "pane");
    const chartEl = el("div", "chart");
    const legendBox = el("div", "legend");
    this.el.append(el("div", "pane-bg"), legendBox, chartEl);
    this.el.style.gridArea = area;
    parent.append(this.el); // in its place before the chart measures itself
    // a press anywhere makes this the chart in use, before the drawing layer or the chart sees it
    this.el.addEventListener("mousedown", () => events.pressed(this), true);

    // ------------------------------------------------------------------- bars and the chart
    this.feed = new MarketFeed(
      catalog,
      {
        switching: (symbol) => this.onSwitching(symbol),
        loaded: (kind, added) => this.onLoaded(kind, added),
        tick: (c) => this.onTick(c),
        busy: (on) => shared.status.busy(on),
        error: (text) => shared.status.error(text),
        note: (text) => shared.status.note(text),
      },
      cell.instId,
      cell.bar,
    );
    const feed = this.feed;
    const daily = () => feed.tf.sec >= 86400;
    this.view = new ChartView({ el: chartEl, appearance: settings.appearance, labels: settings.labels, daily });
    const { chart, candles } = this.view;

    this.overlays = new Overlays({
      chart,
      series: candles,
      toChartTime,
      fmtPrice: feed.fmtPrice,
      settings: () => ({
        groups: settings.groups.get(),
        mas: settings.mas.get(),
        maOptions: settings.maOptions.get(),
        fvgs: settings.fvgs.get(),
        obs: settings.obs.get(),
        srs: settings.srs.get(),
        labels: settings.labels.get(),
      }),
      changed: () => {
        if (!this.hovering) this.legend.render();
      },
    });

    this.scaleLabels = new ScaleLabelLayer({
      chart,
      series: candles,
      candles: () => feed.bars,
      barSec: () => feed.tf.sec,
      fmtPrice: feed.fmtPrice,
      labels: () => settings.labels.get(),
      colors: () => ({ up: settings.appearance.get().up, down: settings.appearance.get().down }),
    });
    candles.attachPrimitive(this.scaleLabels);

    // ------------------------------------------------------------------- drawings and alerts
    const inUse = () => events.inUse(this);
    this.alertUi = {
      service: shared.alerts,
      instId: () => feed.instId,
      bar: () => feed.bar,
      price: () => feed.bars[feed.bars.length - 1]?.close ?? null,
      fmtPrice: catalog.fmtPrice,
      fmtClock,
      open: (id) => {
        if (id !== feed.instId) this.switchTo(id, feed.bar);
      },
    };
    this.drawings = new DrawingLayer({
      chart,
      series: candles,
      el: chartEl,
      times: () => feed.times,
      bars: () => feed.bars,
      base: () => feed.instId.split("-")[0],
      barSec: () => feed.tf.sec,
      ohlcAt: (i) => {
        const c = feed.bars[i];
        return c ? [c.open, c.high, c.low, c.close] : null;
      },
      fmtPrice: feed.fmtPrice,
      fmtTime: (t) => fmtChartTime(toChartTime(t), daily()),
      fib: () => settings.fib.get(),
      magnet: () => settings.magnet.get(),
      position: () => settings.position.get(),
      capital: () => shared.trading.capital(),
      orderTag: (d) => shared.trading.tag(d, feed.bars[feed.bars.length - 1]?.time ?? null, feed.fmtPrice),
      orderClicked: (d, x, y) => shared.trading.click(this.orders, d, x, y),
      styleFor: (k) => (k === "rect" ? settings.drawStyles.get().rect ?? DEFAULT_RECT_STYLE : settings.drawStyles.get()[k] ?? DEFAULT_LINE_STYLE),
      changed: (list) => {
        if (!this.drawingsFor) return;
        saveDrawings(this.drawingsFor, list);
        shared.alerts.drawingsChanged(this.drawingsFor, list);
        events.drawingsChanged(this);
      },
      toolChanged: (t) => {
        if (inUse()) shared.tools.paintTools(t);
      },
      magnetActive: (on) => {
        if (inUse()) shared.tools.paintMagnet(on);
      },
      openSettings: (d, x, y) =>
        shared.tools.openSettings(this.drawings, d, x, y, drawingAlertSection(this.alertUi, d, () => this.tradeStage(d))),
      hint: (text) => {
        if (inUse()) shared.status.hint(text);
      },
    });
    candles.attachPrimitive(this.drawings);
    this.orders = {
      alive: () => !this.dead,
      instId: () => feed.instId,
      last: () => feed.bars[feed.bars.length - 1]?.close ?? null,
      fmtPrice: feed.fmtPrice,
      trade: (id) => this.drawings.tradeOf(id),
      positions: () => this.drawings.positions(),
      setOrder: (id, o) => this.drawings.setOrder(id, o),
    };

    this.alertLayer = new AlertLayer({
      chart,
      series: candles,
      alerts: () => (this.drawingsFor ? shared.alerts.forSymbol(this.drawingsFor) : []),
      drawing: (a) => (a.target.kind === "drawing" ? this.drawings.find(a.target.id) : undefined),
      times: () => feed.times,
      barSec: () => feed.tf.sec,
      fmtPrice: feed.fmtPrice,
    });
    candles.attachPrimitive(this.alertLayer);

    // ------------------------------------------------------------------- text and menus
    this.legend = new Legend(feed, this.overlays, legendBox);
    this.menus = new PaneMenus({
      el: chartEl,
      view: this.view,
      feed,
      labels: settings.labels,
      alerts: this.alertUi,
      appearanceAt: shared.appearanceAt,
    });

    chart.subscribeCrosshairMove((p) => {
      this.hovering = p.time !== undefined;
      this.legend.render(this.hovering && p.time !== undefined ? fromChartTime(p.time) : undefined);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (r && r.from < 30) void feed.loadOlder();
      this.watchZoom();
    });

    // ------------------------------------------------------------------- settings → this chart
    this.offs.push(
      settings.mas.watch(() => this.overlays.syncLines()),
      settings.groups.watch(() => this.overlays.syncLines()),
      settings.maOptions.watch(() => this.overlays.refresh(true)),
      settings.fvgs.watch(() => this.overlays.refresh(true)),
      settings.obs.watch(() => this.overlays.refresh(true)),
      settings.srs.watch(() => this.overlays.refresh(true)),
      settings.labels.watch(() => this.applyLabels()),
      settings.appearance.watch(() => this.applyAppearance()),
      settings.fib.watch(() => this.drawings.refresh()),
      settings.magnet.watch(() => this.drawings.refresh()),
      settings.position.watch(() => this.drawings.redraw()),
    );
    this.applyLabels();
  }

  /** Load the first bars. */
  start() {
    void this.feed.switchTo(this.feed.instId, this.feed.bar);
  }

  switchTo(instId: string, bar: string) {
    void this.feed.switchTo(instId, bar);
  }

  /** What to save for this chart. */
  cell(): Cell {
    return { instId: this.feed.instId, bar: this.feed.bar, zoom: this.zoom };
  }
  /** Its live candle channel. */
  pair(): Pair {
    return { instId: this.feed.instId, bar: this.feed.bar };
  }

  /** In use (the toolbars act on it, the keys go to its drawings) or not. */
  setInUse(on: boolean) {
    this.el.classList.toggle("in-use", on);
    this.drawings.setActive(on);
    if (on) this.drawings.refresh(); // its tool's hint and the magnet button
  }

  /** The symbol list arrived (the charts load at the same time): a symbol no longer listed gives way to the
   *  most traded one; prices get their proper decimals. */
  catalogReady() {
    const id = this.s.catalog.usable(this.feed.instId);
    if (id !== this.feed.instId) {
      this.switchTo(id, this.feed.bar);
      return;
    }
    this.feed.setPrecision();
    this.view.setPriceFormat(this.feed.tick, this.feed.fmtPrice);
    this.overlays.refresh(true);
    this.scaleLabels.refresh();
    this.drawings.redraw();
    this.alertLayer.redraw();
    this.legend.render();
    this.ev.priced(this);
  }

  /** Another chart of the same symbol changed the drawings: show the saved ones. */
  reloadDrawings() {
    if (this.drawingsFor) this.drawings.setDrawings(loadDrawings(this.drawingsFor));
  }
  redrawAlerts() {
    this.alertLayer.redraw();
  }
  /** The window shows again: catch up on what came while it was hidden. */
  shown() {
    if (this.stale) this.redrawAll();
  }

  destroy() {
    this.dead = true;
    clearTimeout(this.zoomTimer);
    for (const off of this.offs) off();
    this.feed.dispose();
    this.overlays.destroy();
    this.drawings.destroy();
    const { candles } = this.view;
    candles.detachPrimitive(this.scaleLabels);
    candles.detachPrimitive(this.drawings);
    candles.detachPrimitive(this.alertLayer);
    this.view.chart.remove();
    this.el.remove();
  }

  // ------------------------------------------------------------------- internals
  /** Where a position stands on the chart: an alert made after its entry waits for the exit. */
  private tradeStage(d: Drawing): TradeStage | null {
    if (d.kind !== "position") return null;
    const st = this.drawings.tradeOf(d.id)?.outcome.status;
    return st === "tp" || st === "sl" ? "done" : st === "open" || st === "expired" ? "open" : "wait";
  }

  private applyLabels() {
    this.view.applyLabels();
    this.overlays.syncLines(); // the moving averages' value and name labels
    this.scaleLabels.refresh();
  }
  private applyAppearance() {
    this.view.applyAppearance();
    this.scaleLabels.refresh();
  }

  /** The latest bars, at the saved zoom (bar spacing) when there is one. */
  private showLatest() {
    if (this.zoom == null) {
      this.view.showLatest();
      return;
    }
    const ts = this.view.chart.timeScale();
    ts.applyOptions({ barSpacing: this.zoom });
    ts.scrollToRealTime();
  }

  /** The view moved or zoomed: once it settles, keep the new zoom. */
  private watchZoom() {
    clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => {
      const spacing = this.view.barSpacing();
      if (!this.feed.bars.length || spacing == null) return;
      const z = Math.round(spacing * 100) / 100;
      if (z === this.zoom) return;
      this.zoom = z;
      this.ev.zoomed(this);
    }, 800);
  }

  private onSwitching(symbol: boolean) {
    if (this.drawings.getTool() !== "cursor") this.drawings.setTool("cursor");
    if (symbol) {
      this.drawingsFor = "";
      this.drawings.setDrawings([]); // the old symbol's drawings go away until the new bars are in
      this.overlays.setSymbol(this.feed.instId);
    }
    this.overlays.setBar(this.feed.bar);
    this.view.setPriceFormat(this.feed.tick, this.feed.fmtPrice);
    this.ev.switched(this);
  }

  private onLoaded(kind: "first" | "older" | "repair", added: number) {
    if (kind === "older") {
      const range = this.view.chart.timeScale().getVisibleLogicalRange();
      this.redrawAll();
      this.view.keepView(added, range);
      return;
    }
    if (kind === "repair") this.overlays.resyncOthers(); // other timeframes may have missed bars too
    this.redrawAll();
    if (kind === "first") {
      this.s.status.ok();
      if (this.drawingsFor !== this.feed.instId) {
        this.drawingsFor = this.feed.instId;
        this.drawings.setDrawings(loadDrawings(this.feed.instId));
      }
      this.showLatest();
    }
  }

  private onTick(c: Candle) {
    if (document.hidden) {
      // minimized: keep the bars current but skip the drawing work until the window shows again
      this.overlays.tick(c, false);
      this.stale = true;
      return;
    }
    this.view.update(c);
    this.overlays.tick(c);
    if (!this.hovering) this.legend.render();
    this.ev.priced(this);
  }

  private redrawAll() {
    this.stale = false;
    this.view.setBars(this.feed.bars);
    this.overlays.setData(this.feed.bars);
    this.legend.render();
    this.ev.priced(this);
  }
}
