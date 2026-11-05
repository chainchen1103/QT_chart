// Tools that trade on OKX: place an order from a position, cancel it, change it while it waits (price, stops,
// the size worked out again), move the stop-loss / take-profit on OKX.
// Depending on the AI connection's settings each waits for the user's OK in QT Chart (the same windows the
// user's own orders use), always so when it goes past the position defaults. A window waits up to five minutes;
// the app is answered within WAIT_MS (AI apps give up on a call after about a minute), with "still waiting" when
// the user hasn't decided yet: one window at a time, and the same order asked again waits for the same window.

import { shortName } from "../core/format.ts";
import { posDir } from "../drawings/geometry.ts";
import { checkPrices, fmtMoney } from "../drawings/trade.ts";
import { loadDrawings } from "../settings/store.ts";
import { MAX_DRAWINGS, type PositionDrawing } from "../settings/model.ts";
import { isOpenState, type OrderPrefs } from "../trade/model.ts";
import { amendPlanFor, isMissing, openAmendWindow, openOrderWindow, orderPlanFor, sendAmend, submitOrder, withInfo, type OrderDone } from "../trade/panel.ts";
import { closePopover } from "../ui/popover.ts";
import { ArgError, bool, data, fail, needsConfirm, num, oneOf, riskAllowed, str, widensStop, withinDefaults, type Args, type ToolResult } from "./model.ts";
import { chartFor, findDrawing, request, S, SYMBOL, symbolArg, who, type CallCtx, type McpApp, type Tool } from "./tools.ts";
import { positionFrom } from "./write.ts";

/** How long a call waits for the user's answer before saying it is still waiting. */
const WAIT_MS = 45_000;
/** How long a confirmation window stays open: then it closes (nothing is sent). */
const GIVE_UP_MS = 5 * 60_000;

const TRADE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

/** The confirmation window open now. */
let pending: { key: string; done: Promise<ToolResult> } | null = null;
/** Trade calls run one after another, so two can't both find no window open and each open one. */
let queue: Promise<unknown> = Promise.resolve();
function serial(run: () => Promise<ToolResult>): Promise<ToolResult> {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/** The user's answer when it comes within WAIT_MS, else "still waiting". */
async function answer(done: Promise<ToolResult>): Promise<ToolResult> {
  let timer = 0;
  const later = new Promise<ToolResult>((resolve) => {
    timer = window.setTimeout(
      () =>
        resolve({
          ...data({
            waiting: true,
            message:
              "QT Chart is showing this to the user, who hasn't answered yet. Don't send it again: call get_account later, its aiOrderRequests say how it ended. The window closes by itself after five minutes, sending nothing.",
          }),
          log: "等使用者確認",
        }),
      WAIT_MS,
    );
  });
  const r = await Promise.race([done, later]);
  clearTimeout(timer);
  return r;
}

/** Show a confirmation window (opened by `open`, which resolves with the outcome) and wait for it. */
function confirmWith(app: McpApp, key: string, open: (resolve: (r: ToolResult) => void) => void): Promise<ToolResult> {
  app.attention();
  const done = new Promise<ToolResult>((resolve) => open(resolve));
  const mine = { key, done };
  pending = mine;
  const giveUp = window.setTimeout(() => {
    if (pending === mine) closePopover(); // still open: closing it sends nothing
  }, GIVE_UP_MS);
  void done.finally(() => {
    clearTimeout(giveUp);
    if (pending === mine) pending = null;
  });
  return answer(done);
}

/** A window already open: the same request waits for it again; another can't open one now. */
function busy(key: string): Promise<ToolResult> | ToolResult | null {
  if (!pending) return null;
  if (pending.key === key) return answer(pending.done);
  return fail("Another request is waiting for the user's confirmation in QT Chart: wait for it first (get_account shows how it ended).");
}

// ----------------------------------------------------------------------------- the tools
export function tradeTools(app: McpApp): Tool[] {
  return [
    {
      name: "place_order",
      title: "Place an order on OKX",
      description:
        "Send an order to OKX from a position: an existing position drawing (drawing_id), or a new one drawn from entry, stop_loss and take_profit (entry may be left out for a market order). The size comes from the position's risk and capital (the account's equity by default), in whole contracts; the stop-loss always goes with the order, the take-profit too unless attach_take_profit is false. Depending on the user's settings QT Chart first shows the order and waits for the user's OK; orders with more risk or leverage than the position defaults always wait. The account may be real money (get_app_state). Place only orders the user asked for.",
      level: "trade",
      input: {
        type: "object",
        properties: {
          symbol: SYMBOL,
          drawing_id: S.str("The position to order from (list_drawings)."),
          entry: S.num("New position: entry price (the limit price). Market orders may leave it out."),
          stop_loss: S.num("New position: stop-loss price (below the entry for a long, above for a short)."),
          take_profit: S.num("New position: take-profit price."),
          order_type: S.oneOf(["limit", "post_only", "market"], "limit (default as the user last chose), post_only (maker only) or market."),
          margin_mode: S.oneOf(["isolated", "cross"], "Margin mode (default as the user last chose)."),
          attach_take_profit: S.bool("Send the take-profit with it (default as the user last chose)."),
          risk: S.num("New position: risk, % of capital or USDT (risk_mode). Default: the position defaults."),
          risk_mode: S.oneOf(["pct", "amount"], "New position: risk as a % of capital or a USDT amount."),
          leverage: S.int("New position: leverage, 1 to 125. Default: the position defaults.", { minimum: 1, maximum: 125 }),
          end_time: S.num("New position: where its box ends (UTC seconds). Default: 20 bars on."),
        },
      },
      annotations: TRADE,
      drawings: (a) => a.drawing_id == null, // a new position is drawn for it
      run: (a, c) => serial(() => placeOrder(app, a, c)),
    },
    {
      name: "cancel_order",
      title: "Cancel an order",
      description: "Cancel the order placed from a position (drawing_id) while it hasn't filled; a part already filled stays an open position. Doesn't ask the user: cancelling adds no risk.",
      level: "trade",
      input: { type: "object", properties: { symbol: SYMBOL, drawing_id: S.str("The position whose order to cancel.") }, required: ["drawing_id"] },
      annotations: TRADE,
      run: (a, c) => serial(() => cancelOrder(app, a, c)),
    },
    {
      name: "amend_order",
      title: "Change a waiting order",
      description:
        "Change an order still waiting on OKX with nothing filled (the order of a position: drawing_id): its price (entry), stop-loss and / or take-profit. The size is worked out again from the position's risk, as placing it would, and the position on the chart moves with it. Shown to the user for an OK as the settings say, always when the loss at the stop is past the position defaults. Side, order type and leverage can't change: cancel_order, then place_order again.",
      level: "trade",
      input: {
        type: "object",
        properties: {
          symbol: SYMBOL,
          drawing_id: S.str("The position whose order to change (list_drawings)."),
          entry: S.num("New limit price."),
          stop_loss: S.num("New stop-loss price."),
          take_profit: S.num("New take-profit price (only when the order has one)."),
        },
        required: ["drawing_id"],
      },
      annotations: TRADE,
      drawings: true,
      run: (a, c) => serial(() => amendOrder(app, a, c)),
    },
    {
      name: "move_stops",
      title: "Move stop-loss / take-profit",
      description:
        "Move the stop-loss and / or take-profit of a position on OKX (an open position needs 與 OKX 同步, okxSync, on). For an order still waiting with nothing filled this is amend_order: the size is worked out again. Shown to the user for an OK as the settings say, and for an open position always when the stop moves away from the entry. A position not on OKX just gets the new prices on the chart.",
      level: "trade",
      input: {
        type: "object",
        properties: { symbol: SYMBOL, drawing_id: S.str("The position (list_drawings)."), stop_loss: S.num("New stop-loss price."), take_profit: S.num("New take-profit price.") },
        required: ["drawing_id"],
      },
      annotations: TRADE,
      drawings: true,
      run: (a, c) => serial(() => moveStops(app, a, c)),
    },
  ];
}

function usableAccount(app: McpApp): ToolResult | null {
  const k = app.account.keys;
  if (!k.set) return fail("No OKX API key is set in QT Chart: the user adds one in 設定 → 交易帳戶.");
  if (k.locked) return fail("The OKX API key is locked: the user unlocks it in QT Chart with the account button at the bottom right. Never ask the user for that password.");
  return null;
}

async function placeOrder(app: McpApp, a: Args, c: CallCtx): Promise<ToolResult> {
  const blocked = usableAccount(app);
  if (blocked) return blocked;
  const instId = symbolArg(app, a);
  const inst = app.catalog.get(instId);
  if (!inst || !(inst.ctVal > 0)) return fail(`${instId} has no contract data yet: try again in a few seconds.`);
  const saved = app.settings.orderPrefs.get();
  const prefs: OrderPrefs = {
    ordType: a.order_type == null ? saved.ordType : oneOf(a, "order_type", ["limit", "post_only", "market"] as const),
    tdMode: a.margin_mode == null ? saved.tdMode : oneOf(a, "margin_mode", ["isolated", "cross"] as const),
    attachTp: bool(a, "attach_take_profit") ?? saved.attachTp,
  };
  let id = str(a, "drawing_id", { optional: true, max: 80 });
  /** Drawn for this order: taken away again when the order isn't sent (還原 brings it back). */
  let drawn = false;
  if (!id && (a.stop_loss == null || a.take_profit == null)) throw new ArgError("Give drawing_id, or entry, stop_loss and take_profit");
  if (id) {
    const wait = busy(`order:${id}`);
    if (wait) return wait;
  } else if (pending) return busy("") as ToolResult;

  const pane = await chartFor(app, instId);
  if (!pane) return fail(`${instId} couldn't be loaded on a chart (see the status bar in QT Chart).`);
  if (pane.feed.replaying) return fail("That chart is in a bar replay: stop it first (replay with action stop).");
  const newest = pane.feed.bars[pane.feed.bars.length - 1];
  if (!id) {
    const d = positionFrom(app, instId, a, prefs.ordType === "market" ? newest?.close : undefined);
    app.editDrawings(instId, (list) => {
      if (list.length >= MAX_DRAWINGS) throw new ArgError(`${shortName(instId)} already has ${MAX_DRAWINGS} drawings: delete some first`);
      list.push(d);
      return true;
    });
    id = d.id;
    drawn = true;
  }
  const undraw = () => {
    if (drawn) app.editDrawings(instId, (list) => {
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) list.splice(i, 1);
      return i >= 0;
    });
  };
  const d = pane.drawings.find(id);
  if (!d) return fail(`No drawing ${id} on ${instId}.`);
  if (d.kind !== "position") throw new ArgError("That drawing is not a position");
  if (d.okx) return fail("That position was drawn from the OKX account: it is on OKX already.");
  if (d.order && !["canceled", "mmp_canceled"].includes(d.order.state)) return fail(`That position already has an order (${d.order.state}): cancel_order cancels it, then it can be placed again.`);
  if (newest && d.b.t < newest.time) return fail("That position's box ends before the newest bar: move its end_time later (update_drawing) or draw a new one.");

  const spot = app.trading.spotFor({ ...pane.orders, trade: (x) => pane.drawings.tradeNow(x) }, d);
  const plan = orderPlanFor(spot, prefs);
  if (typeof plan === "string" || plan.problems.length) {
    undraw();
    return fail(typeof plan === "string" ? plan : `The order can't be sent: ${plan.problems.join("，")}`);
  }
  const pos = app.settings.position.get();
  const capital = app.trading.capital().amount;
  const within = withinDefaults({ risk: plan.risk, leverage: d.leverage }, pos, capital);
  // why it is asked when the settings wouldn't ask
  const note = within
    ? undefined
    : d.leverage > pos.leverage
      ? `槓桿 ${d.leverage}x 超過倉位預設的 ${pos.leverage}x，所以要你確認`
      : `最大虧損約 ${fmtMoney(plan.risk)} U，超過倉位預設的 ${fmtMoney(riskAllowed(pos, capital))} U，所以要你確認`;
  const demo = app.account.keys.demo;
  const ask = needsConfirm(app.mcp().confirm, demo, within);
  const req = request({ client: who(c), what: "order", symbol: instId, drawingId: id, status: ask ? "waiting for the user" : "sending" });
  const outcome = (r: OrderDone): ToolResult => {
    if (!r.placed) {
      req.status = "declined";
      req.result = "the user didn't confirm it";
      undraw();
      return {
        ...data({
          placed: false,
          reason: `The user didn't confirm it in QT Chart: nothing was sent${drawn ? ", and the position drawn for it was taken away" : ""}. Don't send it again unless the user asks.`,
        }),
        log: "使用者沒有確認，沒有下單",
      };
    }
    req.status = "done";
    const o = pane.drawings.find(id!)?.kind === "position" ? (pane.drawings.find(id!) as PositionDrawing).order : undefined;
    const out = {
      placed: true, symbol: instId, drawingId: id, orderId: r.ordId, demo: r.demo, side: r.side === "buy" ? "long" : "short", type: r.ordType,
      price: r.px, contracts: r.sz, coins: Number(r.coins.toFixed(8)), lossAtStop: Math.round(r.risk * 100) / 100, stopLoss: o?.sl ?? Number(plan.sl), takeProfit: o ? o.tp ?? null : plan.tp,
      ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
    };
    req.result = out;
    const what = `${shortName(instId)} ${r.side === "buy" ? "多單" : "空單"} ${r.sz} 張${r.demo ? "，模擬盤" : ""}`;
    app.note(`${who(c)} 下單：${what}`);
    return { ...data(out), log: `已下單：${what}` };
  };
  if (!ask) {
    try {
      return outcome(await submitOrder(spot, plan, prefs, true));
    } catch (e) {
      req.status = "failed";
      req.result = String(e);
      undraw();
      return fail(`OKX didn't take the order: ${e}`);
    }
  }
  const box = pane.el.getBoundingClientRect();
  return confirmWith(app, `order:${id}`, (resolve) =>
    openOrderWindow(box.left + box.width / 2 - 170, box.top + 48, spot, { from: who(c), prefs, note, done: (r) => resolve(outcome(r)) }),
  );
}

async function cancelOrder(app: McpApp, a: Args, c: CallCtx): Promise<ToolResult> {
  const blocked = usableAccount(app);
  if (blocked) return blocked;
  const instId = symbolArg(app, a);
  const id = str(a, "drawing_id", { max: 80 });
  const d = findDrawing(loadDrawings(instId), id, instId);
  if (d.kind !== "position" || !d.order) throw new ArgError("That drawing has no order placed from it");
  const o = d.order;
  if (!isOpenState(o.state)) return fail(`The order is ${o.state}: nothing to cancel.`);
  if (o.demo !== app.account.keys.demo) return fail(`The order was placed with the ${o.demo ? "demo" : "real"} API key, not the one set now.`);
  await app.account.cancel(instId, o.ordId);
  let next = o;
  try {
    next = withInfo(o, await app.account.order(instId, o.ordId));
  } catch (e) {
    if (isMissing(e)) next = { ...o, state: "missing" };
  }
  app.quietDrawings(instId, (list) => {
    const x = list.find((y) => y.id === id);
    if (x?.kind !== "position") return false;
    x.order = next;
    return true;
  });
  app.note(`${who(c)} 撤單：${shortName(instId)} 訂單 ${o.ordId}`);
  return { ...data({ cancelled: true, orderId: o.ordId, state: next.state, filledContracts: next.fillSz }), log: `已撤單：${shortName(instId)}` };
}

async function moveStops(app: McpApp, a: Args, c: CallCtx): Promise<ToolResult> {
  const instId = symbolArg(app, a);
  const id = str(a, "drawing_id", { max: 80 });
  const sl = num(a, "stop_loss", { optional: true, min: 0 });
  const tp = num(a, "take_profit", { optional: true, min: 0 });
  if (sl == null && tp == null) throw new ArgError("Give stop_loss and / or take_profit");
  const d = findDrawing(loadDrawings(instId), id, instId);
  if (d.kind !== "position") throw new ArgError("That drawing is not a position");
  if (d.okx?.closed || d.order?.closed) return fail("That position was closed on OKX.");
  if (app.trading.waiting(d)) return amendWaitingOrder(app, instId, id, { sl, tp }, c); // its size goes with it
  const dir = posDir(d);
  const bad = checkPrices({ entry: d.a.p, stop: sl ?? d.b.p, target: tp ?? d.target }, d.okx || d.order ? dir : undefined);
  if (bad) throw new ArgError(bad);
  const onOkx = (!!d.okx && !d.okx.closed) || app.sync.isLive(instId, d);
  if (!onOkx) {
    if (d.order && isOpenState(d.order.state)) return fail("The order is on OKX but QT Chart isn't following the account: turn on okxSync (update_settings) and the key must be unlocked.");
    app.editDrawings(instId, (list) => {
      const x = list.find((y) => y.id === id);
      if (x?.kind !== "position") return false;
      x.b = { ...x.b, p: sl ?? x.b.p };
      x.target = tp ?? x.target;
      return true;
    });
    app.note(`${who(c)} 移了 ${shortName(instId)} 倉位的止損止盈`);
    return data({ onOkx: false, stopLoss: sl ?? d.b.p, takeProfit: tp ?? d.target, note: "Not on OKX: only the drawing moved." });
  }
  const blocked = usableAccount(app);
  if (blocked) return blocked;
  const wait = busy(`stops:${id}`);
  if (wait) return wait;
  const demo = app.sync.symbolState(instId)?.demo ?? app.account.keys.demo;
  const widens = sl != null && widensStop(dir, d.b.p, sl);
  const ask = needsConfirm(app.mcp().confirm, demo, !widens);
  const req = request({ client: who(c), what: "stops", symbol: instId, drawingId: id, status: ask ? "waiting for the user" : "sending" });
  const change = { ...(sl != null ? { sl } : {}), ...(tp != null ? { tp } : {}) };
  const fmt = (p: number) => app.catalog.fmtPrice(instId, p);
  const outcome = (r: { ok: boolean; text: string }): ToolResult => {
    req.status = r.ok ? "done" : ask && /沒有確認/.test(r.text) ? "declined" : "failed";
    req.result = r.text;
    if (r.ok) app.note(`${who(c)} 改了 ${shortName(instId)} 在 OKX 上的止損止盈`);
    return r.ok
      ? { ...data({ moved: true, onOkx: true, details: r.text, note: "The drawing follows once OKX reports the change." }), log: `已改 OKX 止損止盈：${r.text}` }
      : { ...fail(r.text), log: r.text };
  };
  if (!ask) return outcome(await app.sync.amendForAi(instId, d, change, fmt, null));
  return confirmWith(app, `stops:${id}`, (resolve) => {
    const note = widens ? "止損移離進場價，虧損會變大，所以要你確認" : undefined;
    void app.sync.amendForAi(instId, d, change, fmt, { from: who(c), note }).then((r) => resolve(outcome(r)));
  });
}

async function amendOrder(app: McpApp, a: Args, c: CallCtx): Promise<ToolResult> {
  const instId = symbolArg(app, a);
  const id = str(a, "drawing_id", { max: 80 });
  const entry = num(a, "entry", { optional: true, min: 0 });
  const sl = num(a, "stop_loss", { optional: true, min: 0 });
  const tp = num(a, "take_profit", { optional: true, min: 0 });
  if (entry == null && sl == null && tp == null) throw new ArgError("Give entry, stop_loss and / or take_profit");
  return amendWaitingOrder(app, instId, id, { entry, sl, tp }, c);
}

/**
 * A waiting order's prices changed by an AI app: its position moved on the chart, the size worked out again,
 * the change asked for as the settings say, then sent; anything not sent puts the position back.
 */
async function amendWaitingOrder(app: McpApp, instId: string, id: string, p: { entry?: number; sl?: number; tp?: number }, c: CallCtx): Promise<ToolResult> {
  const blocked = usableAccount(app);
  if (blocked) return blocked;
  const d0 = findDrawing(loadDrawings(instId), id, instId);
  if (d0.kind !== "position") throw new ArgError("That drawing is not a position");
  if (!app.trading.waiting(d0)) return fail("That position has no order waiting on OKX with nothing filled: move_stops moves the stops of a filled one.");
  const o = d0.order!;
  if (o.demo !== app.account.keys.demo) return fail(`That order was placed with the ${o.demo ? "demo" : "real-money"} API key, not the one set now.`);
  const prices = { entry: p.entry ?? d0.a.p, stop: p.sl ?? d0.b.p, target: p.tp ?? d0.target };
  const bad = checkPrices(prices, posDir(d0));
  if (bad) throw new ArgError(bad);
  const key = `amend:${id}`;
  const wait = busy(key);
  if (wait) return wait;
  const pane = await chartFor(app, instId);
  if (!pane) return fail(`${instId} couldn't be loaded on a chart (see the status bar in QT Chart).`);
  if (pane.feed.replaying) return fail("That chart is in a bar replay: stop it first (replay with action stop).");
  const put = (entry: number, stop: number, target: number) =>
    app.quietDrawings(instId, (list) => {
      const x = list.find((y) => y.id === id);
      if (x?.kind !== "position") return false;
      x.a = { ...x.a, p: entry };
      x.b = { ...x.b, p: stop };
      x.target = target;
      return true;
    });
  put(prices.entry, prices.stop, prices.target);
  const revert = () => put(d0.a.p, d0.b.p, d0.target);
  const d = pane.drawings.find(id);
  if (d?.kind !== "position") {
    revert();
    return fail(`No drawing ${id} on ${instId}.`);
  }
  const spot = { ...app.trading.spotFor(pane.orders, d), trade: pane.drawings.tradeNow(id) };
  const plan = amendPlanFor(spot);
  if (plan == null) {
    revert();
    return data({ amended: false, note: "Nothing changes on OKX: the prices round to what the order has." });
  }
  if (typeof plan === "string" || plan.problems.length) {
    revert();
    return fail(typeof plan === "string" ? plan : `The order can't be changed: ${plan.problems.join("，")}`);
  }
  const pos = app.settings.position.get();
  const capital = app.trading.capital().amount;
  const within = withinDefaults({ risk: plan.risk, leverage: d.leverage }, pos, capital);
  const note = within ? undefined : `最大虧損約 ${fmtMoney(plan.risk)} U，超過倉位預設的 ${fmtMoney(riskAllowed(pos, capital))} U，所以要你確認`;
  const ask = needsConfirm(app.mcp().confirm, o.demo, within);
  const req = request({ client: who(c), what: "amend", symbol: instId, drawingId: id, status: ask ? "waiting for the user" : "sending" });
  const outcome = (r: { ok: boolean; text: string }): ToolResult => {
    req.status = r.ok ? "done" : ask && /沒有確認/.test(r.text) ? "declined" : "failed";
    req.result = r.text;
    if (!r.ok) return { ...fail(`${r.text}. The position is back as it was.`), log: r.text };
    const now = pane.drawings.find(id);
    const after = now?.kind === "position" ? now.order : undefined;
    app.note(`${who(c)} 改了 ${shortName(instId)} 的掛單`);
    const out = {
      amended: true, symbol: instId, drawingId: id, orderId: o.ordId, demo: o.demo, price: after?.px ?? null, contracts: after?.sz ?? plan.contracts,
      stopLoss: after?.sl ?? null, takeProfit: after?.tp ?? null, lossAtStop: Math.round(plan.risk * 100) / 100, changes: plan.lines,
      ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
    };
    return { ...data(out), log: `已改掛單：${plan.lines.join("，")}` };
  };
  if (!ask) {
    try {
      await sendAmend(spot, plan);
      return outcome({ ok: true, text: plan.lines.join("\n") });
    } catch (e) {
      revert();
      return outcome({ ok: false, text: `OKX didn't take the change: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  const box = pane.el.getBoundingClientRect();
  return confirmWith(app, key, (resolve) =>
    openAmendWindow(box.left + box.width / 2 - 170, box.top + 48, spot, plan, revert, { from: who(c), note, done: (r) => resolve(outcome(r)) }),
  );
}
