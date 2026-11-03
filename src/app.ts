// QT Chart: builds the parts and connects them (loaded by main.ts once the saved data is in). Each part gets
// only what it needs through a small interface, and the saved settings are Setting<T> values the parts watch,
// so no part reaches into another.
//
//   layout/    tabs and split layouts: which charts are on screen, which one is in use
//   chart/     one chart and its parts (pane: bars, the chart itself, legend, price-scale labels); the symbol
//              list and the backdrop every chart shares
//   indicators/ moving averages, FVG / order blocks / support-resistance, and the bars of other timeframes
//   drawings/  drawing tools: state and mouse (layer), geometry (geo), painting (paint), position sizing (trade)
//   alerts/    price and drawing alerts
//   pine/      Pine Script: parser, interpreter, built-ins and the strategy backtester (indicators/pine/ puts
//              the results on the charts)
//   trade/     orders on OKX with the user's own API key: the account, the order windows, order sizing
//   settings/  what is saved and its checks (model), and the saved values themselves (store)
//   ui/        the toolbars, menus, status bar and settings windows
//   core/      calls to the backend, which live candles to stream, storage, formatting, timeframes

import { alertNotify, gpuPref, onCandle, onStatus, openTradingView, setGpuPref, setStreams, type CandleEvent } from "./core/api.ts";
import { fmtClock } from "./core/format.ts";
import { LiveHub } from "./core/live.ts";
import { readJson, readRaw, writeJson } from "./core/storage.ts";
import { TIMEFRAMES } from "./core/timeframes.ts";
import { Backdrop } from "./chart/backdrop.ts";
import { Catalog, DEFAULT_SYMBOL } from "./chart/catalog.ts";
import { renderQuote } from "./chart/legend.ts";
import { Notifier } from "./alerts/notify.ts";
import { toggleAlertManager, type AlertUi } from "./alerts/panel.ts";
import { AlertService } from "./alerts/service.ts";
import { toggleLayoutPicker } from "./layout/picker.ts";
import { TradeAccount } from "./trade/account.ts";
import { paintAccountButton } from "./trade/panel.ts";
import { Trading } from "./trade/trading.ts";
import { TabBar } from "./layout/tabbar.ts";
import { Workspace } from "./layout/workspace.ts";
import { TOOL_INFO } from "./settings/model.ts";
import { loadBgImage, loadDrawings, loadSettings, saveBgImage } from "./settings/store.ts";
import { setupMenus } from "./ui/menus.ts";
import { togglePineManager, type PineUi } from "./ui/panels/pine.ts";
import { appearanceAt, toggleAppearancePanel, type AppearanceIo } from "./ui/panels/appearance.ts";
import { performanceSection } from "./ui/panels/performance.ts";
import { StatusBar } from "./ui/statusbar.ts";
import { Toolbar } from "./ui/toolbar.ts";
import { Tools } from "./ui/tools.ts";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const DEFAULT_HINT = "滾輪縮放、拖曳平移；往左拖載入更早的 K 線；價格標尺按右鍵設定標籤；分割畫面時點一下圖表就換用那個圖表";

const settings = loadSettings();
const catalog = new Catalog();
const status = new StatusBar({ dot: $("status-dot"), status: $("status"), hint: $("hint") }, DEFAULT_HINT);
const backdrop = new Backdrop(document.documentElement);
let bgImage = loadBgImage();
/** One live connection for the charts on screen, the alerts and the tabs. */
const hub = new LiveHub(setStreams, (e) => status.error(`即時報價：${e}`));

// ----------------------------------------------------------------------------- alerts
const notifier = new Notifier({
  box: $("toasts"),
  options: () => alerts.options(),
  system: alertNotify,
  open: (id) => workspace.openSymbol(id),
  fmtClock,
});
const alerts = new AlertService({
  watch: (ids) => hub.want("alerts", ids.map((instId) => ({ instId, bar: "1m" }))),
  loadDrawings,
  fib: () => settings.fib.get(),
  kindName: (k) => TOOL_INFO[k].name,
  fmtPrice: catalog.fmtPrice,
  fmtTime: fmtClock,
  notify: (n) => notifier.show(n),
  isTf: (b) => TIMEFRAMES.some((t) => t.bar === b),
  read: readJson,
  write: writeJson,
  now: () => Date.now() / 1000,
});
/** The alert list (bell button) works on the chart in use. */
const alertUi: AlertUi = {
  service: alerts,
  instId: () => workspace.inUse().feed.instId,
  bar: () => workspace.inUse().feed.bar,
  price: () => workspace.inUse().alertUi.price(),
  fmtPrice: catalog.fmtPrice,
  fmtClock,
  open: (id) => workspace.openSymbol(id),
};
function paintAlertButton() {
  const on = alerts.all().filter((a) => a.on).length;
  $("alert-count").textContent = on ? String(on) : "";
  $("alert-btn").classList.toggle("on", on > 0);
}

// ----------------------------------------------------------------------------- orders (OKX API)
const account = new TradeAccount();
const trading = new Trading({
  acct: account,
  catalog,
  position: settings.position,
  prefs: settings.orderPrefs,
  button: $("account-btn"),
  note: (text) => status.note(text),
});

// ----------------------------------------------------------------------------- toolbars and windows
const tools: Tools = new Tools({
  drawings: () => workspace.inUse().drawings,
  settings,
  hint: (t) => status.hint(t),
  instId: () => workspace.inUse().feed.instId,
  apiEquity: () => account.equity(),
});
const toolbar = new Toolbar({
  catalog,
  settings,
  current: () => workspace.inUse().feed,
  switchTo: (id, bar) => workspace.inUse().switchTo(id, bar),
});
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
function applyAppearance() {
  backdrop.apply(settings.appearance.get(), bgImage);
}

// ----------------------------------------------------------------------------- tabs and charts
const tabBar = new TabBar({
  box: $("tabs"),
  catalog,
  tabs: () => workspace.tabs(),
  shown: () => workspace.shownIndex(),
  select: (i) => workspace.selectTab(i),
  add: () => {
    if (workspace.addTab()) toolbar.focusSymbol(); // type the symbol the new tab should show
  },
  close: (i) => workspace.closeTab(i),
  move: (from, to) => workspace.moveTab(from, to),
});
const workspace: Workspace = new Workspace(
  {
    grid: $("grid"),
    shared: { catalog, settings, alerts, status, tools, trading, appearanceAt: (x, y) => appearanceAt(x, y, appearanceIo, performance) },
    hub,
    inUseChanged: (p) => {
      toolbar.paintTimeframes();
      tools.paintTools(p.drawings.getTool());
      renderQuote($("quote"), p.feed, catalog);
    },
    priced: (p) => renderQuote($("quote"), p.feed, catalog),
    tabsChanged: () => tabBar.render(),
  },
  // the single chart of older versions becomes the first tab
  { instId: readRaw("instId") ?? DEFAULT_SYMBOL, bar: readRaw("bar") ?? "15m", zoom: null },
);
setupMenus(
  () => workspace.charts().map((p) => p.menus),
  () => workspace.inUse().menus,
);

// ----------------------------------------------------------------------------- Pine scripts
const pineUi: PineUi = {
  scripts: settings.pine,
  host: () => workspace.inUse().pine,
  chartName: () => {
    const f = workspace.inUse().feed;
    return `${f.instId} · ${f.tf.label}`;
  },
  note: (text) => status.note(text),
};
function paintPineButton() {
  $("pine-btn").classList.toggle("on", settings.pine.get().some((s) => s.on));
}

/** A live candle: to the charts showing that symbol and timeframe, the alerts (1-minute bars), the tabs. */
function route(e: CandleEvent) {
  for (const p of workspace.charts()) if (p.feed.instId === e.instId && p.feed.bar === e.bar) p.feed.live(e.candle);
  if (e.bar === "1m") alerts.onCandle(e.instId, e.candle);
  tabBar.price(e.instId, e.candle.close);
}

// ----------------------------------------------------------------------------- settings and buttons
settings.appearance.watch(applyAppearance);
settings.pine.watch(paintPineButton);
alerts.subscribe(() => {
  for (const p of workspace.charts()) p.redrawAlerts();
  paintAlertButton();
});
account.subscribe(() => {
  paintAccountButton($("account-btn"), account);
  for (const p of workspace.charts()) p.drawings.redraw(); // the capital may come from the account now
});
// orders still open on the charts on screen: ask OKX every few seconds
window.setInterval(() => {
  if (!document.hidden) void trading.poll(workspace.charts().map((p) => p.orders));
}, 4000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) for (const p of workspace.charts()) p.shown();
});
// Toolbar buttons don't take keyboard focus when clicked: no focus ring, and Space/Enter/Delete stay with the chart.
document.addEventListener("mousedown", (e) => {
  if ((e.target as Element | null)?.closest?.(".icon-btn, .icon-caret, .tf-btn, .tool-btn, .tab, .tab-add, .layout-btn")) e.preventDefault();
});
$("layout-btn").onclick = () => toggleLayoutPicker($("layout-btn"), () => workspace.layout(), (id) => workspace.setLayout(id));
$("appearance-btn").onclick = () => toggleAppearancePanel($("appearance-btn"), appearanceIo, performance);
$("alert-btn").onclick = () => toggleAlertManager($("alert-btn"), alertUi);
$("account-btn").onclick = () => trading.openAccount();
$("pine-btn").onclick = () => togglePineManager($("pine-btn"), pineUi);
$("credit").onclick = (e) => {
  e.preventDefault();
  openTradingView().catch((err) => status.error(String(err)));
};

applyAppearance();
paintAlertButton();
paintAccountButton($("account-btn"), account);
paintPineButton();
status.hint(null);
workspace.start(); // the charts load their bars while the symbol list is on its way

async function start() {
  await onStatus((s) => status.setStream(s));
  await onCandle(route);
  alerts.start();
  void account.start();
  try {
    await catalog.load();
    workspace.catalogReady();
  } catch (e) {
    status.error(`讀不到幣種清單：${e}`);
  }
}

void start();
