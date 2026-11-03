// Pine Script, as the rest of the app sees it: load a script (parse + compile, errors with their line), what
// it declares (title, indicator or strategy, on the chart or below it), and running it.

import type { Expr, Script } from "./ast.ts";
import { compile, heikinAshi, type Program, type RunData, type RunOpts, type RunResult, type SecRequest } from "./compile.ts";
import { PineSyntaxError } from "./lexer.ts";
import { parse } from "./parser.ts";
import type { Bar, SecRun } from "./runtime.ts";

export type { Program, RunData, RunOpts, RunResult, SecRequest, SecRun, Bar };
export { heikinAshi };

export type ScriptInfo = { title: string; kind: "indicator" | "strategy" | "library"; overlay: boolean; version: number };

export type Loaded = { ok: true; program: Program; info: ScriptInfo } | { ok: false; error: { line: number; col: number; message: string }; info: ScriptInfo | null };

/** Parse and compile; a mistake comes back with its line and column instead of throwing. */
export function load(source: string): Loaded {
  let script: Script;
  try {
    script = parse(source);
  } catch (e) {
    return { ok: false, error: errorOf(e), info: null };
  }
  const info = scriptInfo(script);
  try {
    return { ok: true, program: compile(script), info };
  } catch (e) {
    return { ok: false, error: errorOf(e), info };
  }
}

function errorOf(e: unknown): { line: number; col: number; message: string } {
  if (e instanceof PineSyntaxError) return { line: e.line, col: e.col, message: e.message };
  return { line: 0, col: 0, message: String((e as Error)?.message ?? e) };
}

/** The title, kind and overlay written in indicator() / strategy() (when they are plain values). */
export function scriptInfo(script: Script): ScriptInfo {
  const info: ScriptInfo = { title: "", kind: "indicator", overlay: false, version: script.version };
  for (const s of script.body) {
    if (s.k !== "expr" || s.e.k !== "call" || s.e.callee.k !== "id") continue;
    const name = s.e.callee.name;
    if (name !== "indicator" && name !== "strategy" && name !== "study" && name !== "library") continue;
    info.kind = name === "strategy" ? "strategy" : name === "library" ? "library" : "indicator";
    const args = s.e.args;
    const title = args.find((a) => a.name === "title") ?? args.find((a) => !a.name);
    if (title && title.value.k === "str") info.title = title.value.v;
    const short = args.find((a) => a.name === "shorttitle") ?? args.filter((a) => !a.name)[1];
    if (!info.title && short && short.value.k === "str") info.title = short.value.v;
    const ov = args.find((a) => a.name === "overlay") ?? args.filter((a) => !a.name)[2];
    if (ov) info.overlay = boolOf(ov.value);
    break;
  }
  return info;
}
const boolOf = (e: Expr) => e.k === "bool" && e.v;

/** The script's title as written, or "Pine 腳本". */
export function titleOf(source: string): string {
  try {
    return scriptInfo(parse(source)).title || "Pine 腳本";
  } catch {
    const m = /(?:indicator|strategy|study)\s*\(\s*(?:title\s*=\s*)?["']([^"']+)["']/.exec(source);
    return m ? m[1] : "Pine 腳本";
  }
}

/** Run a script on the chart's bars, with what request.security() needs computed first. `fetch` gives the bars
 *  of another timeframe when they are loaded (null: not yet). Returns the result and the timeframes still
 *  missing. */
export function runWithSecurity(
  program: Program,
  data: RunData,
  opts: RunOpts,
  fetch: (req: SecRequest) => readonly Bar[] | null,
  known: SecRequest[],
): { result: RunResult; missing: SecRequest[] } {
  const sec = new Map<string, SecRun>();
  const missing: SecRequest[] = [];
  const runFor = (reqs: SecRequest[]) => {
    for (const req of reqs) {
      if (sec.has(req.key)) continue;
      let bars = fetch(req);
      if (!bars) {
        if (!missing.some((m) => m.key === req.key)) missing.push(req);
        continue;
      }
      if (req.ha) bars = heikinAshi(bars);
      const r = program.run({ ...data, bars, sec: req.tf.sec }, { ...opts, secFor: req, sec: undefined });
      sec.set(req.key, { tf: req.tf, times: bars.map((b) => b.time * 1000), confirmed: bars.map((b) => b.confirmed), values: r.secOut });
    }
  };
  runFor(known);
  let result = program.run(data, { ...opts, sec });
  // requests found on this run that weren't known: compute them and run again (once)
  const fresh = result.needs.filter((n) => !sec.has(n.key) && !missing.some((m) => m.key === n.key));
  if (fresh.length) {
    runFor(fresh);
    if (fresh.some((n) => sec.has(n.key))) result = program.run(data, { ...opts, sec });
  }
  for (const n of result.needs) if (!sec.has(n.key) && !missing.some((m) => m.key === n.key)) missing.push(n);
  return { result, missing };
}
