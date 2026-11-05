// The settings window: the settings that belong to the whole app (not to one drawing or one indicator), in
// sections listed on the left. Each section is drawn by the same code as its quick window elsewhere (the chart
// appearance, the price-scale labels, the timeframe menu, the alert window, the position and account windows),
// so a change made in one place shows in the other. Changes are saved at once; nothing waits for an OK button.
// (The magnet stays with its button in the drawing toolbar.)

import type { Setting } from "../../core/setting.ts";
import type { BarSettings } from "../../settings/model.ts";
import { checkbox, el, labelled, textButton } from "../dom.ts";
import { openModal } from "../modal.ts";
import { POPOVER_CLOSED, type Render } from "../popover.ts";
import { MAX_BARS } from "../../chart/feed.ts";
import chartsLicense from "../../assets/licenses/lightweight-charts-LICENSE.txt?raw";
import fontLicense from "../../assets/licenses/Geist-OFL.txt?raw";

export type SettingsSection = "appearance" | "labels" | "bars" | "alerts" | "position" | "account" | "ai" | "performance" | "about";

export type SettingsIo = {
  appearance: Render;
  labels: Render;
  timeframes: Render;
  bars: Setting<BarSettings>;
  alerts: Render;
  position: Render;
  account: Render;
  ai: Render;
  performance: Render;
  /** Open tradingview.com (the chart library's credit). */
  openTradingView(): void;
};

const SECTIONS: { id: SettingsSection; name: string; note: string }[] = [
  { id: "appearance", name: "圖表外觀", note: "背景、格線、文字和 K 線的顏色與文字大小，所有圖表共用" },
  { id: "labels", name: "價格標籤", note: "價格標尺上顯示哪些標籤" },
  { id: "bars", name: "K 線與週期", note: "工具列上的週期、自己加的週期，和每個圖表載入多少 K 線" },
  { id: "alerts", name: "提醒", note: "所有價格提醒共用的聲音和通知" },
  { id: "position", name: "倉位", note: "新倉位的預設資金和風險，和所有倉位共用的 R 線、顏色" },
  { id: "account", name: "交易帳戶", note: "下單用的 OKX API" },
  { id: "ai", name: "AI 連線", note: "讓 AI 應用程式透過 MCP 操作 QT Chart" },
  { id: "performance", name: "效能", note: "繪圖方式" },
  { id: "about", name: "關於", note: "QT Chart 用到的套件和它們的授權" },
];

/** Open the settings window at a section. */
export function openSettings(io: SettingsIo, at: SettingsSection = "appearance") {
  let current = at;
  let sectionBody: HTMLElement | null = null;
  const leave = () => sectionBody?.dispatchEvent(new Event(POPOVER_CLOSED)); // what the section follows stops
  openModal({
    title: "設定",
    cls: "settings-win",
    onClose: leave,
    render: (body) => {
      const layout = el("div", "set-layout");
      const nav = el("nav", "set-nav");
      const main = el("div", "set-main");
      layout.append(nav, main);
      body.append(layout);
      const show = (id: SettingsSection) => {
        leave();
        current = id;
        for (const b of nav.querySelectorAll<HTMLElement>(".set-nav-item")) b.classList.toggle("active", b.dataset.id === id);
        const s = SECTIONS.find((x) => x.id === id)!;
        main.replaceChildren(el("div", "set-title", s.name), el("div", "set-note", s.note));
        const box = el("div", "set-body");
        main.append(box);
        sectionBody = box;
        const render = sectionRender(io, id);
        const rerender = () => {
          // the box in use stays in use across a redraw (found again by its data-key), as in popovers
          const act = document.activeElement;
          const key = act instanceof HTMLElement && box.contains(act) ? act.dataset.key : undefined;
          box.replaceChildren();
          render(box, rerender);
          const again = key ? box.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`) : null;
          again?.focus();
        };
        rerender();
        main.scrollTop = 0;
      };
      for (const s of SECTIONS) {
        const b = el("button", "set-nav-item", s.name);
        b.type = "button";
        b.dataset.id = s.id;
        b.onclick = () => show(s.id);
        nav.append(b);
      }
      show(current);
    },
  });
}

function sectionRender(io: SettingsIo, id: SettingsSection): Render {
  switch (id) {
    case "appearance":
      return io.appearance;
    case "labels":
      return io.labels;
    case "bars":
      return (body, rerender) => {
        io.timeframes(body, rerender);
        body.append(el("div", "pop-section", "K 線數量"));
        const b = io.bars.get();
        body.append(
          labelled(
            checkbox(b.unlimited, "", (v) => io.bars.set({ ...io.bars.get(), unlimited: v })),
            "開啟無上限的 K 線量",
            "往左捲動時一直載入更早的 K 線，直到 OKX 沒有資料為止",
          ),
          el("div", "pop-note", `關閉時每個圖表最多 ${MAX_BARS.toLocaleString()} 根，開啟較吃記憶體`),
        );
      };
    case "alerts":
      return io.alerts;
    case "position":
      return io.position;
    case "account":
      return io.account;
    case "ai":
      return io.ai;
    case "performance":
      return io.performance;
    case "about":
      return (body) => {
        const credit = textButton("TradingView Lightweight Charts™", "link-btn set-link", () => io.openTradingView(), "開啟 tradingview.com");
        body.append(
          el("div", "pop-section", "圖表"),
          aboutRow(credit, "Apache License 2.0。Copyright (с) 2025 TradingView, Inc."),
          el("div", "pop-section", "字型"),
          aboutRow(el("span", "", "Geist、Geist Mono"), "SIL Open Font License 1.1。Copyright (c) 2023 Vercel, in collaboration with basement.studio"),
          el("div", "pop-section", "行情和下單"),
          aboutRow(el("span", "", "OKX API"), "行情取自 OKX，金鑰只存在這台電腦"),
        );
        // the licences ask for their full text to go along with the program
        const full = el("pre", "set-license");
        full.hidden = true;
        full.textContent = `TradingView Lightweight Charts™\nCopyright (с) 2025 TradingView, Inc. https://www.tradingview.com/\n\n${chartsLicense}\n\n────────────────────────\n\nGeist, Geist Mono\n${fontLicense}`;
        const toggle = textButton("顯示授權全文", "link-btn", () => {
          full.hidden = !full.hidden;
          toggle.textContent = full.hidden ? "顯示授權全文" : "收起授權全文";
        });
        const row = el("div", "pop-row");
        row.append(toggle);
        body.append(row, full);
      };
  }
}

function aboutRow(name: HTMLElement, text: string): HTMLElement {
  const r = el("div", "set-about");
  r.append(name, el("div", "pop-note", text));
  return r;
}
