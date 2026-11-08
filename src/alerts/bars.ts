// Bars of the timeframes that indicator alerts run on, for their symbols: fetched once with enough bars before
// them for the indicator, then kept current from the 1-minute bars the alerts already stream. Pure apart from
// the fetch it is given, so it can be tested.

import type { Candle } from "../core/api.ts";
import { foldTick, tfSec } from "../core/timeframes.ts";

type Entry = { bars: Candle[]; loading: boolean; retryAt: number; need: number };

const MAX_FETCH = 3000; // the backend's limit per request
const RETRY_MS = 15000;

export class AlertBars {
  private readonly map = new Map<string, Entry>();
  private readonly fetch: (instId: string, bar: string, count: number) => Promise<Candle[]>;
  private readonly nowMs: () => number;

  constructor(fetch: (instId: string, bar: string, count: number) => Promise<Candle[]>, nowMs: () => number = Date.now) {
    this.fetch = fetch;
    this.nowMs = nowMs;
  }

  static key(instId: string, bar: string): string {
    return `${instId} ${bar}`;
  }

  /** The bars (the last one still forming), or null while they load: asked for, with `need` bars at least. */
  get(instId: string, bar: string, need: number): Candle[] | null {
    const key = AlertBars.key(instId, bar);
    let e = this.map.get(key);
    if (!e) {
      e = { bars: [], loading: false, retryAt: 0, need };
      this.map.set(key, e);
    }
    if (need > e.need) {
      e.need = need;
      if (e.bars.length < Math.min(need, MAX_FETCH)) e.bars = []; // an alert wants more of them: again
    }
    if (e.bars.length) return e.bars;
    this.load(key, instId, bar, e);
    return null;
  }

  private load(key: string, instId: string, bar: string, e: Entry) {
    if (e.loading || this.nowMs() < e.retryAt) return;
    e.loading = true;
    this.fetch(instId, bar, Math.min(MAX_FETCH, e.need + 5))
      .then((got) => {
        if (this.map.get(key) === e) e.bars = got.map((c) => ({ ...c }));
      })
      .catch(() => {
        e.retryAt = this.nowMs() + RETRY_MS;
      })
      .finally(() => {
        e.loading = false;
      });
  }

  /** A 1-minute bar of a symbol, folded into each of its timeframes. Returns the timeframes where a bar closed (a
   *  new one began). A gap of more than a bar (the computer slept) means fetching them again. */
  fold(instId: string, c: Candle): Set<string> {
    const closed = new Set<string>();
    for (const [key, e] of this.map) {
      const [id, bar] = key.split(" ");
      if (id !== instId || !e.bars.length) continue;
      const sec = tfSec(bar);
      const last = e.bars[e.bars.length - 1];
      if (c.time > last.time + 2 * sec) {
        e.bars = [];
        continue;
      }
      if (foldTick(e.bars, sec, c, 60)) closed.add(bar);
      if (e.bars.length > MAX_FETCH + 500) e.bars.splice(0, e.bars.length - MAX_FETCH);
    }
    return closed;
  }

  /** Forget every symbol and timeframe but these (keys from AlertBars.key). */
  keep(keys: Set<string>) {
    for (const k of [...this.map.keys()]) if (!keys.has(k)) this.map.delete(k);
  }
}
