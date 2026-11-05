// The AI connection (MCP): its settings, what each tool may do, and the checks of what AI apps send. Pure (no
// DOM, no calls), unit-tested in tests/mcp.test.ts. The server itself is src-tauri/src/mcp.rs; the tools are
// tools.ts (shared parts), read.ts, write.ts and trade.ts; host.ts connects them to the server.

import { barForSec } from "../core/timeframes.ts";

/** Orders from AI apps: confirmed in QT Chart every time, only real-money ones, or never. */
export type ConfirmMode = "always" | "real" | "never";
export const CONFIRM_MODES: { key: ConfirmMode; label: string }[] = [
  { key: "always", label: "每次都要我確認" },
  { key: "real", label: "模擬盤不用確認，實盤要確認" },
  { key: "never", label: "都不用確認" },
];

export type McpSettings = {
  on: boolean;
  port: number;
  /** Charts may be changed: what they show, drawings, alerts, indicators, Pine scripts, settings. */
  write: boolean;
  /** Orders may be placed and cancelled, and stops on OKX moved. */
  trade: boolean;
  confirm: ConfirmMode;
};
export const DEFAULT_MCP: McpSettings = { on: false, port: 39217, write: true, trade: false, confirm: "always" };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function cleanMcp(raw: unknown): McpSettings {
  const r = isObj(raw) ? raw : {};
  const d = DEFAULT_MCP;
  const port = typeof r.port === "number" && Number.isInteger(r.port) && r.port >= 1024 && r.port <= 65535 ? r.port : d.port;
  return {
    on: r.on === true,
    port,
    write: r.write !== false,
    trade: r.trade === true,
    confirm: CONFIRM_MODES.some((m) => m.key === r.confirm) ? (r.confirm as ConfirmMode) : d.confirm,
  };
}

/** What a tool does: reads, changes the charts, or trades. */
export type Level = "read" | "write" | "trade";
export const LEVEL_TEXT: Record<Level, string> = { read: "讀取", write: "修改圖表", trade: "下單" };

export function allowed(level: Level, s: McpSettings): boolean {
  return level === "read" || (level === "write" ? s.write : s.trade);
}

/** Does an order from an AI app need the user's OK in QT Chart? `withinLimits`: its risk and leverage are within
 *  the position defaults (when they are not, it is always asked). */
export function needsConfirm(mode: ConfirmMode, demo: boolean, withinLimits: boolean): boolean {
  if (!withinLimits) return true;
  return mode === "always" || (mode === "real" && !demo);
}

/** The loss at the stop the position defaults allow (U): a share of `capital`, or an amount. */
export function riskAllowed(d: { risk: number; riskMode: "pct" | "amount" }, capital: number): number {
  return d.riskMode === "pct" ? (capital * d.risk) / 100 : d.risk;
}

/** An order within the position defaults: its loss at the stop no more than they allow (a hair over for the
 *  rounding of contracts and prices) and its leverage no higher. */
export function withinDefaults(o: { risk: number; leverage: number }, d: { risk: number; riskMode: "pct" | "amount"; leverage: number }, capital: number): boolean {
  return o.risk <= riskAllowed(d, capital) * 1.01 + 1e-9 && o.leverage <= d.leverage;
}

/** Moving a stop-loss from `from` to `to` adds to the loss at it: lower for a long (dir 1), higher for a short. */
export function widensStop(dir: 1 | -1, from: number, to: number): boolean {
  return (from - to) * dir > 0;
}

// ----------------------------------------------------------------------------- reading what AI apps send
/** A wrong argument: told back to the AI app as the tool's error. */
export class ArgError extends Error {}

export type Args = Record<string, unknown>;

export function str(a: Args, key: string, opt?: { optional?: false; max?: number }): string;
export function str(a: Args, key: string, opt: { optional: true; max?: number }): string | undefined;
export function str(a: Args, key: string, opt: { optional?: boolean; max?: number } = {}): string | undefined {
  const v = a[key];
  if (v === undefined || v === null) {
    if (opt.optional) return undefined;
    throw new ArgError(`${key} is required`);
  }
  if (typeof v !== "string") throw new ArgError(`${key} must be a string`);
  if (opt.max && v.length > opt.max) throw new ArgError(`${key} is too long (at most ${opt.max} characters)`);
  return v;
}

export function num(a: Args, key: string, opt?: { optional?: false; min?: number; max?: number; int?: boolean }): number;
export function num(a: Args, key: string, opt: { optional: true; min?: number; max?: number; int?: boolean }): number | undefined;
export function num(a: Args, key: string, opt: { optional?: boolean; min?: number; max?: number; int?: boolean } = {}): number | undefined {
  const v = a[key];
  if (v === undefined || v === null) {
    if (opt.optional) return undefined;
    throw new ArgError(`${key} is required`);
  }
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ArgError(`${key} must be a number`);
  if (opt.int && !Number.isInteger(n)) throw new ArgError(`${key} must be a whole number`);
  if (opt.min != null && n < opt.min) throw new ArgError(`${key} must be at least ${opt.min}`);
  if (opt.max != null && n > opt.max) throw new ArgError(`${key} must be at most ${opt.max}`);
  return n;
}

export function bool(a: Args, key: string, fallback?: boolean): boolean | undefined {
  const v = a[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new ArgError(`${key} must be true or false`);
  return v;
}

export function oneOf<T extends string>(a: Args, key: string, options: readonly T[], fallback?: T): T {
  const v = a[key];
  if ((v === undefined || v === null) && fallback !== undefined) return fallback;
  if (typeof v !== "string" || !options.includes(v as T)) throw new ArgError(`${key} must be one of: ${options.join(", ")}`);
  return v as T;
}

export function obj(a: Args, key: string): Args | undefined {
  const v = a[key];
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw new ArgError(`${key} must be an object`);
  return v;
}

/** A chart point: { time: UTC seconds, price }. */
export type Point = { t: number; p: number };
export function points(a: Args, key: string, min: number, max: number): Point[] {
  const v = a[key];
  if (!Array.isArray(v)) throw new ArgError(`${key} must be a list of { time, price }`);
  if (v.length < min || v.length > max) throw new ArgError(min === max ? `${key} needs ${min} points` : `${key} needs ${min} to ${max} points`);
  return v.map((x, i) => {
    if (!isObj(x)) throw new ArgError(`${key}[${i}] must be { time, price }`);
    const t = num(x, "time", { min: 0 });
    const p = num(x, "price");
    if (!(p > 0)) throw new ArgError(`${key}[${i}].price must be above 0`);
    return { t: t > 1e11 ? Math.floor(t / 1000) : t, p }; // milliseconds taken too
  });
}

/** The app's name for a timeframe an AI app writes: "15m", "15min", "1h", "4H", "1d", "D", "1W", "1Dutc"
 *  (null: not one the app shows; "1M" is a month, which it doesn't). */
export function normalizeTf(s: string): string | null {
  const m = /^(\d{1,4})?\s*([a-zA-Z]+?)(utc)?$/i.exec(s.trim());
  if (!m) return null;
  const n = m[1] ? Number(m[1]) : 1;
  const u = m[2];
  if (u === "M" || /^mo/i.test(u)) return null;
  const sec = /^(s|secs?|seconds?)$/i.test(u)
    ? 1
    : /^(m|mins?|minutes?)$/i.test(u)
      ? 60
      : /^(h|hrs?|hours?)$/i.test(u)
        ? 3600
        : /^(d|days?)$/i.test(u)
          ? 86400
          : /^(w|wks?|weeks?)$/i.test(u)
            ? 604800
            : 0;
  return sec && n >= 1 ? barForSec(n * sec) : null;
}

/** A time as an AI app reads it best next to the number: 2026-11-05T13:00:00Z. */
export const iso = (t: number): string => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** OKX's symbol for what an AI app may write: "BTC", "btc-usdt", "BTCUSDT.P", "BTC-USDT-SWAP" → BTC-USDT-SWAP. */
export function normalizeSymbol(s: string): string {
  const u = s.trim().toUpperCase().replace(/\.P$/, "").replace(/[\s/_]+/g, "-");
  if (/^[A-Z0-9]+-USDT-SWAP$/.test(u)) return u;
  const m = /^([A-Z0-9]+?)-?(USDT)?(-SWAP)?$/.exec(u);
  return m ? `${m[1]}-USDT-SWAP` : u;
}

/** A tool's answer: text, JSON (as text), or a picture; `log`: how it went, for the list of calls in the settings
 *  (kept in QT Chart, not sent). */
export type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean; log?: string };
export const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
export const data = (v: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
export const fail = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });
