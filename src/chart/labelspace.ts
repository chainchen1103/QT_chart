// Room for the text written on a chart, so labels don't cover each other: drawings' labels (a position's boxes,
// Fib and channel levels, R lines), indicator lines' names, the 高 / 低 tags at the price scale and alert bells.
// Each layer says what it will write when its views update (a box's size and the places it may go, best first)
// and paints each label where it was put. Places are handed out once per repaint, over every layer together,
// lowest priority number first (PRIO): what can't move, the bells of price alerts, labels that stay with their
// line, a position's info at its entry, labels that may move, R lines' names, the bells of drawings, indicator
// lines' names. A label takes the first of its places that covers nothing placed before it (nor what it should
// keep off, such as candles); failing that, it slides from its places past what is in the way when it may (an
// indicator line's name slides left along its line); with no free place it takes the one where it covers least,
// or is left out when it is optional.

export type Box = { x: number; y: number; w: number; h: number };
export type Slide = "left" | "right" | "up" | "down";
/** How far a label may slide: its left edge (sliding left or right) or its top (up or down) stays from `min` to `max`. */
export type Range = { min: number; max: number };
/** A top-left corner to try; `slide` and `range` in place of the label's own for sliding from here ("none": not). */
export type Spot = { x: number; y: number; slide?: Slide | "none"; range?: Range };

export type LabelAsk = {
  /** Unique within its layer. */
  key: string;
  w: number;
  h: number;
  /** Places to try, best first. */
  at: readonly Spot[];
  /** When none of them is free: from each place, slide this way past what is in the way. */
  slide?: Slide;
  range?: Range;
  /** What it should keep off besides other labels (a position's result: the candles). */
  avoid?: (b: Box) => boolean;
  /** Left out when it has no free place (rather than covering something). */
  optional?: boolean;
  /** Lower numbers are placed first (PRIO). */
  prio: number;
};

export const PRIO = {
  /** The 高 / 低 tags. */
  fixed: 0,
  /** Bells of price alerts, at the price scale. */
  scaleBell: 5,
  /** Drawings' labels that stay with their line: Fib and channel levels, a trend angle, a regression's R. */
  pinned: 20,
  /** A position's info at its entry. */
  anchored: 21,
  /** Drawings' labels that may move: a position's take-profit, stop and result, the info line's box. */
  drawing: 22,
  /** The names of a position's R lines. */
  minor: 24,
  /** Bells of drawings that have alerts. */
  bell: 30,
  /** Names of indicator lines (support and resistance). */
  indicator: 40,
} as const;

/** Kept free between labels, px. */
const GAP = 2;
const MAX_SLIDES = 40;

export class LabelSpace {
  private readonly asks = new Map<string, readonly LabelAsk[]>();
  private placed: Map<string, Map<string, Box>> | null = null;
  private readonly size: () => { width: number; height: number };

  /** `size`: the price pane's size. */
  constructor(size: () => { width: number; height: number }) {
    this.size = size;
  }

  /** All of a layer's labels, in place of what it asked for before. */
  set(layer: string, asks: readonly LabelAsk[]) {
    this.asks.set(layer, asks);
    this.placed = null;
  }

  /** Where a label of a layer went (null: left out, or not asked for). Places are handed out on the first call
   *  after a change. */
  at(layer: string, key: string): Box | null {
    this.placed ??= layout(this.asks, this.size());
    return this.placed.get(layer)?.get(key) ?? null;
  }
}

/** Places for every label of every layer (by layer, then key), in a pane `width` × `height`. */
export function layout(asks: ReadonlyMap<string, readonly LabelAsk[]>, size: { width: number; height: number }): Map<string, Map<string, Box>> {
  const all: { layer: string; ask: LabelAsk; n: number }[] = [];
  for (const [layer, list] of asks) for (const ask of list) all.push({ layer, ask, n: all.length });
  all.sort((a, b) => a.ask.prio - b.ask.prio || a.n - b.n);
  const taken: Box[] = [];
  const out = new Map<string, Map<string, Box>>();
  for (const { layer, ask } of all) {
    const b = place(ask, taken, size.width, size.height);
    if (!b) continue;
    taken.push(b);
    let m = out.get(layer);
    if (!m) out.set(layer, (m = new Map()));
    m.set(ask.key, b);
  }
  return out;
}

function place(a: LabelAsk, taken: readonly Box[], W: number, H: number): Box | null {
  const best = { box: null as Box | null, cost: Infinity };
  /** What is in the way at `b`, whether it covers what it should keep off, and what it costs there: covering
   *  another label, then being off the pane (a label out of sight is worse than one partly covered), then
   *  covering what it keeps off. */
  const judge = (b: Box) => {
    const hits = taken.filter((t) => near(b, t));
    const covers = !!a.avoid && a.avoid(b);
    const cost = hits.reduce((s, t) => s + overlap(b, t), 0) + 2 * outside(b, W, H) + (covers ? 0.3 * b.w * b.h : 0);
    if (cost < best.cost) {
      best.box = b;
      best.cost = cost;
    }
    return { hits, covers, free: !hits.length && cost === 0 };
  };
  // each place as it is first
  for (const p of a.at) {
    const b = { x: p.x, y: p.y, w: a.w, h: a.h };
    if (judge(b).free) return b;
  }
  // then sliding from those that may
  for (const p of a.at) {
    const slide = p.slide === "none" ? undefined : (p.slide ?? a.slide);
    if (!slide) continue;
    const range = p.range ?? a.range;
    let b: Box = { x: p.x, y: p.y, w: a.w, h: a.h };
    for (let k = 0; k < MAX_SLIDES; k++) {
      const j = judge(b);
      if (j.free) return b;
      if (!j.hits.length && !j.covers) break; // free but partly off the pane: sliding on won't help
      if (atEdge(b, slide, W, H)) break;
      b = j.hits.length ? past(b, j.hits, slide) : step(b, slide);
      if (range) {
        const v = slide === "left" || slide === "right" ? b.x : b.y;
        if (v < range.min || v > range.max) break; // slid off what it belongs to
      }
    }
  }
  if (a.optional && best.cost > 0) return null;
  return best.box ?? { x: a.at[0]?.x ?? 0, y: a.at[0]?.y ?? 0, w: a.w, h: a.h };
}

/** `b` moved a bit the way it slides (past what it keeps off, which is not a box). */
function step(b: Box, s: Slide): Box {
  const d = Math.max(8, Math.round((s === "left" || s === "right" ? b.w : b.h) / 4));
  return s === "left" ? { ...b, x: b.x - d } : s === "right" ? { ...b, x: b.x + d } : s === "up" ? { ...b, y: b.y - d } : { ...b, y: b.y + d };
}

/** Closer than GAP (or overlapping). */
function near(a: Box, b: Box): boolean {
  return a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;
}

/** Less than this is rounding, not covering (sizes are fractions of a pixel). */
const EPS = 0.01;

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > EPS && h > EPS ? w * h : 0;
}

function outside(b: Box, W: number, H: number): number {
  const out = b.w * b.h - overlap(b, { x: 0, y: 0, w: W, h: H });
  return out > EPS ? out : 0;
}

function atEdge(b: Box, s: Slide, W: number, H: number): boolean {
  return s === "left" ? b.x <= 0 : s === "right" ? b.x + b.w >= W : s === "up" ? b.y <= 0 : b.y + b.h >= H;
}

/** `b` moved just past everything in `hits`, the way it slides. */
function past(b: Box, hits: Box[], s: Slide): Box {
  switch (s) {
    case "left":
      return { ...b, x: Math.min(...hits.map((t) => t.x)) - GAP - b.w };
    case "right":
      return { ...b, x: Math.max(...hits.map((t) => t.x + t.w)) + GAP };
    case "up":
      return { ...b, y: Math.min(...hits.map((t) => t.y)) - GAP - b.h };
    case "down":
      return { ...b, y: Math.max(...hits.map((t) => t.y + t.h)) + GAP };
  }
}

// ----------------------------------------------------------------------------- measuring text
let measurer: CanvasRenderingContext2D | null = null;
const widths = new Map<string, number>();

/** Width of `text` in `font` (CSS px). Remembered; forgotten when web fonts finish loading, as they change it.
 *  Without a page (tests): about 0.6 em a character, 1 em for Chinese. */
export function textWidth(font: string, text: string): number {
  const key = `${font}\n${text}`;
  const known = widths.get(key);
  if (known !== undefined) return known;
  if (!measurer && typeof document !== "undefined") {
    measurer = document.createElement("canvas").getContext("2d");
    document.fonts?.addEventListener("loadingdone", () => widths.clear());
  }
  if (!measurer) return [...text].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e7f ? 1 : 0.6), 0) * parseFloat(font);
  measurer.font = font;
  const w = measurer.measureText(text).width;
  if (widths.size > 5000) widths.clear();
  widths.set(key, w);
  return w;
}
