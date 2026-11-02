// Fair value gaps and order blocks on small hand-made bar series.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findFvgs, findLevels, findOrderBlocks, pickZones } from "../src/indicators/zones.ts";
import type { Candle } from "../src/core/api.ts";

let t = 0;
const k = (open: number, high: number, low: number, close: number, confirmed = true): Candle => ({
  time: (t += 60), open, high, low, close, volume: 1, confirmed,
});
const reset = () => (t = 0);

test("bullish FVG: found when bar 3 closes, filled when a low reaches the bottom", () => {
  reset();
  const bars = [k(100, 101, 99, 100.5), k(100.5, 106, 100.4, 105.8), k(105.8, 108, 103, 107)];
  const z = findFvgs(bars, { body: false, minPct: 0 });
  assert.equal(z.length, 1);
  assert.deepEqual(z[0], { from: bars[1].time, to: null, top: 103, bottom: 101, dir: 1 });
  bars.push(k(107, 107.5, 102, 102.5)); // dips into the gap: not filled yet
  assert.equal(findFvgs(bars, { body: false, minPct: 0 })[0].to, null);
  bars.push(k(102.5, 103, 100.9, 101.5, false)); // the bar still forming trades through the bottom: filled
  assert.equal(findFvgs(bars, { body: false, minPct: 0 })[0].to, bars[4].time);
});

test("FVG waits for the third bar to close; bearish gaps; size filter; bodies", () => {
  reset();
  const forming = [k(100, 101, 99, 100.5), k(100.5, 106, 100.4, 105.8), k(105.8, 108, 103, 107, false)];
  assert.equal(findFvgs(forming, { body: false, minPct: 0 }).length, 0);
  reset();
  const down = [k(100, 101, 99, 99.5), k(99.5, 99.6, 94, 94.2), k(94.2, 96, 93, 93.5)];
  assert.deepEqual(findFvgs(down, { body: false, minPct: 0 })[0], { from: down[1].time, to: null, top: 99, bottom: 96, dir: -1 });
  assert.equal(findFvgs(down, { body: false, minPct: 4 }).length, 0); // 3 / 93.5 = 3.2 % < 4 %
  assert.equal(findFvgs(down, { body: false, minPct: 3 }).length, 1);
  reset();
  // wicks overlap (high 1 = 104 > low 3 = 103), bodies don't (body top 1 = 101 < body bottom 3 = 104)
  const b = [k(100, 104, 99, 101), k(101, 107, 100.5, 106), k(106, 109, 103, 108)];
  assert.equal(findFvgs(b, { body: false, minPct: 0 }).length, 0);
  assert.deepEqual(findFvgs(b, { body: true, minPct: 0 })[0], { from: b[1].time, to: null, top: 106, bottom: 101, dir: 1 });
});

test("order block: last down bar before the close above the swing high; broken by a close under its low", () => {
  reset();
  const bars = [
    k(100, 101, 99, 100.5), // 0
    k(100.5, 105, 100, 104), // 1  swing high 105 (swing = 1)
    k(104, 104.5, 101, 102), // 2  confirms it
    k(102, 102.5, 98, 99), // 3  down bar: the block, [98, 102.5]
    k(99, 103, 98.5, 102.8), // 4  up
    k(102.8, 106, 102.5, 105.5), // 5  closes above 105: break
  ];
  const z = findOrderBlocks(bars, { swing: 1, lookback: 10 });
  assert.equal(z.length, 1);
  assert.deepEqual(z[0], { from: bars[3].time, to: null, top: 102.5, bottom: 98, dir: 1 });
  bars.push(k(105.5, 106, 99, 99.5)); // closes inside the block: still alive
  assert.equal(findOrderBlocks(bars, { swing: 1, lookback: 10 })[0].to, null);
  bars.push(k(99.5, 100, 97, 97.5, false)); // still forming: doesn't count yet
  assert.equal(findOrderBlocks(bars, { swing: 1, lookback: 10 })[0].to, null);
  bars[bars.length - 1].confirmed = true; // closes under 98: broken
  assert.equal(findOrderBlocks(bars, { swing: 1, lookback: 10 })[0].to, bars[7].time);
  // lookback too short to reach the down bar: no block
  assert.equal(findOrderBlocks(bars.slice(0, 6), { swing: 1, lookback: 1 }).length, 0);
});

test("order block: bearish mirror, and a swing level is used once", () => {
  reset();
  const bars = [
    k(100, 101, 99.5, 100), // 0
    k(100, 100.5, 95, 96), // 1  swing low 95
    k(96, 98, 95.5, 97.5), // 2  confirms it
    k(97.5, 99.5, 97, 99), // 3  up bar: the block [97, 99.5]
    k(99, 99.2, 94, 94.5), // 4  closes under 95: break
    k(94.5, 95, 93, 93.5), // 5  lower again, but the level is used up
  ];
  const z = findOrderBlocks(bars, { swing: 1, lookback: 10 });
  assert.equal(z.length, 1);
  assert.deepEqual(z[0], { from: bars[3].time, to: null, top: 99.5, bottom: 97, dir: -1 });
});

test("pickZones keeps the newest running ones per side, and ended ones on request", () => {
  const z = [
    { from: 1, to: null, top: 2, bottom: 1, dir: 1 as const },
    { from: 2, to: 5, top: 2, bottom: 1, dir: 1 as const },
    { from: 3, to: null, top: 2, bottom: 1, dir: 1 as const },
    { from: 4, to: null, top: 2, bottom: 1, dir: -1 as const },
  ];
  assert.deepEqual(pickZones(z, 1, false).map((x) => x.from), [3, 4]);
  assert.deepEqual(pickZones(z, 5, true).map((x) => x.from), [1, 3, 4, 2]);
});

test("support and resistance: swing levels until a close beyond them", () => {
  reset();
  const bars = [
    k(100, 101, 99, 100), // 0
    k(100, 104, 99.5, 103), // 1  swing high 104 (swing = 1): resistance
    k(103, 103.5, 98, 98.5), // 2  confirms 104; swing low 98 at bar 2
    k(98.5, 101, 98.2, 100.5), // 3  confirms 98: support
    k(100.5, 103.8, 100, 103.6), // 4  under 104: resistance holds
  ];
  const z = findLevels(bars, { swing: 1 });
  assert.deepEqual(z.map((x) => [x.dir, x.top, x.to]), [[-1, 104, null], [1, 98, null]]);
  assert.equal(z[0].from, bars[1].time);
  bars.push(k(103.6, 105, 103, 104.5, false)); // forming bar above 104: not yet
  assert.equal(findLevels(bars, { swing: 1 })[0].to, null);
  bars[5].confirmed = true; // closes above 104: resistance broken
  const after = findLevels(bars, { swing: 1 });
  assert.equal(after[0].to, bars[5].time);
  assert.equal(after[1].to, null);
  // a wick through the level without a close beyond it doesn't break support
  bars.push(k(104.5, 104.6, 97.5, 98.1));
  assert.equal(findLevels(bars, { swing: 1 })[1].to, null);
});
