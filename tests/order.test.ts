// Positions turned into OKX orders (src/trade/model.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanOrderPrefs, floorStep, newClOrdId, planOrder, roundStep, stepDecimals, type OrderInput } from "../src/trade/model.ts";
import { cleanOrder } from "../src/settings/model.ts";

const btc = { ctVal: 0.01, lotSz: "0.01", minSz: "0.01", maxLever: 100, tickSz: "0.1" };
const base: OrderInput = {
  instId: "BTC-USDT-SWAP", entry: 78000.04, stop: 77500, target: 79000, qty: 0.02, leverage: 10, last: 77900, avail: 500,
  spec: btc, prefs: { ordType: "limit", tdMode: "isolated", attachTp: true },
};

test("steps", () => {
  assert.equal(stepDecimals("0.01"), 2);
  assert.equal(stepDecimals("1"), 0);
  assert.equal(stepDecimals("0.0000000001"), 10);
  assert.equal(floorStep(4.2 / 0.1, "0.01"), "42.00"); // 41.99999… is still 42
  assert.equal(floorStep(1.239, "0.01"), "1.23");
  assert.equal(floorStep(0.004, "0.01"), "0.00");
  assert.equal(roundStep(78000.04, "0.1"), "78000.0");
  assert.equal(roundStep(0.00000123456, "0.0000000001"), "0.0000012346");
});

test("a long limit order with its stop and take-profit", () => {
  const p = planOrder(base);
  assert.equal(p.side, "buy");
  assert.equal(p.px, "78000.0");
  assert.equal(p.sz, "2.00"); // 0.02 BTC / 0.01 per contract
  assert.equal(p.sl, "77500.0");
  assert.equal(p.tp, "79000.0");
  assert.equal(Math.round(p.notional), 1560);
  assert.equal(Math.round(p.margin), 156);
  assert.equal(Math.round(p.risk), 10);
  assert.deepEqual(p.problems, []);
  assert.match(p.warnings.join(), /高於現價/); // 78,000 is above the last 77,900: fills at once
});

test("what blocks an order", () => {
  assert.match(planOrder({ ...base, qty: 0.00005 }).problems.join(), /數量太小/);
  assert.match(planOrder({ ...base, leverage: 125 }).problems.join(), /最高 100 倍/);
  assert.match(planOrder({ ...base, leverage: 7.5 }).problems.join(), /整數/);
  assert.match(planOrder({ ...base, prefs: { ...base.prefs, ordType: "post_only" } }).problems.join(), /Maker/);
  // a market long when the price is already under the stop
  assert.match(planOrder({ ...base, last: 77400, prefs: { ...base.prefs, ordType: "market" } }).problems.join(), /止損另一邊/);
  const short = planOrder({ ...base, entry: 78000, stop: 78500, target: 77000, last: 78100 });
  assert.equal(short.side, "sell");
  assert.match(short.warnings.join(), /低於現價/);
  assert.deepEqual(short.problems, []);
  const noTp = planOrder({ ...base, prefs: { ...base.prefs, attachTp: false } });
  assert.equal(noTp.tp, null);
  assert.match(planOrder({ ...base, avail: 50 }).warnings.join(), /超過可用/);
});

test("market orders size from the latest price", () => {
  const p = planOrder({ ...base, last: 77800, prefs: { ...base.prefs, ordType: "market" } });
  assert.equal(p.px, null);
  assert.equal(Math.round(p.notional), 1556);
  assert.deepEqual(p.problems, []);
});

test("saved choices and order records are checked", () => {
  assert.deepEqual(cleanOrderPrefs({ ordType: "stop", tdMode: "cross", attachTp: false }), { ordType: "limit", tdMode: "cross", attachTp: false });
  assert.deepEqual(cleanOrderPrefs(null), { ordType: "limit", tdMode: "isolated", attachTp: true });
  const id = newClOrdId(1793667723004, () => 0.5);
  assert.match(id, /^qtc[a-z0-9]{1,29}$/);
  assert.ok(id.length <= 32);
  const o = cleanOrder({ ordId: "123", clOrdId: id, demo: true, side: "buy", ordType: "limit", px: 78000, sz: 2, at: 1, state: "live", avgPx: null, fillSz: 0 });
  assert.equal(o?.state, "live");
  assert.equal(cleanOrder({ ordId: "12a", clOrdId: id, side: "buy" }), undefined);
  assert.equal(cleanOrder({ ordId: "1", clOrdId: id, side: "buy", state: "weird" })?.state, "unknown");
});
