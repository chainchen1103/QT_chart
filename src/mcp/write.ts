// Tools that change the charts: what they show (symbol, timeframe, layout, tabs, view, bar replay), drawings
// (undone by the user with 還原), alerts, Pine scripts and the settings. Each says in the status bar who did it.

import { shortName } from "../core/format.ts";
import { checkPrices } from "../drawings/trade.ts";
import { condsFor, type AlertCond, type Repeat } from "../alerts/model.ts";
import { LAYOUT_IDS, LAYOUTS, MAX_TABS, type LayoutId } from "../layout/model.ts";
import { load } from "../pine/index.ts";
import { SPEEDS } from "../chart/replay.ts";
import { loadDrawings } from "../settings/store.ts";
import {
  CHANNEL_DEV,
  cleanAppearance,
  cleanBars,
  cleanDrawings,
  cleanFib,
  cleanFvgs,
  cleanGroups,
  cleanLabels,
  cleanMagnet,
  cleanMaOptions,
  cleanMas,
  cleanObs,
  cleanPosition,
  cleanSrs,
  cleanSync,
  cleanTimeframes,
  DASHES,
  DEFAULT_LINE_STYLE,
  DEFAULT_RECT_STYLE,
  defaultChannelStyle,
  isChannel,
  LINE_WIDTHS,
  MA_COLORS,
  MAX_DRAWINGS,
  MAX_PINE_SCRIPTS,
  MAX_PINE_SOURCE,
  newId,
  nextColor,
  POSITION_LIMITS,
  TOOL_INFO,
  type ChannelStyle,
  type Drawing,
  type DrawKind,
  type LineStyle,
  type PineScript,
  type PositionDrawing,
  type RectStyle,
} from "../settings/model.ts";
import { cleanOptions } from "../alerts/model.ts";
import { ArgError, bool, data, normalizeTf, num, obj, oneOf, points, str, text, type Args, type ToolResult } from "./model.ts";
import { drawingOut } from "./read.ts";
import { CHART, chartArg, chartFor, chartsOf, COLOR, findDrawing, POINT, S, SYMBOL, symbolArg, tfArg, TIMEFRAME, who, type CallCtx, type McpApp, type Tool } from "./tools.ts";

const KINDS = Object.keys(TOOL_INFO) as DrawKind[];
const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DELETE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

const STYLE = S.obj("Look. Lines: color, width (1 to 4), dash (solid, dash, dot). Rectangles: color (border), fill, transparency (0 solid to 100 clear), extend (to the right). Channels: color, width, dash, fill, transparency, middle (middle line), extend_left, extend_right; regression also std_dev (0.1 to 10) and pearson.", {
  color: COLOR,
  width: S.int("Line width, 1 to 4.", { minimum: 1, maximum: 4 }),
  dash: S.oneOf(["solid", "dash", "dot"], "Line style."),
  fill: COLOR,
  transparency: S.int("Fill transparency, 0 (solid) to 100 (clear).", { minimum: 0, maximum: 100 }),
  extend: S.bool("Rectangle: run on to the right."),
  middle: S.bool("Channel: the dashed middle line."),
  extend_left: S.bool("Channel: run on to the left."),
  extend_right: S.bool("Channel: run on to the right."),
  std_dev: S.num("Regression: outer lines this many standard deviations away.", { minimum: 0.1, maximum: 10 }),
  pearson: S.bool("Regression: show Pearson's R."),
});

const POSITION_FIELDS = {
  entry: S.num("Position: entry price."),
  stop_loss: S.num("Position: stop-loss price (below the entry: long, above: short)."),
  take_profit: S.num("Position: take-profit price."),
  time: S.num("Position: entry bar time (UTC seconds). Default: the newest bar."),
  end_time: S.num("Position: where its box ends (UTC seconds). Default: 20 bars after the entry."),
  risk: S.num("Position: risk per trade, % of capital or an amount in USDT (risk_mode). Default: the position defaults."),
  risk_mode: S.oneOf(["pct", "amount"], "Position: risk as a % of capital or a fixed USDT amount."),
  leverage: S.int("Position: leverage, 1 to 125.", { minimum: 1, maximum: 125 }),
  capital: S.num("Position: its own starting capital in USDT (default: carried from the previous position, or the account's equity)."),
};

export function writeTools(app: McpApp): Tool[] {
  return [
    // ------------------------------------------------------------------- what the charts show
    {
      name: "set_chart",
      title: "Change a chart",
      description: "Show another symbol and / or timeframe on a chart, put it in use, or reset its view (newest bars, default zoom). Waits until the bars are in.",
      level: "write",
      input: {
        type: "object",
        properties: {
          chart: CHART,
          symbol: S.str("Symbol to show, e.g. ETH-USDT-SWAP."),
          timeframe: TIMEFRAME,
          select: S.bool("Make it the chart in use (the toolbars act on it)."),
          reset_view: S.bool("Back to the newest bars at the default zoom."),
        },
      },
      annotations: { ...EDIT, idempotentHint: true },
      run: async (a, c) => {
        const p = chartArg(app, a);
        const i = app.workspace.charts().indexOf(p);
        const instId = a.symbol != null ? symbolArg(app, a) : p.feed.instId;
        const bar = tfArg(a) ?? p.feed.bar;
        if (bool(a, "select")) app.workspace.useChart(i);
        if (instId !== p.feed.instId || bar !== p.feed.bar) {
          await p.switchTo(instId, bar);
          app.note(`${who(c)}：圖表 ${i + 1} 換成 ${shortName(instId)} ${bar}`);
        }
        if (bool(a, "reset_view")) p.resetView();
        if (!p.feed.current) return text(`Chart ${i} could not load ${instId} ${bar} (see the status bar in QT Chart).`);
        return data({ chart: i, symbol: p.feed.instId, timeframe: p.feed.bar, bars: p.feed.bars.length, lastPrice: p.feed.bars[p.feed.bars.length - 1]?.close ?? null, inUse: p === app.workspace.inUse() });
      },
    },
    {
      name: "set_layout",
      title: "Split the tab",
      description: `How the shown tab splits into charts: ${LAYOUT_IDS.map((id) => `${id} (${layoutText(id)})`).join(", ")}. New charts show what the chart in use shows; charts a smaller layout drops are remembered.`,
      level: "write",
      input: { type: "object", properties: { layout: S.oneOf(LAYOUT_IDS, "The layout.") }, required: ["layout"] },
      annotations: { ...EDIT, idempotentHint: true },
      run: (a, c) => {
        const id = oneOf(a, "layout", LAYOUT_IDS);
        app.workspace.setLayout(id);
        app.note(`${who(c)}：版面改成${LAYOUTS[id].name}`);
        return data({ layout: id, charts: app.workspace.charts().map((p, i) => ({ chart: i, symbol: p.feed.instId, timeframe: p.feed.bar })) });
      },
    },
    {
      name: "manage_tabs",
      title: "Tabs",
      description: `Add a tab (after the shown one, showing what the chart in use shows, or the symbol / timeframe given), show another tab, or close one. At most ${MAX_TABS} tabs; the last one can't be closed.`,
      level: "write",
      input: {
        type: "object",
        properties: {
          action: S.oneOf(["add", "select", "close"], "What to do."),
          tab: S.int("The tab to show or close, by its index in get_app_state.", { minimum: 0 }),
          symbol: S.str("add: the symbol the new tab shows."),
          timeframe: TIMEFRAME,
        },
        required: ["action"],
      },
      annotations: EDIT,
      run: async (a, c) => {
        const ws = app.workspace;
        const action = oneOf(a, "action", ["add", "select", "close"] as const);
        if (action === "add") {
          const instId = a.symbol != null ? symbolArg(app, a) : null;
          const bar = tfArg(a);
          if (!ws.addTab()) throw new ArgError(`There are already ${MAX_TABS} tabs`);
          const p = ws.inUse();
          if ((instId && instId !== p.feed.instId) || (bar && bar !== p.feed.bar)) await p.switchTo(instId ?? p.feed.instId, bar ?? p.feed.bar);
          app.note(`${who(c)}：新增分頁`);
        } else {
          const i = num(a, "tab", { int: true, min: 0 });
          if (i >= ws.tabs().length) throw new ArgError(`There is no tab ${i}: there are ${ws.tabs().length}`);
          if (action === "select") ws.selectTab(i);
          else {
            if (ws.tabs().length <= 1) throw new ArgError("The last tab can't be closed");
            ws.closeTab(i);
            app.note(`${who(c)}：關掉分頁 ${i + 1}`);
          }
        }
        return data({ shownTab: ws.shownIndex(), tabs: ws.tabs().length, charts: ws.charts().map((p, i) => ({ chart: i, symbol: p.feed.instId, timeframe: p.feed.bar })) });
      },
    },
    {
      name: "replay",
      title: "Bar replay",
      description:
        "Bar replay on a chart: start from a past bar (the later bars are hidden), step forward bar by bar, play or pause, or stop (back to live). Indicators, Pine scripts and positions see only the bars shown; read them with get_candles (chart), get_indicators or get_chart_image after each step.",
      level: "write",
      input: {
        type: "object",
        properties: {
          chart: CHART,
          action: S.oneOf(["start", "step", "play", "pause", "stop"], "What to do."),
          time: S.num("start: the bar to replay from (UTC seconds); older bars load as needed."),
          bars: S.int("step: how many bars (1 to 500, default 1).", { minimum: 1, maximum: 500 }),
          speed: { type: "integer", enum: SPEEDS, description: "play: bars a second." },
        },
        required: ["action"],
      },
      annotations: EDIT,
      run: async (a, c) => {
        const p = chartArg(app, a);
        const r = p.replay;
        const action = oneOf(a, "action", ["start", "step", "play", "pause", "stop"] as const);
        if (action === "start") {
          const t = num(a, "time", { min: 0 });
          if (!p.feed.current) throw new ArgError("The chart's bars are still loading");
          if (!(await r.startAt(t > 1e11 ? Math.floor(t / 1000) : t))) throw new ArgError("There are no bars after that time to replay: pick an earlier one");
          app.note(`${who(c)}：開始 K 線重播`);
        } else if (!p.feed.replaying) {
          if (action !== "stop") throw new ArgError("The chart is not in a bar replay: start one first");
        } else if (action === "step") {
          r.stepBy(num(a, "bars", { optional: true, int: true, min: 1, max: 500 }) ?? 1);
        } else if (action === "play") {
          const speed = num(a, "speed", { optional: true, int: true });
          if (speed != null && !SPEEDS.includes(speed)) throw new ArgError(`speed must be one of ${SPEEDS.join(", ")}`);
          r.play(speed);
        } else if (action === "pause") r.pause();
        else r.stop();
        const last = p.feed.bars[p.feed.bars.length - 1];
        return data({
          chart: app.workspace.charts().indexOf(p),
          replaying: p.feed.replaying,
          playing: r.playing,
          barsAhead: p.feed.ahead,
          lastBar: last ? { time: last.time, open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume } : null,
        });
      },
    },

    // ------------------------------------------------------------------- drawings
    {
      name: "add_drawing",
      title: "Draw",
      description:
        "Draw on a symbol (it shows on every chart of the symbol; the user can undo it with 還原 or Ctrl+Z). Points by kind: hline, hray (to the right), vline, cross: 1 point. trend, ray, extended (both ways), info, angle, fib, rect, regression: 2 points. channel (parallel), flat (flat top / bottom), disjoint: 2 points for the first line plus second_line_price, the second line's price at the first point's time. position (a planned trade, sized from the risk settings; place_order sends it to OKX): entry, stop_loss, take_profit instead of points.",
      level: "write",
      input: {
        type: "object",
        properties: {
          symbol: SYMBOL,
          kind: S.oneOf(KINDS, "What to draw."),
          points: { type: "array", items: POINT, minItems: 1, maxItems: 2, description: "1 or 2 points as {time, price}, by kind." },
          second_line_price: S.num("channel, flat, disjoint: the second line's price at the first point's time."),
          style: STYLE,
          ...POSITION_FIELDS,
        },
        required: ["kind"],
      },
      annotations: EDIT,
      run: async (a, c) => {
        const instId = symbolArg(app, a);
        const kind = oneOf(a, "kind", KINDS);
        const d = kind === "position" ? positionFrom(app, instId, a) : drawingFrom(app, kind, a);
        app.editDrawings(instId, (list) => {
          if (list.length >= MAX_DRAWINGS) throw new ArgError(`${shortName(instId)} already has ${MAX_DRAWINGS} drawings: delete some first`);
          list.push(d);
          return true;
        });
        app.note(`${who(c)} 在 ${shortName(instId)} 畫了${TOOL_INFO[kind].name}`);
        return data({ symbol: instId, added: drawingOut(app, instId, d, await readyChart(app, instId, kind === "position")) });
      },
    },
    {
      name: "update_drawing",
      title: "Change a drawing",
      description:
        "Move or restyle a drawing: new points, second_line_price, style, or a position's prices, times, risk, leverage and capital (fields not given stay). A position with an order on OKX keeps its entry; use move_stops for its stop-loss and take-profit. One step to undo.",
      level: "write",
      input: {
        type: "object",
        properties: {
          symbol: SYMBOL,
          id: S.str("The drawing (list_drawings)."),
          points: { type: "array", items: POINT, minItems: 1, maxItems: 2, description: "New points, as many as its kind has." },
          second_line_price: S.num("channel, flat, disjoint: the second line's price at the first point's time."),
          style: STYLE,
          ...POSITION_FIELDS,
        },
        required: ["id"],
      },
      annotations: { ...EDIT, idempotentHint: true },
      run: async (a, c) => {
        const instId = symbolArg(app, a);
        const id = str(a, "id", { max: 80 });
        const before = findDrawing(loadDrawings(instId), id, instId);
        const d = before.kind === "position" ? positionChanged(app, instId, before, a) : drawingChanged(before, a);
        app.editDrawings(instId, (list) => {
          const i = list.findIndex((x) => x.id === id);
          if (i < 0 || JSON.stringify(list[i]) === JSON.stringify(d)) return false;
          list[i] = d;
          return true;
        });
        app.note(`${who(c)} 改了 ${shortName(instId)} 的${TOOL_INFO[d.kind].name}`);
        return data({ symbol: instId, drawing: drawingOut(app, instId, d, await readyChart(app, instId, d.kind === "position")) });
      },
    },
    {
      name: "delete_drawings",
      title: "Delete drawings",
      description: "Delete drawings of a symbol by id, or all of them. Their alerts go too. An order already on OKX stays there: cancel_order cancels it. One step to undo.",
      level: "write",
      input: {
        type: "object",
        properties: { symbol: SYMBOL, ids: { type: "array", items: { type: "string" }, description: "The drawings to delete." }, all: S.bool("Delete every drawing of the symbol.") },
      },
      annotations: DELETE,
      run: (a, c) => {
        const instId = symbolArg(app, a);
        const all = bool(a, "all") ?? false;
        const ids = Array.isArray(a.ids) ? a.ids.filter((x): x is string => typeof x === "string") : [];
        if (!all && !ids.length) throw new ArgError("Give ids, or all: true");
        let gone: Drawing[] = [];
        app.editDrawings(instId, (list) => {
          if (!all) for (const id of ids) findDrawing(list, id, instId);
          gone = list.filter((d) => all || ids.includes(d.id));
          const keep = list.filter((d) => !gone.includes(d));
          list.splice(0, list.length, ...keep);
          return gone.length > 0;
        });
        if (gone.length) app.note(`${who(c)} 刪了 ${shortName(instId)} 的 ${gone.length} 個畫線`);
        const live = gone.filter((d) => d.kind === "position" && d.order && ["live", "partially_filled"].includes(d.order.state));
        return data({ symbol: instId, deleted: gone.map((d) => d.id), ...(live.length ? { note: `${live.length} of them had an order still open on OKX: it stays there.` } : {}) });
      },
    },
    {
      name: "undo_drawings",
      title: "Undo drawings",
      description: "Undo the last change to a symbol's drawings (by the user or an AI app), or redo the change undone last, as 還原 / 重做 in QT Chart do. Orders on OKX are not undone.",
      level: "write",
      input: { type: "object", properties: { symbol: SYMBOL, redo: S.bool("Redo instead of undo.") } },
      annotations: EDIT,
      run: (a, c) => {
        const instId = symbolArg(app, a);
        const redo = bool(a, "redo") ?? false;
        const list = redo ? app.history.redo(instId) : app.history.undo(instId);
        if (!list) return text(redo ? "Nothing to redo." : "Nothing to undo.");
        app.quietDrawings(instId, (cur) => {
          cur.splice(0, cur.length, ...list);
          return true;
        });
        app.note(`${who(c)}：${redo ? "重做" : "還原"} ${shortName(instId)} 的畫線`);
        return data({ symbol: instId, drawings: list.length });
      },
    },

    // ------------------------------------------------------------------- alerts
    {
      name: "save_alert",
      title: "Add or change an alert",
      description:
        "A new alert (with price, or drawing_id: a drawing has at most one alert, a new one replaces it), or changes to one (with id). Conditions: a price or a line: touch, up (crosses up), down (crosses down); rectangles: enter, exit; channels: exit, enter, touch, up, down; vertical lines: time; positions: trade (entry, then stop-loss or take-profit). Alerts sound in QT Chart and show a Windows notification.",
      level: "write",
      input: {
        type: "object",
        properties: {
          id: S.str("Change this alert (list_alerts) instead of adding one."),
          symbol: SYMBOL,
          price: S.num("A price alert at this price."),
          drawing_id: S.str("An alert on this drawing (list_drawings)."),
          condition: S.oneOf(["touch", "up", "down", "enter", "exit", "time", "trade"], "When it goes off (default: the first that fits)."),
          repeat: S.oneOf(["once", "every"], "once: switch off after going off; every: stay on, at most once a minute."),
          note: S.str("A note shown with it (up to 120 characters)."),
          on: S.bool("Switch it on or off."),
          timeframe: { ...TIMEFRAME, description: "For sloped lines: read the line at this timeframe's bar start. Default: a chart's timeframe." },
        },
      },
      annotations: EDIT,
      run: (a, c) => saveAlert(app, a, c),
    },
    {
      name: "delete_alert",
      title: "Delete an alert",
      description: "Delete an alert by id.",
      level: "write",
      input: { type: "object", properties: { id: S.str("The alert (list_alerts).") }, required: ["id"] },
      annotations: DELETE,
      run: (a, c) => {
        const id = str(a, "id", { max: 80 });
        const al = app.alerts.all().find((x) => x.id === id);
        if (!al) throw new ArgError(`No alert ${id}`);
        app.alerts.remove(id);
        app.note(`${who(c)} 刪了 ${shortName(al.instId)} 的提醒`);
        return data({ deleted: id });
      },
    },

    // ------------------------------------------------------------------- Pine scripts
    {
      name: "save_pine_script",
      title: "Add or change a Pine script",
      description:
        "Add a Pine Script v5 / v6 indicator or strategy (every chart runs the ones switched on), or change one by id: name, source, on, inputs (by input title or id; null puts one back to its default). The source must compile; the error says the line. Results: get_indicators.",
      level: "write",
      input: {
        type: "object",
        properties: {
          id: S.str("Change this script (list_pine_scripts) instead of adding one."),
          name: S.str("Name in the list (default: the script's title)."),
          source: S.str(`Pine source code (up to ${MAX_PINE_SOURCE} characters).`),
          on: S.bool("Run it on the charts (default for a new one: on)."),
          inputs: { type: "object", description: "Input values by input title or id, e.g. {\"Length\": 20}.", additionalProperties: true },
        },
      },
      annotations: EDIT,
      run: (a, c) => savePine(app, a, c),
    },
    {
      name: "delete_pine_script",
      title: "Delete a Pine script",
      description: "Delete a Pine script by id.",
      level: "write",
      input: { type: "object", properties: { id: S.str("The script (list_pine_scripts).") }, required: ["id"] },
      annotations: DELETE,
      run: (a, c) => {
        const id = str(a, "id", { max: 80 });
        const list = app.settings.pine.get();
        const s = list.find((x) => x.id === id);
        if (!s) throw new ArgError(`No Pine script ${id}`);
        app.settings.pine.set(list.filter((x) => x.id !== id));
        app.note(`${who(c)} 刪了 Pine 腳本 ${s.name}`);
        return data({ deleted: id });
      },
    },

    // ------------------------------------------------------------------- settings
    {
      name: "update_settings",
      title: "Change settings",
      description:
        "Change settings. Send only the sections and fields to change, shaped as get_settings returns them: appearance, labels, timeframes, bars, fib, magnet, position (its look: levels, profit, loss, transparency, showPrices, infoHover; capital, risk and leverage defaults only change in QT Chart), indicatorSwitches, movingAverages, maOptions, fvg, orderBlocks, supportResistance, alertOptions, okxSync. Objects merge field by field; lists (movingAverages, fvg, orderBlocks, supportResistance, fib.levels, position.levels, timeframes.bar) replace the whole list. Values out of range are put back and listed in the answer.",
      level: "write",
      input: {
        type: "object",
        properties: Object.fromEntries(Object.entries(SECTIONS).map(([k, x]) => [k, { type: x.list ? "array" : "object", description: x.about, ...(x.list ? { items: { type: "object" } } : {}) }])),
      },
      annotations: { ...EDIT, idempotentHint: true },
      run: (a, c) => updateSettings(app, a, c),
    },
  ];
}

const layoutText = (id: LayoutId) => LAYOUTS[id].areas.join(" / ");

/** A chart with the symbol's drawings on it, for their sizes (a position's) when there is one already or when
 *  `need`: then the chart in use switches to it. */
async function readyChart(app: McpApp, instId: string, need: boolean) {
  const on = chartsOf(app, instId).find((p) => p.feed.current);
  if (on || !need) return on;
  return (await chartFor(app, instId)) ?? undefined;
}

// ----------------------------------------------------------------------------- drawings from what an app sends
function color(s: Args, key: string): string | undefined {
  const v = str(s, key, { optional: true, max: 9 });
  if (v == null) return undefined;
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw new ArgError(`style.${key} must be a color like #2962ff`);
  return v;
}

/** The style an app asked for on top of `base` (each field checked). */
function styled<T extends LineStyle | RectStyle | ChannelStyle>(base: T, s: Args | undefined, kind: DrawKind): T {
  if (!s) return base;
  const out: Record<string, unknown> = { ...base };
  const width = num(s, "width", { optional: true, int: true });
  if (width != null && !LINE_WIDTHS.includes(width)) throw new ArgError("style.width must be 1 to 4");
  const dash = s.dash == null ? undefined : oneOf(s, "dash", DASHES.map((d) => d.key));
  const c = color(s, "color");
  if (width != null) out.width = width;
  if (dash) out.dash = dash;
  if (kind === "rect") {
    if (c) out.border = c;
  } else if (c) out.color = c;
  if (kind === "rect" || isChannel(kind)) {
    const fill = color(s, "fill");
    const tr = num(s, "transparency", { optional: true, int: true, min: 0, max: 100 });
    if (fill) out.fill = fill;
    if (tr != null) out.transparency = tr;
  }
  if (kind === "rect") {
    const ext = bool(s, "extend");
    if (ext != null) out.extend = ext;
  }
  if (isChannel(kind)) {
    for (const [k, to] of [["middle", "middle"], ["extend_left", "extendLeft"], ["extend_right", "extendRight"], ["pearson", "pearson"]] as const) {
      const v = bool(s, k);
      if (v != null) out[to] = v;
    }
    const dev = num(s, "std_dev", { optional: true, min: CHANNEL_DEV.min, max: CHANNEL_DEV.max });
    if (dev != null) out.dev = dev;
  }
  return out as T;
}

function defaultStyle(app: McpApp, kind: Exclude<DrawKind, "fib" | "position">): LineStyle | RectStyle | ChannelStyle {
  const styles = app.settings.drawStyles.get();
  if (kind === "rect") return styles.rect ?? DEFAULT_RECT_STYLE;
  if (isChannel(kind)) return styles[kind] ?? defaultChannelStyle(kind);
  return styles[kind] ?? DEFAULT_LINE_STYLE;
}

/** Points of a kind from `a.points` (a channel's two, plus its second line). */
function anchorsFor(kind: DrawKind, a: Args) {
  const n = Math.min(2, TOOL_INFO[kind].points);
  const pts = points(a, "points", n, n);
  const A = { t: pts[0].t, p: pts[0].p };
  const B = n === 2 ? { t: pts[1].t, p: pts[1].p } : { ...A };
  if (n === 2 && B.t === A.t && kind !== "vline") throw new ArgError("The two points need different times");
  return { A, B };
}

function drawingFrom(app: McpApp, kind: Exclude<DrawKind, "position">, a: Args): Drawing {
  const { A, B } = anchorsFor(kind, a);
  const id = newId(kind);
  let raw: Record<string, unknown>;
  if (kind === "fib") raw = { id, kind, a: A, b: B };
  else {
    const style = styled(defaultStyle(app, kind), obj(a, "style"), kind);
    raw = { id, kind, a: A, b: B, style };
    if (isChannel(kind)) {
      const second = kind === "regression" ? A.p : num(a, "second_line_price", { min: 0 });
      raw.c = { t: A.t, p: second };
    }
  }
  return checked(raw, kind);
}

/** A drawing as saving would keep it; an error when it wouldn't be kept as asked. */
function checked(raw: Record<string, unknown>, kind: DrawKind): Drawing {
  const [d] = cleanDrawings([raw]);
  if (!d || d.kind !== kind) throw new ArgError(`That ${kind} can't be drawn: check its points and prices`);
  return d;
}

function drawingChanged(d: Exclude<Drawing, PositionDrawing>, a: Args): Drawing {
  const raw: Record<string, unknown> = JSON.parse(JSON.stringify(d));
  if (a.points != null) {
    const { A, B } = anchorsFor(d.kind, a);
    raw.a = A;
    raw.b = B;
    if (isChannel(d.kind)) raw.c = { t: A.t, p: d.kind === "regression" ? A.p : (raw.c as { p: number }).p };
  }
  if (a.second_line_price != null && isChannel(d.kind) && d.kind !== "regression") raw.c = { t: (raw.a as { t: number }).t, p: num(a, "second_line_price", { min: 0 }) };
  if (a.style != null && d.kind !== "fib") raw.style = styled(d.style, obj(a, "style"), d.kind);
  return checked(raw, d.kind);
}

/** Bar length and newest bar time for a symbol: from a chart that shows it, else from the chart in use's
 *  timeframe and the clock. */
function barsOf(app: McpApp, instId: string): { sec: number; newest: number } {
  const p = chartsOf(app, instId).find((x) => x.feed.current && x.feed.bars.length);
  if (p) return { sec: p.feed.tf.sec, newest: p.feed.bars[p.feed.bars.length - 1].time };
  const sec = app.workspace.inUse().feed.tf.sec;
  return { sec, newest: Math.floor(Date.now() / 1000 / sec) * sec };
}

/** A new position from entry / stop_loss / take_profit and the defaults; `entry` given here when the app may
 *  leave it out (a market order: the last price). */
export function positionFrom(app: McpApp, instId: string, a: Args, entry?: number): PositionDrawing {
  const e = num(a, "entry", { optional: true, min: 0 }) ?? entry;
  if (e == null) throw new ArgError("entry is required");
  const stop = num(a, "stop_loss", { min: 0 });
  const target = num(a, "take_profit", { min: 0 });
  const bad = checkPrices({ entry: e, stop, target });
  if (bad) throw new ArgError(bad);
  const { sec, newest } = barsOf(app, instId);
  const tArg = num(a, "time", { optional: true, min: 0 });
  const t = tArg == null ? newest : Math.floor((tArg > 1e11 ? tArg / 1000 : tArg) / sec) * sec;
  const endArg = num(a, "end_time", { optional: true, min: 0 });
  const end = endArg == null ? t + 20 * sec : endArg > 1e11 ? Math.floor(endArg / 1000) : endArg;
  if (end <= t) throw new ArgError("end_time must be after the entry time");
  const def = app.settings.position.get();
  const sizing = sizingArgs(a, def);
  const d: PositionDrawing = {
    id: newId("position"),
    kind: "position",
    a: { t, p: e },
    b: { t: end, p: stop },
    target,
    capital: sizing.capital ?? null,
    risk: sizing.risk ?? def.risk,
    riskMode: sizing.riskMode ?? def.riskMode,
    leverage: sizing.leverage ?? def.leverage,
  };
  return checked(d, "position") as PositionDrawing;
}

/** risk / risk_mode / leverage / capital as given (checked against the position limits). */
function sizingArgs(a: Args, def: { riskMode: "pct" | "amount" }) {
  const riskMode = a.risk_mode == null ? undefined : oneOf(a, "risk_mode", ["pct", "amount"] as const);
  const mode = riskMode ?? def.riskMode;
  const lim = POSITION_LIMITS[mode];
  const risk = num(a, "risk", { optional: true, min: lim.min, max: lim.max });
  if (riskMode && riskMode !== def.riskMode && risk == null) throw new ArgError("Give risk with a risk_mode other than the default");
  const leverage = num(a, "leverage", { optional: true, int: true, min: POSITION_LIMITS.leverage.min, max: POSITION_LIMITS.leverage.max });
  const capital = num(a, "capital", { optional: true, min: POSITION_LIMITS.capital.min, max: POSITION_LIMITS.capital.max });
  return { riskMode, risk, leverage, capital };
}

function positionChanged(app: McpApp, instId: string, d: PositionDrawing, a: Args): PositionDrawing {
  if (d.okx?.closed || d.order?.closed) throw new ArgError("This position was closed on OKX: it is a record now and can't be changed");
  const onOkx = !!d.okx || app.sync.isLive(instId, d) || (!!d.order && !["canceled", "mmp_canceled", "missing"].includes(d.order.state));
  const wantsPrices = a.entry != null || a.stop_loss != null || a.take_profit != null || a.time != null;
  if (onOkx && wantsPrices) throw new ArgError("This position has an order on OKX: its entry can't change here, and move_stops moves its stop-loss and take-profit on OKX");
  const next: PositionDrawing = JSON.parse(JSON.stringify(d));
  const entry = num(a, "entry", { optional: true, min: 0 }) ?? d.a.p;
  const stop = num(a, "stop_loss", { optional: true, min: 0 }) ?? d.b.p;
  const target = num(a, "take_profit", { optional: true, min: 0 }) ?? d.target;
  const bad = checkPrices({ entry, stop, target }, d.dir);
  if (bad) throw new ArgError(bad);
  const t = num(a, "time", { optional: true, min: 0 });
  const end = num(a, "end_time", { optional: true, min: 0 });
  next.a = { t: t == null ? d.a.t : t > 1e11 ? Math.floor(t / 1000) : t, p: entry };
  next.b = { t: end == null ? d.b.t : end > 1e11 ? Math.floor(end / 1000) : end, p: stop };
  next.target = target;
  if (next.b.t <= next.a.t) throw new ArgError("end_time must be after the entry time");
  const s = sizingArgs(a, d);
  if (s.riskMode) next.riskMode = s.riskMode;
  if (s.risk != null) next.risk = s.risk;
  else if (s.riskMode && s.riskMode !== d.riskMode) throw new ArgError("Give risk with the new risk_mode");
  if (s.leverage != null) next.leverage = s.leverage;
  if (a.capital === null) next.capital = null;
  else if (s.capital != null) next.capital = s.capital;
  return checked(next as unknown as Record<string, unknown>, "position") as PositionDrawing;
}

// ----------------------------------------------------------------------------- alerts
function saveAlert(app: McpApp, a: Args, c: CallCtx): ToolResult {
  const id = str(a, "id", { optional: true, max: 80 });
  const cond = a.condition == null ? undefined : oneOf(a, "condition", ["touch", "up", "down", "enter", "exit", "time", "trade"] as const);
  const repeat = a.repeat == null ? undefined : oneOf(a, "repeat", ["once", "every"] as const);
  const note = str(a, "note", { optional: true, max: 120 });
  const on = bool(a, "on");
  if (id) {
    const al = app.alerts.all().find((x) => x.id === id);
    if (!al) throw new ArgError(`No alert ${id}`);
    const price = num(a, "price", { optional: true, min: 0 });
    if (price != null && al.target.kind !== "price") throw new ArgError("That alert is on a drawing: move the drawing instead");
    const kind = al.target.kind === "price" ? "price" : app.alerts.drawingOf(al)?.kind;
    if (cond && kind && !condsFor(kind).includes(cond)) throw new ArgError(`That alert can use: ${condsFor(kind).join(", ")}`);
    app.alerts.update(id, {
      ...(cond ? { cond } : {}),
      ...(repeat ? { repeat } : {}),
      ...(note != null ? { note } : {}),
      ...(on != null ? { on } : {}),
      ...(price != null ? { target: { kind: "price" as const, price } } : {}),
    });
    app.note(`${who(c)} 改了 ${shortName(al.instId)} 的提醒`);
    return data({ alert: app.alerts.all().find((x) => x.id === id) });
  }
  const instId = symbolArg(app, a);
  const price = num(a, "price", { optional: true, min: 0 });
  const drawingId = str(a, "drawing_id", { optional: true, max: 80 });
  if ((price == null) === (drawingId == null)) throw new ArgError("Give price, or drawing_id");
  let kind: "price" | DrawKind = "price";
  if (drawingId) kind = findDrawing(loadDrawings(instId), drawingId, instId).kind;
  if (price != null && !(price > 0)) throw new ArgError("price must be above 0");
  const conds = condsFor(kind);
  const chosen: AlertCond = cond ?? conds[0];
  if (!conds.includes(chosen)) throw new ArgError(`A ${kind === "price" ? "price" : kind} alert can use: ${conds.join(", ")}`);
  const tf = tfArg(a) ?? chartsOf(app, instId)[0]?.feed.bar ?? app.workspace.inUse().feed.bar;
  const r = app.alerts.add({
    instId,
    target: price != null ? { kind: "price", price } : { kind: "drawing", id: drawingId! },
    cond: chosen,
    repeat: (repeat ?? "once") as Repeat,
    tf,
    note: note ?? "",
  });
  if (typeof r === "string") throw new ArgError(r);
  if (on === false) app.alerts.update(r.id, { on: false });
  app.note(`${who(c)} 在 ${shortName(instId)} 設了提醒`);
  return data({ alert: r });
}

// ----------------------------------------------------------------------------- Pine
function savePine(app: McpApp, a: Args, c: CallCtx): ToolResult {
  const id = str(a, "id", { optional: true, max: 80 });
  const list = app.settings.pine.get();
  const old = id ? list.find((x) => x.id === id) : undefined;
  if (id && !old) throw new ArgError(`No Pine script ${id}`);
  if (!old && list.length >= MAX_PINE_SCRIPTS) throw new ArgError(`There are already ${MAX_PINE_SCRIPTS} Pine scripts: delete one first`);
  const source = old ? (str(a, "source", { optional: true, max: MAX_PINE_SOURCE }) ?? old.source) : str(a, "source", { max: MAX_PINE_SOURCE });
  const loaded = load(source);
  if (!loaded.ok) return { content: [{ type: "text", text: `The script doesn't compile, line ${loaded.error.line}: ${loaded.error.message}. Nothing was saved.` }], isError: true };
  const name = (str(a, "name", { optional: true, max: 120 }) ?? old?.name ?? "").trim() || loaded.info.title || "Pine";
  const on = bool(a, "on") ?? old?.on ?? true;
  const inputs: PineScript["inputs"] = { ...(old?.inputs ?? {}) };
  const given = obj(a, "inputs");
  if (given)
    for (const [k, v] of Object.entries(given)) {
      if (v === null) delete inputs[k];
      else if (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 1000)) inputs[k] = v;
      else throw new ArgError(`inputs.${k} must be a number, true / false or text`);
    }
  const script: PineScript = { id: old?.id ?? newId("pine"), name, source, on, inputs };
  app.settings.pine.set(old ? list.map((x) => (x.id === old.id ? script : x)) : [...list, script]);
  app.note(`${who(c)} ${old ? "改了" : "新增"} Pine 腳本 ${name}`);
  return data({ id: script.id, name, on, kind: loaded.info.kind, title: loaded.info.title, results: "get_indicators shows its output once the charts have run it (about a second)" });
}

// ----------------------------------------------------------------------------- settings
/** `list`: the section is a list (sent whole). */
type Section = { about: string; list?: true; apply(app: McpApp, v: unknown): unknown };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const merged = (cur: object, v: unknown, name: string): Record<string, unknown> => {
  if (!isObj(v)) throw new ArgError(`${name} must be an object`);
  return { ...cur, ...v };
};
const list = (v: unknown, name: string): unknown[] => {
  if (!Array.isArray(v)) throw new ArgError(`${name} must be a list`);
  return v;
};
/** Timeframes as AI apps write them ("1D", "4h") in the app's own names ("" stays: the chart's timeframe). */
function tfName(v: unknown, where: string): string {
  if (v === "") return "";
  const tf = typeof v === "string" ? normalizeTf(v) : null;
  if (!tf) throw new ArgError(`${where}: unknown timeframe ${String(v)} (use 1m, 15m, 1H, 4H, 1D, 1W and the like)`);
  return tf;
}
/** A list of indicator sets with their `tf` in the app's names. */
function withTf(v: unknown[], name: string): unknown[] {
  return v.map((x, i) => (isObj(x) && x.tf != null ? { ...x, tf: tfName(x.tf, `${name}[${i}].tf`) } : x));
}

/** Moving averages without a color get the next one free. */
function colored(v: unknown[]): unknown[] {
  const used = v.flatMap((m) => (isObj(m) && typeof m.color === "string" ? [m.color] : []));
  return v.map((m) => {
    if (!isObj(m) || typeof m.color === "string") return m;
    const color = nextColor(MA_COLORS, used);
    used.push(color);
    return { tf: "", on: true, ...m, color };
  });
}
const SIZING_KEYS = ["capital", "risk", "riskMode", "leverage", "chain", "capitalFromApi"];

const SECTIONS: Record<string, Section> = {
  appearance: { about: "{bg, grid, text, up, down: #rrggbb; labelSize 9-18; axisSize 10-16; imageTransparency 0-100; imageFit cover|contain|stretch}", apply: (app, v) => app.settings.appearance.set(cleanAppearance(merged(app.settings.appearance.get(), v, "appearance"))) },
  labels: { about: "Price-scale labels on or off: {last, countdown, maValues, maNames, highLow, crosshair, volume}", apply: (app, v) => app.settings.labels.set(cleanLabels(merged(app.settings.labels.get(), v, "labels"))) },
  timeframes: {
    about: "{bar: timeframes on the toolbar, custom: timeframes added by the user}",
    apply: (app, v) => {
      const m = merged(app.settings.timeframes.get(), v, "timeframes");
      for (const k of ["bar", "custom"]) if (Array.isArray(m[k])) m[k] = (m[k] as unknown[]).map((x, i) => tfName(x, `timeframes.${k}[${i}]`));
      app.settings.timeframes.set(cleanTimeframes(m));
    },
  },
  bars: { about: "{unlimited: keep loading older bars without a cap}", apply: (app, v) => app.settings.bars.set(cleanBars(merged(app.settings.bars.get(), v, "bars"))) },
  fib: { about: "{levels: [{value, color, on}], extend, fill, showPrice, reverse}", apply: (app, v) => app.settings.fib.set(cleanFib(merged(app.settings.fib.get(), v, "fib")) ?? app.settings.fib.get()) },
  magnet: { about: "{on: always snap to open/high/low/close, holdKey: Control|Alt}", apply: (app, v) => app.settings.magnet.set(cleanMagnet(merged(app.settings.magnet.get(), v, "magnet")) ?? app.settings.magnet.get()) },
  position: {
    about: "The look of positions: {levels: [{value, on}] (R lines), profit, loss (#rrggbb), transparency 0-100, showPrices, infoHover}",
    apply: (app, v) => {
      if (isObj(v)) {
        const bad = SIZING_KEYS.filter((k) => k in v);
        if (bad.length) throw new ArgError(`position.${bad.join(", position.")}: the sizing defaults only change in QT Chart (they decide which orders need the user's confirmation)`);
      }
      app.settings.position.set(cleanPosition(merged(app.settings.position.get(), v, "position")));
    },
  },
  indicatorSwitches: { about: "{ma, fvg, ob, sr}: the toolbar switches", apply: (app, v) => app.settings.groups.set(cleanGroups(merged(app.settings.groups.get(), v, "indicatorSwitches"))) },
  movingAverages: { list: true, about: "The whole list, up to 10: [{id (keep it to change one), kind SMA|EMA|WMA, length 1-1000, color, on, tf ('' = the chart's timeframe)}]", apply: (app, v) => app.settings.mas.set(cleanMas(colored(withTf(list(v, "movingAverages"), "movingAverages"))) ?? []) },
  maOptions: { about: "{waitClose: higher-timeframe averages move only when their bar closes}", apply: (app, v) => app.settings.maOptions.set(cleanMaOptions(merged(app.settings.maOptions.get(), v, "maOptions"))) },
  fvg: { list: true, about: "Fair value gap sets, the whole list, up to 4: [{id, on, tf, body, minPct 0-10, maxCount 1-50, showEnded, up, down}]", apply: (app, v) => app.settings.fvgs.set(cleanFvgs(withTf(list(v, "fvg"), "fvg")) ?? []) },
  orderBlocks: { list: true, about: "Order block sets, the whole list, up to 4: [{id, on, tf, swing 1-20, lookback 1-50, maxCount 1-50, showEnded, up, down}]", apply: (app, v) => app.settings.obs.set(cleanObs(withTf(list(v, "orderBlocks"), "orderBlocks")) ?? []) },
  supportResistance: { list: true, about: "Support / resistance sets, the whole list, up to 4: [{id, on, tf, swing 1-50, maxCount 1-50, showEnded, up (support color), down (resistance color)}]", apply: (app, v) => app.settings.srs.set(cleanSrs(withTf(list(v, "supportResistance"), "supportResistance")) ?? []) },
  alertOptions: { about: "{sound, system (Windows notification), popup (message in the window)}", apply: (app, v) => app.alerts.setOptions(cleanOptions(merged(app.alerts.options(), v, "alertOptions"))) },
  okxSync: { about: "{on: follow the OKX account's positions and stops on the charts}", apply: (app, v) => app.settings.okxSync.set(cleanSync(merged(app.settings.okxSync.get(), v, "okxSync"))) },
};

/** What get_settings shows of a section now (to tell what wasn't taken). */
function current(app: McpApp, key: string): unknown {
  const s = app.settings;
  const map: Record<string, () => unknown> = {
    appearance: () => s.appearance.get(), labels: () => s.labels.get(), timeframes: () => s.timeframes.get(), bars: () => s.bars.get(), fib: () => s.fib.get(),
    magnet: () => s.magnet.get(), position: () => s.position.get(), indicatorSwitches: () => s.groups.get(), movingAverages: () => s.mas.get(),
    maOptions: () => s.maOptions.get(), fvg: () => s.fvgs.get(), orderBlocks: () => s.obs.get(), supportResistance: () => s.srs.get(),
    alertOptions: () => app.alerts.options(), okxSync: () => s.okxSync.get(),
  };
  return map[key]();
}

function updateSettings(app: McpApp, a: Args, c: CallCtx): ToolResult {
  const keys = Object.keys(a).filter((k) => a[k] !== undefined);
  const unknown = keys.filter((k) => !SECTIONS[k]);
  if (unknown.length) throw new ArgError(`Unknown settings: ${unknown.join(", ")}. Sections: ${Object.keys(SECTIONS).join(", ")}`);
  if (!keys.length) throw new ArgError("Nothing to change");
  for (const k of keys) SECTIONS[k].apply(app, a[k]); // all checked as they go; a section that throws changes nothing of its own
  const notTaken: string[] = [];
  for (const k of keys) {
    const want = a[k];
    const now = current(app, k) as Record<string, unknown> | unknown[];
    if (isObj(want) && isObj(now)) {
      for (const f of Object.keys(want)) if (JSON.stringify(want[f]) !== JSON.stringify(now[f]) && !Array.isArray(want[f])) notTaken.push(`${k}.${f}`);
    } else if (Array.isArray(want) && Array.isArray(now) && want.length !== now.length) notTaken.push(`${k}: ${want.length - now.length} entries were not valid`);
  }
  app.note(`${who(c)} 改了設定：${keys.join("、")}`);
  return data({ changed: keys, ...(notTaken.length ? { notTaken, note: "These values were out of range or not valid and were put back; get_settings shows what is set." } : {}), now: Object.fromEntries(keys.map((k) => [k, current(app, k)])) });
}
