// ta.*: indicators. Each call site keeps its own state (the values it was given on earlier bars), like
// TradingView: a ta function called only on some bars only sees those bars. na values are skipped by the
// averages (they work on the last `length` values that are not na).

import { Tuple, type Runtime } from "../runtime.ts";
import { num, toInt, type Lib } from "./types.ts";

// ----------------------------------------------------------------------------- building blocks

/** Every value given, one per call (na included); old ones are dropped once far behind. */
export class Seq {
  a: number[] = [];
  push(v: number, keep = 3000) {
    const a = this.a;
    a.push(v);
    if (a.length > keep * 2 + 4096) a.splice(0, a.length - Math.max(keep, 3000));
  }
  ago(k: number): number {
    const j = this.a.length - 1 - k;
    return j >= 0 && j < this.a.length ? this.a[j] : NaN;
  }
  get size() {
    return this.a.length;
  }
}

/** Mean of the last `len` values that are not na (running sum, recomputed now and then). */
export class Sma {
  a: number[] = [];
  private sum = 0;
  private len = -1;
  private k = 0;
  next(v: number, len: number): number {
    if (!(len >= 1)) return NaN;
    const a = this.a;
    if (v === v) {
      a.push(v);
      if (a.length > len * 2 + 4096) {
        a.splice(0, a.length - len);
        this.len = -1;
      }
      if (len === this.len && this.k < 1024) {
        this.sum += v;
        if (a.length > len) this.sum -= a[a.length - 1 - len];
        this.k++;
      } else this.exact(len);
    } else if (len !== this.len) this.exact(len);
    return a.length >= len ? this.sum / len : NaN;
  }
  /** Sum of the window (math.sum). */
  total(v: number, len: number): number {
    const m = this.next(v, len);
    return m * len;
  }
  private exact(len: number) {
    const a = this.a;
    let s = 0;
    for (let i = Math.max(0, a.length - len); i < a.length; i++) s += a[i];
    this.sum = s;
    this.len = len;
    this.k = 0;
  }
}

/** Exponential average (alpha given), started from the mean of the first `len` values. */
export class Ema {
  prev = NaN;
  private seed = new Sma();
  next(v: number, alpha: number, len: number): number {
    if (!(v === v)) return this.prev;
    if (this.prev === this.prev) {
      this.prev = alpha * v + (1 - alpha) * this.prev;
      return this.prev;
    }
    const s = this.seed.next(v, len);
    if (s === s) this.prev = s;
    return this.prev;
  }
}
const ema = (st: Ema, v: number, len: number) => (len >= 1 ? st.next(v, 2 / (len + 1), len) : NaN);
const rma = (st: Ema, v: number, len: number) => (len >= 1 ? st.next(v, 1 / len, len) : NaN);

/** The values that are not na, for functions that look at the whole window each bar. */
export class Window {
  a: number[] = [];
  push(v: number, len: number) {
    if (v === v) {
      const a = this.a;
      a.push(v);
      if (a.length > len * 2 + 4096) a.splice(0, a.length - Math.max(len, 1));
    }
  }
  full(len: number) {
    return len >= 1 && this.a.length >= len;
  }
}

class Wma {
  w = new Window();
  next(v: number, len: number): number {
    this.w.push(v, len);
    if (!this.w.full(len)) return NaN;
    const a = this.w.a;
    let s = 0;
    for (let i = 0; i < len; i++) s += a[a.length - 1 - i] * (len - i);
    return s / ((len * (len + 1)) / 2);
  }
}

/** Deviation, with TradingView's rule that differences within 1e-10 count as zero. */
const dz = (d: number) => (Math.abs(d) <= 1e-10 ? 0 : d);

class Stdev {
  w = new Window();
  next(v: number, len: number, biased: boolean, variance = false): number {
    this.w.push(v, len);
    if (!this.w.full(len)) return NaN;
    const a = this.w.a;
    let m = 0;
    for (let i = a.length - len; i < a.length; i++) m += a[i];
    m /= len;
    let s = 0;
    for (let i = a.length - len; i < a.length; i++) {
      const d = dz(a[i] - m);
      s += d * d;
    }
    const div = biased ? len : len - 1;
    const varc = div > 0 ? s / div : NaN;
    return variance ? varc : Math.sqrt(varc);
  }
}

/** Highest / lowest over the last `len` bars (na skipped). */
class Extreme {
  s = new Seq();
  next(v: number, len: number, hi: boolean): { v: number; k: number } {
    this.s.push(v, len);
    if (!(len >= 1) || this.s.size < len) return { v: NaN, k: NaN };
    let best = NaN;
    let at = NaN;
    for (let k = 0; k < len; k++) {
      const x = this.s.ago(k);
      if (!(x === x)) continue;
      if (!(best === best) || (hi ? x > best : x < best)) {
        best = x;
        at = k;
      }
    }
    return { v: best, k: at };
  }
}

/** Value of the series `len` calls ago. */
class Lag {
  s = new Seq();
  next(v: number, len: number): number {
    this.s.push(v, len + 1);
    return this.s.ago(len);
  }
}

const trOf = (R: Runtime, handleNa: boolean): number => {
  const i = R.i;
  const h = R.h[i];
  const l = R.l[i];
  if (i === 0 || !(R.c[i - 1] === R.c[i - 1])) return handleNa ? h - l : NaN;
  const pc = R.c[i - 1];
  return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
};

const asNum = (v: unknown): number => (typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : NaN);
const src = (v: unknown, R: Runtime, fallback: Float64Array): number => (v === undefined ? fallback[R.i] : asNum(v));

/** A day changed between this bar and the one before (the default anchor of ta.vwap). */
export function newPeriod(R: Runtime, sec: number): boolean {
  const i = R.i;
  if (i === 0) return true;
  const ms = sec * 1000;
  if (sec === 604800) {
    // weeks start on Monday (1970-01-01 was a Thursday)
    const wk = (t: number) => Math.floor((t - 4 * 86400000) / ms);
    return wk(R.t[i]) !== wk(R.t[i - 1]);
  }
  return Math.floor(R.t[i] / ms) !== Math.floor(R.t[i - 1] / ms);
}

// ----------------------------------------------------------------------------- the library

export const TA: Lib = {
  "ta.sma": { p: ["source", "length"], st: () => new Sma(), f: (_R, a, st: Sma) => st.next(asNum(a[0]), toInt(a[1])) },
  "ta.ema": { p: ["source", "length"], st: () => new Ema(), f: (_R, a, st: Ema) => ema(st, asNum(a[0]), toInt(a[1])) },
  "ta.rma": { p: ["source", "length"], st: () => new Ema(), f: (_R, a, st: Ema) => rma(st, asNum(a[0]), toInt(a[1])) },
  "ta.wma": { p: ["source", "length"], st: () => new Wma(), f: (_R, a, st: Wma) => st.next(asNum(a[0]), toInt(a[1])) },
  "ta.vwma": {
    p: ["source", "length"],
    st: () => ({ pv: new Sma(), v: new Sma() }),
    f: (R, a, st: { pv: Sma; v: Sma }) => {
      const len = toInt(a[1]);
      const x = asNum(a[0]);
      const v = R.vol[R.i];
      return st.pv.next(x * v, len) / st.v.next(x === x ? v : NaN, len);
    },
  },
  "ta.swma": {
    p: ["source"],
    st: () => new Seq(),
    f: (_R, a, st: Seq) => {
      st.push(asNum(a[0]), 4);
      if (st.size < 4) return NaN;
      return st.ago(3) / 6 + (st.ago(2) * 2) / 6 + (st.ago(1) * 2) / 6 + st.ago(0) / 6;
    },
  },
  "ta.alma": {
    p: ["series", "length", "offset", "sigma", "floor"],
    st: () => new Window(),
    f: (_R, a, st: Window) => {
      const len = toInt(a[1]);
      st.push(asNum(a[0]), len);
      if (!st.full(len)) return NaN;
      const off = num(a[2], 0.85);
      const sigma = num(a[3], 6);
      const m = a[4] ? Math.floor(off * (len - 1)) : off * (len - 1);
      const s = len / sigma;
      let norm = 0;
      let sum = 0;
      const arr = st.a;
      for (let i = 0; i < len; i++) {
        const w = Math.exp(-((i - m) ** 2) / (2 * s * s));
        norm += w;
        sum += arr[arr.length - len + i] * w;
      }
      return sum / norm;
    },
  },
  "ta.hma": {
    p: ["source", "length"],
    st: () => ({ half: new Wma(), full: new Wma(), out: new Wma() }),
    f: (_R, a, st: { half: Wma; full: Wma; out: Wma }) => {
      const len = toInt(a[1]);
      const x = asNum(a[0]);
      const d = 2 * st.half.next(x, Math.trunc(len / 2)) - st.full.next(x, len);
      return st.out.next(d, Math.floor(Math.sqrt(len)));
    },
  },
  "ta.linreg": {
    p: ["source", "length", "offset"],
    st: () => new Window(),
    f: (_R, a, st: Window) => {
      const len = toInt(a[1]);
      st.push(asNum(a[0]), len);
      if (!st.full(len)) return NaN;
      const off = toInt(a[2] ?? 0);
      const arr = st.a;
      let sx = 0;
      let sy = 0;
      let sxy = 0;
      let sxx = 0;
      for (let i = 0; i < len; i++) {
        const y = arr[arr.length - len + i];
        sx += i;
        sy += y;
        sxy += i * y;
        sxx += i * i;
      }
      const slope = (len * sxy - sx * sy) / (len * sxx - sx * sx || 1);
      const intercept = (sy - slope * sx) / len;
      return intercept + slope * (len - 1 - off);
    },
  },
  "ta.rsi": {
    p: ["source", "length"],
    st: () => ({ prev: NaN, u: new Ema(), d: new Ema() }),
    f: (_R, a, st: { prev: number; u: Ema; d: Ema }) => {
      const x = asNum(a[0]);
      const len = toInt(a[1]);
      const ch = x - st.prev;
      st.prev = x;
      const u = rma(st.u, Math.max(ch, 0), len);
      const d = rma(st.d, Math.max(-ch, 0), len);
      if (!(u === u) || !(d === d)) return NaN;
      return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
    },
  },
  "ta.macd": {
    p: ["source", "fastlen", "slowlen", "siglen"],
    st: () => ({ f: new Ema(), s: new Ema(), g: new Ema() }),
    f: (_R, a, st: { f: Ema; s: Ema; g: Ema }) => {
      const x = asNum(a[0]);
      const m = ema(st.f, x, toInt(a[1])) - ema(st.s, x, toInt(a[2]));
      const sig = ema(st.g, m, toInt(a[3]));
      return new Tuple([m, sig, m - sig]);
    },
  },
  "ta.stoch": {
    p: ["source", "high", "low", "length"],
    st: () => ({ h: new Extreme(), l: new Extreme() }),
    f: (_R, a, st: { h: Extreme; l: Extreme }) => {
      const len = toInt(a[3]);
      const hh = st.h.next(asNum(a[1]), len, true).v;
      const ll = st.l.next(asNum(a[2]), len, false).v;
      const r = hh - ll;
      return r === 0 ? NaN : (100 * (asNum(a[0]) - ll)) / r;
    },
  },
  "ta.cci": {
    p: ["source", "length"],
    st: () => new Window(),
    f: (_R, a, st: Window) => {
      const len = toInt(a[1]);
      const x = asNum(a[0]);
      st.push(x, len);
      if (!st.full(len)) return NaN;
      const arr = st.a;
      let m = 0;
      for (let i = arr.length - len; i < arr.length; i++) m += arr[i];
      m /= len;
      let dev = 0;
      for (let i = arr.length - len; i < arr.length; i++) dev += Math.abs(arr[i] - m);
      dev /= len;
      return dev === 0 ? 0 : (x - m) / (0.015 * dev);
    },
  },
  "ta.mfi": {
    p: ["series", "length"],
    st: () => ({ prev: NaN, up: new Sma(), dn: new Sma() }),
    f: (R, a, st: { prev: number; up: Sma; dn: Sma }) => {
      const x = asNum(a[0]);
      const len = toInt(a[1]);
      const ch = x - st.prev;
      st.prev = x;
      const v = R.vol[R.i];
      const upper = st.up.total(v * (ch <= 0 ? 0 : x), len);
      const lower = st.dn.total(v * (ch >= 0 ? 0 : x), len);
      return 100 - 100 / (1 + upper / lower);
    },
  },
  "ta.tr": { p: ["handle_na"], f: (R, a) => trOf(R, !!a[0]) },
  "ta.atr": { p: ["length"], st: () => new Ema(), f: (R, a, st: Ema) => rma(st, trOf(R, true), toInt(a[0])) },
  "ta.bb": {
    p: ["series", "length", "mult"],
    st: () => ({ m: new Sma(), d: new Stdev() }),
    f: (_R, a, st: { m: Sma; d: Stdev }) => {
      const x = asNum(a[0]);
      const len = toInt(a[1]);
      const basis = st.m.next(x, len);
      const dev = num(a[2]) * st.d.next(x, len, true);
      return new Tuple([basis, basis + dev, basis - dev]);
    },
  },
  "ta.bbw": {
    p: ["series", "length", "mult"],
    st: () => ({ m: new Sma(), d: new Stdev() }),
    f: (_R, a, st: { m: Sma; d: Stdev }) => {
      const x = asNum(a[0]);
      const len = toInt(a[1]);
      const basis = st.m.next(x, len);
      const dev = num(a[2]) * st.d.next(x, len, true);
      return ((basis + dev - (basis - dev)) / basis) * 100;
    },
  },
  "ta.kc": {
    p: ["series", "length", "mult", "useTrueRange"],
    st: () => ({ b: new Ema(), r: new Ema() }),
    f: (R, a, st: { b: Ema; r: Ema }) => {
      const len = toInt(a[1]);
      const basis = ema(st.b, asNum(a[0]), len);
      const range = a[3] === false ? R.h[R.i] - R.l[R.i] : trOf(R, false);
      const re = ema(st.r, range, len);
      const m = num(a[2]);
      return new Tuple([basis, basis + re * m, basis - re * m]);
    },
  },
  "ta.kcw": {
    p: ["series", "length", "mult", "useTrueRange"],
    st: () => ({ b: new Ema(), r: new Ema() }),
    f: (R, a, st: { b: Ema; r: Ema }) => {
      const len = toInt(a[1]);
      const basis = ema(st.b, asNum(a[0]), len);
      const range = a[3] === false ? R.h[R.i] - R.l[R.i] : trOf(R, false);
      const re = ema(st.r, range, len) * num(a[2]);
      return (2 * re) / basis;
    },
  },
  "ta.stdev": { p: ["source", "length", "biased"], st: () => new Stdev(), f: (_R, a, st: Stdev) => st.next(asNum(a[0]), toInt(a[1]), a[2] !== false) },
  "ta.variance": { p: ["source", "length", "biased"], st: () => new Stdev(), f: (_R, a, st: Stdev) => st.next(asNum(a[0]), toInt(a[1]), a[2] !== false, true) },
  "ta.dev": {
    p: ["source", "length"],
    st: () => new Window(),
    f: (_R, a, st: Window) => {
      const len = toInt(a[1]);
      st.push(asNum(a[0]), len);
      if (!st.full(len)) return NaN;
      const arr = st.a;
      let m = 0;
      for (let i = arr.length - len; i < arr.length; i++) m += arr[i];
      m /= len;
      let s = 0;
      for (let i = arr.length - len; i < arr.length; i++) s += Math.abs(dz(arr[i] - m));
      return s / len;
    },
  },
  "ta.highest": {
    p: ["source", "length"],
    st: () => new Extreme(),
    f: (R, a, st: Extreme) => (a[1] === undefined ? st.next(R.h[R.i], toInt(a[0]), true).v : st.next(asNum(a[0]), toInt(a[1]), true).v),
  },
  "ta.lowest": {
    p: ["source", "length"],
    st: () => new Extreme(),
    f: (R, a, st: Extreme) => (a[1] === undefined ? st.next(R.l[R.i], toInt(a[0]), false).v : st.next(asNum(a[0]), toInt(a[1]), false).v),
  },
  "ta.highestbars": {
    p: ["source", "length"],
    st: () => new Extreme(),
    f: (R, a, st: Extreme) => -(a[1] === undefined ? st.next(R.h[R.i], toInt(a[0]), true).k : st.next(asNum(a[0]), toInt(a[1]), true).k),
  },
  "ta.lowestbars": {
    p: ["source", "length"],
    st: () => new Extreme(),
    f: (R, a, st: Extreme) => -(a[1] === undefined ? st.next(R.l[R.i], toInt(a[0]), false).k : st.next(asNum(a[0]), toInt(a[1]), false).k),
  },
  "ta.range": {
    p: ["source", "length"],
    st: () => ({ h: new Extreme(), l: new Extreme() }),
    f: (_R, a, st: { h: Extreme; l: Extreme }) => {
      const len = toInt(a[1]);
      const x = asNum(a[0]);
      return st.h.next(x, len, true).v - st.l.next(x, len, false).v;
    },
  },
  "ta.change": {
    p: ["source", "length"],
    st: () => new Lag(),
    f: (_R, a, st: Lag) => {
      const len = a[1] === undefined ? 1 : toInt(a[1]);
      if (typeof a[0] === "boolean") {
        const prev = st.next(a[0] ? 1 : 0, len);
        return prev === prev ? (a[0] ? 1 : 0) !== prev : false;
      }
      const x = asNum(a[0]);
      return x - st.next(x, len);
    },
  },
  "ta.mom": {
    p: ["source", "length"],
    st: () => new Lag(),
    f: (_R, a, st: Lag) => {
      const x = asNum(a[0]);
      return x - st.next(x, toInt(a[1]));
    },
  },
  "ta.roc": {
    p: ["source", "length"],
    st: () => new Lag(),
    f: (_R, a, st: Lag) => {
      const x = asNum(a[0]);
      const p = st.next(x, toInt(a[1]));
      return (100 * (x - p)) / p;
    },
  },
  "ta.crossover": { p: ["source1", "source2"], st: () => ({ a: NaN, b: NaN }), f: (_R, a, st: { a: number; b: number }) => cross(st, asNum(a[0]), asNum(a[1]), 1) },
  "ta.crossunder": { p: ["source1", "source2"], st: () => ({ a: NaN, b: NaN }), f: (_R, a, st: { a: number; b: number }) => cross(st, asNum(a[0]), asNum(a[1]), -1) },
  "ta.cross": { p: ["source1", "source2"], st: () => ({ a: NaN, b: NaN }), f: (_R, a, st: { a: number; b: number }) => cross(st, asNum(a[0]), asNum(a[1]), 0) },
  "ta.rising": {
    p: ["source", "length"],
    st: () => new Seq(),
    f: (_R, a, st: Seq) => {
      const len = toInt(a[1]);
      const x = asNum(a[0]);
      st.push(x, len + 1);
      if (!(len >= 1) || st.size <= len) return false;
      for (let k = 1; k <= len; k++) if (!(x > st.ago(k))) return false;
      return true;
    },
  },
  "ta.falling": {
    p: ["source", "length"],
    st: () => new Seq(),
    f: (_R, a, st: Seq) => {
      const len = toInt(a[1]);
      const x = asNum(a[0]);
      st.push(x, len + 1);
      if (!(len >= 1) || st.size <= len) return false;
      for (let k = 1; k <= len; k++) if (!(x < st.ago(k))) return false;
      return true;
    },
  },
  "ta.pivothigh": { p: ["source", "leftbars", "rightbars"], st: () => new Seq(), f: (R, a, st: Seq) => pivot(R, a, st, true) },
  "ta.pivotlow": { p: ["source", "leftbars", "rightbars"], st: () => new Seq(), f: (R, a, st: Seq) => pivot(R, a, st, false) },
  "ta.valuewhen": {
    p: ["condition", "source", "occurrence"],
    st: () => [] as unknown[],
    f: (_R, a, st: unknown[]) => {
      if (a[0] && a[0] === a[0]) {
        st.push(a[1]);
        if (st.length > 6000) st.splice(0, 3000);
      }
      const k = toInt(a[2] ?? 0);
      const j = st.length - 1 - k;
      return j >= 0 ? st[j] : NaN;
    },
  },
  "ta.barssince": {
    p: ["condition"],
    st: () => ({ n: -1, last: -1 }),
    f: (_R, a, st: { n: number; last: number }) => {
      st.n++;
      if (a[0] && a[0] === a[0]) st.last = st.n;
      return st.last >= 0 ? st.n - st.last : NaN;
    },
  },
  "ta.cum": {
    p: ["source"],
    st: () => ({ s: 0 }),
    f: (_R, a, st: { s: number }) => {
      const x = asNum(a[0]);
      if (x === x) st.s += x;
      return st.s;
    },
  },
  "ta.median": {
    p: ["source", "length"],
    st: () => new Window(),
    f: (_R, a, st: Window) => {
      const len = toInt(a[1]);
      st.push(asNum(a[0]), len);
      if (!st.full(len)) return NaN;
      const s = st.a.slice(-len).sort((x, y) => x - y);
      return len % 2 ? s[(len - 1) / 2] : (s[len / 2 - 1] + s[len / 2]) / 2;
    },
  },
  "ta.mode": {
    p: ["source", "length"],
    st: () => new Window(),
    f: (_R, a, st: Window) => {
      const len = toInt(a[1]);
      st.push(asNum(a[0]), len);
      if (!st.full(len)) return NaN;
      return modeOf(st.a.slice(-len));
    },
  },
  "ta.percentrank": {
    p: ["source", "length"],
    st: () => new Seq(),
    f: (_R, a, st: Seq) => {
      const len = toInt(a[1]);
      const x = asNum(a[0]);
      st.push(x, len + 1);
      if (!(len >= 1) || st.size <= len || !(x === x)) return NaN;
      let c = 0;
      for (let k = 1; k <= len; k++) if (st.ago(k) <= x) c++;
      return (100 * c) / len;
    },
  },
  "ta.percentile_linear_interpolation": {
    p: ["source", "length", "percentage"],
    st: () => new Window(),
    f: (_R, a, st: Window) => {
      const len = toInt(a[1]);
      st.push(asNum(a[0]), len);
      if (!st.full(len)) return NaN;
      return percentileLinear(st.a.slice(-len), num(a[2]));
    },
  },
  "ta.percentile_nearest_rank": {
    p: ["source", "length", "percentage"],
    st: () => new Window(),
    f: (_R, a, st: Window) => {
      const len = toInt(a[1]);
      st.push(asNum(a[0]), len);
      if (!st.full(len)) return NaN;
      return percentileNearest(st.a.slice(-len), num(a[2]));
    },
  },
  "ta.correlation": {
    p: ["source1", "source2", "length"],
    st: () => ({ x: new Seq(), y: new Seq() }),
    f: (_R, a, st: { x: Seq; y: Seq }) => {
      const len = toInt(a[2]);
      st.x.push(asNum(a[0]), len);
      st.y.push(asNum(a[1]), len);
      if (!(len >= 2) || st.x.size < len) return NaN;
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      for (let k = 0; k < len; k++) {
        const x = st.x.ago(k);
        const y = st.y.ago(k);
        if (!(x === x) || !(y === y)) return NaN;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
      }
      const cov = sxy / len - (sx / len) * (sy / len);
      const vx = sxx / len - (sx / len) ** 2;
      const vy = syy / len - (sy / len) ** 2;
      return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : NaN;
    },
  },
  "ta.cmo": {
    p: ["series", "length"],
    st: () => ({ prev: NaN, u: new Sma(), d: new Sma() }),
    f: (_R, a, st: { prev: number; u: Sma; d: Sma }) => {
      const x = asNum(a[0]);
      const len = toInt(a[1]);
      const m = x - st.prev;
      st.prev = x;
      const s1 = st.u.total(m >= 0 ? m : m === m ? 0 : NaN, len);
      const s2 = st.d.total(m >= 0 ? 0 : m === m ? -m : NaN, len);
      return (100 * (s1 - s2)) / (s1 + s2);
    },
  },
  "ta.cog": {
    p: ["source", "length"],
    st: () => new Seq(),
    f: (_R, a, st: Seq) => {
      const len = toInt(a[1]);
      st.push(asNum(a[0]), len);
      if (!(len >= 1) || st.size < len) return NaN;
      let num1 = 0;
      let den = 0;
      for (let k = 0; k < len; k++) {
        const x = st.ago(k);
        num1 += x * (k + 1);
        den += x;
      }
      return -num1 / den;
    },
  },
  "ta.tsi": {
    p: ["source", "short_length", "long_length"],
    st: () => ({ prev: NaN, a1: new Ema(), a2: new Ema(), b1: new Ema(), b2: new Ema() }),
    f: (_R, a, st: { prev: number; a1: Ema; a2: Ema; b1: Ema; b2: Ema }) => {
      const x = asNum(a[0]);
      const pc = x - st.prev;
      st.prev = x;
      const s = toInt(a[1]);
      const l = toInt(a[2]);
      const d = ema(st.a2, ema(st.a1, pc, l), s);
      const ad = ema(st.b2, ema(st.b1, Math.abs(pc), l), s);
      return d / ad;
    },
  },
  "ta.wpr": {
    p: ["length"],
    st: () => ({ h: new Extreme(), l: new Extreme() }),
    f: (R, a, st: { h: Extreme; l: Extreme }) => {
      const len = toInt(a[0]);
      const hh = st.h.next(R.h[R.i], len, true).v;
      const ll = st.l.next(R.l[R.i], len, false).v;
      return (100 * (R.c[R.i] - hh)) / (hh - ll);
    },
  },
  "ta.dmi": {
    p: ["diLength", "adxSmoothing"],
    st: () => ({ tr: new Ema(), p: new Ema(), m: new Ema(), adx: new Ema(), lastP: NaN, lastM: NaN }),
    f: (R, a, st: { tr: Ema; p: Ema; m: Ema; adx: Ema; lastP: number; lastM: number }) => {
      const len = toInt(a[0]);
      const i = R.i;
      const up = i > 0 ? R.h[i] - R.h[i - 1] : NaN;
      const down = i > 0 ? -(R.l[i] - R.l[i - 1]) : NaN;
      const plusDM = up === up ? (up > down && up > 0 ? up : 0) : NaN;
      const minusDM = down === down ? (down > up && down > 0 ? down : 0) : NaN;
      const trur = rma(st.tr, trOf(R, false), len);
      let plus = (100 * rma(st.p, plusDM, len)) / trur;
      let minus = (100 * rma(st.m, minusDM, len)) / trur;
      if (plus === plus) st.lastP = plus;
      else plus = st.lastP;
      if (minus === minus) st.lastM = minus;
      else minus = st.lastM;
      const sum = plus + minus;
      const adx = 100 * rma(st.adx, Math.abs(plus - minus) / (sum === 0 ? 1 : sum), toInt(a[1]));
      return new Tuple([plus, minus, adx]);
    },
  },
  "ta.sar": {
    p: ["start", "inc", "max"],
    st: () => ({ n: -1, result: NaN, maxMin: NaN, acc: NaN, below: false }),
    f: (R, a, st: { n: number; result: number; maxMin: number; acc: number; below: boolean }) => sar(R, a, st),
  },
  "ta.supertrend": {
    p: ["factor", "atrPeriod"],
    st: () => ({ atr: new Ema(), atrPrev: NaN, lower: NaN, upper: NaN, st: NaN }),
    f: (R, a, st: { atr: Ema; atrPrev: number; lower: number; upper: number; st: number }) => {
      const i = R.i;
      const factor = num(a[0]);
      const atr = rma(st.atr, trOf(R, true), toInt(a[1]));
      const hl2 = (R.h[i] + R.l[i]) / 2;
      let upper = hl2 + factor * atr;
      let lower = hl2 - factor * atr;
      const pl = st.lower === st.lower ? st.lower : 0;
      const pu = st.upper === st.upper ? st.upper : 0;
      const pc = i > 0 ? R.c[i - 1] : NaN;
      lower = lower > pl || pc < pl ? lower : pl;
      upper = upper < pu || pc > pu ? upper : pu;
      let dir: number;
      if (!(st.atrPrev === st.atrPrev)) dir = 1;
      else if (st.st === pu) dir = R.c[i] > upper ? -1 : 1;
      else dir = R.c[i] < lower ? 1 : -1;
      const value = dir === -1 ? lower : upper;
      st.lower = lower;
      st.upper = upper;
      st.st = value;
      st.atrPrev = atr;
      return new Tuple([value, dir]);
    },
  },
  "ta.vwap": {
    p: ["source", "anchor", "stdev_mult"],
    st: () => ({ pv: 0, v: 0, p2v: 0, started: false }),
    f: (R, a, st: { pv: number; v: number; p2v: number; started: boolean }) => {
      const x = src(a[0], R, R.c);
      const reset = a[1] === undefined ? newPeriod(R, 86400) : !!a[1] && a[1] === a[1];
      if (reset || !st.started) {
        st.pv = 0;
        st.v = 0;
        st.p2v = 0;
        st.started = true;
      }
      const vol = R.vol[R.i];
      if (x === x && vol === vol) {
        st.pv += x * vol;
        st.v += vol;
        st.p2v += x * x * vol;
      }
      const vw = st.pv / st.v;
      if (a[2] === undefined) return vw;
      const sd = Math.sqrt(Math.max(0, st.p2v / st.v - vw * vw)) * num(a[2]);
      return new Tuple([vw, vw + sd, vw - sd]);
    },
  },
  "ta.max": {
    p: ["source"],
    st: () => ({ m: NaN }),
    f: (_R, a, st: { m: number }) => {
      const x = asNum(a[0]);
      if (x === x && !(x <= st.m)) st.m = x;
      return st.m;
    },
  },
  "ta.min": {
    p: ["source"],
    st: () => ({ m: NaN }),
    f: (_R, a, st: { m: number }) => {
      const x = asNum(a[0]);
      if (x === x && !(x >= st.m)) st.m = x;
      return st.m;
    },
  },
  "math.sum": { p: ["source", "length"], st: () => new Sma(), f: (_R, a, st: Sma) => st.total(asNum(a[0]), toInt(a[1])) },
};

function cross(st: { a: number; b: number }, x: number, y: number, dir: number): boolean {
  const pa = st.a;
  const pb = st.b;
  st.a = x;
  st.b = y;
  const over = x > y && pa <= pb;
  const under = x < y && pa >= pb;
  return dir > 0 ? over : dir < 0 ? under : over || under;
}

function pivot(R: Runtime, a: unknown[], st: Seq, high: boolean): number {
  // (source, left, right) or (left, right) on high / low
  let x: number;
  let left: number;
  let right: number;
  if (a[2] === undefined) {
    x = high ? R.h[R.i] : R.l[R.i];
    left = toInt(a[0]);
    right = toInt(a[1]);
  } else {
    x = asNum(a[0]);
    left = toInt(a[1]);
    right = toInt(a[2]);
  }
  st.push(x, left + right + 1);
  if (!(left >= 0) || !(right >= 0) || st.size < left + right + 1) return NaN;
  const v = st.ago(right);
  if (!(v === v)) return NaN;
  for (let k = 1; k <= left; k++) {
    const y = st.ago(right + k);
    if (!(high ? v > y : v < y)) return NaN;
  }
  for (let k = 1; k <= right; k++) {
    const y = st.ago(right - k);
    if (!(high ? v >= y : v <= y)) return NaN;
  }
  return v;
}

function sar(R: Runtime, a: unknown[], st: { n: number; result: number; maxMin: number; acc: number; below: boolean }): number {
  const start = num(a[0]);
  const inc = num(a[1]);
  const max = num(a[2]);
  const i = R.i;
  st.n++;
  if (st.n === 0) return NaN;
  const h = R.h[i];
  const l = R.l[i];
  let first = false;
  if (st.n === 1) {
    if (R.c[i] > R.c[i - 1]) {
      st.below = true;
      st.maxMin = h;
      st.result = R.l[i - 1];
    } else {
      st.below = false;
      st.maxMin = l;
      st.result = R.h[i - 1];
    }
    first = true;
    st.acc = start;
  }
  st.result = st.result + st.acc * (st.maxMin - st.result);
  if (st.below) {
    if (st.result > l) {
      first = true;
      st.below = false;
      st.result = Math.max(h, st.maxMin);
      st.maxMin = l;
      st.acc = start;
    }
  } else if (st.result < h) {
    first = true;
    st.below = true;
    st.result = Math.min(l, st.maxMin);
    st.maxMin = h;
    st.acc = start;
  }
  if (!first) {
    if (st.below) {
      if (h > st.maxMin) {
        st.maxMin = h;
        st.acc = Math.min(st.acc + inc, max);
      }
    } else if (l < st.maxMin) {
      st.maxMin = l;
      st.acc = Math.min(st.acc + inc, max);
    }
  }
  if (st.below) {
    st.result = Math.min(st.result, R.l[i - 1]);
    if (st.n > 1) st.result = Math.min(st.result, R.l[i - 2]);
  } else {
    st.result = Math.max(st.result, R.h[i - 1]);
    if (st.n > 1) st.result = Math.max(st.result, R.h[i - 2]);
  }
  return st.result;
}

export function modeOf(v: number[]): number {
  const counts = new Map<number, number>();
  let best = NaN;
  let bc = 0;
  for (const x of v) {
    if (!(x === x)) continue;
    const c = (counts.get(x) ?? 0) + 1;
    counts.set(x, c);
    if (c > bc || (c === bc && x < best)) {
      bc = c;
      best = x;
    }
  }
  return best;
}
export function percentileLinear(v: number[], p: number): number {
  const s = v.filter((x) => x === x).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const pos = (p / 100) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
export function percentileNearest(v: number[], p: number): number {
  const s = v.filter((x) => x === x).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[Math.min(s.length, rank) - 1];
}

// ----------------------------------------------------------------------------- series variables (whole run)

/** ta.obv, ta.accdist, ta.pvt, ta.vwap, ta.tr, ta.nvi, ta.pvi, ta.wad, ta.iii, ta.wvad: computed for every bar
 *  once, when first read. */
export function taSeries(R: Runtime, name: string): number {
  if (name === "ta.tr") return trOf(R, false);
  let arr = R.cache.get(name);
  if (!arr) {
    arr = computeSeries(R, name);
    R.cache.set(name, arr);
  }
  return arr[R.i];
}

function computeSeries(R: Runtime, name: string): Float64Array {
  const n = R.n;
  const out = new Float64Array(n);
  const { o, h, l, c, vol } = R;
  let acc = 0;
  switch (name) {
    case "ta.obv":
      for (let i = 0; i < n; i++) {
        if (i > 0) acc += Math.sign(c[i] - c[i - 1]) * vol[i];
        out[i] = acc;
      }
      break;
    case "ta.accdist":
      for (let i = 0; i < n; i++) {
        const r = h[i] - l[i];
        acc += r === 0 ? 0 : (((c[i] - l[i]) - (h[i] - c[i])) / r) * vol[i];
        out[i] = acc;
      }
      break;
    case "ta.pvt":
      for (let i = 0; i < n; i++) {
        if (i > 0 && c[i - 1]) acc += ((c[i] - c[i - 1]) / c[i - 1]) * vol[i];
        out[i] = acc;
      }
      break;
    case "ta.iii":
      for (let i = 0; i < n; i++) {
        const r = (h[i] - l[i]) * vol[i];
        out[i] = r === 0 ? NaN : (2 * c[i] - h[i] - l[i]) / r;
      }
      break;
    case "ta.wvad":
      for (let i = 0; i < n; i++) {
        const r = h[i] - l[i];
        out[i] = r === 0 ? 0 : ((c[i] - o[i]) / r) * vol[i];
      }
      break;
    case "ta.wad":
      for (let i = 0; i < n; i++) {
        if (i > 0) {
          const pc = c[i - 1];
          const trh = Math.max(h[i], pc);
          const trl = Math.min(l[i], pc);
          acc += c[i] > pc ? c[i] - trl : c[i] < pc ? c[i] - trh : 0;
        }
        out[i] = acc;
      }
      break;
    case "ta.nvi":
    case "ta.pvi": {
      let v = 1;
      for (let i = 0; i < n; i++) {
        if (i > 0 && c[i - 1]) {
          const neg = name === "ta.nvi";
          if (neg ? vol[i] < vol[i - 1] : vol[i] > vol[i - 1]) v += ((c[i] - c[i - 1]) / c[i - 1]) * v;
        }
        out[i] = v;
      }
      break;
    }
    case "ta.vwap": {
      let pv = 0;
      let vv = 0;
      const saveI = R.i;
      for (let i = 0; i < n; i++) {
        R.i = i;
        if (newPeriod(R, 86400)) {
          pv = 0;
          vv = 0;
        }
        const x = (h[i] + l[i] + c[i]) / 3;
        pv += x * vol[i];
        vv += vol[i];
        out[i] = pv / vv;
      }
      R.i = saveI;
      break;
    }
    default:
      out.fill(NaN);
  }
  return out;
}

