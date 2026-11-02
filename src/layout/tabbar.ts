// The tab bar above the toolbar, as in TradingView's desktop app: each tab shows the symbol of the chart in use
// in it, its latest price and 24-hour change (live, also for tabs not shown), and × to close; + opens a new
// tab. Drag a tab to move it; middle-click closes it. Keys: Ctrl+T new tab, Ctrl+W close, Ctrl+Tab /
// Ctrl+Shift+Tab next / previous.

import { shortName, type Catalog } from "../chart/catalog.ts";
import { tfLabel } from "../core/timeframes.ts";
import { el, textButton } from "../ui/dom.ts";
import { activeCell, cellCount, LAYOUTS, MAX_TABS, type Tab } from "./model.ts";
import { layoutIcon } from "./picker.ts";

export type TabBarDeps = {
  box: HTMLElement;
  catalog: Catalog;
  tabs(): readonly Tab[];
  /** Index of the tab on screen. */
  shown(): number;
  select(i: number): void;
  add(): void;
  close(i: number): void;
  move(from: number, to: number): void;
};

type Item = { instId: string; arrow: HTMLElement; px: HTMLElement; chg: HTMLElement };

export class TabBar {
  private readonly d: TabBarDeps;
  private readonly prices = new Map<string, number>();
  private items: Item[] = [];
  private readonly dirty = new Set<string>();
  private frame = 0;

  constructor(d: TabBarDeps) {
    this.d = d;
    d.box.addEventListener("dblclick", (e) => {
      if (e.target === d.box || (e.target as Element).classList.contains("tab-list")) d.add();
    });
    window.addEventListener("keydown", (e) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const n = this.d.tabs().length;
      const step = (k: number) => this.d.select((this.d.shown() + k + n) % n);
      if (e.code === "KeyT" && !e.shiftKey) this.d.add();
      else if (e.code === "KeyW" && !e.shiftKey) this.d.close(this.d.shown());
      else if (e.key === "Tab" || e.key === "PageDown" || e.key === "PageUp") step(e.key === "PageUp" || e.shiftKey ? -1 : 1);
      else return;
      e.preventDefault();
    });
  }

  render() {
    const tabs = this.d.tabs();
    const list = el("div", "tab-list");
    this.items = [];
    tabs.forEach((t, i) => {
      const c = activeCell(t);
      const tab = el("div", "tab" + (i === this.d.shown() ? " shown" : ""));
      const charts = t.cells.slice(0, cellCount(t.layout)).map((x) => `${x.instId} ${tfLabel(x.bar)}`);
      tab.title = (t.layout === "1" ? charts[0] : `${LAYOUTS[t.layout].name}：\n${charts.join("\n")}`) + "\n拖曳可移動，中鍵關閉";
      if (t.layout !== "1") tab.append(layoutIcon(t.layout, "tab-layout"));
      const item: Item = { instId: c.instId, arrow: el("span", "tab-arrow"), px: el("span", "tab-px"), chg: el("span", "tab-chg") };
      tab.append(el("span", "tab-sym", shortName(c.instId)), item.arrow, item.px, item.chg);
      if (tabs.length > 1) {
        const x = textButton("×", "tab-close", () => this.d.close(i), "關閉分頁（Ctrl+W）");
        x.addEventListener("mousedown", (e) => e.stopPropagation()); // closing doesn't show the tab first
        tab.append(x);
      }
      tab.addEventListener("mousedown", (e) => {
        if (e.button === 1) e.preventDefault(); // no auto-scroll: middle-click closes (auxclick)
        if (e.button !== 0) return;
        this.d.select(i);
        this.dragFrom(i, e.clientX);
      });
      tab.addEventListener("auxclick", (e) => {
        if (e.button === 1 && tabs.length > 1) this.d.close(i);
      });
      this.paint(item);
      this.items.push(item);
      list.append(tab);
    });
    const add = textButton("+", "tab-add", () => this.d.add(), `新分頁（Ctrl+T），最多 ${MAX_TABS} 個`);
    this.d.box.replaceChildren(list, add);
  }

  /** A live price of a symbol (from any chart's or alert's stream). */
  price(instId: string, p: number) {
    this.prices.set(instId, p);
    if (!this.items.some((x) => x.instId === instId)) return;
    this.dirty.add(instId);
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        for (const item of this.items) if (this.dirty.has(item.instId)) this.paint(item);
        this.dirty.clear();
      });
    }
  }

  private paint(item: Item) {
    const { catalog } = this.d;
    const p = this.prices.get(item.instId) ?? catalog.get(item.instId)?.last;
    if (!p) return;
    const chg = catalog.change24h(item.instId, p);
    const cls = chg == null ? "" : chg >= 0 ? "up" : "down";
    item.arrow.className = "tab-arrow " + cls;
    item.arrow.textContent = chg == null ? "" : chg >= 0 ? "▲" : "▼";
    item.px.textContent = catalog.fmtPrice(item.instId, p);
    item.chg.className = "tab-chg " + cls;
    item.chg.textContent = chg == null ? "" : `${chg >= 0 ? "+" : "−"}${Math.abs(chg * 100).toFixed(2)}%`;
  }

  /** Dragging a tab sideways moves it past its neighbors. */
  private dragFrom(index: number, x0: number) {
    let cur = index;
    let moving = false;
    const move = (e: MouseEvent) => {
      if (!moving && Math.abs(e.clientX - x0) < 6) return;
      moving = true;
      const tabs = [...this.d.box.querySelectorAll<HTMLElement>(".tab")];
      let to = cur;
      tabs.forEach((t, k) => {
        const r = t.getBoundingClientRect();
        if (k < cur && e.clientX < r.left + r.width / 2) to = Math.min(to, k);
        if (k > cur && e.clientX > r.left + r.width / 2) to = Math.max(to, k);
      });
      if (to !== cur) {
        this.d.move(cur, to);
        cur = to;
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
  }
}
