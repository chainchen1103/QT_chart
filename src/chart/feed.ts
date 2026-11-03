// Bars for one chart: which symbol and timeframe it shows, the first load, older history when the chart is
// scrolled left (up to a cap, to bound memory, unless the user lifted it), live candles, and repair after a gap
// in the live feed (e.g. the computer slept). And bar replay: the bars after a chosen one are held back and
// shown one at a time. `bars` and `times` (the bars on screen) belong to the feed; everyone else reads them.
// Which live candles reach it is decided outside (the workspace streams every chart on screen).

import { getCandles, type Candle } from "../core/api.ts";
import { fmtFixed } from "../core/format.ts";
import { findTf, type Tf } from "../core/timeframes.ts";
import type { Catalog } from "./catalog.ts";

const INITIAL_BARS = 500;
const OLDER_BARS = 500;
/** At most this many bars stay loaded (older history stops there), unless the user turned the cap off. */
export const MAX_BARS = 20000;
/** A replay that starts further back than the bars loaded loads older ones, at most this many times. */
const REPLAY_LOADS = 40;

export type FeedEvents = {
  /** Symbol or timeframe changed, its bars are on the way (`symbol`: the symbol itself changed). */
  switching(symbol: boolean): void;
  /** Bars replaced: first load (`first`), older bars put in front (`older`, how many), repaired after a gap,
   *  or a replay started or ended (`replay`). */
  loaded(kind: "first" | "older" | "repair" | "replay", added: number): void;
  /** A live candle was applied (or, in a replay, the next bar shown): the newest bar changed, or a new one started. */
  tick(c: Candle, newBar: boolean): void;
  /** The first bars of a symbol or timeframe are on the way (true); that load is over, however it went (false). */
  busy(on: boolean): void;
  error(text: string): void;
  /** Something worth a line in the status bar for a moment. */
  note(text: string): void;
};

export const tfOf = (bar: string): Tf => findTf(bar) ?? findTf("15m")!;

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
  /** How many bars may stay loaded (Infinity: no cap). */
  private readonly limit: () => number;
  /** Replay: the bars after the one on screen last, held back (null: not replaying). */
  private hidden: Candle[] | null = null;
  /** Replay: where it was, kept while another symbol or timeframe loads. */
  private replayAt: number | null = null;

  constructor(catalog: Catalog, on: FeedEvents, instId: string, bar: string, limit: () => number = () => MAX_BARS) {
    this.catalog = catalog;
    this.on = on;
    this.instId = instId;
    this.bar = tfOf(bar).bar;
    this.limit = limit;
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
    if (this.hidden) this.replayAt = this.times[this.times.length - 1] ?? null; // the replay goes on there
    this.hidden = null;
    this.setPrecision();
    this.on.switching(symbol);
    this.on.busy(true);
    try {
      const data = await getCandles(this.instId, this.bar, null, INITIAL_BARS);
      if (my !== this.seq) return;
      this.setBars(data);
      this.ready = true;
      // a replay goes on at the same time: the bars after it stay hidden from the start
      const at = this.replayAt;
      this.replayAt = null;
      if (at != null) this.split(at);
      this.on.loaded("first", data.length);
      if (at != null && this.hidden && this.bars[0].time > at) await this.startReplay(at); // further back: load older bars
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
    if (this.bars.length + (this.hidden?.length ?? 0) >= this.limit()) {
      this.noMoreHistory = true;
      this.on.note(`最多載入 ${this.limit().toLocaleString()} 根 K 線，不再往前載入（設定裡可以開啟無上限）`);
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
    // in a replay the held-back bars take the live candles (once it has caught up, the bars on screen do)
    const list = this.hidden && this.hidden.length ? this.hidden : this.bars;
    const shown = list === this.bars;
    const last = list[list.length - 1];
    if (!last || c.time < last.time) return;
    const sec = this.tf.sec;
    if (c.time > last.time + sec * 1.5) {
      // second bars: OKX sends nothing for seconds without trades; they are flat bars, as its history has them
      if (sec < 60 && c.time - last.time <= 300) {
        for (let t = last.time + sec; t < c.time; t += sec) {
          const flat: Candle = { time: t, open: last.close, high: last.close, low: last.close, close: last.close, volume: 0, confirmed: true };
          this.put(list, flat, true, shown);
        }
      } else {
        void this.repair(); // bars were missed (the computer slept, the network dropped)
        return;
      }
    }
    const newBar = c.time !== list[list.length - 1].time;
    this.put(list, c, newBar, shown);
  }

  private put(list: Candle[], c: Candle, newBar: boolean, shown: boolean) {
    if (newBar) {
      const prev = list[list.length - 1];
      if (prev && !prev.confirmed) list[list.length - 1] = { ...prev, confirmed: true }; // a new bar: the last one is done
      list.push(c);
      if (shown) this.times.push(c.time);
    } else {
      list[list.length - 1] = c;
    }
    if (shown) this.on.tick(c, newBar);
  }

  // ------------------------------------------------------------------- bar replay
  get replaying(): boolean {
    return this.hidden !== null;
  }
  /** Bars still held back in a replay. */
  get ahead(): number {
    return this.hidden?.length ?? 0;
  }

  /** Replay from the bar at `time` (UTC seconds): the bars after it are held back. Loads older bars when
   *  the time is further back. False when there is nothing after it to replay. */
  async startReplay(time: number): Promise<boolean> {
    if (!this.ready) return false;
    const my = this.seq;
    for (let k = 0; k < REPLAY_LOADS && this.bars.length && this.bars[0].time > time && !this.noMoreHistory; k++) {
      await this.loadOlder();
      if (my !== this.seq) return false;
    }
    if (!this.split(time)) return false;
    this.on.loaded("replay", 0);
    return true;
  }

  /** Hold back the bars after the last one at or before `time` (the first bar stays when all are later). */
  private split(time: number): boolean {
    const all = this.hidden ? this.bars.concat(this.hidden) : this.bars;
    let i = all.length - 1;
    while (i > 0 && all[i].time > time) i--;
    if (i >= all.length - 1) return false;
    this.hidden = all.slice(i + 1);
    this.bars = all.slice(0, i + 1);
    this.times = this.bars.map((c) => c.time);
    return true;
  }

  /** Show the next bar of the replay; false when there is none left (the replay has caught up). */
  step(): boolean {
    const c = this.hidden?.shift();
    if (!c) return false;
    this.bars.push(c);
    this.times.push(c.time);
    this.on.tick(c, true);
    return true;
  }

  /** End the replay: every bar again, and live candles from here on. */
  stopReplay() {
    if (!this.hidden) return;
    this.bars = this.bars.concat(this.hidden);
    this.times = this.bars.map((c) => c.time);
    this.hidden = null;
    this.replayAt = null;
    this.on.loaded("replay", 0);
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
      if (this.hidden) {
        // in a replay only the held-back bars change
        const shown = this.times[this.times.length - 1] ?? 0;
        this.hidden = this.hidden.filter((c) => c.time < cut).concat(recent).filter((c) => c.time > shown);
        return;
      }
      this.setBars(this.bars.filter((c) => c.time < cut).concat(recent));
      this.on.loaded("repair", 0);
    } catch (e) {
      if (my === this.seq) this.on.error(`補抓最新 K 線失敗：${e}`);
    } finally {
      this.repairing = false;
    }
  }

  private setBars(bars: Candle[]) {
    const max = this.limit();
    this.bars = bars.length > max ? bars.slice(bars.length - max) : bars;
    this.times = this.bars.map((c) => c.time);
  }
}
