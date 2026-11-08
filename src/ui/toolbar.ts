// The top bar: symbol search and timeframe buttons for the chart in use (the ones the user starred, and a menu
// with all of them), and the 指標 menu: every indicator's switch and settings (shared by every chart).

import type { Catalog } from "../chart/catalog.ts";
import type { Instrument } from "../core/api.ts";
import { fmtChange, shortName } from "../core/format.ts";
import { findTf, tfSec } from "../core/timeframes.ts";
import type { Settings } from "../settings/store.ts";
import { el } from "./dom.ts";
import { countOn, toggleIndicatorMenu, type IndicatorDeps } from "./indicators.ts";
import { closePopover, togglePopover } from "./popover.ts";
import { renderTimeframes, toolbarBars } from "./panels/timeframes.ts";

export type ToolbarDeps = {
  catalog: Catalog;
  settings: Settings;
  /** Symbol and timeframe of the chart in use. */
  current(): { instId: string; bar: string };
  switchTo(instId: string, bar: string): void;
  /** The 指標 menu works on the chart in use. */
  indicators: IndicatorDeps;
};

const $ = (id: string) => document.getElementById(id) as HTMLElement;

export class Toolbar {
  private readonly d: ToolbarDeps;
  private readonly input = $("symbol") as HTMLInputElement;
  private readonly list = $("symbol-list");
  private rows: Instrument[] = [];
  private active = 0;

  constructor(d: ToolbarDeps) {
    this.d = d;
    this.setupSymbolBox();
    this.setupIndicators();
    d.settings.groups.watch(() => this.paintIndicators());
    d.settings.inds.watch(() => this.paintIndicators());
    d.settings.timeframes.watch(() => this.paintTimeframes());
  }

  /** Timeframe buttons, the current one highlighted; the symbol box shows the symbol of the chart in use.
   *  (Painted by the owner once there is a chart, and whenever the chart in use changes.) */
  paintTimeframes() {
    const cur = this.d.current();
    const nav = $("timeframes");
    nav.replaceChildren();
    // the starred ones, and the one on the chart when it isn't starred
    const bars = toolbarBars(this.d.settings.timeframes.get());
    if (!bars.includes(cur.bar) && findTf(cur.bar)) bars.push(cur.bar);
    bars.sort((a, b) => tfSec(a) - tfSec(b));
    for (const bar of bars) {
      const tf = findTf(bar);
      if (!tf) continue;
      const b = el("button", "tf-btn" + (tf.bar === cur.bar ? " active" : ""), tf.label);
      b.onclick = () => this.pickTf(tf.bar);
      nav.append(b);
    }
    const more = el("button", "tf-btn tf-more");
    more.title = "所有週期：秒、分、時、日、週，或自己加";
    more.innerHTML = `<svg class="caret" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 4.75 6 7.25l2.5-2.5" /></svg>`;
    more.onclick = () =>
      togglePopover(more, "below", "週期", renderTimeframes({
        timeframes: this.d.settings.timeframes,
        current: () => this.d.current().bar,
        pick: (bar) => {
          closePopover();
          this.pickTf(bar);
        },
      }));
    nav.append(more);
    if (document.activeElement !== this.input) this.input.value = shortName(cur.instId);
  }

  private pickTf(bar: string) {
    const now = this.d.current();
    if (bar !== now.bar) this.d.switchTo(now.instId, bar);
  }

  /** Put the cursor in the symbol box (a new tab: type the symbol it should show). */
  focusSymbol() {
    this.input.focus();
  }

  // ------------------------------------------------------------------- symbol search
  private renderList(filter: string) {
    // "eth", "ETHUSDT.P" and "ETH-USDT-SWAP" all find ETH
    const key = (s: string) => s.toUpperCase().replace(/[-.\s/]/g, "");
    const q = key(filter);
    this.rows = this.d.catalog.list.filter((i) => !q || key(shortName(i.instId)).includes(q) || key(i.instId).includes(q)).slice(0, 80);
    this.active = Math.min(this.active, Math.max(0, this.rows.length - 1));
    this.list.replaceChildren();
    this.rows.forEach((inst, k) => {
      const row = el("div", "symbol-row" + (k === this.active ? " active" : ""));
      const p = inst.last;
      row.append(
        el("span", "", shortName(inst.instId)),
        el("span", "px", p ? p.toLocaleString("en-US", { maximumFractionDigits: inst.priceDecimals }) : ""),
        el("span", "chg " + (inst.change24h >= 0 ? "up" : "down"), fmtChange(inst.change24h)),
      );
      row.onmousedown = (e) => {
        e.preventDefault();
        this.pick(inst.instId);
      };
      this.list.append(row);
    });
    this.list.hidden = this.rows.length === 0;
  }

  private pick(id: string) {
    this.list.hidden = true;
    this.input.blur();
    const cur = this.d.current();
    if (id !== cur.instId) this.d.switchTo(id, cur.bar);
    else this.input.value = shortName(id);
  }

  private setupSymbolBox() {
    const input = this.input;
    // focusing empties the box (like a search dialog); leaving it without a pick restores the current symbol
    input.addEventListener("focus", () => {
      closePopover();
      input.value = "";
      this.active = 0;
      this.renderList("");
    });
    input.addEventListener("input", () => {
      this.active = 0;
      this.renderList(input.value);
    });
    input.addEventListener("blur", () => {
      this.list.hidden = true;
      input.value = shortName(this.d.current().instId);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.active = Math.max(0, Math.min(this.rows.length - 1, this.active + (e.key === "ArrowDown" ? 1 : -1)));
        this.renderList(input.value);
      } else if (e.key === "Enter") {
        if (this.rows[this.active]) this.pick(this.rows[this.active].instId);
      } else if (e.key === "Escape") {
        input.blur();
      }
    });
  }

  // ------------------------------------------------------------------- indicators
  private paintIndicators() {
    const n = countOn(this.d.settings);
    $("ind-count").textContent = n ? String(n) : "";
    $("ind-btn").classList.toggle("on", n > 0);
  }

  private setupIndicators() {
    $("ind-btn").onclick = () => toggleIndicatorMenu($("ind-btn"), this.d.indicators);
    this.paintIndicators();
  }
}
