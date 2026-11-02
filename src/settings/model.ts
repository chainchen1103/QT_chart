// What the settings and drawings look like, their defaults, and the checks that turn whatever was saved
// (possibly old, partial or broken) into valid values. Pure: saving and reading is settings/store.ts.

import type { Anchor } from "../drawings/geometry.ts";
import type { RiskMode } from "../drawings/trade.ts";
import { TIMEFRAMES } from "../core/timeframes.ts";

export type MaKind = "SMA" | "EMA" | "WMA";
export const MA_KINDS: MaKind[] = ["SMA", "EMA", "WMA"];
/** `tf`: "" = the chart's timeframe, otherwise an OKX bar such as "4H". */
export type MaConf = { id: string; kind: MaKind; length: number; color: string; on: boolean; tf: string };
/** waitClose: lines from a larger timeframe only move when its bar closes (no repainting). */
export type MaOptions = { waitClose: boolean };

/** Fair value gaps on one timeframe. */
export type FvgConf = {
  id: string; on: boolean; tf: string; body: boolean; minPct: number; maxCount: number; showEnded: boolean; up: string; down: string;
};
/** Order blocks on one timeframe. */
export type ObConf = {
  id: string; on: boolean; tf: string; swing: number; lookback: number; maxCount: number; showEnded: boolean; up: string; down: string;
};
/** Support and resistance levels on one timeframe; `up` colors support, `down` resistance. */
export type SrConf = {
  id: string; on: boolean; tf: string; swing: number; maxCount: number; showEnded: boolean; up: string; down: string;
};
/** Master switches in the toolbar. */
export type Groups = { ma: boolean; fvg: boolean; ob: boolean; sr: boolean };
/** Labels on the right price scale (right-click it to switch them). */
export type ScaleLabels = {
  last: boolean; countdown: boolean; maValues: boolean; maNames: boolean; highLow: boolean; crosshair: boolean; volume: boolean;
};
export const LABEL_ITEMS: { key: keyof ScaleLabels; text: string; title: string }[] = [
  { key: "last", text: "最新價", title: "最新價的標籤和虛線" },
  { key: "countdown", text: "收線倒數", title: "這根 K 線還剩多久收，顯示在最新價下面（要開著最新價）" },
  { key: "maValues", text: "均線數值", title: "每條均線最新的值，用均線的顏色" },
  { key: "maNames", text: "均線名稱", title: "在均線數值旁邊標出是哪一條，例如 EMA20" },
  { key: "highLow", text: "畫面內最高、最低價", title: "目前畫面上 K 線的最高價和最低價，加虛線" },
  { key: "crosshair", text: "十字線價格", title: "滑鼠所在位置的價格" },
  { key: "volume", text: "成交量數值", title: "最新一根的成交量，顯示在成交量那一格" },
];

export type FibLevel = { value: number; color: string; on: boolean };
export type FibSettings = { levels: FibLevel[]; extend: boolean; fill: boolean; showPrice: boolean; reverse: boolean };

export type MagnetKey = "Control" | "Shift" | "Alt";
export const MAGNET_KEYS: { key: MagnetKey; label: string }[] = [
  { key: "Control", label: "Ctrl" },
  { key: "Shift", label: "Shift" },
  { key: "Alt", label: "Alt" },
];
/** `on`: always snap. Holding `holdKey` snaps only while it is held. */
export type MagnetSettings = { on: boolean; holdKey: MagnetKey };

// ----------------------------------------------------------------------------- drawings
export type LineKind = "trend" | "ray" | "info" | "extended" | "angle" | "hline" | "hray" | "vline" | "cross";
export type DrawKind = "fib" | LineKind | "rect" | "position";
export type Dash = "solid" | "dash" | "dot";
export type LineStyle = { color: string; width: number; dash: Dash };
/** `transparency` of the fill: 0 = solid, 100 = fully clear. */
export type RectStyle = { border: string; width: number; dash: Dash; fill: string; transparency: number; extend: boolean };

export type FibDrawing = { id: string; kind: "fib"; a: Anchor; b: Anchor };
/** One-point lines (horizontal, horizontal ray, vertical, cross) keep b equal to a. */
export type LineDrawing = { id: string; kind: LineKind; a: Anchor; b: Anchor; style: LineStyle };
export type RectDrawing = { id: string; kind: "rect"; a: Anchor; b: Anchor; style: RectStyle };
/**
 * A trade: a = entry (bar time, price); b.p = stop-loss price, b.t = where the box ends; target = take-profit.
 * capital null = start with what the previous position ended with (or the default capital).
 */
export type PositionDrawing = {
  id: string; kind: "position"; a: Anchor; b: Anchor; target: number;
  capital: number | null; risk: number; riskMode: RiskMode; leverage: number;
};
export type Drawing = FibDrawing | LineDrawing | RectDrawing | PositionDrawing;

/** Name, shortcut and number of points of each drawing tool. */
export const TOOL_INFO: Record<DrawKind, { name: string; key: string; points: 1 | 2 | 3 }> = {
  fib: { name: "Fib 回撤", key: "Alt+F", points: 2 },
  trend: { name: "趨勢線", key: "Alt+T", points: 2 },
  ray: { name: "射線", key: "", points: 2 },
  info: { name: "資訊線", key: "", points: 2 },
  extended: { name: "延長線", key: "", points: 2 },
  angle: { name: "趨勢角度", key: "", points: 2 },
  hline: { name: "水平線", key: "Alt+H", points: 1 },
  hray: { name: "水平射線", key: "Alt+J", points: 1 },
  vline: { name: "垂直線", key: "Alt+V", points: 1 },
  cross: { name: "十字線", key: "Alt+C", points: 1 },
  rect: { name: "矩形", key: "Alt+Shift+R", points: 2 },
  position: { name: "倉位", key: "Alt+P", points: 3 },
};

/** R lines of the position tool, and its colors. `transparency` of the zones: 0 = solid, 100 = clear. */
export type RLevel = { value: number; on: boolean };
export type PositionSettings = {
  levels: RLevel[]; profit: string; loss: string; transparency: number; showPrices: boolean;
  /** Defaults for new positions; `chain`: a position starts with what the previous one ended with. */
  capital: number; risk: number; riskMode: RiskMode; leverage: number; chain: boolean;
};
export const POSITION_LIMITS = {
  capital: { min: 0.01, max: 1e12 },
  pct: { min: 0.01, max: 100 },
  amount: { min: 0.01, max: 1e12 },
  leverage: { min: 1, max: 125 },
};
export const DEFAULT_POSITION: PositionSettings = {
  levels: [
    { value: 1, on: true },
    { value: 1.5, on: true },
    { value: 2, on: true },
  ],
  profit: "#089981",
  loss: "#f23645",
  transparency: 80,
  showPrices: true,
  capital: 1000,
  risk: 1,
  riskMode: "pct",
  leverage: 10,
  chain: true,
};
export const MAX_R_LEVELS = 12;
export const LINE_KINDS: LineKind[] = ["trend", "ray", "info", "extended", "angle", "hline", "hray", "vline", "cross"];
export const DASHES: { key: Dash; label: string }[] = [
  { key: "solid", label: "實線" },
  { key: "dash", label: "虛線" },
  { key: "dot", label: "點線" },
];
export const LINE_WIDTHS = [1, 2, 3, 4];
export const DEFAULT_LINE_STYLE: LineStyle = { color: "#2962ff", width: 2, dash: "solid" };
export const DEFAULT_RECT_STYLE: RectStyle = {
  border: "#9c27b0", width: 1, dash: "solid", fill: "#9c27b0", transparency: 80, extend: false,
};
export type DrawStyles = Partial<Record<LineKind, LineStyle>> & { rect?: RectStyle };

export const MAX_MAS = 10;
export const MAX_ZONE_SETS = 4;
export const MAX_LEVELS = 24;
export const MAX_DRAWINGS = 300;
export const MA_LEN = { min: 1, max: 1000 };
export const LEVEL_RANGE = { min: -10, max: 10 };
export const ZONE_LIMITS = {
  minPct: { min: 0, max: 10 },
  maxCount: { min: 1, max: 50 },
  swing: { min: 1, max: 20 },
  srSwing: { min: 1, max: 50 },
  lookback: { min: 1, max: 50 },
};

export const MA_COLORS = ["#ff5252", "#f7d046", "#b05ad6", "#2962ff", "#26c6da", "#66bb6a", "#ff9800", "#ec407a", "#8d6e63", "#b2b5be"];
export const FIB_COLORS = ["#f23645", "#ff9800", "#4caf50", "#089981", "#00bcd4", "#2962ff", "#9c27b0", "#e91e63", "#787b86"];

export const DEFAULT_MAS: MaConf[] = [
  { id: "ma-ema20", kind: "EMA", length: 20, color: "#ff5252", on: true, tf: "" },
  { id: "ma-sma100", kind: "SMA", length: 100, color: "#f7d046", on: true, tf: "" },
  { id: "ma-sma200", kind: "SMA", length: 200, color: "#b05ad6", on: true, tf: "" },
];
export const DEFAULT_MA_OPTIONS: MaOptions = { waitClose: true };
export const DEFAULT_FVG: FvgConf = {
  id: "fvg-1", on: true, tf: "", body: false, minPct: 0, maxCount: 10, showEnded: false, up: "#089981", down: "#f23645",
};
export const DEFAULT_OB: ObConf = {
  id: "ob-1", on: true, tf: "", swing: 3, lookback: 10, maxCount: 5, showEnded: false, up: "#2962ff", down: "#ff9800",
};
export const DEFAULT_SR: SrConf = {
  id: "sr-1", on: true, tf: "", swing: 10, maxCount: 3, showEnded: false, up: "#22ab94", down: "#f7525f",
};
export const DEFAULT_GROUPS: Groups = { ma: true, fvg: false, ob: false, sr: false };
export const DEFAULT_LABELS: ScaleLabels = {
  last: true, countdown: true, maValues: true, maNames: false, highLow: true, crosshair: true, volume: false,
};

export const DEFAULT_FIB: FibSettings = {
  levels: [
    { value: 0, color: "#787b86", on: true },
    { value: 0.236, color: "#f23645", on: true },
    { value: 0.382, color: "#ff9800", on: true },
    { value: 0.5, color: "#4caf50", on: true },
    { value: 0.618, color: "#089981", on: true },
    { value: 0.786, color: "#00bcd4", on: true },
    { value: 1, color: "#787b86", on: true },
    { value: 1.618, color: "#2962ff", on: true },
    { value: 2.618, color: "#f23645", on: false },
  ],
  extend: true,
  fill: true,
  showPrice: true,
  reverse: false,
};

export const DEFAULT_MAGNET: MagnetSettings = { on: false, holdKey: "Control" };

// ----------------------------------------------------------------------------- helpers
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const isColor = (c: unknown): c is string => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** "" (the chart's timeframe) or a known bar; anything else becomes "". */
const cleanTf = (v: unknown): string => (typeof v === "string" && TIMEFRAMES.some((t) => t.bar === v) ? v : "");
/** A number in [min, max] (rounded when `int`), or the fallback. */
const num = (v: unknown, r: { min: number; max: number }, fallback: number, int = true): number =>
  isNum(v) && v >= r.min && v <= r.max ? (int ? Math.round(v) : v) : fallback;

/** First color in `palette` that `used` doesn't have yet (or the next one in turn). */
export function nextColor(palette: string[], used: string[]): string {
  const taken = new Set(used.map((c) => c.toLowerCase()));
  return palette.find((c) => !taken.has(c.toLowerCase())) ?? palette[used.length % palette.length];
}

// ----------------------------------------------------------------------------- moving averages
export function cleanMas(raw: unknown): MaConf[] | null {
  if (!Array.isArray(raw)) return null;
  const out: MaConf[] = [];
  for (const m of raw) {
    if (out.length >= MAX_MAS) break;
    if (!isObj(m)) continue;
    const kind = MA_KINDS.find((k) => k === m.kind);
    const length = isNum(m.length) ? Math.round(m.length) : NaN;
    if (!kind || !(length >= MA_LEN.min && length <= MA_LEN.max) || !isColor(m.color)) continue;
    let id = typeof m.id === "string" && m.id ? m.id : newId("ma");
    if (out.some((x) => x.id === id)) id = newId("ma");
    out.push({ id, kind, length, color: m.color, on: m.on !== false, tf: cleanTf(m.tf) });
  }
  return out;
}


export function cleanMaOptions(raw: unknown): MaOptions {
  return { waitClose: !(isObj(raw) && raw.waitClose === false) };
}

// ----------------------------------------------------------------------------- FVG, order blocks, switches
/** Keep valid entries, with unique ids; fields that are off fall back to the defaults. */
function cleanSets<T extends { id: string }>(raw: unknown, fix: (r: Record<string, unknown>) => T, prefix: string): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out: T[] = [];
  for (const r of raw) {
    if (out.length >= MAX_ZONE_SETS) break;
    if (!isObj(r)) continue;
    const v = fix(r);
    if (!v.id || out.some((x) => x.id === v.id)) v.id = newId(prefix);
    out.push(v);
  }
  return out;
}

export function cleanFvgs(raw: unknown): FvgConf[] | null {
  const d = DEFAULT_FVG;
  return cleanSets(raw, (r) => ({
    id: typeof r.id === "string" ? r.id : "",
    on: r.on !== false,
    tf: cleanTf(r.tf),
    body: r.body === true,
    minPct: num(r.minPct, ZONE_LIMITS.minPct, d.minPct, false),
    maxCount: num(r.maxCount, ZONE_LIMITS.maxCount, d.maxCount),
    showEnded: r.showEnded === true,
    up: isColor(r.up) ? r.up : d.up,
    down: isColor(r.down) ? r.down : d.down,
  }), "fvg");
}

export function cleanObs(raw: unknown): ObConf[] | null {
  const d = DEFAULT_OB;
  return cleanSets(raw, (r) => ({
    id: typeof r.id === "string" ? r.id : "",
    on: r.on !== false,
    tf: cleanTf(r.tf),
    swing: num(r.swing, ZONE_LIMITS.swing, d.swing),
    lookback: num(r.lookback, ZONE_LIMITS.lookback, d.lookback),
    maxCount: num(r.maxCount, ZONE_LIMITS.maxCount, d.maxCount),
    showEnded: r.showEnded === true,
    up: isColor(r.up) ? r.up : d.up,
    down: isColor(r.down) ? r.down : d.down,
  }), "ob");
}

export function cleanSrs(raw: unknown): SrConf[] | null {
  const d = DEFAULT_SR;
  return cleanSets(raw, (r) => ({
    id: typeof r.id === "string" ? r.id : "",
    on: r.on !== false,
    tf: cleanTf(r.tf),
    swing: num(r.swing, ZONE_LIMITS.srSwing, d.swing),
    maxCount: num(r.maxCount, ZONE_LIMITS.maxCount, d.maxCount),
    showEnded: r.showEnded === true,
    up: isColor(r.up) ? r.up : d.up,
    down: isColor(r.down) ? r.down : d.down,
  }), "sr");
}

export function cleanGroups(raw: unknown): Groups {
  const g = isObj(raw) ? raw : {};
  return { ma: g.ma !== false, fvg: g.fvg === true, ob: g.ob === true, sr: g.sr === true };
}

export function cleanLabels(raw: unknown): ScaleLabels {
  const r = isObj(raw) ? raw : {};
  const out = { ...DEFAULT_LABELS };
  for (const k of Object.keys(out) as (keyof ScaleLabels)[]) if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  return out;
}

// ----------------------------------------------------------------------------- Fibonacci
export function sortLevels(levels: FibLevel[]): FibLevel[] {
  return [...levels].sort((a, b) => a.value - b.value);
}

export function cleanFib(raw: unknown): FibSettings | null {
  if (!isObj(raw) || !Array.isArray(raw.levels)) return null;
  const levels: FibLevel[] = [];
  for (const l of raw.levels) {
    if (levels.length >= MAX_LEVELS) break;
    if (!isObj(l) || !isNum(l.value) || !isColor(l.color)) continue;
    const value = Math.round(l.value * 1e4) / 1e4;
    if (value < LEVEL_RANGE.min || value > LEVEL_RANGE.max || levels.some((x) => x.value === value)) continue;
    levels.push({ value, color: l.color, on: l.on !== false });
  }
  return {
    levels: sortLevels(levels),
    extend: raw.extend !== false,
    fill: raw.fill !== false,
    showPrice: raw.showPrice !== false,
    reverse: raw.reverse === true,
  };
}

// ----------------------------------------------------------------------------- magnet
export function cleanMagnet(raw: unknown): MagnetSettings | null {
  if (!isObj(raw)) return null;
  const key = MAGNET_KEYS.find((k) => k.key === raw.holdKey);
  return { on: raw.on === true, holdKey: key ? key.key : DEFAULT_MAGNET.holdKey };
}
export const magnetKeyLabel = (k: MagnetKey) => MAGNET_KEYS.find((x) => x.key === k)?.label ?? k;

// ----------------------------------------------------------------------------- drawings, per symbol
const cleanDash = (v: unknown): Dash => (DASHES.some((d) => d.key === v) ? (v as Dash) : "solid");
const cleanWidth = (v: unknown, fallback: number): number => (isNum(v) && LINE_WIDTHS.includes(Math.round(v)) ? Math.round(v) : fallback);

export function cleanLineStyle(raw: unknown): LineStyle {
  const r = isObj(raw) ? raw : {};
  const d = DEFAULT_LINE_STYLE;
  return { color: isColor(r.color) ? r.color : d.color, width: cleanWidth(r.width, d.width), dash: cleanDash(r.dash) };
}
export function cleanRectStyle(raw: unknown): RectStyle {
  const r = isObj(raw) ? raw : {};
  const d = DEFAULT_RECT_STYLE;
  return {
    border: isColor(r.border) ? r.border : d.border,
    width: cleanWidth(r.width, d.width),
    dash: cleanDash(r.dash),
    fill: isColor(r.fill) ? r.fill : d.fill,
    transparency: num(r.transparency, { min: 0, max: 100 }, d.transparency),
    extend: r.extend === true,
  };
}

export function cleanDrawings(raw: unknown): Drawing[] {
  if (!Array.isArray(raw)) return [];
  const anchor = (a: unknown): Anchor | null => (isObj(a) && isNum(a.t) && isNum(a.p) ? { t: Math.round(a.t), p: a.p } : null);
  const out: Drawing[] = [];
  for (const d of raw) {
    if (out.length >= MAX_DRAWINGS) break;
    if (!isObj(d)) continue;
    const kind = d.kind;
    const a = anchor(d.a);
    const b = anchor(d.b) ?? a;
    if (!a || !b || typeof kind !== "string" || !(kind in TOOL_INFO)) continue;
    let id = typeof d.id === "string" && d.id ? d.id : newId(kind);
    if (out.some((x) => x.id === id)) id = newId(kind);
    if (kind === "fib") out.push({ id, kind, a, b });
    else if (kind === "rect") out.push({ id, kind, a, b, style: cleanRectStyle(d.style) });
    else if (kind === "position") {
      if (!isNum(d.target) || b.p === a.p) continue;
      const def = DEFAULT_POSITION;
      const riskMode: RiskMode = d.riskMode === "amount" ? "amount" : "pct";
      out.push({
        id, kind, a, b, target: d.target,
        capital: d.capital === null || d.capital === undefined ? null : num(d.capital, POSITION_LIMITS.capital, def.capital, false),
        risk: num(d.risk, POSITION_LIMITS[riskMode], def.risk, false),
        riskMode,
        leverage: num(d.leverage, POSITION_LIMITS.leverage, def.leverage, false),
      });
    }
    else out.push({ id, kind: kind as LineKind, a, b: TOOL_INFO[kind as LineKind].points === 1 ? { ...a } : b, style: cleanLineStyle(d.style) });
  }
  return out;
}

/** The style each tool last used: new drawings start from it. */
export function cleanDrawStyles(raw: unknown): DrawStyles {
  const r = isObj(raw) ? raw : {};
  const out: DrawStyles = {};
  for (const k of LINE_KINDS) if (isObj(r[k])) out[k] = cleanLineStyle(r[k]);
  if (isObj(r.rect)) out.rect = cleanRectStyle(r.rect);
  return out;
}

// ----------------------------------------------------------------------------- chart appearance
export type ImageFit = "cover" | "contain" | "stretch";
export const IMAGE_FITS: { key: ImageFit; label: string }[] = [
  { key: "cover", label: "填滿" },
  { key: "contain", label: "完整顯示" },
  { key: "stretch", label: "拉伸" },
];
/** `imageTransparency`: 0 = the picture at full strength, 100 = invisible. */
export type Appearance = {
  bg: string; grid: string; text: string; up: string; down: string; imageTransparency: number; imageFit: ImageFit;
};
export const DEFAULT_APPEARANCE: Appearance = {
  bg: "#131722", grid: "#1e222d", text: "#b2b5be", up: "#26a69a", down: "#ef5350", imageTransparency: 70, imageFit: "cover",
};
export function cleanAppearance(raw: unknown): Appearance {
  const r = isObj(raw) ? raw : {};
  const d = DEFAULT_APPEARANCE;
  const color = (v: unknown, f: string) => (isColor(v) ? v : f);
  return {
    bg: color(r.bg, d.bg),
    grid: color(r.grid, d.grid),
    text: color(r.text, d.text),
    up: color(r.up, d.up),
    down: color(r.down, d.down),
    imageTransparency: num(r.imageTransparency, { min: 0, max: 100 }, d.imageTransparency),
    imageFit: IMAGE_FITS.some((f) => f.key === r.imageFit) ? (r.imageFit as ImageFit) : d.imageFit,
  };
}

// ----------------------------------------------------------------------------- position tool
export function cleanPosition(raw: unknown): PositionSettings {
  const r = isObj(raw) ? raw : {};
  const d = DEFAULT_POSITION;
  const levels: RLevel[] = [];
  if (Array.isArray(r.levels)) {
    for (const l of r.levels) {
      if (levels.length >= MAX_R_LEVELS) break;
      if (!isObj(l) || !isNum(l.value) || l.value <= 0 || l.value > 20) continue;
      const value = Math.round(l.value * 100) / 100;
      if (!levels.some((x) => x.value === value)) levels.push({ value, on: l.on !== false });
    }
  }
  levels.sort((x, y) => x.value - y.value);
  return {
    levels: Array.isArray(r.levels) ? levels : clone(d.levels),
    profit: isColor(r.profit) ? r.profit : d.profit,
    loss: isColor(r.loss) ? r.loss : d.loss,
    transparency: num(r.transparency, { min: 0, max: 100 }, d.transparency),
    showPrices: r.showPrices !== false,
    capital: num(r.capital, POSITION_LIMITS.capital, d.capital, false),
    risk: num(r.risk, POSITION_LIMITS[r.riskMode === "amount" ? "amount" : "pct"], d.risk, false),
    riskMode: r.riskMode === "amount" ? "amount" : "pct",
    leverage: num(r.leverage, POSITION_LIMITS.leverage, d.leverage, false),
    chain: r.chain !== false,
  };
}
