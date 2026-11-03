// math.*, str.*, color.*, time and date functions, and the small helpers (nz, na, fixnan, int, float, bool).

import { colB, colG, colR, colT, EnumVal, isNa, PineError, rgbt, Tuple, withT, type Runtime } from "../runtime.ts";
import { num, toInt, type Lib } from "./types.ts";

// ----------------------------------------------------------------------------- numbers as text

/** A number the way Pine prints it without a format: up to 10 decimals, no trailing zeros. */
export function fmtNum(v: number): string {
  if (!(v === v)) return "NaN";
  if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toFixed(10)));
}

/** Java DecimalFormat patterns as Pine uses them: "#.##", "0.00", "#,##0.0#", "#.##%". */
export function decimalFormat(v: number, pattern: string): string {
  if (!(v === v)) return "NaN";
  const m = /[#0,.]+/.exec(pattern);
  if (!m) return pattern;
  const pre = pattern.slice(0, m.index).replace(/'/g, "");
  const post = pattern.slice(m.index + m[0].length).replace(/'/g, "");
  const core = m[0];
  if (pre.includes("%") || post.includes("%")) v *= 100;
  const dot = core.indexOf(".");
  const intPart = dot >= 0 ? core.slice(0, dot) : core;
  const decPart = dot >= 0 ? core.slice(dot + 1) : "";
  const minDec = (decPart.match(/0/g) ?? []).length;
  const maxDec = minDec + (decPart.match(/#/g) ?? []).length;
  const minInt = (intPart.match(/0/g) ?? []).length;
  const group = intPart.includes(",");
  const s = Math.abs(v).toFixed(Math.min(20, maxDec));
  let [ip, dp = ""] = s.split(".");
  while (dp.length > minDec && dp.endsWith("0")) dp = dp.slice(0, -1);
  ip = ip.padStart(minInt, "0");
  if (group) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = dp ? `${ip || "0"}.${dp}` : ip || "0";
  return (v < 0 && Number(s) !== 0 ? "-" : "") + pre + body + post;
}

/** str.tostring(value, format). */
export function toStr(R: Runtime, v: unknown, fmt?: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof EnumVal) return v.title;
  if (v instanceof Tuple) return `[${v.items.map((x) => toStr(R, x)).join(", ")}]`;
  if (Array.isArray(v)) return `[${v.map((x) => toStr(R, x)).join(", ")}]`;
  if (typeof v !== "number") return isNa(v) ? "NaN" : String(v);
  if (!(v === v)) return "NaN";
  if (typeof fmt === "string" && fmt) {
    switch (fmt) {
      case "mintick":
        return fixedFor(v, R.sym.mintick);
      case "price":
        return fixedFor(v, R.sym.mintick);
      case "percent":
        return `${v.toFixed(2)}%`;
      case "volume":
        return volume(v);
      case "inherit":
        return fmtNum(v);
    }
    return decimalFormat(v, fmt);
  }
  return fmtNum(v);
}
function fixedFor(v: number, tick: number): string {
  const d = tick > 0 ? Math.max(0, Math.min(10, Math.round(-Math.log10(tick) + 0.4999))) : 2;
  const r = tick > 0 ? Math.round(v / tick) * tick : v;
  return r.toFixed(d);
}
function volume(v: number): string {
  const a = Math.abs(v);
  const f = (x: number, s: string) => `${Number(x.toFixed(3))}${s}`;
  if (a >= 1e9) return f(v / 1e9, "B");
  if (a >= 1e6) return f(v / 1e6, "M");
  if (a >= 1e3) return f(v / 1e3, "K");
  return fmtNum(Number(v.toFixed(3)));
}

/** str.format("{0} and {1,number,#.##}", …): Java MessageFormat as Pine uses it. */
export function strFormat(R: Runtime, f: string, args: unknown[]): string {
  let out = "";
  let i = 0;
  while (i < f.length) {
    const ch = f[i];
    if (ch === "'") {
      // quoted text; '' is a quote
      if (f[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      const end = f.indexOf("'", i + 1);
      out += end < 0 ? f.slice(i + 1) : f.slice(i + 1, end);
      i = end < 0 ? f.length : end + 1;
      continue;
    }
    if (ch === "{") {
      const end = f.indexOf("}", i);
      if (end < 0) {
        out += f.slice(i);
        break;
      }
      const parts = f.slice(i + 1, end).split(",").map((s) => s.trim());
      const v = args[Number(parts[0])];
      out += formatArg(R, v, parts[1], parts.slice(2).join(","));
      i = end + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
function formatArg(R: Runtime, v: unknown, type?: string, style?: string): string {
  if (v === undefined) return "";
  if (typeof v !== "number" || type === undefined || !(v === v)) {
    if (typeof v === "number" && v === v && type === undefined) return decimalFormat(v, "#,##0.###");
    return toStr(R, v);
  }
  if (type === "number") {
    if (!style) return decimalFormat(v, "#,##0.###");
    if (style === "integer") return decimalFormat(Math.round(v), "#,##0");
    if (style === "percent") return decimalFormat(v, "#,##0%");
    if (style === "currency") return "$" + decimalFormat(v, "#,##0.00");
    return decimalFormat(v, style);
  }
  if (type === "date" || type === "time") return formatTime(v, style || (type === "date" ? "yyyy-MM-dd" : "HH:mm:ss"), 0);
  return toStr(R, v);
}

// ----------------------------------------------------------------------------- time

const fmtCache = new Map<string, Intl.DateTimeFormat | null>();

/** Offset of a time zone from UTC at time `t` (ms): "UTC", "GMT+8", "UTC-05:30", "Asia/Taipei". */
export function tzOffset(tz: unknown, t: number): number {
  if (typeof tz !== "string" || !tz) return 0;
  const s = tz.trim();
  if (/^(UTC|GMT|Etc\/UTC|Etc\/GMT|Z)$/i.test(s)) return 0;
  const m = /^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(s);
  if (m) return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 3600000 + Number(m[3] ?? 0) * 60000);
  let f = fmtCache.get(s);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: s, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    } catch {
      f = null;
    }
    fmtCache.set(s, f);
  }
  if (!f || !Number.isFinite(t)) return 0;
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(t))) if (x.type !== "literal") p[x.type] = Number(x.value);
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return local - Math.floor(t / 1000) * 1000;
}

/** Date parts of a time (ms) in a zone. */
export function parts(t: number, tz: unknown) {
  const d = new Date(t + tzOffset(tz, t));
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds(), wd: d.getUTCDay() + 1, date: d };
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - y0) / 86400000 + 1) / 7);
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** str.format_time: Java SimpleDateFormat letters (yyyy MM dd HH mm ss SSS a EEE MMM Z). */
export function formatTime(t: number, fmt: string, tz: unknown): string {
  if (!(t === t)) return "NaN";
  const off = tzOffset(tz, t);
  const p = parts(t, tz);
  let out = "";
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i];
    if (c === "'") {
      const end = fmt.indexOf("'", i + 1);
      out += end < 0 ? fmt.slice(i + 1) : fmt.slice(i + 1, end) || "'";
      i = end < 0 ? fmt.length : end + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(c)) {
      out += c;
      i++;
      continue;
    }
    let j = i;
    while (j < fmt.length && fmt[j] === c) j++;
    const n = j - i;
    const pad = (x: number, w = n) => String(x).padStart(w, "0");
    switch (c) {
      case "y":
        out += n === 2 ? pad(p.y % 100, 2) : pad(p.y, n);
        break;
      case "M":
        out += n >= 4 ? MON_FULL[p.mo - 1] : n === 3 ? MON_NAMES[p.mo - 1] : pad(p.mo);
        break;
      case "d":
        out += pad(p.d);
        break;
      case "H":
        out += pad(p.h);
        break;
      case "h":
        out += pad(p.h % 12 || 12);
        break;
      case "m":
        out += pad(p.mi);
        break;
      case "s":
        out += pad(p.s);
        break;
      case "S":
        out += pad(p.ms, 3).slice(0, Math.max(n, 3));
        break;
      case "a":
        out += p.h < 12 ? "AM" : "PM";
        break;
      case "E":
        out += n >= 4 ? DAY_FULL[p.wd - 1] : DAY_NAMES[p.wd - 1];
        break;
      case "Z":
      case "X": {
        const mins = Math.round(off / 60000);
        const sign = mins < 0 ? "-" : "+";
        out += `${sign}${String(Math.floor(Math.abs(mins) / 60)).padStart(2, "0")}${String(Math.abs(mins) % 60).padStart(2, "0")}`;
        break;
      }
      default:
        out += fmt.slice(i, j);
    }
    i = j;
  }
  return out;
}

/** timestamp("2020-02-20 15:30 +0200") or a date written out. */
export function parseDate(s: string): number {
  const t = s.trim();
  let v = Date.parse(t);
  if (Number.isFinite(v)) {
    // "2020-02-20" is UTC in JavaScript, "2020-02-20 15:30" is local time: Pine means UTC (OKX's exchange zone)
    if (!/[zZ]|[+-]\d{2}:?\d{2}\s*$|GMT|UTC/.test(t) && /\d{1,2}:\d{2}/.test(t)) v = Date.parse(t.replace(" ", "T") + "Z");
    return Number.isFinite(v) ? v : NaN;
  }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([+-]\d{2}:?\d{2}|Z|UTC|GMT)?$/.exec(t);
  if (!m) return NaN;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  return base - (m[7] ? tzOffset(m[7], base) : 0);
}

/** Start (ms) of the bar of `sec` seconds holding `t`; weeks start on Monday. */
export function periodStart(t: number, sec: number): number {
  const ms = sec * 1000;
  if (sec % 604800 === 0) {
    const mon = 4 * 86400000; // 1970-01-05 was a Monday
    return Math.floor((t - mon) / ms) * ms + mon;
  }
  return Math.floor(t / ms) * ms;
}

/** Is the bar starting at `t` inside the session "0930-1600[:days]" (several joined by commas)? */
export function inSession(t: number, session: string, tz: unknown): boolean {
  const s = session.trim();
  if (!s || s === "24x7" || s.toLowerCase() === "regular" || s.toLowerCase() === "extended") return true;
  const p = parts(t, tz);
  const mins = p.h * 60 + p.mi;
  for (const part of s.split(",")) {
    const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})(?::(\d+))?$/.exec(part.trim());
    if (!m) continue;
    const a = Number(m[1]) * 60 + Number(m[2]);
    const b = Number(m[3]) * 60 + Number(m[4]);
    if (m[5] && !m[5].includes(String(p.wd))) continue;
    if (a === b) return true;
    if (a < b ? mins >= a && mins < b : mins >= a || mins < b) return true;
  }
  return false;
}

// ----------------------------------------------------------------------------- the library

const n1 = (f: (x: number) => number) => ({ p: ["number"], f: (_R: Runtime, a: unknown[]) => f(num(a[0])) });
const numbers = (a: unknown[]): number[] => a.filter((x) => x !== undefined).map((x) => num(x));

export const CORE: Lib = {
  // ---- helpers
  nz: {
    p: ["source", "replacement"],
    f: (_R, a) => {
      const v = a[0];
      if (!isNa(v)) return v;
      if (a[1] !== undefined) return a[1];
      return typeof v === "string" ? "" : 0;
    },
  },
  na: { p: ["x"], f: (_R, a) => isNa(a[0]) },
  fixnan: {
    p: ["source"],
    st: () => ({ v: NaN as unknown }),
    f: (_R, a, st: { v: unknown }) => {
      if (!isNa(a[0])) st.v = a[0];
      return st.v;
    },
  },
  int: { p: ["x"], f: (_R, a) => (isNa(a[0]) ? NaN : Math.trunc(num(a[0]))) },
  float: { p: ["x"], f: (_R, a) => (isNa(a[0]) ? NaN : num(a[0])) },
  bool: { p: ["x"], f: (_R, a) => !!a[0] && a[0] === a[0] },
  string: { p: ["x"], f: (R, a) => toStr(R, a[0]) },
  color: { p: ["x"], f: (_R, a) => a[0] },
  max_bars_back: { p: ["var", "num"], f: () => NaN },
  "runtime.error": {
    p: ["message"],
    f: (_R, a) => {
      throw new PineError(String(a[0]));
    },
  },
  "log.info": { p: ["message", "..."], f: (R, a) => log(R, "info", a) },
  "log.warning": { p: ["message", "..."], f: (R, a) => log(R, "warning", a) },
  "log.error": { p: ["message", "..."], f: (R, a) => log(R, "error", a) },
  alert: { p: ["message", "freq"], f: () => NaN },
  alertcondition: { p: ["condition", "title", "message"], f: () => NaN },

  // ---- math
  "math.abs": n1(Math.abs),
  "math.ceil": n1(Math.ceil),
  "math.floor": n1(Math.floor),
  "math.sqrt": n1(Math.sqrt),
  "math.exp": n1(Math.exp),
  "math.log": n1(Math.log),
  "math.log10": n1(Math.log10),
  "math.sign": n1(Math.sign),
  "math.sin": n1(Math.sin),
  "math.cos": n1(Math.cos),
  "math.tan": n1(Math.tan),
  "math.asin": n1(Math.asin),
  "math.acos": n1(Math.acos),
  "math.atan": n1(Math.atan),
  "math.todegrees": n1((x) => (x * 180) / Math.PI),
  "math.toradians": n1((x) => (x * Math.PI) / 180),
  "math.round": {
    p: ["number", "precision"],
    f: (_R, a) => {
      const x = num(a[0]);
      if (a[1] === undefined || isNa(a[1])) return Math.round(x);
      const k = 10 ** toInt(a[1]);
      return Math.round(x * k) / k;
    },
  },
  "math.pow": { p: ["base", "exponent"], f: (_R, a) => num(a[0]) ** num(a[1]) },
  "math.max": { p: ["number0", "number1", "..."], f: (_R, a) => Math.max(...numbers(a)) },
  "math.min": { p: ["number0", "number1", "..."], f: (_R, a) => Math.min(...numbers(a)) },
  "math.avg": {
    p: ["number0", "number1", "..."],
    f: (_R, a) => {
      const v = numbers(a);
      return v.reduce((s, x) => s + x, 0) / v.length;
    },
  },
  "math.round_to_mintick": {
    p: ["number"],
    f: (R, a) => {
      const t = R.sym.mintick;
      return t > 0 ? Math.round(num(a[0]) / t) * t : num(a[0]);
    },
  },
  "math.random": {
    p: ["min", "max", "seed"],
    f: (R, a) => {
      if (a[2] !== undefined && !isNa(a[2])) R.rng = (toInt(a[2]) >>> 0) || 1;
      // xorshift32: the same numbers on every run
      let x = R.rng;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      R.rng = x >>> 0 || 1;
      const lo = num(a[0], 0);
      const hi = num(a[1], 1);
      return lo + (R.rng / 4294967296) * (hi - lo);
    },
  },

  // ---- color
  "color.new": { p: ["color", "transp"], f: (_R, a) => (isNa(a[0]) ? NaN : withT(num(a[0]), num(a[1], 0))) },
  "color.rgb": { p: ["red", "green", "blue", "transp"], f: (_R, a) => (isNa(a[0]) || isNa(a[1]) || isNa(a[2]) ? NaN : rgbt(num(a[0]), num(a[1]), num(a[2]), num(a[3], 0))) },
  "color.r": { p: ["color"], f: (_R, a) => (isNa(a[0]) ? NaN : colR(num(a[0]))) },
  "color.g": { p: ["color"], f: (_R, a) => (isNa(a[0]) ? NaN : colG(num(a[0]))) },
  "color.b": { p: ["color"], f: (_R, a) => (isNa(a[0]) ? NaN : colB(num(a[0]))) },
  "color.t": { p: ["color"], f: (_R, a) => (isNa(a[0]) ? NaN : colT(num(a[0]))) },
  "color.from_gradient": {
    p: ["value", "bottom_value", "top_value", "bottom_color", "top_color"],
    f: (_R, a) => {
      const v = num(a[0]);
      const lo = num(a[1]);
      const hi = num(a[2]);
      const c0 = num(a[3]);
      const c1 = num(a[4]);
      if (!(v === v) || !(lo === lo) || !(hi === hi)) return NaN;
      if (!(c0 === c0)) return c1;
      if (!(c1 === c1)) return c0;
      const k = hi === lo ? 1 : Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
      const mix = (x: number, y: number) => x + (y - x) * k;
      return rgbt(mix(colR(c0), colR(c1)), mix(colG(c0), colG(c1)), mix(colB(c0), colB(c1)), mix(colT(c0), colT(c1)));
    },
  },

  // ---- str
  "str.tostring": { p: ["value", "format"], f: (R, a) => toStr(R, a[0], a[1]) },
  "str.tonumber": {
    p: ["string"],
    f: (_R, a) => {
      const s = String(a[0] ?? "").trim();
      if (!s || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
      return Number(s);
    },
  },
  "str.format": { p: ["formatString", "..."], f: (R, a) => strFormat(R, String(a[0] ?? ""), a.slice(1)) },
  "str.format_time": { p: ["time", "format", "timezone"], f: (_R, a) => formatTime(num(a[0]), typeof a[1] === "string" ? a[1] : "yyyy-MM-dd'T'HH:mm:ssZ", a[2]) },
  "str.length": { p: ["string"], f: (_R, a) => (typeof a[0] === "string" ? a[0].length : NaN) },
  "str.contains": { p: ["source", "str"], f: (_R, a) => String(a[0] ?? "").includes(String(a[1] ?? "")) },
  "str.startswith": { p: ["source", "str"], f: (_R, a) => String(a[0] ?? "").startsWith(String(a[1] ?? "")) },
  "str.endswith": { p: ["source", "str"], f: (_R, a) => String(a[0] ?? "").endsWith(String(a[1] ?? "")) },
  "str.pos": {
    p: ["source", "str"],
    f: (_R, a) => {
      const i = String(a[0] ?? "").indexOf(String(a[1] ?? ""));
      return i < 0 ? NaN : i;
    },
  },
  "str.replace": {
    p: ["source", "target", "replacement", "occurrence"],
    f: (_R, a) => {
      const s = String(a[0] ?? "");
      const t = String(a[1] ?? "");
      if (!t) return s;
      let k = toInt(a[3] ?? 0);
      let from = 0;
      for (;;) {
        const i = s.indexOf(t, from);
        if (i < 0) return s;
        if (k-- <= 0) return s.slice(0, i) + String(a[2] ?? "") + s.slice(i + t.length);
        from = i + t.length;
      }
    },
  },
  "str.replace_all": { p: ["source", "target", "replacement"], f: (_R, a) => (a[1] ? String(a[0] ?? "").split(String(a[1])).join(String(a[2] ?? "")) : String(a[0] ?? "")) },
  "str.split": { p: ["string", "separator"], f: (_R, a) => String(a[0] ?? "").split(String(a[1] ?? "")) },
  "str.substring": {
    p: ["source", "begin_pos", "end_pos"],
    f: (_R, a) => {
      const s = String(a[0] ?? "");
      return a[2] === undefined ? s.substring(toInt(a[1])) : s.substring(toInt(a[1]), toInt(a[2]));
    },
  },
  "str.upper": { p: ["source"], f: (_R, a) => String(a[0] ?? "").toUpperCase() },
  "str.lower": { p: ["source"], f: (_R, a) => String(a[0] ?? "").toLowerCase() },
  "str.trim": { p: ["source"], f: (_R, a) => String(a[0] ?? "").trim() },
  "str.repeat": {
    p: ["source", "repeat", "separator"],
    f: (_R, a) => {
      const n = Math.max(0, toInt(a[1]) || 0);
      return Array.from({ length: n }, () => String(a[0] ?? "")).join(String(a[2] ?? ""));
    },
  },
  "str.match": {
    p: ["source", "regex"],
    f: (_R, a) => {
      try {
        const m = new RegExp(String(a[1] ?? "")).exec(String(a[0] ?? ""));
        return m ? m[0] : "";
      } catch {
        return "";
      }
    },
  },

  // ---- time
  year: { p: ["time", "timezone"], f: (R, a) => datePart(R, a, (p) => p.y) },
  month: { p: ["time", "timezone"], f: (R, a) => datePart(R, a, (p) => p.mo) },
  dayofmonth: { p: ["time", "timezone"], f: (R, a) => datePart(R, a, (p) => p.d) },
  dayofweek: { p: ["time", "timezone"], f: (R, a) => datePart(R, a, (p) => p.wd) },
  hour: { p: ["time", "timezone"], f: (R, a) => datePart(R, a, (p) => p.h) },
  minute: { p: ["time", "timezone"], f: (R, a) => datePart(R, a, (p) => p.mi) },
  second: { p: ["time", "timezone"], f: (R, a) => datePart(R, a, (p) => p.s) },
  weekofyear: { p: ["time", "timezone"], f: (R, a) => datePart(R, a, (p) => isoWeek(p.date)) },
  timestamp: {
    p: ["timezone", "year", "month", "day", "hour", "minute", "second"],
    f: (_R, a) => {
      if (typeof a[0] === "string" && a[1] === undefined) return parseDate(a[0]);
      let tz: unknown = null;
      let v = a;
      if (typeof a[0] === "number") v = [null, ...a];
      else tz = a[0];
      const [, y, mo, d, h, mi, s] = v as (number | undefined)[];
      if ([y, mo, d].some((x) => x === undefined || isNa(x))) return NaN;
      const base = Date.UTC(num(y), num(mo) - 1, num(d), num(h, 0), num(mi, 0), num(s, 0));
      return base - tzOffset(tz, base);
    },
  },
  time: { p: ["timeframe", "session", "timezone"], f: (R, a) => barTime(R, a, false) },
  time_close: { p: ["timeframe", "session", "timezone"], f: (R, a) => barTime(R, a, true) },
};

function log(R: Runtime, level: string, a: unknown[]) {
  const text = a.length > 1 ? strFormat(R, String(a[0]), a.slice(1)) : toStr(R, a[0]);
  if (R.logs.length < 200) R.logs.push(`[${level}] ${text}`);
  return NaN;
}

function datePart(R: Runtime, a: unknown[], pick: (p: ReturnType<typeof parts>) => number): number {
  const t = a[0] === undefined ? R.t[R.i] : num(a[0]);
  if (!(t === t)) return NaN;
  return pick(parts(t, a[1]));
}

function barTime(R: Runtime, a: unknown[], close: boolean): number {
  const t = R.t[R.i];
  const tf = typeof a[0] === "string" && a[0] ? a[0] : "";
  let start = t;
  let sec = R.tf.sec;
  if (tf) {
    const p = tfSeconds(tf);
    if (p && p > R.tf.sec) {
      sec = p;
      start = periodStart(t, p);
    }
  }
  if (typeof a[1] === "string" && a[1] && !inSession(t, a[1], a[2])) return NaN;
  return close ? start + sec * 1000 : start;
}

/** Seconds in a Pine timeframe string ("15", "60", "D", "1W", "3M" ≈ 30 days per month). */
export function tfSeconds(s: string): number {
  const m = /^(\d*)([SDWM]?)$/.exec(s.trim());
  if (!m) return 0;
  const n = m[1] ? Number(m[1]) : 1;
  switch (m[2]) {
    case "":
      return n * 60;
    case "S":
      return n;
    case "D":
      return n * 86400;
    case "W":
      return n * 604800;
    case "M":
      return n * 2592000;
  }
  return 0;
}
