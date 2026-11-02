// Bars of every timeframe the indicators use, for the symbol on screen.
// The chart's own timeframe is seeded from the chart's bars; older bars (warm-up) and other timeframes are
// fetched from OKX when needed. Live candles from the chart are folded into all of them.

import { getCandles, type Candle } from "../core/api.ts";
import { foldTick, tfSec } from "../core/timeframes.ts";

type Entry = { bars: Candle[]; loading: boolean; exhausted: boolean; error: string | null; retryAt: number };

const MAX_FETCH = 3000; // the Rust side's limit per request
const RETRY_MS = 15000;

export class SourceStore {
  private inst = "";
  private gen = 0; // bumps on every reset, so late answers for another symbol are dropped
  private map = new Map<string, Entry>();

  /** `changed(bar)`: new bars arrived for that timeframe (or loading failed). */
  constructor(private readonly changed: (bar: string) => void) {}

  /** A new symbol: forget everything. */
  reset(inst: string) {
    this.inst = inst;
    this.gen++;
    this.map.clear();
  }

  /** Forget timeframes smaller than the chart's: they no longer get live bars. */
  dropBelow(sec: number) {
    for (const bar of [...this.map.keys()]) if (tfSec(bar) < sec) this.map.delete(bar);
  }

  /** Forget every timeframe except `keep` (after a gap in the live feed, e.g. the computer slept). */
  dropExcept(keep: string) {
    for (const bar of [...this.map.keys()]) if (bar !== keep) this.map.delete(bar);
  }

  get(bar: string): Candle[] | null {
    const e = this.map.get(bar);
    return e && e.bars.length ? e.bars : null;
  }

  status(bar: string): "ok" | "loading" | "error" {
    const e = this.map.get(bar);
    if (e && e.bars.length) return "ok";
    return e && e.error && !e.loading ? "error" : "loading";
  }

  private entry(bar: string): Entry {
    let e = this.map.get(bar);
    if (!e) {
      e = { bars: [], loading: false, exhausted: false, error: null, retryAt: 0 };
      this.map.set(bar, e);
    }
    return e;
  }

  /** The chart's own bars: they replace this timeframe from their first bar on; older bars stay. */
  seed(bar: string, bars: Candle[]) {
    if (!bars.length) return;
    const e = this.entry(bar);
    const first = bars[0].time;
    e.bars = e.bars.filter((c) => c.time < first).concat(bars.map((c) => ({ ...c })));
  }

  /** Make sure `bar` covers from `from` (UTC seconds) up to now; fetches in the background. */
  ensure(bar: string, from: number) {
    const e = this.entry(bar);
    if (e.loading || Date.now() < e.retryAt) return;
    if (e.exhausted || (e.bars.length && e.bars[0].time <= from)) return;
    e.loading = true;
    void this.fetch(bar, e, from);
  }

  private async fetch(bar: string, e: Entry, from: number) {
    const gen = this.gen;
    const sec = tfSec(bar);
    try {
      if (!e.bars.length) {
        const n = Math.min(MAX_FETCH, Math.ceil((Date.now() / 1000 - from) / sec) + 2);
        const got = await getCandles(this.inst, bar, null, n);
        if (gen !== this.gen) return;
        e.bars = got.concat(e.bars.filter((c) => got.length && c.time > got[got.length - 1].time));
        e.exhausted = got.length < n;
      } else {
        const first = e.bars[0].time;
        const n = Math.min(MAX_FETCH, Math.ceil((first - from) / sec) + 2);
        const got = await getCandles(this.inst, bar, first * 1000, n);
        if (gen !== this.gen) return;
        e.bars = got.filter((c) => c.time < e.bars[0].time).concat(e.bars);
        e.exhausted = got.length < n;
      }
      e.error = null;
    } catch (err) {
      if (gen !== this.gen) return;
      e.error = String(err);
      e.retryAt = Date.now() + RETRY_MS;
    } finally {
      if (gen === this.gen) {
        e.loading = false;
        this.changed(bar);
      }
    }
  }

  /** A live candle of the chart's timeframe: fold it into every timeframe at least as large. */
  tick(c: Candle, chartBar: string) {
    const cSec = tfSec(chartBar);
    for (const [bar, e] of this.map) {
      const sec = tfSec(bar);
      if (!e.bars.length || sec < cSec) continue;
      if (foldTick(e.bars, sec, c, cSec) && bar !== chartBar) this.refreshTail(bar, e);
    }
  }

  /** A few seconds after a larger bar closes, take OKX's final numbers for it. */
  private refreshTail(bar: string, e: Entry) {
    const gen = this.gen;
    setTimeout(async () => {
      if (gen !== this.gen || this.map.get(bar) !== e) return;
      try {
        const got = await getCandles(this.inst, bar, null, 3);
        if (gen !== this.gen || this.map.get(bar) !== e || !got.length) return;
        const cut = got[0].time;
        e.bars = e.bars.filter((c) => c.time < cut).concat(got);
        this.changed(bar);
      } catch {
        /* keep the folded bars */
      }
    }, 3000);
  }
}
