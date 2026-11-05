// Shared controls of the settings windows.
// Each change is applied and saved at once through the callbacks; nothing waits for an OK button.

import { findTf, TIMEFRAMES, tfLabel, tfSec } from "../../core/timeframes.ts";
import { el } from "../dom.ts";

/** Which timeframe an indicator runs on: "" = the chart's. Orange when smaller than the chart's (not shown). */
export function tfSelect(value: string, chartBar: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = el("select");
  s.append(new Option("圖表週期", "", false, value === ""));
  // the named timeframes, and the one saved when the user had added it by count and unit
  const list = TIMEFRAMES.some((t) => t.bar === value) || !findTf(value) ? TIMEFRAMES : [...TIMEFRAMES, findTf(value)!];
  for (const t of list) s.append(new Option(t.label, t.bar, false, t.bar === value));
  const paint = () => {
    const low = !!s.value && tfSec(s.value) < tfSec(chartBar);
    s.classList.toggle("warn", low);
    s.title = low
      ? `比現在的圖表週期（${tfLabel(chartBar)}）小，先不顯示。切到 ${tfLabel(s.value)} 或更小的圖表週期才會出現`
      : "用哪個週期的 K 線計算，「圖表週期」會跟著圖表切換";
  };
  paint();
  s.onchange = () => {
    paint();
    onChange(s.value);
  };
  return s;
}
