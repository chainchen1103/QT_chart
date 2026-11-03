// What a script shows: plots, shapes, horizontal lines, fills, background and bar colors (one value per bar),
// and drawing objects (lines, labels, boxes, tables, line fills, polylines) that live until deleted or until
// there are too many. Also the script's settings (indicator() / strategy()) and its inputs.

import { DEFAULT_BLUE, EnumVal, hexColor, isNa, PineError, PineObject, truthy, withT, colT, type InputDef, type Runtime, type UdtDef } from "./runtime.ts";
import { Broker } from "./strategy.ts";
import { num, toInt, type Lib } from "./lib/types.ts";

// ----------------------------------------------------------------------------- per-bar outputs

export type PlotOut = {
  kind: "plot";
  key: string;
  /** Its settings were read (they don't change from bar to bar). */
  init: boolean;
  title: string;
  values: Float64Array;
  colors: Float64Array;
  style: string;
  linewidth: number;
  offset: number;
  histbase: number;
  trackprice: boolean;
  display: number;
  join: boolean;
  precision: number | null;
  format: string;
  overlay: boolean;
};
export type ShapeOut = {
  kind: "shape";
  key: string;
  init: boolean;
  title: string;
  on: Uint8Array;
  y: Float64Array;
  colors: Float64Array;
  textcolors: Float64Array;
  /** shape.* name, or "char" for plotchar. */
  shape: string;
  char: string;
  text: string;
  location: string;
  size: string;
  offset: number;
  display: number;
  overlay: boolean;
};
export type ArrowOut = { kind: "arrow"; key: string; title: string; values: Float64Array; up: Float64Array; down: Float64Array; offset: number; minh: number; maxh: number; display: number };
export type CandleOut = {
  kind: "candle" | "bar";
  key: string;
  title: string;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  colors: Float64Array;
  wicks: Float64Array;
  borders: Float64Array;
  display: number;
};
export type HlineOut = { kind: "hline"; key: string; title: string; price: number; color: number; style: string; width: number; display: number };
export type FillOut = {
  kind: "fill";
  key: string;
  title: string;
  a: PlotOut | HlineOut;
  b: PlotOut | HlineOut;
  colors: Float64Array;
  /** Gradient fills: the values and colors at the top and bottom of each bar's band. */
  grad: { top: Float64Array; bottom: Float64Array; topColor: Float64Array; bottomColor: Float64Array } | null;
  fillgaps: boolean;
  display: number;
};
export type BgOut = { kind: "bg" | "barcolor"; key: string; title: string; colors: Float64Array; offset: number; display: number; overlay: boolean };

// ----------------------------------------------------------------------------- drawing objects

export class PLine {
  readonly kind = "line";
  dead = false;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  xloc: string;
  extend: string;
  color: number;
  style: string;
  width: number;
  constructor(x1: number, y1: number, x2: number, y2: number, xloc: string, extend: string, color: number, style: string, width: number) {
    this.x1 = x1;
    this.y1 = y1;
    this.x2 = x2;
    this.y2 = y2;
    this.xloc = xloc;
    this.extend = extend;
    this.color = color;
    this.style = style;
    this.width = width;
  }
}
export class PLabel {
  readonly kind = "label";
  dead = false;
  x: number;
  y: number;
  text: string;
  xloc: string;
  yloc: string;
  color: number;
  style: string;
  textcolor: number;
  size: string;
  textalign: string;
  tooltip: string;
  constructor(x: number, y: number, text: string, xloc: string, yloc: string, color: number, style: string, textcolor: number, size: string, textalign: string, tooltip: string) {
    this.x = x;
    this.y = y;
    this.text = text;
    this.xloc = xloc;
    this.yloc = yloc;
    this.color = color;
    this.style = style;
    this.textcolor = textcolor;
    this.size = size;
    this.textalign = textalign;
    this.tooltip = tooltip;
  }
}
export class PBox {
  readonly kind = "box";
  dead = false;
  left: number;
  top: number;
  right: number;
  bottom: number;
  border_color: number;
  border_width: number;
  border_style: string;
  extend: string;
  xloc: string;
  bgcolor: number;
  text: string;
  text_size: string;
  text_color: number;
  text_halign: string;
  text_valign: string;
  text_wrap: string;
  constructor(left: number, top: number, right: number, bottom: number, border_color: number, border_width: number, border_style: string, extend: string, xloc: string, bgcolor: number, text: string, text_size: string, text_color: number, text_halign: string, text_valign: string, text_wrap: string) {
    this.left = left;
    this.top = top;
    this.right = right;
    this.bottom = bottom;
    this.border_color = border_color;
    this.border_width = border_width;
    this.border_style = border_style;
    this.extend = extend;
    this.xloc = xloc;
    this.bgcolor = bgcolor;
    this.text = text;
    this.text_size = text_size;
    this.text_color = text_color;
    this.text_halign = text_halign;
    this.text_valign = text_valign;
    this.text_wrap = text_wrap;
  }
}
export type Cell = { text: string; width: number; height: number; text_color: number; text_halign: string; text_valign: string; text_size: string; bgcolor: number; tooltip: string };
export class PTable {
  readonly kind = "table";
  dead = false;
  cells = new Map<string, Cell>();
  merges: [number, number, number, number][] = [];
  position: string;
  columns: number;
  rows: number;
  bgcolor: number;
  frame_color: number;
  frame_width: number;
  border_color: number;
  border_width: number;
  constructor(position: string, columns: number, rows: number, bgcolor: number, frame_color: number, frame_width: number, border_color: number, border_width: number) {
    this.position = position;
    this.columns = columns;
    this.rows = rows;
    this.bgcolor = bgcolor;
    this.frame_color = frame_color;
    this.frame_width = frame_width;
    this.border_color = border_color;
    this.border_width = border_width;
  }
}
export class PLinefill {
  readonly kind = "linefill";
  dead = false;
  l1: PLine;
  l2: PLine;
  color: number;
  constructor(l1: PLine, l2: PLine, color: number) {
    this.l1 = l1;
    this.l2 = l2;
    this.color = color;
  }
}
export class PPolyline {
  readonly kind = "polyline";
  dead = false;
  pts: { x: number; y: number }[];
  curved: boolean;
  closed: boolean;
  xloc: string;
  line_color: number;
  fill_color: number;
  line_style: string;
  line_width: number;
  constructor(pts: { x: number; y: number }[], curved: boolean, closed: boolean, xloc: string, line_color: number, fill_color: number, line_style: string, line_width: number) {
    this.pts = pts;
    this.curved = curved;
    this.closed = closed;
    this.xloc = xloc;
    this.line_color = line_color;
    this.fill_color = fill_color;
    this.line_style = line_style;
    this.line_width = line_width;
  }
}
export type Drawing = PLine | PLabel | PBox | PTable | PLinefill | PPolyline;

export const CHART_POINT: UdtDef = {
  name: "chart.point",
  fields: ["time", "index", "price"],
  ix: { time: 0, index: 1, price: 2 },
  defs: [() => NaN, () => NaN, () => NaN],
};
const point = (time: number, index: number, price: number) => new PineObject(CHART_POINT, [time, index, price]);
const isPoint = (v: unknown): v is PineObject => v instanceof PineObject && v.t === CHART_POINT;

// ----------------------------------------------------------------------------- everything shown

export class Outputs {
  plots: PlotOut[] = [];
  shapes: ShapeOut[] = [];
  arrows: ArrowOut[] = [];
  candles: CandleOut[] = [];
  hlines: HlineOut[] = [];
  fills: FillOut[] = [];
  bgs: BgOut[] = [];
  lines: PLine[] = [];
  labels: PLabel[] = [];
  boxes: PBox[] = [];
  tables: PTable[] = [];
  linefills: PLinefill[] = [];
  polylines: PPolyline[] = [];
  private used = new Map<number, number>();

  readonly n: number;
  constructor(n: number) {
    this.n = n;
  }

  /** A key that stays the same between runs: the call's node, and which time it made one. */
  key(id: number): string {
    const k = this.used.get(id) ?? 0;
    this.used.set(id, k + 1);
    return k ? `${id}#${k}` : String(id);
  }
  series = (fill = NaN) => new Float64Array(this.n).fill(fill);

  add<T extends Drawing>(R: Runtime, list: T[], d: T, max: number): T {
    list.push(d);
    while (list.length > Math.max(1, max)) {
      const old = list.shift()!;
      old.dead = true;
    }
    if (list.length > 600) R.warn("畫線物件太多，只保留最新的");
    return d;
  }
  remove(d: Drawing | unknown) {
    if (!d || typeof d !== "object" || !("kind" in d) || (d as Drawing).dead) return;
    const o = d as Drawing;
    o.dead = true;
    const list = (o.kind === "line" ? this.lines : o.kind === "label" ? this.labels : o.kind === "box" ? this.boxes : o.kind === "table" ? this.tables : o.kind === "linefill" ? this.linefills : this.polylines) as Drawing[];
    const i = list.indexOf(o);
    if (i >= 0) list.splice(i, 1);
    if (o.kind === "line") for (const f of this.linefills.slice()) if (f.l1 === o || f.l2 === o) this.remove(f);
  }
}

// ----------------------------------------------------------------------------- argument helpers

/** Positional arguments (by the form's parameter names) and named ones, as one record. */
function args(pos: unknown[], named: Record<string, unknown>, names: string[]): Record<string, unknown> {
  const o: Record<string, unknown> = { ...named };
  for (let i = 0; i < pos.length && i < names.length; i++) if (pos[i] !== undefined && o[names[i]] === undefined) o[names[i]] = pos[i];
  return o;
}
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : v instanceof EnumVal ? v.title : d);
const col = (v: unknown, d: number): number => (v === undefined ? d : typeof v === "number" ? v : NaN);
const bool = (v: unknown, d: boolean) => (v === undefined ? d : !!v && v === v);
/** display.* flags: in the pane (1), data window (2), on the price scale (4), in the legend (8). */
export const DISPLAY = { pane: 1, data: 2, scale: 4, legend: 8, all: 15 };
const shown = (v: unknown): number => (v === undefined ? DISPLAY.all : typeof v === "number" ? v : v === "none" ? 0 : DISPLAY.all);
/** v4's `transp` argument. */
const transp = (c: number, t: unknown) => (typeof t === "number" && c === c ? withT(c, t) : c);

function initPlot(R: Runtime, id: number): PlotOut {
  const o = R.out;
  const p: PlotOut = {
    kind: "plot", key: o.key(id), init: false, title: "", values: o.series(), colors: o.series(), style: "line", linewidth: 1, offset: 0,
    histbase: 0, trackprice: false, display: DISPLAY.all, join: false, precision: null, format: "inherit", overlay: false,
  };
  o.plots.push(p);
  return p;
}

// ----------------------------------------------------------------------------- the library

const PLOT = ["series", "title", "color", "linewidth", "style", "trackprice", "histbase", "offset", "join", "editable", "show_last", "display", "format", "precision", "force_overlay"];
const SHAPE = ["series", "title", "style", "location", "color", "offset", "text", "textcolor", "editable", "size", "show_last", "display", "format", "precision", "force_overlay"];
const CHAR = ["series", "title", "char", "location", "color", "offset", "text", "textcolor", "editable", "size", "show_last", "display", "format", "precision", "force_overlay"];
const ARROW = ["series", "title", "colorup", "colordown", "offset", "minheight", "maxheight", "editable", "show_last", "display", "format", "precision", "force_overlay"];
const CANDLE = ["open", "high", "low", "close", "title", "color", "wickcolor", "editable", "show_last", "bordercolor", "display", "format", "precision", "force_overlay"];
const BARS = ["open", "high", "low", "close", "title", "color", "editable", "show_last", "display", "format", "precision", "force_overlay"];
const HLINE = ["price", "title", "color", "linestyle", "linewidth", "editable", "display"];
const FILL_H = ["hline1", "hline2", "color", "title", "editable", "fillgaps", "display"];
const FILL_P = ["plot1", "plot2", "color", "title", "editable", "show_last", "fillgaps", "display"];
const FILL_G = ["plot1", "plot2", "top_value", "bottom_value", "top_color", "bottom_color", "title", "display", "fillgaps", "editable"];
const BG = ["color", "offset", "editable", "show_last", "title", "display", "force_overlay"];

const LINE_XY = ["x1", "y1", "x2", "y2", "xloc", "extend", "color", "style", "width", "force_overlay"];
const LINE_PT = ["first_point", "second_point", "xloc", "extend", "color", "style", "width", "force_overlay"];
const LABEL_XY = ["x", "y", "text", "xloc", "yloc", "color", "style", "textcolor", "size", "textalign", "tooltip", "text_font_family", "force_overlay", "text_formatting"];
const LABEL_PT = ["point", "text", "xloc", "yloc", "color", "style", "textcolor", "size", "textalign", "tooltip", "text_font_family", "force_overlay", "text_formatting"];
const BOX_XY = ["left", "top", "right", "bottom", "border_color", "border_width", "border_style", "extend", "xloc", "bgcolor", "text", "text_size", "text_color", "text_halign", "text_valign", "text_wrap", "text_font_family", "force_overlay", "text_formatting"];
const BOX_PT = ["top_left", "bottom_right", "border_color", "border_width", "border_style", "extend", "xloc", "bgcolor", "text", "text_size", "text_color", "text_halign", "text_valign", "text_wrap", "text_font_family", "force_overlay", "text_formatting"];
const TABLE = ["position", "columns", "rows", "bgcolor", "frame_color", "frame_width", "border_color", "border_width", "force_overlay"];
const CELL = ["table_id", "column", "row", "text", "width", "height", "text_color", "text_halign", "text_valign", "text_size", "bgcolor", "tooltip", "text_font_family", "text_formatting"];

const GRAY = hexColor("#787B86");
const GREEN = hexColor("#4CAF50");
const RED = hexColor("#FF5252");
const BLACK = hexColor("#000000");
const WHITE = hexColor("#FFFFFF");

function xOf(p: PineObject, xloc: string): number {
  return num(xloc === "bar_time" ? p.f[0] : p.f[1]);
}
function line(v: unknown): PLine {
  if (!(v instanceof PLine)) throw new PineError(isNa(v) ? "線是 na（還沒建立或已刪除）" : "這不是線");
  return v;
}
function label(v: unknown): PLabel {
  if (!(v instanceof PLabel)) throw new PineError(isNa(v) ? "標籤是 na（還沒建立或已刪除）" : "這不是標籤");
  return v;
}
function box(v: unknown): PBox {
  if (!(v instanceof PBox)) throw new PineError(isNa(v) ? "方框是 na（還沒建立或已刪除）" : "這不是方框");
  return v;
}
function table(v: unknown): PTable {
  if (!(v instanceof PTable)) throw new PineError(isNa(v) ? "表格是 na（還沒建立或已刪除）" : "這不是表格");
  return v;
}

/** Setters: `line.set_color(id, c)` → a function setting that field. */
function setters<T>(ns: string, get: (v: unknown) => T, fields: Record<string, (o: T, v: unknown) => void>): Lib {
  const out: Lib = {};
  for (const [name, set] of Object.entries(fields)) {
    out[`${ns}.set_${name}`] = {
      p: ["id", "value", "value2"],
      f: (_R, a) => {
        if (isNa(a[0])) return NaN;
        set(get(a[0]), a.length > 2 && a[2] !== undefined ? [a[1], a[2]] : a[1]);
        return NaN;
      },
    };
  }
  return out;
}

const pair = (v: unknown): [unknown, unknown] => (Array.isArray(v) ? [v[0], v[1]] : [v, undefined]);

export const OUTPUTS: Lib = {
  // ---- per-bar plots
  plot: {
    p: PLOT,
    st: initPlot,
    n: (R, pos, named, p: PlotOut) => {
      const i = R.i;
      const v = named.series !== undefined ? named.series : pos[0];
      p.values[i] = typeof v === "boolean" ? (v ? 1 : 0) : num(v);
      p.colors[i] = transp(col(named.color !== undefined ? named.color : pos[2], DEFAULT_BLUE), named.transp);
      if (!p.init) {
        p.init = true;
        const a = args(pos, named, PLOT);
        p.title = str(a.title, p.title);
        p.style = str(a.style, "line");
        p.linewidth = Math.max(1, num(a.linewidth, 1));
        p.offset = toInt(a.offset ?? 0) || 0;
        p.histbase = num(a.histbase, 0);
        p.trackprice = bool(a.trackprice, false);
        p.display = shown(a.display);
        p.join = bool(a.join, false);
        p.precision = a.precision === undefined ? null : toInt(a.precision);
        p.format = str(a.format, "inherit");
        p.overlay = bool(a.force_overlay, false);
      }
      return p;
    },
  },
  plotshape: { p: SHAPE, st: (R, id) => initShape(R, id, "shape"), n: (R, pos, named, s: ShapeOut) => shape(R, pos, named, SHAPE, s) },
  plotchar: { p: CHAR, st: (R, id) => initShape(R, id, "char"), n: (R, pos, named, s: ShapeOut) => shape(R, pos, named, CHAR, s) },
  plotarrow: {
    p: ARROW,
    st: (R, id) => {
      const o = R.out;
      const s: ArrowOut = { kind: "arrow", key: o.key(id), title: "", values: o.series(), up: o.series(), down: o.series(), offset: 0, minh: 5, maxh: 100, display: DISPLAY.all };
      o.arrows.push(s);
      return s;
    },
    n: (R, pos, named, s: ArrowOut) => {
      const a = args(pos, named, ARROW);
      const i = R.i;
      s.values[i] = num(a.series);
      s.up[i] = transp(col(a.colorup, GREEN), a.transp);
      s.down[i] = transp(col(a.colordown, RED), a.transp);
      s.title = str(a.title, s.title);
      s.offset = toInt(a.offset ?? 0) || 0;
      s.minh = num(a.minheight, 5);
      s.maxh = num(a.maxheight, 100);
      s.display = shown(a.display);
      return NaN;
    },
  },
  plotcandle: { p: CANDLE, st: (R, id) => initCandle(R, id, "candle"), n: (R, pos, named, s: CandleOut) => candle(R, args(pos, named, CANDLE), s) },
  plotbar: { p: BARS, st: (R, id) => initCandle(R, id, "bar"), n: (R, pos, named, s: CandleOut) => candle(R, args(pos, named, BARS), s) },
  hline: {
    p: HLINE,
    st: (R, id) => {
      const o = R.out;
      const h: HlineOut = { kind: "hline", key: o.key(id), title: "", price: NaN, color: GRAY, style: "dashed", width: 1, display: DISPLAY.all };
      o.hlines.push(h);
      return h;
    },
    n: (_R, pos, named, h: HlineOut & { init?: boolean }) => {
      if (h.init) return h;
      h.init = true;
      const a = args(pos, named, HLINE);
      h.price = num(a.price);
      h.title = str(a.title, h.title);
      h.color = col(a.color, GRAY);
      h.style = str(a.linestyle, "dashed");
      h.width = Math.max(1, num(a.linewidth, 1));
      h.display = shown(a.display);
      return h;
    },
  },
  fill: {
    p: FILL_P,
    st: (R, id) => ({ key: R.out.key(id), out: null as FillOut | null }),
    n: (R, pos, named, st: { key: string; out: FillOut | null }) => {
      const grad = named.top_value !== undefined || typeof pos[3] === "number";
      const first = (pos[0] ?? named.plot1 ?? named.hline1) as PlotOut | HlineOut | undefined;
      const hl = first?.kind === "hline";
      const a = args(pos, named, grad ? FILL_G : hl ? FILL_H : FILL_P);
      const p1 = (a.plot1 ?? a.hline1) as PlotOut | HlineOut | undefined;
      const p2 = (a.plot2 ?? a.hline2) as PlotOut | HlineOut | undefined;
      if (!p1 || !p2 || typeof p1 !== "object" || typeof p2 !== "object") return NaN;
      let f = st.out;
      if (!f) {
        const o = R.out;
        f = { kind: "fill", key: st.key, title: "", a: p1, b: p2, colors: o.series(), grad: null, fillgaps: false, display: DISPLAY.all };
        if (grad) f.grad = { top: o.series(), bottom: o.series(), topColor: o.series(), bottomColor: o.series() };
        st.out = f;
        o.fills.push(f);
      }
      const i = R.i;
      const v4 = R.version <= 4;
      const dflt = withT(DEFAULT_BLUE, 90);
      let c = transp(col(a.color, dflt), a.transp ?? (v4 && a.color !== undefined && colT(num(a.color)) === 0 ? 90 : undefined));
      if (f.grad) {
        f.grad.top[i] = num(a.top_value);
        f.grad.bottom[i] = num(a.bottom_value);
        f.grad.topColor[i] = col(a.top_color, NaN);
        f.grad.bottomColor[i] = col(a.bottom_color, NaN);
        c = NaN;
      }
      f.colors[i] = c;
      f.title = str(a.title, f.title);
      f.fillgaps = bool(a.fillgaps, false);
      f.display = shown(a.display);
      return f;
    },
  },
  bgcolor: {
    p: BG,
    st: (R, id) => initBg(R, id, "bg"),
    n: (R, pos, named, s: BgOut & { init?: boolean }) => {
      if (!s.init) {
        s.init = true;
        const a = args(pos, named, BG);
        s.offset = toInt(a.offset ?? 0) || 0;
        s.title = str(a.title, s.title);
        s.display = shown(a.display);
        s.overlay = bool(a.force_overlay, false);
      }
      let c = col(named.color !== undefined ? named.color : pos[0], NaN);
      if (R.version <= 4 && c === c && named.transp === undefined && colT(c) === 0) c = withT(c, 90);
      s.colors[R.i] = transp(c, named.transp);
      return NaN;
    },
  },
  barcolor: {
    p: BG,
    st: (R, id) => initBg(R, id, "barcolor"),
    n: (R, pos, named, s: BgOut & { init?: boolean }) => {
      if (!s.init) {
        s.init = true;
        const a = args(pos, named, BG);
        s.offset = toInt(a.offset ?? 0) || 0;
        s.title = str(a.title, s.title);
        s.display = shown(a.display);
      }
      s.colors[R.i] = transp(col(named.color !== undefined ? named.color : pos[0], NaN), named.transp);
      return NaN;
    },
  },

  // ---- chart.point
  "chart.point.new": { p: ["time", "index", "price"], f: (_R, a) => point(num(a[0]), num(a[1]), num(a[2])) },
  "chart.point.from_index": { p: ["index", "price"], f: (_R, a) => point(NaN, num(a[0]), num(a[1])) },
  "chart.point.from_time": { p: ["time", "price"], f: (_R, a) => point(num(a[0]), NaN, num(a[1])) },
  "chart.point.now": { p: ["price"], f: (R, a) => point(R.t[R.i], R.i, a[0] === undefined ? R.c[R.i] : num(a[0])) },
  "chart.point.copy": { p: ["id"], f: (_R, a) => (isPoint(a[0]) ? point(num(a[0].f[0]), num(a[0].f[1]), num(a[0].f[2])) : NaN) },

  // ---- line
  "line.new": {
    p: LINE_XY,
    n: (R, pos, named) => {
      const pt = isPoint(pos[0]) || isPoint(named.first_point);
      const a = args(pos, named, pt ? LINE_PT : LINE_XY);
      const xloc = str(a.xloc, "bar_index");
      let x1 = num(a.x1), y1 = num(a.y1), x2 = num(a.x2), y2 = num(a.y2);
      if (pt) {
        const p1 = a.first_point as PineObject;
        const p2 = a.second_point as PineObject;
        x1 = xOf(p1, xloc);
        y1 = num(p1.f[2]);
        x2 = isPoint(p2) ? xOf(p2, xloc) : NaN;
        y2 = isPoint(p2) ? num(p2.f[2]) : NaN;
      }
      const l = new PLine(x1, y1, x2, y2, xloc, str(a.extend, "none"), col(a.color, DEFAULT_BLUE), str(a.style, "solid"), Math.max(1, num(a.width, 1)));
      return R.out.add(R, R.out.lines, l, R.decl.maxLines);
    },
  },
  ...setters("line", line, {
    x1: (o, v) => (o.x1 = num(v)),
    x2: (o, v) => (o.x2 = num(v)),
    y1: (o, v) => (o.y1 = num(v)),
    y2: (o, v) => (o.y2 = num(v)),
    xy1: (o, v) => {
      const [x, y] = pair(v);
      o.x1 = num(x);
      o.y1 = num(y);
    },
    xy2: (o, v) => {
      const [x, y] = pair(v);
      o.x2 = num(x);
      o.y2 = num(y);
    },
    first_point: (o, v) => {
      if (!isPoint(v)) return;
      o.x1 = xOf(v, o.xloc);
      o.y1 = num(v.f[2]);
    },
    second_point: (o, v) => {
      if (!isPoint(v)) return;
      o.x2 = xOf(v, o.xloc);
      o.y2 = num(v.f[2]);
    },
    color: (o, v) => (o.color = col(v, NaN)),
    width: (o, v) => (o.width = Math.max(1, num(v, 1))),
    style: (o, v) => (o.style = str(v, "solid")),
    extend: (o, v) => (o.extend = str(v, "none")),
    xloc: (o, v) => {
      // set_xloc(id, x1, x2, xloc)
      o.xloc = str(v, o.xloc);
    },
  }),
  "line.set_xloc": {
    p: ["id", "x1", "x2", "xloc"],
    f: (_R, a) => {
      const o = line(a[0]);
      o.x1 = num(a[1]);
      o.x2 = num(a[2]);
      o.xloc = str(a[3], o.xloc);
      return NaN;
    },
  },
  "line.get_x1": { p: ["id"], f: (_R, a) => line(a[0]).x1 },
  "line.get_x2": { p: ["id"], f: (_R, a) => line(a[0]).x2 },
  "line.get_y1": { p: ["id"], f: (_R, a) => line(a[0]).y1 },
  "line.get_y2": { p: ["id"], f: (_R, a) => line(a[0]).y2 },
  "line.get_price": {
    p: ["id", "x"],
    f: (_R, a) => {
      const l = line(a[0]);
      const x = num(a[1]);
      if (l.x2 === l.x1) return l.y1;
      return l.y1 + ((l.y2 - l.y1) * (x - l.x1)) / (l.x2 - l.x1);
    },
  },
  "line.delete": { p: ["id"], f: (R, a) => (R.out.remove(a[0]), NaN) },
  "line.copy": {
    p: ["id"],
    f: (R, a) => {
      const l = line(a[0]);
      return R.out.add(R, R.out.lines, new PLine(l.x1, l.y1, l.x2, l.y2, l.xloc, l.extend, l.color, l.style, l.width), R.decl.maxLines);
    },
  },

  // ---- label
  "label.new": {
    p: LABEL_XY,
    n: (R, pos, named) => {
      const pt = isPoint(pos[0]) || isPoint(named.point);
      const a = args(pos, named, pt ? LABEL_PT : LABEL_XY);
      const xloc = str(a.xloc, "bar_index");
      let x = num(a.x);
      let y = num(a.y);
      if (pt) {
        const p = a.point as PineObject;
        x = xOf(p, xloc);
        y = num(p.f[2]);
      }
      const l = new PLabel(
        x, y, str(a.text), xloc, str(a.yloc, "price"), col(a.color, DEFAULT_BLUE), str(a.style, "label_down"),
        col(a.textcolor, R.version >= 6 ? WHITE : BLACK), str(a.size, "normal"), str(a.textalign, "center"), str(a.tooltip),
      );
      return R.out.add(R, R.out.labels, l, R.decl.maxLabels);
    },
  },
  ...setters("label", label, {
    x: (o, v) => (o.x = num(v)),
    y: (o, v) => (o.y = num(v)),
    xy: (o, v) => {
      const [x, y] = pair(v);
      o.x = num(x);
      o.y = num(y);
    },
    point: (o, v) => {
      if (!isPoint(v)) return;
      o.x = xOf(v, o.xloc);
      o.y = num(v.f[2]);
    },
    text: (o, v) => (o.text = str(v)),
    color: (o, v) => (o.color = col(v, NaN)),
    textcolor: (o, v) => (o.textcolor = col(v, NaN)),
    style: (o, v) => (o.style = str(v, "label_down")),
    size: (o, v) => (o.size = str(v, "normal")),
    textalign: (o, v) => (o.textalign = str(v, "center")),
    tooltip: (o, v) => (o.tooltip = str(v)),
    yloc: (o, v) => (o.yloc = str(v, "price")),
    text_font_family: () => {},
    text_formatting: () => {},
  }),
  "label.set_xloc": {
    p: ["id", "x", "xloc"],
    f: (_R, a) => {
      const o = label(a[0]);
      o.x = num(a[1]);
      o.xloc = str(a[2], o.xloc);
      return NaN;
    },
  },
  "label.get_x": { p: ["id"], f: (_R, a) => label(a[0]).x },
  "label.get_y": { p: ["id"], f: (_R, a) => label(a[0]).y },
  "label.get_text": { p: ["id"], f: (_R, a) => label(a[0]).text },
  "label.delete": { p: ["id"], f: (R, a) => (R.out.remove(a[0]), NaN) },
  "label.copy": {
    p: ["id"],
    f: (R, a) => {
      const l = label(a[0]);
      const c = new PLabel(l.x, l.y, l.text, l.xloc, l.yloc, l.color, l.style, l.textcolor, l.size, l.textalign, l.tooltip);
      return R.out.add(R, R.out.labels, c, R.decl.maxLabels);
    },
  },

  // ---- box
  "box.new": {
    p: BOX_XY,
    n: (R, pos, named) => {
      const pt = isPoint(pos[0]) || isPoint(named.top_left);
      const a = args(pos, named, pt ? BOX_PT : BOX_XY);
      const xloc = str(a.xloc, "bar_index");
      let left = num(a.left), top = num(a.top), right = num(a.right), bottom = num(a.bottom);
      if (pt) {
        const tl = a.top_left as PineObject;
        const br = a.bottom_right as PineObject;
        left = xOf(tl, xloc);
        top = num(tl.f[2]);
        right = isPoint(br) ? xOf(br, xloc) : NaN;
        bottom = isPoint(br) ? num(br.f[2]) : NaN;
      }
      const b = new PBox(
        left, top, right, bottom, col(a.border_color, DEFAULT_BLUE), num(a.border_width, 1), str(a.border_style, "solid"), str(a.extend, "none"), xloc,
        col(a.bgcolor, DEFAULT_BLUE), str(a.text), str(a.text_size, "auto"), col(a.text_color, BLACK), str(a.text_halign, "center"), str(a.text_valign, "center"), str(a.text_wrap, "none"),
      );
      return R.out.add(R, R.out.boxes, b, R.decl.maxBoxes);
    },
  },
  ...setters("box", box, {
    left: (o, v) => (o.left = num(v)),
    right: (o, v) => (o.right = num(v)),
    top: (o, v) => (o.top = num(v)),
    bottom: (o, v) => (o.bottom = num(v)),
    lefttop: (o, v) => {
      const [x, y] = pair(v);
      o.left = num(x);
      o.top = num(y);
    },
    rightbottom: (o, v) => {
      const [x, y] = pair(v);
      o.right = num(x);
      o.bottom = num(y);
    },
    top_left_point: (o, v) => {
      if (!isPoint(v)) return;
      o.left = xOf(v, o.xloc);
      o.top = num(v.f[2]);
    },
    bottom_right_point: (o, v) => {
      if (!isPoint(v)) return;
      o.right = xOf(v, o.xloc);
      o.bottom = num(v.f[2]);
    },
    border_color: (o, v) => (o.border_color = col(v, NaN)),
    border_width: (o, v) => (o.border_width = num(v, 1)),
    border_style: (o, v) => (o.border_style = str(v, "solid")),
    extend: (o, v) => (o.extend = str(v, "none")),
    bgcolor: (o, v) => (o.bgcolor = col(v, NaN)),
    text: (o, v) => (o.text = str(v)),
    text_size: (o, v) => (o.text_size = str(v, "auto")),
    text_color: (o, v) => (o.text_color = col(v, NaN)),
    text_halign: (o, v) => (o.text_halign = str(v, "center")),
    text_valign: (o, v) => (o.text_valign = str(v, "center")),
    text_wrap: (o, v) => (o.text_wrap = str(v, "none")),
    text_font_family: () => {},
    text_formatting: () => {},
  }),
  "box.set_xloc": {
    p: ["id", "left", "right", "xloc"],
    f: (_R, a) => {
      const o = box(a[0]);
      o.left = num(a[1]);
      o.right = num(a[2]);
      o.xloc = str(a[3], o.xloc);
      return NaN;
    },
  },
  "box.get_left": { p: ["id"], f: (_R, a) => box(a[0]).left },
  "box.get_right": { p: ["id"], f: (_R, a) => box(a[0]).right },
  "box.get_top": { p: ["id"], f: (_R, a) => box(a[0]).top },
  "box.get_bottom": { p: ["id"], f: (_R, a) => box(a[0]).bottom },
  "box.delete": { p: ["id"], f: (R, a) => (R.out.remove(a[0]), NaN) },
  "box.copy": {
    p: ["id"],
    f: (R, a) => {
      const b = box(a[0]);
      const c = new PBox(b.left, b.top, b.right, b.bottom, b.border_color, b.border_width, b.border_style, b.extend, b.xloc, b.bgcolor, b.text, b.text_size, b.text_color, b.text_halign, b.text_valign, b.text_wrap);
      return R.out.add(R, R.out.boxes, c, R.decl.maxBoxes);
    },
  },

  // ---- table
  "table.new": {
    p: TABLE,
    n: (R, pos, named) => {
      const a = args(pos, named, TABLE);
      const t = new PTable(str(a.position, "top_right"), Math.max(0, toInt(a.columns) || 0), Math.max(0, toInt(a.rows) || 0), col(a.bgcolor, NaN), col(a.frame_color, NaN), num(a.frame_width, 0), col(a.border_color, NaN), num(a.border_width, 0));
      return R.out.add(R, R.out.tables, t, 100);
    },
  },
  "table.cell": {
    p: CELL,
    n: (_R, pos, named) => {
      const a = args(pos, named, CELL);
      if (isNa(a.table_id)) return NaN;
      const t = table(a.table_id);
      const c = toInt(a.column);
      const r = toInt(a.row);
      if (!(c >= 0 && c < t.columns && r >= 0 && r < t.rows)) throw new PineError(`表格位置 (${c}, ${r}) 超出範圍（${t.columns} 欄 × ${t.rows} 列）`);
      t.cells.set(`${c},${r}`, {
        text: str(a.text), width: num(a.width, 0), height: num(a.height, 0), text_color: col(a.text_color, BLACK), text_halign: str(a.text_halign, "center"),
        text_valign: str(a.text_valign, "center"), text_size: str(a.text_size, "normal"), bgcolor: col(a.bgcolor, NaN), tooltip: str(a.tooltip),
      });
      return NaN;
    },
  },
  ...cellSetters(),
  "table.clear": {
    p: ["table_id", "start_column", "start_row", "end_column", "end_row"],
    f: (_R, a) => {
      if (isNa(a[0])) return NaN;
      const t = table(a[0]);
      const c0 = toInt(a[1]), r0 = toInt(a[2]);
      const c1 = a[3] === undefined ? c0 : toInt(a[3]);
      const r1 = a[4] === undefined ? r0 : toInt(a[4]);
      for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) t.cells.delete(`${c},${r}`);
      return NaN;
    },
  },
  "table.merge_cells": {
    p: ["table_id", "start_column", "start_row", "end_column", "end_row"],
    f: (_R, a) => {
      table(a[0]).merges.push([toInt(a[1]), toInt(a[2]), toInt(a[3]), toInt(a[4])]);
      return NaN;
    },
  },
  ...setters("table", table, {
    position: (o, v) => (o.position = str(v, o.position)),
    bgcolor: (o, v) => (o.bgcolor = col(v, NaN)),
    frame_color: (o, v) => (o.frame_color = col(v, NaN)),
    frame_width: (o, v) => (o.frame_width = num(v, 0)),
    border_color: (o, v) => (o.border_color = col(v, NaN)),
    border_width: (o, v) => (o.border_width = num(v, 0)),
  }),
  "table.delete": { p: ["table_id"], f: (R, a) => (R.out.remove(a[0]), NaN) },

  // ---- linefill and polyline
  "linefill.new": {
    p: ["line1", "line2", "color"],
    f: (R, a) => (a[0] instanceof PLine && a[1] instanceof PLine ? R.out.add(R, R.out.linefills, new PLinefill(a[0], a[1], col(a[2], NaN)), 500) : NaN),
  },
  "linefill.set_color": {
    p: ["id", "color"],
    f: (_R, a) => {
      if (a[0] instanceof PLinefill) a[0].color = col(a[1], NaN);
      return NaN;
    },
  },
  "linefill.get_line1": { p: ["id"], f: (_R, a) => (a[0] instanceof PLinefill ? a[0].l1 : NaN) },
  "linefill.get_line2": { p: ["id"], f: (_R, a) => (a[0] instanceof PLinefill ? a[0].l2 : NaN) },
  "linefill.delete": { p: ["id"], f: (R, a) => (R.out.remove(a[0]), NaN) },
  "polyline.new": {
    p: ["points", "curved", "closed", "xloc", "line_color", "fill_color", "line_style", "line_width", "force_overlay"],
    f: (R, a) => {
      if (!Array.isArray(a[0])) return NaN;
      const xloc = str(a[3], "bar_index");
      const pts = a[0].filter(isPoint).map((p) => ({ x: xOf(p, xloc), y: num(p.f[2]) }));
      const p = new PPolyline(pts, bool(a[1], false), bool(a[2], false), xloc, col(a[4], DEFAULT_BLUE), col(a[5], NaN), str(a[6], "solid"), Math.max(1, num(a[7], 1)));
      return R.out.add(R, R.out.polylines, p, R.decl.maxPolylines);
    },
  },
  "polyline.delete": { p: ["id"], f: (R, a) => (R.out.remove(a[0]), NaN) },

  // ---- the script's settings
  indicator: { p: ["title"], n: (R, pos, named) => declare(R, "indicator", pos, named) },
  study: { p: ["title"], n: (R, pos, named) => declare(R, "indicator", pos, named) },
  strategy: { p: ["title"], n: (R, pos, named) => declare(R, "strategy", pos, named) },
  library: { p: ["title"], n: (R, pos, named) => declare(R, "library", pos, named) },
};

function cellSetters(): Lib {
  const out: Lib = {};
  const fields: Record<string, (c: Cell, v: unknown) => void> = {
    text: (c, v) => (c.text = str(v)),
    bgcolor: (c, v) => (c.bgcolor = col(v, NaN)),
    text_color: (c, v) => (c.text_color = col(v, NaN)),
    text_size: (c, v) => (c.text_size = str(v, "normal")),
    text_halign: (c, v) => (c.text_halign = str(v, "center")),
    text_valign: (c, v) => (c.text_valign = str(v, "center")),
    width: (c, v) => (c.width = num(v, 0)),
    height: (c, v) => (c.height = num(v, 0)),
    tooltip: (c, v) => (c.tooltip = str(v)),
    text_font_family: () => {},
    text_formatting: () => {},
  };
  for (const [name, set] of Object.entries(fields)) {
    out[`table.cell_set_${name}`] = {
      p: ["table_id", "column", "row", "value"],
      f: (_R, a) => {
        if (isNa(a[0])) return NaN;
        const t = table(a[0]);
        const key = `${toInt(a[1])},${toInt(a[2])}`;
        let c = t.cells.get(key);
        if (!c) {
          c = { text: "", width: 0, height: 0, text_color: BLACK, text_halign: "center", text_valign: "center", text_size: "normal", bgcolor: NaN, tooltip: "" };
          t.cells.set(key, c);
        }
        set(c, a[3]);
        return NaN;
      },
    };
  }
  return out;
}

function initShape(R: Runtime, id: number, kind: "shape" | "char"): ShapeOut {
  const o = R.out;
  const s: ShapeOut = {
    kind: "shape", key: o.key(id), init: false, title: "", on: new Uint8Array(o.n), y: o.series(), colors: o.series(), textcolors: o.series(),
    shape: kind === "char" ? "char" : "xcross", char: "★", text: "", location: "abovebar", size: "auto", offset: 0, display: DISPLAY.all, overlay: false,
  };
  o.shapes.push(s);
  return s;
}
function shape(R: Runtime, pos: unknown[], named: Record<string, unknown>, names: string[], s: ShapeOut) {
  const i = R.i;
  if (!s.init) {
    s.init = true;
    const a = args(pos, named, names);
    if (s.shape !== "char") s.shape = str(a.style, "xcross");
    else s.char = str(a.char, "★").slice(0, 2) || "★";
    s.location = str(a.location, "abovebar");
    s.title = str(a.title, s.title);
    s.text = str(a.text);
    s.size = str(a.size, "auto");
    s.offset = toInt(a.offset ?? 0) || 0;
    s.display = shown(a.display);
    s.overlay = bool(a.force_overlay, false);
  }
  const v = named.series !== undefined ? named.series : pos[0];
  const abs = s.location === "absolute";
  s.on[i] = abs ? (typeof v === "number" && v === v ? 1 : 0) : truthy(v) ? 1 : 0;
  if (abs) s.y[i] = num(v);
  const c = transp(col(named.color !== undefined ? named.color : pos[4], DEFAULT_BLUE), named.transp);
  s.colors[i] = c;
  s.textcolors[i] = col(named.textcolor !== undefined ? named.textcolor : pos[7], c);
  return NaN;
}
function initCandle(R: Runtime, id: number, kind: "candle" | "bar"): CandleOut {
  const o = R.out;
  const c: CandleOut = { kind, key: o.key(id), title: "", o: o.series(), h: o.series(), l: o.series(), c: o.series(), colors: o.series(), wicks: o.series(), borders: o.series(), display: DISPLAY.all };
  o.candles.push(c);
  return c;
}
function candle(R: Runtime, a: Record<string, unknown>, s: CandleOut) {
  const i = R.i;
  s.o[i] = num(a.open);
  s.h[i] = num(a.high);
  s.l[i] = num(a.low);
  s.c[i] = num(a.close);
  const c = col(a.color, NaN);
  s.colors[i] = c;
  s.wicks[i] = col(a.wickcolor, c);
  s.borders[i] = col(a.bordercolor, c);
  s.title = str(a.title, s.title);
  s.display = shown(a.display);
  return NaN;
}
function initBg(R: Runtime, id: number, kind: "bg" | "barcolor"): BgOut {
  const o = R.out;
  const s: BgOut = { kind, key: o.key(id), title: "", colors: o.series(), offset: 0, display: DISPLAY.all, overlay: false };
  o.bgs.push(s);
  return s;
}

const DECL = ["title", "shorttitle", "overlay", "format", "precision", "scale", "max_bars_back", "timeframe", "timeframe_gaps", "explicit_plot_zorder", "max_lines_count", "max_labels_count", "max_boxes_count", "calc_bars_count", "max_polylines_count"];
const STRAT = ["title", "shorttitle", "overlay", "format", "precision", "scale", "pyramiding", "calc_on_order_fills", "calc_on_every_tick", "max_bars_back", "backtest_fill_limits_assumption", "default_qty_type", "default_qty_value", "initial_capital", "currency", "slippage", "commission_type", "commission_value", "process_orders_on_close", "close_entries_rule", "margin_long", "margin_short", "explicit_plot_zorder", "max_lines_count", "max_labels_count", "max_boxes_count", "calc_bars_count", "risk_free_rate", "use_bar_magnifier", "fill_orders_on_standard_ohlc", "max_polylines_count"];

function declare(R: Runtime, kind: "indicator" | "strategy" | "library", pos: unknown[], named: Record<string, unknown>) {
  if (R.declSeen) return NaN;
  R.declSeen = true;
  const a = args(pos, named, kind === "strategy" ? STRAT : DECL);
  const d = R.decl;
  d.kind = kind;
  d.title = str(a.title, "");
  d.shorttitle = str(a.shorttitle, "");
  d.overlay = bool(a.overlay, false);
  d.precision = a.precision === undefined ? null : toInt(a.precision);
  d.format = str(a.format, "inherit");
  const cap = (v: unknown, dflt: number) => Math.max(1, Math.min(500, v === undefined ? dflt : toInt(v) || dflt));
  d.maxLines = cap(a.max_lines_count, 50);
  d.maxLabels = cap(a.max_labels_count, 50);
  d.maxBoxes = cap(a.max_boxes_count, 50);
  d.maxPolylines = cap(a.max_polylines_count, 50);
  d.opts = a;
  if (a.timeframe !== undefined && a.timeframe !== "") R.warn("indicator(timeframe=…) 不支援：腳本照圖表的週期計算");
  if (kind === "strategy" && !R.secFor) R.strat = new Broker(R, a);
  return NaN;
}

// ----------------------------------------------------------------------------- inputs

const SOURCES = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4", "volume"];

/** input.source(close): the name of the series, so the user can pick another one. */
export class SrcName {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

type InputState = { done: boolean; value: unknown; src: string | null; live: boolean };

/** input.*(): the value the user set for it, or its default. `kind` "auto" (input()) goes by the default. */
export function input(R: Runtime, st: InputState, kind: InputDef["kind"] | "auto", pos: unknown[], named: Record<string, unknown>): unknown {
  if (st.done) return st.src ? sourceValue(R, st.src) : st.live ? (pos[0] ?? named.defval) : st.value;
  st.done = true;
  const raw = pos[0] ?? named.defval;
  const srcName = raw instanceof SrcName ? raw.name : null;
  const defval = srcName ?? raw;
  let k: InputDef["kind"];
  if (kind === "auto") {
    const t = named.type ?? pos[2];
    if (srcName) k = "source";
    else if (typeof defval === "boolean") k = "bool";
    else if (typeof defval === "string") k = t === "session" ? "session" : t === "resolution" ? "timeframe" : t === "symbol" ? "symbol" : t === "source" ? "source" : "string";
    else if (typeof defval === "number") k = t === "color" ? "color" : t === "integer" ? "int" : t === "float" ? "float" : t === "time" ? "time" : Number.isInteger(defval) ? "int" : "float";
    else k = "string";
  } else k = kind;
  if (k === "source" && !srcName) {
    // a source given as an expression: it can't be swapped, it just follows its value
    st.live = true;
    return raw;
  }
  // the forms: (defval, title, minval, maxval, step, tooltip, inline, group) or (defval, title, options, tooltip, inline, group)
  const withOptions = Array.isArray(pos[2]) || named.options !== undefined;
  const names =
    kind === "auto"
      ? ["defval", "title", "type", "minval", "maxval", "confirm", "step", "options", "tooltip", "inline", "group"]
      : k === "int" || k === "float"
        ? withOptions
          ? ["defval", "title", "options", "tooltip", "inline", "group", "confirm", "display"]
          : ["defval", "title", "minval", "maxval", "step", "tooltip", "inline", "group", "confirm", "display"]
        : k === "string" || k === "timeframe" || k === "enum" || k === "source"
          ? ["defval", "title", "options", "tooltip", "inline", "group", "confirm", "display"]
          : ["defval", "title", "tooltip", "inline", "group", "confirm", "display"];
  const a = args(pos, named, names);
  const title = str(a.title, "");
  let key = title || `#${R.inputs.length + 1}`;
  for (let n = 2; R.inputKeys.has(key); n++) key = `${title || "#" + (R.inputs.length + 1)} (${n})`;
  R.inputKeys.add(key);
  const def: InputDef = {
    key,
    kind: k,
    title: title || defaultTitle(k),
    defval,
    options: Array.isArray(a.options) ? a.options : null,
    min: a.minval === undefined ? null : num(a.minval),
    max: a.maxval === undefined ? null : num(a.maxval),
    step: a.step === undefined ? null : num(a.step),
    group: str(a.group),
    inline: str(a.inline),
    tooltip: str(a.tooltip),
    legend: (shown(a.display) & DISPLAY.legend) !== 0,
  };
  if (k === "enum" && defval instanceof EnumVal) def.enumVals = R.enums.get(defval.e) ?? [defval];
  R.inputs.push(def);
  const user = R.inputVals[key];
  const v = valid(def, user) ? user : defval;
  if (k === "enum" && typeof v === "string") st.value = def.enumVals?.find((e) => e.name === v) ?? defval;
  else st.value = v;
  def.value = st.value instanceof EnumVal ? st.value.title : st.value;
  if (k === "source") {
    st.src = typeof st.value === "string" && SOURCES.includes(st.value) ? st.value : "close";
    return sourceValue(R, st.src);
  }
  return st.value;
}

function defaultTitle(k: InputDef["kind"]): string {
  return { int: "整數", float: "數值", bool: "開關", string: "文字", color: "顏色", source: "來源", timeframe: "週期", session: "時段", symbol: "商品", time: "時間", price: "價格", text_area: "文字", enum: "選項" }[k];
}

/** A saved value for an input: still the right kind (and in its list, when it has one)? */
function valid(d: InputDef, v: unknown): boolean {
  if (v === undefined || v === null) return false;
  switch (d.kind) {
    case "int":
    case "float":
    case "time":
    case "price":
    case "color":
      if (typeof v !== "number" || !Number.isFinite(v)) return false;
      break;
    case "bool":
      return typeof v === "boolean";
    case "enum":
      return typeof v === "string" && !!d.enumVals?.some((e) => e.name === v);
    default:
      if (typeof v !== "string") return false;
  }
  if (d.options && !d.options.some((o) => o === v)) return false;
  if (d.kind === "source" && !SOURCES.includes(v as string)) return false;
  return true;
}

export function sourceValue(R: Runtime, name: string): number {
  const i = R.i;
  switch (name) {
    case "open":
      return R.o[i];
    case "high":
      return R.h[i];
    case "low":
      return R.l[i];
    case "hl2":
      return (R.h[i] + R.l[i]) / 2;
    case "hlc3":
      return (R.h[i] + R.l[i] + R.c[i]) / 3;
    case "ohlc4":
      return (R.o[i] + R.h[i] + R.l[i] + R.c[i]) / 4;
    case "hlcc4":
      return (R.h[i] + R.l[i] + R.c[i] * 2) / 4;
    case "volume":
      return R.vol[i];
    default:
      return R.c[i];
  }
}

const inputFn = (kind: InputDef["kind"] | "auto") => ({
  p: ["defval", "title"],
  st: (): InputState => ({ done: false, value: NaN, src: null, live: false }),
  n: (R: Runtime, pos: unknown[], named: Record<string, unknown>, st: InputState) => input(R, st, kind, pos, named),
});

export const INPUTS: Lib = {
  input: inputFn("auto"),
  "input.int": inputFn("int"),
  "input.float": inputFn("float"),
  "input.bool": inputFn("bool"),
  "input.string": inputFn("string"),
  "input.color": inputFn("color"),
  "input.source": inputFn("source"),
  "input.timeframe": inputFn("timeframe"),
  "input.session": inputFn("session"),
  "input.symbol": inputFn("symbol"),
  "input.time": inputFn("time"),
  "input.price": inputFn("price"),
  "input.text_area": inputFn("text_area"),
  "input.enum": inputFn("enum"),
};
