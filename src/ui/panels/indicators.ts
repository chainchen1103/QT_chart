// Settings of Bollinger Bands, RSI, MACD, KD and ATR: numbers, colors, levels and timeframe, then the alerts on
// that indicator. Each change is applied and saved at once; nothing waits for an OK button.

import { indicatorAlertSection, type AlertUi, type IndPreset, type IndSource } from "../../alerts/panel.ts";
import type { Setting } from "../../core/setting.ts";
import { DEFAULT_INDS, IND_LIMITS, type IndKind, type IndSettings } from "../../settings/indicators.ts";
import { checkbox, colorInput, el, labelled, lbl, numInput, textButton } from "../dom.ts";
import { togglePopover } from "../popover.ts";
import { tfSelect } from "./controls.ts";

export const IND_TITLE: Record<IndKind, string> = { boll: "布林通道", rsi: "RSI", macd: "MACD", kd: "KD", atr: "ATR" };
const ABOUT: Record<IndKind, string> = {
  boll: "中軌是均線，上下軌是加減幾倍標準差",
  rsi: "相對強弱指標，上線以上偏超買，下線以下偏超賣",
  macd: "快慢兩條指數均線的差，和它的訊號線",
  kd: "隨機指標：收盤價在近期高低區間的位置",
  atr: "平均真實波幅，用來估波動和止損距離",
};

export type IndPanelDeps = {
  inds: Setting<IndSettings>;
  /** Timeframe of the chart in use. */
  bar(): string;
  alerts(): AlertUi;
  sources(kind: IndKind): IndSource[];
  preset(kind: IndKind): IndPreset;
};

const len = (v: number, title: string, onCommit: (v: number) => void) => numInput(v, IND_LIMITS.length, { title, width: 56 }, onCommit);
const level = (v: number, title: string, onCommit: (v: number) => void) =>
  numInput(v, IND_LIMITS.level, { title, width: 56, step: "1", int: false }, onCommit);

export function toggleIndPanel(kind: IndKind, anchor: HTMLElement, d: IndPanelDeps) {
  const patch = (p: Record<string, unknown>) => {
    const all = d.inds.get();
    d.inds.set({ ...all, [kind]: { ...all[kind], ...p } });
  };
  togglePopover(anchor, "below", IND_TITLE[kind], (body, rerender) => {
    const s = d.inds.get();
    const c = s[kind];
    body.append(el("div", "pop-note", ABOUT[kind]));
    const r1 = el("div", "pop-row");
    r1.append(
      labelled(checkbox(c.on, "", (v) => {
        patch({ on: v });
        rerender(); // the alert section needs it on
      }), "顯示"),
      lbl("用哪個週期算"),
      tfSelect(c.tf, d.bar(), (v) => patch({ tf: v })),
    );
    body.append(r1);
    const row = (...items: HTMLElement[]) => {
      const r = el("div", "pop-row");
      r.append(...items);
      body.append(r);
    };
    switch (kind) {
      case "boll": {
        const b = s.boll;
        row(lbl("週期"), len(b.length, "中軌是幾根 K 線的均線", (v) => patch({ length: v })), lbl("根，標準差"),
          numInput(b.mult, IND_LIMITS.mult, { title: "上下軌離中軌幾倍標準差", width: 56, step: "0.1", int: false }, (v) => patch({ mult: v })), lbl("倍"));
        row(lbl("顏色"), colorInput(b.color, (v) => patch({ color: v })), labelled(checkbox(b.fill, "", (v) => patch({ fill: v })), "上下軌之間填色"));
        break;
      }
      case "rsi": {
        const r = s.rsi;
        row(lbl("週期"), len(r.length, "看幾根 K 線的漲跌", (v) => patch({ length: v })), lbl("根"), lbl("顏色"), colorInput(r.color, (v) => patch({ color: v })));
        row(lbl("上線"), level(r.upper, "超買線", (v) => patch({ upper: v })), lbl("下線"), level(r.lower, "超賣線", (v) => patch({ lower: v })));
        break;
      }
      case "macd": {
        const m = s.macd;
        row(lbl("快線"), len(m.fast, "快的指數均線週期", (v) => patch({ fast: v })), lbl("慢線"), len(m.slow, "慢的指數均線週期", (v) => patch({ slow: v })),
          lbl("訊號線"), len(m.signal, "MACD 的指數均線週期", (v) => patch({ signal: v })));
        row(lbl("MACD"), colorInput(m.macdColor, (v) => patch({ macdColor: v })), lbl("訊號線"), colorInput(m.signalColor, (v) => patch({ signalColor: v })),
          lbl("柱體 正"), colorInput(m.up, (v) => patch({ up: v })), lbl("負"), colorInput(m.down, (v) => patch({ down: v })));
        break;
      }
      case "kd": {
        const k = s.kd;
        row(lbl("週期"), len(k.length, "看幾根 K 線的高低區間", (v) => patch({ length: v })), lbl("K 平滑"),
          numInput(k.smoothK, IND_LIMITS.smooth, { title: "K 是 RSV 的幾根均線", width: 52 }, (v) => patch({ smoothK: v })), lbl("D 平滑"),
          numInput(k.smoothD, IND_LIMITS.smooth, { title: "D 是 K 的幾根均線", width: 52 }, (v) => patch({ smoothD: v })));
        row(lbl("K"), colorInput(k.kColor, (v) => patch({ kColor: v })), lbl("D"), colorInput(k.dColor, (v) => patch({ dColor: v })),
          lbl("上線"), level(k.upper, "超買線", (v) => patch({ upper: v })), lbl("下線"), level(k.lower, "超賣線", (v) => patch({ lower: v })));
        break;
      }
      case "atr": {
        const a = s.atr;
        row(lbl("週期"), len(a.length, "幾根 K 線的平均", (v) => patch({ length: v })), lbl("根"), lbl("顏色"), colorInput(a.color, (v) => patch({ color: v })));
        break;
      }
    }
    const foot = el("div", "pop-foot");
    foot.append(el("span", "spacer"), textButton("恢復預設", "link-btn", () => {
      patch({ ...DEFAULT_INDS[kind], on: d.inds.get()[kind].on });
      rerender();
    }));
    body.append(foot);
    indicatorAlertSection(d.alerts(), kind, () => (d.inds.get()[kind].on ? d.sources(kind) : []), () => d.preset(kind))(body, rerender);
  });
}
