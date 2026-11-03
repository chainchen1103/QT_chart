// What a running script works with: values (na, colors, tuples, objects of user types, enums), frames (the
// variables and remembered state of the script and of each place a function is called from), the bars, and
// what the script draws and orders. One Runtime per compiled script; every run starts it afresh.

import type { Broker } from "./strategy.ts";
import type { Outputs } from "./outputs.ts";
import { barForSec } from "../core/timeframes.ts";

// ----------------------------------------------------------------------------- values

/** na: NaN for every type (arithmetic carries it on, comparisons with it are false). */
export const NA = NaN;
export const isNa = (v: unknown): boolean => v == null || v !== v;
/** Pine's `if x` / `and` / `or`: na and 0 are false. */
export const truthy = (v: unknown): boolean => !!v && v === v;

/** Several values returned at once: `[a, b] = f()`. */
export class Tuple {
  readonly items: unknown[];
  constructor(items: unknown[]) {
    this.items = items;
  }
}

export type UdtDef = {
  name: string;
  fields: string[];
  ix: Record<string, number>;
  /** Default value of each field (na when none was given). */
  defs: ((R: Runtime) => unknown)[];
};

/** An object of a user-defined type (`type Pivot …` → `Pivot.new(…)`). */
export class PineObject {
  readonly t: UdtDef;
  readonly f: unknown[];
  constructor(t: UdtDef, f: unknown[]) {
    this.t = t;
    this.f = f;
  }
}

/** A value of a user-defined enum. One object per value, so == compares them. */
export class EnumVal {
  readonly e: string;
  readonly name: string;
  readonly title: string;
  constructor(e: string, name: string, title: string) {
    this.e = e;
    this.name = name;
    this.title = title;
  }
  toString() {
    return this.title;
  }
}

export class PineError extends Error {}

// ----------------------------------------------------------------------------- colors
// A color is one number: rgb * 1001 + transparency * 10 (transparency 0 = solid … 100 = invisible, one
// decimal). == works, and na is NaN like every other na.

export const rgbt = (r: number, g: number, b: number, t = 0): number => {
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x || 0)));
  const tt = Math.max(0, Math.min(100, Number.isFinite(t) ? t : 0));
  return (c(r) * 65536 + c(g) * 256 + c(b)) * 1001 + Math.round(tt * 10);
};
export const colRgb = (c: number) => Math.floor(c / 1001);
export const colR = (c: number) => Math.floor(colRgb(c) / 65536);
export const colG = (c: number) => Math.floor(colRgb(c) / 256) % 256;
export const colB = (c: number) => colRgb(c) % 256;
export const colT = (c: number) => (c % 1001) / 10;
export const withT = (c: number, t: number) => colRgb(c) * 1001 + Math.round(Math.max(0, Math.min(100, t)) * 10);

/** #RRGGBB or #RRGGBBAA. */
export function hexColor(hex: string): number {
  const h = hex.replace("#", "");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  const a = h.length === 8 ? n(6) : 255;
  return rgbt(n(0), n(2), n(4), Math.round((1 - a / 255) * 1000) / 10);
}

/** For the canvas: rgba(…), or null for na and fully transparent colors. */
export function cssColor(c: number): string | null {
  if (!(c === c) || typeof c !== "number") return null;
  const t = colT(c);
  if (t >= 100) return null;
  return `rgba(${colR(c)},${colG(c)},${colB(c)},${Math.round((100 - t)) / 100})`;
}
/** #rrggbb without the transparency (for color inputs). */
export function hexOf(c: number): string {
  const h = (x: number) => x.toString(16).padStart(2, "0");
  return `#${h(colR(c))}${h(colG(c))}${h(colB(c))}`;
}

/** Built-in colors; v6 changed red, teal and yellow. */
export function namedColors(version: number): Record<string, number> {
  const v6 = version >= 6;
  return {
    aqua: hexColor("#00BCD4"),
    black: hexColor("#363A45"),
    blue: hexColor("#2196F3"),
    fuchsia: hexColor("#E040FB"),
    gray: hexColor("#787B86"),
    green: hexColor("#4CAF50"),
    lime: hexColor("#00E676"),
    maroon: hexColor("#880E4F"),
    navy: hexColor("#311B92"),
    olive: hexColor("#808000"),
    orange: hexColor("#FF9800"),
    purple: hexColor("#9C27B0"),
    red: hexColor(v6 ? "#F23645" : "#FF5252"),
    silver: hexColor("#B2B5BE"),
    teal: hexColor(v6 ? "#089981" : "#00897B"),
    white: hexColor("#FFFFFF"),
    yellow: hexColor(v6 ? "#FDD835" : "#FFEB3B"),
  };
}
/** TradingView's default plot / drawing blue. */
export const DEFAULT_BLUE = hexColor("#2962FF");

// ----------------------------------------------------------------------------- frames

/** The history of a variable that is read with [n]: one value per bar (the last is the current one). */
export type Hist = { b: number; a: unknown[] };

/** Variables (v), their histories (h), and the state of each call inside (s): one for the script itself, one
 *  for each place a function is called from. */
export type Frame = { v: unknown[]; h: (Hist | undefined)[]; s: unknown[] };

export type FnInfo = { nslots: number; nsites: number; tracked: boolean[] };
export const newFrame = (fi: FnInfo): Frame => ({ v: new Array(fi.nslots), h: new Array(fi.nslots), s: new Array(fi.nsites) });

// ----------------------------------------------------------------------------- the bars and symbol

export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number; confirmed: boolean };

export type SymInfo = {
  /** BTC-USDT-SWAP */
  instId: string;
  ticker: string;
  tickerid: string;
  base: string;
  quote: string;
  mintick: number;
  description: string;
};

export function symInfo(instId: string, mintick: number): SymInfo {
  const [base = instId, quote = "USDT", kind = ""] = instId.split("-");
  const ticker = `${base}${quote}${kind === "SWAP" ? ".P" : ""}`;
  return { instId, ticker, tickerid: `OKX:${ticker}`, base, quote, mintick: mintick > 0 ? mintick : 0.01, description: `${base} / ${quote}${kind === "SWAP" ? " 永續合約" : ""}` };
}

/** Pine timeframe strings ("1", "60", "240", "D", "1D", "W") ↔ seconds and OKX bar names. */
export type PineTf = { period: string; sec: number; okx: string | null };

const TF_TABLE: [string[], number, string | null][] = [
  [["1"], 60, "1m"],
  [["3"], 180, "3m"],
  [["5"], 300, "5m"],
  [["15"], 900, "15m"],
  [["30"], 1800, "30m"],
  [["60", "1H", "1h"], 3600, "1H"],
  [["120", "2H", "2h"], 7200, "2H"],
  [["240", "4H", "4h"], 14400, "4H"],
  [["360", "6H", "6h"], 21600, "6Hutc"],
  [["720", "12H", "12h"], 43200, "12Hutc"],
  [["D", "1D"], 86400, "1Dutc"],
  [["W", "1W"], 604800, "1Wutc"],
];

/** A Pine timeframe string; `okx` is the app's name for it, or null when the app can't load it (months,
 *  lengths no OKX bar divides). */
export function pineTf(s: string): PineTf | null {
  const t = s.trim();
  for (const [names, sec, okx] of TF_TABLE) if (names.includes(t)) return { period: names[0], sec, okx };
  const m = /^(\d+)([SDWM]?)$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const sec = unit === "" ? n * 60 : unit === "S" ? n : unit === "D" ? n * 86400 : unit === "W" ? n * 604800 : 0;
  if (!sec) return null;
  for (const [names, s2, okx] of TF_TABLE) if (s2 === sec) return { period: names[0], sec, okx };
  return { period: t, sec, okx: barForSec(sec) };
}

/** The Pine name of a timeframe in seconds (as `timeframe.period` shows it). */
export function periodOf(sec: number, version: number): string {
  if (sec % 604800 === 0) return `${version >= 6 || sec !== 604800 ? sec / 604800 : ""}W`;
  if (sec % 86400 === 0) return `${version >= 6 || sec !== 86400 ? sec / 86400 : ""}D`;
  if (sec % 60 === 0) return String(sec / 60);
  return `${sec}S`;
}

// ----------------------------------------------------------------------------- the runtime

export type Decl = {
  kind: "indicator" | "strategy" | "library";
  title: string;
  shorttitle: string;
  overlay: boolean;
  precision: number | null;
  format: string;
  maxLines: number;
  maxLabels: number;
  maxBoxes: number;
  maxPolylines: number;
  /** strategy() settings, as written (the broker reads them). */
  opts: Record<string, unknown>;
};

export const defaultDecl = (): Decl => ({
  kind: "indicator", title: "", shorttitle: "", overlay: false, precision: null, format: "inherit",
  maxLines: 50, maxLabels: 50, maxBoxes: 50, maxPolylines: 50, opts: {},
});

export type InputDef = {
  key: string;
  kind: "int" | "float" | "bool" | "string" | "color" | "source" | "timeframe" | "session" | "symbol" | "time" | "price" | "text_area" | "enum";
  title: string;
  defval: unknown;
  options: unknown[] | null;
  min: number | null;
  max: number | null;
  step: number | null;
  group: string;
  inline: string;
  tooltip: string;
  /** enum inputs: the values and their titles. */
  enumVals?: EnumVal[];
  /** The value the script got (the user's, or the default). */
  value?: unknown;
  /** Shown after the script's name in the legend (display.status_line). */
  legend: boolean;
};

/** What request.security() asks for: a timeframe, on plain or Heikin-Ashi bars ("240", "240|ha"). */
export type SecRequest = { key: string; tf: PineTf; ha: boolean };

/** Values of request.security() computed on another timeframe: per call (by key), one value per bar of it. */
export type SecRun = { tf: PineTf; times: number[]; confirmed: boolean[]; values: Map<string, unknown[]> };

export class Runtime {
  version = 5;
  // bars (struct of arrays; times in milliseconds like Pine's `time`)
  n = 0;
  i = 0;
  t: Float64Array = new Float64Array(0);
  o: Float64Array = new Float64Array(0);
  h: Float64Array = new Float64Array(0);
  l: Float64Array = new Float64Array(0);
  c: Float64Array = new Float64Array(0);
  vol: Float64Array = new Float64Array(0);
  conf: Uint8Array = new Uint8Array(0);
  /** Index of the last closed bar. */
  lastConfirmed = -1;
  tf: PineTf = { period: "1", sec: 60, okx: "1m" };
  sym: SymInfo = symInfo("BTC-USDT-SWAP", 0.1);
  now = 0;

  g!: Frame;
  /** break (1) / continue (2) on the way out of a loop body. */
  jump = 0;
  /** Line of the statement running (for error messages). */
  line = 0;
  loops = 0;
  deadline = 0;

  decl: Decl = defaultDecl();
  declSeen = false;
  inputs: InputDef[] = [];
  inputKeys = new Set<string>();
  inputVals: Record<string, unknown> = {};
  out!: Outputs;
  strat: Broker | null = null;
  /** request.security(): runs on other timeframes (main run), or the timeframe this run computes for. */
  sec = new Map<string, SecRun>();
  secFor: SecRequest | null = null;
  secOut = new Map<string, unknown[]>();
  /** Timeframes request.security() asked for that aren't loaded. */
  needs = new Set<string>();
  /** How many times each call site has made a frame (keys of security calls inside functions). */
  occ = new Map<number, number>();
  warnings = new Set<string>();
  logs: string[] = [];
  /** Whole-run series computed once (ta.obv, ta.vwap, …). */
  cache = new Map<string, Float64Array>();
  /** Enums of the script, by name (input.enum lists their values). */
  enums = new Map<string, EnumVal[]>();
  rng = 1;

  warn(text: string) {
    if (this.warnings.size < 20) this.warnings.add(text);
  }
}
