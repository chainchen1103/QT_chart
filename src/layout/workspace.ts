// The tabs and the charts on screen: which tab is shown, its layout and the charts in it, which chart is in
// use (the toolbars act on it), the live channels the charts need, and what is saved ("tabs"). Only the shown
// tab's charts exist; another tab's charts are made again when it is shown, at the zoom they had.

import type { LiveHub } from "../core/live.ts";
import { readJson, writeJson } from "../core/storage.ts";
import { findTf } from "../core/timeframes.ts";
import { ChartPane, type PaneEvents, type PaneShared } from "../chart/pane.ts";
import { Grid } from "./grid.ts";
import {
  activeCell,
  addTab,
  cellCount,
  cellLetter,
  cleanTabs,
  closeTab,
  MAX_TABS,
  moveTab,
  setLayout,
  type Cell,
  type LayoutId,
  type Tab,
  type Tabs,
} from "./model.ts";

export type WorkspaceDeps = {
  /** The grid the charts go in. */
  grid: HTMLElement;
  shared: PaneShared;
  hub: LiveHub;
  /** Another chart is in use, or the one in use shows something else: toolbars, quote, window title. */
  inUseChanged(p: ChartPane): void;
  /** The chart in use has a new price. */
  priced(p: ChartPane): void;
  /** Tabs added, closed, moved, shown, or what they show changed. */
  tabsChanged(): void;
  /** The chart in use started or ended a bar replay. */
  replayChanged(p: ChartPane): void;
};

const isBar = (b: string) => !!findTf(b);

export class Workspace {
  private state: Tabs;
  private panes: ChartPane[] = [];
  private readonly grid: Grid;
  private readonly d: WorkspaceDeps;
  private readonly events: PaneEvents;

  /** `fallback`: what the first tab shows when nothing is saved. */
  constructor(d: WorkspaceDeps, fallback: Cell) {
    this.d = d;
    this.state = cleanTabs(readJson("tabs"), fallback, isBar);
    this.grid = new Grid(d.grid, (sizes, done) => {
      this.tab.sizes = sizes;
      if (done) this.save();
    });
    this.events = {
      inUse: (p) => p === this.inUse(),
      pressed: (p) => this.use(p),
      switched: (p) => this.onSwitched(p),
      priced: (p) => {
        if (p === this.inUse()) d.priced(p);
      },
      drawingsChanged: (p) => {
        for (const q of this.panes) if (q !== p && q.feed.instId === p.feed.instId) q.reloadDrawings();
      },
      zoomed: () => this.save(),
      replay: (p) => {
        if (p === this.inUse()) d.replayChanged(p);
      },
    };
  }

  private get tab(): Tab {
    return this.state.tabs[this.state.active];
  }

  tabs(): readonly Tab[] {
    return this.state.tabs;
  }
  shownIndex(): number {
    return this.state.active;
  }
  /** The charts on screen, in cell order. */
  charts(): readonly ChartPane[] {
    return this.panes;
  }
  inUse(): ChartPane {
    return this.panes[this.tab.active] ?? this.panes[0];
  }
  layout(): LayoutId {
    return this.tab.layout;
  }

  /** Make the shown tab's charts (they load while the symbol list is still on its way). */
  start() {
    this.show();
  }

  /** The symbol list arrived. */
  catalogReady() {
    const { catalog } = this.d.shared;
    for (const t of this.state.tabs) for (const c of t.cells.slice(t === this.tab ? this.panes.length : 0)) c.instId = catalog.usable(c.instId);
    for (const p of this.panes) p.catalogReady();
    this.d.tabsChanged();
    this.d.inUseChanged(this.inUse());
  }

  // ------------------------------------------------------------------- tabs
  selectTab(i: number) {
    if (i === this.state.active || !this.state.tabs[i]) return;
    this.hide();
    this.state = { ...this.state, active: i };
    this.show();
    this.save();
  }

  /** A new tab after the shown one, showing what the chart in use shows. */
  addTab(): boolean {
    const next = addTab(this.state, this.inUse().cell());
    if (next === this.state) {
      this.d.shared.status.note(`最多 ${MAX_TABS} 個分頁`);
      return false;
    }
    this.hide();
    this.state = next;
    this.show();
    this.save();
    return true;
  }

  closeTab(i: number) {
    if (this.state.tabs.length <= 1 || !this.state.tabs[i]) return;
    const shown = i === this.state.active;
    if (shown) this.hide();
    this.state = closeTab(this.state, i);
    if (shown) this.show();
    else {
      this.syncStreams();
      this.d.tabsChanged();
    }
    this.save();
  }

  moveTab(from: number, to: number) {
    this.state = moveTab(this.state, from, to);
    this.d.tabsChanged();
    this.save();
  }

  // ------------------------------------------------------------------- the shown tab
  setLayout(id: LayoutId) {
    if (id === this.tab.layout) return;
    this.storeCells();
    const tab = setLayout(this.tab, id);
    this.state.tabs[this.state.active] = tab;
    const n = cellCount(id);
    while (this.panes.length > n) this.panes.pop()?.destroy();
    this.grid.apply(tab.layout, tab.sizes, this.panes.map((p) => p.el)); // the new places first, then new charts in them
    const added: ChartPane[] = [];
    while (this.panes.length < n) {
      const p = this.makePane(this.panes.length, tab.cells[this.panes.length]);
      this.panes.push(p);
      added.push(p);
    }
    this.grid.apply(tab.layout, tab.sizes, this.panes.map((p) => p.el));
    this.markInUse();
    for (const p of added) p.start();
    this.syncStreams();
    this.save();
    this.d.tabsChanged();
    this.d.inUseChanged(this.inUse());
  }

  /** Show a symbol on the chart in use (an alert's "前往"). */
  openSymbol(instId: string) {
    const p = this.inUse();
    if (p.feed.instId !== instId) p.switchTo(instId, p.feed.bar);
  }

  // ------------------------------------------------------------------- internals
  private show() {
    const tab = this.tab;
    for (const c of tab.cells) c.instId = this.d.shared.catalog.usable(c.instId);
    this.grid.apply(tab.layout, tab.sizes, []);
    this.panes = tab.cells.slice(0, cellCount(tab.layout)).map((c, i) => this.makePane(i, c));
    this.grid.apply(tab.layout, tab.sizes, this.panes.map((p) => p.el));
    this.markInUse();
    for (const p of this.panes) p.start();
    this.syncStreams();
    this.d.tabsChanged();
    this.d.inUseChanged(this.inUse());
  }

  private hide() {
    this.storeCells();
    for (const p of this.panes) p.destroy();
    this.panes = [];
  }

  private makePane(i: number, cell: Cell): ChartPane {
    return new ChartPane(this.d.grid, cellLetter(i), cell, this.d.shared, this.events);
  }

  private markInUse() {
    const u = this.inUse();
    for (const p of this.panes) p.setInUse(p === u);
  }

  /** A press on another chart: it is in use now, and takes over the drawing tool picked on the old one. */
  private use(p: ChartPane) {
    const old = this.inUse();
    const i = this.panes.indexOf(p);
    if (p === old || i < 0) return;
    const tool = old.drawings.getTool();
    this.tab.active = i;
    old.setInUse(false);
    p.setInUse(true);
    if (tool !== "cursor") p.drawings.setTool(tool);
    this.syncStreams(); // the tab shows the price of the chart in use
    this.save();
    this.d.tabsChanged();
    this.d.inUseChanged(p);
  }

  private onSwitched(p: ChartPane) {
    this.syncStreams();
    this.save();
    if (p !== this.inUse()) return;
    this.d.tabsChanged();
    this.d.inUseChanged(p);
  }

  private storeCells() {
    this.panes.forEach((p, i) => (this.tab.cells[i] = p.cell()));
  }

  /** The charts on screen, plus a price for every tab. */
  private syncStreams() {
    this.d.hub.want("charts", this.panes.map((p) => p.pair()));
    this.d.hub.wantPrices("tabs", this.state.tabs.map((t) => activeCell(t).instId));
  }

  private save() {
    this.storeCells();
    writeJson("tabs", this.state);
  }
}
