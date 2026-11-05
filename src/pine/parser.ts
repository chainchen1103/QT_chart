// Pine Script → syntax tree (ast.ts). Statements end at a newline (or a `,` that starts another one); blocks are
// indented lines after `if`, `for`, `while`, `switch`, `=>`, `type` and `enum`.

import type { Arg, Block, Expr, IfExpr, Param, Script, Stmt, TypeRef } from "./ast.ts";
import { lex, PineSyntaxError, type Tok } from "./lexer.ts";

export { PineSyntaxError } from "./lexer.ts";

const ASSIGN_OPS = new Set([":=", "+=", "-=", "*=", "/=", "%="]);
const QUALIFIERS = new Set(["const", "simple", "series"]);

export function parse(src: string): Script {
  const { toks, version } = lex(src);
  const p = new Parser(toks);
  const body = p.statements(true);
  return { body, version, nodes: p.nextId };
}

class Parser {
  private pos = 0;
  nextId = 1;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  // ------------------------------------------------------------------- tokens
  private peek(o = 0): Tok {
    return this.toks[Math.min(this.pos + o, this.toks.length - 1)];
  }
  private next(): Tok {
    return this.toks[this.pos++] ?? this.toks[this.toks.length - 1];
  }
  private isOp(s: string, o = 0) {
    const t = this.peek(o);
    return t.k === "op" && t.s === s;
  }
  private isId(s: string, o = 0) {
    const t = this.peek(o);
    return t.k === "id" && t.s === s;
  }
  private err(msg: string, t: Tok = this.peek()): never {
    throw new PineSyntaxError(msg, t.line, t.col || 1);
  }
  private expectOp(s: string): Tok {
    if (!this.isOp(s)) this.err(`這裡應該是「${s}」${this.near()}`);
    return this.next();
  }
  private near(): string {
    const t = this.peek();
    if (t.k === "nl") return "，卻換行了";
    if (t.k === "eof") return "，卻已經到結尾";
    if (t.k === "indent" || t.k === "dedent") return "（縮排不對）";
    return `，卻是「${t.k === "str" ? '"' + t.s + '"' : t.s}」`;
  }
  /** The last token closed a block (an if / switch / for / while value): nothing more belongs to it. */
  private ended(): boolean {
    const prev = this.toks[this.pos - 1];
    return !!prev && prev.k === "dedent";
  }
  private name(): string {
    const t = this.peek();
    if (t.k !== "id") this.err(`這裡應該是名稱${this.near()}`);
    this.pos++;
    return t.s;
  }
  private base(t: Tok) {
    return { id: this.nextId++, line: t.line, col: t.col };
  }

  // ------------------------------------------------------------------- statements
  /** Statements until the end of the block (a dedent) or of the script. */
  statements(top: boolean): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      const t = this.peek();
      if (t.k === "nl") {
        this.pos++;
        continue;
      }
      if (t.k === "eof") break;
      if (t.k === "dedent") {
        if (top) this.err("縮排不對");
        break;
      }
      if (t.k === "indent") this.err("這行縮排太多了");
      out.push(...this.statementLine());
    }
    return out;
  }

  /** One line of statements (several when separated by commas). */
  private statementLine(): Stmt[] {
    const out = [this.statement()];
    for (;;) {
      const prev = this.toks[this.pos - 1];
      if (prev && prev.k === "dedent") return out; // a block ended the statement
      if (this.isOp(",")) {
        this.pos++;
        out.push(this.statement());
        continue;
      }
      const t = this.peek();
      if (t.k === "nl") {
        this.pos++;
        return out;
      }
      if (t.k === "eof" || t.k === "dedent") return out;
      this.err(`這行應該到這裡就結束${this.near()}`);
    }
  }

  /** An indented block after a header line (the newline is next). */
  private block(): Block {
    const t = this.peek();
    if (t.k !== "nl") this.err(`這行之後應該換行並縮排${this.near()}`);
    this.pos++;
    if (this.peek().k !== "indent") this.err("下一行應該縮排（4 個空格或一個 Tab）", this.peek());
    this.pos++;
    const body = this.statements(false);
    if (this.peek().k === "dedent") this.pos++;
    return { body, line: t.line };
  }

  /** `=> …`: one line, or an indented block. */
  private arrowBody(): Block {
    const t = this.peek();
    if (t.k === "nl") return this.block();
    const s = this.statement();
    return { body: [s], line: t.line };
  }

  private statement(): Stmt {
    const t = this.peek();
    if (t.k === "id") {
      switch (t.s) {
        case "var":
        case "varip":
          return this.decl();
        case "break":
          this.pos++;
          return { k: "break", ...this.base(t) };
        case "continue":
          this.pos++;
          return { k: "continue", ...this.base(t) };
        case "import":
          this.err("不支援 import（程式庫）：請把需要的函式直接貼進腳本");
          break;
        case "export":
          this.pos++;
          return this.statement();
        case "type":
          if (this.peek(1).k === "id" && this.peek(2).k === "nl") return this.typeDef();
          break;
        case "enum":
          if (this.peek(1).k === "id" && this.peek(2).k === "nl") return this.enumDef();
          break;
        case "method":
          if (this.peek(1).k === "id" && this.isOp("(", 2)) return this.fnDef(true);
          break;
      }
      const control = t.s === "if" || t.s === "for" || t.s === "while" || t.s === "switch";
      if (!control && this.isOp("(", 1) && this.isFnDef()) return this.fnDef(false);
      const typed = control ? null : this.typedDecl();
      if (typed) return typed;
      if (!control && this.isOp("=", 1)) return this.decl();
    }
    if (t.k === "op" && t.s === "[") {
      const tuple = this.tupleDecl();
      if (tuple) return tuple;
    }
    const e = this.expr();
    const op = this.peek();
    if (op.k === "op" && ASSIGN_OPS.has(op.s)) {
      if (e.k !== "id" && e.k !== "member") this.err("只能指定給變數或欄位", op);
      this.pos++;
      return { k: "assign", ...this.base(op), target: e, op: op.s, value: this.expr() };
    }
    if (op.k === "op" && op.s === "=") this.err("這個名稱已經用過，要改它的值請用 :=", op);
    return { k: "expr", ...this.base(t), e };
  }

  /** `name(` … `) =>` ahead? */
  private isFnDef(): boolean {
    let i = this.pos + 2;
    let depth = 1;
    for (; i < this.toks.length && depth > 0; i++) {
      const t = this.toks[i];
      if (t.k === "eof") return false;
      if (t.k === "op") {
        if (t.s === "(" || t.s === "[") depth++;
        else if (t.s === ")" || t.s === "]") depth--;
      }
    }
    const t = this.toks[i];
    return !!t && t.k === "op" && t.s === "=>";
  }

  private fnDef(method: boolean): Stmt {
    const start = this.peek();
    if (method) this.pos++;
    const name = this.name();
    this.expectOp("(");
    const params: Param[] = [];
    while (!this.isOp(")")) {
      while (this.peek().k === "id" && QUALIFIERS.has(this.peek().s) && this.peek(1).k === "id") this.pos++;
      let type: TypeRef | null = null;
      // `float x`, `array<float> a`, `int[] a`, `chart.point p`: a type, then the name
      if (this.peek().k === "id" && !(this.isOp(",", 1) || this.isOp(")", 1) || this.isOp("=", 1))) type = this.typeRef();
      const pname = this.name();
      let def: Expr | null = null;
      if (this.isOp("=")) {
        this.pos++;
        def = this.expr();
      }
      params.push({ name: pname, type, def });
      if (!this.isOp(",")) break;
      this.pos++;
    }
    this.expectOp(")");
    this.expectOp("=>");
    const body = this.arrowBody();
    return { k: "fn", ...this.base(start), name, params, body, method };
  }

  private typeDef(): Stmt {
    const start = this.next();
    const name = this.name();
    const fields: { name: string; type: TypeRef; def: Expr | null }[] = [];
    this.expectBlockStart();
    while (this.peek().k !== "dedent" && this.peek().k !== "eof") {
      if (this.peek().k === "nl") {
        this.pos++;
        continue;
      }
      if (this.isId("varip")) this.pos++;
      const type = this.typeRef();
      const fname = this.name();
      let def: Expr | null = null;
      if (this.isOp("=")) {
        this.pos++;
        def = this.expr();
      }
      fields.push({ name: fname, type, def });
      if (this.peek().k === "nl") this.pos++;
    }
    if (this.peek().k === "dedent") this.pos++;
    return { k: "type", ...this.base(start), name, fields };
  }

  private enumDef(): Stmt {
    const start = this.next();
    const name = this.name();
    const fields: { name: string; title: string }[] = [];
    this.expectBlockStart();
    while (this.peek().k !== "dedent" && this.peek().k !== "eof") {
      if (this.peek().k === "nl") {
        this.pos++;
        continue;
      }
      const fname = this.name();
      let title = fname;
      if (this.isOp("=")) {
        this.pos++;
        const s = this.next();
        if (s.k !== "str") this.err("enum 的名稱要是字串", s);
        title = s.s;
      }
      fields.push({ name: fname, title });
      if (this.peek().k === "nl") this.pos++;
    }
    if (this.peek().k === "dedent") this.pos++;
    return { k: "enum", ...this.base(start), name, fields };
  }

  private expectBlockStart() {
    if (this.peek().k !== "nl") this.err(`這行之後應該換行並縮排${this.near()}`);
    this.pos++;
    if (this.peek().k !== "indent") this.err("下一行應該縮排", this.peek());
    this.pos++;
  }

  /** `float x = …`, `var line l = na`, `array<int> a = …`: a declaration with a type, or null (nothing read). */
  private typedDecl(): Stmt | null {
    const save = this.pos;
    try {
      while (this.peek().k === "id" && QUALIFIERS.has(this.peek().s) && this.peek(1).k === "id") this.pos++;
      if (this.peek().k !== "id") return this.restore(save);
      const type = this.typeRef();
      if (this.peek().k !== "id" || !this.isOp("=", 1)) return this.restore(save);
      const start = this.toks[save];
      const name = this.name();
      this.pos++; // =
      return { k: "decl", ...this.base(start), name, mode: "", type, init: this.expr() };
    } catch {
      return this.restore(save);
    }
  }
  private restore(save: number): null {
    this.pos = save;
    return null;
  }

  /** `var`/`varip` [qualifier] [type] name = value, or name = value. */
  private decl(): Stmt {
    const start = this.peek();
    let mode: "" | "var" | "varip" = "";
    if (this.isId("var") || this.isId("varip")) mode = this.next().s as "var" | "varip";
    while (this.peek().k === "id" && QUALIFIERS.has(this.peek().s) && this.peek(1).k === "id") this.pos++;
    let type: TypeRef | null = null;
    if (!(this.peek().k === "id" && this.isOp("=", 1))) type = this.typeRef();
    const name = this.name();
    this.expectOp("=");
    return { k: "decl", ...this.base(start), name, mode, type, init: this.expr() };
  }

  /** `[a, b] = …`, or null when the line is something else. */
  private tupleDecl(): Stmt | null {
    const save = this.pos;
    const start = this.next();
    const names: string[] = [];
    while (this.peek().k === "id") {
      names.push(this.next().s);
      if (this.isOp(",")) this.pos++;
      else break;
    }
    if (!names.length || !this.isOp("]") || !this.isOp("=", 1)) return this.restore(save);
    this.pos += 2;
    return { k: "tupledecl", ...this.base(start), names, init: this.expr() };
  }

  /** float, chart.point, array<float>, map<string, int>, int[], MyType. */
  private typeRef(): TypeRef {
    let name = this.name();
    while (this.isOp(".") && this.peek(1).k === "id") {
      this.pos++;
      name += "." + this.next().s;
    }
    const args: TypeRef[] = [];
    if (this.isOp("<")) {
      this.pos++;
      for (;;) {
        args.push(this.typeRef());
        if (this.isOp(",")) {
          this.pos++;
          continue;
        }
        break;
      }
      this.expectOp(">");
    }
    let t: TypeRef = { name, args };
    while (this.isOp("[") && this.isOp("]", 1)) {
      this.pos += 2;
      t = { name: "array", args: [t] };
    }
    return t;
  }

  // ------------------------------------------------------------------- expressions
  expr(): Expr {
    const c = this.or();
    if (this.ended() || !this.isOp("?")) return c;
    const t = this.next();
    const a = this.expr();
    this.expectOp(":");
    const b = this.expr();
    return { k: "ternary", ...this.base(t), c, a, b };
  }

  private or(): Expr {
    let l = this.and();
    while (!this.ended() && this.isId("or")) {
      const t = this.next();
      l = { k: "bin", ...this.base(t), op: "or", l, r: this.and() };
    }
    return l;
  }
  private and(): Expr {
    let l = this.equality();
    while (!this.ended() && this.isId("and")) {
      const t = this.next();
      l = { k: "bin", ...this.base(t), op: "and", l, r: this.equality() };
    }
    return l;
  }
  private equality(): Expr {
    let l = this.comparison();
    while (!this.ended() && (this.isOp("==") || this.isOp("!="))) {
      const t = this.next();
      l = { k: "bin", ...this.base(t), op: t.s, l, r: this.comparison() };
    }
    return l;
  }
  private comparison(): Expr {
    let l = this.additive();
    while (!this.ended() && (this.isOp("<") || this.isOp(">") || this.isOp("<=") || this.isOp(">="))) {
      const t = this.next();
      l = { k: "bin", ...this.base(t), op: t.s, l, r: this.additive() };
    }
    return l;
  }
  private additive(): Expr {
    let l = this.multiplicative();
    while (!this.ended() && (this.isOp("+") || this.isOp("-"))) {
      const t = this.next();
      l = { k: "bin", ...this.base(t), op: t.s, l, r: this.multiplicative() };
    }
    return l;
  }
  private multiplicative(): Expr {
    let l = this.unary();
    while (!this.ended() && (this.isOp("*") || this.isOp("/") || this.isOp("%"))) {
      const t = this.next();
      l = { k: "bin", ...this.base(t), op: t.s, l, r: this.unary() };
    }
    return l;
  }
  private unary(): Expr {
    const t = this.peek();
    if ((t.k === "op" && (t.s === "-" || t.s === "+")) || (t.k === "id" && t.s === "not")) {
      this.pos++;
      const e = this.unary();
      if (t.s === "-" && e.k === "num") return { ...e, v: -e.v };
      return { k: "unary", ...this.base(t), op: t.s as "-" | "+" | "not", e };
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.ended()) break;
      const t = this.peek();
      if (t.k !== "op") break;
      if (t.s === ".") {
        this.pos++;
        const name = this.name();
        e = { k: "member", ...this.base(t), obj: e, name };
        continue;
      }
      if (t.s === "(") {
        e = this.call(e, []);
        continue;
      }
      if (t.s === "[") {
        this.pos++;
        const index = this.expr();
        this.expectOp("]");
        e = { k: "hist", ...this.base(t), obj: e, index };
        continue;
      }
      if (t.s === "<" && (e.k === "id" || e.k === "member")) {
        // array.new<float>(…), map.new<string, float>()
        const save = this.pos;
        try {
          this.pos++;
          const targs: TypeRef[] = [];
          for (;;) {
            targs.push(this.typeRef());
            if (this.isOp(",")) {
              this.pos++;
              continue;
            }
            break;
          }
          if (this.isOp(">") && this.isOp("(", 1)) {
            this.pos++;
            e = this.call(e, targs);
            continue;
          }
        } catch {
          /* not a type list: a comparison */
        }
        this.pos = save;
      }
      break;
    }
    return e;
  }

  private call(callee: Expr, targs: TypeRef[]): Expr {
    const t = this.expectOp("(");
    const args: Arg[] = [];
    while (!this.isOp(")")) {
      let name: string | null = null;
      if (this.peek().k === "id" && this.isOp("=", 1)) {
        name = this.next().s;
        this.pos++;
      }
      args.push({ name, value: this.expr() });
      if (!this.isOp(",")) break;
      this.pos++;
    }
    this.expectOp(")");
    return { k: "call", ...this.base(t), callee, args, targs };
  }

  private primary(): Expr {
    const t = this.peek();
    switch (t.k) {
      case "num":
        this.pos++;
        return { k: "num", ...this.base(t), v: t.n, int: t.int };
      case "str":
        this.pos++;
        return { k: "str", ...this.base(t), v: t.s };
      case "color":
        this.pos++;
        return { k: "color", ...this.base(t), v: t.s };
      case "id":
        switch (t.s) {
          case "true":
          case "false":
            this.pos++;
            return { k: "bool", ...this.base(t), v: t.s === "true" };
          case "if":
            return this.ifExpr();
          case "switch":
            return this.switchExpr();
          case "for":
            return this.forExpr();
          case "while": {
            this.pos++;
            const cond = this.expr();
            return { k: "while", ...this.base(t), cond, body: this.block() };
          }
        }
        if (t.s === "and" || t.s === "or" || t.s === "else" || t.s === "var" || t.s === "varip") this.err(`這裡不能用「${t.s}」`);
        this.pos++;
        return { k: "id", ...this.base(t), name: t.s };
      case "op":
        if (t.s === "(") {
          this.pos++;
          const e = this.expr();
          this.expectOp(")");
          return e;
        }
        if (t.s === "[") {
          this.pos++;
          const items: Expr[] = [];
          while (!this.isOp("]")) {
            items.push(this.expr());
            if (!this.isOp(",")) break;
            this.pos++;
          }
          this.expectOp("]");
          return { k: "tuple", ...this.base(t), items };
        }
        break;
    }
    this.err(`這裡應該是一個值${this.near()}`);
  }

  private ifExpr(): IfExpr {
    const t = this.next();
    const cond = this.expr();
    const then = this.block();
    let els: Block | null = null;
    if (this.isId("else")) {
      const e = this.next();
      if (this.isId("if")) els = { body: [{ k: "expr", ...this.base(e), e: this.ifExpr() }], line: e.line };
      else els = this.block();
    }
    return { k: "if", ...this.base(t), cond, then, else: els };
  }

  private switchExpr(): Expr {
    const t = this.next();
    const subject = this.peek().k === "nl" ? null : this.expr();
    this.expectBlockStart();
    const cases: { cond: Expr | null; body: Block }[] = [];
    while (this.peek().k !== "dedent" && this.peek().k !== "eof") {
      if (this.peek().k === "nl") {
        this.pos++;
        continue;
      }
      let cond: Expr | null = null;
      if (!this.isOp("=>")) cond = this.expr();
      this.expectOp("=>");
      const body = this.arrowBody();
      cases.push({ cond, body });
      const prev = this.toks[this.pos - 1];
      if (prev.k !== "dedent" && this.peek().k === "nl") this.pos++;
    }
    if (this.peek().k === "dedent") this.pos++;
    return { k: "switch", ...this.base(t), subject, cases };
  }

  private forExpr(): Expr {
    const t = this.next();
    if (this.isOp("[")) {
      // for [i, x] in array
      this.pos++;
      const index = this.name();
      this.expectOp(",");
      const name = this.name();
      this.expectOp("]");
      if (!this.isId("in")) this.err("這裡應該是 in");
      this.pos++;
      const iter = this.expr();
      return { k: "forin", ...this.base(t), index, name, iter, body: this.block() };
    }
    const name = this.name();
    if (this.isId("in")) {
      this.pos++;
      const iter = this.expr();
      return { k: "forin", ...this.base(t), index: null, name, iter, body: this.block() };
    }
    this.expectOp("=");
    const from = this.expr();
    if (!this.isId("to")) this.err(`for 迴圈應該寫成 for i = 起點 to 終點${this.near()}`);
    this.pos++;
    const to = this.expr();
    let by: Expr | null = null;
    if (this.isId("by")) {
      this.pos++;
      by = this.expr();
    }
    return { k: "for", ...this.base(t), name, from, to, by, body: this.block() };
  }
}
