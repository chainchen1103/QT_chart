// Price zones found in the bars: fair value gaps (FVG) and order blocks (OB).
// Pure functions (no DOM), unit-tested in tests/zones.test.ts. New zones need closed bars only, so they
// never appear and then vanish; a zone can end on the bar that is still forming (price got there).

import type { Candle } from "../core/api.ts";

/** A zone from bar `from` (UTC seconds) running right until `to` (the bar that ended it) or until now. */
export type Zone = { from: number; to: number | null; top: number; bottom: number; dir: 1 | -1 };

export type FvgOptions = {
  /** Use candle bodies instead of wicks for the gap. */
  body: boolean;
  /** Smallest gap kept, in % of price (0 keeps all). */
  minPct: number;
};

/**
 * Fair value gaps: three bars where the first and the third don't overlap. Bullish: the low of bar 3 is
 * above the high of bar 1, and the gap is [high 1, low 3]; bearish mirrors. The zone starts at the middle
 * bar, appears once bar 3 has closed, and ends (filled) when a later bar trades through its far side: a low
 * at or under the bottom of a bullish gap, a high at or over the top of a bearish one.
 */
export function findFvgs(bars: Candle[], o: FvgOptions): Zone[] {
  const out: Zone[] = [];
  const open: Zone[] = [];
  const top = (c: Candle) => (o.body ? Math.max(c.open, c.close) : c.high);
  const bot = (c: Candle) => (o.body ? Math.min(c.open, c.close) : c.low);
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i];
    for (let k = open.length - 1; k >= 0; k--) {
      const z = open[k];
      if ((z.dir === 1 && c.low <= z.bottom) || (z.dir === -1 && c.high >= z.top)) {
        z.to = c.time;
        open.splice(k, 1);
      }
    }
    if (i < 2 || !c.confirmed) continue;
    const a = bars[i - 2];
    const from = bars[i - 1].time;
    const minGap = (c.close * Math.max(0, o.minPct)) / 100;
    let z: Zone | null = null;
    if (bot(c) > top(a) && bot(c) - top(a) >= minGap) z = { from, to: null, top: bot(c), bottom: top(a), dir: 1 };
    else if (top(c) < bot(a) && bot(a) - top(c) >= minGap) z = { from, to: null, top: bot(a), bottom: top(c), dir: -1 };
    if (z) {
      out.push(z);
      open.push(z);
    }
  }
  return out;
}

export type ObOptions = {
  /** Bars on each side of a swing high or low. */
  swing: number;
  /** How many bars before the breakout to look for the block. */
  lookback: number;
};

/** A high (dir 1) or low (dir -1) strictly beyond the `n` bars on each side. */
function isPivot(bars: Candle[], h: number, n: number, dir: 1 | -1): boolean {
  const v = dir === 1 ? bars[h].high : bars[h].low;
  for (let k = h - n; k <= h + n; k++) {
    if (k === h) continue;
    const w = dir === 1 ? bars[k].high : bars[k].low;
    if (dir === 1 ? w >= v : w <= v) return false;
  }
  return true;
}

/**
 * Order blocks. A swing high is a high strictly above the `swing` bars on each side, known once those
 * later bars have closed. When a bar closes above the most recent unbroken swing high, the last down bar
 * (close < open) among the `lookback` bars before it is a bullish block, zone = that bar's [low, high].
 * Every unbroken swing high under that close is used up. Bearish mirrors with swing lows and up bars.
 * A block ends (broken) when a later bar closes beyond it: under its low (bullish) or over its high (bearish).
 */
export function findOrderBlocks(bars: Candle[], o: ObOptions): Zone[] {
  const n = Math.max(1, Math.round(o.swing));
  const look = Math.max(1, Math.round(o.lookback));
  const out: Zone[] = [];
  const live: Zone[] = [];
  let highs: number[] = []; // unbroken swing highs, in the order they became known
  let lows: number[] = [];
  const block = (i: number, dir: 1 | -1): Zone | null => {
    for (let k = i - 1; k >= Math.max(0, i - look); k--) {
      const b = bars[k];
      if (dir === 1 ? b.close < b.open : b.close > b.open) {
        if (out.some((z) => z.dir === dir && z.from === b.time)) return null; // same block again
        return { from: b.time, to: null, top: b.high, bottom: b.low, dir };
      }
    }
    return null;
  };
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i];
    if (!c.confirmed) continue; // everything below works on closes
    for (let k = live.length - 1; k >= 0; k--) {
      const z = live[k];
      if ((z.dir === 1 && c.close < z.bottom) || (z.dir === -1 && c.close > z.top)) {
        z.to = c.time;
        live.splice(k, 1);
      }
    }
    const h = i - n;
    if (h >= n) {
      if (isPivot(bars, h, n, 1)) highs.push(bars[h].high);
      if (isPivot(bars, h, n, -1)) lows.push(bars[h].low);
    }
    if (highs.length && c.close > highs[highs.length - 1]) {
      const z = block(i, 1);
      if (z) {
        out.push(z);
        live.push(z);
      }
    }
    if (lows.length && c.close < lows[lows.length - 1]) {
      const z = block(i, -1);
      if (z) {
        out.push(z);
        live.push(z);
      }
    }
    highs = highs.filter((p) => p >= c.close);
    lows = lows.filter((p) => p <= c.close);
  }
  return out;
}

export type LevelOptions = {
  /** Bars on each side of a swing high or low. */
  swing: number;
};

/**
 * Support and resistance: a swing high (strictly above the `swing` bars on each side) is a resistance level and
 * a swing low a support level, starting at the swing bar once the bars after it have closed. A level ends
 * (broken) when a later bar closes beyond it: above a resistance, below a support.
 * As zones: top = bottom = the level; dir 1 = support, -1 = resistance.
 */
export function findLevels(bars: Candle[], o: LevelOptions): Zone[] {
  const n = Math.max(1, Math.round(o.swing));
  const out: Zone[] = [];
  const live: Zone[] = [];
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i];
    if (!c.confirmed) continue; // works on closes
    for (let k = live.length - 1; k >= 0; k--) {
      const z = live[k];
      if ((z.dir === 1 && c.close < z.bottom) || (z.dir === -1 && c.close > z.top)) {
        z.to = c.time;
        live.splice(k, 1);
      }
    }
    const h = i - n;
    if (h < n) continue;
    const add = (z: Zone) => {
      out.push(z);
      live.push(z);
    };
    if (isPivot(bars, h, n, 1)) add({ from: bars[h].time, to: null, top: bars[h].high, bottom: bars[h].high, dir: -1 });
    if (isPivot(bars, h, n, -1)) add({ from: bars[h].time, to: null, top: bars[h].low, bottom: bars[h].low, dir: 1 });
  }
  return out;
}

/** The newest `max` zones still running in each direction, plus (if asked) the newest `max` ended ones. */
export function pickZones(zones: Zone[], max: number, withEnded: boolean): Zone[] {
  const pick = (dir: 1 | -1, ended: boolean) => zones.filter((z) => z.dir === dir && (z.to !== null) === ended).slice(-max);
  const out = [...pick(1, false), ...pick(-1, false)];
  if (withEnded) out.push(...pick(1, true), ...pick(-1, true));
  return out;
}
