// Text on and around a chart: the legend (symbol, OHLC, change, volume, moving averages, zone counts) for the
// bar under the crosshair or the newest one; and the latest price with its 24h change, for the toolbar and the
// window title.

import { fmtVol } from "../core/format.ts";
import type { IndState, Overlays } from "../indicators/overlays.ts";
import { el } from "../ui/dom.ts";
import type { Catalog } from "./catalog.ts";
import type { MarketFeed } from "./feed.ts";

const STATE_TEXT: Record<IndState, string> = {
  ok: "",
  loading: "載入中…",
  lower: "（比圖表週期小，不顯示）",
  error: "（載入失敗，稍後重試）",
};
export class Legend {
  private readonly feed: MarketFeed;
  private readonly overlays: Overlays;
  private readonly box: HTMLElement;
  /** More lines (Pine scripts) for bar i. */
  private readonly extra: (i: number, box: HTMLElement) => void;

  constructor(feed: MarketFeed, overlays: Overlays, box: HTMLElement, extra: (i: number, box: HTMLElement) => void = () => {}) {
    this.feed = feed;
    this.overlays = overlays;
    this.box = box;
    this.extra = extra;
  }

  /** The bar at time t (UTC seconds), or the newest bar. */
  render(t?: number) {
    const { feed } = this;
    const bars = feed.bars;
    const box = this.box;
    box.replaceChildren();
    let i = bars.length - 1;
    if (t !== undefined) {
      const j = indexOf(feed.times, t);
      if (j >= 0) i = j;
    }
    box.append(el("span", "name", `${feed.instId} · ${feed.tf.label}`));
    const c = bars[i];
    if (!c) return;
    const fp = feed.fmtPrice;
    const prev = i > 0 ? bars[i - 1].close : c.open;
    const chg = prev ? (c.close - prev) / prev : 0;
    const cls = c.close >= c.open ? "up" : "down";
    for (const [k, v] of [["開", c.open], ["高", c.high], ["低", c.low], ["收", c.close]] as const) box.append(el("span", "k", k + " "), el("span", cls, fp(v)));
    box.append(el("span", chg >= 0 ? "up" : "down", `  ${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(2)}%`));
    box.append(el("span", "k", "量 "), el("span", "", fmtVol(c.volume)));
    const mas = this.overlays.maLegend(i);
    if (mas.length) {
      const line = el("span", "ma");
      for (const m of mas) {
        const s = el("span", m.state === "ok" ? "" : "muted", `${m.label} ${m.state === "ok" ? (m.value == null ? "—" : fp(m.value)) : STATE_TEXT[m.state]}   `);
        if (m.state === "ok") s.style.color = m.color;
        line.append(s);
      }
      box.append(line);
    }
    const zones = this.overlays.zonesLegend();
    if (zones.length) {
      const line = el("span", "ma");
      for (const z of zones) {
        line.append(el("span", "k", z.label + " "));
        if (z.state !== "ok") {
          line.append(el("span", "muted", STATE_TEXT[z.state] + "   "));
          continue;
        }
        const up = el("span", "", `${z.upText} ${z.up} `);
        up.style.color = z.upColor;
        const down = el("span", "", `${z.downText} ${z.down}   `);
        down.style.color = z.downColor;
        line.append(up, down);
      }
      box.append(line);
    }
    this.extra(i, box);
  }

}

/** Latest price and 24h change of a chart (the toolbar shows the chart in use), and the window title. */
export function renderQuote(box: HTMLElement, feed: MarketFeed, catalog: Catalog) {
  const c = feed.bars[feed.bars.length - 1];
  box.replaceChildren();
  if (!c) return;
  const chg = catalog.change24h(feed.instId, c.close);
  box.append(el("span", "", feed.fmtPrice(c.close) + "  "));
  if (chg != null) box.append(el("span", chg >= 0 ? "up" : "down", `24h ${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(2)}%`));
  document.title = `${feed.instId} ${feed.fmtPrice(c.close)} · QT Chart`;
}

function indexOf(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] === t) return mid;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
