// Tabs and the charts in each tab: which layout (one chart, side by side, stacked, up to a 2×2 grid), what
// each chart shows, how the space is shared, and the rules that keep saved data valid. Pure data and
// functions (no DOM), unit-tested in tests/layout.test.ts.

/** Layouts: rows of cell letters, like CSS grid-template-areas; a letter spanning cells is one chart. Cell
 *  "a" is chart 1, "b" chart 2, and so on; a chart keeps its place when the layout changes where it can. */
export const LAYOUTS = {
  "1": { name: "單一圖表", areas: ["a"] },
  "2h": { name: "左右兩個", areas: ["a b"] },
  "2v": { name: "上下兩個", areas: ["a", "b"] },
  "3h": { name: "三個並排", areas: ["a b c"] },
  "3v": { name: "三個上下疊", areas: ["a", "b", "c"] },
  "1+2": { name: "左一右二", areas: ["a b", "a c"] },
  "2+1": { name: "左二右一", areas: ["a b", "c b"] },
  "1+2v": { name: "上一下二", areas: ["a a", "b c"] },
  "2+1v": { name: "上二下一", areas: ["a b", "c c"] },
  "4": { name: "四宮格", areas: ["a b", "c d"] },
  "4h": { name: "四個並排", areas: ["a b c d"] },
  "4v": { name: "四個上下疊", areas: ["a", "b", "c", "d"] },
  "1+3": { name: "左一右三", areas: ["a b", "a c", "a d"] },
  "1+3v": { name: "上一下三", areas: ["a a a", "b c d"] },
} as const satisfies Record<string, { name: string; areas: readonly string[] }>;

export type LayoutId = keyof typeof LAYOUTS;
export const LAYOUT_IDS = Object.keys(LAYOUTS) as LayoutId[];
export const MAX_CELLS = 4;
export const MAX_TABS = 20;
/** A chart gets at least this share of the width or height it is split along. */
export const MIN_SHARE = 0.1;

/** What one chart shows; `zoom` is its bar spacing in pixels (null: the default view). */
export type Cell = { instId: string; bar: string; zoom: number | null };
/** Relative widths of the grid's columns and heights of its rows. */
export type Sizes = { cols: number[]; rows: number[] };
export type Tab = { id: string; layout: LayoutId; cells: Cell[]; active: number; sizes: Sizes };
export type Tabs = { tabs: Tab[]; active: number };

export const isLayout = (v: unknown): v is LayoutId =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(LAYOUTS, v);

/** The layout as a grid of cell letters, rows × columns. */
export const gridOf = (id: LayoutId): string[][] => LAYOUTS[id].areas.map((r) => r.split(" "));
export const cellCount = (id: LayoutId): number => new Set(LAYOUTS[id].areas.join(" ").split(" ")).size;
export const cellLetter = (i: number): string => String.fromCharCode(97 + i);

export function evenSizes(id: LayoutId): Sizes {
  const g = gridOf(id);
  return { cols: g[0].map(() => 1), rows: g.map(() => 1) };
}

export const newTabId = (): string => `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function newTab(cell: Cell, id = newTabId()): Tab {
  return { id, layout: "1", cells: [{ ...cell }], active: 0, sizes: evenSizes("1") };
}

/** The chart in use in a tab (its symbol is what the tab shows). */
export const activeCell = (t: Tab): Cell => t.cells[t.active] ?? t.cells[0];

// ----------------------------------------------------------------------------- changes (new objects)
/** A new tab right after the one in use, showing `cell`; it becomes the one in use. */
export function addTab(s: Tabs, cell: Cell): Tabs {
  if (s.tabs.length >= MAX_TABS) return s;
  const tabs = s.tabs.slice();
  tabs.splice(s.active + 1, 0, newTab(cell));
  return { tabs, active: s.active + 1 };
}

/** Close tab i (the last tab stays); the one in use moves to its neighbor when it was closed. */
export function closeTab(s: Tabs, i: number): Tabs {
  if (s.tabs.length <= 1 || i < 0 || i >= s.tabs.length) return s;
  const tabs = s.tabs.filter((_, k) => k !== i);
  const active = i < s.active ? s.active - 1 : i === s.active ? Math.min(i, tabs.length - 1) : s.active;
  return { tabs, active };
}

/** Move a tab from one place to another; the tab in use stays in use. */
export function moveTab(s: Tabs, from: number, to: number): Tabs {
  const n = s.tabs.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return s;
  const tabs = s.tabs.slice();
  const [t] = tabs.splice(from, 1);
  tabs.splice(to, 0, t);
  const id = s.tabs[s.active].id;
  return { tabs, active: tabs.findIndex((x) => x.id === id) };
}

/** A new layout: charts it adds show what the chart in use shows; charts it drops are remembered for later. */
export function setLayout(t: Tab, id: LayoutId): Tab {
  const n = cellCount(id);
  const cells = t.cells.map((c) => ({ ...c }));
  while (cells.length < n) cells.push({ ...activeCell(t) });
  return { ...t, layout: id, cells, active: Math.min(t.active, n - 1), sizes: evenSizes(id) };
}

// ----------------------------------------------------------------------------- dividers
/** A line between charts that can be dragged: along columns ("col", a vertical line at `at` of the width,
 *  from `from` to `to` of the height) or rows (a horizontal line). `index`: the track before it. */
export type Divider = { axis: "col" | "row"; index: number; at: number; from: number; to: number };

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
/** Edges of the tracks as shares of the whole: [0, …, 1]. */
function edges(list: number[]): number[] {
  const total = sum(list);
  const out = [0];
  let acc = 0;
  for (const v of list) out.push((acc += v) / total);
  return out;
}

export function dividers(id: LayoutId, sizes: Sizes): Divider[] {
  const g = gridOf(id);
  const ce = edges(sizes.cols);
  const re = edges(sizes.rows);
  const out: Divider[] = [];
  for (let j = 0; j + 1 < g[0].length; j++) {
    const rows = g.flatMap((row, r) => (row[j] !== row[j + 1] ? [r] : []));
    if (rows.length) out.push({ axis: "col", index: j, at: ce[j + 1], from: re[rows[0]], to: re[rows[rows.length - 1] + 1] });
  }
  for (let i = 0; i + 1 < g.length; i++) {
    const cols = g[i].flatMap((x, c) => (x !== g[i + 1][c] ? [c] : []));
    if (cols.length) out.push({ axis: "row", index: i, at: re[i + 1], from: ce[cols[0]], to: ce[cols[cols.length - 1] + 1] });
  }
  return out;
}

/** A divider dragged to `at` (share of the whole width or height): only the two tracks beside it change, and
 *  each keeps at least MIN_SHARE. */
export function moveDivider(sizes: Sizes, axis: "col" | "row", index: number, at: number): Sizes {
  const list = (axis === "col" ? sizes.cols : sizes.rows).slice();
  if (index < 0 || index + 1 >= list.length) return sizes;
  const total = sum(list);
  const lo = sum(list.slice(0, index)) / total;
  const hi = sum(list.slice(0, index + 2)) / total;
  if (hi - lo <= 2 * MIN_SHARE) return sizes;
  const b = Math.min(hi - MIN_SHARE, Math.max(lo + MIN_SHARE, at));
  list[index] = (b - lo) * total;
  list[index + 1] = (hi - b) * total;
  return axis === "col" ? { cols: list, rows: sizes.rows.slice() } : { cols: sizes.cols.slice(), rows: list };
}

/** The two tracks beside a divider share their space evenly again (double-click on it). */
export function centerDivider(sizes: Sizes, axis: "col" | "row", index: number): Sizes {
  const list = axis === "col" ? sizes.cols : sizes.rows;
  if (index < 0 || index + 1 >= list.length) return sizes;
  const e = edges(list);
  return moveDivider(sizes, axis, index, (e[index] + e[index + 2]) / 2);
}

// ----------------------------------------------------------------------------- saved data
const INST = /^[A-Z0-9][A-Z0-9-]{0,39}$/;
const TAB_ID = /^[a-z0-9-]{1,40}$/;

function cleanCell(v: unknown, isBar: (b: string) => boolean): Cell | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.instId !== "string" || !INST.test(o.instId) || typeof o.bar !== "string" || !isBar(o.bar)) return null;
  const z = o.zoom;
  const zoom = typeof z === "number" && Number.isFinite(z) && z >= 0.5 && z <= 200 ? Math.round(z * 100) / 100 : null;
  return { instId: o.instId, bar: o.bar, zoom };
}

function cleanSizes(v: unknown, id: LayoutId): Sizes {
  const even = evenSizes(id);
  if (!v || typeof v !== "object") return even;
  const o = v as Record<string, unknown>;
  const ok = (a: unknown, n: number): a is number[] =>
    Array.isArray(a) && a.length === n && a.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0);
  if (!ok(o.cols, even.cols.length) || !ok(o.rows, even.rows.length)) return even;
  // a share below the minimum (an edited file) puts that layout back to even
  const shares = (a: number[]) => a.map((x) => x / sum(a));
  if ([...shares(o.cols), ...shares(o.rows)].some((x) => x < MIN_SHARE - 1e-9)) return even;
  return { cols: o.cols.slice(), rows: o.rows.slice() };
}

function cleanTab(v: unknown, fallback: Cell, isBar: (b: string) => boolean): Tab | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const layout: LayoutId = isLayout(o.layout) ? o.layout : "1";
  const cells = (Array.isArray(o.cells) ? o.cells : [])
    .slice(0, MAX_CELLS)
    .map((c) => cleanCell(c, isBar))
    .filter((c): c is Cell => c !== null);
  if (!cells.length) cells.push({ ...fallback });
  while (cells.length < cellCount(layout)) cells.push({ ...cells[0] });
  const a = o.active;
  const active = typeof a === "number" && Number.isInteger(a) && a >= 0 && a < cellCount(layout) ? a : 0;
  const id = typeof o.id === "string" && TAB_ID.test(o.id) ? o.id : newTabId();
  return { id, layout, cells, active, sizes: cleanSizes(o.sizes, layout) };
}

/** Whatever was saved as a valid set of tabs; nothing (or nothing usable) saved: one tab showing `fallback`. */
export function cleanTabs(raw: unknown, fallback: Cell, isBar: (b: string) => boolean): Tabs {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const tabs: Tab[] = [];
  const ids = new Set<string>();
  for (const v of Array.isArray(o.tabs) ? o.tabs.slice(0, MAX_TABS) : []) {
    const t = cleanTab(v, fallback, isBar);
    if (!t) continue;
    while (ids.has(t.id)) t.id = newTabId();
    ids.add(t.id);
    tabs.push(t);
  }
  if (!tabs.length) tabs.push(newTab(fallback));
  const a = o.active;
  const active = typeof a === "number" && Number.isInteger(a) && a >= 0 && a < tabs.length ? a : 0;
  return { tabs, active };
}
