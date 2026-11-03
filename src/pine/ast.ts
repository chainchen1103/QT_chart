// The parsed script. Every node knows its line (for error messages) and has an id unique in the script
// (the interpreter keys the state of each call by it).

export type TypeRef = {
  /** float, int, bool, string, color, line, label, box, table, linefill, polyline, chart.point, array, matrix,
   *  map, or a user type / enum name. */
  name: string;
  /** array<float> → [float]; map<string, float> → [string, float]. `float[]` becomes array<float>. */
  args: TypeRef[];
};

type Base = { id: number; line: number; col: number };

export type Arg = { name: string | null; value: Expr };

export type Expr =
  | (Base & { k: "num"; v: number; int: boolean })
  | (Base & { k: "str"; v: string })
  | (Base & { k: "bool"; v: boolean })
  | (Base & { k: "color"; v: string })
  | (Base & { k: "id"; name: string })
  | (Base & { k: "member"; obj: Expr; name: string })
  | (Base & { k: "call"; callee: Expr; args: Arg[]; targs: TypeRef[] })
  | (Base & { k: "hist"; obj: Expr; index: Expr })
  | (Base & { k: "unary"; op: "-" | "+" | "not"; e: Expr })
  | (Base & { k: "bin"; op: string; l: Expr; r: Expr })
  | (Base & { k: "ternary"; c: Expr; a: Expr; b: Expr })
  | (Base & { k: "tuple"; items: Expr[] })
  | IfExpr
  | (Base & { k: "switch"; subject: Expr | null; cases: { cond: Expr | null; body: Block }[] })
  | (Base & { k: "for"; name: string; from: Expr; to: Expr; by: Expr | null; body: Block })
  | (Base & { k: "forin"; index: string | null; name: string; iter: Expr; body: Block })
  | (Base & { k: "while"; cond: Expr; body: Block });

export type IfExpr = Base & { k: "if"; cond: Expr; then: Block; else: Block | null };

export type Param = { name: string; type: TypeRef | null; def: Expr | null };

export type Stmt =
  | (Base & { k: "decl"; name: string; mode: "" | "var" | "varip"; type: TypeRef | null; init: Expr })
  | (Base & { k: "tupledecl"; names: string[]; init: Expr })
  | (Base & { k: "assign"; target: Expr; op: string; value: Expr })
  | (Base & { k: "fn"; name: string; params: Param[]; body: Block; method: boolean })
  | (Base & { k: "type"; name: string; fields: { name: string; type: TypeRef; def: Expr | null }[] })
  | (Base & { k: "enum"; name: string; fields: { name: string; title: string }[] })
  | (Base & { k: "break" })
  | (Base & { k: "continue" })
  | (Base & { k: "expr"; e: Expr });

export type Block = { body: Stmt[]; line: number };

export type Script = { body: Stmt[]; version: number; nodes: number };
