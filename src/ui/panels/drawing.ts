// Drawing tools: the menu of lines and channels, and the style of one line, channel or rectangle.
// Each change is applied and saved at once through the callbacks; nothing waits for an OK button.

import { fmtLevel, parseLevel } from "../../drawings/geometry.ts";
import {
  type ChannelDrawing,
  type ChannelLevel,
  type ChannelStyle,
  type Dash,
  type DrawKind,
  type LineDrawing,
  type LineStyle,
  type RectDrawing,
  type RectStyle,
  CHANNEL_DEV,
  clone,
  DASHES,
  isChannelDrawing,
  LEVEL_RANGE,
  LINE_WIDTHS,
  MAX_CHANNEL_LEVELS,
  TOOL_INFO,
} from "../../settings/model.ts";
import { ICONS } from "../icons.ts";
import { checkbox, colorInput, el, flagBad, keycaps, labelled, lbl, numInput, textButton } from "../dom.ts";
import { closePopover, popoverAt, togglePopover, type Render } from "../popover.ts";

/** Flyout of a tool group in the left toolbar (the lines and channels), in sections: pick one to start drawing. */
export function toggleToolMenu(
  anchor: HTMLElement, title: string, groups: { title: string; kinds: DrawKind[] }[], current: DrawKind, onPick: (k: DrawKind) => void,
) {
  togglePopover(anchor, "right", title, (body) => {
    for (const g of groups) {
      body.append(el("div", "tool-group", g.title));
      for (const k of g.kinds) {
        const row = el("button", "tool-row" + (k === current ? " active" : ""));
        row.type = "button";
        const icon = el("span", "tool-row-icon");
        icon.innerHTML = ICONS[k]; // our own fixed SVG
        row.append(icon, el("span", "tool-row-name", TOOL_INFO[k].name));
        if (TOOL_INFO[k].key) row.append(keycaps(TOOL_INFO[k].key, "keys tool-row-key")); // no empty keycap for none
        row.onclick = () => {
          closePopover();
          onPick(k);
        };
        body.append(row);
      }
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

/** Fill color and its transparency (0% solid, 100% none). */
function fillRow(fill: string, transparency: number, apply: (p: { fill?: string; transparency?: number }) => void): HTMLElement {
  const row = el("div", "pop-row");
  const range = el("input");
  range.type = "range";
  range.min = "0";
  range.max = "100";
  range.step = "5";
  range.value = String(transparency);
  const pct = el("span", "pop-lbl", `${transparency}%`);
  range.oninput = () => {
    pct.textContent = `${range.value}%`;
    apply({ transparency: Number(range.value) });
  };
  row.append(lbl("填色"), colorInput(fill, (v) => apply({ fill: v }), "填色"), lbl("透明度"), range, pct);
  return row;
}

/** Style of one line, channel or rectangle (double-click or right-click it). New drawings of that kind start from it. */
export function openDrawingStyle(
  x: number,
  y: number,
  d: LineDrawing | ChannelDrawing | RectDrawing,
  cb: { set: (s: LineStyle | RectStyle | ChannelStyle) => void; remove: () => void },
  extra?: Render,
) {
  // a channel's style as it is now, across redraws of the window (it changes with each pick)
  let cs: ChannelStyle | null = isChannelDrawing(d) ? clone(d.style) : null;
  popoverAt(x, y, TOOL_INFO[d.kind].name, (body, rerender) => {
    if (cs && isChannelDrawing(d)) {
      channelRows(body, rerender, d, () => cs!, (v) => {
        cs = v;
        cb.set(v);
      });
    } else if (d.kind === "rect") {
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
      body.append(border, fillRow(s.fill, s.transparency, apply), labelled(checkbox(s.extend, "", (v) => apply({ extend: v })), "向右延伸"));
    } else if (!isChannelDrawing(d)) {
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

/** What a level is, in words: "下軌", "中間", "上軌上方 1 倍寬", ... */
function levelWords(v: number): string {
  if (v === 0) return "和下軌重疊";
  if (v === 1) return "和上軌重疊";
  if (v === 0.5) return "正中間";
  if (v < 0) return `下軌下方 ${fmtLevel(-v)} 倍寬`;
  if (v > 1) return `上軌上方 ${fmtLevel(v - 1)} 倍寬`;
  return `下軌上方 ${fmtLevel(v)} 倍寬`;
}

const byValue = (l: ChannelLevel[]) => [...l].sort((a, b) => a.value - b.value);

/**
 * A channel's settings: its lines and fill, a regression trend's standard deviations and Pearson's R, the
 * middle line, extending, and the lines in proportion to its width (added, changed, switched, deleted here).
 */
function channelRows(body: HTMLElement, rerender: () => void, d: ChannelDrawing, get: () => ChannelStyle, set: (s: ChannelStyle) => void) {
  const apply = (p: Partial<ChannelStyle>) => set({ ...get(), ...p });
  const s = get();
  const lines = el("div", "pop-row");
  lines.append(
    lbl("線條"),
    colorInput(s.color, (v) => apply({ color: v }), "線條顏色"),
    widthSelect(s.width, (v) => apply({ width: v })),
    dashSelect(s.dash, (v) => apply({ dash: v })),
  );
  body.append(lines, fillRow(s.fill, s.transparency, apply));
  if (d.kind === "regression") {
    const dev = el("div", "pop-row");
    const box = numInput(s.dev, CHANNEL_DEV, { title: "上下兩條線離迴歸線幾個標準差", step: "0.1", int: false, width: 64 }, (v) => apply({ dev: v }));
    box.dataset.key = "dev";
    dev.append(lbl("上下各"), box, lbl("個標準差"));
    body.append(dev);
  }
  const opts = el("div", "pop-grid");
  opts.append(
    labelled(checkbox(s.middle, "", (v) => apply({ middle: v })), d.kind === "regression" ? "迴歸線" : "中線"),
    labelled(checkbox(s.extendLeft, "", (v) => apply({ extendLeft: v })), "向左延伸"),
    labelled(checkbox(s.extendRight, "", (v) => apply({ extendRight: v })), "向右延伸"),
  );
  if (d.kind === "regression") opts.append(labelled(checkbox(s.pearson, "", (v) => apply({ pearson: v })), "皮爾森相關係數 R"));
  body.append(opts);

  body.append(el("div", "pop-section", "等比線"));
  body.append(el("div", "pop-note", "以通道寬度為單位：0 下軌，0.5 中線，1 上軌"));
  const setLevels = (levels: ChannelLevel[]) => apply({ levels: byValue(levels) });
  s.levels.forEach((l, i) => {
    const row = el("div", "pop-row");
    const on = checkbox(l.on, "顯示／隱藏", (v) => setLevels(get().levels.map((x, k) => (k === i ? { ...x, on: v } : x))));
    const val = el("input");
    val.type = "text";
    val.inputMode = "decimal";
    val.value = fmtLevel(l.value);
    val.title = "幾倍通道寬度";
    val.dataset.key = `level-${i}`;
    val.onchange = () => {
      const r = parseLevel(val.value, LEVEL_RANGE.min, LEVEL_RANGE.max);
      if (!("value" in r) || get().levels.some((x, k) => k !== i && x.value === r.value)) {
        flagBad(val);
        val.value = fmtLevel(l.value);
        return;
      }
      setLevels(get().levels.map((x, k) => (k === i ? { ...x, value: r.value } : x)));
      rerender();
    };
    val.onkeydown = (e) => {
      if (e.key === "Enter") val.blur();
    };
    const del = textButton("×", "pop-del", () => {
      setLevels(get().levels.filter((_, k) => k !== i));
      rerender();
    }, "刪除這條線");
    row.append(on, val, lbl(levelWords(l.value)), del);
    body.append(row);
  });
  const addRow = el("div", "pop-row");
  const input = el("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.placeholder = "例如 0.5、-1";
  input.style.width = "120px";
  input.dataset.key = "add-level";
  const msg = el("div", "pop-msg");
  const add = () => {
    const r = parseLevel(input.value, LEVEL_RANGE.min, LEVEL_RANGE.max);
    const cur = get().levels;
    if (!("value" in r)) msg.textContent = r.error;
    else if (cur.some((x) => x.value === r.value)) msg.textContent = "已經有這條線";
    else if (cur.length >= MAX_CHANNEL_LEVELS) msg.textContent = `最多 ${MAX_CHANNEL_LEVELS} 條`;
    else {
      setLevels([...cur, { value: r.value, on: true }]);
      rerender(); // the box stays in use (data-key), empty, for the next one
      return;
    }
    flagBad(input);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") add();
  };
  addRow.append(input, textButton("新增", "text-btn", add, "在這個通道加一條等比線"));
  body.append(addRow, msg);
}
