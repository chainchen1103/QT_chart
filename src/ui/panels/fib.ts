// Fibonacci retracement levels and options.
// Each change is applied and saved at once through the callbacks; nothing waits for an OK button.

import { parseLevel } from "../../drawings/geometry.ts";
import {
  clone,
  DEFAULT_FIB,
  FIB_COLORS,
  LEVEL_RANGE,
  MAX_LEVELS,
  nextColor,
  sortLevels,
  type FibSettings,
} from "../../settings/model.ts";
import { checkbox, colorInput, el, flagBad, labelled, textButton } from "../dom.ts";
import { togglePopover, type Render } from "../popover.ts";

/** `extra`: a section for the Fib this was opened from (its alert), above the foot. */
export function toggleFibPanel(anchor: HTMLElement, fib: { get: () => FibSettings; set: (v: FibSettings) => void }, extra?: Render) {
  togglePopover(anchor, "right", "Fib 回撤", (body, rerender) => {
    const f = fib.get();
    const setF = (p: Partial<FibSettings>) => fib.set({ ...fib.get(), ...p });
    const setLevel = (i: number, p: Partial<FibSettings["levels"][number]>) =>
      setF({ levels: fib.get().levels.map((l, k) => (k === i ? { ...l, ...p } : l)) });

    body.append(el("div", "pop-section", "Fib 數值（勾選的才會畫）"));
    f.levels.forEach((l, i) => {
      const row = el("div", "pop-row");
      const on = checkbox(l.on, "顯示／隱藏", (v) => setLevel(i, { on: v }));
      const val = el("input");
      val.type = "text";
      val.inputMode = "decimal";
      val.value = String(l.value);
      val.title = "比例，例如 0.618；也可以打 61.8%";
      val.onchange = () => {
        const r = parseLevel(val.value, LEVEL_RANGE.min, LEVEL_RANGE.max);
        const dup = "value" in r && fib.get().levels.some((x, k) => k !== i && x.value === r.value);
        if (!("value" in r) || dup) {
          flagBad(val);
          val.value = String(l.value);
          return;
        }
        setF({ levels: sortLevels(fib.get().levels.map((x, k) => (k === i ? { ...x, value: r.value } : x))) });
        rerender();
      };
      val.onkeydown = (e) => {
        if (e.key === "Enter") val.blur();
      };
      const color = colorInput(l.color, (v) => setLevel(i, { color: v }));
      const del = textButton("×", "pop-del", () => {
        setF({ levels: fib.get().levels.filter((_, k) => k !== i) });
        rerender();
      }, "刪除這個數值");
      row.append(on, val, color, del);
      body.append(row);
    });
    if (!f.levels.length) body.append(el("div", "pop-note", "沒有數值。在下面輸入一個，例如 0.618。"));

    // add a level
    const addRow = el("div", "pop-row");
    const input = el("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.placeholder = "例如 0.705";
    input.className = "pop-add";
    const msg = el("div", "pop-msg");
    const add = () => {
      const r = parseLevel(input.value, LEVEL_RANGE.min, LEVEL_RANGE.max);
      const cur = fib.get().levels;
      if (!("value" in r)) msg.textContent = r.error;
      else if (cur.some((x) => x.value === r.value)) msg.textContent = "已經有這個數值";
      else if (cur.length >= MAX_LEVELS) msg.textContent = `最多 ${MAX_LEVELS} 個數值`;
      else {
        setF({ levels: sortLevels([...cur, { value: r.value, color: nextColor(FIB_COLORS, cur.map((x) => x.color)), on: true }]) });
        rerender();
        (document.querySelector(".popover .pop-add") as HTMLInputElement | null)?.focus();
        return;
      }
      flagBad(input);
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") add();
    };
    addRow.append(input, textButton("新增", "text-btn", add));
    body.append(addRow, msg);

    body.append(el("div", "pop-section", "顯示"));
    const opts = el("div", "pop-grid");
    opts.append(
      labelled(checkbox(f.extend, "", (v) => setF({ extend: v })), "線往右延伸"),
      labelled(checkbox(f.fill, "", (v) => setF({ fill: v })), "背景填色"),
      labelled(checkbox(f.showPrice, "", (v) => setF({ showPrice: v })), "顯示價格"),
      labelled(checkbox(f.reverse, "", (v) => setF({ reverse: v })), "反轉方向", "預設：第一個點是 1，第二個點是 0"),
    );
    body.append(opts);
    extra?.(body, rerender);

    const foot = el("div", "pop-foot");
    foot.append(el("span", "pop-note", "畫好的 Fib 會一起更新"), el("span", "spacer"), textButton("恢復預設數值", "link-btn", () => {
      fib.set(clone(DEFAULT_FIB));
      rerender();
    }));
    body.append(foot);
  });
}
