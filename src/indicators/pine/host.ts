// The Pine scripts on one chart: runs every script that is switched on over the chart's bars (again when
// bars load, settings change, and on live ticks — at most about once a second, less often for slow scripts),
// loads the other timeframes request.security() asks for, and shows each result through its ScriptView.

import type { Candle } from "../../core/api.ts";
import type { Setting } from "../../core/setting.ts";
import { tfSec } from "../../core/timeframes.ts";
import { loadCached, runWithSecurity, type SecRequest } from "../../pine/index.ts";
import type { PineScript } from "../../settings/model.ts";
import { SourceStore } from "../sources.ts";
import { fillLegend, ScriptView, type LegendItem, type ViewHost } from "./view.ts";
import { cssColor } from "../../pine/runtime.ts";
import { DISPLAY } from "../../pine/outputs.ts";
import { pineLines } from "../../alerts/pine.ts";
import type { PineSpec } from "../specs.ts";

export { loadCached };

/** Bars of the other timeframe loaded before the chart's first bar, so its indicators have warmed up. */
const WARMUP = 300;
const TICK_MIN_MS = 1000;

export type PineHostDeps = ViewHost & {
  scripts: Setting<PineScript[]>;
  instId(): string;
  bar(): string;
  /** Colors from barcolor() for the candles (null: their own). */
  barColors(colors: (string | null)[] | null): void;
  /** Results changed (legend, windows showing them). */
  changed(): void;
};

export class PineHost {
  private readonly d: PineHostDeps;
  private readonly views = new Map<string, ScriptView>();
  /** request.security() requests each script made, so they are computed before the main run. */
  private readonly known = new Map<string, SecRequest[]>();
  private readonly sources: SourceStore;
  private readonly listeners = new Set<() => void>();
  private readonly off: () => void;
  /** Pane legends sit at their pane's top: place them again when the chart changes size. */
  private readonly resized: ResizeObserver;
  private timer = 0;
  private due = 0;
  private lastMs = 0;
  private stale = false;
  private dead = false;

  constructor(d: PineHostDeps) {
    this.d = d;
    this.sources = new SourceStore(() => this.schedule(0));
    this.off = d.scripts.watch(() => this.schedule(0));
    this.resized = new ResizeObserver(() => {
      if (this.views.size) d.changed();
    });
    this.resized.observe(d.legendBox);
  }

  // ------------------------------------------------------------------- chart lifecycle
  setSymbol(instId: string) {
    this.sources.reset(instId);
    this.known.clear();
  }
  setBar(bar: string) {
    this.sources.dropBelow(tfSec(bar));
  }
  /** New bars (first load, older history, after a gap). */
  setData() {
    this.schedule(0);
  }
  /** A live candle (already applied to the chart's bars). `draw` false: the window is hidden. */
  tick(c: Candle, draw = true) {
    this.sources.tick(c, this.d.bar());
    if (!draw) {
      this.stale = true;
      return;
    }
    this.schedule(c.confirmed ? 50 : Math.max(TICK_MIN_MS, this.lastMs * 5));
  }
  /** The window shows again. */
  shown() {
    if (this.stale) this.schedule(0);
  }
  destroy() {
    this.dead = true;
    clearTimeout(this.timer);
    this.off();
    this.resized.disconnect();
    for (const v of this.views.values()) v.destroy();
    this.views.clear();
    this.sources.reset("");
    this.listeners.clear();
  }

  // ------------------------------------------------------------------- what the windows read
  view(id: string): ScriptView | undefined {
    return this.views.get(id);
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** Run again soon (an input changed: right away). */
  refresh() {
    this.schedule(0);
  }

  /** Legend lines of the scripts drawn on the price pane; the others write theirs in their own pane. */
  legend(i: number, box: HTMLElement) {
    for (const v of this.ordered()) {
      if (v.inOwnPane) {
        v.renderPaneLegend(i);
        continue;
      }
      v.renderPaneLegend(i); // removes a pane legend left from before
      const line = document.createElement("span");
      line.className = "ma pine-line";
      fillLegend(line, v.legend(i));
      line.style.fontSize = "";
      line.append(...(this.d.legendButtons?.(v.id) ?? []));
      box.append(line);
    }
  }

  // ------------------------------------------------------------------- alerts
  /** A script as alerts name it, from its last result on this chart: null before it ran, or when it draws no
   *  plot an alert could watch. */
  specOf(id: string): PineSpec | null {
    const v = this.views.get(id);
    const r = v?.result;
    if (!v || !r || !r.ok) return null;
    const lines = pineLines(r.out.plots).slice(0, 64).map(({ key, name }) => ({ key, name: name.slice(0, 120) }));
    if (!lines.length) return null;
    return { type: "pine", id, name: v.title().slice(0, 80), overlay: r.decl.overlay, lines };
  }

  /** The script whose own pane is at this height of the screen, and its value there. */
  paneAt(clientY: number): { id: string; name: string; value: number } | null {
    for (const v of this.ordered()) {
      const value = v.valueAt(clientY);
      if (value != null) return { id: v.id, name: v.title(), value };
    }
    return null;
  }

  /** Alerts changed: their levels across the scripts' panes again. */
  alertsChanged() {
    for (const v of this.views.values()) v.syncLevels();
  }

  private ordered(): ScriptView[] {
    const out: ScriptView[] = [];
    for (const s of this.d.scripts.get()) {
      const v = this.views.get(s.id);
      if (v) out.push(v);
    }
    return out;
  }

  // ------------------------------------------------------------------- running
  private schedule(delay: number) {
    if (this.dead) return;
    const at = Date.now() + delay;
    if (this.timer && this.due <= at) return; // a run is already on its way
    clearTimeout(this.timer);
    this.due = at;
    this.timer = window.setTimeout(() => this.runAll(), delay);
  }

  private runAll() {
    this.timer = 0;
    if (this.dead) return;
    this.stale = false;
    const bars = this.d.bars();
    const scripts = this.d.scripts.get().filter((s) => s.on);
    for (const [id, v] of this.views)
      if (!scripts.some((s) => s.id === id)) {
        v.destroy();
        this.views.delete(id);
        this.known.delete(id);
      }
    if (!bars.length) return;
    const t0 = performance.now();
    let barColors: (string | null)[] | null = null;
    for (const s of scripts) {
      let v = this.views.get(s.id);
      if (!v) {
        v = new ScriptView(this.d, s.id);
        this.views.set(s.id, v);
      }
      const loaded = loadCached(s.source);
      if (!loaded.ok) {
        v.update(null, loaded.info, s.name, `第 ${loaded.error.line} 行：${loaded.error.message}`, false);
        continue;
      }
      const data = { bars, sec: this.d.barSec(), instId: this.d.instId(), mintick: this.d.tick(), now: Date.now() };
      const { result, missing } = runWithSecurity(loaded.program, data, { inputs: s.inputs, timeLimit: 5000 }, (req) => this.otherBars(req, bars), this.known.get(s.id) ?? []);
      const known = this.known.get(s.id) ?? [];
      for (const n of [...result.needs, ...missing]) if (!known.some((k) => k.key === n.key)) known.push(n);
      this.known.set(s.id, known);
      const err = result.error ? `第 ${result.error.line} 行：${result.error.message}` : null;
      v.update(result, loaded.info, s.name, err, missing.length > 0);
      if (result.ok)
        for (const b of result.out.bgs) {
          if (b.kind !== "barcolor" || !(b.display & DISPLAY.pane)) continue;
          barColors ??= new Array(bars.length).fill(null);
          for (let i = 0; i < b.colors.length; i++) {
            const d = i + b.offset;
            if (d < 0 || d >= bars.length) continue;
            const c = cssColor(b.colors[i]);
            if (c) barColors[d] = c;
          }
        }
    }
    this.lastMs = performance.now() - t0;
    this.d.barColors(barColors);
    this.d.changed();
    for (const fn of this.listeners) fn();
  }

  /** Bars of another timeframe for request.security(): the chart's own (Heikin-Ashi of it), or loaded ones
   *  (null while they are on the way; their arrival runs the scripts again). */
  private otherBars(req: SecRequest, chartBars: Candle[]): readonly Candle[] | null {
    const sec = this.d.barSec();
    if (req.tf.sec === sec) return chartBars;
    if (!req.tf.okx) return []; // a timeframe OKX doesn't have: no values
    if (chartBars.length) this.sources.ensure(req.tf.okx, chartBars[0].time - WARMUP * req.tf.sec);
    if (this.sources.status(req.tf.okx) === "error") return [];
    return this.sources.get(req.tf.okx);
  }
}

export type { LegendItem };
