// Bars for one chart: which symbol and timeframe it shows, the first load, older history when the chart is
// scrolled left (up to a cap, to bound memory), live candles, and repair after a gap in the live feed (e.g.
// the computer slept). `bars` and `times` belong to the feed; everyone else reads them. Which live candles
// reach it is decided outside (the workspace streams every chart on screen).

import { getCandles, type Candle } from "../core/api.ts";
import { fmtFixed } from "../core/format.ts";
import { TIMEFRAMES, type Tf } from "../core/timeframes.ts";
import type { Catalog } from "./catalog.ts";

const INITIAL_BARS = 500;
const OLDER_BARS = 500;
/** At most this many bars stay loaded (older history stops there): memory stays bounded. */
export const MAX_BARS = 20000;

export type FeedEvents = {
  /** Symbol or timeframe changed, its bars are on the way (`symbol`: the symbol itself changed). */
  switching(symbol: boolean): void;
  /** Bars replaced: first load (`first`), older bars put in front (`older`, how many), or repaired after a gap. */
  loaded(kind: "first" | "older" | "repair", added: number): void;
  /** A live candle was applied: the newest bar changed, or a new one started. */
  tick(c: Candle, newBar: boolean): void;
  /** The first bars of a symbol or timeframe are on the way (true); that load is over, however it went (false). */
  busy(on: boolean): void;
  error(text: string): void;
  /** Something worth a line in the status bar for a moment. */
  note(text: string): void;
};

export const tfOf = (bar: string): Tf => TIMEFRAMES.find((t) => t.bar === bar) ?? TIMEFRAMES[2];

export class MarketFeed {
  instId: string;
  bar: string;
  bars: Candle[] = [];
  times: number[] = [];
  /** Price decimals and price step of the symbol on screen. */
  decimals = 2;
  tick = 0.01;
  private seq = 0; // bumps on every switch, so late answers for the old symbol are dropped
  /** The bars belong to instId / bar (not while a switch is loading): live candles may be applied. */
  private ready = false;
  private loadingOlder = false;
  private noMoreHistory = false;
  private repairing = false;
  private readonly catalog: Catalog;
  private readonly on: FeedEvents;

  constructor(catalog: Catalog, on: FeedEvents, instId: string, bar: string) {
    this.catalog = catalog;
    this.on = on;
    this.instId = instId;
    this.bar = tfOf(bar).bar;
  }

  get tf(): Tf {
    return tfOf(this.bar);
  }

  fmtPrice = (v: number): string => fmtFixed(v, this.decimals);
  roundToTick(p: number): number {
    return this.tick > 0 ? Number((Math.round(p / this.tick) * this.tick).toFixed(this.decimals)) : p;
  }

  /** Show this symbol and timeframe: load its latest bars (live candles are applied once they are in). */
  async switchTo(instId: string, bar: string) {
    const symbol = instId !== this.instId || !this.bars.length;
    this.instId = instId;
    this.bar = tfOf(bar).bar;
    const my = ++this.seq;
    this.ready = false;
    this.noMoreHistory = false;
    this.setPrecision();
    this.on.switching(symbol);
    this.on.busy(true);
    try {
      const data = await getCandles(this.instId, this.bar, null, INITIAL_BARS);
      if (my !== this.seq) return;
      this.setBars(data);
      this.ready = true;
      this.on.loaded("first", data.length);
    } catch (e) {
      if (my === this.seq) this.on.error(`載入 ${instId} 失敗：${e}`);
    } finally {
      this.on.busy(false);
    }
  }

  /** Price decimals and step from the symbol list (again once the list has arrived). */
  setPrecision() {
    this.decimals = this.catalog.decimals(this.instId);
    this.tick = this.catalog.tick(this.instId);
  }

  /** The chart is gone: answers still on the way are dropped. */
  dispose() {
    this.seq++;
    this.ready = false;
  }

  /** Older bars in front, when the chart is scrolled near its left end. */
  async loadOlder() {
    if (this.loadingOlder || this.noMoreHistory || !this.bars.length) return;
    if (this.bars.length >= MAX_BARS) {
      this.noMoreHistory = true;
      this.on.note(`最多載入 ${MAX_BARS.toLocaleString()} 根 K 線，不再往前載入`);
      return;
    }
    this.loadingOlder = true;
    const my = this.seq;
    try {
      const older = await getCandles(this.instId, this.bar, this.bars[0].time * 1000, OLDER_BARS);
      if (my !== this.seq) return;
      const fresh = older.filter((c) => c.time < this.bars[0].time);
      if (!fresh.length) {
        this.noMoreHistory = true;
        return;
      }
      this.setBars(fresh.concat(this.bars));
      this.on.loaded("older", fresh.length);
    } catch (e) {
      if (my === this.seq) this.on.error(`載入更早的 K 線失敗：${e}`);
    } finally {
      this.loadingOlder = false;
    }
  }

  /** A live candle of this symbol and timeframe. */
  live(c: Candle) {
    if (!this.ready) return;
    const last = this.bars[this.bars.length - 1];
    if (!last || c.time < last.time) return;
    if (c.time > last.time + this.tf.sec * 1.5) {
      void this.repair(); // bars were missed (the computer slept, the network dropped)
      return;
    }
    const newBar = c.time !== last.time;
    if (newBar) {
      this.bars.push(c);
      this.times.push(c.time);
    } else {
      this.bars[this.bars.length - 1] = c;
    }
    this.on.tick(c, newBar);
  }

  /** After a gap in the live feed: merge the latest bars from REST, once at a time. */
  private async repair() {
    if (this.repairing) return;
    this.repairing = true;
    const my = this.seq;
    try {
      const recent = await getCandles(this.instId, this.bar, null, 300);
      if (my !== this.seq || !recent.length) return;
      const cut = recent[0].time;
      this.setBars(this.bars.filter((c) => c.time < cut).concat(recent));
      this.on.loaded("repair", 0);
    } catch (e) {
      if (my === this.seq) this.on.error(`補抓最新 K 線失敗：${e}`);
    } finally {
      this.repairing = false;
    }
  }

  private setBars(bars: Candle[]) {
    this.bars = bars.length > MAX_BARS ? bars.slice(bars.length - MAX_BARS) : bars;
    this.times = this.bars.map((c) => c.time);
  }
}
