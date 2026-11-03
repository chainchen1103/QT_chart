// Bar replay on one chart: pick the bar to start from, then show the bars after it one at a time, by hand
// (Shift+→) or at a chosen speed, until the present (the replay then ends by itself) or back to live at any
// time. The feed holds the later bars back (feed.ts); this is the picking and the control bar at the bottom of
// the chart. Indicators, Pine scripts and positions see only the bars shown; orders can't be placed meanwhile.

import type { IChartApi } from "lightweight-charts";
import { fmtChartTime, fromChartTime, toChartTime } from "../core/format.ts";
import { el, isTyping } from "../ui/dom.ts";
import type { MarketFeed } from "./feed.ts";

export type ReplayHost = {
  /** The pane: the control bar and the picking line go in it. */
  el: HTMLElement;
  chart: IChartApi;
  feed: MarketFeed;
  /** Is this the chart in use (keys act on it)? */
  inUse(): boolean;
  hint(text: string | null): void;
  note(text: string): void;
  /** Started, ended, picking, playing: the toolbar button follows. */
  changed(): void;
};

/** Bars per second while playing. */
const SPEEDS = [1, 2, 3, 5, 10];

const svg = (body: string) =>
  `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  play: svg(`<path d="M6.5 4.5v11l9-5.5z"/>`),
  pause: svg(`<path d="M7 4.5v11M13 4.5v11"/>`),
  step: svg(`<path d="M5 4.5v11l7.5-5.5zM15 4.5v11"/>`),
  pick: svg(`<path d="M10 2.5v15M6 6.5 3 10l3 3.5M14 6.5l3 3.5-3 3.5"/>`),
};

export class Replay {
  private readonly h: ReplayHost;
  private picking: { overlay: HTMLElement; off: () => void } | null = null;
  private bar: HTMLElement | null = null;
  private timer = 0;
  private speed = 1;
  private readonly offKeys: () => void;

  constructor(h: ReplayHost) {
    this.h = h;
    const onKey = (e: KeyboardEvent) => {
      if (!this.h.feed.replaying || !this.h.inUse() || isTyping(e.target as Element | null)) return;
      if (e.key === "ArrowRight" && e.shiftKey) {
        e.preventDefault();
        this.pause();
        this.next();
      }
    };
    document.addEventListener("keydown", onKey);
    this.offKeys = () => document.removeEventListener("keydown", onKey);
  }

  /** Replaying, or picking where to start. */
  get active(): boolean {
    return this.h.feed.replaying || !!this.picking;
  }
  get playing(): boolean {
    return this.timer !== 0;
  }

  /** The toolbar button: start picking, or end what is going on. */
  toggle() {
    if (this.picking) this.cancelPick();
    else if (this.h.feed.replaying) this.stop();
    else this.pick();
  }

  /** Let the user click the bar to start from (Esc cancels). */
  pick() {
    if (this.picking) return;
    this.pause();
    const { chart } = this.h;
    const overlay = el("div", "replay-pick");
    const line = el("div", "replay-pick-line");
    const shade = el("div", "replay-pick-shade");
    overlay.append(shade, line);
    this.h.el.append(overlay);
    const plotWidth = () => chart.timeScale().width();
    const move = (e: MouseEvent) => {
      const r = overlay.getBoundingClientRect();
      const x = Math.max(0, Math.min(plotWidth(), e.clientX - r.left));
      line.style.transform = `translateX(${x}px)`;
      shade.style.left = `${x}px`;
      shade.style.width = `${Math.max(0, plotWidth() - x)}px`;
    };
    const down = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button !== 0) {
        this.cancelPick();
        return;
      }
      const r = overlay.getBoundingClientRect();
      const x = Math.min(plotWidth() - 1, e.clientX - r.left);
      const time = this.timeAt(x);
      this.cancelPick();
      if (time != null) void this.start(time);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.cancelPick();
      }
    };
    overlay.addEventListener("mousemove", move);
    overlay.addEventListener("mousedown", down);
    overlay.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("keydown", key, true);
    this.picking = { overlay, off: () => document.removeEventListener("keydown", key, true) };
    this.h.hint("K 線重播：點一下要從哪一根開始（右鍵或 Esc 取消）");
    this.h.changed();
  }

  /** The bar time (UTC seconds) under x in the plot, the newest bar when x is past it. */
  private timeAt(x: number): number | null {
    const ts = this.h.chart.timeScale();
    const t = ts.coordinateToTime(x);
    if (t != null) return fromChartTime(t);
    const times = this.h.feed.times;
    const i = Math.round(ts.coordinateToLogical(x) ?? times.length - 1);
    return times[Math.max(0, Math.min(times.length - 1, i))] ?? null;
  }

  private cancelPick() {
    if (!this.picking) return;
    this.picking.off();
    this.picking.overlay.remove();
    this.picking = null;
    this.h.hint(null);
    this.h.changed();
  }

  private async start(time: number) {
    const ok = await this.h.feed.startReplay(time);
    if (!ok) {
      this.h.note("那一根之後沒有 K 線可以重播，選早一點的 K 線");
      return;
    }
    this.show();
  }

  /** The replay began (here, or carried over to another timeframe): the control bar. */
  show() {
    if (!this.bar) {
      this.bar = el("div", "replay-bar");
      this.h.el.append(this.bar);
    }
    this.paint();
    this.h.changed();
  }

  /** Back to live: every bar again. */
  stop() {
    this.pause();
    this.cancelPick();
    this.h.feed.stopReplay();
    this.bar?.remove();
    this.bar = null;
    this.h.changed();
  }

  /** The next bar; at the present the replay ends. */
  private next() {
    if (!this.h.feed.step()) {
      this.stop();
      this.h.note("重播到最新的 K 線了，回到即時");
      return;
    }
    if (!this.h.feed.ahead) {
      this.stop();
      this.h.note("重播到最新的 K 線了，回到即時");
      return;
    }
    this.paintTime();
  }

  private play() {
    if (this.timer) return;
    this.timer = window.setInterval(() => this.next(), 1000 / this.speed);
    this.paint();
    this.h.changed();
  }
  private pause() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = 0;
    this.paint();
    this.h.changed();
  }

  /** The chart was switched or redrawn while replaying: keep the bar in step. */
  sync() {
    if (this.h.feed.replaying) this.show();
    else if (this.bar) {
      this.pause();
      this.bar.remove();
      this.bar = null;
      this.h.changed();
    }
  }

  private paintTime() {
    const t = this.bar?.querySelector<HTMLElement>(".replay-time");
    const feed = this.h.feed;
    const last = feed.times[feed.times.length - 1];
    if (t && last != null) t.textContent = fmtChartTime(toChartTime(last), feed.tf.sec >= 86400, feed.tf.sec < 60);
    const left = this.bar?.querySelector<HTMLElement>(".replay-left");
    if (left) left.textContent = `還有 ${feed.ahead.toLocaleString()} 根`;
  }

  private paint() {
    const bar = this.bar;
    if (!bar) return;
    bar.replaceChildren();
    const btn = (icon: string, title: string, onClick: () => void, cls = "") => {
      const b = el("button", "replay-btn" + (cls ? " " + cls : ""));
      b.type = "button";
      b.title = title;
      b.innerHTML = icon; // our own fixed SVG
      b.onclick = onClick;
      b.addEventListener("mousedown", (e) => e.preventDefault()); // keys stay with the chart
      return b;
    };
    const speed = el("select", "replay-speed");
    speed.title = "播放速度";
    for (const s of SPEEDS) speed.append(new Option(`每秒 ${s} 根`, String(s), false, s === this.speed));
    speed.onchange = () => {
      this.speed = Number(speed.value);
      if (this.timer) {
        this.pause();
        this.play();
      }
    };
    const exit = el("button", "replay-exit", "回到即時");
    exit.type = "button";
    exit.title = "結束重播，顯示全部 K 線";
    exit.onclick = () => this.stop();
    bar.append(
      el("span", "replay-dot"),
      el("span", "replay-label", "重播"),
      el("span", "replay-time"),
      btn(ICON.pick, "重新選起點", () => this.pick()),
      this.timer ? btn(ICON.pause, "暫停", () => this.pause(), "on") : btn(ICON.play, "播放", () => this.play()),
      btn(ICON.step, "下一根（Shift+→）", () => {
        this.pause();
        this.next();
      }),
      speed,
      el("span", "replay-left"),
      exit,
    );
    this.paintTime();
  }

  destroy() {
    this.pause();
    this.cancelPick();
    this.offKeys();
    this.bar?.remove();
  }
}
