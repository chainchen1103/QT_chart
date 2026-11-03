// array.*, map.*, matrix.*. Arrays are JavaScript arrays and maps are Maps (both by reference, like Pine).

import { isNa, PineError, type Runtime } from "../runtime.ts";
import { modeOf, percentileLinear, percentileNearest } from "./ta.ts";
import { toStr } from "./core.ts";
import { num, toInt, type Builtin, type Lib } from "./types.ts";

export class Matrix {
  rows: number;
  cols: number;
  d: unknown[];
  constructor(rows: number, cols: number, d: unknown[]) {
    this.rows = rows;
    this.cols = cols;
    this.d = d;
  }
  at(r: number, c: number) {
    if (!(r >= 0 && r < this.rows && c >= 0 && c < this.cols)) throw new PineError(`矩陣位置 (${r}, ${c}) 超出範圍（${this.rows} × ${this.cols}）`);
    return r * this.cols + c;
  }
}

function arr(x: unknown): unknown[] {
  if (!Array.isArray(x)) throw new PineError(isNa(x) ? "陣列是 na（還沒建立）" : "這不是陣列");
  return x;
}
function mapOf(x: unknown): Map<unknown, unknown> {
  if (!(x instanceof Map)) throw new PineError(isNa(x) ? "map 是 na（還沒建立）" : "這不是 map");
  return x;
}
function mat(x: unknown): Matrix {
  if (!(x instanceof Matrix)) throw new PineError(isNa(x) ? "矩陣是 na（還沒建立）" : "這不是矩陣");
  return x;
}
/** An index into `a` (v6: negative counts from the end); throws when outside. */
function idx(R: Runtime, a: unknown[], i: unknown, insert = false): number {
  let k = toInt(i);
  if (k < 0 && R.version >= 6) k += a.length;
  if (!(k >= 0 && (insert ? k <= a.length : k < a.length))) throw new PineError(`陣列索引 ${toInt(i)} 超出範圍（大小 ${a.length}）`);
  return k;
}
const nums = (a: unknown[]): number[] => a.map((x) => num(x)).filter((x) => x === x);

const make: Builtin = {
  p: ["size", "initial_value"],
  f: (_R, a) => {
    const n = a[0] === undefined ? 0 : toInt(a[0]);
    if (!(n >= 0)) throw new PineError("陣列大小不能是負的");
    return new Array(n).fill(a[1] === undefined ? NaN : a[1]);
  },
};

function stdev(v: number[], biased: boolean, variance = false): number {
  if (!v.length) return NaN;
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  const s = v.reduce((t, x) => t + (x - m) ** 2, 0);
  const div = biased ? v.length : v.length - 1;
  const r = div > 0 ? s / div : NaN;
  return variance ? r : Math.sqrt(r);
}

function sortVals(a: unknown[], desc: boolean): unknown[] {
  return a.sort((x, y) => {
    const xn = isNa(x);
    const yn = isNa(y);
    if (xn || yn) return xn && yn ? 0 : xn ? 1 : -1; // na last
    const r = typeof x === "string" ? String(x).localeCompare(String(y)) : num(x) - num(y);
    return desc ? -r : r;
  });
}

function binSearch(a: unknown[], v: number, mode: 0 | -1 | 1): number {
  let lo = 0;
  let hi = a.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const x = num(a[mid]);
    if (x === v) {
      found = mid;
      if (mode === 0) return mid;
      if (mode < 0) hi = mid - 1;
      else lo = mid + 1;
    } else if (x < v) lo = mid + 1;
    else hi = mid - 1;
  }
  if (mode === 0) return found;
  if (found >= 0) return found;
  return mode < 0 ? lo : hi;
}

export const COLLECTIONS: Lib = {
  // ---- array
  "array.new": make,
  "array.new_float": make,
  "array.new_int": make,
  "array.new_bool": { p: ["size", "initial_value"], f: (R, a) => make.f!(R, [a[0], a[1] === undefined ? false : a[1]], null) },
  "array.new_string": make,
  "array.new_color": make,
  "array.new_line": make,
  "array.new_label": make,
  "array.new_box": make,
  "array.new_table": make,
  "array.new_linefill": make,
  "array.from": { p: ["..."], f: (_R, a) => a.filter((x) => x !== undefined) },
  "array.copy": { p: ["id"], f: (_R, a) => arr(a[0]).slice() },
  "array.size": { p: ["id"], f: (_R, a) => arr(a[0]).length },
  "array.get": { p: ["id", "index"], f: (R, a) => arr(a[0])[idx(R, arr(a[0]), a[1])] },
  "array.set": {
    p: ["id", "index", "value"],
    f: (R, a) => {
      const x = arr(a[0]);
      x[idx(R, x, a[1])] = a[2];
      return NaN;
    },
  },
  "array.push": {
    p: ["id", "value"],
    f: (_R, a) => {
      const x = arr(a[0]);
      if (x.length >= 100000) throw new PineError("陣列太大（超過 100000 個）");
      x.push(a[1]);
      return NaN;
    },
  },
  "array.unshift": {
    p: ["id", "value"],
    f: (_R, a) => {
      arr(a[0]).unshift(a[1]);
      return NaN;
    },
  },
  "array.pop": {
    p: ["id"],
    f: (_R, a) => {
      const x = arr(a[0]);
      if (!x.length) throw new PineError("陣列是空的，不能 pop");
      return x.pop();
    },
  },
  "array.shift": {
    p: ["id"],
    f: (_R, a) => {
      const x = arr(a[0]);
      if (!x.length) throw new PineError("陣列是空的，不能 shift");
      return x.shift();
    },
  },
  "array.insert": {
    p: ["id", "index", "value"],
    f: (R, a) => {
      const x = arr(a[0]);
      x.splice(idx(R, x, a[1], true), 0, a[2]);
      return NaN;
    },
  },
  "array.remove": {
    p: ["id", "index"],
    f: (R, a) => {
      const x = arr(a[0]);
      return x.splice(idx(R, x, a[1]), 1)[0];
    },
  },
  "array.clear": {
    p: ["id"],
    f: (_R, a) => {
      arr(a[0]).length = 0;
      return NaN;
    },
  },
  "array.concat": {
    p: ["id1", "id2"],
    f: (_R, a) => {
      const x = arr(a[0]);
      for (const v of arr(a[1])) x.push(v);
      return x;
    },
  },
  "array.slice": {
    p: ["id", "index_from", "index_to"],
    f: (_R, a) => {
      const x = arr(a[0]);
      return x.slice(toInt(a[1]), a[2] === undefined ? x.length : toInt(a[2]));
    },
  },
  "array.includes": { p: ["id", "value"], f: (_R, a) => arr(a[0]).some((v) => v === a[1]) },
  "array.indexof": {
    p: ["id", "value"],
    f: (_R, a) => arr(a[0]).findIndex((v) => v === a[1]),
  },
  "array.lastindexof": {
    p: ["id", "value"],
    f: (_R, a) => {
      const x = arr(a[0]);
      for (let i = x.length - 1; i >= 0; i--) if (x[i] === a[1]) return i;
      return -1;
    },
  },
  "array.first": {
    p: ["id"],
    f: (_R, a) => {
      const x = arr(a[0]);
      if (!x.length) throw new PineError("陣列是空的，沒有第一個");
      return x[0];
    },
  },
  "array.last": {
    p: ["id"],
    f: (_R, a) => {
      const x = arr(a[0]);
      if (!x.length) throw new PineError("陣列是空的，沒有最後一個");
      return x[x.length - 1];
    },
  },
  "array.sum": { p: ["id"], f: (_R, a) => nums(arr(a[0])).reduce((s, x) => s + x, 0) },
  "array.avg": {
    p: ["id"],
    f: (_R, a) => {
      const v = nums(arr(a[0]));
      return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
    },
  },
  "array.min": {
    p: ["id", "nth"],
    f: (_R, a) => {
      const v = nums(arr(a[0])).sort((x, y) => x - y);
      return v[toInt(a[1] ?? 0)] ?? NaN;
    },
  },
  "array.max": {
    p: ["id", "nth"],
    f: (_R, a) => {
      const v = nums(arr(a[0])).sort((x, y) => y - x);
      return v[toInt(a[1] ?? 0)] ?? NaN;
    },
  },
  "array.range": {
    p: ["id"],
    f: (_R, a) => {
      const v = nums(arr(a[0]));
      return v.length ? Math.max(...v) - Math.min(...v) : NaN;
    },
  },
  "array.median": {
    p: ["id"],
    f: (_R, a) => {
      const v = nums(arr(a[0])).sort((x, y) => x - y);
      if (!v.length) return NaN;
      const m = v.length >> 1;
      return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
    },
  },
  "array.mode": { p: ["id"], f: (_R, a) => modeOf(nums(arr(a[0]))) },
  "array.stdev": { p: ["id", "biased"], f: (_R, a) => stdev(nums(arr(a[0])), a[1] !== false) },
  "array.variance": { p: ["id", "biased"], f: (_R, a) => stdev(nums(arr(a[0])), a[1] !== false, true) },
  "array.covariance": {
    p: ["id1", "id2", "biased"],
    f: (_R, a) => {
      const x = arr(a[0]).map((v) => num(v));
      const y = arr(a[1]).map((v) => num(v));
      const n = Math.min(x.length, y.length);
      if (!n) return NaN;
      const mx = x.slice(0, n).reduce((s, v) => s + v, 0) / n;
      const my = y.slice(0, n).reduce((s, v) => s + v, 0) / n;
      let s = 0;
      for (let i = 0; i < n; i++) s += (x[i] - mx) * (y[i] - my);
      return s / (a[2] === false ? n - 1 : n);
    },
  },
  "array.standardize": {
    p: ["id"],
    f: (_R, a) => {
      const v = arr(a[0]).map((x) => num(x));
      const m = v.reduce((s, x) => s + x, 0) / v.length;
      const sd = stdev(v, true);
      return v.map((x) => (x - m) / sd);
    },
  },
  "array.percentile_linear_interpolation": { p: ["id", "percentage"], f: (_R, a) => percentileLinear(nums(arr(a[0])), num(a[1])) },
  "array.percentile_nearest_rank": { p: ["id", "percentage"], f: (_R, a) => percentileNearest(nums(arr(a[0])), num(a[1])) },
  "array.percentrank": {
    p: ["id", "index"],
    f: (R, a) => {
      const x = arr(a[0]);
      const v = num(x[idx(R, x, a[1])]);
      const others = nums(x).length - 1;
      if (others <= 0) return NaN;
      let c = 0;
      for (const y of x) if (num(y) <= v) c++;
      return (100 * (c - 1)) / others;
    },
  },
  "array.abs": { p: ["id"], f: (_R, a) => arr(a[0]).map((x) => Math.abs(num(x))) },
  "array.sort": {
    p: ["id", "order"],
    f: (_R, a) => {
      sortVals(arr(a[0]), a[1] === "descending");
      return NaN;
    },
  },
  "array.sort_indices": {
    p: ["id", "order"],
    f: (_R, a) => {
      const x = arr(a[0]);
      const ids = x.map((_, i) => i);
      const desc = a[1] === "descending";
      ids.sort((i, j) => {
        const r = typeof x[i] === "string" ? String(x[i]).localeCompare(String(x[j])) : num(x[i]) - num(x[j]);
        return desc ? -r : r;
      });
      return ids;
    },
  },
  "array.reverse": {
    p: ["id"],
    f: (_R, a) => {
      arr(a[0]).reverse();
      return NaN;
    },
  },
  "array.fill": {
    p: ["id", "value", "index_from", "index_to"],
    f: (_R, a) => {
      const x = arr(a[0]);
      x.fill(a[1], a[2] === undefined ? 0 : toInt(a[2]), a[3] === undefined ? x.length : toInt(a[3]));
      return NaN;
    },
  },
  "array.join": { p: ["id", "separator"], f: (R, a) => arr(a[0]).map((v) => toStr(R, v)).join(a[1] === undefined ? "" : String(a[1])) },
  "array.every": { p: ["id"], f: (_R, a) => arr(a[0]).every((v) => !!v && v === v) },
  "array.some": { p: ["id"], f: (_R, a) => arr(a[0]).some((v) => !!v && v === v) },
  "array.binary_search": { p: ["id", "val"], f: (_R, a) => binSearch(arr(a[0]), num(a[1]), 0) },
  "array.binary_search_leftmost": { p: ["id", "val"], f: (_R, a) => binSearch(arr(a[0]), num(a[1]), -1) },
  "array.binary_search_rightmost": { p: ["id", "val"], f: (_R, a) => binSearch(arr(a[0]), num(a[1]), 1) },

  // ---- map
  "map.new": { p: [], f: () => new Map() },
  "map.put": {
    p: ["id", "key", "value"],
    f: (_R, a) => {
      const m = mapOf(a[0]);
      const old = m.has(a[1]) ? m.get(a[1]) : NaN;
      if (m.size >= 50000 && !m.has(a[1])) throw new PineError("map 太大（超過 50000 個）");
      m.set(a[1], a[2]);
      return old;
    },
  },
  "map.get": {
    p: ["id", "key"],
    f: (_R, a) => {
      const m = mapOf(a[0]);
      return m.has(a[1]) ? m.get(a[1]) : NaN;
    },
  },
  "map.contains": { p: ["id", "key"], f: (_R, a) => mapOf(a[0]).has(a[1]) },
  "map.remove": {
    p: ["id", "key"],
    f: (_R, a) => {
      const m = mapOf(a[0]);
      const old = m.has(a[1]) ? m.get(a[1]) : NaN;
      m.delete(a[1]);
      return old;
    },
  },
  "map.keys": { p: ["id"], f: (_R, a) => [...mapOf(a[0]).keys()] },
  "map.values": { p: ["id"], f: (_R, a) => [...mapOf(a[0]).values()] },
  "map.size": { p: ["id"], f: (_R, a) => mapOf(a[0]).size },
  "map.clear": {
    p: ["id"],
    f: (_R, a) => {
      mapOf(a[0]).clear();
      return NaN;
    },
  },
  "map.copy": { p: ["id"], f: (_R, a) => new Map(mapOf(a[0])) },
  "map.put_all": {
    p: ["id", "id2"],
    f: (_R, a) => {
      const m = mapOf(a[0]);
      for (const [k, v] of mapOf(a[1])) m.set(k, v);
      return NaN;
    },
  },

  // ---- matrix (the common part)
  "matrix.new": {
    p: ["rows", "columns", "initial_value"],
    f: (_R, a) => {
      const r = toInt(a[0] ?? 0);
      const c = toInt(a[1] ?? 0);
      return new Matrix(r, c, new Array(r * c).fill(a[2] === undefined ? NaN : a[2]));
    },
  },
  "matrix.get": {
    p: ["id", "row", "column"],
    f: (_R, a) => {
      const m = mat(a[0]);
      return m.d[m.at(toInt(a[1]), toInt(a[2]))];
    },
  },
  "matrix.set": {
    p: ["id", "row", "column", "value"],
    f: (_R, a) => {
      const m = mat(a[0]);
      m.d[m.at(toInt(a[1]), toInt(a[2]))] = a[3];
      return NaN;
    },
  },
  "matrix.rows": { p: ["id"], f: (_R, a) => mat(a[0]).rows },
  "matrix.columns": { p: ["id"], f: (_R, a) => mat(a[0]).cols },
  "matrix.elements_count": { p: ["id"], f: (_R, a) => mat(a[0]).d.length },
  "matrix.row": {
    p: ["id", "row"],
    f: (_R, a) => {
      const m = mat(a[0]);
      const r = toInt(a[1]);
      return m.d.slice(m.at(r, 0), m.at(r, 0) + m.cols);
    },
  },
  "matrix.col": {
    p: ["id", "column"],
    f: (_R, a) => {
      const m = mat(a[0]);
      const c = toInt(a[1]);
      return Array.from({ length: m.rows }, (_, r) => m.d[m.at(r, c)]);
    },
  },
  "matrix.fill": {
    p: ["id", "value"],
    f: (_R, a) => {
      mat(a[0]).d.fill(a[1]);
      return NaN;
    },
  },
  "matrix.copy": {
    p: ["id"],
    f: (_R, a) => {
      const m = mat(a[0]);
      return new Matrix(m.rows, m.cols, m.d.slice());
    },
  },
  "matrix.add_row": {
    p: ["id", "row", "array_id"],
    f: (_R, a) => {
      const m = mat(a[0]);
      const r = a[1] === undefined ? m.rows : toInt(a[1]);
      const vals = a[2] === undefined ? new Array(m.cols || 0).fill(NaN) : arr(a[2]).slice();
      if (m.rows === 0 && m.cols === 0) m.cols = vals.length;
      if (vals.length !== m.cols) throw new PineError("新增的列長度和矩陣的欄數不同");
      m.d.splice(r * m.cols, 0, ...vals);
      m.rows++;
      return NaN;
    },
  },
  "matrix.add_col": {
    p: ["id", "column", "array_id"],
    f: (_R, a) => {
      const m = mat(a[0]);
      const c = a[1] === undefined ? m.cols : toInt(a[1]);
      const vals = a[2] === undefined ? new Array(m.rows || 0).fill(NaN) : arr(a[2]).slice();
      if (m.rows === 0 && m.cols === 0) m.rows = vals.length;
      if (vals.length !== m.rows) throw new PineError("新增的欄長度和矩陣的列數不同");
      const d: unknown[] = [];
      for (let r = 0; r < m.rows; r++) {
        const row = m.d.slice(r * m.cols, (r + 1) * m.cols);
        row.splice(c, 0, vals[r]);
        d.push(...row);
      }
      m.d = d;
      m.cols++;
      return NaN;
    },
  },
  "matrix.remove_row": {
    p: ["id", "row"],
    f: (_R, a) => {
      const m = mat(a[0]);
      const r = a[1] === undefined ? m.rows - 1 : toInt(a[1]);
      const out = m.d.splice(m.at(r, 0), m.cols);
      m.rows--;
      return out;
    },
  },
  "matrix.remove_col": {
    p: ["id", "column"],
    f: (_R, a) => {
      const m = mat(a[0]);
      const c = a[1] === undefined ? m.cols - 1 : toInt(a[1]);
      const out: unknown[] = [];
      const d: unknown[] = [];
      for (let r = 0; r < m.rows; r++)
        for (let k = 0; k < m.cols; k++) {
          if (k === c) out.push(m.d[r * m.cols + k]);
          else d.push(m.d[r * m.cols + k]);
        }
      m.d = d;
      m.cols--;
      return out;
    },
  },
  "matrix.sum": {
    p: ["id1", "id2"],
    f: (_R, a) => {
      const m = mat(a[0]);
      if (a[1] instanceof Matrix) return new Matrix(m.rows, m.cols, m.d.map((v, i) => num(v) + num((a[1] as Matrix).d[i])));
      return new Matrix(m.rows, m.cols, m.d.map((v) => num(v) + num(a[1])));
    },
  },
  "matrix.avg": {
    p: ["id"],
    f: (_R, a) => {
      const v = nums(mat(a[0]).d);
      return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
    },
  },
  "matrix.max": { p: ["id"], f: (_R, a) => Math.max(...nums(mat(a[0]).d)) },
  "matrix.min": { p: ["id"], f: (_R, a) => Math.min(...nums(mat(a[0]).d)) },
};
