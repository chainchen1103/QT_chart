// Trading on the charts: what the order spot at the right of each position shows (下單, or the order placed
// from it and its state), what a click on it opens, the positions' starting capital (the account's equity
// when an API is set), and asking OKX every few seconds about orders still open.

import type { Catalog } from "../chart/catalog.ts";
import type { Setting } from "../core/setting.ts";
import type { PositionResult } from "../drawings/trade.ts";
import type { OrderTag } from "../drawings/paint.ts";
import type { PositionDrawing, PositionOrder, PositionSettings } from "../settings/model.ts";
import type { TradeAccount } from "./account.ts";
import { fmtCoins, isOpenState, type ContractSpec, type OrderPrefs } from "./model.ts";
import { isMissing, openOrderDetails, openOrderWindow, toggleAccountPanel, withInfo, type OrderSpot } from "./panel.ts";
import { THEME } from "../ui/theme.ts";

/** A chart, as the order parts see it. */
export type OrderTarget = {
  alive(): boolean;
  instId(): string;
  last(): number | null;
  fmtPrice(p: number): string;
  trade(id: string): PositionResult | undefined;
  positions(): PositionDrawing[];
  setOrder(id: string, o: PositionOrder | undefined): void;
};

export type TradingDeps = {
  acct: TradeAccount;
  catalog: Catalog;
  position: Setting<PositionSettings>;
  prefs: Setting<OrderPrefs>;
  /** The account button (the API settings open next to it). */
  button: HTMLElement;
  note(text: string): void;
  /** An order of ours filled (seen by asking OKX): an add may move the earlier stops now. */
  filled?(instId: string): void;
};

/** 下單 is the primary action on the chart: off-white with dark text, like the primary buttons. */
const ACTION_BG = THEME.text;
const OPEN_BG = "rgba(91,156,246,0.45)";
const DONE_BG = "#089981";
const GRAY = "rgba(45,45,48,0.95)";

export class Trading {
  private readonly d: TradingDeps;
  private polling = false;

  constructor(d: TradingDeps) {
    this.d = d;
  }

  /** Starting capital of positions: the account's equity (`live`), when an API is set and that option is on. */
  capital(): { amount: number; live: boolean } {
    const p = this.d.position.get();
    const eq = this.d.acct.equity();
    return p.capitalFromApi && eq != null && eq > 0 ? { amount: eq, live: true } : { amount: p.capital, live: false };
  }

  /** The spot at the right of a position: 下單 while its box still reaches the newest bar, then its order. */
  tag(d: PositionDrawing, newestBar: number | null, fmtPrice: (p: number) => string): OrderTag | null {
    const o = d.order;
    if (!o) return newestBar != null && d.b.t >= newestBar ? { text: "下單", bg: ACTION_BG, fg: THEME.bg } : null;
    const env = o.demo ? "模擬 · " : "";
    switch (o.state) {
      case "live":
        return { text: `${env}掛單中 ${fmtCoins(o.sz)} 張`, bg: OPEN_BG };
      case "partially_filled":
        return { text: `${env}部分成交 ${fmtCoins(o.fillSz)}/${fmtCoins(o.sz)} 張`, bg: OPEN_BG };
      case "filled":
        return { text: `${env}已成交 ${fmtCoins(o.sz)} 張${o.avgPx ? " @ " + fmtPrice(o.avgPx) : ""}`, bg: DONE_BG };
      case "canceled":
      case "mmp_canceled":
        return { text: `${env}已撤單 · 重新下單`, bg: GRAY };
      case "missing":
        return { text: `${env}交易所查不到這張單`, bg: GRAY };
      default:
        return { text: `${env}訂單狀態不明`, bg: GRAY };
    }
  }

  /** The spot was clicked: the order window (an API first, when none is set), or the order's details. */
  click(t: OrderTarget, d: PositionDrawing, x: number, y: number) {
    const o = d.order;
    if (o && o.state !== "canceled" && o.state !== "mmp_canceled") {
      openOrderDetails(x, y, this.spot(t, d));
      return;
    }
    if (!this.d.acct.usable()) {
      this.d.note(this.d.acct.keys.locked ? "先輸入解鎖密碼才能下單" : "先設定 OKX API 才能下單");
      this.openAccount();
      return;
    }
    openOrderWindow(x, y, this.spot(t, d));
  }

  openAccount() {
    toggleAccountPanel(this.d.button, this.d.acct, this.d.position);
  }

  /** Ask OKX about every order still open on these charts (once each, one at a time). */
  async poll(targets: readonly OrderTarget[]) {
    const { acct } = this.d;
    if (this.polling || !acct.usable()) return;
    this.polling = true;
    try {
      const seen = new Set<string>();
      for (const t of targets) {
        for (const d of t.positions()) {
          const o = d.order;
          if (!o || !isOpenState(o.state) || o.demo !== acct.keys.demo || seen.has(o.ordId)) continue;
          seen.add(o.ordId);
          try {
            const next = withInfo(o, await acct.order(t.instId(), o.ordId));
            if (!t.alive() || (next.state === o.state && next.fillSz === o.fillSz && next.avgPx === o.avgPx)) continue;
            t.setOrder(d.id, next);
            if (next.state === "filled") this.d.note(`${t.instId()} 訂單成交：${fmtCoins(next.sz)} 張${next.avgPx ? " @ " + t.fmtPrice(next.avgPx) : ""}`);
            if (next.fillSz > 0 && next.moveOnFill && !next.moved) this.d.filled?.(t.instId());
          } catch (e) {
            if (isMissing(e) && t.alive()) t.setOrder(d.id, { ...o, state: "missing" }); // stop asking
            // anything else: asked again next round
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private spot(t: OrderTarget, d: PositionDrawing): OrderSpot {
    const inst = this.d.catalog.get(t.instId());
    const spec: ContractSpec | null = inst && inst.ctVal > 0 ? { ctVal: inst.ctVal, lotSz: inst.lotSz, minSz: inst.minSz, maxLever: inst.maxLever, tickSz: inst.tickSz } : null;
    return {
      acct: this.d.acct,
      instId: t.instId(),
      base: inst?.base ?? t.instId().split("-")[0],
      spec,
      drawing: d,
      trade: t.trade(d.id),
      last: t.last(),
      fmtPrice: t.fmtPrice,
      prefs: this.d.prefs,
      record: (o) => {
        if (!t.alive()) return;
        t.setOrder(d.id, o);
        d.order = o; // the window's own copy, for its next redraw
      },
      note: this.d.note,
    };
  }
}
