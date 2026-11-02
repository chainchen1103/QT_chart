// Which live candles the backend streams: the charts on screen, the symbols with alerts (1-minute bars), and
// the symbol of every tab (any bar will do, a price is all a tab shows). Each part says what it wants under
// its own name; the union goes to the backend once per turn of the event loop, and only when it changed.

import type { Pair } from "./api.ts";

export class LiveHub {
  private readonly exact = new Map<string, Pair[]>();
  private readonly symbols = new Map<string, string[]>();
  private sent = "";
  private queued = false;
  private readonly send: (pairs: Pair[]) => Promise<void>;
  private readonly failed: (e: unknown) => void;

  constructor(send: (pairs: Pair[]) => Promise<void>, failed: (e: unknown) => void) {
    this.send = send;
    this.failed = failed;
  }

  /** These exact symbols and timeframes, for `owner` (replaces what it wanted before). */
  want(owner: string, pairs: Pair[]) {
    this.exact.set(owner, pairs);
    this.queue();
  }
  /** Prices of these symbols, whatever the timeframe. */
  wantPrices(owner: string, instIds: string[]) {
    this.symbols.set(owner, instIds);
    this.queue();
  }

  private queue() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      const pairs = unionPairs([...this.exact.values()], [...this.symbols.values()]);
      const key = pairs.map((p) => `${p.instId}/${p.bar}`).join(",");
      if (key === this.sent) return;
      this.sent = key;
      this.send(pairs).catch((e) => {
        this.sent = ""; // try again with the next change
        this.failed(e);
      });
    });
  }
}

/** Every exact pair once, plus a 1-minute channel for each price-only symbol that nothing streams yet; sorted. */
export function unionPairs(exact: Pair[][], symbols: string[][]): Pair[] {
  const out = new Map<string, Pair>();
  const covered = new Set<string>();
  for (const list of exact) {
    for (const p of list) {
      out.set(`${p.instId}/${p.bar}`, { instId: p.instId, bar: p.bar });
      covered.add(p.instId);
    }
  }
  for (const list of symbols) {
    for (const id of list) if (!covered.has(id)) out.set(`${id}/1m`, { instId: id, bar: "1m" });
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, p]) => p);
}
