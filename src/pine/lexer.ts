// Pine Script tokens. Lines start blocks by their indentation (4 spaces or a tab per level); a line indented
// by something else continues the line before it, and so does any line inside ( ) or [ ], or after a line
// that ends with an operator. The version comes from the `//@version=` line.

export type TokKind = "num" | "str" | "color" | "id" | "op" | "nl" | "indent" | "dedent" | "eof";

export type Tok = {
  k: TokKind;
  /** The text (identifier, operator, string contents). */
  s: string;
  /** Numbers and colors. */
  n: number;
  /** A number written without a decimal point or exponent. */
  int: boolean;
  line: number;
  col: number;
};

export class PineSyntaxError extends Error {
  readonly line: number;
  readonly col: number;
  constructor(msg: string, line: number, col: number) {
    super(msg);
    this.line = line;
    this.col = col;
  }
}

/** Reserved words: never names. (`type`, `method`, `enum`, `to`, `by`, `in` and the qualifiers depend on
 *  where they stand, so they stay names here and the parser looks at them.) */
export const KEYWORDS = new Set([
  "and", "or", "not", "if", "else", "for", "while", "switch", "var", "varip", "import", "export",
  "true", "false", "break", "continue",
]);

const OPS2 = [":=", "+=", "-=", "*=", "/=", "%=", "==", "!=", "<=", ">=", "=>"];
const OPS1 = "+-*/%<>=?:,()[].";
/** A line ending in one of these goes on in the next line. (`=>` starts a block instead.) */
const CONTINUES = new Set(["+", "-", "*", "/", "%", "<", ">", "<=", ">=", "==", "!=", "?", ":", ",", "=", ":=", "+=", "-=", "*=", "/=", "%="]);
/** A line starting with one of these goes on from the line before it. */
const LEADS = new Set(["?", ":", "*", "/", "%", "==", "!=", "<=", ">=", "."]);

const tok = (k: TokKind, s: string, line: number, col: number, n = 0, int = false): Tok => ({ k, s, n, int, line, col });

export type Lexed = { toks: Tok[]; version: number };

export function lex(src: string): Lexed {
  // pasted from web pages: non-breaking and zero-width spaces count as plain spaces / nothing
  const lines = src.replace(/\r\n?/g, "\n").replace(/[\u00a0\u2007\u202f\u3000]/g, " ").replace(/[\u200b\u200c\u200d\ufeff]/g, "").split("\n");
  const toks: Tok[] = [];
  const stack = [0];
  let depth = 0; // open ( and [
  let version = 5;
  let started = false; // a statement has been emitted (so a newline separates the next one)

  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln];
    const lineNo = ln + 1;
    const ver = /^\s*\/\/\s*@version\s*=\s*(\d+)/.exec(raw);
    if (ver) version = Number(ver[1]);
    // indentation
    let width = 0;
    let p = 0;
    for (; p < raw.length; p++) {
      const ch = raw[p];
      if (ch === " ") width++;
      else if (ch === "\t") width += 4;
      else break;
    }
    const lineToks = scanLine(raw, p, lineNo);
    if (!lineToks.length) continue; // blank or comment only

    const prev = toks[toks.length - 1];
    const first = lineToks[0];
    const prevOpen = !!prev && ((prev.k === "op" && CONTINUES.has(prev.s)) || (prev.k === "id" && (prev.s === "and" || prev.s === "or" || prev.s === "not")));
    const leads = (first.k === "op" && LEADS.has(first.s)) || (first.k === "id" && (first.s === "and" || first.s === "or"));
    const cont = depth > 0 || (started && (width % 4 !== 0 || prevOpen || leads));
    if (!cont) {
      if (started) toks.push(tok("nl", "", prev ? prev.line : lineNo, prev ? prev.col + Math.max(1, prev.s.length) : 0));
      const level = width;
      if (level > stack[stack.length - 1]) {
        stack.push(level);
        toks.push(tok("indent", "", lineNo, 0));
      } else {
        while (level < stack[stack.length - 1]) {
          stack.pop();
          toks.push(tok("dedent", "", lineNo, 0));
        }
        if (level !== stack[stack.length - 1]) throw new PineSyntaxError("縮排和上面的區塊對不起來", lineNo, 1);
      }
    }
    for (const t of lineToks) {
      if (t.k === "op") {
        if (t.s === "(" || t.s === "[") depth++;
        else if ((t.s === ")" || t.s === "]") && depth > 0) depth--;
      }
      toks.push(t);
    }
    started = true;
  }
  if (started) toks.push(tok("nl", "", lines.length, 0));
  while (stack.length > 1) {
    stack.pop();
    toks.push(tok("dedent", "", lines.length, 0));
  }
  toks.push(tok("eof", "", lines.length + 1, 0));
  return { toks, version };
}

const isIdStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isDigit = (c: string) => c >= "0" && c <= "9";
const isHex = (c: string) => isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");

/** The tokens of one line from position `p` (comments dropped). */
function scanLine(s: string, p: number, line: number): Tok[] {
  const out: Tok[] = [];
  const n = s.length;
  while (p < n) {
    const c = s[p];
    const col = p + 1;
    if (c === " " || c === "\t") {
      p++;
      continue;
    }
    if (c === "/" && s[p + 1] === "/") break; // comment
    if (isIdStart(c)) {
      let q = p + 1;
      while (q < n && (isIdStart(s[q]) || isDigit(s[q]))) q++;
      out.push(tok("id", s.slice(p, q), line, col));
      p = q;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(s[p + 1] ?? ""))) {
      let q = p;
      let int = true;
      while (q < n && isDigit(s[q])) q++;
      if (s[q] === "." && !isIdStart(s[q + 1] ?? "")) {
        int = false;
        q++;
        while (q < n && isDigit(s[q])) q++;
      }
      if ((s[q] === "e" || s[q] === "E") && (isDigit(s[q + 1] ?? "") || ((s[q + 1] === "+" || s[q + 1] === "-") && isDigit(s[q + 2] ?? "")))) {
        int = false;
        q += 2;
        while (q < n && isDigit(s[q])) q++;
      }
      const text = s.slice(p, q);
      out.push(tok("num", text, line, col, Number(text), int));
      p = q;
      continue;
    }
    if (c === '"' || c === "'") {
      let q = p + 1;
      let text = "";
      while (q < n && s[q] !== c) {
        if (s[q] === "\\" && q + 1 < n) {
          const e = s[q + 1];
          text += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e;
          q += 2;
          continue;
        }
        text += s[q++];
      }
      if (q >= n) throw new PineSyntaxError("字串沒有結束的引號", line, col);
      out.push(tok("str", text, line, col));
      p = q + 1;
      continue;
    }
    if (c === "#") {
      let q = p + 1;
      while (q < n && isHex(s[q])) q++;
      const hex = s.slice(p + 1, q);
      if (hex.length !== 6 && hex.length !== 8) throw new PineSyntaxError(`顏色要寫成 #RRGGBB 或 #RRGGBBAA：${s.slice(p, q)}`, line, col);
      out.push(tok("color", "#" + hex, line, col));
      p = q;
      continue;
    }
    const two = s.slice(p, p + 2);
    if (OPS2.includes(two)) {
      out.push(tok("op", two, line, col));
      p += 2;
      continue;
    }
    if (OPS1.includes(c)) {
      out.push(tok("op", c, line, col));
      p++;
      continue;
    }
    throw new PineSyntaxError(`看不懂的字元「${c}」`, line, col);
  }
  return out;
}
