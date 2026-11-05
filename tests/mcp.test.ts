// The AI connection's rules: its saved settings, what each permission allows, when an order waits for the user,
// and how what AI apps send (symbols, timeframes, points, numbers) is read.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowed,
  ArgError,
  bool,
  cleanMcp,
  DEFAULT_MCP,
  iso,
  needsConfirm,
  normalizeSymbol,
  normalizeTf,
  num,
  oneOf,
  points,
  riskAllowed,
  str,
  widensStop,
  withinDefaults,
} from "../src/mcp/model.ts";

test("settings: off, read-only for orders and asking every time unless the user says otherwise", () => {
  assert.deepEqual(cleanMcp(undefined), DEFAULT_MCP);
  assert.deepEqual(DEFAULT_MCP, { on: false, port: 39217, write: true, trade: false, confirm: "always" });
  assert.deepEqual(cleanMcp({ on: true, port: 40000, write: false, trade: true, confirm: "real" }), { on: true, port: 40000, write: false, trade: true, confirm: "real" });
  // anything odd falls back to the safe default
  const odd = cleanMcp({ on: "yes", port: 80, trade: "true", confirm: "sometimes" });
  assert.deepEqual(odd, DEFAULT_MCP);
  assert.equal(cleanMcp({ port: 70000 }).port, 39217);
  assert.equal(cleanMcp({ port: 4000.5 }).port, 39217);
});

test("permissions: reading always, changing the charts and trading only when allowed", () => {
  const s = { ...DEFAULT_MCP, on: true };
  assert.equal(allowed("read", { ...s, write: false, trade: false }), true);
  assert.equal(allowed("write", s), true);
  assert.equal(allowed("write", { ...s, write: false }), false);
  assert.equal(allowed("trade", s), false);
  assert.equal(allowed("trade", { ...s, trade: true }), true);
});

test("an order waits for the user: always, real money only, never; past the defaults always", () => {
  assert.equal(needsConfirm("always", true, true), true);
  assert.equal(needsConfirm("real", true, true), false);
  assert.equal(needsConfirm("real", false, true), true);
  assert.equal(needsConfirm("never", false, true), false);
  for (const m of ["always", "real", "never"] as const) for (const demo of [true, false]) assert.equal(needsConfirm(m, demo, false), true);
});

test("within the position defaults: the loss at the stop and the leverage", () => {
  const pct = { risk: 1, riskMode: "pct" as const, leverage: 10 };
  assert.equal(riskAllowed(pct, 2000), 20);
  assert.equal(riskAllowed({ risk: 15, riskMode: "amount" }, 2000), 15);
  assert.equal(withinDefaults({ risk: 20, leverage: 10 }, pct, 2000), true);
  assert.equal(withinDefaults({ risk: 20.15, leverage: 10 }, pct, 2000), true); // rounding of contracts and prices
  assert.equal(withinDefaults({ risk: 21, leverage: 10 }, pct, 2000), false);
  assert.equal(withinDefaults({ risk: 5, leverage: 20 }, pct, 2000), false);
  // a stop moved away from the entry adds risk; towards it, or past it, doesn't
  assert.equal(widensStop(1, 95, 90), true);
  assert.equal(widensStop(1, 95, 97), false);
  assert.equal(widensStop(-1, 105, 110), true);
  assert.equal(widensStop(-1, 105, 100), false);
  assert.equal(widensStop(1, 95, 95), false);
});

test("timeframes as AI apps write them, in the app's own names", () => {
  const cases: [string, string | null][] = [
    ["15m", "15m"], ["15min", "15m"], ["1 minute", "1m"], ["1h", "1H"], ["4H", "4H"], ["4 hours", "4H"], ["6h", "6Hutc"], ["12H", "12Hutc"],
    ["1d", "1Dutc"], ["D", "1Dutc"], ["1Dutc", "1Dutc"], ["1W", "1Wutc"], ["week", "1Wutc"], ["15s", "15s"], ["90m", "90m"], ["120m", "2H"],
    ["1M", null], ["1mo", null], ["0m", null], ["abc", null], ["", null], ["25h", null], ["13s", "13s"],
  ];
  for (const [given, want] of cases) assert.equal(normalizeTf(given), want, given);
});

test("symbols as AI apps write them", () => {
  for (const s of ["BTC", "btc", "BTCUSDT", "BTC-USDT", "btc/usdt", "BTCUSDT.P", "BTC-USDT-SWAP"]) assert.equal(normalizeSymbol(s), "BTC-USDT-SWAP", s);
  assert.equal(normalizeSymbol("1000PEPE"), "1000PEPE-USDT-SWAP");
});

test("arguments: required or not, numbers in range, choices, points in UTC seconds", () => {
  const a = { n: "12.5", i: 3, s: "x", b: true, k: "limit", pts: [{ time: 1_700_000_000_000, price: 100 }, { time: 1_700_000_060, price: "101" }] };
  assert.equal(num(a, "n"), 12.5);
  assert.equal(num(a, "missing", { optional: true }), undefined);
  assert.throws(() => num(a, "missing"), ArgError);
  assert.throws(() => num(a, "i", { min: 5 }), /at least 5/);
  assert.throws(() => num(a, "n", { int: true }), /whole number/);
  assert.throws(() => num({ x: "abc" }, "x"), /must be a number/);
  assert.equal(str(a, "s"), "x");
  assert.throws(() => str({ s: 3 }, "s"), /must be a string/);
  assert.throws(() => str({ s: "abcdef" }, "s", { max: 3 }), /too long/);
  assert.equal(bool(a, "b"), true);
  assert.equal(bool(a, "none", false), false);
  assert.throws(() => bool({ b: "yes" }, "b"), /true or false/);
  assert.equal(oneOf(a, "k", ["limit", "market"] as const), "limit");
  assert.equal(oneOf({}, "k", ["limit", "market"] as const, "market"), "market");
  assert.throws(() => oneOf({ k: "stop" }, "k", ["limit", "market"] as const), /one of: limit, market/);
  assert.deepEqual(points(a, "pts", 2, 2), [{ t: 1_700_000_000, p: 100 }, { t: 1_700_000_060, p: 101 }]); // milliseconds taken too
  assert.throws(() => points(a, "pts", 1, 1), /needs 1 points/);
  assert.throws(() => points({ pts: [{ time: 1, price: 0 }] }, "pts", 1, 1), /above 0/);
  assert.equal(iso(1_700_000_000), "2023-11-14T22:13:20Z");
});
