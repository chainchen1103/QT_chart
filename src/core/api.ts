// Thin wrappers around the Rust commands and events (src-tauri/src/lib.rs).
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Candle = {
  time: number; // UTC seconds, start of the bar
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // base currency (e.g. BTC)
  confirmed: boolean;
};

export type Instrument = {
  instId: string; // e.g. BTC-USDT-SWAP
  base: string; // e.g. BTC
  tickSz: string;
  priceDecimals: number;
  last: number;
  change24h: number; // fraction, e.g. 0.012 = +1.2%
  volUsdt24h: number;
  ctVal: number; // coins in one contract (orders are in contracts)
  lotSz: string; // contract step, e.g. "0.01"
  minSz: string; // fewest contracts per order
  maxLever: number;
};

/** A symbol and a timeframe: one live candle channel. */
export type Pair = { instId: string; bar: string };
export type CandleEvent = { instId: string; bar: string; candle: Candle };
export type StreamStatus = { state: "connecting" | "ws" | "polling" | "error"; detail: string };

export const listInstruments = () => invoke<Instrument[]>("list_instruments");

// before: UTC milliseconds; returns bars strictly older than it (ascending). Without it: the latest bars.
export const getCandles = (instId: string, bar: string, before: number | null, count: number) =>
  invoke<Candle[]>("get_candles", { instId, bar, before, count });

/** Opens https://www.tradingview.com/ in the default browser (credit for the chart library). */
export const openTradingView = () => invoke<void>("open_tradingview");

/** Live candles for exactly these channels, over one connection (src-tauri/src/stream.rs); [] stops. */
export const setStreams = (pairs: Pair[]) => invoke<void>("set_streams", { pairs });
export const onCandle = (cb: (e: CandleEvent) => void): Promise<UnlistenFn> =>
  listen<CandleEvent>("candle", (e) => cb(e.payload));

/** Saved data, kept as files by the backend (src-tauri/src/store.rs): all of it at once, or one value. */
export const storeLoad = () => invoke<Record<string, string>>("store_load");
export const storeSet = (key: string, value: string) => invoke<void>("store_set", { key, value });
export const storeRemove = (key: string) => invoke<void>("store_remove", { key });

// ----------------------------------------------------------------------------- trading (src-tauri/src/trade.rs)
/** Is an OKX API key set? `hint`: its first and last characters (the secret never comes back). */
/** `locked`: saved with an unlock password not entered yet; `protected`: has an unlock password at all. */
export type KeyStatus = { set: boolean; demo: boolean; hint: string; locked: boolean; protected: boolean };
export type Account = { demo: boolean; equity: number; avail: number; posMode: string; acctLv: string };
export type OrderReq = {
  instId: string;
  side: "buy" | "sell";
  ordType: "limit" | "post_only" | "market";
  px: string | null;
  sz: string; // contracts
  tdMode: "isolated" | "cross";
  lever: number;
  tp: string | null;
  sl: string; // always
  clOrdId: string;
  /** The id its stop-loss / take-profit gets: OKX gives it to their order once this one fills. */
  algoClOrdId: string | null;
};
export type Placed = { ordId: string; clOrdId: string };
export type OrderInfo = {
  state: string; px: string; sz: string; avgPx: string; accFillSz: string; ordType: string; side: string; cTime: string;
  fillTime: string; uTime: string;
};

// ----------------------------------------------------------------------------- the account as it is (src-tauri/src/sync.rs)
/** An open position. posSide "net": one per symbol, pos below 0 is a short. Times in ms. */
export type SyncPos = {
  instId: string; posId: string; posSide: string; pos: number; avgPx: number; upl: number; markPx: number;
  liqPx: number | null; lever: number; mgnMode: string; cTime: number; uTime: number;
};
/** A stop-loss / take-profit order waiting; `side` is the side it closes with; sz 0 with closeFraction (all). */
export type SyncAlgo = {
  instId: string; algoId: string; algoClOrdId: string; ordType: string; side: string; posSide: string; sz: number;
  closeFraction: boolean; sl: number | null; tp: number | null; cTime: number;
};
/** An order that changed; sl / tp: its attached stop-loss and take-profit as they stand. */
export type SyncOrder = {
  instId: string; ordId: string; clOrdId: string; state: string; side: string; sz: number; accFillSz: number;
  avgPx: number | null; fillTime: number; uTime: number; sl: number | null; tp: number | null; attachAlgoClOrdId: string;
};
export type SyncEvent = { demo: boolean; source: "rest" | "ws"; positions: SyncPos[]; algos: SyncAlgo[]; orders: SyncOrder[] };
export type SyncStatus = { state: "off" | "connecting" | "ws" | "polling" | "error"; detail: string };
/** A closed position (OKX's position history); times in ms. */
export type ClosedPos = {
  instId: string; posId: string; direction: "long" | "short"; cTime: number; uTime: number;
  openAvgPx: number; closeAvgPx: number; realizedPnl: number; kind: string;
};
/** Move a stop-loss / take-profit: its own order ("algo", its order filled) or still attached to ordId. */
export type AmendReq = {
  instId: string; kind: "algo" | "attached"; ordId?: string; algoId?: string; algoClOrdId?: string; sl?: string; tp?: string;
};
export const tradeStatus = () => invoke<KeyStatus>("trade_status");
export const tradeSetKeys = (key: string, secret: string, passphrase: string, demo: boolean, password: string) =>
  invoke<Account>("trade_set_keys", { key, secret, passphrase, demo, password });
export const tradeUnlock = (password: string) => invoke<KeyStatus>("trade_unlock", { password });
export const tradeLock = () => invoke<KeyStatus>("trade_lock");
/** Set the unlock password (`current`: the one it has, when it has one). */
export const tradeSetPassword = (current: string | null, password: string) =>
  invoke<KeyStatus>("trade_set_password", { current, password });
export const tradeClearKeys = () => invoke<void>("trade_clear_keys");
export const tradeAccount = () => invoke<Account>("trade_account");
export const tradePlace = (order: OrderReq) => invoke<Placed>("trade_place", { order });
export const tradeOrder = (instId: string, ordId: string) => invoke<OrderInfo>("trade_order", { instId, ordId });
export const tradeCancel = (instId: string, ordId: string) => invoke<void>("trade_cancel", { instId, ordId });
/** Follow the account ("okx_sync" events) or stop. */
export const tradeSync = (on: boolean) => invoke<void>("trade_sync", { on });
export const tradeClosedPositions = (instId: string) => invoke<ClosedPos[]>("trade_closed_positions", { instId });
export const tradeAmendStops = (req: AmendReq) => invoke<void>("trade_amend_stops", { req });
export const onSync = (cb: (e: SyncEvent) => void): Promise<UnlistenFn> => listen<SyncEvent>("okx_sync", (e) => cb(e.payload));
export const onSyncStatus = (cb: (s: SyncStatus) => void): Promise<UnlistenFn> =>
  listen<SyncStatus>("okx_sync_status", (e) => cb(e.payload));

// ----------------------------------------------------------------------------- the AI connection (src-tauri/src/mcp.rs)
/** The MCP server: running or not, where, its token, why it couldn't start, where `--mcp-stdio` reads the port
 *  and token, and this program (for apps that start it with --mcp-stdio). */
export type McpStatus = { running: boolean; port: number; token: string; error: string; config: string; exe: string };
/** A call from an AI app: answered with mcpReply(id, ...). `client`: the app's name as it introduced itself. */
export type McpCall = { id: number; method: string; params: unknown; client: string };
export const mcpStatus = () => invoke<McpStatus>("mcp_status");
export const mcpStart = (port: number) => invoke<McpStatus>("mcp_start", { port });
export const mcpStop = () => invoke<McpStatus>("mcp_stop");
export const mcpNewToken = () => invoke<McpStatus>("mcp_new_token");
export const mcpReply = (id: number, result: unknown, error: string | null) => invoke<void>("mcp_reply", { id, result: result ?? null, error });
export const onMcpCall = (cb: (c: McpCall) => void): Promise<UnlistenFn> => listen<McpCall>("mcp_call", (e) => cb(e.payload));
/** Bring the window to the front (an order from an AI app waiting for the user's OK). */
export const windowAttention = () => invoke<void>("window_attention");

/** Whether the web view may use the graphics card; a change takes effect at the next start. */
export const gpuPref = () => invoke<boolean>("gpu_pref");
export const setGpuPref = (on: boolean) => invoke<void>("set_gpu_pref", { on });

/** An alert went off: taskbar flash when in the background, plus a Windows notification when `system`; clicking
 *  that brings the window back and opens `instId` (onAlertOpen). */
export const alertNotify = (title: string, body: string, system: boolean, sound: boolean, instId: string) =>
  invoke<void>("alert_notify", { title, body, system, sound, instId });
/** The Windows notification of an alert was clicked: open its symbol. */
export const onAlertOpen = (cb: (instId: string) => void): Promise<UnlistenFn> =>
  listen<string>("alert_open", (e) => cb(e.payload));
export const onStatus = (cb: (s: StreamStatus) => void): Promise<UnlistenFn> =>
  listen<StreamStatus>("stream_status", (e) => cb(e.payload));
