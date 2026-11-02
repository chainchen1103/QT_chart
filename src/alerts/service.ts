// Price alerts at run time: the saved list, 1-minute prices of the symbols with an alert on, going off, and
// the log.
// Everything outside (storage, the backend, drawings, formatting, how a notice is shown) comes in through
// AlertDeps, so this file knows nothing about the chart or the DOM.

import type { Drawing, DrawKind, FibSettings } from "../settings/model.ts";
import { describe, evaluate, moveSince, targetShape, tradeSig, type AlertEvent, type Snapshot } from "./engine.ts";
import {
  cleanAlerts,
  cleanLog,
  cleanOptions,
  COND_TEXT,
  MAX_ALERTS,
  MAX_LOG,
  MAX_NOTE,
  oneShot,
  type Alert,
  type AlertCond,
  type AlertOptions,
  type AlertTarget,
  type LogEntry,
  type Repeat,
  type TradeStage,
} from "./model.ts";

export type AlertNotice = { alert: Alert; title: string; body: string };

export type AlertDeps = {
  /** Stream these symbols' prices (every symbol with an alert on). */
  watch(ids: string[]): void;
  /** The saved drawings of a symbol (asked once per symbol; changes come through drawingsChanged). */
  loadDrawings(instId: string): Drawing[];
  fib(): FibSettings;
  kindName(k: DrawKind): string;
  fmtPrice(instId: string, p: number): string;
  fmtTime(t: number): string;
  notify(n: AlertNotice): void;
  isTf(bar: string): boolean;
  read(key: string): unknown;
  write(key: string, v: unknown): void;
  /** UTC seconds. */
  now(): number;
};

export type NewAlert = {
  instId: string; target: AlertTarget; cond: AlertCond; repeat: Repeat; tf: string; note: string; stage?: TradeStage;
};
export type AlertPatch = Partial<Pick<Alert, "cond" | "repeat" | "note" | "on" | "target">>;

export const STAGE_TEXT: Record<TradeStage, string> = { wait: "等進場", open: "已進場，等出場", done: "已出場" };

export class AlertService {
  private readonly deps: AlertDeps;
  private alerts: Alert[];
  private entries: LogEntry[];
  private opts: AlertOptions;
  /** The last price snapshot of each watched symbol. */
  private readonly tracks = new Map<string, Snapshot>();
  private readonly drawings = new Map<string, Drawing[]>();
  private readonly listeners = new Set<() => void>();
  /** Symbols with an alert on: the only prices that matter. */
  private watched = new Set<string>();
  private watching = "";

  constructor(deps: AlertDeps) {
    this.deps = deps;
    this.alerts = cleanAlerts(deps.read("alerts"), deps.isTf);
    this.entries = cleanLog(deps.read("alertlog"));
    this.opts = cleanOptions(deps.read("alertopts"));
  }

  /** Start streaming the symbols that have alerts on. */
  start() {
    this.syncWatch();
  }

  // ------------------------------------------------------------------- reading
  all(): readonly Alert[] {
    return this.alerts;
  }
  forSymbol(instId: string): Alert[] {
    return this.alerts.filter((a) => a.instId === instId);
  }
  forDrawing(instId: string, drawingId: string): Alert | undefined {
    return this.alerts.find((a) => a.instId === instId && a.target.kind === "drawing" && a.target.id === drawingId);
  }
  drawingOf(a: Alert): Drawing | undefined {
    return a.target.kind === "drawing" ? this.findDrawing(a.instId, a.target.id) : undefined;
  }
  /** Latest price seen for a symbol (only while it is watched). */
  lastPrice(instId: string): number | null {
    return this.tracks.get(instId)?.close ?? null;
  }
  log(): readonly LogEntry[] {
    return this.entries;
  }
  options(): AlertOptions {
    return this.opts;
  }
  /** Short text for a list: "觸及 78,500.0", "趨勢線 · 向上突破", "倉位 · 進場、止盈、止損". */
  label(a: Alert): string {
    if (a.target.kind === "price") return `${COND_TEXT[a.cond]} ${this.deps.fmtPrice(a.instId, a.target.price)}`;
    const d = this.drawingOf(a);
    return `${d ? this.deps.kindName(d.kind) : "畫線"} · ${COND_TEXT[a.cond]}`;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ------------------------------------------------------------------- changing
  /** A new alert; a text when it can't be made. A drawing has at most one alert: a new one replaces it. */
  add(n: NewAlert): Alert | string {
    if (n.target.kind === "drawing") {
      const old = this.forDrawing(n.instId, n.target.id);
      if (old) this.alerts = this.alerts.filter((a) => a !== old);
    }
    if (this.alerts.length >= MAX_ALERTS) return `最多 ${MAX_ALERTS} 個提醒，先刪掉一些`;
    const a: Alert = {
      id: `al-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      instId: n.instId,
      target: n.target,
      cond: n.cond,
      repeat: n.repeat,
      tf: n.tf,
      note: n.note.slice(0, MAX_NOTE),
      on: true,
      created: this.deps.now(),
      fired: null,
      count: 0,
    };
    if (n.cond === "trade") {
      a.stage = n.stage ?? "wait";
      const d = this.drawingOf(a);
      if (d?.kind === "position") a.sig = tradeSig({ entry: d.a.p, stop: d.b.p, target: d.target });
    }
    this.alerts.push(a);
    this.changed();
    return a;
  }

  update(id: string, patch: AlertPatch) {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return;
    const rearm = patch.on === true && !a.on;
    Object.assign(a, patch);
    if (patch.note != null) a.note = patch.note.slice(0, MAX_NOTE);
    if (rearm) {
      a.created = this.deps.now(); // a vertical line's time must still be ahead
      if (a.cond === "trade" && a.stage === "done") {
        a.stage = "wait";
        delete a.sig;
      }
    }
    this.changed();
  }

  remove(id: string) {
    this.alerts = this.alerts.filter((a) => a.id !== id);
    this.changed();
  }

  /** A symbol's drawings changed: alerts on deleted drawings go too. */
  drawingsChanged(instId: string, list: Drawing[]) {
    this.drawings.set(instId, list);
    const ids = new Set(list.map((d) => d.id));
    const keep = this.alerts.filter((a) => a.instId !== instId || a.target.kind !== "drawing" || ids.has(a.target.id));
    if (keep.length !== this.alerts.length) {
      this.alerts = keep;
      this.changed();
    } else {
      this.emit(); // moved or restyled: redraw
    }
  }

  setOptions(o: AlertOptions) {
    this.opts = o;
    this.deps.write("alertopts", o);
    this.emit();
  }

  clearLog() {
    this.entries = [];
    this.deps.write("alertlog", this.entries);
    this.emit();
  }

  // ------------------------------------------------------------------- prices
  /** A 1-minute candle snapshot (of any symbol: others than the watched ones are ignored). */
  onCandle(instId: string, c: Snapshot) {
    if (!this.watched.has(instId)) return;
    const m = moveSince(this.tracks.get(instId) ?? null, c);
    if (!m) return;
    this.tracks.set(instId, { time: c.time, high: c.high, low: c.low, close: c.close });
    const now = this.deps.now();
    const fib = this.deps.fib();
    let dirty = false;
    for (const a of this.alerts) {
      if (!a.on || a.instId !== instId) continue;
      const shape = targetShape(a, (id) => this.findDrawing(instId, id), now, fib, this.deps.kindName);
      if (shape === "gone") continue; // removed through drawingsChanged
      if (shape?.type === "trade") {
        const sig = tradeSig(shape);
        if (a.sig !== sig) {
          if (a.sig !== undefined) a.stage = "wait"; // entry, stop or take-profit moved: start over
          a.sig = sig;
          dirty = true;
        }
      }
      const out = evaluate(a, shape, m, now);
      if (out.stage && out.stage !== a.stage) {
        a.stage = out.stage;
        dirty = true;
      }
      if (out.events.length) {
        this.fire(a, out.events, m.price, now);
        dirty = true;
      }
    }
    if (dirty) this.changed(true);
  }

  private fire(a: Alert, events: AlertEvent[], price: number, now: number) {
    a.fired = now;
    a.count += 1;
    if (oneShot(a.cond) ? a.cond === "time" || a.stage === "done" : a.repeat === "once") a.on = false;
    const fmt = (p: number) => this.deps.fmtPrice(a.instId, p);
    const text = events.map((e) => describe(e, fmt, this.deps.fmtTime)).join("；");
    this.entries.unshift({ t: now, instId: a.instId, text, note: a.note, alertId: a.id });
    if (this.entries.length > MAX_LOG) this.entries.length = MAX_LOG;
    const base = a.instId.replace(/-USDT-SWAP$/, "");
    this.deps.notify({ alert: a, title: `${base} ${text}`, body: `現價 ${fmt(price)}${a.note ? `\n${a.note}` : ""}` });
  }

  // ------------------------------------------------------------------- internals
  private findDrawing(instId: string, id: string): Drawing | undefined {
    let list = this.drawings.get(instId);
    if (!list) {
      list = this.deps.loadDrawings(instId);
      this.drawings.set(instId, list);
    }
    return list.find((d) => d.id === id);
  }

  private changed(withLog = false) {
    this.deps.write("alerts", this.alerts);
    if (withLog) this.deps.write("alertlog", this.entries);
    this.syncWatch();
    this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** Stream exactly the symbols with an alert on; forget prices and drawings of the others. */
  private syncWatch() {
    const ids = [...new Set(this.alerts.filter((a) => a.on).map((a) => a.instId))].sort();
    const key = ids.join(",");
    if (key === this.watching) return;
    this.watching = key;
    const keep = new Set(ids);
    this.watched = keep;
    for (const k of [...this.tracks.keys()]) if (!keep.has(k)) this.tracks.delete(k);
    for (const k of [...this.drawings.keys()]) if (!keep.has(k)) this.drawings.delete(k);
    this.deps.watch(ids);
  }
}
