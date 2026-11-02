import type { IChartApi, Logical } from "lightweight-charts";

/** x of a logical (bar) index. The library converts whole indices only, so fractions are interpolated. */
export function xOfLogical(chart: IChartApi, i: number): number | null {
  if (!Number.isFinite(i)) return null;
  const ts = chart.timeScale();
  const lo = Math.floor(i);
  const x0 = ts.logicalToCoordinate(lo as Logical);
  if (x0 == null || i === lo) return x0;
  const x1 = ts.logicalToCoordinate((lo + 1) as Logical);
  return x1 == null ? x0 : x0 + (x1 - x0) * (i - lo);
}
