// The symbols on offer (live USDT perpetuals, most traded first), shared by every chart: price decimals and
// step, the price formatting of any symbol, and the 24-hour change of a live price.

import { listInstruments, type Instrument } from "../core/api.ts";
import { fmtFixed } from "../core/format.ts";

export const DEFAULT_SYMBOL = "BTC-USDT-SWAP";

export class Catalog {
  list: Instrument[] = [];
  private byId = new Map<string, Instrument>();

  async load() {
    this.list = await listInstruments();
    this.byId = new Map(this.list.map((i) => [i.instId, i]));
  }

  get(id: string): Instrument | undefined {
    return this.byId.get(id);
  }
  /** A saved symbol that is no longer listed falls back to the most traded one (nothing loaded: kept). */
  usable(id: string): string {
    return !this.list.length || this.byId.has(id) ? id : this.list[0].instId;
  }
  decimals(id: string): number {
    return this.byId.get(id)?.priceDecimals ?? 2;
  }
  tick(id: string): number {
    const i = this.byId.get(id);
    return i ? parseFloat(i.tickSz) || Math.pow(10, -i.priceDecimals) : 0.01;
  }
  fmtPrice = (id: string, v: number): string => fmtFixed(v, this.decimals(id));
  /** Change of `price` against the price 24 hours before the list was loaded (null when unknown). */
  change24h(id: string, price: number): number | null {
    const i = this.byId.get(id);
    if (!i || !i.last) return null;
    const chg = price / (i.last / (1 + i.change24h)) - 1;
    return Number.isFinite(chg) ? chg : null;
  }
}

export { shortName } from "../core/format.ts";
