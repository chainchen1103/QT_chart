// The layout button's window: every layout as a small picture, by how many charts it holds. Also the small
// picture itself, which the tabs show too.

import { el } from "../ui/dom.ts";
import { closePopover, togglePopover } from "../ui/popover.ts";
import { cellCount, gridOf, LAYOUT_IDS, LAYOUTS, MAX_CELLS, type LayoutId } from "./model.ts";

const SVG = "http://www.w3.org/2000/svg";

/** The layout drawn as boxes, one per chart. */
export function layoutIcon(id: LayoutId, cls = "layout-icon"): SVGSVGElement {
  const g = gridOf(id);
  const rows = g.length;
  const cols = g[0].length;
  const W = 22;
  const H = 16;
  const gap = 1.6;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `-1 -1 ${W + 2} ${H + 2}`);
  svg.setAttribute("class", cls);
  for (const letter of new Set(g.flat())) {
    const at = g.flatMap((row, r) => row.flatMap((x, c) => (x === letter ? [[r, c]] : [])));
    const r0 = Math.min(...at.map((p) => p[0]));
    const r1 = Math.max(...at.map((p) => p[0]));
    const c0 = Math.min(...at.map((p) => p[1]));
    const c1 = Math.max(...at.map((p) => p[1]));
    const cw = (W + gap) / cols;
    const rh = (H + gap) / rows;
    const rect = document.createElementNS(SVG, "rect");
    rect.setAttribute("x", (c0 * cw).toFixed(2));
    rect.setAttribute("y", (r0 * rh).toFixed(2));
    rect.setAttribute("width", ((c1 - c0 + 1) * cw - gap).toFixed(2));
    rect.setAttribute("height", ((r1 - r0 + 1) * rh - gap).toFixed(2));
    rect.setAttribute("rx", "1.5");
    svg.append(rect);
  }
  return svg;
}

export function toggleLayoutPicker(anchor: HTMLElement, current: () => LayoutId, pick: (id: LayoutId) => void) {
  togglePopover(anchor, "below", "版面：一個分頁放幾個圖表", (body) => {
    for (let n = 1; n <= MAX_CELLS; n++) {
      const row = el("div", "layout-row");
      row.append(el("span", "pop-lbl layout-n", `${n} 個`));
      for (const id of LAYOUT_IDS.filter((x) => cellCount(x) === n)) {
        const b = el("button", "layout-btn" + (id === current() ? " active" : ""));
        b.type = "button";
        b.title = LAYOUTS[id].name;
        b.append(layoutIcon(id));
        b.onclick = () => {
          closePopover();
          pick(id);
        };
        row.append(b);
      }
      body.append(row);
    }
    body.append(
      el("div", "pop-note", "點圖表就換用那個圖表，藍框是使用中"),
      el("div", "pop-note", "拖曳圖表之間的分隔線調整大小，雙擊分隔線恢復平分"),
    );
  });
}
