// The charts of a tab laid out as a CSS grid, with the lines between them draggable to share the space
// differently (double-click a line: even again). The lines sit over the 1-pixel gaps between charts.

import { el } from "../ui/dom.ts";
import { centerDivider, cellLetter, dividers, gridOf, moveDivider, type Divider, type LayoutId, type Sizes } from "./model.ts";

const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

export class Grid {
  private layout: LayoutId = "1";
  private sizes: Sizes = { cols: [1], rows: [1] };
  private lines: HTMLElement[] = [];
  private readonly box: HTMLElement;
  /** The sizes changed by a drag (`done`: the drag ended, worth saving). */
  private readonly resized: (s: Sizes, done: boolean) => void;

  constructor(box: HTMLElement, resized: (s: Sizes, done: boolean) => void) {
    this.box = box;
    this.resized = resized;
  }

  /** Put the charts (in cell order) into the layout. */
  apply(layout: LayoutId, sizes: Sizes, charts: HTMLElement[]) {
    this.layout = layout;
    this.box.style.gridTemplateAreas = gridOf(layout).map((r) => `"${r.join(" ")}"`).join(" ");
    charts.forEach((c, i) => (c.style.gridArea = cellLetter(i)));
    this.box.classList.toggle("multi", charts.length > 1);
    this.setSizes(sizes);
  }

  private setSizes(sizes: Sizes) {
    this.sizes = sizes;
    const fr = (a: number[]) => a.map((f) => `minmax(0, ${f.toFixed(4)}fr)`).join(" ");
    this.box.style.gridTemplateColumns = fr(sizes.cols);
    this.box.style.gridTemplateRows = fr(sizes.rows);
    this.placeLines();
  }

  /** One element per divider, reused while the layout stays the same (so a drag keeps its element). */
  private placeLines() {
    const ds = dividers(this.layout, this.sizes);
    while (this.lines.length > ds.length) this.lines.pop()?.remove();
    while (this.lines.length < ds.length) this.lines.push(this.newLine(this.lines.length));
    ds.forEach((d, k) => {
      const s = this.lines[k].style;
      this.lines[k].classList.toggle("col", d.axis === "col");
      this.lines[k].classList.toggle("row", d.axis === "row");
      if (d.axis === "col") {
        Object.assign(s, { left: `calc(${pct(d.at)} - 3px)`, top: pct(d.from), width: "6px", height: pct(d.to - d.from) });
      } else {
        Object.assign(s, { top: `calc(${pct(d.at)} - 3px)`, left: pct(d.from), height: "6px", width: pct(d.to - d.from) });
      }
    });
  }

  private divider(k: number): Divider | undefined {
    return dividers(this.layout, this.sizes)[k];
  }

  private newLine(k: number): HTMLElement {
    const line = el("div", "divider");
    line.title = "拖曳調整大小；雙擊恢復平分";
    line.addEventListener("mousedown", (e) => {
      const d = this.divider(k);
      if (e.button !== 0 || !d) return;
      e.preventDefault();
      const r = this.box.getBoundingClientRect();
      const cls = d.axis === "col" ? "resizing-col" : "resizing-row";
      document.body.classList.add(cls);
      line.classList.add("dragging");
      const move = (ev: MouseEvent) => {
        const at = d.axis === "col" ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
        this.setSizes(moveDivider(this.sizes, d.axis, d.index, at));
        this.resized(this.sizes, false);
      };
      const up = () => {
        window.removeEventListener("mousemove", move, true);
        window.removeEventListener("mouseup", up, true);
        document.body.classList.remove(cls);
        line.classList.remove("dragging");
        this.resized(this.sizes, true);
      };
      window.addEventListener("mousemove", move, true);
      window.addEventListener("mouseup", up, true);
    });
    line.addEventListener("dblclick", () => {
      const d = this.divider(k);
      if (!d) return;
      this.setSizes(centerDivider(this.sizes, d.axis, d.index));
      this.resized(this.sizes, true);
    });
    this.box.append(line);
    return line;
  }
}
