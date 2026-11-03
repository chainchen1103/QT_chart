// Timeframes: every named one in groups (seconds to weeks), the ones the user added by count and unit, which
// of them sit on the toolbar (the star), and adding a new one. The toolbar's menu and the settings window show
// the same thing. Each change is saved at once; nothing waits for an OK button.

import type { Setting } from "../../core/setting.ts";
import { findTf, tfName, tfSec, TF_GROUPS, TF_UNITS, type TfUnit } from "../../core/timeframes.ts";
import { MAX_TF_BAR, MAX_TF_CUSTOM, type TimeframeSettings } from "../../settings/model.ts";
import { el, textButton } from "../dom.ts";
import type { Render } from "../popover.ts";

export type TimeframeIo = {
  timeframes: Setting<TimeframeSettings>;
  /** The chart in use's timeframe, and switching it (null when there is no chart to switch). */
  current(): string;
  pick: ((bar: string) => void) | null;
};

const STAR = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="m8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z"/></svg>`;

const bySec = (a: string, b: string) => tfSec(a) - tfSec(b);

/** The toolbar's timeframes, shortest first. */
export const toolbarBars = (t: TimeframeSettings): string[] => [...t.bar].sort(bySec);

export function renderTimeframes(io: TimeframeIo): Render {
  return (body, rerender) => {
    body.classList.add("tf-pop");
    const set = io.timeframes;
    const cur = io.current();
    const pinned = new Set(set.get().bar);
    const named = new Set(TF_GROUPS.flatMap((g) => g.bars));
    const togglePin = (bar: string) => {
      const t = set.get();
      if (t.bar.includes(bar)) {
        if (t.bar.length <= 1) return; // one stays on the toolbar
        set.set({ ...t, bar: t.bar.filter((b) => b !== bar) });
      } else if (t.bar.length < MAX_TF_BAR) {
        set.set({ ...t, bar: [...t.bar, bar] });
      }
      rerender();
    };
    const item = (bar: string, removable: boolean) => {
      const tf = findTf(bar);
      if (!tf) return el("span");
      const row = el("div", "tf-item" + (bar === cur ? " active" : ""));
      const pick = el("button", "tf-pick", tf.label);
      pick.type = "button";
      if (io.pick) {
        const go = io.pick;
        pick.title = `切換到 ${tf.label}`;
        pick.onclick = () => go(bar);
      } else pick.disabled = true;
      const star = el("button", "tf-star" + (pinned.has(bar) ? " on" : ""));
      star.type = "button";
      star.innerHTML = STAR; // our own fixed SVG
      star.title = pinned.has(bar) ? "從工具列拿掉" : pinned.size >= MAX_TF_BAR ? `工具列最多 ${MAX_TF_BAR} 個` : "放到工具列";
      star.onclick = () => togglePin(bar);
      row.append(pick, star);
      if (removable) {
        row.append(textButton("×", "pop-del", () => {
          const t = set.get();
          set.set({ bar: t.bar.length > 1 ? t.bar.filter((b) => b !== bar) : t.bar, custom: t.custom.filter((b) => b !== bar) });
          rerender();
        }, "刪除這個週期"));
      }
      return row;
    };
    for (const g of TF_GROUPS) {
      body.append(el("div", "pop-section", g.name));
      const grid = el("div", "tf-grid");
      for (const b of g.bars) grid.append(item(b, false));
      body.append(grid);
    }
    const custom = set.get().custom.filter((b) => !named.has(b)).sort(bySec);
    if (custom.length) {
      body.append(el("div", "pop-section", "自己加的"));
      const grid = el("div", "tf-grid");
      for (const b of custom) grid.append(item(b, true));
      body.append(grid);
    }

    // a new one by count and unit
    body.append(el("div", "pop-section", "新增週期"));
    const row = el("div", "pop-row");
    const n = el("input");
    n.type = "number";
    n.min = "1";
    n.max = "1439";
    n.step = "1";
    n.value = "10";
    n.title = "數字";
    const unit = el("select");
    for (const u of TF_UNITS) unit.append(new Option(u.label, u.unit, false, u.unit === "m"));
    const msg = el("div", "pop-msg");
    const add = () => {
      const bar = tfName(Number(n.value), unit.value as TfUnit);
      if (!bar) {
        msg.textContent = "做不出這個週期：秒 1–59、分 1–1439、時 1–23、日 1–90、週 1–12，而且要能用 OKX 的 K 線湊成（最多 240 根）";
        return;
      }
      const t = set.get();
      if (!named.has(bar) && !t.custom.includes(bar) && t.custom.length >= MAX_TF_CUSTOM) {
        msg.textContent = `最多自己加 ${MAX_TF_CUSTOM} 個週期`;
        return;
      }
      set.set({
        bar: t.bar.includes(bar) || t.bar.length >= MAX_TF_BAR ? t.bar : [...t.bar, bar],
        custom: named.has(bar) || t.custom.includes(bar) ? t.custom : [...t.custom, bar],
      });
      io.pick?.(bar);
      rerender();
    };
    n.onkeydown = (e) => {
      if (e.key === "Enter") add();
    };
    row.append(n, unit, textButton("新增", "text-btn", add, "加到清單和工具列，並切換過去"));
    body.append(row, msg);
    body.append(el("div", "pop-note", "星號標起來的會放在工具列上。OKX 沒有的週期（例如 10 秒、45 分、3 時）會用比較短的 K 線湊成。"));
  };
}
