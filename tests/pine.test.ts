// Pine Script: parsing, the interpreter's series rules, ta.* values against plain reference code, request.security
// alignment and the strategy emulator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load, runWithSecurity, type Bar, type RunResult } from "../src/pine/index.ts";
import { parse } from "../src/pine/parser.ts";
import { decimalFormat, strFormat } from "../src/pine/lib/core.ts";
import { Runtime } from "../src/pine/runtime.ts";

function bars(closes: number[], sec = 900, extra: (i: number) => Partial<Bar> = () => ({})): Bar[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { time: 1700006400 + i * sec, open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c, volume: 10 + i, confirmed: true, ...extra(i) };
  });
}
const wave = (n: number) => Array.from({ length: n }, (_, i) => 100 + 10 * Math.sin(i / 5) + i * 0.1);

function run(src: string, b: Bar[], inputs: Record<string, unknown> = {}): RunResult {
  const l = load(src);
  if (!l.ok) throw new Error(`line ${l.error.line}: ${l.error.message}`);
  const r = l.program.run({ bars: b, sec: b.length > 1 ? b[1].time - b[0].time : 900, instId: "BTC-USDT-SWAP", mintick: 0.01 }, { inputs });
  if (r.error) throw new Error(`line ${r.error.line}: ${r.error.message}`);
  return r;
}
/** Values of the plot titled `t`. */
const plotOf = (r: RunResult, t: string) => Array.from(r.out.plots.find((p) => p.title === t)!.values);
const close = (a: number, b: number, eps = 1e-9) => (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
function sameSeries(a: number[], b: number[], eps = 1e-9) {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(close(a[i], b[i], eps), `bar ${i}: ${a[i]} vs ${b[i]}`);
}

// ----------------------------------------------------------------------------- parsing

test("parse: blocks by indentation, continued lines, functions, switch and tuples", () => {
  const s = parse(`//@version=5
indicator("x")
f(a, b = 2) =>
    c = a + b
    c * 2
g(x) => x + 1
long = close > open and
     volume > 0
v = switch
    long => 1
    => -1
[m, s, h] = ta.macd(close, 12, 26, 9)
plot(f(1),
  "t")
if long
    x = 1
else if not long
    x = 2
else
    x = 3
`);
  assert.equal(s.version, 5);
  assert.deepEqual(s.body.map((x) => x.k), ["expr", "fn", "fn", "decl", "decl", "tupledecl", "expr", "expr"]);
});

test("parse: errors point at the line", () => {
  assert.throws(() => parse("x = (1 + \ny = 2"), (e: Error & { line?: number }) => typeof e.line === "number");
  const l = load(`//@version=5\nindicator("x")\nplot(foo)\n`);
  assert.equal(l.ok, false);
  if (!l.ok) {
    assert.equal(l.error.line, 3);
    assert.match(l.error.message, /foo/);
  }
  const u = load(`//@version=5\nindicator("x")\nplot(ta.nonsense(close))\n`);
  assert.equal(u.ok, false);
});

test("parse: generics, typed declarations, methods and user types", () => {
  const r = run(
    `//@version=5
indicator("t")
type P
    float price
    int n = 3
method twice(P this) => this.price * 2
var array<P> ps = array.new<P>()
var map<string, float> m = map.new<string, float>()
int[] ints = array.from(1, 2, 3)
ps.push(P.new(close))
m.put("last", close)
p = ps.last()
plot(p.twice(), "twice")
plot(p.n, "n")
plot(m.get("last"), "map")
plot(ints.sum(), "sum")
plot(ps.size(), "size")`,
    bars([1, 2, 3]),
  );
  assert.deepEqual(plotOf(r, "twice"), [2, 4, 6]);
  assert.deepEqual(plotOf(r, "n"), [3, 3, 3]);
  assert.deepEqual(plotOf(r, "map"), [1, 2, 3]);
  assert.deepEqual(plotOf(r, "sum"), [6, 6, 6]);
  assert.deepEqual(plotOf(r, "size"), [1, 2, 3]);
});

// ----------------------------------------------------------------------------- series rules

test("var keeps its value, plain variables start again each bar, x[1] is the last bar's", () => {
  const r = run(
    `//@version=5
indicator("t")
var a = 0
a += 1
b = 0
b += 1
c = close[1]
d = a[2]
plot(a, "a")
plot(b, "b")
plot(c, "c")
plot(d, "d")`,
    bars([10, 20, 30, 40]),
  );
  assert.deepEqual(plotOf(r, "a"), [1, 2, 3, 4]);
  assert.deepEqual(plotOf(r, "b"), [1, 1, 1, 1]);
  assert.deepEqual(plotOf(r, "c"), [NaN, 10, 20, 30]);
  assert.deepEqual(plotOf(r, "d"), [NaN, NaN, 1, 2]);
});

test("each call of a function keeps its own state; a function called on some bars only sees those bars", () => {
  const r = run(
    `//@version=5
indicator("t")
count() =>
    var n = 0
    n += 1
    n
prev(x) => x[1]
a = count()
b = count()
c = bar_index % 2 == 0 ? count() : na
plot(a, "a")
plot(b, "b")
plot(c, "c")
plot(prev(close), "prev")
e = bar_index % 2 == 0 ? prev(close) : na
plot(e, "e")`,
    bars([1, 2, 3, 4, 5, 6]),
  );
  assert.deepEqual(plotOf(r, "a"), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(plotOf(r, "b"), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(plotOf(r, "c"), [1, NaN, 2, NaN, 3, NaN]);
  assert.deepEqual(plotOf(r, "prev"), [NaN, 1, 2, 3, 4, 5]);
  // called on even bars only: its x[1] is the value of the call before (two bars back)
  assert.deepEqual(plotOf(r, "e"), [NaN, NaN, 1, NaN, 3, NaN]);
});

test("loops, break and continue, while, for…in, switch, ternaries and na", () => {
  const r = run(
    `//@version=5
indicator("t")
s = 0
for i = 0 to 10
    if i == 3
        continue
    if i == 6
        break
    s += i
down = 0
for i = 3 to 1
    down := down * 10 + i
w = 0
while w < 5
    w += 2
arr = array.from(5, 6, 7)
t = 0
for [k, v] in arr
    t += k * v
x = switch close
    1 => "one"
    2 => "two"
    => "many"
plot(s, "s")
plot(down, "down")
plot(w, "w")
plot(t, "t")
plot(x == "two" ? 1 : 0, "x")
plot(nz(close[5], -1), "nz")
plot(na(close[5]) ? 1 : 0, "na")`,
    bars([1, 2]),
  );
  assert.deepEqual(plotOf(r, "s"), [0 + 1 + 2 + 4 + 5, 12]);
  assert.deepEqual(plotOf(r, "down"), [321, 321]);
  assert.deepEqual(plotOf(r, "w"), [6, 6]);
  assert.deepEqual(plotOf(r, "t"), [0 * 5 + 1 * 6 + 2 * 7, 20]);
  assert.deepEqual(plotOf(r, "x"), [0, 1]);
  assert.deepEqual(plotOf(r, "nz"), [-1, -1]);
  assert.deepEqual(plotOf(r, "na"), [1, 1]);
});

test("v5 divides whole constants as whole numbers, v6 never does; v6 and/or stop early", () => {
  const v5 = run(`//@version=5\nindicator("t")\nplot(7 / 2, "a")\nlen = 7\nplot(len / 2, "b")\nplot(close / 2, "c")`, bars([3]));
  assert.deepEqual([plotOf(v5, "a")[0], plotOf(v5, "b")[0], plotOf(v5, "c")[0]], [3, 3, 1.5]);
  const v6 = run(`//@version=6\nindicator("t")\nplot(7 / 2, "a")`, bars([3]));
  assert.equal(plotOf(v6, "a")[0], 3.5);
  // v6: the right side isn't run when the left decides; v5 runs both
  const lazy = (v: number) =>
    plotOf(run(`//@version=${v}\nindicator("t")\nvar a = array.new_float()\nf() =>\n    array.push(a, 1)\n    true\nx = false and f()\nplot(array.size(a), "n")`, bars([1, 1, 1])), "n");
  assert.deepEqual(lazy(6), [0, 0, 0]);
  assert.deepEqual(lazy(5), [1, 2, 3]);
});

test("strings, colors and formatting", () => {
  assert.equal(decimalFormat(1234.5678, "#.##"), "1234.57");
  assert.equal(decimalFormat(0.5, "0.000"), "0.500");
  assert.equal(decimalFormat(1234567.891, "#,##0.0"), "1,234,567.9");
  assert.equal(decimalFormat(0.256, "#.#%"), "25.6%");
  const R = new Runtime();
  assert.equal(strFormat(R, "{0} / {1,number,#.##} / {2}", ["a", 3.14159, 1234.5]), "a / 3.14 / 1,234.5");
  const r = run(
    `//@version=5
indicator("t")
c = color.new(color.red, 50)
s = str.tostring(close, "#.00") + "|" + str.upper("ab") + "|" + str.replace_all("a-b-c", "-", "+")
var string kept = ""
if barstate.islast
    kept := s
plot(color.t(c), "t")
plot(str.length(kept), "len")
plot(str.contains(kept, "AB") ? 1 : 0, "has")
plot(str.tonumber("2.5"), "num")`,
    bars([1.5]),
  );
  assert.equal(plotOf(r, "t")[0], 50);
  assert.equal(plotOf(r, "len")[0], "1.50|AB|a+b+c".length);
  assert.equal(plotOf(r, "has")[0], 1);
  assert.equal(plotOf(r, "num")[0], 2.5);
});

// ----------------------------------------------------------------------------- ta.* against reference code

function refSma(x: number[], n: number) {
  return x.map((_, i) => (i < n - 1 ? NaN : x.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n));
}
function refEma(x: number[], n: number, alpha = 2 / (n + 1)) {
  const out: number[] = [];
  let prev = NaN;
  x.forEach((v, i) => {
    if (Number.isNaN(prev)) prev = i >= n - 1 ? x.slice(i - n + 1, i + 1).reduce((s, y) => s + y, 0) / n : NaN;
    else prev = alpha * v + (1 - alpha) * prev;
    out.push(prev);
  });
  return out;
}

test("ta.sma, ema, rma, wma, stdev match reference code", () => {
  const c = wave(120);
  const r = run(
    `//@version=5
indicator("t")
plot(ta.sma(close, 10), "sma")
plot(ta.ema(close, 10), "ema")
plot(ta.rma(close, 14), "rma")
plot(ta.wma(close, 5), "wma")
plot(ta.stdev(close, 20), "stdev")
plot(ta.highest(close, 7), "hh")
plot(ta.lowest(7), "ll")`,
    bars(c),
  );
  sameSeries(plotOf(r, "sma"), refSma(c, 10));
  sameSeries(plotOf(r, "ema"), refEma(c, 10));
  sameSeries(plotOf(r, "rma"), refEma(c, 14, 1 / 14));
  const wma = c.map((_, i) => (i < 4 ? NaN : [0, 1, 2, 3, 4].reduce((s, k) => s + c[i - k] * (5 - k), 0) / 15));
  sameSeries(plotOf(r, "wma"), wma);
  const sd = c.map((_, i) => {
    if (i < 19) return NaN;
    const w = c.slice(i - 19, i + 1);
    const m = w.reduce((s, v) => s + v, 0) / 20;
    return Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / 20);
  });
  sameSeries(plotOf(r, "stdev"), sd, 1e-7);
  sameSeries(plotOf(r, "hh"), c.map((_, i) => (i < 6 ? NaN : Math.max(...c.slice(i - 6, i + 1)))));
  const lows = bars(c).map((b) => b.low);
  sameSeries(plotOf(r, "ll"), lows.map((_, i) => (i < 6 ? NaN : Math.min(...lows.slice(i - 6, i + 1)))));
});

test("ta.rsi, atr, crossover, barssince, valuewhen, pivots", () => {
  const c = wave(80);
  const b = bars(c);
  const r = run(
    `//@version=5
indicator("t")
plot(ta.rsi(close, 14), "rsi")
plot(ta.atr(5), "atr")
x = ta.crossover(close, ta.sma(close, 5))
plot(x ? 1 : 0, "x")
plot(ta.barssince(x), "since")
plot(ta.valuewhen(x, close, 0), "when")
plot(ta.pivothigh(close, 3, 3), "ph")`,
    b,
  );
  // RSI from Wilder's averages of gains and losses (first value on bar 14)
  const ch = c.map((v, i) => (i ? v - c[i - 1] : NaN));
  const up = refEma(ch.slice(1).map((v) => Math.max(v, 0)), 14, 1 / 14);
  const dn = refEma(ch.slice(1).map((v) => Math.max(-v, 0)), 14, 1 / 14);
  const rsi = [NaN, ...up.map((u, i) => (dn[i] === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / dn[i])))];
  sameSeries(plotOf(r, "rsi"), rsi, 1e-9);
  const tr = b.map((x, i) => (i ? Math.max(x.high - x.low, Math.abs(x.high - b[i - 1].close), Math.abs(x.low - b[i - 1].close)) : x.high - x.low));
  sameSeries(plotOf(r, "atr"), refEma(tr, 5, 1 / 5));
  const sma5 = refSma(c, 5);
  const cross = c.map((v, i) => (i && v > sma5[i] && c[i - 1] <= sma5[i - 1] ? 1 : 0));
  assert.deepEqual(plotOf(r, "x"), cross);
  let last = -1;
  let lastClose = NaN;
  const since = cross.map((x, i) => {
    if (x) {
      last = i;
      lastClose = c[i];
    }
    return last < 0 ? NaN : i - last;
  });
  assert.deepEqual(plotOf(r, "since"), since);
  last = -1;
  const when = cross.map((x, i) => (x ? (lastClose = c[i]) : last < 0 && !cross.slice(0, i).some(Boolean) ? NaN : lastClose));
  sameSeries(plotOf(r, "when"), when);
  const ph = c.map((_, i) => {
    const p = i - 3;
    if (p < 3) return NaN;
    const v = c[p];
    for (let k = 1; k <= 3; k++) if (!(v > c[p - k]) || !(v >= c[p + k])) return NaN;
    return v;
  });
  sameSeries(plotOf(r, "ph"), ph);
});

// ----------------------------------------------------------------------------- request.security

test("request.security: a larger timeframe shows once its bar closes; lookahead shows it at once", () => {
  // 15-minute bars over 3 hours; the hourly close is the close of its last 15-minute bar
  const c = Array.from({ length: 12 }, (_, i) => 100 + i);
  const b = bars(c, 900);
  const hourly: Bar[] = [0, 1, 2].map((h) => ({ time: b[0].time + h * 3600, open: c[h * 4], high: 0, low: 0, close: c[h * 4 + 3], volume: 1, confirmed: true }));
  const l = load(`//@version=5
indicator("t")
plot(request.security(syminfo.tickerid, "60", close), "off")
plot(request.security(syminfo.tickerid, "60", close, lookahead = barmerge.lookahead_on), "on")
plot(request.security(syminfo.tickerid, "60", close, gaps = barmerge.gaps_on), "gaps")`);
  assert.ok(l.ok);
  if (!l.ok) return;
  const { result, missing } = runWithSecurity(l.program, { bars: b, sec: 900, instId: "BTC-USDT-SWAP", mintick: 0.01 }, {}, (req) => (req.tf.sec === 3600 ? hourly : null), []);
  assert.equal(missing.length, 0);
  assert.equal(result.error, null);
  const off = Array.from(result.out.plots[0].values);
  const on = Array.from(result.out.plots[1].values);
  const gaps = Array.from(result.out.plots[2].values);
  assert.deepEqual(off, [NaN, NaN, NaN, 103, 103, 103, 103, 107, 107, 107, 107, 111]);
  assert.deepEqual(on, [103, 103, 103, 103, 107, 107, 107, 107, 111, 111, 111, 111]);
  assert.deepEqual(gaps, [NaN, NaN, NaN, 103, NaN, NaN, NaN, 107, NaN, NaN, NaN, 111]);
});

// ----------------------------------------------------------------------------- strategies

test("strategy: market orders fill at the next open; an opposite entry reverses", () => {
  // opens 10, 11, 12, …
  const c = [10, 11, 12, 13, 14, 15, 16];
  const b = c.map((x, i) => ({ time: 1700006400 + i * 900, open: x, high: x + 0.5, low: x - 0.5, close: x + 0.2, volume: 1, confirmed: true }));
  const r = run(
    `//@version=5
strategy("s", initial_capital = 1000)
if bar_index == 1
    strategy.entry("L", strategy.long, qty = 2)
if bar_index == 3
    strategy.entry("S", strategy.short, qty = 1)
if bar_index == 5
    strategy.close("S")`,
    b,
  );
  const s = r.strategy!;
  assert.equal(s.trades.length, 2);
  // long 2 @ 12 (bar 2 open), reversed at bar 4 open (14): +4; short 1 @ 14 closed at bar 6 open (16): -2
  assert.deepEqual(s.trades.map((t) => [t.entryId, t.exitId, t.entryPrice, t.exitPrice, t.qty]), [
    ["L", "S", 12, 14, 2],
    ["S", "Close entry(s) order S", 14, 16, 1],
  ]);
  assert.ok(Math.abs(s.netProfit - 2) < 1e-9);
});

test("strategy: exit take-profit and stop-loss fill where the bar reaches them, gaps at the open", () => {
  const b: Bar[] = [
    { time: 0, open: 100, high: 101, low: 99, close: 100, volume: 1, confirmed: true },
    { time: 900, open: 100, high: 101, low: 99, close: 100, volume: 1, confirmed: true }, // entry at 100
    { time: 1800, open: 100, high: 104, low: 99.5, close: 103, volume: 1, confirmed: true }, // TP 103 reached
    { time: 2700, open: 103, high: 103, low: 103, close: 103, volume: 1, confirmed: true },
    { time: 3600, open: 103, high: 103, low: 103, close: 103, volume: 1, confirmed: true }, // second entry at 103
    { time: 4500, open: 95, high: 96, low: 94, close: 95, volume: 1, confirmed: true }, // gaps below the stop: fills at the open
  ];
  const r = run(
    `//@version=5
strategy("s", initial_capital = 1000)
if bar_index == 0 or bar_index == 3
    strategy.entry("L", strategy.long, qty = 1)
strategy.exit("x", "L", profit = 300, loss = 200)`,
    b,
  );
  const t = r.strategy!.trades;
  assert.deepEqual(t.map((x) => [x.entryPrice, x.exitPrice, x.exitId]), [
    [100, 103, "x"],
    [103, 95, "x"],
  ]);
});

test("strategy: process_orders_on_close fills at this bar's close; pyramiding limits entries; commission", () => {
  const b = [10, 11, 12, 13].map((x, i) => ({ time: i * 900, open: x, high: x + 1, low: x - 1, close: x + 0.5, volume: 1, confirmed: true }));
  const r = run(
    `//@version=5
strategy("s", process_orders_on_close = true, pyramiding = 2, commission_type = strategy.commission.cash_per_order, commission_value = 1)
strategy.entry("L", strategy.long, qty = 1)`,
    b,
  );
  const s = r.strategy!;
  assert.equal(s.open.length, 2);
  assert.deepEqual(s.open.map((t) => t.price), [10.5, 11.5]);
  assert.equal(s.commission, 2);
});

test("strategy: percent of equity sizes from the close when the order is placed", () => {
  const b = [100, 100, 110].map((x, i) => ({ time: i * 900, open: x, high: x, low: x, close: x, volume: 1, confirmed: true }));
  const r = run(
    `//@version=5
strategy("s", initial_capital = 1000, default_qty_type = strategy.percent_of_equity, default_qty_value = 50)
if bar_index == 0
    strategy.entry("L", strategy.long)
plot(strategy.position_size, "size")
plot(strategy.equity, "eq")`,
    b,
  );
  assert.deepEqual(plotOf(r, "size"), [0, 5, 5]);
  assert.deepEqual(plotOf(r, "eq"), [1000, 1000, 1050]);
});

// ----------------------------------------------------------------------------- inputs, drawings, errors

test("inputs: the user's values are used, wrong ones fall back to the default", () => {
  const src = `//@version=5
indicator("t")
n = input.int(3, "Len", minval = 1)
k = input.string("a", "Kind", options = ["a", "b"])
s = input.source(close, "Src")
plot(n, "n")
plot(k == "b" ? 1 : 0, "k")
plot(s, "s")`;
  const b = bars([5, 6]);
  const r = run(src, b, { Len: 7, Kind: "b", Src: "open" });
  assert.deepEqual(plotOf(r, "n"), [7, 7]);
  assert.deepEqual(plotOf(r, "k"), [1, 1]);
  assert.deepEqual(plotOf(r, "s"), [5, 5]);
  const bad = run(src, b, { Len: "x", Kind: "c", Src: "nothing" });
  assert.deepEqual(plotOf(bad, "n"), [3, 3]);
  assert.deepEqual(plotOf(bad, "k"), [0, 0]);
  assert.deepEqual(plotOf(bad, "s"), [5, 6]);
  assert.deepEqual(r.inputs.map((i) => [i.key, i.kind]), [["Len", "int"], ["Kind", "string"], ["Src", "source"]]);
});

test("drawings: only the newest max_lines_count stay; deleted ones go", () => {
  const r = run(
    `//@version=5
indicator("t", max_lines_count = 3)
l = line.new(bar_index, close, bar_index + 1, close)
if bar_index == 9
    line.delete(l)
lb = label.new(bar_index, high, "x")
label.delete(lb[1])`,
    bars(wave(10)),
  );
  assert.deepEqual(r.out.lines.map((l) => l.x1), [7, 8]);
  assert.equal(r.out.labels.length, 1);
});

test("runtime errors stop the script with their line", () => {
  const l = load(`//@version=5\nindicator("t")\na = array.new_float(2)\nx = a.get(5)\nplot(x)`);
  assert.ok(l.ok);
  if (!l.ok) return;
  const r = l.program.run({ bars: bars([1, 2]), sec: 900, instId: "BTC-USDT-SWAP", mintick: 0.01 });
  assert.equal(r.ok, false);
  assert.equal(r.error?.line, 4);
  const inf = load(`//@version=5\nindicator("t")\nwhile true\n    x = 1`);
  assert.ok(inf.ok);
  if (!inf.ok) return;
  const r2 = inf.program.run({ bars: bars([1]), sec: 900, instId: "BTC-USDT-SWAP", mintick: 0.01 }, { timeLimit: 200 });
  assert.equal(r2.ok, false);
});
