// Price alerts at run time: the saved list, 1-minute prices of the symbols with an alert on, going off, and
// the log.
// Everything outside (storage, the backend, drawings, formatting, how a notice is shown) comes in through
// AlertDeps, so this file knows nothing about the chart or the DOM.

import type { Drawing, DrawKind, FibSettings } from "../settings/model.ts";
import type { Candle } from "../core/api.ts";
import { shortName } from "../core/format.ts";
import { tfLabel, tfSec } from "../core/timeframes.ts";
import type { Num } from "../indicators/osc.ts";
import { computeLines, fmtValue, lineName, linesOf, onPrices, PINE_BARS, sameSpec, specName, warmupOf, type IndSpec } from "../indicators/specs.ts";
import type { SecRequest } from "../pine/index.ts";
import { AlertBars } from "./bars.ts";
import { runForAlert, type PineRun } from "./pine.ts";
import { describe, evaluate, indicatorStep, moveSince, signalOf, targetShape, tradeSig, type AlertEvent, type Move, type Snapshot } from "./engine.ts";
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
  type IndTarget,
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
  /** The newest `count` bars of a symbol and timeframe (indicator alerts need their history). */
  candles(instId: string, bar: string, count: number): Promise<Candle[]>;
  /** A Pine script as it is now (alerts on it run it), or null when it was deleted. */
  pine?(id: string): { source: string; inputs: Record<string, unknown> } | null;
  /** A symbol's price step (Pine's syminfo.mintick). */
  mintick?(instId: string): number;
};

/** A Pine script's last run for alerts on a symbol and timeframe: scripts run at most about once a second (less
 *  often when slow), and again at once when a bar closes or the script or its inputs change. */
type PineCache = { at: number; ms: number; n: number; last: number; source: string; inputs: object; run: PineRun | null };

export type NewAlert = {
  instId: string; target: AlertTarget; cond: AlertCond; repeat: Repeat; tf: string; note: string; stage?: TradeStage; close?: boolean;
};
export type AlertPatch = Partial<Pick<Alert, "cond" | "repeat" | "note" | "on" | "target" | "close">>;

export const STAGE_TEXT: Record<TradeStage, string> = { wait: "等進場", open: "已進場，等出場", done: "已出場" };

/** Words of a phrase, with a space where Latin letters or digits meet Chinese: "K 向上突破 D", "價格觸及 EMA20". */
function phrase(...parts: string[]): string {
  const latin = (c: string) => /[A-Za-z0-9]/.test(c);
  let out = "";
  for (const p of parts) {
    if (!p) continue;
    if (out && latin(out[out.length - 1]) !== latin(p[0])) out += " ";
    out += p;
  }
  return out;
}

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
  /** Bars of the timeframes indicator alerts run on, and the value each of them saw last. */
  private readonly indBars: AlertBars;
  private readonly indPrev = new Map<string, Num>();
  /** Pine alerts' runs, and the request.security() timeframes each script asked for, by symbol, timeframe and
   *  script. */
  private readonly pineRuns = new Map<string, PineCache>();
  private readonly pineNeeds = new Map<string, SecRequest[]>();

  constructor(deps: AlertDeps) {
    this.deps = deps;
    this.indBars = new AlertBars(deps.candles);
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
  /** Numbers that alerts on this symbol compare an indicator's line with, drawn across its pane: only alerts on
   * the indicator as drawn there, the same numbers and timeframe (an RSI 1m alert means nothing on a 1H pane). */
  indicatorLevels(instId: string, spec: IndSpec, tf: string): number[] {
    const out: number[] = [];
    for (const a of this.alerts) {
      const t = a.target;
      if (a.on && a.instId === instId && a.tf === tf && t.kind === "indicator" && t.value != null && sameSpec(t.spec, spec)) out.push(t.value);
    }
    return out;
  }

  /** "向上突破 80", "MACD 向上突破訊號線", "價格向上突破 EMA20", "價格觸及布林上軌". */
  private indWhat(a: Alert, t: IndTarget): string {
    const cond = COND_TEXT[a.cond];
    const own = linesOf(t.spec).length > 1 ? lineName(t.spec, t.line) : "";
    if (onPrices(t.spec)) return phrase("價格", cond, lineName(t.spec, t.line));
    if (t.other) return phrase(own || lineName(t.spec, t.line), cond, lineName(t.spec, t.other));
    const level = t.value ?? 0;
    // a level the user typed: as typed (80, not 80.00)
    const typed = t.spec.type === "rsi" || t.spec.type === "kd" || t.spec.type === "pine";
    const v = typed ? String(Number(level.toPrecision(10))) : fmtValue(t.spec, level, (p) => this.deps.fmtPrice(a.instId, p));
    return `${own ? own + " " : ""}${cond} ${v}`;
  }
  options(): AlertOptions {
    return this.opts;
  }
  /** Short text for a list: "觸及 78,500.0", "趨勢線 · 向上突破", "倉位 · 進場、止盈、止損", "RSI 14 1時 · 向上突破 80". */
  label(a: Alert): string {
    if (a.target.kind === "price") return `${COND_TEXT[a.cond]} ${this.deps.fmtPrice(a.instId, a.target.price)}`;
    if (a.target.kind === "indicator") return `${specName(a.target.spec)} ${tfLabel(a.tf)} · ${this.indWhat(a, a.target)}${a.close ? " · 收盤" : ""}`;
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
    if (n.target.kind === "indicator" && n.close) a.close = true;
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
    if (a.target.kind !== "indicator" || !a.close) delete a.close;
    this.indPrev.delete(a.id); // what it compares changed, or it starts again
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

  /** The Pine scripts changed: alerts on deleted scripts go too. */
  pineScriptsChanged(ids: readonly string[]) {
    const keep = this.alerts.filter((a) => a.target.kind !== "indicator" || a.target.spec.type !== "pine" || ids.includes(a.target.spec.id));
    if (keep.length !== this.alerts.length) {
      this.alerts = keep;
      this.changed();
    }
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
  onCandle(instId: string, c: Candle) {
    if (!this.watched.has(instId)) return;
    const m = moveSince(this.tracks.get(instId) ?? null, c);
    if (!m) return;
    this.tracks.set(instId, { time: c.time, high: c.high, low: c.low, close: c.close });
    const now = this.deps.now();
    const fib = this.deps.fib();
    let dirty = false;
    const closed = this.indBars.fold(instId, c);
    const computed = new Map<string, { lines: Record<string, Num[]>; closes: number[] } | null>();
    for (const a of this.alerts) {
      if (!a.on || a.instId !== instId) continue;
      if (a.target.kind === "indicator") {
        if (this.checkIndicator(a, a.target, m, closed.has(a.tf), computed, now)) dirty = true;
        continue;
      }
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

  /** One indicator alert on a price update: true when it went off. */
  private checkIndicator(
    a: Alert, t: IndTarget, m: Move, newBar: boolean,
    computed: Map<string, { lines: Record<string, Num[]>; closes: number[] } | null>, now: number,
  ): boolean {
    const bars = this.indBars.get(a.instId, a.tf, warmupOf(t.spec) + 50);
    if (!bars || bars.length < 3) return false;
    const spec = t.spec;
    const key = spec.type === "pine" ? `${a.tf} pine ${spec.id}` : `${a.tf} ${JSON.stringify(spec)}`;
    let c = computed.get(key);
    if (c === undefined) {
      const lines = spec.type === "pine" ? this.pineLines(a.instId, a.tf, spec.id, bars, newBar) : computeLines(spec, bars);
      c = lines ? { lines, closes: bars.map((b) => b.close) } : null;
      computed.set(key, c);
    }
    if (!c) return false; // the script can't run (yet)
    const sig = signalOf(t, c.lines, c.closes);
    const out = indicatorStep(a, t, sig, c.lines[t.line] ?? [], newBar, this.indPrev.get(a.id), m, now);
    this.indPrev.set(a.id, out.next);
    if (!out.hit) return false;
    const line = c.lines[t.line] ?? [];
    const at = a.close ? line.length - 2 : line.length - 1; // the bar that closed, or the one moving
    const value = line[at];
    const fmt = (v: number) => fmtValue(t.spec, v, (p) => this.deps.fmtPrice(a.instId, p));
    const now2 = onPrices(t.spec) ? "" : value == null ? "" : t.other ? `（${fmt(value)}，${fmt(c.lines[t.other]?.[at] ?? 0)}）` : `（現值 ${fmt(value)}）`;
    const where = onPrices(t.spec) && value != null ? `（${fmt(value)}）` : "";
    const text = `${specName(t.spec)} ${tfLabel(a.tf)}：${this.indWhat(a, t)}${where}${now2}${a.close ? "，K 線收盤" : ""}`;
    this.fire(a, [{ type: "ind", text }], c.closes[c.closes.length - 1], now);
    return true;
  }

  /** A Pine script's lines on an alert's bars: its last run while that is fresh, else a new run. Null when the
   *  script is gone, doesn't run, or waits for other timeframes' bars. */
  private pineLines(instId: string, tf: string, id: string, bars: Candle[], newBar: boolean): Record<string, Num[]> | null {
    const script = this.deps.pine?.(id);
    if (!script) return null;
    const key = `${instId} ${tf} ${id}`;
    const nowMs = this.deps.now() * 1000;
    const last = bars[bars.length - 1].time;
    const old = this.pineRuns.get(key);
    const fresh = old && !newBar && old.n === bars.length && old.last === last && old.source === script.source && old.inputs === script.inputs
      && nowMs - old.at < Math.max(1000, old.ms * 5);
    if (fresh) return old.run && !old.run.missing ? old.run.lines : null;
    const t0 = performance.now();
    const data = { bars, sec: tfSec(tf), instId, mintick: this.deps.mintick?.(instId) ?? 0.01, now: nowMs };
    const run = runForAlert(script, data, (req) => this.indBars.get(instId, req.tf.okx!, PINE_BARS + 50), this.pineNeeds.get(key) ?? []);
    if (run) this.pineNeeds.set(key, run.needs);
    this.pineRuns.set(key, { at: nowMs, ms: performance.now() - t0, n: bars.length, last, source: script.source, inputs: script.inputs, run });
    return run && !run.missing ? run.lines : null;
  }

  private fire(a: Alert, events: AlertEvent[], price: number, now: number) {
    a.fired = now;
    a.count += 1;
    if (oneShot(a.cond) ? a.cond === "time" || a.stage === "done" : a.repeat === "once") a.on = false;
    const fmt = (p: number) => this.deps.fmtPrice(a.instId, p);
    const text = events.map((e) => describe(e, fmt, this.deps.fmtTime)).join("，");
    this.entries.unshift({ t: now, instId: a.instId, text, note: a.note, alertId: a.id });
    if (this.entries.length > MAX_LOG) this.entries.length = MAX_LOG;
    this.deps.notify({ alert: a, title: `${shortName(a.instId)} ${text}`, body: `現價 ${fmt(price)}${a.note ? `\n${a.note}` : ""}` });
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
    const on = this.alerts.filter((a) => a.on);
    const bars = new Set<string>();
    const pine = new Set<string>();
    for (const a of on) {
      if (a.target.kind !== "indicator") continue;
      bars.add(AlertBars.key(a.instId, a.tf));
      if (a.target.spec.type !== "pine") continue;
      // a Pine script's own timeframe, and the others its request.security() asks for
      const key = `${a.instId} ${a.tf} ${a.target.spec.id}`;
      pine.add(key);
      for (const r of this.pineNeeds.get(key) ?? []) if (r.tf.okx) bars.add(AlertBars.key(a.instId, r.tf.okx));
    }
    this.indBars.keep(bars);
    for (const k of [...this.pineRuns.keys()]) if (!pine.has(k)) this.pineRuns.delete(k);
    for (const k of [...this.pineNeeds.keys()]) if (!pine.has(k)) this.pineNeeds.delete(k);
    for (const id of [...this.indPrev.keys()]) if (!on.some((a) => a.id === id)) this.indPrev.delete(id);
    const ids = [...new Set(on.map((a) => a.instId))].sort();
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
