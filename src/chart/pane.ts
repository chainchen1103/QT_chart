// One chart of the workspace with all its parts: bars (feed), the chart itself (view), indicators, price-scale
// labels, drawings, the alerts on it, its legend and menus. Made when its tab is shown and destroyed when the
// tab is left or the layout drops it, so only the charts on screen take memory. What every chart shares
// (symbols, settings, alerts, toolbars, status bar) comes in through PaneShared; what happens to it goes out
// through PaneEvents.

import type { Candle, Pair } from "../core/api.ts";
import { fmtChartTime, fmtClock, fromChartTime, toChartTime } from "../core/format.ts";
import { AlertLayer } from "../alerts/layer.ts";
import { pineLines } from "../alerts/pine.ts";
import type { TradeStage } from "../alerts/model.ts";
import { drawingAlertSection, indicatorAlertDialog, roundValue, type AlertUi, type IndPreset, type IndSource } from "../alerts/panel.ts";
import type { AlertService } from "../alerts/service.ts";
import type { DrawingHistory } from "../drawings/history.ts";
import { DrawingLayer } from "../drawings/layer.ts";
import { Overlays } from "../indicators/overlays.ts";
import { fmtSig, maSpec, specFor } from "../indicators/specs.ts";
import { legendButton, Studies } from "../indicators/studies.ts";
import type { IndKind } from "../settings/indicators.ts";
import { openIndicatorSettings, type IndicatorDeps } from "../ui/indicators.ts";
import { PineHost } from "../indicators/pine/host.ts";
import type { Cell } from "../layout/model.ts";
import { DEFAULT_APPEARANCE, DEFAULT_LINE_STYLE, DEFAULT_RECT_STYLE, defaultChannelStyle, isChannel, type Drawing } from "../settings/model.ts";
import { loadDrawings, saveDrawings, type Settings } from "../settings/store.ts";
import { el } from "../ui/dom.ts";
import { PaneMenus } from "../ui/menus.ts";
import { closePopover } from "../ui/popover.ts";
import type { StatusBar } from "../ui/statusbar.ts";
import type { Tools } from "../ui/tools.ts";
import type { AccountSync } from "../trade/sync.ts";
import type { OrderTarget, Trading } from "../trade/trading.ts";
import type { Catalog } from "./catalog.ts";
import { MarketFeed, MAX_BARS } from "./feed.ts";
import { Replay } from "./replay.ts";
import { LabelSpace } from "./labelspace.ts";
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
  /** Undo and redo of the drawings, for each symbol (all charts of a symbol share its steps). */
  history: DrawingHistory;
  /** The OKX account as it is (positions and their stops), matched to the drawings. */
  sync: AccountSync;
  /** Open the appearance window at a screen point. */
  appearanceAt(x: number, y: number): void;
  /** Open a Pine script's settings window (its inputs and alerts). */
  pineSettings(id: string): void;
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
  /** Bar replay started, ended, or started or stopped playing (the toolbar button). */
  replay(p: ChartPane): void;
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
  /** The Pine scripts on this chart. */
  readonly pine: PineHost;
  /** Bar replay on this chart. */
  readonly replay: Replay;
  private readonly overlays: Overlays;
  /** Bollinger Bands, and RSI, MACD, KD, ATR in their panes. */
  private readonly studies: Studies;
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
      () => (settings.bars.get().unlimited ? Infinity : MAX_BARS),
    );
    const feed = this.feed;
    const daily = () => feed.tf.sec >= 86400;
    const seconds = () => feed.tf.sec < 60;
    this.view = new ChartView({ el: chartEl, appearance: settings.appearance, labels: settings.labels, daily, seconds });
    const { chart, candles } = this.view;
    // the labels every layer writes on the price pane share it (see labelspace.ts), at the size set in 圖表外觀
    const space = new LabelSpace(() => ({ width: chart.timeScale().width(), height: chart.panes()[0]?.getHeight() ?? 0 }));
    const textSize = () => settings.appearance.get().labelSize;

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
      refreshed: (full) => this.studies.refresh(full),
      space,
      textSize,
    });

    // the settings windows and alerts opened from this chart's legends work on it
    const indDeps: IndicatorDeps = {
      settings,
      bar: () => feed.bar,
      alerts: () => this.alertUi,
      sources: (k) => this.indicatorSources(k),
      preset: (k) => this.indicatorPreset(k),
    };
    this.studies = new Studies({
      chart,
      candles,
      sources: this.overlays.sources,
      paneBox: this.el,
      settings: () => settings.inds.get(),
      waitClose: () => settings.maOptions.get().waitClose,
      valuesOnScale: () => settings.labels.get().maValues,
      bar: () => feed.bar,
      times: () => feed.times,
      toChartTime,
      fmtPrice: feed.fmtPrice,
      alertLevels: (kind) => {
        const [src] = this.indicatorSources(kind);
        return src ? shared.alerts.indicatorLevels(feed.instId, src.spec, src.tf) : [];
      },
      bell: (kind, at) => indicatorAlertDialog(at, this.alertUi, this.indicatorSources(kind), this.indicatorPreset(kind)),
      gear: (kind, at) => openIndicatorSettings(kind, at, indDeps),
      moved: () => this.legend.render(),
    });

    this.pine = new PineHost({
      chart,
      candles,
      legendBox: this.el,
      bars: () => feed.bars,
      times: () => feed.times,
      barSec: () => feed.tf.sec,
      toChartTime,
      fmtPrice: feed.fmtPrice,
      tick: () => feed.tick,
      scripts: settings.pine,
      instId: () => feed.instId,
      bar: () => feed.bar,
      barColors: (c) => this.view.setBarColors(c),
      textScale: () => textSize() / DEFAULT_APPEARANCE.labelSize,
      changed: () => {
        if (!this.hovering) this.legend.render();
      },
      // a script's legend: a new alert on its plots (when it draws any), its settings
      legendButtons: (id) => [
        ...(this.pineSources(id).length ? [legendButton("bell", "新增提醒", (b) => indicatorAlertDialog(b, this.alertUi, this.pineSources(id), this.pinePreset(id)))] : []),
        legendButton("gear", "腳本設定", () => shared.pineSettings(id)),
      ],
      alertLevels: (id) => {
        const [src] = this.pineSources(id);
        return src ? shared.alerts.indicatorLevels(feed.instId, src.spec, src.tf) : [];
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
      live: () => !feed.replaying,
      space,
      textSize,
      axisSize: () => settings.appearance.get().axisSize,
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
      roundPrice: (p) => feed.roundToTick(p),
      priceText: (p) => p.toFixed(feed.decimals),
      fmtTime: (t) => fmtChartTime(toChartTime(t), daily(), seconds()),
      fib: () => settings.fib.get(),
      magnet: () => settings.magnet.get(),
      position: () => settings.position.get(),
      capital: () => shared.trading.capital(),
      // no orders from a replay: its newest bar is in the past
      orderTag: (d) => (feed.replaying ? null : shared.trading.tag(d, feed.bars[feed.bars.length - 1]?.time ?? null, feed.fmtPrice)),
      orderClicked: (d, x, y) => shared.trading.click(this.orders, d, x, y),
      styleFor: (k) => {
        const styles = settings.drawStyles.get();
        if (k === "rect") return styles.rect ?? DEFAULT_RECT_STYLE;
        if (isChannel(k)) return styles[k] ?? defaultChannelStyle(k);
        return styles[k] ?? DEFAULT_LINE_STYLE;
      },
      changed: (list, step) => {
        if (!this.drawingsFor) return;
        saveDrawings(this.drawingsFor, list);
        if (step === false) shared.history.quiet(this.drawingsFor, list);
        else shared.history.record(this.drawingsFor, list, step);
        shared.alerts.drawingsChanged(this.drawingsFor, list);
        events.drawingsChanged(this);
      },
      undo: () => this.stepHistory(true),
      redo: () => this.stepHistory(false),
      isLive: (d) => shared.sync.isLive(feed.instId, d),
      live: (d) => shared.sync.liveInfo(feed.instId, d),
      stopsEdited: (d, before, x, y) => {
        shared.sync.confirmEdit(feed.instId, d, before, x, y, feed.fmtPrice, () => this.drawings.setStops(d.id, before));
      },
      waiting: (d) => !feed.replaying && shared.trading.waiting(d),
      filledCoins: (d) => {
        const o = d.order;
        const ct = catalog.get(feed.instId)?.ctVal ?? 0;
        if (!o || !(ct > 0) || !(o.state === "filled" || o.state === "partially_filled")) return null;
        // all of it filled: its size as filled; part of it: the whole order (the rest still waits at its price)
        return (o.state === "filled" && o.fillSz > 0 ? o.fillSz : o.sz) * ct;
      },
      waitingEdited: (d, before, x, y) => {
        shared.trading.amendWaiting(this.orders, d, this.drawings.tradeNow(d.id), x, y, () => this.drawings.restore(d.id, before));
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
      locked: () => settings.drawLock.get(),
      space,
      textSize,
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

    this.replay = new Replay({
      el: this.el,
      chart,
      feed,
      inUse,
      hint: (text) => {
        if (inUse()) shared.status.hint(text);
      },
      note: (text) => shared.status.note(text),
      changed: () => events.replay(this),
    });

    this.alertLayer = new AlertLayer({
      chart,
      series: candles,
      alerts: () => (this.drawingsFor ? shared.alerts.forSymbol(this.drawingsFor) : []),
      drawing: (a) => (a.target.kind === "drawing" ? this.drawings.findShown(a.target.id) : undefined),
      times: () => feed.times,
      barSec: () => feed.tf.sec,
      fmtPrice: feed.fmtPrice,
      space,
    });
    candles.attachPrimitive(this.alertLayer);

    // ------------------------------------------------------------------- text and menus
    this.legend = new Legend(
      feed,
      this.overlays,
      legendBox,
      (i, box) => {
        this.studies.legend(i, box);
        this.pine.legend(i, box);
      },
      // the moving averages' line: a new alert on one of them, their settings
      (line) => line.append(
        legendButton("bell", "新增均線提醒", (b) => indicatorAlertDialog(b, this.alertUi, this.indicatorSources("ma"))),
        legendButton("gear", "均線設定", (b) => openIndicatorSettings("ma", b, indDeps)),
      ),
    );
    this.menus = new PaneMenus({
      el: chartEl,
      view: this.view,
      feed,
      labels: settings.labels,
      alerts: this.alertUi,
      appearanceAt: shared.appearanceAt,
      resetView: () => this.resetView(),
      studyAt: (clientY) => this.paneHit(clientY),
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
      settings.inds.watch(() => this.overlays.refresh(true)),
      settings.labels.watch(() => this.applyLabels()),
      settings.appearance.watch(() => this.applyAppearance()),
      settings.fib.watch(() => this.drawings.refresh()),
      settings.magnet.watch(() => this.drawings.refresh()),
      settings.position.watch(() => {
        this.drawings.refresh(); // 顯示歷史倉位 may hide some
        this.alertLayer.redraw();
      }),
      settings.drawLock.watch(() => this.drawings.lockChanged()),
    );
    this.applyLabels();
  }

  /** Load the first bars. */
  start() {
    void this.feed.switchTo(this.feed.instId, this.feed.bar);
  }

  /** Show another symbol or timeframe; done once its bars are in (or another switch came first). */
  switchTo(instId: string, bar: string): Promise<void> {
    return this.feed.switchTo(instId, bar);
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

  /** Another chart of the same symbol (or OKX) changed the drawings: show the saved ones, keeping what is
   *  selected or dragged. */
  reloadDrawings() {
    if (this.drawingsFor) this.drawings.setDrawings(loadDrawings(this.drawingsFor), true);
  }
  redrawAlerts() {
    this.alertLayer.redraw();
    this.studies.alertsChanged();
    this.pine.alertsChanged();
  }
  /** The window shows again: catch up on what came while it was hidden. */
  shown() {
    if (this.stale) this.redrawAll();
    this.pine.shown();
  }

  destroy() {
    this.dead = true;
    clearTimeout(this.zoomTimer);
    for (const off of this.offs) off();
    this.feed.dispose();
    this.replay.destroy();
    this.overlays.destroy();
    this.studies.destroy();
    this.pine.destroy();
    this.drawings.destroy();
    const { candles } = this.view;
    candles.detachPrimitive(this.scaleLabels);
    candles.detachPrimitive(this.drawings);
    candles.detachPrimitive(this.alertLayer);
    this.view.chart.remove();
    this.el.remove();
  }

  /** Ctrl+Z (back) or Ctrl+Y on this chart, or the 還原 / 重做 buttons: its symbol's drawings one step back, or
   *  forward again. */
  stepHistory(back: boolean) {
    const id = this.drawingsFor;
    if (!id) return;
    const { history, status, alerts, settings } = this.s;
    if (settings.drawLock.get()) {
      status.note("畫線已鎖定，不能還原或重做");
      return;
    }
    const list = back ? history.undo(id) : history.redo(id);
    if (!list) {
      status.note(back ? "沒有可以還原的畫線操作" : "沒有可以重做的畫線操作");
      return;
    }
    closePopover(); // a window open on a drawing would show it as it was
    saveDrawings(id, list);
    this.drawings.setDrawings(list);
    alerts.drawingsChanged(id, list);
    this.ev.drawingsChanged(this);
    status.note(back ? "已還原上一步（Ctrl+Y 重做）" : "已重做");
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

  /** What the indicators show now (AI apps). */
  indicators() {
    const inds = this.s.settings.inds.get();
    const studies = (["boll", "rsi", "macd", "kd", "atr"] as IndKind[]).flatMap((kind) => {
      const v = this.studies.valuesAt(kind);
      return v ? [{ kind, spec: v.spec, timeframe: inds[kind].tf || this.feed.bar, state: v.state, values: v.values }] : [];
    });
    return { ...this.overlays.snapshot(), studies };
  }

  /** What an alert can be made on for this kind of indicator: as set now on this chart, and the timeframe it runs
   *  on (moving averages: each one switched on). */
  indicatorSources(kind: "ma" | IndKind): IndSource[] {
    const s = this.s.settings;
    if (kind === "ma") return s.groups.get().ma ? s.mas.get().filter((m) => m.on).map((m) => ({ spec: maSpec(m), tf: m.tf || this.feed.bar })) : [];
    const inds = s.inds.get();
    return [{ spec: specFor(kind, inds), tf: inds[kind].tf || this.feed.bar }];
  }
  /** A Pine script as an alert can watch it: its plots as this chart last drew them, on this chart's timeframe
   *  (none before it has run here). */
  pineSources(id: string): IndSource[] {
    const spec = this.pine.specOf(id);
    return spec ? [{ spec, tf: this.feed.bar }] : [];
  }

  /** Where a new alert on a Pine script starts: its first line's value now. */
  pinePreset(id: string): IndPreset {
    const r = this.pine.view(id)?.result;
    const first = r?.ok ? pineLines(r.out.plots)[0] : undefined;
    const vals = first?.plot.values ?? [];
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] === vals[i]) return { value: roundValue("pine", vals[i]) };
    return {};
  }

  /** The indicator pane at this height of the screen (a built-in one, or a Pine script's), with a new alert on
   *  it at the value there. */
  private paneHit(clientY: number): { text: string; alert(x: number, y: number): void } | null {
    const st = this.studies.paneAt(clientY);
    if (st) {
      const v = st.kind === "rsi" || st.kind === "kd" ? st.value.toFixed(1) : fmtSig(st.value);
      return {
        text: `${st.kind.toUpperCase()} ${v}`,
        alert: (x, y) => indicatorAlertDialog({ x, y }, this.alertUi, this.indicatorSources(st.kind), { value: roundValue(st.kind, st.value) }),
      };
    }
    const pn = this.pine.paneAt(clientY);
    if (!pn) return null;
    const sources = this.pineSources(pn.id);
    if (!sources.length) return null;
    return { text: `${pn.name} ${fmtSig(pn.value)}`, alert: (x, y) => indicatorAlertDialog({ x, y }, this.alertUi, sources, { value: roundValue("pine", pn.value) }) };
  }

  /** Where a new alert starts: RSI and KD at their upper line, MACD at 0, ATR at its value now. */
  indicatorPreset(kind: "ma" | IndKind): IndPreset {
    const inds = this.s.settings.inds.get();
    if (kind === "rsi") return { value: inds.rsi.upper };
    if (kind === "kd") return { value: inds.kd.upper };
    if (kind === "macd") return { value: 0 };
    const atr = kind === "atr" ? this.studies.valuesAt("atr")?.values.atr : null;
    return atr != null ? { value: roundValue("atr", atr) } : {};
  }
  /** The chart as a PNG (base64, no data: prefix): prices, volume and every pane, with the axes and everything
   *  drawn on them; bars that came while the window was hidden are drawn first. */
  screenshot(): string {
    if (this.stale) this.redrawAll();
    return this.view.chart.takeScreenshot(true).toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
  }

  /** Back to the view the chart opens with: the newest bars at the default zoom, every price scale fitting its
   *  bars again; the symbol and timeframe stay. */
  resetView() {
    this.zoom = null;
    this.ev.zoomed(this);
    this.showLatest();
  }

  /** The latest bars, at the saved zoom (bar spacing) when there is one, with the prices fitted to them (a
   *  price scale dragged by hand would still show the old symbol's prices). */
  private showLatest() {
    this.view.fitPrices();
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
      this.pine.setSymbol(this.feed.instId);
    }
    this.overlays.setBar(this.feed.bar);
    this.pine.setBar(this.feed.bar);
    this.view.setPriceFormat(this.feed.tick, this.feed.fmtPrice);
    this.ev.switched(this);
  }

  private onLoaded(kind: "first" | "older" | "repair" | "replay", added: number) {
    if (kind === "replay") {
      this.redrawAll();
      this.showLatest();
      this.replay.sync();
      return;
    }
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
        const list = loadDrawings(this.feed.instId);
        this.s.history.start(this.feed.instId, list);
        this.drawings.setDrawings(list);
      }
      this.showLatest();
      this.replay.sync(); // a replay carried over to this symbol or timeframe
    }
  }

  private onTick(c: Candle) {
    if (document.hidden) {
      // minimized: keep the bars current but skip the drawing work until the window shows again
      this.overlays.tick(c, false);
      this.pine.tick(c, false);
      this.stale = true;
      return;
    }
    this.view.update(c);
    this.overlays.tick(c);
    this.pine.tick(c);
    if (!this.hovering) this.legend.render();
    this.ev.priced(this);
  }

  private redrawAll() {
    this.stale = false;
    this.view.setBars(this.feed.bars);
    this.overlays.setData(this.feed.bars);
    this.pine.setData();
    this.legend.render();
    this.ev.priced(this);
  }
}
