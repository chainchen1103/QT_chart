// Turns the syntax tree into JavaScript closures (no eval: the app's content security policy forbids it, and a
// script can only call what is listed here — never the order or API functions of the app). Each closure takes
// the frame it runs in: the script's own, or the one of the place a function was called from, which keeps
// that call's variables, histories and the state of the ta.* calls inside it.

import type { Arg, Block, Expr, Param, Script, Stmt, TypeRef } from "./ast.ts";
import { PineSyntaxError } from "./lexer.ts";
import { COLLECTIONS, Matrix } from "./lib/collections.ts";
import { CORE, tfSeconds } from "./lib/core.ts";
import { newPeriod, TA, taSeries } from "./lib/ta.ts";
import type { Builtin, Lib } from "./lib/types.ts";
import { num, toInt } from "./lib/types.ts";
import { INPUTS, Outputs, OUTPUTS, PBox, PLabel, PLine, PLinefill, PPolyline, PTable, SrcName } from "./outputs.ts";
import {
  EnumVal,
  hexColor,
  isNa,
  namedColors,
  newFrame,
  periodOf,
  PineError,
  PineObject,
  pineTf,
  Runtime,
  Tuple,
  type Bar,
  type FnInfo,
  type Frame,
  type SecRun,
  type SecRequest,
  type UdtDef,
  symInfo,
  defaultDecl,
} from "./runtime.ts";
import { STRATEGY, strategyVar } from "./strategy.ts";

type Ev = (f: Frame) => unknown;

const LIB: Lib = { ...CORE, ...TA, ...COLLECTIONS, ...OUTPUTS, ...INPUTS, ...STRATEGY };

/** Older scripts (v4 and before) call these without a namespace. */
const V4_NS = ["math", "ta", "str", "request"];
const V4_ALIASES: Record<string, string> = { tostring: "str.tostring", tonumber: "str.tonumber", security: "request.security", study: "indicator" };

const LOOP_CHECK = 4095;

type VarInfo = { slot: number; global: boolean; constInt: boolean; type: TypeRef | null };

type UserFn = {
  name: string;
  params: Param[];
  fi: FnInfo;
  body: Ev | null;
  defaults: (Ev | null)[];
  method: boolean;
  /** Type of the first parameter (methods pick by it). */
  self: string | null;
};

class FnCtx {
  fi: FnInfo = { nslots: 0, nsites: 0, tracked: [] };
  scopes: Map<string, VarInfo>[] = [new Map()];
  readonly global: boolean;
  constructor(global: boolean) {
    this.global = global;
  }
  site(): number {
    return this.fi.nsites++;
  }
  declare(name: string, type: TypeRef | null, constInt = false): VarInfo {
    const slot = this.fi.nslots++;
    this.fi.tracked[slot] = false;
    const v: VarInfo = { slot, global: this.global, constInt, type };
    this.scopes[this.scopes.length - 1].set(name, v);
    return v;
  }
  lookup(name: string): VarInfo | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const v = this.scopes[i].get(name);
      if (v) return v;
    }
    return undefined;
  }
}

export type RunData = {
  bars: readonly Bar[];
  /** Seconds per bar. */
  sec: number;
  instId: string;
  mintick: number;
  now?: number;
};

export type RunOpts = {
  inputs?: Record<string, unknown>;
  /** request.security() values computed on other timeframes (by request key). */
  sec?: Map<string, SecRun>;
  /** This run computes request.security() values for that request (key, timeframe, Heikin-Ashi). */
  secFor?: SecRequest | null;
  /** Stop after this many milliseconds. */
  timeLimit?: number;
};


export type RunResult = {
  ok: boolean;
  error: { line: number; message: string } | null;
  decl: Runtime["decl"];
  out: Outputs;
  strategy: ReturnType<NonNullable<Runtime["strat"]>["report"]> | null;
  inputs: Runtime["inputs"];
  warnings: string[];
  logs: string[];
  /** request.security() requests not loaded yet. */
  needs: SecRequest[];
  secOut: Map<string, unknown[]>;
  ms: number;
};

export type Program = {
  version: number;
  run(data: RunData, opts?: RunOpts): RunResult;
};

const SOURCE_VARS = new Set(["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4", "volume"]);

// ----------------------------------------------------------------------------- constants

const STR_CONSTS: Record<string, unknown> = {
  "xloc.bar_index": "bar_index", "xloc.bar_time": "bar_time",
  "yloc.price": "price", "yloc.abovebar": "abovebar", "yloc.belowbar": "belowbar",
  "extend.none": "none", "extend.left": "left", "extend.right": "right", "extend.both": "both",
  "barmerge.gaps_on": true, "barmerge.gaps_off": false, "barmerge.lookahead_on": true, "barmerge.lookahead_off": false,
  "strategy.long": "long", "strategy.short": "short", "strategy.fixed": "fixed", "strategy.cash": "cash", "strategy.percent_of_equity": "percent_of_equity",
  "strategy.commission.percent": "percent", "strategy.commission.cash_per_contract": "cash_per_contract", "strategy.commission.cash_per_order": "cash_per_order",
  "strategy.oca.none": "none", "strategy.oca.cancel": "cancel", "strategy.oca.reduce": "reduce",
  "strategy.direction.all": "all", "strategy.direction.long": "long", "strategy.direction.short": "short",
  "order.ascending": "ascending", "order.descending": "descending",
  "dayofweek.sunday": 1, "dayofweek.monday": 2, "dayofweek.tuesday": 3, "dayofweek.wednesday": 4, "dayofweek.thursday": 5, "dayofweek.friday": 6, "dayofweek.saturday": 7,
  "math.pi": Math.PI, "math.e": Math.E, "math.phi": 1.618033988749895, "math.rphi": 0.6180339887498948,
  "font.family_default": "default", "font.family_monospace": "monospace",
  "alert.freq_all": "all", "alert.freq_once_per_bar": "once_per_bar", "alert.freq_once_per_bar_close": "once_per_bar_close",
  "session.regular": "regular", "session.extended": "extended",
  "adjustment.none": "none", "adjustment.splits": "splits", "adjustment.dividends": "dividends",
  "settlement_as_close.on": "on", "settlement_as_close.off": "off", "settlement_as_close.inherit": "inherit",
  "backadjustment.on": "on", "backadjustment.off": "off", "backadjustment.inherit": "inherit",
  "text.align_left": "left", "text.align_center": "center", "text.align_right": "right", "text.align_top": "top", "text.align_bottom": "bottom",
  "text.wrap_auto": "auto", "text.wrap_none": "none", "text.format_bold": "bold", "text.format_italic": "italic", "text.format_none": "none",
  "hline.style_solid": "solid", "hline.style_dotted": "dotted", "hline.style_dashed": "dashed",
  "line.style_solid": "solid", "line.style_dotted": "dotted", "line.style_dashed": "dashed", "line.style_arrow_left": "arrow_left", "line.style_arrow_right": "arrow_right", "line.style_arrow_both": "arrow_both",
  // display.* are flags that add up (display.pane + display.price_scale): see outputs.ts DISPLAY
  "display.all": 15, "display.none": 0, "display.pane": 1, "display.data_window": 2, "display.price_scale": 4, "display.status_line": 8,
  "format.inherit": "inherit", "format.price": "price", "format.volume": "volume", "format.percent": "percent", "format.mintick": "mintick",
  "scale.right": "right", "scale.left": "left", "scale.none": "none",
  "chart.bg_color": hexColor("#131722"), "chart.fg_color": hexColor("#D1D4DC"),
  "chart.is_standard": true, "chart.is_heikinashi": false, "chart.is_renko": false, "chart.is_kagi": false, "chart.is_linebreak": false, "chart.is_pnf": false, "chart.is_range": false,
  // input() types of older scripts
  "input.integer": "integer", "input.float": "float", "input.bool": "bool", "input.string": "string", "input.source": "source", "input.resolution": "resolution", "input.session": "session", "input.symbol": "symbol", "input.color": "color", "input.time": "time",
};
for (const s of ["none", "xcross", "cross", "triangleup", "triangledown", "flag", "circle", "arrowup", "arrowdown", "label_up", "label_down", "label_left", "label_right", "label_lower_left", "label_lower_right", "label_upper_left", "label_upper_right", "label_center", "square", "diamond", "text_outline"]) STR_CONSTS[`label.style_${s}`] = s;
for (const s of ["auto", "tiny", "small", "normal", "large", "huge"]) STR_CONSTS[`size.${s}`] = s;
for (const s of ["top_left", "top_center", "top_right", "middle_left", "middle_center", "middle_right", "bottom_left", "bottom_center", "bottom_right"]) STR_CONSTS[`position.${s}`] = s;
for (const s of ["xcross", "cross", "triangleup", "triangledown", "flag", "circle", "arrowup", "arrowdown", "labelup", "labeldown", "square", "diamond"]) STR_CONSTS[`shape.${s}`] = s;
for (const s of ["abovebar", "belowbar", "top", "bottom", "absolute"]) STR_CONSTS[`location.${s}`] = s;
for (const s of ["line", "stepline", "stepline_diamond", "steplinebr", "histogram", "cross", "area", "areabr", "columns", "circles", "linebr"]) STR_CONSTS[`plot.style_${s}`] = s;

// ----------------------------------------------------------------------------- the compiler

class Compiler {
  readonly R = new Runtime();
  readonly g = new FnCtx(true);
  cur = this.g;
  readonly fns = new Map<string, UserFn[]>();
  readonly methods = new Map<string, UserFn[]>();
  readonly types = new Map<string, UdtDef>();
  readonly enums = new Map<string, Map<string, EnumVal>>();
  readonly reassigned = new Set<string>();
  readonly colors: Record<string, number>;
  readonly version: number;
  readonly script: Script;

  constructor(script: Script) {
    this.script = script;
    this.version = script.version;
    this.R.version = script.version;
    this.colors = namedColors(script.version);
  }

  err(msg: string, n: { line: number; col: number }): never {
    throw new PineSyntaxError(msg, n.line, n.col || 1);
  }

  // ------------------------------------------------------------------- whole script
  compile(): Program {
    const body = this.script.body;
    this.prepass(body);
    const main = this.stmts(body);
    return this.program(main);
  }

  /** Functions, types and enums can be used before they are written; and which names are ever reassigned. */
  private prepass(body: Stmt[]) {
    for (const s of body) {
      if (s.k === "fn") {
        const uf: UserFn = { name: s.name, params: s.params, fi: { nslots: 0, nsites: 0, tracked: [] }, body: null, defaults: [], method: s.method, self: s.params[0]?.type ? typeName(s.params[0].type) : null };
        (s as Stmt & { uf?: UserFn }).uf = uf;
        const list = this.fns.get(s.name) ?? [];
        list.push(uf);
        this.fns.set(s.name, list);
        if (s.method) {
          const ms = this.methods.get(s.name) ?? [];
          ms.push(uf);
          this.methods.set(s.name, ms);
        }
      } else if (s.k === "type") {
        const ix: Record<string, number> = {};
        s.fields.forEach((f, k) => (ix[f.name] = k));
        this.types.set(s.name, { name: s.name, fields: s.fields.map((f) => f.name), ix, defs: [] });
      } else if (s.k === "enum") {
        const vals = new Map<string, EnumVal>();
        for (const f of s.fields) vals.set(f.name, new EnumVal(s.name, f.name, f.title));
        this.enums.set(s.name, vals);
      }
    }
    const walk = (x: unknown) => {
      if (!x || typeof x !== "object") return;
      if (Array.isArray(x)) {
        for (const y of x) walk(y);
        return;
      }
      const n = x as { k?: string; target?: Expr };
      if (n.k === "assign" && n.target?.k === "id") this.reassigned.add(n.target.name);
      for (const v of Object.values(x)) if (v && typeof v === "object") walk(v);
    };
    walk(body);
  }

  private program(main: Ev): Program {
    const R = this.R;
    const gfi = this.g.fi;
    const version = this.version;
    const enums = this.enums;
    return {
      version,
      run(data: RunData, opts: RunOpts = {}): RunResult {
        const t0 = Date.now();
        reset(R, data, opts);
        for (const [name, vals] of enums) R.enums.set(name, [...vals.values()]);
        R.g = newFrame(gfi);
        let error: RunResult["error"] = null;
        try {
          for (let i = 0; i < R.n; i++) {
            R.i = i;
            R.jump = 0;
            if (R.strat) R.strat.barOpen(i);
            main(R.g);
            if (R.strat) R.strat.barClose(i);
            if ((i & 63) === 63 && Date.now() > R.deadline) throw new PineError(`腳本計算太久（超過 ${Math.round((opts.timeLimit ?? 8000) / 1000)} 秒），已停止`);
          }
        } catch (e) {
          error = { line: R.line, message: e instanceof PineError ? e.message : e instanceof RangeError ? "腳本太複雜（遞迴太深或陣列太大）" : `執行錯誤：${(e as Error)?.message ?? e}` };
        }
        const needs: SecRequest[] = [];
        for (const k of R.needs) {
          const [period, ha] = k.split("|");
          const tf = pineTf(period);
          if (tf) needs.push({ key: k, tf, ha: ha === "ha" });
        }
        return {
          ok: !error,
          error,
          decl: R.decl,
          out: R.out,
          strategy: R.strat && !error ? R.strat.report() : null,
          inputs: R.inputs,
          warnings: [...R.warnings],
          logs: R.logs,
          needs,
          secOut: R.secOut,
          ms: Date.now() - t0,
        };
      },
    };
  }

  // ------------------------------------------------------------------- statements
  private stmts(list: Stmt[]): Ev {
    const evs = list.map((s) => this.stmt(s)).filter((e): e is Ev => !!e);
    return seq(this.R, evs);
  }

  private block(b: Block, scope = true): Ev {
    if (scope) this.cur.scopes.push(new Map());
    const ev = this.stmts(b.body);
    if (scope) this.cur.scopes.pop();
    return ev;
  }

  private stmt(s: Stmt): Ev | null {
    const R = this.R;
    const line = s.line;
    const wrap = (ev: Ev): Ev => (f) => {
      R.line = line;
      return ev(f);
    };
    switch (s.k) {
      case "expr":
        return wrap(this.expr(s.e));
      case "decl":
        return wrap(this.decl(s));
      case "tupledecl":
        return wrap(this.tupleDecl(s));
      case "assign":
        return wrap(this.assign(s));
      case "break":
        return () => ((R.jump = 1), NaN);
      case "continue":
        return () => ((R.jump = 2), NaN);
      case "fn":
        if (this.cur !== this.g) this.err("函式只能寫在最外層", s);
        this.fnDef(s);
        return null;
      case "type":
        if (this.cur !== this.g) this.err("type 只能寫在最外層", s);
        this.typeDef(s);
        return null;
      case "enum":
        return null;
    }
  }

  private decl(s: Extract<Stmt, { k: "decl" }>): Ev {
    const init = this.expr(s.init);
    const constInt = s.mode === "" && !this.reassigned.has(s.name) && this.isConstInt(s.init);
    const v = this.cur.declare(s.name, s.type, constInt);
    const slot = v.slot;
    const tracked = this.cur.fi.tracked;
    const R = this.R;
    if (s.mode) {
      return (f) => {
        let val = f.v[slot];
        if (val === undefined) {
          val = init(f);
          if (val === undefined) val = NaN;
          f.v[slot] = val;
        }
        if (tracked[slot]) push(R, f, slot, val);
        return val;
      };
    }
    return (f) => {
      let val = init(f);
      if (val === undefined) val = NaN;
      f.v[slot] = val;
      if (tracked[slot]) push(R, f, slot, val);
      return val;
    };
  }

  private tupleDecl(s: Extract<Stmt, { k: "tupledecl" }>): Ev {
    const init = this.expr(s.init);
    const vs = s.names.map((n) => this.cur.declare(n, null));
    const tracked = this.cur.fi.tracked;
    const R = this.R;
    return (f) => {
      const t = init(f);
      let items: unknown[];
      if (t instanceof Tuple) items = t.items;
      else if (isNa(t)) items = [];
      else throw new PineError(`右邊不是 ${s.names.length} 個值，不能拆成 [${s.names.join(", ")}]`);
      for (let k = 0; k < vs.length; k++) {
        const val = items[k] === undefined ? NaN : items[k];
        f.v[vs[k].slot] = val;
        if (tracked[vs[k].slot]) push(R, f, vs[k].slot, val);
      }
      return t;
    };
  }

  private assign(s: Extract<Stmt, { k: "assign" }>): Ev {
    const value = this.expr(s.value);
    const op = s.op;
    const R = this.R;
    const t = s.target;
    if (t.k === "id") {
      const v = this.resolve(t.name);
      if (!v) this.err(`「${t.name}」還沒宣告（第一次要用 = 宣告）`, t);
      const slot = v.slot;
      const outer = v.global && this.cur !== this.g;
      const tracked = outer ? this.g.fi.tracked : this.cur.fi.tracked;
      const calc = combine(op);
      return (f) => {
        const fr = outer ? R.g : f;
        const val = calc(fr.v[slot], value(f));
        fr.v[slot] = val;
        if (tracked[slot]) {
          const h = fr.h[slot];
          if (h && h.b === R.i) h.a[h.a.length - 1] = val;
          else push(R, fr, slot, val);
        }
        return val;
      };
    }
    if (t.k === "member") {
      const obj = this.expr(t.obj);
      const name = t.name;
      const calc = combine(op);
      return (f) => {
        const o = obj(f);
        if (!(o instanceof PineObject)) throw new PineError(isNa(o) ? `物件是 na，不能設定 ${name}` : `不能設定 ${name}`);
        const k = o.t.ix[name];
        if (k === undefined) throw new PineError(`${o.t.name} 沒有欄位 ${name}`);
        const val = calc(o.f[k], value(f));
        o.f[k] = val;
        return val;
      };
    }
    this.err("只能指定給變數或欄位", s);
  }

  private fnDef(s: Extract<Stmt, { k: "fn" }>) {
    const uf = (s as Stmt & { uf?: UserFn }).uf!;
    uf.defaults = s.params.map((p) => (p.def ? this.expr(p.def) : null));
    const ctx = new FnCtx(false);
    const prev = this.cur;
    this.cur = ctx;
    for (const p of s.params) ctx.declare(p.name, p.type);
    uf.body = this.block(s.body, false);
    this.cur = prev;
    uf.fi = ctx.fi;
  }

  private typeDef(s: Extract<Stmt, { k: "type" }>) {
    const def = this.types.get(s.name)!;
    const R = this.R;
    def.defs = s.fields.map((f) => {
      if (!f.def) return () => NaN;
      const ev = this.expr(f.def);
      return () => ev(R.g);
    });
  }

  // ------------------------------------------------------------------- names
  private resolve(name: string): VarInfo | undefined {
    const v = this.cur.lookup(name);
    if (v) return v;
    if (this.cur !== this.g) return this.g.scopes[0].get(name);
    return undefined;
  }

  /** "ta.sma", "color.red", "MyType.new": a name made of names, when its start isn't a variable. */
  private dotted(e: Expr): string | null {
    if (e.k === "id") return this.resolve(e.name) ? null : e.name;
    if (e.k === "member") {
      const d = this.dotted(e.obj);
      return d === null ? null : `${d}.${e.name}`;
    }
    return null;
  }

  /** #fff, color.red, color.new(…): a color written out (input() makes a color input of it). */
  private isColorExpr(e: Expr): boolean {
    if (e.k === "color") return true;
    const path = e.k === "member" ? this.dotted(e) : e.k === "call" ? this.dotted(e.callee) : null;
    return !!path && path.startsWith("color.");
  }

  private isConstInt(e: Expr): boolean {
    switch (e.k) {
      case "num":
        return e.int;
      case "unary":
        return e.op !== "not" && this.isConstInt(e.e);
      case "bin":
        return ["+", "-", "*", "/", "%"].includes(e.op) && this.isConstInt(e.l) && this.isConstInt(e.r);
      case "id": {
        const v = this.resolve(e.name);
        return !!v && v.constInt;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------- expressions
  expr(e: Expr): Ev {
    const R = this.R;
    switch (e.k) {
      case "num": {
        const v = e.v;
        return () => v;
      }
      case "str": {
        const v = e.v;
        return () => v;
      }
      case "bool": {
        const v = e.v;
        return () => v;
      }
      case "color": {
        const v = hexColor(e.v);
        return () => v;
      }
      case "id":
        return this.ident(e);
      case "member":
        return this.member(e);
      case "call":
        return this.call(e);
      case "hist":
        return this.hist(e);
      case "unary": {
        const x = this.expr(e.e);
        if (e.op === "-") return (f) => -(x(f) as number);
        if (e.op === "+") return x;
        return (f) => {
          const v = x(f);
          return !(v && v === v);
        };
      }
      case "bin":
        return this.binary(e);
      case "ternary": {
        const c = this.expr(e.c);
        const a = this.expr(e.a);
        const b = this.expr(e.b);
        return (f) => {
          const v = c(f);
          return v && v === v ? a(f) : b(f);
        };
      }
      case "tuple": {
        const items = e.items.map((x) => this.expr(x));
        return (f) => new Tuple(items.map((x) => x(f)));
      }
      case "if": {
        const c = this.expr(e.cond);
        const t = this.block(e.then);
        const els = e.else ? this.block(e.else) : null;
        return (f) => {
          const v = c(f);
          return v && v === v ? t(f) : els ? els(f) : NaN;
        };
      }
      case "switch":
        return this.switchExpr(e);
      case "for":
        return this.forLoop(e);
      case "forin":
        return this.forIn(e);
      case "while": {
        const c = this.expr(e.cond);
        const body = this.block(e.body);
        return (f) => {
          let res: unknown = NaN;
          for (;;) {
            const v = c(f);
            if (!(v && v === v)) break;
            res = body(f);
            loopTick(R);
            if (R.jump) {
              const j = R.jump;
              R.jump = 0;
              if (j === 1) break;
            }
          }
          return res;
        };
      }
    }
  }

  private binary(e: Extract<Expr, { k: "bin" }>): Ev {
    const l = this.expr(e.l);
    const r = this.expr(e.r);
    const lazy = this.version >= 6;
    switch (e.op) {
      case "+":
        return (f) => (l(f) as number) + (r(f) as number);
      case "-":
        return (f) => (l(f) as number) - (r(f) as number);
      case "*":
        return (f) => (l(f) as number) * (r(f) as number);
      case "/":
        if (this.version <= 5 && this.isConstInt(e.l) && this.isConstInt(e.r))
          return (f) => {
            const b = r(f) as number;
            return b === 0 ? NaN : Math.trunc((l(f) as number) / b);
          };
        return (f) => {
          const b = r(f) as number;
          return b === 0 ? NaN : (l(f) as number) / b;
        };
      case "%":
        return (f) => {
          const b = r(f) as number;
          return b === 0 ? NaN : (l(f) as number) % b;
        };
      case "<":
        return (f) => (l(f) as number) < (r(f) as number);
      case ">":
        return (f) => (l(f) as number) > (r(f) as number);
      case "<=":
        return (f) => (l(f) as number) <= (r(f) as number);
      case ">=":
        return (f) => (l(f) as number) >= (r(f) as number);
      case "==":
        return (f) => l(f) === r(f);
      case "!=":
        return (f) => {
          const a = l(f);
          const b = r(f);
          return a !== b && !(a !== a && b !== b);
        };
      case "and":
        if (lazy)
          return (f) => {
            const a = l(f);
            if (!(a && a === a)) return false;
            const b = r(f);
            return !!b && b === b;
          };
        return (f) => {
          const a = l(f);
          const b = r(f);
          return !!a && a === a && !!b && b === b;
        };
      case "or":
        if (lazy)
          return (f) => {
            const a = l(f);
            if (a && a === a) return true;
            const b = r(f);
            return !!b && b === b;
          };
        return (f) => {
          const a = l(f);
          const b = r(f);
          return (!!a && a === a) || (!!b && b === b);
        };
    }
    this.err(`看不懂的運算「${e.op}」`, e);
  }

  private ident(e: Extract<Expr, { k: "id" }>): Ev {
    const v = this.resolve(e.name);
    if (v) {
      const slot = v.slot;
      if (v.global && this.cur !== this.g) {
        const R = this.R;
        return () => R.g.v[slot];
      }
      return (f) => f.v[slot];
    }
    const b = this.builtinVar(e.name);
    if (b) return b;
    if (this.fns.has(e.name) || LIB[e.name]) this.err(`「${e.name}」是函式，要加 ( ) 呼叫`, e);
    this.err(`找不到「${e.name}」`, e);
  }

  private member(e: Extract<Expr, { k: "member" }>): Ev {
    const path = this.dotted(e);
    if (path) {
      const dot = path.lastIndexOf(".");
      const en = this.enums.get(path.slice(0, dot));
      if (en) {
        const v = en.get(path.slice(dot + 1));
        if (!v) this.err(`${path.slice(0, dot)} 沒有 ${path.slice(dot + 1)}`, e);
        return () => v;
      }
      const b = this.builtinVar(path);
      if (b) return b;
      if (LIB[path]) this.err(`「${path}」是函式，要加 ( ) 呼叫`, e);
      this.err(`不支援或不認得「${path}」`, e);
    }
    const obj = this.expr(e.obj);
    const name = e.name;
    return (f) => {
      const o = obj(f);
      if (o instanceof PineObject) {
        const k = o.t.ix[name];
        if (k === undefined) throw new PineError(`${o.t.name} 沒有欄位 ${name}`);
        return o.f[k];
      }
      if (isNa(o)) throw new PineError(`物件是 na，讀不到 ${name}`);
      throw new PineError(`讀不到「${name}」`);
    };
  }

  /** x[n]: a variable's history, the bars' own series, or any expression's past values. */
  private hist(e: Extract<Expr, { k: "hist" }>): Ev {
    const R = this.R;
    const idx = this.expr(e.index);
    const o = e.obj;
    if (o.k === "id") {
      const v = this.resolve(o.name);
      if (v) {
        const outer = v.global && this.cur !== this.g;
        const fi = outer ? this.g.fi : this.cur.fi;
        fi.tracked[v.slot] = true;
        const slot = v.slot;
        return (f) => {
          const fr = outer ? R.g : f;
          const n = toInt(idx(f));
          if (n === 0) return fr.v[slot];
          const h = fr.h[slot];
          if (!h || !(n > 0)) return NaN;
          const j = (h.b === R.i ? h.a.length - 1 : h.a.length) - n;
          return j >= 0 ? h.a[j] : NaN;
        };
      }
      const arr = barSeries(R, o.name);
      if (arr) {
        if (o.name === "bar_index") return (f) => {
          const n = toInt(idx(f));
          return R.i - n >= 0 && n >= 0 ? R.i - n : NaN;
        };
        return (f) => {
          const n = toInt(idx(f));
          const j = R.i - n;
          const a = arr();
          return j >= 0 && n >= 0 && j < R.n ? a[j] : NaN;
        };
      }
      if (o.name === "time_close") return (f) => {
        const j = R.i - toInt(idx(f));
        return j >= 0 && j < R.n ? R.t[j] + R.tf.sec * 1000 : NaN;
      };
    }
    const inner = this.expr(o);
    const site = this.cur.site();
    return (f) => {
      let st = f.s[site] as { b: number; a: unknown[] } | undefined;
      if (!st) st = f.s[site] = { b: -1, a: [] };
      const v = inner(f);
      if (st.b !== R.i) {
        st.a.push(v);
        st.b = R.i;
      } else st.a[st.a.length - 1] = v;
      const n = toInt(idx(f));
      const j = st.a.length - 1 - n;
      return j >= 0 && n >= 0 ? st.a[j] : NaN;
    };
  }

  private switchExpr(e: Extract<Expr, { k: "switch" }>): Ev {
    const subj = e.subject ? this.expr(e.subject) : null;
    const cases = e.cases.map((c) => ({ cond: c.cond ? this.expr(c.cond) : null, body: this.block(c.body) }));
    const dflt = cases.find((c) => !c.cond)?.body ?? null;
    const conds = cases.filter((c) => c.cond) as { cond: Ev; body: Ev }[];
    return (f) => {
      if (subj) {
        const s = subj(f);
        for (const c of conds) if (c.cond(f) === s) return c.body(f);
      } else {
        for (const c of conds) {
          const v = c.cond(f);
          if (v && v === v) return c.body(f);
        }
      }
      return dflt ? dflt(f) : NaN;
    };
  }

  private forLoop(e: Extract<Expr, { k: "for" }>): Ev {
    const R = this.R;
    const from = this.expr(e.from);
    const to = this.expr(e.to);
    const by = e.by ? this.expr(e.by) : null;
    this.cur.scopes.push(new Map());
    const v = this.cur.declare(e.name, null);
    const body = this.block(e.body);
    this.cur.scopes.pop();
    const slot = v.slot;
    const tracked = this.cur.fi.tracked;
    const dynamic = this.version >= 6;
    return (f) => {
      const a = num(from(f));
      let b = num(to(f));
      if (!(a === a) || !(b === b)) return NaN;
      const step = by ? Math.abs(num(by(f))) : 1;
      if (!(step > 0)) throw new PineError("for 迴圈的 by 要大於 0");
      const dir = b >= a ? 1 : -1;
      let res: unknown = NaN;
      for (let i = a; dir > 0 ? i <= b : i >= b; i += dir * step) {
        f.v[slot] = i;
        if (tracked[slot]) push(R, f, slot, i);
        res = body(f);
        loopTick(R);
        if (R.jump) {
          const j = R.jump;
          R.jump = 0;
          if (j === 1) break;
        }
        if (dynamic) b = num(to(f));
      }
      return res;
    };
  }

  private forIn(e: Extract<Expr, { k: "forin" }>): Ev {
    const R = this.R;
    const iter = this.expr(e.iter);
    this.cur.scopes.push(new Map());
    const iv = e.index ? this.cur.declare(e.index, null) : null;
    const v = this.cur.declare(e.name, null);
    const body = this.block(e.body);
    this.cur.scopes.pop();
    const slot = v.slot;
    const islot = iv ? iv.slot : -1;
    return (f) => {
      const it = iter(f);
      let res: unknown = NaN;
      const step = (k: unknown, x: unknown): boolean => {
        if (islot >= 0) f.v[islot] = k;
        f.v[slot] = x;
        res = body(f);
        loopTick(R);
        if (R.jump) {
          const j = R.jump;
          R.jump = 0;
          if (j === 1) return false;
        }
        return true;
      };
      if (Array.isArray(it)) {
        const n = it.length;
        for (let k = 0; k < n && k < it.length; k++) if (!step(k, it[k])) break;
      } else if (it instanceof Map) {
        for (const [k, x] of [...it]) if (!step(k, x)) break;
      } else if (it instanceof Matrix) {
        for (let r = 0; r < it.rows; r++) if (!step(r, it.d.slice(r * it.cols, (r + 1) * it.cols))) break;
      } else if (!isNa(it)) throw new PineError("for … in 只能走過陣列、map 或矩陣");
      return res;
    };
  }

  // ------------------------------------------------------------------- calls
  private call(e: Extract<Expr, { k: "call" }>): Ev {
    const callee = e.callee;
    const path = this.dotted(callee);
    if (path !== null) {
      if (!path.includes(".")) {
        const fns = this.fns.get(path);
        if (fns) return this.userCall(e, pick(fns, e.args.length, e, this), null);
        if (path === "iff") {
          const [c, a, b] = e.args.map((x) => this.expr(x.value));
          return (f) => {
            const v = c(f);
            return v && v === v ? a(f) : b(f);
          };
        }
      }
      const dot = path.lastIndexOf(".");
      const head = path.slice(0, dot);
      const tail = path.slice(dot + 1);
      const udt = head === "chart.point" ? null : this.types.get(head);
      if (udt && tail === "new") return this.construct(e, udt);
      if (udt && tail === "copy") {
        const x = this.expr(e.args[0]?.value ?? this.err("copy 要給物件", e));
        return (f) => copyObj(x(f));
      }
      if (path === "request.security" || (path === "security" && this.version <= 4)) return this.security(e);
      if (path === "request.security_lower_tf") {
        const R = this.R;
        return () => (R.warn("request.security_lower_tf 不支援：回傳空陣列"), []);
      }
      if (path.startsWith("request.")) {
        const R = this.R;
        const what = path;
        return () => (R.warn(`${what} 不支援：回傳 na`), what === "request.currency_rate" ? 1 : NaN);
      }
      if (path.startsWith("ticker.")) return this.ticker(e, tail);
      if (this.version <= 4 && ["heikinashi", "renko", "linebreak", "kagi", "pointfigure"].includes(path)) return this.ticker(e, path);
      if (this.version <= 4 && path === "tickerid") return this.ticker(e, "new");
      if (path === "timeframe.change" || path === "timeframe.in_seconds" || path === "timeframe.from_seconds") return this.tfCall(e, tail);
      let bi = LIB[path];
      let name = path;
      if (!bi && !path.includes(".")) {
        const alias = V4_ALIASES[path];
        if (alias) {
          bi = LIB[alias];
          name = alias;
        }
        for (const ns of V4_NS) {
          if (bi) break;
          if (LIB[`${ns}.${path}`]) {
            bi = LIB[`${ns}.${path}`];
            name = `${ns}.${path}`;
          }
        }
      }
      if (bi) return this.builtinCall(e, bi, name, null);
      if (callee.k === "member" && this.methods.has(callee.name) && this.dotted(callee.obj) === null) return this.methodCall(e, callee.obj, callee.name);
      this.err(`不支援的函式「${path}」`, e);
    }
    if (callee.k === "member") return this.methodCall(e, callee.obj, callee.name);
    this.err("這個不能當函式呼叫", e);
  }

  /** Arguments in parameter order (named ones by name); missing ones undefined. */
  private mapArgs(args: Arg[], params: string[], fname: string, node: Expr, offset = 0): (Ev | undefined)[] {
    const out: (Ev | undefined)[] = [];
    const variadic = params[params.length - 1] === "...";
    let p = offset;
    for (const a of args) {
      if (a.name) {
        const k = params.indexOf(a.name);
        if (k < 0) {
          // older parameters that are gone (transp, when, …) are ignored, like an option that does nothing
          if (["transp", "when", "editable", "show_last", "display", "format", "precision", "tooltip", "confirm", "inline", "group", "force_overlay"].includes(a.name)) continue;
          this.err(`${fname} 沒有參數「${a.name}」`, node);
        }
        out[k] = this.expr(a.value);
      } else {
        if (p >= params.length && !variadic) this.err(`${fname} 的參數太多了`, node);
        out[p++] = this.expr(a.value);
      }
    }
    return out;
  }

  private builtinCall(e: Extract<Expr, { k: "call" }>, bi: Builtin, name: string, self: Ev | null): Ev {
    const R = this.R;
    const site = bi.st ? this.cur.site() : -1;
    const id = e.id;
    const mk = bi.st;
    // input.source(close) / input(close): the name of the source, so the user can pick another one;
    // input(#2962FF): a color input
    const isInput = name === "input.source" || name === "input";
    const defArg = isInput ? (e.args.find((a) => a.name === "defval") ?? (e.args[0] && !e.args[0].name ? e.args[0] : undefined)) : undefined;
    const dv = defArg?.value;
    const srcArg = dv && dv.k === "id" && SOURCE_VARS.has(dv.name) && !this.resolve(dv.name) ? dv.name : null;
    const typed = e.args.some((a) => a.name === "type") || (e.args.length > 2 && !e.args[2].name);
    const colorArg = name === "input" && dv && !typed && this.isColorExpr(dv);
    // input(2.0): a float input, though 2.0 is a whole number
    const floatArg = name === "input" && dv && !typed && dv.k === "num" && !dv.int;
    if (bi.n) {
      const pos: Ev[] = [];
      if (self) pos.push(self);
      const named: [string, Ev][] = [];
      for (const a of e.args) {
        let ev = this.expr(a.value);
        if (srcArg && a === defArg) {
          const s = new SrcName(srcArg);
          ev = () => s;
        }
        if (a.name) named.push([a.name, ev]);
        else pos.push(ev);
      }
      if (colorArg) named.push(["type", () => "color"]);
      if (floatArg) named.push(["type", () => "float"]);
      const n = pos.length;
      const fn = bi.n;
      // one argument list and record per call site, filled again on each call (none of these functions keeps them)
      const pa = new Array(n);
      const nm: Record<string, unknown> = {};
      return (f) => {
        for (let i = 0; i < n; i++) pa[i] = pos[i](f);
        for (let i = 0; i < named.length; i++) nm[named[i][0]] = named[i][1](f);
        let st: unknown;
        if (site >= 0) {
          st = f.s[site];
          if (st === undefined) st = f.s[site] = mk!(R, id);
        }
        return fn(R, pa, nm, st);
      };
    }
    const evs = this.mapArgs(e.args, bi.p, name, e, self ? 1 : 0);
    if (self) evs[0] = self;
    const n = evs.length;
    const fn = bi.f!;
    if (site < 0) {
      if (n === 1 && evs[0]) {
        const a0 = evs[0];
        return (f) => fn(R, [a0(f)], undefined);
      }
      if (n === 2 && evs[0] && evs[1]) {
        const a0 = evs[0];
        const a1 = evs[1];
        return (f) => fn(R, [a0(f), a1(f)], undefined);
      }
    }
    return (f) => {
      const a = new Array(n);
      for (let i = 0; i < n; i++) {
        const ev = evs[i];
        a[i] = ev ? ev(f) : undefined;
      }
      let st: unknown;
      if (site >= 0) {
        st = f.s[site];
        if (st === undefined) st = f.s[site] = mk!(R, id);
      }
      return fn(R, a, st);
    };
  }

  private userCall(e: Extract<Expr, { k: "call" }>, uf: UserFn, self: Ev | null): Ev {
    const R = this.R;
    const site = this.cur.site();
    const params = uf.params.map((p) => p.name);
    const evs = this.mapArgs(e.args, params, uf.name, e, self ? 1 : 0);
    if (self) evs[0] = self;
    const n = params.length;
    return (f) => {
      let cf = f.s[site] as Frame | undefined;
      if (!cf) cf = f.s[site] = newFrame(uf.fi);
      const vals = new Array(n);
      for (let i = 0; i < n; i++) {
        const ev = evs[i];
        if (ev) vals[i] = ev(f);
        else {
          const d = uf.defaults[i];
          vals[i] = d ? d(R.g) : NaN;
        }
      }
      return invoke(R, uf, cf, vals);
    };
  }

  /** obj.name(…): a user method for that kind of value, or the built-in one (array.*, map.*, line.*, str.*…). */
  private methodCall(e: Extract<Expr, { k: "call" }>, objE: Expr, name: string): Ev {
    const R = this.R;
    const obj = this.expr(objE);
    const users = this.methods.get(name) ?? [];
    const site = this.cur.site();
    const pos: Ev[] = [];
    const named: [string, Ev][] = [];
    for (const a of e.args) {
      if (a.name) named.push([a.name, this.expr(a.value)]);
      else pos.push(this.expr(a.value));
    }
    const types = this.types;
    return (f) => {
      const o = obj(f);
      const kind = kindOf(o);
      let st = f.s[site] as Map<unknown, unknown> | undefined;
      if (!st) st = f.s[site] = new Map();
      const uf = pickMethod(users, kind);
      if (uf) {
        let cf = st.get(uf) as Frame | undefined;
        if (!cf) {
          cf = newFrame(uf.fi);
          st.set(uf, cf);
        }
        const vals = new Array(uf.params.length);
        vals[0] = o;
        for (let i = 0; i < pos.length; i++) vals[i + 1] = pos[i](f);
        for (const [k, ev] of named) {
          const j = uf.params.findIndex((p) => p.name === k);
          if (j < 0) throw new PineError(`${name} 沒有參數「${k}」`);
          vals[j] = ev(f);
        }
        for (let i = 0; i < vals.length; i++) if (vals[i] === undefined) vals[i] = uf.defaults[i] ? uf.defaults[i]!(R.g) : NaN;
        return invoke(R, uf, cf, vals);
      }
      if (name === "copy" && (o instanceof PineObject || types.has(kind))) return copyObj(o);
      const ns = NAMESPACE[kind];
      const bi = ns ? LIB[`${ns}.${name}`] : undefined;
      if (!bi) {
        if (isNa(o)) throw new PineError(`物件是 na，不能呼叫 ${name}()`);
        throw new PineError(`${KIND_NAME[kind] ?? kind} 沒有 ${name}() 方法`);
      }
      if (bi.n) {
        const pa = [o, ...pos.map((p) => p(f))];
        const nm: Record<string, unknown> = {};
        for (const [k, ev] of named) nm[k] = ev(f);
        let bst: unknown;
        if (bi.st) {
          bst = st.get(bi);
          if (bst === undefined) st.set(bi, (bst = bi.st(R, e.id)));
        }
        return bi.n(R, pa, nm, bst);
      }
      const a: unknown[] = [o];
      for (let i = 0; i < pos.length; i++) a[i + 1] = pos[i](f);
      for (const [k, ev] of named) {
        const j = bi.p.indexOf(k);
        if (j < 0) throw new PineError(`${ns}.${name} 沒有參數「${k}」`);
        a[j] = ev(f);
      }
      let bst: unknown;
      if (bi.st) {
        bst = st.get(bi);
        if (bst === undefined) st.set(bi, (bst = bi.st(R, e.id)));
      }
      return bi.f!(R, a, bst);
    };
  }

  /** MyType.new(…): fields in order or by name; missing ones get their default. */
  private construct(e: Extract<Expr, { k: "call" }>, t: UdtDef): Ev {
    const evs = this.mapArgs(e.args, t.fields, `${t.name}.new`, e);
    const R = this.R;
    return (f) => {
      const vals = new Array(t.fields.length);
      for (let i = 0; i < vals.length; i++) {
        const ev = evs[i];
        vals[i] = ev ? ev(f) : t.defs[i] ? t.defs[i](R) : NaN;
      }
      return new PineObject(t, vals);
    };
  }

  // ------------------------------------------------------------------- request.security and friends
  private security(e: Extract<Expr, { k: "call" }>): Ev {
    const R = this.R;
    const names = ["symbol", "timeframe", "expression", "gaps", "lookahead", "ignore_invalid_symbol", "currency", "calc_bars_count"];
    const evs = this.mapArgs(e.args, names, "request.security", e);
    const sym = evs[0] ?? (() => "");
    const tfE = evs[1] ?? (() => "");
    const expr = evs[2];
    if (!expr) this.err("request.security 要給計算的式子", e);
    const gapsE = evs[3];
    const lookE = evs[4];
    const exprNode = e.args.find((a) => a.name === "expression")?.value ?? e.args.filter((a) => !a.name)[2]?.value;
    const width = exprNode?.k === "tuple" ? exprNode.items.length : 0;
    const naLike = () => (width ? new Tuple(new Array(width).fill(NaN)) : NaN);
    const site = this.cur.site();
    const id = e.id;
    return (f) => {
      let st = f.s[site] as { key: string; last: number } | undefined;
      if (!st) {
        const k = R.occ.get(id) ?? 0;
        R.occ.set(id, k + 1);
        st = f.s[site] = { key: k ? `${id}#${k}` : String(id), last: -2 };
      }
      const symbol = sym(f);
      let ha = false;
      let s = typeof symbol === "string" ? symbol : "";
      if (s.startsWith("HA:")) {
        ha = true;
        s = s.slice(3);
      }
      if (s.startsWith("NA:")) {
        R.warn(`不支援這種 K 線（${s.slice(3, s.indexOf(":", 3))}）：回傳 na`);
        return naLike();
      }
      if (!sameSymbol(R, s)) {
        R.warn(`request.security 只能用圖表上的商品（${s}）：回傳 na`);
        return naLike();
      }
      const tfs = tfE(f);
      const tf = typeof tfs === "string" && tfs ? pineTf(tfs) : R.secFor ? R.secFor.tf : R.tf;
      if (!tf) {
        R.warn(`不支援的週期「${String(tfs)}」：回傳 na`);
        return naLike();
      }
      const key = `${tf.period}${ha ? "|ha" : ""}`;
      if (R.secFor) {
        // computing values for one request: record them where the request is this one
        if (key !== R.secFor.key && !(tf.sec === R.secFor.tf.sec && !ha && !R.secFor.ha)) return naLike();
        const v = expr(f);
        let arr = R.secOut.get(st.key);
        if (!arr) R.secOut.set(st.key, (arr = new Array(R.n).fill(NaN)));
        arr[R.i] = v;
        return v;
      }
      if (tf.sec === R.tf.sec && !ha) return expr(f);
      if (tf.sec < R.tf.sec) {
        R.warn(`request.security 不支援比圖表小的週期（${tf.period}）：回傳 na`);
        return naLike();
      }
      const run = R.sec.get(key);
      if (!run) {
        R.needs.add(key);
        return naLike();
      }
      const vals = run.values.get(st.key);
      if (!vals) return naLike();
      const look = lookE ? !!lookE(f) : false;
      const at = alignment(R, run, key, look)[R.i];
      if (gapsE && gapsE(f)) {
        // gaps_on: only on the bar where the other timeframe's value arrives
        const prev = R.i > 0 ? alignment(R, run, key, look)[R.i - 1] : -1;
        if (at === prev) return naLike();
      }
      return at >= 0 ? vals[at] : naLike();
    };
  }

  private ticker(e: Extract<Expr, { k: "call" }>, fn: string): Ev {
    const R = this.R;
    const first = e.args[0] ? this.expr(e.args[0].value) : () => R.sym.tickerid;
    const second = e.args[1] ? this.expr(e.args[1].value) : null;
    switch (fn) {
      case "new":
        return (f) => `${String(first(f))}:${second ? String(second(f)) : ""}`;
      case "heikinashi":
        return (f) => `HA:${String(first(f))}`;
      case "renko":
      case "kagi":
      case "linebreak":
      case "pointfigure":
      case "inherit":
        if (fn === "inherit") return (f) => (second ? second(f) : first(f));
        return (f) => `NA:${fn}:${String(first(f))}`;
      default:
        return (f) => first(f);
    }
  }

  private tfCall(e: Extract<Expr, { k: "call" }>, fn: string): Ev {
    const R = this.R;
    const a = e.args[0] ? this.expr(e.args[0].value) : () => "";
    if (fn === "from_seconds") return (f) => periodOf(toInt(a(f)), R.version);
    if (fn === "in_seconds")
      return (f) => {
        const s = a(f);
        return typeof s === "string" && s ? tfSeconds(s) : R.tf.sec;
      };
    return (f) => {
      const s = a(f);
      const sec = typeof s === "string" && s ? tfSeconds(s) : R.tf.sec;
      return sec > R.tf.sec ? newPeriod(R, sec) : true;
    };
  }

  // ------------------------------------------------------------------- built-in variables
  private builtinVar(name: string): Ev | null {
    const R = this.R;
    const arr = barSeries(R, name);
    if (arr) {
      if (name === "bar_index") return () => R.i;
      return () => arr()[R.i];
    }
    if (name in STR_CONSTS) {
      const v = STR_CONSTS[name];
      return () => v;
    }
    if (name.startsWith("color.")) {
      const c = this.colors[name.slice(6)];
      if (c !== undefined) return () => c;
      return null;
    }
    if (name.startsWith("currency.")) {
      const v = name.slice(9);
      return () => v;
    }
    if (name.startsWith("strategy.")) return () => strategyVar(R, name);
    if (name.startsWith("ta.")) return () => taSeries(R, name);
    switch (name) {
      case "na":
        return () => NaN;
      case "time_close":
        return () => R.t[R.i] + R.tf.sec * 1000;
      case "time_tradingday":
        return () => Math.floor(R.t[R.i] / 86400000) * 86400000;
      case "timenow":
        return () => R.now;
      case "last_bar_index":
        return () => R.n - 1;
      case "last_bar_time":
        return () => R.t[R.n - 1];
      case "year":
      case "month":
      case "dayofmonth":
      case "dayofweek":
      case "hour":
      case "minute":
      case "second":
      case "weekofyear": {
        const fn = LIB[name].f!;
        return () => fn(R, [], undefined);
      }
      case "barstate.isfirst":
        return () => R.i === 0;
      case "barstate.islast":
        return () => R.i === R.n - 1;
      case "barstate.ishistory":
        return () => !!R.conf[R.i];
      case "barstate.isrealtime":
        return () => R.i === R.n - 1 && !R.conf[R.i];
      case "barstate.isnew":
        return () => true;
      case "barstate.isconfirmed":
        return () => !!R.conf[R.i];
      case "barstate.islastconfirmedhistory":
        return () => R.i === R.lastConfirmed;
      case "syminfo.ticker":
        return () => R.sym.ticker;
      case "syminfo.tickerid":
      case "syminfo.main_tickerid":
        return () => R.sym.tickerid;
      case "syminfo.prefix":
        return () => "OKX";
      case "syminfo.root":
      case "syminfo.basecurrency":
        return () => R.sym.base;
      case "syminfo.currency":
        return () => R.sym.quote;
      case "syminfo.description":
        return () => R.sym.description;
      case "syminfo.mintick":
        return () => R.sym.mintick;
      case "syminfo.pointvalue":
        return () => 1;
      case "syminfo.pricescale":
        return () => Math.round(1 / R.sym.mintick);
      case "syminfo.minmove":
        return () => 1;
      case "syminfo.type":
        return () => "crypto";
      case "syminfo.timezone":
        return () => "Etc/UTC";
      case "syminfo.session":
        return () => "24x7";
      case "syminfo.volumetype":
        return () => "base";
      case "syminfo.country":
      case "syminfo.industry":
      case "syminfo.sector":
        return () => "";
      case "timeframe.period":
      case "timeframe.main_period":
        return () => R.tf.period;
      case "timeframe.multiplier":
        return () => {
          const s = R.tf.sec;
          return s % 604800 === 0 ? s / 604800 : s % 86400 === 0 ? s / 86400 : s % 60 === 0 ? s / 60 : s;
        };
      case "timeframe.isintraday":
        return () => R.tf.sec < 86400;
      case "timeframe.isdaily":
        return () => R.tf.sec >= 86400 && R.tf.sec % 604800 !== 0;
      case "timeframe.isweekly":
        return () => R.tf.sec % 604800 === 0;
      case "timeframe.ismonthly":
      case "timeframe.isticks":
        return () => false;
      case "timeframe.isminutes":
        return () => R.tf.sec < 86400 && R.tf.sec >= 60;
      case "timeframe.isseconds":
        return () => R.tf.sec < 60;
      case "timeframe.isdwm":
        return () => R.tf.sec >= 86400;
      case "line.all":
        return () => R.out.lines.slice();
      case "label.all":
        return () => R.out.labels.slice();
      case "box.all":
        return () => R.out.boxes.slice();
      case "table.all":
        return () => R.out.tables.slice();
      case "linefill.all":
        return () => R.out.linefills.slice();
      case "polyline.all":
        return () => R.out.polylines.slice();
    }
    return null;
  }
}

// ----------------------------------------------------------------------------- runtime helpers

function seq(R: Runtime, evs: Ev[]): Ev {
  const n = evs.length;
  if (n === 0) return () => NaN;
  if (n === 1) return evs[0];
  return (f) => {
    let v: unknown = NaN;
    for (let i = 0; i < n; i++) {
      v = evs[i](f);
      if (R.jump) return v;
    }
    return v;
  };
}

/** A new value of a variable whose history is read: one per bar (the last one is the current value). */
function push(R: Runtime, f: Frame, slot: number, val: unknown) {
  let h = f.h[slot];
  if (!h) h = f.h[slot] = { b: -1, a: [] };
  if (h.b !== R.i) {
    h.a.push(val);
    h.b = R.i;
  } else h.a[h.a.length - 1] = val;
}

function loopTick(R: Runtime) {
  if ((++R.loops & LOOP_CHECK) === 0 && Date.now() > R.deadline) throw new PineError("迴圈跑太久，已停止（是不是沒有結束條件？）");
}

function combine(op: string): (a: unknown, b: unknown) => unknown {
  switch (op) {
    case "+=":
      return (a, b) => (a as number) + (b as number);
    case "-=":
      return (a, b) => (a as number) - (b as number);
    case "*=":
      return (a, b) => (a as number) * (b as number);
    case "/=":
      return (a, b) => ((b as number) === 0 ? NaN : (a as number) / (b as number));
    case "%=":
      return (a, b) => ((b as number) === 0 ? NaN : (a as number) % (b as number));
    default:
      return (_a, b) => (b === undefined ? NaN : b);
  }
}

function invoke(R: Runtime, uf: UserFn, cf: Frame, vals: unknown[]): unknown {
  const tracked = uf.fi.tracked;
  for (let i = 0; i < vals.length; i++) {
    cf.v[i] = vals[i];
    if (tracked[i]) push(R, cf, i, vals[i]);
  }
  if (!uf.body) throw new PineError(`函式 ${uf.name} 還沒寫好`);
  const r = uf.body(cf);
  R.jump = 0;
  return r;
}

function pick(fns: UserFn[], nargs: number, e: { line: number; col: number }, c: Compiler): UserFn {
  if (fns.length === 1) return fns[0];
  const fit = fns.filter((f) => nargs <= f.params.length && nargs >= f.params.filter((p) => !p.def).length);
  if (!fit.length) c.err(`${fns[0].name} 沒有 ${nargs} 個參數的版本`, e);
  return fit[fit.length - 1];
}

function typeName(t: TypeRef): string {
  return t.name;
}

/** The kind of a value, for picking methods. */
function kindOf(v: unknown): string {
  switch (typeof v) {
    case "number":
      return "float";
    case "string":
      return "string";
    case "boolean":
      return "bool";
  }
  if (Array.isArray(v)) return "array";
  if (v instanceof Map) return "map";
  if (v instanceof Matrix) return "matrix";
  if (v instanceof PineObject) return v.t.name;
  if (v instanceof EnumVal) return v.e;
  if (v instanceof PLine) return "line";
  if (v instanceof PLabel) return "label";
  if (v instanceof PBox) return "box";
  if (v instanceof PTable) return "table";
  if (v instanceof PLinefill) return "linefill";
  if (v instanceof PPolyline) return "polyline";
  return "na";
}
const NAMESPACE: Record<string, string> = {
  array: "array", map: "map", matrix: "matrix", string: "str", line: "line", label: "label", box: "box", table: "table", linefill: "linefill", polyline: "polyline", "chart.point": "chart.point",
};
const KIND_NAME: Record<string, string> = { float: "數字", bool: "布林值", na: "na", string: "文字" };

function pickMethod(users: UserFn[], kind: string): UserFn | null {
  if (!users.length) return null;
  const fits = (self: string | null) => {
    if (self === null) return true;
    if (self === kind) return true;
    if (kind === "float" && (self === "int" || self === "float" || self === "color")) return true;
    return false;
  };
  const exact = users.filter((u) => u.self === kind);
  if (exact.length) return exact[exact.length - 1];
  const loose = users.filter((u) => fits(u.self));
  return loose.length ? loose[loose.length - 1] : null;
}

function copyObj(o: unknown): unknown {
  if (o instanceof PineObject) return new PineObject(o.t, o.f.slice());
  if (isNa(o)) return NaN;
  throw new PineError("只能複製物件");
}

/** close, open, … : the bars' own series (for x and x[n]). */
function barSeries(R: Runtime, name: string): (() => ArrayLike<number>) | null {
  switch (name) {
    case "open":
      return () => R.o;
    case "high":
      return () => R.h;
    case "low":
      return () => R.l;
    case "close":
      return () => R.c;
    case "volume":
      return () => R.vol;
    case "time":
      return () => R.t;
    case "bar_index":
      return () => R.c;
    case "hl2":
    case "hlc3":
    case "ohlc4":
    case "hlcc4":
      return () => derived(R, name);
  }
  return null;
}

function derived(R: Runtime, name: string): Float64Array {
  let a = R.cache.get(name);
  if (a) return a;
  a = new Float64Array(R.n);
  const { o, h, l, c } = R;
  for (let i = 0; i < R.n; i++)
    a[i] = name === "hl2" ? (h[i] + l[i]) / 2 : name === "hlc3" ? (h[i] + l[i] + c[i]) / 3 : name === "ohlc4" ? (o[i] + h[i] + l[i] + c[i]) / 4 : (h[i] + l[i] + 2 * c[i]) / 4;
  R.cache.set(name, a);
  return a;
}

/** Same symbol as the chart? (Another exchange's symbol for the same pair counts as this one.) */
function sameSymbol(R: Runtime, s: string): boolean {
  if (!s) return true;
  const norm = (x: string) => x.replace(/^.*:/, "").replace(/\.P$|PERP$|-SWAP$/i, "").replace(/[-_/]/g, "").toUpperCase();
  return norm(s) === norm(R.sym.tickerid) || norm(s) === norm(R.sym.instId) || norm(s) === R.sym.base.toUpperCase() + "USD" || norm(s) === R.sym.base.toUpperCase() + "USDC";
}

/** For each chart bar, which bar of the other timeframe request.security() reads. */
function alignment(R: Runtime, run: SecRun, key: string, look: boolean): Int32Array {
  const ck = `align:${key}:${look ? 1 : 0}`;
  const cached = R.cache.get(ck);
  if (cached) return cached as unknown as Int32Array;
  const out = new Int32Array(R.n).fill(-1);
  const ms = run.tf.sec * 1000;
  const chartMs = R.tf.sec * 1000;
  const times = run.times;
  let j = -1;
  let k = -1;
  for (let i = 0; i < R.n; i++) {
    const t = R.t[i];
    while (k + 1 < times.length && times[k + 1] <= t) k++;
    if (look) {
      out[i] = k;
      continue;
    }
    const end = t + chartMs;
    while (j + 1 < times.length && times[j + 1] + ms <= end && run.confirmed[j + 1]) j++;
    // the forming bar sees the other timeframe's forming bar, like TradingView in real time
    out[i] = i === R.n - 1 && !R.conf[i] ? k : j;
  }
  R.cache.set(ck, out as unknown as Float64Array);
  return out;
}

function reset(R: Runtime, data: RunData, opts: RunOpts) {
  const bars = data.bars;
  const n = bars.length;
  R.n = n;
  R.t = new Float64Array(n);
  R.o = new Float64Array(n);
  R.h = new Float64Array(n);
  R.l = new Float64Array(n);
  R.c = new Float64Array(n);
  R.vol = new Float64Array(n);
  R.conf = new Uint8Array(n);
  R.lastConfirmed = -1;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    R.t[i] = b.time * 1000;
    R.o[i] = b.open;
    R.h[i] = b.high;
    R.l[i] = b.low;
    R.c[i] = b.close;
    R.vol[i] = b.volume;
    R.conf[i] = b.confirmed ? 1 : 0;
    if (b.confirmed) R.lastConfirmed = i;
  }
  R.tf = opts.secFor ? opts.secFor.tf : pineTf(periodOf(data.sec, 6)) ?? { period: periodOf(data.sec, R.version), sec: data.sec, okx: null };
  R.tf = { ...R.tf, period: periodOf(R.tf.sec, R.version) };
  R.sym = symInfo(data.instId, data.mintick);
  R.now = data.now ?? Date.now();
  R.decl = defaultDecl();
  R.declSeen = false;
  R.inputs = [];
  R.inputKeys = new Set();
  R.inputVals = opts.inputs ?? {};
  R.out = new Outputs(n);
  R.strat = null;
  R.sec = opts.sec ?? new Map();
  R.secFor = opts.secFor ?? null;
  R.secOut = new Map();
  R.needs = new Set();
  R.occ = new Map();
  R.warnings = new Set();
  R.logs = [];
  R.rng = 1;
  R.cache = new Map();
  R.enums = new Map();
  R.loops = 0;
  R.line = 0;
  R.jump = 0;
  R.deadline = Date.now() + (opts.timeLimit ?? 8000);
}

/** Heikin-Ashi bars made from plain ones. */
export function heikinAshi(bars: readonly Bar[]): Bar[] {
  const out: Bar[] = [];
  let po = NaN;
  let pc = NaN;
  for (const b of bars) {
    const c = (b.open + b.high + b.low + b.close) / 4;
    const o = po === po ? (po + pc) / 2 : (b.open + b.close) / 2;
    out.push({ time: b.time, open: o, high: Math.max(b.high, o, c), low: Math.min(b.low, o, c), close: c, volume: b.volume, confirmed: b.confirmed });
    po = o;
    pc = c;
  }
  return out;
}

/** Compile a parsed script. Throws PineSyntaxError (with a line) for what can't run. */
export function compile(script: Script): Program {
  return new Compiler(script).compile();
}

export type { SecRequest } from "./runtime.ts";
