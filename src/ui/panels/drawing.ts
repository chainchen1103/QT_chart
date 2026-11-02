// Drawing tools: the line-kind menu, and the style of one line or rectangle.
// Each change is applied and saved at once through the callbacks; nothing waits for an OK button.

import {
  type Dash,
  type DrawKind,
  type LineDrawing,
  type LineStyle,
  type RectDrawing,
  type RectStyle,
  DASHES,
  LINE_WIDTHS,
  TOOL_INFO,
} from "../../settings/model.ts";
import { ICONS } from "../icons.ts";
import { checkbox, colorInput, el, labelled, lbl, textButton } from "../dom.ts";
import { closePopover, popoverAt, togglePopover, type Render } from "../popover.ts";

/** Flyout of a tool group in the left toolbar (e.g. the lines): pick one to start drawing. */
export function toggleToolMenu(anchor: HTMLElement, title: string, kinds: DrawKind[], current: DrawKind, onPick: (k: DrawKind) => void) {
  togglePopover(anchor, "right", title, (body) => {
    for (const k of kinds) {
      const row = el("button", "tool-row" + (k === current ? " active" : ""));
      row.type = "button";
      const icon = el("span", "tool-row-icon");
      icon.innerHTML = ICONS[k]; // our own fixed SVG
      row.append(icon, el("span", "tool-row-name", TOOL_INFO[k].name), el("span", "tool-row-key", TOOL_INFO[k].key));
      row.onclick = () => {
        closePopover();
        onPick(k);
      };
      body.append(row);
    }
  });
}

function widthSelect(value: number, onChange: (v: number) => void): HTMLSelectElement {
  const s = el("select");
  s.title = "粗細";
  for (const w of LINE_WIDTHS) s.append(new Option(`${w} px`, String(w), false, w === value));
  s.onchange = () => onChange(Number(s.value));
  return s;
}
function dashSelect(value: Dash, onChange: (v: Dash) => void): HTMLSelectElement {
  const s = el("select");
  s.title = "樣式";
  for (const d of DASHES) s.append(new Option(d.label, d.key, false, d.key === value));
  s.onchange = () => onChange(s.value as Dash);
  return s;
}

/** Style of one line or rectangle (double-click or right-click it). New drawings of that kind start from it. */
export function openDrawingStyle(
  x: number,
  y: number,
  d: LineDrawing | RectDrawing,
  cb: { set: (s: LineStyle | RectStyle) => void; remove: () => void },
  extra?: Render,
) {
  popoverAt(x, y, TOOL_INFO[d.kind].name, (body, rerender) => {
    if (d.kind === "rect") {
      let s: RectStyle = { ...d.style };
      const apply = (p: Partial<RectStyle>) => {
        s = { ...s, ...p };
        cb.set(s);
      };
      const border = el("div", "pop-row");
      border.append(
        lbl("邊框"),
        colorInput(s.border, (v) => apply({ border: v }), "邊框顏色"),
        widthSelect(s.width, (v) => apply({ width: v })),
        dashSelect(s.dash, (v) => apply({ dash: v })),
      );
      const fill = el("div", "pop-row");
      const range = el("input");
      range.type = "range";
      range.min = "0";
      range.max = "100";
      range.step = "5";
      range.value = String(s.transparency);
      const pct = el("span", "pop-lbl", `${s.transparency}%`);
      range.oninput = () => {
        pct.textContent = `${range.value}%`;
        apply({ transparency: Number(range.value) });
      };
      fill.append(lbl("填色"), colorInput(s.fill, (v) => apply({ fill: v }), "填色"), lbl("透明度"), range, pct);
      body.append(border, fill, labelled(checkbox(s.extend, "", (v) => apply({ extend: v })), "向右延伸"));
    } else {
      let s: LineStyle = { ...d.style };
      const apply = (p: Partial<LineStyle>) => {
        s = { ...s, ...p };
        cb.set(s);
      };
      const row = el("div", "pop-row");
      row.append(
        lbl("顏色"),
        colorInput(s.color, (v) => apply({ color: v })),
        lbl("粗細"),
        widthSelect(s.width, (v) => apply({ width: v })),
        lbl("樣式"),
        dashSelect(s.dash, (v) => apply({ dash: v })),
      );
      body.append(row);
    }
    extra?.(body, rerender);
    const foot = el("div", "pop-foot");
    foot.append(
      el("span", "pop-note"),
      el("span", "spacer"),
      textButton("刪除", "text-btn danger", () => {
        closePopover();
        cb.remove();
      }, "刪除這個畫線"),
    );
    body.append(foot);
  });
}
