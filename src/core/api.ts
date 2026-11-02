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
};

export type CandleEvent = { instId: string; bar: string; candle: Candle };
export type StreamStatus = { state: "connecting" | "ws" | "polling" | "error"; detail: string };

export const listInstruments = () => invoke<Instrument[]>("list_instruments");

// before: UTC milliseconds; returns bars strictly older than it (ascending). Without it: the latest bars.
export const getCandles = (instId: string, bar: string, before: number | null, count: number) =>
  invoke<Candle[]>("get_candles", { instId, bar, before, count });

/** Opens https://www.tradingview.com/ in the default browser (credit for the chart library). */
export const openTradingView = () => invoke<void>("open_tradingview");

export const startStream = (instId: string, bar: string) => invoke<void>("start_stream", { instId, bar });

export const onCandle = (cb: (e: CandleEvent) => void): Promise<UnlistenFn> =>
  listen<CandleEvent>("candle", (e) => cb(e.payload));

/** 1-minute candles of every symbol with an alert on (see src-tauri/src/watch.rs); [] stops. */
export const watchSymbols = (instIds: string[]) => invoke<void>("watch_symbols", { instIds });
export const onWatchCandle = (cb: (e: CandleEvent) => void): Promise<UnlistenFn> =>
  listen<CandleEvent>("watch_candle", (e) => cb(e.payload));
/** Saved data, kept as files by the backend (src-tauri/src/store.rs): all of it at once, or one value. */
export const storeLoad = () => invoke<Record<string, string>>("store_load");
export const storeSet = (key: string, value: string) => invoke<void>("store_set", { key, value });
export const storeRemove = (key: string) => invoke<void>("store_remove", { key });

/** Whether the web view may use the graphics card; a change takes effect at the next start. */
export const gpuPref = () => invoke<boolean>("gpu_pref");
export const setGpuPref = (on: boolean) => invoke<void>("set_gpu_pref", { on });

/** An alert went off: taskbar flash when in the background, plus a Windows notification when `system`. */
export const alertNotify = (title: string, body: string, system: boolean, sound: boolean) =>
  invoke<void>("alert_notify", { title, body, system, sound });
export const onStatus = (cb: (s: StreamStatus) => void): Promise<UnlistenFn> =>
  listen<StreamStatus>("stream_status", (e) => cb(e.payload));
