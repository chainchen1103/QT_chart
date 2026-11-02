// QT Chart: builds the parts and connects them (loaded by main.ts once the saved data is in). Each part gets
// only what it needs through a small interface, and the saved settings are Setting<T> values the parts watch,
// so no part reaches into another.
//
//   chart/     the chart itself, its bars (feed), the legend and the price-scale labels
//   indicators/ moving averages, FVG / order blocks / support-resistance, and the bars of other timeframes
//   drawings/  drawing tools: state and mouse (layer), geometry (geo), painting (paint), position sizing (trade)
//   alerts/    price and drawing alerts
//   settings/  what is saved and its checks (model), and the saved values themselves (store)
//   ui/        the toolbars, menus and settings windows
//   core/      calls to the backend, storage, formatting, timeframes

import { alertNotify, gpuPref, onCandle, onStatus, onWatchCandle, openTradingView, setGpuPref, watchSymbols, type Candle } from "./core/api.ts";
import { fmtChartTime, fmtClock, fromChartTime, toChartTime } from "./core/format.ts";
import { readJson, writeJson } from "./core/storage.ts";
import { TIMEFRAMES } from "./core/timeframes.ts";
import { MarketFeed } from "./chart/feed.ts";
import { Legend } from "./chart/legend.ts";
import { ScaleLabelLayer } from "./chart/scalelabels.ts";
import { ChartView } from "./chart/view.ts";
import { Overlays } from "./indicators/overlays.ts";
import { DrawingLayer } from "./drawings/layer.ts";
import { AlertLayer } from "./alerts/layer.ts";
import type { TradeStage } from "./alerts/model.ts";
import { Notifier } from "./alerts/notify.ts";
import { drawingAlertSection, toggleAlertManager, type AlertUi } from "./alerts/panel.ts";
import { AlertService } from "./alerts/service.ts";
import { DEFAULT_LINE_STYLE, DEFAULT_RECT_STYLE, TOOL_INFO, type Drawing } from "./settings/model.ts";
import { loadBgImage, loadDrawings, loadSettings, saveBgImage, saveDrawings } from "./settings/store.ts";
import { setupMenus } from "./ui/menus.ts";
import { appearanceAt, toggleAppearancePanel, type AppearanceIo } from "./ui/panels/appearance.ts";
import { performanceSection } from "./ui/panels/performance.ts";
import { Toolbar } from "./ui/toolbar.ts";
import { Tools } from "./ui/tools.ts";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const DEFAULT_HINT = "滾輪縮放、拖曳平移；往左拖載入更早的 K 線；價格標尺按右鍵設定標籤";

const settings = loadSettings();
let bgImage = loadBgImage();
let drawingsFor = ""; // symbol whose drawings are on screen
let hovering = false; // the crosshair is on a bar: the legend shows that bar
let stale = false; // live bars came while the window was hidden: redraw once it shows again

// ----------------------------------------------------------------------------- the chart and its bars
const feed = new MarketFeed({
  switching: onSwitching,
  loaded: onLoaded,
  tick: onTick,
  status: (s) => legend.status(s),
  note: (text) => {
    setHint(text);
    setTimeout(() => setHint(null), 4000);
  },
});
const daily = () => feed.tf.sec >= 86400;
const view = new ChartView({
  el: $("chart"),
  wrap: $("chart").parentElement as HTMLElement,
  picture: $("chart-bg"),
  appearance: settings.appearance,
  labels: settings.labels,
  daily,
});

const overlays = new Overlays({
  chart: view.chart,
  series: view.candles,
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
    if (!hovering) legend.render();
  },
});

const scaleLabels = new ScaleLabelLayer({
  chart: view.chart,
  series: view.candles,
  candles: () => feed.bars,
  barSec: () => feed.tf.sec,
  fmtPrice: feed.fmtPrice,
  labels: () => settings.labels.get(),
  colors: () => ({ up: settings.appearance.get().up, down: settings.appearance.get().down }),
});
view.candles.attachPrimitive(scaleLabels);

// ----------------------------------------------------------------------------- drawings
const drawings = new DrawingLayer({
  chart: view.chart,
  series: view.candles,
  el: $("chart"),
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
  styleFor: (k) => (k === "rect" ? settings.drawStyles.get().rect ?? DEFAULT_RECT_STYLE : settings.drawStyles.get()[k] ?? DEFAULT_LINE_STYLE),
  changed: (list) => {
    if (!drawingsFor) return;
    saveDrawings(drawingsFor, list);
    alerts.drawingsChanged(drawingsFor, list);
  },
  toolChanged: (t) => tools.paintTools(t),
  magnetActive: (on) => tools.paintMagnet(on),
  openSettings: (d, x, y) => tools.openSettings(d, x, y),
  hint: setHint,
});
view.candles.attachPrimitive(drawings);

// ----------------------------------------------------------------------------- alerts
const notifier = new Notifier({
  box: $("toasts"),
  options: () => alerts.options(),
  system: alertNotify,
  open: (id) => {
    if (id !== feed.instId) void feed.switchTo(id, feed.bar);
  },
  fmtClock,
});
const alerts = new AlertService({
  watch: (ids) => {
    watchSymbols(ids).catch((e) => legend.status({ state: "error", detail: `提醒的報價：${e}` }));
  },
  loadDrawings,
  fib: () => settings.fib.get(),
  kindName: (k) => TOOL_INFO[k].name,
  fmtPrice: feed.fmtPriceOf,
  fmtTime: fmtClock,
  notify: (n) => notifier.show(n),
  isTf: (b) => TIMEFRAMES.some((t) => t.bar === b),
  read: readJson,
  write: writeJson,
  now: () => Date.now() / 1000,
});
const alertLayer = new AlertLayer({
  chart: view.chart,
  series: view.candles,
  alerts: () => (drawingsFor ? alerts.forSymbol(drawingsFor) : []),
  drawing: (a) => (a.target.kind === "drawing" ? drawings.find(a.target.id) : undefined),
  times: () => feed.times,
  barSec: () => feed.tf.sec,
  fmtPrice: feed.fmtPrice,
});
view.candles.attachPrimitive(alertLayer);
const alertUi: AlertUi = {
  service: alerts,
  instId: () => feed.instId,
  bar: () => feed.bar,
  price: () => feed.bars[feed.bars.length - 1]?.close ?? null,
  fmtPrice: feed.fmtPriceOf,
  fmtClock,
  open: (id) => {
    if (id !== feed.instId) void feed.switchTo(id, feed.bar);
  },
};
/** Where a position stands on the chart: an alert made after its entry waits for the exit. */
function tradeStage(d: Drawing): TradeStage | null {
  if (d.kind !== "position") return null;
  const st = drawings.tradeOf(d.id)?.outcome.status;
  return st === "tp" || st === "sl" ? "done" : st === "open" || st === "expired" ? "open" : "wait";
}
function paintAlertButton() {
  const on = alerts.all().filter((a) => a.on).length;
  $("alert-count").textContent = on ? String(on) : "";
  $("alert-btn").classList.toggle("on", on > 0);
}

// ----------------------------------------------------------------------------- text, toolbars, menus
const legend = new Legend(feed, overlays, { legend: $("legend"), quote: $("quote"), dot: $("status-dot"), status: $("status") });
const tools = new Tools({
  drawings,
  settings,
  hint: setHint,
  instId: () => feed.instId,
  alertSection: (d) => drawingAlertSection(alertUi, d, () => tradeStage(d)),
});
const toolbar = new Toolbar({ feed, settings, switchTo: (id, bar) => void feed.switchTo(id, bar) });

const appearanceIo: AppearanceIo = {
  get: () => settings.appearance.get(),
  set: (v) => settings.appearance.set(v),
  image: () => bgImage,
  setImage: (data) => {
    if (!saveBgImage(data)) return false;
    bgImage = data;
    applyAppearance();
    return true;
  },
};
const performance = performanceSection({ gpu: gpuPref, setGpu: setGpuPref });
setupMenus({
  el: $("chart"),
  view,
  feed,
  labels: settings.labels,
  alerts: alertUi,
  appearanceAt: (x, y) => appearanceAt(x, y, appearanceIo, performance),
});

function setHint(text: string | null) {
  $("hint").textContent = text ?? DEFAULT_HINT;
}
function applyLabels() {
  view.applyLabels();
  overlays.syncLines(); // the moving averages' value and name labels
  scaleLabels.refresh();
}
function applyAppearance() {
  view.applyAppearance(bgImage);
  scaleLabels.refresh();
}

// ----------------------------------------------------------------------------- settings → what uses them
settings.mas.watch(() => overlays.syncLines());
settings.groups.watch(() => overlays.syncLines());
settings.maOptions.watch(() => overlays.refresh(true));
settings.fvgs.watch(() => overlays.refresh(true));
settings.obs.watch(() => overlays.refresh(true));
settings.srs.watch(() => overlays.refresh(true));
settings.labels.watch(applyLabels);
settings.appearance.watch(applyAppearance);
settings.fib.watch(() => drawings.refresh());
settings.magnet.watch(() => drawings.refresh());
settings.position.watch(() => drawings.redraw());
alerts.subscribe(() => {
  alertLayer.redraw();
  paintAlertButton();
});

// ----------------------------------------------------------------------------- the feed's events
function onSwitching(symbol: boolean) {
  if (drawings.getTool() !== "cursor") drawings.setTool("cursor");
  if (symbol) {
    drawingsFor = "";
    drawings.setDrawings([]); // the old symbol's drawings go away until the new bars are in
    overlays.setSymbol(feed.instId);
  }
  overlays.setBar(feed.bar);
  view.setPriceFormat(feed.tick, feed.fmtPrice);
  toolbar.paintTimeframes();
}

function onLoaded(kind: "first" | "older" | "repair", added: number) {
  if (kind === "older") {
    const range = view.chart.timeScale().getVisibleLogicalRange();
    redrawAll();
    view.keepView(added, range);
    return;
  }
  if (kind === "repair") overlays.resyncOthers(); // other timeframes may have missed bars too
  redrawAll();
  if (kind === "first") {
    if (drawingsFor !== feed.instId) {
      drawingsFor = feed.instId;
      drawings.setDrawings(loadDrawings(feed.instId));
    }
    view.showLatest();
  }
}

function onTick(c: Candle) {
  if (document.hidden) {
    // minimized: keep the bars current but skip the drawing work until the window shows again
    overlays.tick(c, false);
    stale = true;
    return;
  }
  view.update(c);
  overlays.tick(c);
  if (!hovering) legend.render();
  legend.quote();
}

function redrawAll() {
  stale = false;
  view.setBars(feed.bars);
  overlays.setData(feed.bars);
  legend.render();
  legend.quote();
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && stale) redrawAll();
});

view.chart.subscribeCrosshairMove((p) => {
  hovering = p.time !== undefined;
  legend.render(hovering && p.time !== undefined ? fromChartTime(p.time) : undefined);
});
view.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
  if (r && r.from < 30) void feed.loadOlder();
});

// Toolbar buttons don't take keyboard focus when clicked: no focus ring, and Space/Enter/Delete stay with the chart.
document.addEventListener("mousedown", (e) => {
  if ((e.target as Element | null)?.closest?.(".icon-btn, .icon-caret, .tf-btn, .tool-btn")) e.preventDefault();
});
$("appearance-btn").onclick = () => toggleAppearancePanel($("appearance-btn"), appearanceIo, performance);
$("alert-btn").onclick = () => toggleAlertManager($("alert-btn"), alertUi);
$("credit").onclick = (e) => {
  e.preventDefault();
  openTradingView().catch((err) => legend.status({ state: "error", detail: String(err) }));
};

async function start() {
  applyLabels();
  applyAppearance();
  paintAlertButton();
  setHint(null);
  await onStatus((s) => legend.status(s));
  await onCandle((e) => {
    if (e.instId === feed.instId && e.bar === feed.bar) feed.live(e.candle);
  });
  await onWatchCandle((e) => alerts.onCandle(e.instId, e.candle));
  try {
    await feed.loadInstruments();
  } catch (e) {
    legend.status({ state: "error", detail: `讀不到幣種清單：${e}` });
  }
  alerts.start();
  await feed.switchTo(feed.instId, feed.bar);
}

void start();
