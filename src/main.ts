import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  ColorType,
  CrosshairMode,
  TickMarkType,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import {
  alertNotify,
  getCandles,
  listInstruments,
  onCandle,
  onStatus,
  onWatchCandle,
  openTradingView,
  startStream,
  watchSymbols,
  type Candle,
  type Instrument,
  type StreamStatus,
} from "./api";
import { AlertLayer } from "./alerts/layer.ts";
import type { TradeStage } from "./alerts/model.ts";
import { Notifier } from "./alerts/notify.ts";
import { alertDialogAt, drawingAlertSection, toggleAlertManager, type AlertUi } from "./alerts/panel.ts";
import { AlertService } from "./alerts/service.ts";
import { readJson, writeJson } from "./storage.ts";
import { isTyping, menuItem } from "./ui/dom.ts";
import { popoverAt } from "./ui/popover.ts";
import { DrawingLayer, type Tool } from "./drawings";
import { Overlays, type IndState } from "./overlays";
import {
  closePopover,
  openDrawingStyle,
  openScaleMenu,
  toggleFibPanel,
  toggleFvgPanel,
  toggleMagnetPanel,
  toggleMaPanel,
  toggleObPanel,
  toggleSrPanel,
  toggleToolMenu,
  toggleAppearancePanel,
  appearanceAt,
  togglePositionPanel,
  positionPanelAt,
  type AppearanceIo,
  type PositionIo,
} from "./panels";
import { ICONS } from "./icons";
import { hexToRgba } from "./fibmath";
import { ScaleLabelLayer } from "./scalelabels";
import {
  clone,
  DEFAULT_FVG,
  DEFAULT_OB,
  DEFAULT_SR,
  DEFAULT_LINE_STYLE,
  DEFAULT_RECT_STYLE,
  LINE_KINDS,
  TOOL_INFO,
  loadDrawStyles,
  saveDrawStyles,
  loadAppearance,
  saveAppearance,
  loadPosition,
  savePosition,
  loadBgImage,
  saveBgImage,
  loadDrawings,
  loadFib,
  loadFvgs,
  loadGroups,
  loadLabels,
  loadMagnet,
  loadMaOptions,
  loadMas,
  loadObs,
  loadSrs,
  magnetKeyLabel,
  saveDrawings,
  saveFib,
  saveFvgs,
  saveGroups,
  saveLabels,
  saveMagnet,
  saveMaOptions,
  saveMas,
  saveObs,
  saveSrs,
  type FibSettings,
  type FvgConf,
  type Groups,
  type MagnetSettings,
  type MaConf,
  type MaOptions,
  type ObConf,
  type ScaleLabels,
  type SrConf,
  type DrawStyles,
  type Appearance,
  type PositionSettings,
  type Drawing,
  type LineKind,
  type LineStyle,
  type RectStyle,
} from "./settings";
import { TIMEFRAMES } from "./timeframes";

// ----------------------------------------------------------------------------- settings
const INITIAL_BARS = 500;
const OLDER_BARS = 500;
const DEFAULT_HINT = "滾輪縮放、拖曳平移；往左拖載入更早的 K 線；價格標尺按右鍵設定標籤";

// The chart library works in UTC; shift by the local offset so the axis shows local time (Taiwan: +8 h).
const TZ_SEC = -new Date().getTimezoneOffset() * 60;
const toChartTime = (t: number) => (t + TZ_SEC) as UTCTimestamp;
const fromChartTime = (t: Time) => (t as number) - TZ_SEC;

// ----------------------------------------------------------------------------- small helpers
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pad = (n: number) => String(n).padStart(2, "0");
const store = {
  get(k: string): string | null {
    try { return localStorage.getItem("qtchart." + k); } catch { return null; }
  },
  set(k: string, v: string) {
    try { localStorage.setItem("qtchart." + k, v); } catch { /* storage unavailable */ }
  },
};
const tfOf = (bar: string) => TIMEFRAMES.find((t) => t.bar === bar) ?? TIMEFRAMES[2];

function fmtPrice(v: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
/** A price of any symbol, with that symbol's decimals. */
function fmtPriceOf(id: string, v: number): string {
  const d = instById.get(id)?.priceDecimals ?? decimals;
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
/** UTC seconds as local "11/02 16:23". */
function fmtClock(t: number): string {
  const d = new Date(t * 1000);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** A price rounded to the symbol's price step. */
function roundToTick(p: number): number {
  return tick > 0 ? Number((Math.round(p / tick) * tick).toFixed(decimals)) : p;
}
function fmtVol(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(2) + "K";
  return v.toFixed(a >= 100 ? 0 : 2);
}
function fmtTime(t: Time): string {
  const d = new Date((t as number) * 1000); // already shifted to local time: read with UTC getters
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return tfOf(bar).sec >= 86400 ? day : `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function fmtTick(t: Time, type: TickMarkType): string {
  const d = new Date((t as number) * 1000);
  switch (type) {
    case TickMarkType.Year:
      return String(d.getUTCFullYear());
    case TickMarkType.Month:
      return `${d.getUTCMonth() + 1}月`;
    case TickMarkType.DayOfMonth:
      return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    default:
      return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
}
const span = (cls: string, text: string) => {
  const s = document.createElement("span");
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
};

// ----------------------------------------------------------------------------- state
let instruments: Instrument[] = [];
let instId = store.get("instId") ?? "BTC-USDT-SWAP";
let bar = tfOf(store.get("bar") ?? "15m").bar;
let candles: Candle[] = [];
let candleTimes: number[] = []; // candles[i].time, kept for the drawing tools
let decimals = 2;
let tick = 0.01; // price step of the symbol on screen
let instById = new Map<string, Instrument>();
let loadingOlder = false;
let noMoreHistory = false;
let hovering = false;
let seq = 0; // guards against late answers after a switch
let maConfs: MaConf[] = loadMas();
let maOptions: MaOptions = loadMaOptions();
let fvgSets: FvgConf[] = loadFvgs();
let obSets: ObConf[] = loadObs();
let srSets: SrConf[] = loadSrs();
let groups: Groups = loadGroups();
let labels: ScaleLabels = loadLabels();
let appearance: Appearance = loadAppearance();
let bgImage = loadBgImage();
let fibSettings: FibSettings = loadFib();
let magnet: MagnetSettings = loadMagnet();
let drawingsFor = ""; // symbol whose drawings are on screen
let drawStyles: DrawStyles = loadDrawStyles();
let positionSettings: PositionSettings = loadPosition();
let lastLine: LineKind = (LINE_KINDS as string[]).includes(store.get("lineTool") ?? "") ? (store.get("lineTool") as LineKind) : "trend";

// ----------------------------------------------------------------------------- chart
const chart = createChart($("chart"), {
  autoSize: true,
  layout: {
    // see-through: the background color and picture are behind the chart (applyAppearance)
    background: { type: ColorType.Solid, color: "rgba(0,0,0,0)" },
    textColor: appearance.text,
    fontSize: 12,
    panes: { separatorColor: "#2a2e39", separatorHoverColor: "#363a45", enableResize: true },
    attributionLogo: false, // the credit TradingView's licence asks for is in the status bar instead
  },
  grid: { vertLines: { color: appearance.grid }, horzLines: { color: appearance.grid } },
  crosshair: { mode: CrosshairMode.Normal },
  rightPriceScale: { borderColor: "#2a2e39" },
  timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 8, tickMarkFormatter: fmtTick },
  localization: { timeFormatter: fmtTime },
});
const candleSeries = chart.addSeries(CandlestickSeries, {
  upColor: appearance.up, downColor: appearance.down, borderVisible: false, wickUpColor: appearance.up, wickDownColor: appearance.down,
});
const volumeSeries = chart.addSeries(
  HistogramSeries,
  { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false },
  1,
);
chart.panes()[1]?.setHeight(110);

const toBar = (c: Candle) => ({ time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close });
const toVol = (c: Candle) => ({
  time: toChartTime(c.time), value: c.volume, color: hexToRgba(c.close >= c.open ? appearance.up : appearance.down, 0.5),
});

// ----------------------------------------------------------------------------- indicators (MA, FVG, OB)
const overlays = new Overlays({
  chart,
  series: candleSeries,
  toChartTime,
  fmtPrice,
  settings: () => ({ groups, mas: maConfs, maOptions, fvgs: fvgSets, obs: obSets, srs: srSets, labels }),
  changed: () => {
    if (!hovering) renderLegend();
  },
});

// ----------------------------------------------------------------------------- price-scale labels
const scaleLabels = new ScaleLabelLayer({
  chart,
  series: candleSeries,
  candles: () => candles,
  barSec: () => tfOf(bar).sec,
  fmtPrice,
  labels: () => labels,
  colors: () => ({ up: appearance.up, down: appearance.down }),
});
candleSeries.attachPrimitive(scaleLabels);

/** Show or hide each price-scale label as set. */
function applyLabels() {
  candleSeries.applyOptions({ lastValueVisible: labels.last, priceLineVisible: labels.last });
  volumeSeries.applyOptions({ lastValueVisible: labels.volume });
  chart.applyOptions({ crosshair: { horzLine: { labelVisible: labels.crosshair } } });
  overlays.syncLines(); // the moving averages' value and name labels
  scaleLabels.refresh();
}
function setLabels(v: ScaleLabels) {
  labels = v;
  saveLabels(v);
  applyLabels();
}
// ----------------------------------------------------------------------------- appearance
const appearanceIo: AppearanceIo = {
  get: () => appearance,
  set: (v) => {
    appearance = v;
    saveAppearance(v);
    applyAppearance();
  },
  image: () => bgImage,
  setImage: (data) => {
    if (!saveBgImage(data)) return false;
    bgImage = data;
    applyAppearance();
    return true;
  },
};

/** Background color and picture behind the see-through chart; grid, text and candle colors. */
function applyAppearance() {
  const a = appearance;
  ($("chart").parentElement as HTMLElement).style.backgroundColor = a.bg;
  const pic = $("chart-bg");
  pic.style.backgroundImage = bgImage ? `url("${bgImage}")` : "none";
  pic.style.backgroundSize = a.imageFit === "stretch" ? "100% 100%" : a.imageFit;
  pic.style.opacity = String(1 - a.imageTransparency / 100);
  chart.applyOptions({
    layout: { textColor: a.text },
    grid: { vertLines: { color: a.grid }, horzLines: { color: a.grid } },
  });
  candleSeries.applyOptions({ upColor: a.up, downColor: a.down, wickUpColor: a.up, wickDownColor: a.down });
  volumeSeries.setData(candles.map(toVol));
  document.documentElement.style.setProperty("--up", a.up);
  document.documentElement.style.setProperty("--down", a.down);
  scaleLabels.refresh();
}

/** Price at a y inside the chart element, when that y is in the price pane. */
function priceAtY(y: number): number | null {
  const h = chart.panes()[0]?.getHeight() ?? 0;
  if (y < 0 || y > h) return null;
  const p = candleSeries.coordinateToPrice(y);
  return p == null || !(p > 0) ? null : roundToTick(p);
}

function setupScaleMenu() {
  const el = $("chart");
  // right-click on the price scale (either pane): a new alert at that price and the label switches; on the chart
  // itself: a new alert and the appearance (a right-click on a drawing is taken by the drawing layer first)
  el.addEventListener("contextmenu", (e) => {
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const p = priceAtY(e.clientY - r.top);
    const { clientX: cx, clientY: cy } = e;
    e.preventDefault();
    const addAlert = (body: HTMLElement) => {
      if (p != null) body.append(menuItem(`在 ${fmtPrice(p)} 新增提醒`, () => alertDialogAt(cx, cy, alertUi, p), "Alt+A"));
    };
    if (x < chart.timeScale().width()) {
      popoverAt(cx, cy, "圖表", (body) => {
        addAlert(body);
        body.append(menuItem("圖表外觀…", () => appearanceAt(cx, cy, appearanceIo)));
      });
    } else {
      openScaleMenu(cx, cy, { get: () => labels, set: setLabels }, addAlert);
    }
  });
  $("appearance-btn").onclick = () => toggleAppearancePanel($("appearance-btn"), appearanceIo);
  // no browser menu anywhere else either, except in text boxes
  document.addEventListener("contextmenu", (e) => {
    if (!(e.target as Element | null)?.closest?.("input, textarea")) e.preventDefault();
  });
}

function setMas(v: MaConf[]) {
  maConfs = v;
  saveMas(v);
  overlays.syncLines();
}
function setMaOptions(v: MaOptions) {
  maOptions = v;
  saveMaOptions(v);
  overlays.refresh(true);
}
function setFvgs(v: FvgConf[]) {
  fvgSets = v;
  saveFvgs(v);
  overlays.refresh(true);
}
function setObs(v: ObConf[]) {
  obSets = v;
  saveObs(v);
  overlays.refresh(true);
}
function setSrs(v: SrConf[]) {
  srSets = v;
  saveSrs(v);
  overlays.refresh(true);
}
function setGroups(v: Groups) {
  // switching a group on with nothing in it brings back the default set
  if (v.fvg && !fvgSets.length) setFvgs([clone(DEFAULT_FVG)]);
  if (v.ob && !obSets.length) setObs([clone(DEFAULT_OB)]);
  if (v.sr && !srSets.length) setSrs([clone(DEFAULT_SR)]);
  groups = v;
  saveGroups(v);
  paintGroups();
  overlays.syncLines();
}
function paintGroups() {
  $("ma-toggle").classList.toggle("on", groups.ma);
  $("fvg-toggle").classList.toggle("on", groups.fvg);
  $("ob-toggle").classList.toggle("on", groups.ob);
  $("sr-toggle").classList.toggle("on", groups.sr);
}
function setupIndicatorButtons() {
  $("ma-toggle").onclick = () => setGroups({ ...groups, ma: !groups.ma });
  $("fvg-toggle").onclick = () => setGroups({ ...groups, fvg: !groups.fvg });
  $("ob-toggle").onclick = () => setGroups({ ...groups, ob: !groups.ob });
  $("sr-toggle").onclick = () => setGroups({ ...groups, sr: !groups.sr });
  $("ma-btn").onclick = () =>
    toggleMaPanel($("ma-btn"), { get: () => maConfs, set: setMas }, { get: () => maOptions, set: setMaOptions }, () => bar);
  $("fvg-btn").onclick = () => toggleFvgPanel($("fvg-btn"), { get: () => fvgSets, set: setFvgs }, () => bar);
  $("ob-btn").onclick = () => toggleObPanel($("ob-btn"), { get: () => obSets, set: setObs }, () => bar);
  $("sr-btn").onclick = () => toggleSrPanel($("sr-btn"), { get: () => srSets, set: setSrs }, () => bar);
  paintGroups();
}

function setAllData() {
  candleTimes = candles.map((c) => c.time);
  candleSeries.setData(candles.map(toBar));
  volumeSeries.setData(candles.map(toVol));
  overlays.setData(candles);
}

// ----------------------------------------------------------------------------- drawings
function setHint(text: string | null) {
  $("hint").textContent = text ?? DEFAULT_HINT;
}

function paintTools(tool: Tool) {
  $("tool-cursor").classList.toggle("active", tool === "cursor");
  $("tool-fib").classList.toggle("active", tool === "fib");
  $("tool-rect").classList.toggle("active", tool === "rect");
  $("tool-position").classList.toggle("active", tool === "position");
  const isLine = (LINE_KINDS as string[]).includes(tool);
  if (isLine && tool !== lastLine) {
    lastLine = tool as LineKind;
    store.set("lineTool", lastLine);
  }
  const lb = $("tool-line");
  lb.innerHTML = ICONS[lastLine]; // our own fixed SVG
  lb.classList.toggle("active", isLine);
  const key = TOOL_INFO[lastLine].key;
  lb.title = `${TOOL_INFO[lastLine].name}${key ? "（" + key + "）" : ""}；右下角小三角或按右鍵選其他線`;
}

const positionIo: PositionIo = {
  get: () => positionSettings,
  set: (v) => {
    positionSettings = v;
    savePosition(v);
    drawings.redraw();
  },
};

/** Double-click or right-click on a drawing: Fib levels for a Fib, the R lines for a position, otherwise
 *  that drawing's style. */
function openDrawingSettings(d: Drawing, x: number, y: number) {
  const alert = drawingAlertSection(alertUi, d, () => tradeStage(d));
  if (d.kind === "fib") {
    toggleFibPanel($("tool-settings"), { get: () => fibSettings, set: setFib }, alert);
    return;
  }
  if (d.kind === "position") {
    positionPanelAt(x, y, positionIo, {
      drawing: d,
      trade: () => drawings.tradeOf(d.id),
      update: (p) => drawings.updatePosition(d.id, p),
      remove: () => drawings.remove(d.id),
    }, alert);
    return;
  }
  openDrawingStyle(x, y, d, {
    set: (s) => {
      drawings.setStyle(d.id, s);
      if (d.kind === "rect") drawStyles = { ...drawStyles, rect: s as RectStyle };
      else drawStyles = { ...drawStyles, [d.kind]: s as LineStyle };
      saveDrawStyles(drawStyles);
    },
    remove: () => drawings.remove(d.id),
  }, alert);
}

/** Where a position stands on the chart: an alert made after its entry waits for the exit. */
function tradeStage(d: Drawing): TradeStage | null {
  if (d.kind !== "position") return null;
  const st = drawings.tradeOf(d.id)?.outcome.status;
  return st === "tp" || st === "sl" ? "done" : st === "open" || st === "expired" ? "open" : "wait";
}

function paintMagnet(active: boolean) {
  const b = $("tool-magnet");
  b.classList.toggle("on", magnet.on);
  b.classList.toggle("held", active && !magnet.on);
  b.title = `吸附到 K 線開高低收：${magnet.on ? "常開（按一下關閉）" : "常關（按一下開啟）"}；按住 ${magnetKeyLabel(magnet.holdKey)} 暫時吸附；右邊小箭頭或按右鍵改設定`;
}

const drawings = new DrawingLayer({
  chart,
  series: candleSeries,
  el: $("chart"),
  times: () => candleTimes,
  bars: () => candles,
  base: () => instId.split("-")[0],
  barSec: () => tfOf(bar).sec,
  ohlcAt: (i) => {
    const c = candles[i];
    return c ? [c.open, c.high, c.low, c.close] : null;
  },
  fmtPrice,
  fmtTime: (t) => fmtTime(toChartTime(t)),
  fib: () => fibSettings,
  magnet: () => magnet,
  position: () => positionSettings,
  styleFor: (k) => (k === "rect" ? drawStyles.rect ?? DEFAULT_RECT_STYLE : drawStyles[k] ?? DEFAULT_LINE_STYLE),
  changed: (list) => {
    if (!drawingsFor) return;
    saveDrawings(drawingsFor, list);
    alerts.drawingsChanged(drawingsFor, list);
  },
  toolChanged: paintTools,
  magnetActive: paintMagnet,
  openSettings: openDrawingSettings,
  hint: setHint,
});
candleSeries.attachPrimitive(drawings);

// ----------------------------------------------------------------------------- price alerts
const notifier = new Notifier({
  box: $("toasts"),
  options: () => alerts.options(),
  system: alertNotify,
  open: (id) => {
    if (id !== instId) void switchTo(id, bar);
  },
  fmtClock,
});
const alerts = new AlertService({
  watch: (ids) => {
    watchSymbols(ids).catch((e) => setStatus({ state: "error", detail: `提醒的報價：${e}` }));
  },
  loadDrawings,
  fib: () => fibSettings,
  kindName: (k) => TOOL_INFO[k].name,
  fmtPrice: fmtPriceOf,
  fmtTime: fmtClock,
  notify: (n) => notifier.show(n),
  isTf: (b) => TIMEFRAMES.some((t) => t.bar === b),
  read: readJson,
  write: writeJson,
  now: () => Date.now() / 1000,
});
const alertLayer = new AlertLayer({
  chart,
  series: candleSeries,
  alerts: () => (drawingsFor ? alerts.forSymbol(drawingsFor) : []),
  drawing: (a) => (a.target.kind === "drawing" ? drawings.find(a.target.id) : undefined),
  times: () => candleTimes,
  barSec: () => tfOf(bar).sec,
  fmtPrice,
});
candleSeries.attachPrimitive(alertLayer);
const alertUi: AlertUi = {
  service: alerts,
  instId: () => instId,
  bar: () => bar,
  price: () => candles[candles.length - 1]?.close ?? null,
  fmtPrice: fmtPriceOf,
  fmtClock,
  open: (id) => {
    if (id !== instId) void switchTo(id, bar);
  },
};

function paintAlertButton() {
  const on = alerts.all().filter((a) => a.on).length;
  $("alert-count").textContent = on ? String(on) : "";
  $("alert-btn").classList.toggle("on", on > 0);
}
let crossY: number | null = null; // crosshair y in the price pane
let mouseAt = { x: 0, y: 0 };
function setupAlerts() {
  alerts.subscribe(() => {
    alertLayer.redraw();
    paintAlertButton();
  });
  paintAlertButton();
  $("alert-btn").onclick = () => toggleAlertManager($("alert-btn"), alertUi);
  $("chart").addEventListener("mousemove", (e) => (mouseAt = { x: e.clientX, y: e.clientY }));
  // Alt+A: a new alert at the crosshair's price (or the last price), as on TradingView
  window.addEventListener("keydown", (e) => {
    if (!e.altKey || e.code !== "KeyA" || e.repeat || isTyping(document.activeElement)) return;
    e.preventDefault();
    const r = $("chart").getBoundingClientRect();
    const p = crossY != null ? priceAtY(crossY) : null;
    const at = crossY != null ? mouseAt : { x: r.left + r.width / 2 - 150, y: r.top + 80 };
    alertDialogAt(at.x, at.y, alertUi, p ?? alertUi.price());
  });
}

function setFib(v: FibSettings) {
  fibSettings = v;
  saveFib(v);
  drawings.refresh();
}
function setMagnet(v: MagnetSettings) {
  magnet = v;
  saveMagnet(v);
  drawings.refresh();
}
function openDrawSettings() {
  toggleFibPanel($("tool-settings"), { get: () => fibSettings, set: setFib });
}
function openMagnetSettings() {
  toggleMagnetPanel($("tool-magnet-menu"), { get: () => magnet, set: setMagnet });
}

let clearArmedUntil = 0;
function setupDrawingTools() {
  $("tool-cursor").onclick = () => drawings.setTool("cursor");
  $("tool-fib").onclick = () => drawings.setTool(drawings.getTool() === "fib" ? "cursor" : "fib");
  $("tool-rect").innerHTML = ICONS.rect;
  $("tool-rect").onclick = () => drawings.setTool(drawings.getTool() === "rect" ? "cursor" : "rect");
  $("tool-position").innerHTML = ICONS.position;
  $("tool-position").onclick = () => drawings.setTool(drawings.getTool() === "position" ? "cursor" : "position");
  const positionMenu = () => togglePositionPanel($("tool-position-menu"), positionIo);
  $("tool-position-menu").onclick = positionMenu;
  $("tool-position").oncontextmenu = (e) => {
    e.preventDefault();
    positionMenu();
  };
  $("tool-line").onclick = () => drawings.setTool(drawings.getTool() === lastLine ? "cursor" : lastLine);
  const lineMenu = () => toggleToolMenu($("tool-line-menu"), "線", LINE_KINDS, lastLine, (k) => drawings.setTool(k));
  $("tool-line-menu").onclick = lineMenu;
  $("tool-line").oncontextmenu = (e) => {
    e.preventDefault();
    lineMenu();
  };
  $("tool-magnet").onclick = () => setMagnet({ ...magnet, on: !magnet.on });
  $("tool-magnet").oncontextmenu = (e) => {
    e.preventDefault();
    openMagnetSettings();
  };
  $("tool-magnet-menu").onclick = () => openMagnetSettings();
  $("tool-settings").onclick = () => openDrawSettings();
  const clear = $("tool-clear");
  clear.onclick = () => {
    if (!drawings.count()) {
      setHint("這個幣種沒有畫線");
      setTimeout(() => setHint(null), 2000);
      return;
    }
    if (Date.now() < clearArmedUntil) {
      clearArmedUntil = 0;
      clear.classList.remove("armed");
      drawings.clearAll();
      setHint(null);
      return;
    }
    clearArmedUntil = Date.now() + 3000;
    clear.classList.add("armed");
    setHint(`再按一次，刪除 ${instId} 的全部 ${drawings.count()} 個畫線`);
    setTimeout(() => {
      if (Date.now() >= clearArmedUntil) {
        clear.classList.remove("armed");
        setHint(null);
      }
    }, 3100);
  };
  paintTools("cursor");
  paintMagnet(magnet.on);
}

// ----------------------------------------------------------------------------- legend, quote, status
function indexOfTime(t: number): number {
  let lo = 0, hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time === t) return mid;
    if (candles[mid].time < t) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

function renderLegend(param?: MouseEventParams) {
  const el = $("legend");
  el.replaceChildren();
  let i = candles.length - 1;
  if (param && param.time !== undefined) {
    const j = indexOfTime(fromChartTime(param.time));
    if (j >= 0) i = j;
  }
  el.append(span("name", `${instId} · ${tfOf(bar).label}`));
  const c = candles[i];
  if (!c) return;
  const prev = i > 0 ? candles[i - 1].close : c.open;
  const chg = prev ? (c.close - prev) / prev : 0;
  const cls = c.close >= c.open ? "up" : "down";
  for (const [k, v] of [["開", c.open], ["高", c.high], ["低", c.low], ["收", c.close]] as const) {
    el.append(span("k", k + " "), span(cls, fmtPrice(v)));
  }
  el.append(span(chg >= 0 ? "up" : "down", `  ${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(2)}%`));
  el.append(span("k", "量 "), span("", fmtVol(c.volume)));
  const mas = overlays.maLegend(i);
  if (mas.length) {
    const line = span("ma", "");
    for (const m of mas) {
      const s = span(m.state === "ok" ? "" : "muted", `${m.label} ${m.state === "ok" ? (m.value == null ? "—" : fmtPrice(m.value)) : STATE_TEXT[m.state]}   `);
      if (m.state === "ok") s.style.color = m.color;
      line.append(s);
    }
    el.append(line);
  }
  const zones = overlays.zonesLegend();
  if (zones.length) {
    const line = span("ma", "");
    for (const z of zones) {
      line.append(span("k", z.label + " "));
      if (z.state !== "ok") {
        line.append(span("muted", STATE_TEXT[z.state] + "   "));
        continue;
      }
      const up = span("", `${z.upText} ${z.up} `);
      up.style.color = z.upColor;
      const down = span("", `${z.downText} ${z.down}   `);
      down.style.color = z.downColor;
      line.append(up, down);
    }
    el.append(line);
  }
}

const STATE_TEXT: Record<IndState, string> = {
  ok: "",
  loading: "載入中…",
  lower: "（比圖表週期小，不顯示）",
  error: "（載入失敗，稍後重試）",
};

function updateQuote() {
  const c = candles[candles.length - 1];
  const inst = instruments.find((x) => x.instId === instId);
  const q = $("quote");
  q.replaceChildren();
  if (!c) return;
  const chg = inst && inst.last ? c.close / (inst.last / (1 + inst.change24h)) - 1 : null;
  q.append(span("", fmtPrice(c.close) + "  "));
  if (chg != null && isFinite(chg)) q.append(span(chg >= 0 ? "up" : "down", `24h ${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(2)}%`));
  document.title = `${instId} ${fmtPrice(c.close)} · QT Chart`;
}

function setStatus(s: StreamStatus) {
  const text: Record<StreamStatus["state"], string> = {
    connecting: "連線中…",
    ws: "即時（WebSocket）",
    polling: "輪詢更新中（每 2 秒）",
    error: "錯誤",
  };
  $("status-dot").className = "dot " + s.state;
  $("status").textContent = s.detail ? `${text[s.state]}：${s.detail}` : text[s.state];
}

// ----------------------------------------------------------------------------- loading
async function switchTo(newInst: string, newBar: string) {
  const symbolChanged = newInst !== drawingsFor;
  instId = newInst;
  bar = tfOf(newBar).bar;
  store.set("instId", instId);
  store.set("bar", bar);
  const my = ++seq;
  noMoreHistory = false;
  ($("symbol") as HTMLInputElement).value = instId;
  renderTimeframes();
  if (drawings.getTool() !== "cursor") drawings.setTool("cursor");
  if (symbolChanged) {
    drawingsFor = "";
    drawings.setDrawings([]); // the old symbol's drawings go away until the new bars are in
    overlays.setSymbol(instId);
  }
  overlays.setBar(bar);
  const inst = instruments.find((x) => x.instId === instId);
  decimals = inst ? inst.priceDecimals : decimals;
  const minMove = inst ? parseFloat(inst.tickSz) : Math.pow(10, -decimals);
  tick = minMove;
  // custom formatter on the price series only, so the volume pane keeps its own K/M format
  candleSeries.applyOptions({ priceFormat: { type: "custom", minMove, formatter: (p: number) => fmtPrice(p) } });
  setStatus({ state: "connecting", detail: "載入 K 線" });
  try {
    const data = await getCandles(instId, bar, null, INITIAL_BARS);
    if (my !== seq) return;
    candles = data;
    setAllData();
    if (drawingsFor !== instId) {
      drawingsFor = instId;
      drawings.setDrawings(loadDrawings(instId));
    }
    const n = candles.length;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 160), to: n + 8 });
    renderLegend();
    updateQuote();
    await startStream(instId, bar);
  } catch (e) {
    if (my === seq) setStatus({ state: "error", detail: `載入失敗：${e}` });
  }
}

async function loadOlder() {
  if (loadingOlder || noMoreHistory || !candles.length) return;
  loadingOlder = true;
  const my = seq;
  try {
    const older = await getCandles(instId, bar, candles[0].time * 1000, OLDER_BARS);
    if (my !== seq) return;
    const fresh = older.filter((c) => c.time < candles[0].time);
    if (!fresh.length) {
      noMoreHistory = true;
      return;
    }
    const range = chart.timeScale().getVisibleLogicalRange();
    candles = fresh.concat(candles);
    setAllData();
    if (range) chart.timeScale().setVisibleLogicalRange({ from: range.from + fresh.length, to: range.to + fresh.length });
  } catch (e) {
    setStatus({ state: "error", detail: `載入更早的 K 線失敗：${e}` });
  } finally {
    loadingOlder = false;
  }
}

let reloading = false;
async function reloadRecent() {
  // after a gap in the live feed (e.g. the computer slept): merge the latest bars from REST, once at a time
  if (reloading) return;
  reloading = true;
  const my = seq;
  try {
    const recent = await getCandles(instId, bar, null, 300);
    if (my !== seq || !recent.length) return;
    const cut = recent[0].time;
    candles = candles.filter((c) => c.time < cut).concat(recent);
    overlays.resyncOthers(); // other timeframes may have missed bars too
    setAllData();
    renderLegend();
    updateQuote();
  } catch (e) {
    setStatus({ state: "error", detail: `補抓最新 K 線失敗：${e}` });
  } finally {
    reloading = false;
  }
}

function applyLive(c: Candle) {
  const last = candles[candles.length - 1];
  if (!last || c.time < last.time) return;
  if (c.time > last.time + tfOf(bar).sec * 1.5) {
    void reloadRecent();
    return;
  }
  if (c.time === last.time) {
    candles[candles.length - 1] = c;
  } else {
    candles.push(c);
    candleTimes.push(c.time);
  }
  candleSeries.update(toBar(c));
  volumeSeries.update(toVol(c));
  overlays.tick(c);
  if (!hovering) renderLegend();
  updateQuote();
}

// ----------------------------------------------------------------------------- toolbar
function renderTimeframes() {
  const nav = $("timeframes");
  nav.replaceChildren();
  for (const tf of TIMEFRAMES) {
    const b = document.createElement("button");
    b.className = "tf-btn" + (tf.bar === bar ? " active" : "");
    b.textContent = tf.label;
    b.onclick = () => { if (tf.bar !== bar) void switchTo(instId, tf.bar); };
    nav.append(b);
  }
}

let listActive = 0;
let listRows: Instrument[] = [];
function renderSymbolList(filter: string) {
  const box = $("symbol-list");
  const q = filter.trim().toUpperCase().replace(/[-\s/]/g, "");
  listRows = instruments.filter((i) => !q || i.instId.replace(/-/g, "").includes(q)).slice(0, 80);
  listActive = Math.min(listActive, Math.max(0, listRows.length - 1));
  box.replaceChildren();
  listRows.forEach((inst, k) => {
    const row = document.createElement("div");
    row.className = "symbol-row" + (k === listActive ? " active" : "");
    row.append(span("", `${inst.base}USDT 永續`));
    const p = inst.last;
    row.append(span("px", p ? p.toLocaleString("en-US", { maximumFractionDigits: inst.priceDecimals }) : ""));
    row.append(span("chg " + (inst.change24h >= 0 ? "up" : "down"), `${inst.change24h >= 0 ? "+" : ""}${(inst.change24h * 100).toFixed(2)}%`));
    row.onmousedown = (e) => { e.preventDefault(); pick(inst.instId); };
    box.append(row);
  });
  box.hidden = listRows.length === 0;
}
function pick(id: string) {
  const input = $("symbol") as HTMLInputElement;
  $("symbol-list").hidden = true;
  input.blur();
  if (id !== instId) void switchTo(id, bar); else input.value = instId;
}
function setupSymbolBox() {
  const input = $("symbol") as HTMLInputElement;
  // focusing empties the box (like a search dialog); leaving it without a pick restores the current symbol
  input.addEventListener("focus", () => { closePopover(); input.value = ""; listActive = 0; renderSymbolList(""); });
  input.addEventListener("input", () => { listActive = 0; renderSymbolList(input.value); });
  input.addEventListener("blur", () => { $("symbol-list").hidden = true; input.value = instId; });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      listActive = Math.max(0, Math.min(listRows.length - 1, listActive + (e.key === "ArrowDown" ? 1 : -1)));
      renderSymbolList(input.value);
    } else if (e.key === "Enter") {
      if (listRows[listActive]) pick(listRows[listActive].instId);
    } else if (e.key === "Escape") {
      input.blur();
    }
  });
}

// ----------------------------------------------------------------------------- start
chart.subscribeCrosshairMove((p) => {
  hovering = p.time !== undefined;
  crossY = p.point && (p.paneIndex ?? 0) === 0 ? p.point.y : null;
  renderLegend(hovering ? p : undefined);
});
chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
  if (r && r.from < 30) void loadOlder();
});

// Toolbar buttons don't take keyboard focus when clicked: no focus ring, and Space/Enter/Delete stay with the chart.
document.addEventListener("mousedown", (e) => {
  if ((e.target as Element | null)?.closest?.(".icon-btn, .icon-caret, .tf-btn, .tool-btn")) e.preventDefault();
});

async function main() {
  renderTimeframes();
  setupSymbolBox();
  setupDrawingTools();
  setupIndicatorButtons();
  setupScaleMenu();
  setupAlerts();
  applyLabels();
  applyAppearance();
  $("credit").onclick = (e) => {
    e.preventDefault();
    openTradingView().catch((err) => setStatus({ state: "error", detail: String(err) }));
  };
  setHint(null);
  await onStatus(setStatus);
  await onCandle((e) => { if (e.instId === instId && e.bar === bar) applyLive(e.candle); });
  await onWatchCandle((e) => alerts.onCandle(e.instId, e.candle));
  try {
    instruments = await listInstruments();
    instById = new Map(instruments.map((i) => [i.instId, i]));
  } catch (e) {
    setStatus({ state: "error", detail: `讀不到幣種清單：${e}` });
  }
  alerts.start();
  if (instruments.length && !instruments.some((i) => i.instId === instId)) instId = instruments[0].instId;
  await switchTo(instId, bar);
}

void main();
