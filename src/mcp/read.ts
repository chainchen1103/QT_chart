// Tools that only read: the app's state, symbols, candles, a chart's picture, drawings, indicators and Pine
// scripts' results, alerts, the OKX account, Pine scripts and the settings.

import { getCandles } from "../core/api.ts";
import { keysWith } from "../core/storage.ts";
import { fibPrice, posDir } from "../drawings/geometry.ts";
import { activeCell, LAYOUTS } from "../layout/model.ts";
import { loadCached } from "../indicators/pine/host.ts";
import type { ChartPane } from "../chart/pane.ts";
import { COND_TEXT } from "../alerts/model.ts";
import { loadDrawings } from "../settings/store.ts";
import { TOOL_INFO, type Drawing, type PositionDrawing, type PositionOrder } from "../settings/model.ts";
import { bool, data, iso, num, str, text } from "./model.ts";
import { CHART, chartArg, chartsOf, orderRequests, S, SYMBOL, symbolArg, tfArg, TIMEFRAME, type McpApp, type Tool } from "./tools.ts";
import guide from "../../docs/AGENT_GUIDE.md?raw";

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

export function readTools(app: McpApp): Tool[] {
  return [
    {
      name: "get_guide",
      title: "Guide for agents",
      description:
        "The guide to working QT Chart with these tools, in Traditional Chinese: conventions (symbols, timeframes, times, chart numbers), drawings and Fib, positions, the rules for orders and what their answers mean, indicators, Pine, bar replay, alerts, settings and suggested workflows. Read it once before using the other tools.",
      level: "read",
      input: { type: "object", properties: {} },
      annotations: READ,
      run: () => text(guide),
    },
    {
      name: "get_app_state",
      title: "QT Chart state",
      description:
        "Start here. The tabs and the charts on the shown tab (index, symbol, timeframe, which one is in use, bar replay), the OKX account (API key: none, demo or real money; locked; equity), the position-sizing defaults, and what this connection may do: read, change charts, place orders, and whether orders wait for the user's confirmation.",
      level: "read",
      input: { type: "object", properties: {} },
      annotations: READ,
      run: () => data(appState(app)),
    },
    {
      name: "list_symbols",
      title: "List symbols",
      description:
        "OKX USDT perpetual swaps the app can chart, most traded first: last price, 24h change and volume, price step, contract size (coins per contract), size step, minimum size and maximum leverage.",
      level: "read",
      input: {
        type: "object",
        properties: {
          query: S.str("Part of the symbol or coin, e.g. ETH."),
          limit: S.int("How many (1 to 500, default 30).", { minimum: 1, maximum: 500 }),
        },
      },
      annotations: READ,
      run: (a) => {
        if (!app.catalog.list.length) return text("The symbol list is still loading: try again in a few seconds.");
        const q = (str(a, "query", { optional: true, max: 40 }) ?? "").trim().toUpperCase().replace(/[\s/_-]+/g, "");
        const limit = num(a, "limit", { optional: true, int: true, min: 1, max: 500 }) ?? 30;
        const list = app.catalog.list
          .filter((i) => !q || i.instId.replace(/-/g, "").includes(q))
          .sort((x, y) => y.volUsdt24h - x.volUsdt24h)
          .slice(0, limit)
          .map((i) => ({
            symbol: i.instId, coin: i.base, last: i.last, change24hPct: round(i.change24h * 100, 2), volume24hUsdt: Math.round(i.volUsdt24h),
            priceStep: i.tickSz, contractCoins: i.ctVal, sizeStep: i.lotSz, minSize: i.minSz, maxLeverage: i.maxLever,
          }));
        return data({ count: list.length, symbols: list });
      },
    },
    {
      name: "get_candles",
      title: "Get candles",
      description:
        "OHLCV bars, oldest first, as rows [time (UTC seconds, bar start), open, high, low, close, volume (coins), closed]. From OKX for any symbol and timeframe, or with `chart` the bars that chart has loaded (during a bar replay only the bars shown so far).",
      level: "read",
      input: {
        type: "object",
        properties: {
          symbol: SYMBOL,
          timeframe: { ...TIMEFRAME, description: `${TIMEFRAME.description} Default: the chart in use's.` },
          count: S.int("How many bars, newest last (1 to 1000, default 200).", { minimum: 1, maximum: 1000 }),
          before: S.num("Only bars that start before this time (UTC seconds): for older history."),
          chart: { ...CHART, description: "Read the bars a chart on screen has (its symbol and timeframe) instead of asking OKX." },
        },
      },
      annotations: { ...READ, idempotentHint: false, openWorldHint: true },
      run: async (a) => {
        const count = num(a, "count", { optional: true, int: true, min: 1, max: 1000 }) ?? 200;
        const cols = ["time", "open", "high", "low", "close", "volume", "closed"];
        if (a.chart != null) {
          const p = chartArg(app, a);
          const bars = p.feed.bars.slice(-count);
          return data({
            symbol: p.feed.instId, timeframe: p.feed.bar, replay: p.feed.replaying, columns: cols,
            rows: bars.map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume, c.confirmed]),
          });
        }
        const instId = symbolArg(app, a);
        const bar = tfArg(a) ?? app.workspace.inUse().feed.bar;
        const before = num(a, "before", { optional: true, min: 0 });
        const ms = before == null ? null : before > 1e11 ? before : before * 1000;
        const bars = await getCandles(instId, bar, ms, count);
        return data({ symbol: instId, timeframe: bar, columns: cols, rows: bars.slice(-count).map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume, c.confirmed]) });
      },
    },
    {
      name: "get_chart_image",
      title: "Chart picture",
      description: "A PNG of a chart as it is on screen: candles, volume, indicators, Pine scripts, drawings and both axes.",
      level: "read",
      input: { type: "object", properties: { chart: CHART } },
      annotations: { ...READ, idempotentHint: false },
      run: (a) => {
        const p = chartArg(app, a);
        const png = p.screenshot();
        const i = app.workspace.charts().indexOf(p);
        return { content: [{ type: "text", text: `Chart ${i}: ${p.feed.instId} ${p.feed.bar}${p.feed.replaying ? " (bar replay)" : ""}` }, { type: "image", data: png, mimeType: "image/png" }] };
      },
    },
    {
      name: "list_drawings",
      title: "List drawings",
      description:
        "A symbol's drawings (they show on every chart of it): id, kind, points as {time, price}, style; Fib level prices; for positions the entry, stop-loss, take-profit, sizing, how it played out on the bars, the order placed from it and the OKX position it is tied to.",
      level: "read",
      input: { type: "object", properties: { symbol: SYMBOL, kind: S.str("Only this kind, e.g. position, trend, hline, fib, rect, channel.") } },
      annotations: READ,
      run: (a) => {
        const instId = symbolArg(app, a);
        const kind = str(a, "kind", { optional: true, max: 20 });
        const pane = chartsOf(app, instId).find((p) => p.feed.current);
        const list = loadDrawings(instId).filter((d) => !kind || d.kind === kind);
        return data({ symbol: instId, count: list.length, drawings: list.map((d) => drawingOut(app, instId, d, pane)) });
      },
    },
    {
      name: "get_indicators",
      title: "Indicator values",
      description:
        "What a chart's indicators show now: moving averages' latest values, FVG / order block / support-resistance zones (bars and prices), and each Pine script's output on that chart (latest plot values, horizontal lines, tables, recent labels, errors) with a strategy's backtest summary and recent trades.",
      level: "read",
      input: {
        type: "object",
        properties: { chart: CHART, trades: S.int("Strategy trades to list per script, newest last (0 to 200, default 10).", { minimum: 0, maximum: 200 }) },
      },
      annotations: READ,
      run: (a) => {
        const p = chartArg(app, a);
        const trades = num(a, "trades", { optional: true, int: true, min: 0, max: 200 }) ?? 10;
        const ind = p.indicators();
        const groups = app.settings.groups.get();
        return data({
          chart: app.workspace.charts().indexOf(p),
          symbol: p.feed.instId,
          timeframe: p.feed.bar,
          replay: p.feed.replaying,
          switches: { movingAverages: groups.ma, fvg: groups.fvg, orderBlocks: groups.ob, supportResistance: groups.sr },
          movingAverages: ind.mas.map((m) => ({ name: m.name, value: m.value, state: m.state })),
          zones: ind.zones.map((z) => ({
            kind: z.kind === "fvg" ? "fvg" : z.kind === "ob" ? "order_block" : "support_resistance",
            side: z.kind === "sr" ? (z.dir === 1 ? "support" : "resistance") : z.dir === 1 ? "bullish" : "bearish",
            timeframe: z.tf || p.feed.bar,
            from: z.from,
            endedAt: z.to,
            top: z.top,
            bottom: z.bottom,
          })),
          pine: pineOut(app, p, trades),
        });
      },
    },
    {
      name: "list_alerts",
      title: "List alerts",
      description: "Price and drawing alerts (all symbols, or one): id, what they watch, condition, repeat, on or off, note, when they last went off; with `log` the recent alerts that went off.",
      level: "read",
      input: { type: "object", properties: { symbol: { ...SYMBOL, description: "Only this symbol's (default: all symbols)." }, log: S.bool("Add the recent alerts that went off.") } },
      annotations: READ,
      run: (a) => {
        const only = a.symbol != null ? symbolArg(app, a) : null;
        const list = app.alerts.all().filter((x) => !only || x.instId === only);
        const out: Record<string, unknown> = {
          alerts: list.map((x) => {
            const d = app.alerts.drawingOf(x);
            return {
              id: x.id,
              symbol: x.instId,
              target: x.target.kind === "price" ? { price: x.target.price } : { drawingId: x.target.id, drawingKind: d?.kind ?? null },
              condition: x.cond,
              conditionText: COND_TEXT[x.cond],
              repeat: x.repeat,
              on: x.on,
              note: x.note,
              timeframe: x.tf,
              created: x.created,
              lastFired: x.fired,
              timesFired: x.count,
              ...(x.stage ? { stage: x.stage } : {}),
            };
          }),
        };
        if (bool(a, "log")) out.log = app.alerts.log().filter((e) => !only || e.instId === only).slice(0, 30).map((e) => ({ time: e.t, symbol: e.instId, text: e.text, note: e.note, alertId: e.alertId }));
        return data(out);
      },
    },
    {
      name: "get_account",
      title: "OKX account",
      description:
        "The OKX account through the user's API key: whether a key is set (demo or real money) and unlocked, equity and free margin, open positions and their stop-loss / take-profit orders (needs 與 OKX 同步, the sync setting), orders placed from positions on the charts, and the orders AI apps asked for with how they ended.",
      level: "read",
      input: { type: "object", properties: {} },
      annotations: { ...READ, idempotentHint: false, openWorldHint: true },
      run: () => data(accountOut(app)),
    },
    {
      name: "list_pine_scripts",
      title: "List Pine scripts",
      description: "The user's Pine scripts (every chart runs the ones switched on): id, name, on, title and kind from the script, compile error, changed inputs; with `source` their code.",
      level: "read",
      input: { type: "object", properties: { source: S.bool("Add each script's source code."), id: S.str("Only this script.") } },
      annotations: READ,
      run: (a) => {
        const withSource = bool(a, "source") ?? false;
        const id = str(a, "id", { optional: true, max: 80 });
        const list = app.settings.pine.get().filter((s) => !id || s.id === id);
        return data({
          scripts: list.map((s) => {
            const l = loadCached(s.source);
            return {
              id: s.id, name: s.name, on: s.on, title: l.info?.title ?? "", kind: l.info?.kind ?? null, overlay: l.info?.overlay ?? null,
              error: l.ok ? null : `line ${l.error.line}: ${l.error.message}`, inputs: s.inputs, ...(withSource ? { source: s.source } : {}),
            };
          }),
        });
      },
    },
    {
      name: "get_settings",
      title: "Settings",
      description:
        "Every setting: appearance (colors, text sizes), price-scale labels, toolbar timeframes, bar limit, Fib levels, magnet, position defaults (R lines, colors, capital, risk, leverage), moving averages, FVG / order block / support-resistance sets, indicator switches, alert options and OKX sync.",
      level: "read",
      input: { type: "object", properties: {} },
      annotations: READ,
      run: () => {
        const s = app.settings;
        return data({
          appearance: s.appearance.get(),
          labels: s.labels.get(),
          timeframes: s.timeframes.get(),
          bars: s.bars.get(),
          fib: s.fib.get(),
          magnet: s.magnet.get(),
          position: s.position.get(),
          indicatorSwitches: s.groups.get(),
          movingAverages: s.mas.get(),
          maOptions: s.maOptions.get(),
          fvg: s.fvgs.get(),
          orderBlocks: s.obs.get(),
          supportResistance: s.srs.get(),
          alertOptions: app.alerts.options(),
          okxSync: s.okxSync.get(),
          orderWindow: s.orderPrefs.get(),
        });
      },
    },
  ];
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

// ----------------------------------------------------------------------------- the app
export function appState(app: McpApp) {
  const ws = app.workspace;
  const inUse = ws.inUse();
  const keys = app.account.keys;
  const m = app.mcp();
  const pos = app.settings.position.get();
  const cap = app.trading.capital();
  return {
    time: Math.floor(Date.now() / 1000),
    shownTab: ws.shownIndex(),
    tabs: ws.tabs().map((t, i) => ({ tab: i, layout: t.layout, layoutName: LAYOUTS[t.layout].name, charts: t.cells.length, symbol: activeCell(t).instId })),
    layout: ws.layout(),
    charts: ws.charts().map((p, i) => ({
      chart: i,
      symbol: p.feed.instId,
      timeframe: p.feed.bar,
      inUse: p === inUse,
      loaded: p.feed.current,
      bars: p.feed.bars.length,
      lastPrice: p.feed.bars[p.feed.bars.length - 1]?.close ?? null,
      replay: p.feed.replaying ? { barsAhead: p.feed.ahead, at: p.feed.times[p.feed.times.length - 1] ?? null, playing: p.replay.playing } : null,
    })),
    account: {
      apiKey: keys.set ? (keys.demo ? "demo" : "real") : "none",
      locked: keys.locked,
      equity: app.account.equity(),
      available: app.account.usable() ? app.account.account?.avail ?? null : null,
      okxSync: app.settings.okxSync.get().on,
    },
    positionDefaults: { capital: cap.amount, capitalFromAccount: cap.live, risk: pos.risk, riskMode: pos.riskMode, leverage: pos.leverage, chainPositions: pos.chain },
    connection: {
      read: true,
      changeCharts: m.write,
      placeOrders: m.trade,
      orderConfirmation: m.confirm === "always" ? "every order" : m.confirm === "real" ? "real-money orders only (demo orders go straight to OKX)" : "none: orders go straight to OKX",
      note: "Orders whose risk or leverage is above the position defaults always wait for the user's confirmation.",
    },
    alertsOn: app.alerts.all().filter((x) => x.on).length,
    pineScripts: app.settings.pine.get().map((s) => ({ id: s.id, name: s.name, on: s.on })),
  };
}

// ----------------------------------------------------------------------------- drawings
export function drawingOut(app: McpApp, instId: string, d: Drawing, pane?: ChartPane) {
  const base = { id: d.id, kind: d.kind, name: TOOL_INFO[d.kind].name };
  const pt = (x: { t: number; p: number }) => ({ time: x.t, price: x.p });
  const alert = app.alerts.forDrawing(instId, d.id);
  const withAlert = alert ? { alert: { id: alert.id, condition: alert.cond, on: alert.on } } : {};
  switch (d.kind) {
    case "fib": {
      const f = app.settings.fib.get();
      return { ...base, points: [pt(d.a), pt(d.b)], levels: f.levels.filter((l) => l.on).map((l) => ({ level: l.value, price: fibPrice(d.a, d.b, l.value, f.reverse) })), ...withAlert };
    }
    case "rect":
      return { ...base, points: [pt(d.a), pt(d.b)], top: Math.max(d.a.p, d.b.p), bottom: Math.min(d.a.p, d.b.p), style: d.style, ...withAlert };
    case "position":
      return { ...base, ...positionOut(app, instId, d, pane), ...withAlert };
    case "channel":
    case "regression":
    case "flat":
    case "disjoint":
      return { ...base, points: [pt(d.a), pt(d.b)], secondLinePrice: d.c.p, style: d.style, ...(d.fit ? { fit: { stdDev: d.fit.sd, pearsonR: d.fit.r } } : {}), ...withAlert };
    default:
      return { ...base, points: TOOL_INFO[d.kind].points === 1 ? [pt(d.a)] : [pt(d.a), pt(d.b)], style: d.style, ...withAlert };
  }
}

export function orderOut(o: PositionOrder) {
  return {
    orderId: o.ordId, state: o.state, demo: o.demo, side: o.side, type: o.ordType, price: o.px, contracts: o.sz, filled: o.fillSz, avgPrice: o.avgPx,
    placed: Math.floor(o.at), stopLoss: o.sl ?? null, takeProfit: o.tp ?? null, ...(o.closed ? { closed: { time: o.closed.t, price: o.closed.px || null, pnl: o.closed.pnl } } : {}),
  };
}

function positionOut(app: McpApp, instId: string, d: PositionDrawing, pane?: ChartPane) {
  const t = pane?.drawings.find(d.id) ? pane.drawings.tradeNow(d.id) : undefined;
  const live = app.sync.liveInfo(instId, d);
  return {
    direction: posDir(d) === 1 ? "long" : "short",
    entry: d.a.p,
    stopLoss: d.b.p,
    takeProfit: d.target,
    entryTime: d.a.t,
    endTime: d.b.t,
    capital: d.capital,
    risk: d.risk,
    riskMode: d.riskMode,
    leverage: d.leverage,
    ...(t
      ? {
          sizing: { capital: round(t.capital, 2), coins: Number(t.plan.qty.toFixed(8)), riskAmount: round(t.plan.riskAmount, 2), notional: round(t.plan.notional, 2), margin: round(t.plan.margin, 2), rewardRisk: round(t.plan.rr, 2), capped: t.plan.capped },
          outcome: { status: t.outcome.status, exitPrice: t.outcome.exit, exitTime: t.outcome.exitT, pnl: round(t.pnl, 2) },
        }
      : {}),
    ...(d.order ? { order: orderOut(d.order) } : {}),
    ...(d.okx ? { okxPosition: { posId: d.okx.posId, side: d.okx.side, demo: d.okx.demo, opened: Math.floor(d.okx.cTime / 1000), ...(d.okx.closed ? { closed: { time: d.okx.closed.t, price: d.okx.closed.px || null, pnl: d.okx.closed.pnl } } : {}) } } : {}),
    ...(live && !live.closed ? { onOkx: { coins: live.coins, avgPrice: live.avg, leverage: live.lever, unrealizedPnl: live.upl, demo: live.demo } } : {}),
  };
}

// ----------------------------------------------------------------------------- Pine on a chart
function pineOut(app: McpApp, p: ChartPane, trades: number) {
  const bars = p.feed.bars;
  const last = bars.length - 1;
  const out = [];
  for (const s of app.settings.pine.get()) {
    if (!s.on) continue;
    const v = p.pine.view(s.id);
    const r = v?.result;
    const o = r?.ok ? r.out : null;
    const timeOf = (x: number, xloc: string) => (xloc === "bar_time" ? Math.floor(x / 1000) : bars[x]?.time ?? null);
    const st = r?.ok ? r.strategy : null;
    const closed = st?.trades ?? [];
    const wins = closed.filter((t) => t.profit > 0).length;
    out.push({
      id: s.id,
      name: v?.name || s.name,
      kind: v?.info?.kind ?? null,
      error: v?.error ?? (v ? null : "not run on this chart yet"),
      loading: v?.loading ?? false,
      plots: o ? o.plots.map((pl) => ({ title: pl.title, value: finite(pl.values[last]), previous: finite(pl.values[last - 1]) })) : [],
      horizontalLines: o ? o.hlines.map((h) => ({ title: h.title, price: h.price })) : [],
      tables: o ? o.tables.filter((t) => !t.dead).map(tableText) : [],
      labels: o ? o.labels.filter((l) => !l.dead).slice(-10).map((l) => ({ time: timeOf(l.x, l.xloc), price: finite(l.y), text: l.text })) : [],
      ...(st
        ? {
            strategy: {
              netProfit: round(st.netProfit, 2), grossProfit: round(st.grossProfit, 2), grossLoss: round(st.grossLoss, 2), commission: round(st.commission, 2),
              openProfit: round(st.openProfit, 2), initialCapital: st.initialCapital, currency: st.currency, closedTrades: closed.length,
              winRatePct: closed.length ? round((wins / closed.length) * 100, 2) : null,
              profitFactor: st.grossLoss < 0 ? round(st.grossProfit / -st.grossLoss, 3) : null,
              maxDrawdown: round(st.maxDrawdown, 2), maxDrawdownPct: round(st.maxDrawdownPct, 2), buyAndHold: round(st.buyHold, 2),
              openTrades: st.open.map((t) => ({ id: t.entryId, direction: t.dir === 1 ? "long" : "short", qty: t.qty, price: t.price, time: Math.floor(t.time / 1000) })),
              recentTrades: trades
                ? closed.slice(-trades).map((t) => ({
                    direction: t.dir === 1 ? "long" : "short", qty: t.qty, entryTime: Math.floor(t.entryTime / 1000), entryPrice: t.entryPrice,
                    exitTime: Math.floor(t.exitTime / 1000), exitPrice: t.exitPrice, profit: round(t.profit, 2), entryId: t.entryId, exitId: t.exitId,
                  }))
                : [],
            },
          }
        : {}),
    });
  }
  return out;
}

const finite = (v: number | undefined) => (v != null && Number.isFinite(v) ? v : null);

function tableText(t: { columns: number; rows: number; cells: Map<string, { text: string }> }): string[][] {
  const rows: string[][] = [];
  for (let r = 0; r < t.rows; r++) {
    const row: string[] = [];
    for (let c = 0; c < t.columns; c++) row.push(t.cells.get(`${c},${r}`)?.text ?? "");
    if (row.some((x) => x)) rows.push(row);
  }
  return rows;
}

// ----------------------------------------------------------------------------- the account
function accountOut(app: McpApp) {
  const { keys, account, error } = app.account;
  const st = app.sync.state;
  const ct = (instId: string) => app.catalog.get(instId)?.ctVal ?? 0;
  const chartOrders = [];
  for (const instId of keysWith("drawings.").map((k) => k.slice("drawings.".length))) {
    for (const d of loadDrawings(instId)) if (d.kind === "position" && d.order) chartOrders.push({ symbol: instId, drawingId: d.id, ...orderOut(d.order) });
  }
  chartOrders.sort((x, y) => y.placed - x.placed);
  return {
    apiKey: keys.set ? (keys.demo ? "demo" : "real") : "none",
    locked: keys.locked,
    ...(keys.locked ? { note: "The API key is locked: the user has to unlock it in QT Chart (account button at the bottom right). Never ask for the password." } : {}),
    account: app.account.usable() && account ? { equity: account.equity, available: account.avail, positionMode: account.posMode, accountLevel: account.acctLv } : null,
    error,
    sync: { on: app.settings.okxSync.get().on, status: app.sync.status.state, detail: app.sync.status.detail },
    positions: st
      ? st.positions.map((p) => ({
          symbol: p.instId, posId: p.posId, side: p.posSide === "net" ? (p.pos > 0 ? "long" : "short") : p.posSide, contracts: Math.abs(p.pos),
          coins: Number((Math.abs(p.pos) * ct(p.instId)).toFixed(8)), avgPrice: p.avgPx, markPrice: p.markPx, unrealizedPnl: p.upl, liquidationPrice: p.liqPx,
          leverage: p.lever, marginMode: p.mgnMode, opened: Math.floor(p.cTime / 1000),
        }))
      : null,
    stopOrders: st ? st.algos.map((x) => ({ symbol: x.instId, algoId: x.algoId, closeSide: x.side, contracts: x.closeFraction ? "all" : x.sz, stopLoss: x.sl, takeProfit: x.tp })) : null,
    ...(st ? {} : { positionsNote: "Positions and stop orders show while 與 OKX 同步 (OKX sync) is on and the key is unlocked." }),
    chartOrders: chartOrders.slice(0, 50),
    aiOrderRequests: orderRequests(),
    time: iso(Date.now() / 1000),
  };
}
