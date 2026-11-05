// FVG, order blocks and support / resistance: sets with their own timeframe, colors and counts.
// Each change is applied and saved at once through the callbacks; nothing waits for an OK button.

import {
  clone,
  DEFAULT_FVG,
  DEFAULT_OB,
  DEFAULT_SR,
  MAX_ZONE_SETS,
  newId,
  ZONE_LIMITS,
  type FvgConf,
  type ObConf,
  type SrConf,
} from "../../settings/model.ts";
import { checkbox, colorInput, el, labelled, lbl, numInput, textButton } from "../dom.ts";
import { togglePopover } from "../popover.ts";
import { tfSelect } from "./controls.ts";

/** A timeframe for a new set that the existing sets don't use yet. */
function freeTf(used: string[]): string {
  return ["", "1H", "4H", "1Dutc", "15m", "1Wutc", "5m", "1m"].find((t) => !used.includes(t)) ?? "";
}

/** Shared parts of the FVG and order-block panels: one card per set, add, reset. */
function zoneSetsPanel<T extends FvgConf | ObConf | SrConf>(
  anchor: HTMLElement,
  title: string,
  intro: string,
  sets: { get: () => T[]; set: (v: T[]) => void },
  def: T,
  chartBar: () => string,
  extra: (c: T, patch: (p: Partial<T>) => void) => HTMLElement[],
  endedText: string,
  colorNames: [string, string] = ["多", "空"],
) {
  const patch = (id: string, p: Partial<T>) => sets.set(sets.get().map((x) => (x.id === id ? { ...x, ...p } : x)));
  togglePopover(anchor, "below", title, (body, rerender) => {
    body.append(el("div", "pop-note", intro));
    const list = sets.get();
    if (!list.length) body.append(el("div", "pop-note", "目前沒有設定，按「新增一組」加一組"));
    for (const c of list) {
      const p = (x: Partial<T>) => patch(c.id, x);
      const card = el("div", "pop-card");
      const r1 = el("div", "pop-row");
      r1.append(
        checkbox(c.on, "顯示／隱藏這一組", (v) => p({ on: v } as Partial<T>)),
        lbl("週期"),
        tfSelect(c.tf, chartBar(), (v) => p({ tf: v } as Partial<T>)),
        lbl(colorNames[0]),
        colorInput(c.up, (v) => p({ up: v } as Partial<T>), `${colorNames[0]}的顏色`),
        lbl(colorNames[1]),
        colorInput(c.down, (v) => p({ down: v } as Partial<T>), `${colorNames[1]}的顏色`),
        textButton("×", "pop-del", () => {
          sets.set(sets.get().filter((x) => x.id !== c.id));
          rerender();
        }, "刪除這一組"),
      );
      const r2 = el("div", "pop-row");
      r2.append(...extra(c, p));
      const r3 = el("div", "pop-row");
      r3.append(
        lbl("每個方向最多顯示"),
        numInput(c.maxCount, ZONE_LIMITS.maxCount, { title: "只畫最新的幾個（多、空各算）", width: 52 }, (v) => p({ maxCount: v } as Partial<T>)),
        lbl("個"),
        labelled(checkbox(c.showEnded, "", (v) => p({ showEnded: v } as Partial<T>)), endedText),
      );
      card.append(r1, r2, r3);
      body.append(card);
    }
    const foot = el("div", "pop-foot");
    const add = textButton("＋ 新增一組", "text-btn", () => {
      const cur = sets.get();
      sets.set([...cur, { ...clone(def), id: newId(def.id.split("-")[0]), tf: freeTf(cur.map((x) => x.tf)) }]);
      rerender();
    }, "例如圖表週期一組、4 小時一組");
    add.disabled = list.length >= MAX_ZONE_SETS;
    if (add.disabled) add.title = `最多 ${MAX_ZONE_SETS} 組`;
    foot.append(add, el("span", "spacer"), textButton("恢復預設", "link-btn", () => {
      sets.set([clone(def)]);
      rerender();
    }));
    body.append(foot);
  });
}

export function toggleFvgPanel(anchor: HTMLElement, sets: { get: () => FvgConf[]; set: (v: FvgConf[]) => void }, chartBar: () => string) {
  zoneSetsPanel(
    anchor,
    "FVG",
    "三根 K 線中，第一根和第三根沒有重疊的空白。第三根收完才畫。之後價格穿過整個缺口就算回補，框停在那根。",
    sets,
    DEFAULT_FVG,
    chartBar,
    (c, p) => {
      const kind = el("select");
      kind.title = "影線：看最高、最低價。實體：看開盤和收盤（影線可以重疊）";
      kind.append(new Option("影線不重疊", "wick", false, !c.body), new Option("實體不重疊", "body", false, c.body));
      kind.onchange = () => p({ body: kind.value === "body" });
      return [
        lbl("缺口"),
        kind,
        lbl("最小"),
        numInput(c.minPct, ZONE_LIMITS.minPct, { title: "比這個小的缺口不畫（價格的 %，0 = 全部畫）", width: 64, step: "0.01", int: false }, (v) => p({ minPct: v })),
        lbl("%"),
      ];
    },
    "也顯示已回補的",
  );
}

export function toggleObPanel(anchor: HTMLElement, sets: { get: () => ObConf[]; set: (v: ObConf[]) => void }, chartBar: () => string) {
  zoneSetsPanel(
    anchor,
    "Order Block",
    "收盤突破最近一個還沒被突破的波段高低點時，往前找最後一根反向 K，框住它的高低點。之後收盤穿過這個框就算失效。",
    sets,
    DEFAULT_OB,
    chartBar,
    (c, p) => [
      lbl("波段左右各"),
      numInput(c.swing, ZONE_LIMITS.swing, { title: "波段高點：比左右各這麼多根都高（低點鏡像）", width: 52 }, (v) => p({ swing: v })),
      lbl("根，往前找"),
      numInput(c.lookback, ZONE_LIMITS.lookback, { title: "從突破那根往前找幾根", width: 52 }, (v) => p({ lookback: v })),
      lbl("根"),
    ],
    "也顯示已失效的",
  );
}

export function toggleSrPanel(anchor: HTMLElement, sets: { get: () => SrConf[]; set: (v: SrConf[]) => void }, chartBar: () => string) {
  zoneSetsPanel(
    anchor,
    "支撐阻力",
    "波段高點畫成阻力線，波段低點畫成支撐線。收盤站上阻力或跌破支撐，就算失效。",
    sets,
    DEFAULT_SR,
    chartBar,
    (c, p) => [
      lbl("波段左右各"),
      numInput(c.swing, ZONE_LIMITS.srSwing, { title: "波段高點：比左右各這麼多根都高，低點相反。數字越大，線越少、越重要", width: 52 }, (v) => p({ swing: v })),
      lbl("根"),
    ],
    "也顯示已突破的",
    ["撐", "阻"],
  );
}
