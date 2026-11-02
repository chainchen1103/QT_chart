// Moving averages: add, remove, length, type, color, timeframe.
// Each change is applied and saved at once through the callbacks; nothing waits for an OK button.

import {
  clone,
  DEFAULT_MAS,
  MA_COLORS,
  MA_KINDS,
  MA_LEN,
  MAX_MAS,
  newId,
  nextColor,
  type MaConf,
  type MaKind,
  type MaOptions,
} from "../../settings/model.ts";
import { checkbox, colorInput, el, labelled, lbl, numInput, textButton } from "../dom.ts";
import { togglePopover } from "../popover.ts";
import { tfSelect } from "./controls.ts";

export function toggleMaPanel(
  anchor: HTMLElement,
  mas: { get: () => MaConf[]; set: (v: MaConf[]) => void },
  opts: { get: () => MaOptions; set: (v: MaOptions) => void },
  chartBar: () => string,
) {
  const patch = (id: string, p: Partial<MaConf>) => mas.set(mas.get().map((m) => (m.id === id ? { ...m, ...p } : m)));
  togglePopover(anchor, "below", "均線", (body, rerender) => {
    const list = mas.get();
    if (!list.length) body.append(el("div", "pop-note", "目前沒有均線。按「新增均線」加一條。"));
    for (const m of list) {
      const row = el("div", "pop-row");
      const kind = el("select");
      kind.title = "類型：SMA 簡單、EMA 指數、WMA 加權";
      for (const k of MA_KINDS) kind.append(new Option(k, k, false, k === m.kind));
      kind.onchange = () => patch(m.id, { kind: kind.value as MaKind });
      const len = numInput(m.length, MA_LEN, { title: `週期（${MA_LEN.min}～${MA_LEN.max} 根 K 線）`, width: 64 }, (v) => patch(m.id, { length: v }));
      row.append(
        checkbox(m.on, "顯示／隱藏", (v) => patch(m.id, { on: v })),
        kind,
        len,
        lbl("根"),
        tfSelect(m.tf, chartBar(), (v) => patch(m.id, { tf: v })),
        colorInput(m.color, (v) => patch(m.id, { color: v })),
        textButton("×", "pop-del", () => {
          mas.set(mas.get().filter((x) => x.id !== m.id));
          rerender();
        }, "刪除這條均線"),
      );
      body.append(row);
    }
    body.append(
      el("div", "pop-section", "高週期均線"),
      labelled(
        checkbox(opts.get().waitClose, "", (v) => opts.set({ ...opts.get(), waitClose: v })),
        "等那根 K 線收完才更新",
        "勾選：跟 TradingView 預設一樣，只用收完的高週期 K 線，線在高週期收線時才往前走一格，歷史不會變。\n不勾：最新那根高週期 K 線也算進去，線會跟著現價動。",
      ),
    );
    const foot = el("div", "pop-foot");
    const add = textButton("＋ 新增均線", "text-btn", () => {
      const cur = mas.get();
      const used = new Set(cur.map((m) => m.length));
      const length = [50, 30, 60, 120, 10, 5, 144, 169, 250].find((n) => !used.has(n)) ?? 50;
      mas.set([...cur, { id: newId("ma"), kind: "EMA", length, color: nextColor(MA_COLORS, cur.map((m) => m.color)), on: true, tf: "" }]);
      rerender();
    });
    add.disabled = list.length >= MAX_MAS;
    if (add.disabled) add.title = `最多 ${MAX_MAS} 條`;
    foot.append(add, el("span", "spacer"), textButton("恢復預設", "link-btn", () => {
      mas.set(clone(DEFAULT_MAS));
      rerender();
    }));
    body.append(foot);
  });
}
