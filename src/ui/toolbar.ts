// The top bar: symbol search and timeframe buttons for the chart in use, and the indicator switches (均線, FVG,
// OB, 支撐阻力) with their settings windows (shared by every chart).

import type { Catalog } from "../chart/catalog.ts";
import type { Instrument } from "../core/api.ts";
import { fmtChange, shortName } from "../core/format.ts";
import { TIMEFRAMES } from "../core/timeframes.ts";
import { clone, DEFAULT_FVG, DEFAULT_OB, DEFAULT_SR, type Groups } from "../settings/model.ts";
import type { Settings } from "../settings/store.ts";
import { el } from "./dom.ts";
import { toggleMaPanel } from "./panels/ma.ts";
import { toggleFvgPanel, toggleObPanel, toggleSrPanel } from "./panels/zones.ts";
import { closePopover } from "./popover.ts";

export type ToolbarDeps = {
  catalog: Catalog;
  settings: Settings;
  /** Symbol and timeframe of the chart in use. */
  current(): { instId: string; bar: string };
  switchTo(instId: string, bar: string): void;
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
    d.settings.groups.watch(() => this.paintGroups());
  }

  /** Timeframe buttons, the current one highlighted; the symbol box shows the symbol of the chart in use.
   *  (Painted by the owner once there is a chart, and whenever the chart in use changes.) */
  paintTimeframes() {
    const cur = this.d.current();
    const nav = $("timeframes");
    nav.replaceChildren();
    for (const tf of TIMEFRAMES) {
      const b = el("button", "tf-btn" + (tf.bar === cur.bar ? " active" : ""), tf.label);
      b.onclick = () => {
        const now = this.d.current();
        if (tf.bar !== now.bar) this.d.switchTo(now.instId, tf.bar);
      };
      nav.append(b);
    }
    if (document.activeElement !== this.input) this.input.value = shortName(cur.instId);
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

  // ------------------------------------------------------------------- indicator switches
  private setGroups(v: Groups) {
    const s = this.d.settings;
    // switching a group on with nothing in it brings back its default set
    if (v.fvg && !s.fvgs.get().length) s.fvgs.set([clone(DEFAULT_FVG)]);
    if (v.ob && !s.obs.get().length) s.obs.set([clone(DEFAULT_OB)]);
    if (v.sr && !s.srs.get().length) s.srs.set([clone(DEFAULT_SR)]);
    s.groups.set(v);
  }

  private paintGroups() {
    const g = this.d.settings.groups.get();
    $("ma-toggle").classList.toggle("on", g.ma);
    $("fvg-toggle").classList.toggle("on", g.fvg);
    $("ob-toggle").classList.toggle("on", g.ob);
    $("sr-toggle").classList.toggle("on", g.sr);
  }

  private setupIndicators() {
    const s = this.d.settings;
    const bar = () => this.d.current().bar;
    const flip = (k: keyof Groups) => () => this.setGroups({ ...s.groups.get(), [k]: !s.groups.get()[k] });
    $("ma-toggle").onclick = flip("ma");
    $("fvg-toggle").onclick = flip("fvg");
    $("ob-toggle").onclick = flip("ob");
    $("sr-toggle").onclick = flip("sr");
    $("ma-btn").onclick = () => toggleMaPanel($("ma-btn"), s.mas, s.maOptions, bar);
    $("fvg-btn").onclick = () => toggleFvgPanel($("fvg-btn"), s.fvgs, bar);
    $("ob-btn").onclick = () => toggleObPanel($("ob-btn"), s.obs, bar);
    $("sr-btn").onclick = () => toggleSrPanel($("sr-btn"), s.srs, bar);
    this.paintGroups();
  }
}
