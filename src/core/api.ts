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
export type KeyStatus = { set: boolean; demo: boolean; hint: string };
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
};
export type Placed = { ordId: string; clOrdId: string };
export type OrderInfo = {
  state: string; px: string; sz: string; avgPx: string; accFillSz: string; ordType: string; side: string; cTime: string;
};
export const tradeStatus = () => invoke<KeyStatus>("trade_status");
export const tradeSetKeys = (key: string, secret: string, passphrase: string, demo: boolean) =>
  invoke<Account>("trade_set_keys", { key, secret, passphrase, demo });
export const tradeClearKeys = () => invoke<void>("trade_clear_keys");
export const tradeAccount = () => invoke<Account>("trade_account");
export const tradePlace = (order: OrderReq) => invoke<Placed>("trade_place", { order });
export const tradeOrder = (instId: string, ordId: string) => invoke<OrderInfo>("trade_order", { instId, ordId });
export const tradeCancel = (instId: string, ordId: string) => invoke<void>("trade_cancel", { instId, ordId });

/** Whether the web view may use the graphics card; a change takes effect at the next start. */
export const gpuPref = () => invoke<boolean>("gpu_pref");
export const setGpuPref = (on: boolean) => invoke<void>("set_gpu_pref", { on });

/** An alert went off: taskbar flash when in the background, plus a Windows notification when `system`. */
export const alertNotify = (title: string, body: string, system: boolean, sound: boolean) =>
  invoke<void>("alert_notify", { title, body, system, sound });
export const onStatus = (cb: (s: StreamStatus) => void): Promise<UnlistenFn> =>
  listen<StreamStatus>("stream_status", (e) => cb(e.payload));
