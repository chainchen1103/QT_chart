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
    return { error: pct ? `要在 ${min * 100}% 到 ${max * 100}% 之間` : `要在 ${min} 到 ${max} 之間；百分比請加 %，例如 61.8%` };
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
