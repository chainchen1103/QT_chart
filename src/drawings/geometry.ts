// Pure helpers for the drawing tools (no DOM, no imports), so Node can unit-test them (tests/*.test.ts).

/** A point on the chart: bar start time (UTC seconds) and price. */
export type Anchor = { t: number; p: number };

/**
 * Price of a Fibonacci level. As on TradingView, level 1 sits on the first point and level 0 on the second,
 * so drawing from a swing low to a swing high puts 0.618 at the usual pullback; `reverse` swaps the ends.
 */
export function fibPrice(a: Anchor, b: Anchor, level: number, reverse = false): number {
  return reverse ? a.p + (b.p - a.p) * level : b.p + (a.p - b.p) * level;
}

/**
 * Bar position (logical index) of a time. Inside the loaded bars: the bar that contains the time, so a point
 * drawn on 1-minute bars lands on the 15-minute bar that holds it. Before the first or after the last bar:
 * counted in bar lengths from that end (may be fractional). `times` are ascending bar start times.
 */
export function timeToIndex(times: ArrayLike<number>, t: number, barSec: number): number {
  const n = times.length;
  if (n === 0) return NaN;
  if (t < times[0]) return (t - times[0]) / barSec;
  if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / barSec;
  let lo = 0;
  let hi = n - 1; // times[lo] <= t < times[hi]
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Start time of the bar at a logical index (rounded to a whole bar), extending past either end by bar lengths. */
export function indexToTime(times: ArrayLike<number>, i: number, barSec: number): number {
  const n = times.length;
  const k = Math.round(i);
  if (k < 0) return times[0] + k * barSec;
  if (k > n - 1) return times[n - 1] + (k - (n - 1)) * barSec;
  return times[k];
}

/** A Fibonacci level typed by the user: "0.705", "-0.27", "1.618" or a percentage such as "61.8%". */
export function parseLevel(text: string, min = -10, max = 10): { value: number } | { error: string } {
  const s = text.trim().replace(/\s+/g, "").replace(/％/g, "%");
  if (!s) return { error: "請輸入數值" };
  const pct = s.endsWith("%");
  const num = Number(pct ? s.slice(0, -1) : s);
  if (!s.replace("%", "") || !Number.isFinite(num)) return { error: "不是數字" };
  const v = Math.round((pct ? num / 100 : num) * 1e4) / 1e4;
  if (v < min || v > max) {
    return { error: pct ? `要在 ${min * 100}% 到 ${max * 100}% 之間` : `要在 ${min} 到 ${max} 之間。百分比請加 %，例如 61.8%` };
  }
  return { value: v };
}

/** 0.618 → "0.618", 1 → "1", 0.5000001 → "0.5". */
export function fmtLevel(v: number): string {
  return String(Math.round(v * 1e4) / 1e4);
}

/** "#rrggbb" → "rgba(r,g,b,alpha)". */
export function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Distance from point (px, py) to the segment (ax, ay)–(bx, by). */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
}

/** Distance from (px, py) to the ray that starts at a and passes through b. */
export function distToRay(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const u = len2 === 0 ? 0 : Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2);
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
}

/** Distance from (px, py) to the endless line through a and b. */
export function distToLine(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(px - ax, py - ay);
  return Math.abs((px - ax) * dy - (py - ay) * dx) / len;
}

/** A time span: "3天 4時", "3時 45分", "45分", "0分". */
export function fmtSpan(sec: number): string {
  const s = Math.round(Math.abs(sec) / 60) * 60;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h ? `${d}天 ${h}時` : `${d}天`;
  if (h > 0) return m ? `${h}時 ${m}分` : `${h}時`;
  return `${m}分`;
}

/** Screen angle of a → b in degrees, counter-clockwise from pointing right (screen y grows downward). */
export function screenAngle(ax: number, ay: number, bx: number, by: number): number {
  return (Math.atan2(ay - by, bx - ax) * 180) / Math.PI;
}

/** Long when the stop is under the entry, short when above. */
export const positionDir = (entry: number, stop: number): 1 | -1 => (stop <= entry ? 1 : -1);

/** A position's direction: its own when it has one (an order was placed from it, or it comes from OKX: its stop
 *  may then be past the entry, a profit locked in), else from where the stop is. */
export const posDir = (d: { a: Anchor; b: Anchor; dir?: 1 | -1 }): 1 | -1 => d.dir ?? positionDir(d.a.p, d.b.p);

/** Keep a take-profit on the profit side of the entry (at the entry at worst). */
export function clampTarget(entry: number, stop: number, target: number): number {
  return positionDir(entry, stop) === 1 ? Math.max(target, entry) : Math.min(target, entry);
}

/** Reward to risk: how many R the take-profit is from the entry. */
export function rewardRisk(entry: number, stop: number, target: number): number {
  const r = Math.abs(entry - stop);
  return r > 0 ? Math.abs(target - entry) / r : 0;
}

/**
 * The R lines to draw: entry ± k·R toward the profit side, only up to the take-profit (a line on the
 * take-profit itself is left out: the take-profit line is there already).
 */
export function rLevels(entry: number, stop: number, target: number, ks: number[]): { k: number; price: number }[] {
  const r = Math.abs(entry - stop);
  if (!(r > 0)) return [];
  const dir = positionDir(entry, stop);
  const reach = Math.abs(target - entry);
  const eps = r * 1e-9;
  return [...ks]
    .sort((a, b) => a - b)
    .filter((k) => k > 0 && k * r < reach - eps)
    .map((k) => ({ k, price: entry + dir * k * r }));
}

/** An R multiple typed by the user: "2", "1.5", "3R". */
export function parseR(text: string): { value: number } | { error: string } {
  const s = text.trim().replace(/[rR]$/, "").trim();
  if (!s) return { error: "請輸入數值" };
  const v = Number(s);
  if (!Number.isFinite(v)) return { error: "不是數字" };
  const r = Math.round(v * 100) / 100;
  if (r <= 0 || r > 20) return { error: "要在 0 到 20 之間，例如 3" };
  return { value: r };
}

/**
 * Shift while drawing: b moved so the line from a runs horizontal, vertical or at 45° on screen (the nearest
 * of the eight directions), as far along it as b was. `dir`: "h" horizontal, "v" vertical, "d" diagonal.
 */
export function snapAngle(ax: number, ay: number, bx: number, by: number): { x: number; y: number; dir: "h" | "v" | "d" } {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return { x: bx, y: by, dir: "h" };
  const k = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  const ux = Math.round(Math.cos((k * Math.PI) / 4)); // -1, 0 or 1 along each axis
  const uy = Math.round(Math.sin((k * Math.PI) / 4));
  if (uy === 0) return { x: bx, y: ay, dir: "h" };
  if (ux === 0) return { x: ax, y: by, dir: "v" };
  const len = (dx * ux + dy * uy) / 2; // projection onto (ux, uy) / √2, in steps along each axis
  return { x: ax + ux * len, y: ay + uy * len, dir: "d" };
}

/** Shift while drawing a rectangle: b moved onto the nearer 45° diagonal through a, so the box is a square. */
export function snapSquare(ax: number, ay: number, bx: number, by: number): { x: number; y: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const s = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: ax + (dx < 0 ? -s : s), y: ay + (dy < 0 ? -s : s) };
}

/** Shift while moving: only across or only up and down, whichever way the mouse went further. */
export const lockAxis = (dx: number, dy: number): "h" | "v" => (Math.abs(dx) >= Math.abs(dy) ? "h" : "v");

// ----------------------------------------------------------------------------- channels
/** A line from one point to another (a channel's lines run from its first point's time to its second's). */
export type Line2 = [Anchor, Anchor];
/** The channels whose second line is placed by hand: parallel to the first, level, or mirroring it. */
export type HandChannel = "channel" | "flat" | "disjoint";

/** Price at time t on the line through a and b, continued past them (a's price when they share a time). */
export function priceOnLine(a: Anchor, b: Anchor, t: number): number {
  return b.t === a.t ? a.p : a.p + ((b.p - a.p) * (t - a.t)) / (b.t - a.t);
}

/** A channel's second line, from a's time to b's, starting at c.p: parallel to a–b, level, or mirrored (the
 *  same move the other way). */
export function secondLine(kind: HandChannel, a: Anchor, b: Anchor, c: Anchor): Line2 {
  const rise = b.p - a.p;
  return [{ t: a.t, p: c.p }, { t: b.t, p: kind === "channel" ? c.p + rise : kind === "flat" ? c.p : c.p - rise }];
}

/** The c.p that puts a channel's second line through point pt (placing or dragging that line). */
export function secondThrough(kind: HandChannel, a: Anchor, b: Anchor, pt: Anchor): number {
  const k = b.t === a.t ? 0 : (b.p - a.p) / (b.t - a.t); // the first line's slope, price per second
  const s = kind === "channel" ? k : kind === "flat" ? 0 : -k;
  return pt.p - s * (pt.t - a.t);
}

/** A regression trend's lines: `half` above and below the fitted line a–b. */
export const bandLines = (a: Anchor, b: Anchor, half: number): [Line2, Line2] => [
  [{ t: a.t, p: a.p - half }, { t: b.t, p: b.p - half }],
  [{ t: a.t, p: a.p + half }, { t: b.t, p: b.p + half }],
];

/** A channel's two lines as [lower, upper]: the one lower halfway along is the lower one. */
export function lowerUpper(l1: Line2, l2: Line2): [Line2, Line2] {
  const m1 = l1[0].p + l1[1].p; // twice the price halfway
  const m2 = l2[0].p + l2[1].p;
  return (m1 !== m2 ? m1 < m2 : l1[0].p <= l2[0].p) ? [l1, l2] : [l2, l1];
}

/** The line `k` channel widths up from the lower line, at each end: 0 the lower line, 1 the upper one, 0.5
 *  halfway, −1 one width under the lower line. Where the lines aren't parallel, the width of each end. */
export function widthLine(lo: Line2, up: Line2, k: number): Line2 {
  return [
    { t: lo[0].t, p: lo[0].p + k * (up[0].p - lo[0].p) },
    { t: lo[1].t, p: lo[1].p + k * (up[1].p - lo[1].p) },
  ];
}

/** A line fitted to closes: the fitted price at the two ends asked for, the closes' standard deviation from it
 *  (divided by n − 1, as TradingView's linear regression channel) and Pearson's R of the closes against time. */
export type Fit = { p0: number; p1: number; sd: number; r: number };

/**
 * Least squares through the closes of bars i0 to i1 (logical indexes, either order; `close(i)` for 0 ≤ i < n).
 * Bars past the newest one are left out, and the line goes on to i1. null when the first bar isn't loaded or
 * fewer than two bars are left.
 */
export function fitLine(n: number, close: (i: number) => number, i0: number, i1: number): Fit | null {
  const lo = Math.round(Math.min(i0, i1));
  const hi = Math.min(n - 1, Math.round(Math.max(i0, i1)));
  if (!(lo >= 0) || !(hi - lo >= 1)) return null;
  const m = hi - lo + 1;
  let sy = 0;
  for (let i = lo; i <= hi; i++) sy += close(i);
  const mx = (lo + hi) / 2;
  const my = sy / m;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = lo; i <= hi; i++) {
    const dx = i - mx;
    const dy = close(i) - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxy / sxx;
  const at = (i: number) => my + slope * (i - mx);
  const ss = Math.max(0, syy - slope * sxy); // what the line leaves unexplained
  return { p0: at(i0), p1: at(i1), sd: Math.sqrt(ss / (m - 1)), r: syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0 };
}
