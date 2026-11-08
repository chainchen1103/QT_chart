// Alerts on Pine scripts: the plots of a script an alert can watch, and the script run for an alert away from
// the chart, on the bars the alert keeps (with the other timeframes request.security() asks for). Pure (no DOM).

import type { IndLine } from "../indicators/specs.ts";
import type { Num } from "../indicators/osc.ts";
import { loadCached, runWithSecurity, type Bar, type SecRequest } from "../pine/index.ts";
import { DISPLAY, type PlotOut } from "../pine/outputs.ts";

/** The plots an alert can watch: the ones the script draws, each by its title when no other plot has it (that
 *  stays when the script is edited), else by its place in the script. */
export function pineLines(plots: readonly PlotOut[]): (IndLine & { plot: PlotOut })[] {
  const shown = plots.filter((p) => p.display & DISPLAY.pane);
  const count = new Map<string, number>();
  for (const p of shown) if (p.title) count.set(p.title, (count.get(p.title) ?? 0) + 1);
  return shown.map((p, i) => {
    const unique = !!p.title && p.title.length <= 120 && count.get(p.title) === 1;
    return { key: unique ? p.title : `#${p.key}`, name: unique ? p.title : `${p.title || "線"} ${i + 1}`, plot: p };
  });
}

export type PineRun = {
  /** Each line's values, one per bar (null where it has none). */
  lines: Record<string, Num[]>;
  /** request.security() asked for bars still on the way: its values can't be trusted yet. */
  missing: boolean;
  /** Every request.security() it asked for so far (their bars are kept). */
  needs: SecRequest[];
};

export type PineData = { bars: readonly Bar[]; sec: number; instId: string; mintick: number; now: number };

/**
 * A script run for an alert on `data.bars` (the last one still forming), with its inputs as set now. `other`
 * gives another timeframe's bars (null while they load); `known` are the requests it made before. Null when
 * it doesn't compile or stops with an error.
 */
export function runForAlert(
  script: { source: string; inputs: Record<string, unknown> },
  data: PineData,
  other: (req: SecRequest) => readonly Bar[] | null,
  known: readonly SecRequest[],
): PineRun | null {
  const l = loadCached(script.source);
  if (!l.ok) return null;
  const fetch = (req: SecRequest) => (req.tf.sec === data.sec ? data.bars : req.tf.okx ? other(req) : []);
  const { result, missing } = runWithSecurity(l.program, data, { inputs: script.inputs, timeLimit: 2000 }, fetch, [...known]);
  if (!result.ok) return null;
  const lines: Record<string, Num[]> = {};
  for (const x of pineLines(result.out.plots)) lines[x.key] = Array.from(x.plot.values, (v) => (v === v ? v : null));
  const needs = [...known];
  for (const n of [...result.needs, ...missing]) if (!needs.some((k) => k.key === n.key)) needs.push(n);
  return { lines, missing: missing.length > 0, needs };
}
