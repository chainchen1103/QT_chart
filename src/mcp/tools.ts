// The tools AI apps use (MCP), shared parts: what a tool is, what it may reach in the app (McpApp), and how the
// symbol, chart and timeframe an app names are found. The tools themselves are in read.ts, write.ts and
// trade.ts; host.ts lists them and calls them.

import type { Catalog } from "../chart/catalog.ts";
import type { ChartPane } from "../chart/pane.ts";
import type { AlertService } from "../alerts/service.ts";
import type { DrawingHistory } from "../drawings/history.ts";
import type { Workspace } from "../layout/workspace.ts";
import type { Drawing } from "../settings/model.ts";
import type { Settings } from "../settings/store.ts";
import type { TradeAccount } from "../trade/account.ts";
import type { AccountSync } from "../trade/sync.ts";
import type { Trading } from "../trade/trading.ts";
import { ArgError, normalizeSymbol, normalizeTf, num, str, type Args, type Level, type McpSettings, type ToolResult } from "./model.ts";

/** What the tools may reach. */
export type McpApp = {
  settings: Settings;
  catalog: Catalog;
  workspace: Workspace;
  alerts: AlertService;
  account: TradeAccount;
  trading: Trading;
  sync: AccountSync;
  history: DrawingHistory;
  /** The AI connection's own settings (what it may do, when orders are confirmed). */
  mcp(): McpSettings;
  /** An AI app changes a symbol's drawings: saved, one step to undo, shown on every chart of the symbol; `edit`
   *  says whether it changed anything. */
  editDrawings(instId: string, edit: (list: Drawing[]) => boolean): void;
  /** The same for what OKX did to them (an order's state): saved and shown, no step to undo. */
  quietDrawings(instId: string, edit: (list: Drawing[]) => boolean): void;
  /** A short message in the status bar. */
  note(text: string): void;
  /** Bring the window to the front (an order waiting for the user's OK). */
  attention(): void;
};

/** Who is calling: the app's name as it introduced itself ("" when it didn't). */
export type CallCtx = { client: string };

export type Tool = {
  name: string;
  title: string;
  description: string;
  level: Level;
  input: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run(a: Args, c: CallCtx): ToolResult | Promise<ToolResult>;
};

/** The app's name in what QT Chart shows ("AI 應用程式" when it didn't say). */
export const who = (c: CallCtx) => c.client || "AI 應用程式";

// ----------------------------------------------------------------------------- input schemas
export const S = {
  str: (description: string, more: Record<string, unknown> = {}) => ({ type: "string", description, ...more }),
  num: (description: string, more: Record<string, unknown> = {}) => ({ type: "number", description, ...more }),
  int: (description: string, more: Record<string, unknown> = {}) => ({ type: "integer", description, ...more }),
  bool: (description: string) => ({ type: "boolean", description }),
  oneOf: (values: readonly string[], description: string) => ({ type: "string", enum: values, description }),
  obj: (description: string, properties: Record<string, unknown>) => ({ type: "object", description, properties }),
};
export const SYMBOL = S.str("OKX USDT perpetual swap such as BTC-USDT-SWAP (BTC or BTCUSDT work too). Default: the symbol of the chart in use.");
export const CHART = S.int("A chart of the shown tab, by its index in get_app_state (0 to 3). Default: the chart in use.", { minimum: 0, maximum: 3 });
export const TIMEFRAME = S.str("Timeframe such as 1m, 5m, 15m, 1H, 4H, 1D, 1W; seconds (15s) and other lengths (10m, 3H) work too.");
export const POINT = {
  type: "object",
  properties: { time: S.num("UTC seconds (milliseconds are taken too)."), price: S.num("Price.") },
  required: ["time", "price"],
};
export const COLOR = S.str("Color as #rrggbb.", { pattern: "^#[0-9a-fA-F]{6}$" });

// ----------------------------------------------------------------------------- what an app names
/** The symbol named under `key` (normalized and checked against the symbol list), or the chart in use's. */
export function symbolArg(app: McpApp, a: Args, key = "symbol"): string {
  const raw = str(a, key, { optional: true, max: 40 });
  if (raw == null || raw.trim() === "") return app.workspace.inUse().feed.instId;
  const id = normalizeSymbol(raw);
  if (app.catalog.list.length && !app.catalog.get(id)) throw new ArgError(`Unknown symbol ${raw}: list_symbols finds the ones OKX has`);
  return id;
}

/** The chart named by its index, or the one in use. */
export function chartArg(app: McpApp, a: Args): ChartPane {
  const i = num(a, "chart", { optional: true, int: true, min: 0 });
  if (i == null) return app.workspace.inUse();
  const charts = app.workspace.charts();
  const p = charts[i];
  if (!p) throw new ArgError(`There is no chart ${i}: the shown tab has ${charts.length} (see get_app_state)`);
  return p;
}

/** The timeframe named under `key`, in the app's own name for it; undefined when not given. */
export function tfArg(a: Args, key = "timeframe"): string | undefined {
  const raw = str(a, key, { optional: true, max: 16 });
  if (raw == null || raw.trim() === "") return undefined;
  const tf = normalizeTf(raw);
  if (!tf) throw new ArgError(`Unknown timeframe ${raw}: use 1m, 5m, 15m, 1H, 4H, 1D, 1W and the like (no months)`);
  return tf;
}

/** The charts on screen showing a symbol, the one in use first. */
export function chartsOf(app: McpApp, instId: string): ChartPane[] {
  const inUse = app.workspace.inUse();
  return [...app.workspace.charts()].filter((p) => p.feed.instId === instId).sort((x, y) => Number(y === inUse) - Number(x === inUse));
}

/** A chart showing `instId` with its bars and drawings loaded: one on screen already, or the chart in use switched
 *  to it (its timeframe kept). Null when the bars couldn't be loaded. */
export async function chartFor(app: McpApp, instId: string): Promise<ChartPane | null> {
  const ready = (p: ChartPane) => p.feed.instId === instId && p.feed.current;
  const shown = chartsOf(app, instId);
  const done = shown.find(ready);
  if (done) return done;
  const p = shown[0] ?? app.workspace.inUse();
  if (p.feed.instId !== instId) await p.switchTo(instId, p.feed.bar);
  else await waitFor(() => ready(p) || !app.workspace.charts().includes(p), 15_000);
  return app.workspace.charts().includes(p) && ready(p) ? p : null;
}

/** Wait until `test` holds (checked every 100 ms) or `ms` pass; whether it held. */
export async function waitFor(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

/** A drawing of a symbol by id (from what is saved: charts save every change at once). */
export function findDrawing(list: readonly Drawing[], id: string, instId: string): Drawing {
  const d = list.find((x) => x.id === id);
  if (!d) throw new ArgError(`No drawing ${id} on ${instId}: list_drawings shows them`);
  return d;
}

// ----------------------------------------------------------------------------- what AI apps asked to trade
/** An order or a stop change an AI app asked for, and how it went (get_account shows them). */
export type TradeRequest = {
  time: number;
  client: string;
  what: "order" | "stops";
  symbol: string;
  drawingId: string;
  status: "waiting for the user" | "sending" | "done" | "declined" | "failed";
  result?: unknown;
};
const requests: TradeRequest[] = [];

/** The ones asked for while QT Chart runs, newest first (the last 20). */
export function orderRequests(): readonly TradeRequest[] {
  return requests;
}

/** A new one, kept to be updated as it goes. */
export function request(r: Omit<TradeRequest, "time">): TradeRequest {
  const x = { time: Math.floor(Date.now() / 1000), ...r };
  requests.unshift(x);
  if (requests.length > 20) requests.pop();
  return x;
}
