// The 指標 menu in the toolbar: every indicator with its switch and its settings. On the prices: moving
// averages, Bollinger Bands, FVG, order blocks, support and resistance. In panes of their own: RSI, MACD, KD and
// ATR. The settings windows open from here, and from the gear in each indicator's legend.

import type { AlertUi, IndPreset, IndSource } from "../alerts/panel.ts";
import { indicatorAlertSection } from "../alerts/panel.ts";
import { clone, DEFAULT_FVG, DEFAULT_OB, DEFAULT_SR, type Groups } from "../settings/model.ts";
import type { IndKind } from "../settings/indicators.ts";
import type { Settings } from "../settings/store.ts";
import { checkbox, el, textButton } from "./dom.ts";
import { toggleIndPanel } from "./panels/indicators.ts";
import { toggleMaPanel } from "./panels/ma.ts";
import { toggleFvgPanel, toggleObPanel, toggleSrPanel } from "./panels/zones.ts";
import { closePopover, togglePopover } from "./popover.ts";

export type MenuKind = "ma" | "fvg" | "ob" | "sr" | IndKind;

export type IndicatorDeps = {
  settings: Settings;
  /** The chart in use: its timeframe, its alert windows, what alerts can be made on there. */
  bar(): string;
  alerts(): AlertUi;
  sources(kind: "ma" | IndKind): IndSource[];
  preset(kind: "ma" | IndKind): IndPreset;
};

const ITEMS: { kind: MenuKind; name: string; about: string }[] = [
  { kind: "ma", name: "均線", about: "SMA、EMA、WMA" },
  { kind: "boll", name: "布林通道", about: "均線加減標準差" },
  { kind: "fvg", name: "FVG", about: "三根 K 線之間的缺口" },
  { kind: "ob", name: "OB", about: "Order Block" },
  { kind: "sr", name: "支撐阻力", about: "波段高低點" },
  { kind: "rsi", name: "RSI", about: "相對強弱指標" },
  { kind: "macd", name: "MACD", about: "快慢均線差和訊號線" },
  { kind: "kd", name: "KD", about: "隨機指標" },
  { kind: "atr", name: "ATR", about: "平均真實波幅" },
];
const GROUPS = new Set<MenuKind>(["ma", "fvg", "ob", "sr"]);

/** Is it switched on? */
export function isOn(kind: MenuKind, s: Settings): boolean {
  return GROUPS.has(kind) ? s.groups.get()[kind as keyof Groups] : s.inds.get()[kind as IndKind].on;
}

/** Switch it on or off (an empty FVG / OB / support-resistance list gets its default set back). */
export function setOn(kind: MenuKind, on: boolean, s: Settings) {
  if (GROUPS.has(kind)) {
    if (on && kind === "fvg" && !s.fvgs.get().length) s.fvgs.set([clone(DEFAULT_FVG)]);
    if (on && kind === "ob" && !s.obs.get().length) s.obs.set([clone(DEFAULT_OB)]);
    if (on && kind === "sr" && !s.srs.get().length) s.srs.set([clone(DEFAULT_SR)]);
    s.groups.set({ ...s.groups.get(), [kind]: on });
    return;
  }
  const all = s.inds.get();
  const k = kind as IndKind;
  s.inds.set({ ...all, [k]: { ...all[k], on } });
}

/** How many are on: the toolbar button shows it. */
export const countOn = (s: Settings) => ITEMS.filter((i) => isOn(i.kind, s)).length;

/** The menu, below the toolbar button. */
export function toggleIndicatorMenu(anchor: HTMLElement, d: IndicatorDeps) {
  togglePopover(anchor, "below", "指標", (body, rerender) => {
    body.classList.add("ind-menu");
    const section = (title: string, kinds: MenuKind[]) => {
      body.append(el("div", "pop-section", title));
      for (const it of ITEMS.filter((i) => kinds.includes(i.kind))) {
        const row = el("div", "ind-row");
        const box = checkbox(isOn(it.kind, d.settings), `顯示／隱藏${it.name}`, (v) => {
          setOn(it.kind, v, d.settings);
          rerender();
        });
        const name = el("label", "ind-name");
        name.append(box, el("span", "", it.name), el("span", "ind-about", it.about));
        const gear = textButton("", "ind-gear", () => {
          closePopover();
          openIndicatorSettings(it.kind, anchor, d);
        }, `${it.name}設定`);
        row.append(name, gear);
        body.append(row);
      }
    };
    section("主圖", ["ma", "boll", "fvg", "ob", "sr"]);
    section("副圖：各自一格", ["rsi", "macd", "kd", "atr"]);
    body.append(el("div", "pop-note", "圖例上的鈴鐺可以設指標提醒，例如 RSI 到 80"));
  });
}

/** An indicator's settings window, next to `anchor` (the toolbar button, or the gear in its legend). */
export function openIndicatorSettings(kind: MenuKind, anchor: HTMLElement, d: IndicatorDeps) {
  const s = d.settings;
  switch (kind) {
    case "ma":
      toggleMaPanel(anchor, s.mas, s.maOptions, d.bar, indicatorAlertSection(d.alerts(), (s) => s.type === "ma", () => d.sources("ma"), () => d.preset("ma")));
      return;
    case "fvg":
      toggleFvgPanel(anchor, s.fvgs, d.bar);
      return;
    case "ob":
      toggleObPanel(anchor, s.obs, d.bar);
      return;
    case "sr":
      toggleSrPanel(anchor, s.srs, d.bar);
      return;
    default:
      toggleIndPanel(kind, anchor, { inds: s.inds, bar: d.bar, alerts: d.alerts, sources: d.sources, preset: d.preset });
  }
}
