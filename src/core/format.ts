// Numbers and times as the app shows them. Pure (no DOM).

import type { Time, UTCTimestamp } from "lightweight-charts";

export const pad = (n: number) => String(n).padStart(2, "0");

/** The chart library works in UTC: bar times are shifted by the local offset so the axis shows local time. */
export const TZ_SEC = -new Date().getTimezoneOffset() * 60;
export const toChartTime = (t: number) => (t + TZ_SEC) as UTCTimestamp;
export const fromChartTime = (t: Time) => (t as number) - TZ_SEC;

/** 78123.4 with 1 decimal → "78,123.4". */
export function fmtFixed(v: number, decimals: number): string {
  return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** 1234567 → "1.23M". */
export function fmtVol(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(2) + "K";
  return v.toFixed(a >= 100 ? 0 : 2);
}

/** UTC seconds as local "11/02 16:23". */
export function fmtClock(t: number): string {
  const d = new Date(t * 1000);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A chart time (already shifted to local) as "2026-11-02 16:15", or just the day for daily and weekly bars. */
export function fmtChartTime(t: Time, daily: boolean): string {
  const d = new Date((t as number) * 1000); // shifted: read with the UTC getters
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return daily ? day : `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Time-axis tick labels: year, "11月", "11/2", "16:15". `kind` is lightweight-charts' TickMarkType (0 year,
 *  1 month, 2 day of month, 3 time, 4 time with seconds). */
export function fmtTick(t: Time, kind: number): string {
  const d = new Date((t as number) * 1000);
  if (kind === 0) return String(d.getUTCFullYear());
  if (kind === 1) return `${d.getUTCMonth() + 1}月`;
  if (kind === 2) return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
