import type { Runtime } from "../runtime.ts";

/** A built-in function. `p`: its parameters in order ("..." at the end takes any number more). `st` makes the
 *  state of one call site (functions that remember earlier bars); `f` gets the arguments in parameter order
 *  (undefined when not given). */
export type Builtin = {
  p: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  f?: (R: Runtime, a: any[], st: any) => unknown;
  st?: (R: Runtime, id: number) => unknown;
  /** Functions with several forms (line.new(x1, y1, …) or line.new(point, point, …)): get the positional and
   *  the named arguments apart, and read them themselves. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  n?: (R: Runtime, pos: any[], named: Record<string, any>, st: any) => unknown;
};
export type Lib = Record<string, Builtin>;

/** A length or count argument: whole number (Pine truncates), NaN when missing. */
export const toInt = (x: unknown): number => (typeof x === "number" ? Math.trunc(x) : typeof x === "boolean" ? Number(x) : NaN);
export const num = (x: unknown, d = NaN): number => (typeof x === "number" ? x : typeof x === "boolean" ? Number(x) : d);
