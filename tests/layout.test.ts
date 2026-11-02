// Tabs and split layouts (src/layout/model.ts) and the live-stream list (src/core/live.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addTab,
  cellCount,
  centerDivider,
  cleanTabs,
  closeTab,
  dividers,
  evenSizes,
  LAYOUT_IDS,
  MAX_TABS,
  moveDivider,
  moveTab,
  newTab,
  setLayout,
  type Cell,
  type Tabs,
} from "../src/layout/model.ts";
import { unionPairs } from "../src/core/live.ts";

const btc: Cell = { instId: "BTC-USDT-SWAP", bar: "15m", zoom: null };
const eth: Cell = { instId: "ETH-USDT-SWAP", bar: "1H", zoom: 6.5 };
const isBar = (b: string) => ["1m", "15m", "1H", "4H"].includes(b);

test("layouts: up to four charts, each a block", () => {
  for (const id of LAYOUT_IDS) {
    const n = cellCount(id);
    assert.ok(n >= 1 && n <= 4, id);
  }
  assert.equal(cellCount("2h"), 2);
  assert.equal(cellCount("1+2"), 3);
  assert.equal(cellCount("4"), 4);
  assert.deepEqual(evenSizes("1+3v"), { cols: [1, 1, 1], rows: [1, 1] });
});

test("dividers: only where two different charts meet", () => {
  assert.deepEqual(dividers("1", evenSizes("1")), []);
  assert.deepEqual(dividers("2h", evenSizes("2h")), [{ axis: "col", index: 0, at: 0.5, from: 0, to: 1 }]);
  // left one, right two: the line between the two on the right covers the right half only
  assert.deepEqual(dividers("1+2", evenSizes("1+2")), [
    { axis: "col", index: 0, at: 0.5, from: 0, to: 1 },
    { axis: "row", index: 0, at: 0.5, from: 0.5, to: 1 },
  ]);
  // top one, bottom three: two short vertical lines in the bottom row
  const d = dividers("1+3v", evenSizes("1+3v"));
  assert.equal(d.length, 3);
  assert.deepEqual(d.filter((x) => x.axis === "col").map((x) => [x.from, x.to]), [[0.5, 1], [0.5, 1]]);
  assert.equal(dividers("4", evenSizes("4")).length, 2);
});

test("dragging a divider: only its neighbors change, each keeps a minimum", () => {
  const s = moveDivider(evenSizes("3h"), "col", 0, 0.2);
  assert.deepEqual(s.cols.map((x) => +x.toFixed(6)), [0.6, 1.4, 1]); // first edge from 1/3 to 0.2 of 3
  assert.deepEqual(moveDivider(evenSizes("2h"), "col", 0, 0.01).cols, [0.2, 1.8]); // at least 10%
  assert.deepEqual(moveDivider(evenSizes("2v"), "row", 0, 0.97).rows.map((x) => +x.toFixed(6)), [1.8, 0.2]);
  assert.deepEqual(centerDivider({ cols: [0.6, 1.4], rows: [1] }, "col", 0).cols.map((x) => +x.toFixed(6)), [1, 1]);
  const same = evenSizes("1");
  assert.equal(moveDivider(same, "col", 0, 0.5), same); // no divider there
});

test("tabs: add after the one in use, close, move", () => {
  let s: Tabs = { tabs: [newTab(btc, "t-a")], active: 0 };
  s = addTab(s, eth);
  assert.equal(s.tabs.length, 2);
  assert.equal(s.active, 1);
  assert.equal(s.tabs[1].cells[0].instId, "ETH-USDT-SWAP");
  s = { ...s, tabs: [...s.tabs, newTab(btc, "t-c")] }; // [a, eth, c], eth in use
  const moved = moveTab(s, 2, 0); // [c, a, eth]
  assert.deepEqual(moved.tabs.map((t) => t.id).slice(0, 2), ["t-c", "t-a"]);
  assert.equal(moved.active, 2); // still the ETH tab
  assert.equal(closeTab(s, 1).active, 1); // closing the one in use: its right neighbor
  assert.equal(closeTab(s, 0).active, 0); // closing one before it: same tab, one place left
  const one: Tabs = { tabs: [newTab(btc)], active: 0 };
  assert.equal(closeTab(one, 0), one); // the last tab stays
  let full: Tabs = one;
  for (let i = 0; i < MAX_TABS + 5; i++) full = addTab(full, btc);
  assert.equal(full.tabs.length, MAX_TABS);
});

test("layout change: new charts copy the one in use, dropped ones come back", () => {
  let t = { ...newTab(btc), cells: [btc], active: 0 };
  t = setLayout(t, "2h");
  assert.deepEqual(t.cells.map((c) => c.instId), ["BTC-USDT-SWAP", "BTC-USDT-SWAP"]);
  t = { ...t, cells: [btc, eth], active: 1 };
  t = setLayout(t, "4");
  assert.deepEqual(t.cells.map((c) => c.instId), ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "ETH-USDT-SWAP", "ETH-USDT-SWAP"]);
  t = setLayout(t, "1");
  assert.equal(t.active, 0);
  assert.equal(t.cells.length, 4); // kept
  t = setLayout(t, "2v");
  assert.equal(t.cells[1].instId, "ETH-USDT-SWAP"); // back where it was
  assert.deepEqual(t.sizes, evenSizes("2v"));
});

test("saved tabs are checked", () => {
  const empty = cleanTabs(undefined, btc, isBar);
  assert.equal(empty.tabs.length, 1);
  assert.deepEqual(empty.tabs[0].cells, [btc]);
  const s = cleanTabs(
    {
      active: 7,
      tabs: [
        { id: "t-1", layout: "2h", active: 1, cells: [eth, { instId: "x y", bar: "15m" }], sizes: { cols: [1, 3], rows: [1] } },
        { id: "t-1", layout: "nope", cells: [{ instId: "SOL-USDT-SWAP", bar: "1d" }], active: 3 },
        { id: "t-3", layout: "4", cells: [btc], sizes: { cols: [1, 50], rows: [1, 1] } },
        "junk",
      ],
    },
    btc,
    isBar,
  );
  assert.equal(s.tabs.length, 3);
  assert.equal(s.active, 0);
  const [a, b, c] = s.tabs;
  assert.deepEqual(a.cells.map((x) => x.instId), ["ETH-USDT-SWAP", "ETH-USDT-SWAP"]); // the bad cell dropped, padded
  assert.equal(a.cells[0].zoom, 6.5);
  assert.deepEqual(a.sizes, { cols: [1, 3], rows: [1] });
  assert.notEqual(b.id, "t-1"); // ids stay unique
  assert.equal(b.layout, "1");
  assert.deepEqual(b.cells, [btc]); // 1d isn't a timeframe: fallback
  assert.equal(b.active, 0);
  assert.equal(c.cells.length, 4);
  assert.deepEqual(c.sizes, evenSizes("4")); // 1:50 leaves a chart under the minimum
});

test("live streams: every chart once, alerts on 1m, tabs only when nothing else streams the symbol", () => {
  const pairs = unionPairs(
    [
      [{ instId: "BTC-USDT-SWAP", bar: "15m" }, { instId: "BTC-USDT-SWAP", bar: "15m" }, { instId: "ETH-USDT-SWAP", bar: "4H" }],
      [{ instId: "SOL-USDT-SWAP", bar: "1m" }],
    ],
    [["BTC-USDT-SWAP", "XRP-USDT-SWAP"], ["XRP-USDT-SWAP"]],
  );
  assert.deepEqual(pairs.map((p) => `${p.instId} ${p.bar}`), [
    "BTC-USDT-SWAP 15m",
    "ETH-USDT-SWAP 4H",
    "SOL-USDT-SWAP 1m",
    "XRP-USDT-SWAP 1m",
  ]);
});
