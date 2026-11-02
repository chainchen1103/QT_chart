// Settings popovers: moving averages, FVG, order blocks, and Fibonacci levels with the magnet.
// Each change is applied and saved at once through the callbacks; nothing waits for an OK button.

import { parseLevel, parseR } from "./fibmath";
import {
  clone,
  DEFAULT_FIB,
  DEFAULT_FVG,
  DEFAULT_MAS,
  DEFAULT_OB,
  DEFAULT_SR,
  FIB_COLORS,
  LEVEL_RANGE,
  MA_COLORS,
  MA_KINDS,
  MA_LEN,
  MAGNET_KEYS,
  MAX_LEVELS,
  MAX_MAS,
  MAX_ZONE_SETS,
  newId,
  nextColor,
  sortLevels,
  ZONE_LIMITS,
  type FibSettings,
  type FvgConf,
  type MagnetKey,
  type MagnetSettings,
  type MaConf,
  type MaKind,
  type MaOptions,
  type ObConf,
  type SrConf,
  type ScaleLabels,
  type Dash,
  type DrawKind,
  type LineDrawing,
  type LineStyle,
  type RectDrawing,
  type RectStyle,
  DASHES,
  LINE_WIDTHS,
  TOOL_INFO,
  DEFAULT_APPEARANCE,
  DEFAULT_POSITION,
  MAX_R_LEVELS,
  POSITION_LIMITS,
  type PositionDrawing,
  type PositionSettings,
  IMAGE_FITS,
  type Appearance,
  type ImageFit,
  DEFAULT_LABELS,
  LABEL_ITEMS,
} from "./settings";
import { ICONS } from "./icons";
import { fmtMoney, fmtQty, type PositionResult, type RiskMode } from "./trade";
import { TIMEFRAMES, tfLabel, tfSec } from "./timeframes";

import { checkbox, colorInput, el, flagBad, labelled, lbl, numInput, textButton } from "./ui/dom.ts";
import { closePopover, popoverAt, togglePopover, type Render } from "./ui/popover.ts";

export { closePopover, popoverAt, togglePopover, type Render };

/** Which timeframe an indicator runs on: "" = the chart's. Orange when smaller than the chart's (not shown). */
function tfSelect(value: string, chartBar: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = el("select");
  s.append(new Option("圖表週期", "", false, value === ""));
  for (const t of TIMEFRAMES) s.append(new Option(t.label, t.bar, false, t.bar === value));
  const paint = () => {
    const low = !!s.value && tfSec(s.value) < tfSec(chartBar);
    s.classList.toggle("warn", low);
    s.title = low
      ? `比現在的圖表週期（${tfLabel(chartBar)}）小，先不顯示；切到 ${tfLabel(s.value)} 或更小的圖表週期才會出現`
      : "用哪個週期的 K 線計算；「圖表週期」會跟著圖表切換";
  };
  paint();
  s.onchange = () => {
    paint();
    onChange(s.value);
  };
  return s;
}

// ----------------------------------------------------------------------------- price-scale labels
/** Right-click menu of the price scale: switch each label on or off; `extra` goes on top (e.g. a new alert). */
export function openScaleMenu(x: number, y: number, labels: { get: () => ScaleLabels; set: (v: ScaleLabels) => void }, extra?: Render) {
  popoverAt(x, y, "價格標籤", (body, rerender) => {
    extra?.(body, rerender);
    const cur = labels.get();
    for (const it of LABEL_ITEMS) {
      body.append(labelled(checkbox(cur[it.key], "", (v) => labels.set({ ...labels.get(), [it.key]: v })), it.text, it.title));
    }
    const foot = el("div", "pop-foot");
    foot.append(el("span", "spacer"), textButton("恢復預設", "link-btn", () => {
      labels.set({ ...DEFAULT_LABELS });
      rerender();
    }));
    body.append(foot);
  });
}

// ----------------------------------------------------------------------------- moving averages
export function toggleMaPanel(
  anchor: HTMLElement,
  mas: { get: () => MaConf[]; set: (v: MaConf[]) => void },
  opts: { get: () => MaOptions; set: (v: MaOptions) => void },
  chartBar: () => string,
) {
  const patch = (id: string, p: Partial<MaConf>) => mas.set(mas.get().map((m) => (m.id === id ? { ...m, ...p } : m)));
  togglePopover(anchor, "below", "均線", (body, rerender) => {
    const list = mas.get();
    if (!list.length) body.append(el("div", "pop-note", "目前沒有均線。按「新增均線」加一條。"));
    for (const m of list) {
      const row = el("div", "pop-row");
      const kind = el("select");
      kind.title = "類型：SMA 簡單、EMA 指數、WMA 加權";
      for (const k of MA_KINDS) kind.append(new Option(k, k, false, k === m.kind));
      kind.onchange = () => patch(m.id, { kind: kind.value as MaKind });
      const len = numInput(m.length, MA_LEN, { title: `週期（${MA_LEN.min}～${MA_LEN.max} 根 K 線）`, width: 64 }, (v) => patch(m.id, { length: v }));
      row.append(
        checkbox(m.on, "顯示／隱藏", (v) => patch(m.id, { on: v })),
        kind,
        len,
        lbl("根"),
        tfSelect(m.tf, chartBar(), (v) => patch(m.id, { tf: v })),
        colorInput(m.color, (v) => patch(m.id, { color: v })),
        textButton("×", "pop-del", () => {
          mas.set(mas.get().filter((x) => x.id !== m.id));
          rerender();
        }, "刪除這條均線"),
      );
      body.append(row);
    }
    body.append(
      el("div", "pop-section", "高週期均線"),
      labelled(
        checkbox(opts.get().waitClose, "", (v) => opts.set({ ...opts.get(), waitClose: v })),
        "等那根 K 線收完才更新",
        "勾選：跟 TradingView 預設一樣，只用收完的高週期 K 線，線在高週期收線時才往前走一格，歷史不會變。\n不勾：最新那根高週期 K 線也算進去，線會跟著現價動。",
      ),
    );
    const foot = el("div", "pop-foot");
    const add = textButton("＋ 新增均線", "text-btn", () => {
      const cur = mas.get();
      const used = new Set(cur.map((m) => m.length));
      const length = [50, 30, 60, 120, 10, 5, 144, 169, 250].find((n) => !used.has(n)) ?? 50;
      mas.set([...cur, { id: newId("ma"), kind: "EMA", length, color: nextColor(MA_COLORS, cur.map((m) => m.color)), on: true, tf: "" }]);
      rerender();
    });
    add.disabled = list.length >= MAX_MAS;
    if (add.disabled) add.title = `最多 ${MAX_MAS} 條`;
    foot.append(add, el("span", "spacer"), textButton("恢復預設", "link-btn", () => {
      mas.set(clone(DEFAULT_MAS));
      rerender();
    }));
    body.append(foot);
  });
}

// ----------------------------------------------------------------------------- FVG and order blocks
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
    if (!list.length) body.append(el("div", "pop-note", "目前沒有設定。按「新增一組」加一組。"));
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
    "三根 K 線中，第一根和第三根沒有重疊的空白。第三根收完才畫；之後價格穿過整個缺口就算回補，框停在那根。",
    sets,
    DEFAULT_FVG,
    chartBar,
    (c, p) => {
      const kind = el("select");
      kind.title = "影線：看最高、最低價；實體：看開盤和收盤（影線可以重疊）";
      kind.append(new Option("影線不重疊", "wick", false, !c.body), new Option("實體不重疊", "body", false, c.body));
      kind.onchange = () => p({ body: kind.value === "body" });
      return [
        lbl("缺口"),
        kind,
        lbl("最小"),
        numInput(c.minPct, ZONE_LIMITS.minPct, { title: "比這個小的缺口不畫（價格的 %；0 = 全部畫）", width: 64, step: "0.01", int: false }, (v) => p({ minPct: v })),
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
      numInput(c.swing, ZONE_LIMITS.srSwing, { title: "波段高點：比左右各這麼多根都高；低點相反。數字越大，線越少、越重要", width: 52 }, (v) => p({ swing: v })),
      lbl("根"),
    ],
    "也顯示已突破的",
    ["撐", "阻"],
  );
}

// ----------------------------------------------------------------------------- Fibonacci
/** `extra`: a section for the Fib this was opened from (its alert), above the foot. */
export function toggleFibPanel(anchor: HTMLElement, fib: { get: () => FibSettings; set: (v: FibSettings) => void }, extra?: Render) {
  togglePopover(anchor, "right", "Fib 回撤", (body, rerender) => {
    const f = fib.get();
    const setF = (p: Partial<FibSettings>) => fib.set({ ...fib.get(), ...p });
    const setLevel = (i: number, p: Partial<FibSettings["levels"][number]>) =>
      setF({ levels: fib.get().levels.map((l, k) => (k === i ? { ...l, ...p } : l)) });

    body.append(el("div", "pop-section", "Fib 數值（勾選的才會畫）"));
    f.levels.forEach((l, i) => {
      const row = el("div", "pop-row");
      const on = checkbox(l.on, "顯示／隱藏", (v) => setLevel(i, { on: v }));
      const val = el("input");
      val.type = "text";
      val.inputMode = "decimal";
      val.value = String(l.value);
      val.title = "比例，例如 0.618；也可以打 61.8%";
      val.onchange = () => {
        const r = parseLevel(val.value, LEVEL_RANGE.min, LEVEL_RANGE.max);
        const dup = "value" in r && fib.get().levels.some((x, k) => k !== i && x.value === r.value);
        if (!("value" in r) || dup) {
          flagBad(val);
          val.value = String(l.value);
          return;
        }
        setF({ levels: sortLevels(fib.get().levels.map((x, k) => (k === i ? { ...x, value: r.value } : x))) });
        rerender();
      };
      val.onkeydown = (e) => {
        if (e.key === "Enter") val.blur();
      };
      const color = colorInput(l.color, (v) => setLevel(i, { color: v }));
      const del = textButton("×", "pop-del", () => {
        setF({ levels: fib.get().levels.filter((_, k) => k !== i) });
        rerender();
      }, "刪除這個數值");
      row.append(on, val, color, del);
      body.append(row);
    });
    if (!f.levels.length) body.append(el("div", "pop-note", "沒有數值。在下面輸入一個，例如 0.618。"));

    // add a level
    const addRow = el("div", "pop-row");
    const input = el("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.placeholder = "例如 0.705";
    input.className = "pop-add";
    const msg = el("div", "pop-msg");
    const add = () => {
      const r = parseLevel(input.value, LEVEL_RANGE.min, LEVEL_RANGE.max);
      const cur = fib.get().levels;
      if (!("value" in r)) msg.textContent = r.error;
      else if (cur.some((x) => x.value === r.value)) msg.textContent = "已經有這個數值";
      else if (cur.length >= MAX_LEVELS) msg.textContent = `最多 ${MAX_LEVELS} 個數值`;
      else {
        setF({ levels: sortLevels([...cur, { value: r.value, color: nextColor(FIB_COLORS, cur.map((x) => x.color)), on: true }]) });
        rerender();
        (document.querySelector(".popover .pop-add") as HTMLInputElement | null)?.focus();
        return;
      }
      flagBad(input);
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") add();
    };
    addRow.append(input, textButton("新增", "text-btn", add));
    body.append(addRow, msg);

    body.append(el("div", "pop-section", "顯示"));
    const opts = el("div", "pop-grid");
    opts.append(
      labelled(checkbox(f.extend, "", (v) => setF({ extend: v })), "線往右延伸"),
      labelled(checkbox(f.fill, "", (v) => setF({ fill: v })), "背景填色"),
      labelled(checkbox(f.showPrice, "", (v) => setF({ showPrice: v })), "顯示價格"),
      labelled(checkbox(f.reverse, "", (v) => setF({ reverse: v })), "反轉方向", "預設：第一個點是 1，第二個點是 0"),
    );
    body.append(opts);
    extra?.(body, rerender);

    const foot = el("div", "pop-foot");
    foot.append(el("span", "pop-note", "畫好的 Fib 會一起更新"), el("span", "spacer"), textButton("恢復預設數值", "link-btn", () => {
      fib.set(clone(DEFAULT_FIB));
      rerender();
    }));
    body.append(foot);
  });
}

// ----------------------------------------------------------------------------- magnet
export function toggleMagnetPanel(anchor: HTMLElement, magnet: { get: () => MagnetSettings; set: (v: MagnetSettings) => void }) {
  togglePopover(anchor, "right", "吸附", (body) => {
    const mg = magnet.get();
    body.append(el("div", "pop-note", "所有畫線、矩形、Fib、倉位的點，靠近游標那根 K 線的開、高、低、收時，會吸到最近的那個價格。"));
    body.append(labelled(checkbox(mg.on, "", (v) => magnet.set({ ...magnet.get(), on: v })), "常開（磁鐵按鈕按一下也能切換）"));
    const keyRow = el("div", "pop-row");
    const keySel = el("select");
    for (const k of MAGNET_KEYS) keySel.append(new Option(k.label, k.key, false, k.key === mg.holdKey));
    keySel.onchange = () => magnet.set({ ...magnet.get(), holdKey: keySel.value as MagnetKey });
    keyRow.append(el("span", "", "按住"), keySel, el("span", "", "時暫時吸附，放開就關"));
    body.append(keyRow);
  });
}

// ----------------------------------------------------------------------------- drawing tools
/** Flyout of a tool group in the left toolbar (e.g. the lines): pick one to start drawing. */
export function toggleToolMenu(anchor: HTMLElement, title: string, kinds: DrawKind[], current: DrawKind, onPick: (k: DrawKind) => void) {
  togglePopover(anchor, "right", title, (body) => {
    for (const k of kinds) {
      const row = el("button", "tool-row" + (k === current ? " active" : ""));
      row.type = "button";
      const icon = el("span", "tool-row-icon");
      icon.innerHTML = ICONS[k]; // our own fixed SVG
      row.append(icon, el("span", "tool-row-name", TOOL_INFO[k].name), el("span", "tool-row-key", TOOL_INFO[k].key));
      row.onclick = () => {
        closePopover();
        onPick(k);
      };
      body.append(row);
    }
  });
}

function widthSelect(value: number, onChange: (v: number) => void): HTMLSelectElement {
  const s = el("select");
  s.title = "粗細";
  for (const w of LINE_WIDTHS) s.append(new Option(`${w} px`, String(w), false, w === value));
  s.onchange = () => onChange(Number(s.value));
  return s;
}
function dashSelect(value: Dash, onChange: (v: Dash) => void): HTMLSelectElement {
  const s = el("select");
  s.title = "線的樣式";
  for (const d of DASHES) s.append(new Option(d.label, d.key, false, d.key === value));
  s.onchange = () => onChange(s.value as Dash);
  return s;
}

/** Style of one line or rectangle (double-click or right-click it). New drawings of that kind start from it. */
export function openDrawingStyle(
  x: number,
  y: number,
  d: LineDrawing | RectDrawing,
  cb: { set: (s: LineStyle | RectStyle) => void; remove: () => void },
  extra?: Render,
) {
  popoverAt(x, y, TOOL_INFO[d.kind].name, (body, rerender) => {
    if (d.kind === "rect") {
      let s: RectStyle = { ...d.style };
      const apply = (p: Partial<RectStyle>) => {
        s = { ...s, ...p };
        cb.set(s);
      };
      const border = el("div", "pop-row");
      border.append(
        lbl("邊框"),
        colorInput(s.border, (v) => apply({ border: v }), "邊框顏色"),
        widthSelect(s.width, (v) => apply({ width: v })),
        dashSelect(s.dash, (v) => apply({ dash: v })),
      );
      const fill = el("div", "pop-row");
      const range = el("input");
      range.type = "range";
      range.min = "0";
      range.max = "100";
      range.step = "5";
      range.value = String(s.transparency);
      range.title = "0% 不透明，100% 完全透明";
      const pct = el("span", "pop-lbl", `${s.transparency}%`);
      range.oninput = () => {
        pct.textContent = `${range.value}%`;
        apply({ transparency: Number(range.value) });
      };
      fill.append(lbl("填色"), colorInput(s.fill, (v) => apply({ fill: v }), "填色"), lbl("透明度"), range, pct);
      body.append(border, fill, labelled(checkbox(s.extend, "", (v) => apply({ extend: v })), "向右延伸"));
    } else {
      let s: LineStyle = { ...d.style };
      const apply = (p: Partial<LineStyle>) => {
        s = { ...s, ...p };
        cb.set(s);
      };
      const row = el("div", "pop-row");
      row.append(
        lbl("顏色"),
        colorInput(s.color, (v) => apply({ color: v })),
        lbl("粗細"),
        widthSelect(s.width, (v) => apply({ width: v })),
        lbl("樣式"),
        dashSelect(s.dash, (v) => apply({ dash: v })),
      );
      body.append(row);
    }
    extra?.(body, rerender);
    const foot = el("div", "pop-foot");
    foot.append(
      el("span", "pop-note", "之後新畫的也會用這個樣式"),
      el("span", "spacer"),
      textButton("刪除", "text-btn danger", () => {
        closePopover();
        cb.remove();
      }, "刪除這個畫線（也可以按 Delete）"),
    );
    body.append(foot);
  });
}

// ----------------------------------------------------------------------------- chart appearance
export type AppearanceIo = {
  get: () => Appearance;
  set: (v: Appearance) => void;
  image: () => string;
  /** Returns false when the picture could not be saved. */
  setImage: (dataUrl: string) => boolean;
};

/** Read a picture file and shrink it (longest side at most 1920 × 1200) to a JPEG data URL. */
async function pictureToDataUrl(file: File, bg: string): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => fail(new Error("讀不到這張圖片"));
      i.src = url;
    });
    const scale = Math.min(1, 1920 / img.naturalWidth, 1200 / img.naturalHeight);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("無法處理圖片");
    ctx.fillStyle = bg; // transparent parts of a PNG take the background color
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function renderAppearance(io: AppearanceIo): Render {
  return (body, rerender) => {
    const a = io.get();
    const set = (p: Partial<Appearance>) => io.set({ ...io.get(), ...p });

    const bg = el("div", "pop-row");
    bg.append(lbl("背景顏色"), colorInput(a.bg, (v) => set({ bg: v })));

    body.append(bg, el("div", "pop-section", "背景圖片"));
    const pic = el("div", "pop-row");
    const file = el("input");
    file.type = "file";
    file.accept = "image/*";
    file.hidden = true;
    const msg = el("div", "pop-msg");
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      msg.textContent = "處理中…";
      try {
        const data = await pictureToDataUrl(f, io.get().bg);
        if (!io.setImage(data)) {
          msg.textContent = "圖片太大，存不下；換一張小一點的";
          return;
        }
        rerender();
      } catch (e) {
        msg.textContent = e instanceof Error ? e.message : String(e);
      }
    };
    const img = io.image();
    if (img) {
      const thumb = el("span", "pop-thumb");
      thumb.style.backgroundImage = `url("${img}")`;
      pic.append(thumb);
    }
    pic.append(file, textButton(img ? "換一張…" : "選擇圖片…", "text-btn", () => file.click()));
    if (img) {
      pic.append(textButton("移除", "link-btn", () => {
        io.setImage("");
        rerender();
      }));
    }
    body.append(pic, msg);
    if (img) {
      const opts = el("div", "pop-row");
      const range = el("input");
      range.type = "range";
      range.min = "0";
      range.max = "100";
      range.step = "5";
      range.value = String(a.imageTransparency);
      range.title = "0% 原圖，100% 看不到圖";
      const pct = el("span", "pop-lbl", `${a.imageTransparency}%`);
      range.oninput = () => {
        pct.textContent = `${range.value}%`;
        set({ imageTransparency: Number(range.value) });
      };
      const fit = el("select");
      for (const f of IMAGE_FITS) fit.append(new Option(f.label, f.key, false, f.key === a.imageFit));
      fit.onchange = () => set({ imageFit: fit.value as ImageFit });
      opts.append(lbl("透明度"), range, pct, fit);
      body.append(opts);
    }

    body.append(el("div", "pop-section", "顏色"));
    const lines = el("div", "pop-row");
    lines.append(lbl("格線"), colorInput(a.grid, (v) => set({ grid: v })), lbl("文字"), colorInput(a.text, (v) => set({ text: v })));
    const candles = el("div", "pop-row");
    candles.append(
      lbl("K 線上漲"),
      colorInput(a.up, (v) => set({ up: v }), "上漲 K 線、成交量和最新價的顏色"),
      lbl("下跌"),
      colorInput(a.down, (v) => set({ down: v }), "下跌 K 線、成交量和最新價的顏色"),
    );
    body.append(lines, candles);

    const foot = el("div", "pop-foot");
    foot.append(el("span", "spacer"), textButton("恢復預設顏色", "link-btn", () => {
      io.set({ ...DEFAULT_APPEARANCE });
      rerender();
    }, "背景圖片不會被移除"));
    body.append(foot);
  };
}

export function toggleAppearancePanel(anchor: HTMLElement, io: AppearanceIo) {
  togglePopover(anchor, "below", "圖表外觀", renderAppearance(io));
}
export function appearanceAt(x: number, y: number, io: AppearanceIo) {
  popoverAt(x, y, "圖表外觀", renderAppearance(io));
}

// ----------------------------------------------------------------------------- position tool
export type PositionIo = { get: () => PositionSettings; set: (v: PositionSettings) => void };
/** One position opened from the chart: its own capital, risk and leverage, and how it turned out. */
export type OnePosition = {
  drawing: PositionDrawing;
  trade: () => PositionResult | undefined;
  update: (p: Partial<Pick<PositionDrawing, "capital" | "risk" | "riskMode" | "leverage">>) => void;
  remove: () => void;
};

const OUTCOME_TEXT: Record<string, string> = {
  tp: "止盈出場",
  sl: "止損出場",
  expired: "到期出場（框的右邊界）",
  open: "持倉中",
  pending: "等待進場",
  unfilled: "沒有成交",
  nodata: "K 線不夠，無法結算",
};

/** Risk amount box with a % / U switch. */
function riskInputs(value: number, mode: RiskMode, onChange: (v: number, m: RiskMode) => void): HTMLElement[] {
  const unit = el("select");
  unit.append(new Option("% 資金", "pct", false, mode === "pct"), new Option("U", "amount", false, mode === "amount"));
  const box = numInput(value, POSITION_LIMITS[mode], { title: "每筆最多虧多少：資金的 %，或固定金額", width: 72, step: "0.1", int: false }, (v) =>
    onChange(v, unit.value as RiskMode),
  );
  unit.onchange = () => {
    const m = unit.value as RiskMode;
    const r = POSITION_LIMITS[m];
    const v = Math.min(Math.max(Number(box.value) || r.min, r.min), r.max);
    box.min = String(r.min);
    box.max = String(r.max);
    box.value = String(v);
    onChange(v, m);
  };
  return [box, unit];
}

function renderPosition(io: PositionIo, one?: OnePosition, extra?: Render): Render {
  return (body, rerender) => {
    const cur = io.get();
    const set = (p: Partial<PositionSettings>) => io.set({ ...io.get(), ...p });
    const later = () => requestAnimationFrame(() => requestAnimationFrame(rerender)); // after the chart recomputes

    if (one) {
      const d = one.drawing;
      const t = one.trade();
      const upd = (p: Parameters<OnePosition["update"]>[0]) => {
        one.update(p);
        later();
      };
      body.append(el("div", "pop-section", "這個倉位"));
      const capRow = el("div", "pop-row");
      const auto = d.capital == null;
      const cap = numInput(t ? Math.round(t.capital * 100) / 100 : cur.capital, POSITION_LIMITS.capital, { title: "這筆用多少資金算倉位", width: 96, step: "1", int: false }, (v) =>
        upd({ capital: v }),
      );
      cap.disabled = auto;
      capRow.append(
        lbl("初始資金"),
        cap,
        lbl("U"),
        labelled(checkbox(auto, "", (v) => upd({ capital: v ? null : Number(cap.value) || cur.capital })), "接續前一個倉位", "勾選：用前一個倉位結算後的資金；沒有前一個時用預設資金"),
      );
      const riskRow = el("div", "pop-row");
      riskRow.append(lbl("風險"), ...riskInputs(d.risk, d.riskMode, (v, m) => upd({ risk: v, riskMode: m })));
      const levRow = el("div", "pop-row");
      levRow.append(
        lbl("槓桿"),
        numInput(d.leverage, POSITION_LIMITS.leverage, { title: "1～125 倍", width: 64, step: "1", int: false }, (v) => upd({ leverage: v })),
        lbl("倍"),
      );
      body.append(capRow, riskRow, levRow);
      if (t) {
        const pl = t.plan;
        const lines = [
          `數量 ${fmtQty(pl.qty)}　名目 ${fmtMoney(pl.notional)} U　保證金 ${fmtMoney(pl.margin)} U`,
          `最大虧損 ${fmtMoney(pl.riskAmount)} U　止盈獲利 ${fmtMoney(pl.reward)} U`,
          `結果：${OUTCOME_TEXT[t.outcome.status]}` +
            (t.outcome.exit != null ? `　${t.pnl >= 0 ? "+" : "−"}${fmtMoney(Math.abs(t.pnl))} U，資金變成 ${fmtMoney(t.endCapital)} U` : ""),
        ];
        if (t.auto && !t.chained) lines.unshift(cur.chain ? "前面沒有倉位，用預設資金" : "預設沒有開接續，用預設資金");
        for (const s of lines) body.append(el("div", "pop-note", s));
        if (pl.capped) body.append(el("div", "pop-msg", "保證金超過資金，數量已減到這個槓桿能開的最大值，實際風險會比設定小"));
      }
    } else {
      body.append(el("div", "pop-section", "新倉位的預設"));
      const capRow = el("div", "pop-row");
      capRow.append(
        lbl("初始資金"),
        numInput(cur.capital, POSITION_LIMITS.capital, { title: "第一個倉位（或不接續時）用的資金", width: 96, step: "1", int: false }, (v) => set({ capital: v })),
        lbl("U"),
      );
      const riskRow = el("div", "pop-row");
      riskRow.append(lbl("風險"), ...riskInputs(cur.risk, cur.riskMode, (v, m) => set({ risk: v, riskMode: m })));
      const levRow = el("div", "pop-row");
      levRow.append(
        lbl("槓桿"),
        numInput(cur.leverage, POSITION_LIMITS.leverage, { title: "1～125 倍", width: 64, step: "1", int: false }, (v) => set({ leverage: v })),
        lbl("倍"),
      );
      body.append(
        capRow,
        riskRow,
        levRow,
        labelled(checkbox(cur.chain, "", (v) => set({ chain: v })), "接續前一個倉位結算後的資金", "照進場時間排，每個沒有自己設資金的倉位，用前一個倉位結算後的資金"),
      );
    }

    body.append(el("div", "pop-section", "R 線（R = 進場到止損的距離，只畫到止盈為止）"));
    cur.levels.forEach((l, i) => {
      const row = el("div", "pop-row");
      const val = el("input");
      val.type = "text";
      val.inputMode = "decimal";
      val.value = String(l.value);
      val.title = "幾倍 R，例如 1.5";
      val.onchange = () => {
        const r = parseR(val.value);
        const dup = "value" in r && io.get().levels.some((x, k) => k !== i && x.value === r.value);
        if (!("value" in r) || dup) {
          flagBad(val);
          val.value = String(l.value);
          return;
        }
        const levels = io.get().levels.map((x, k) => (k === i ? { ...x, value: r.value } : x)).sort((a, b) => a.value - b.value);
        set({ levels });
        rerender();
      };
      val.onkeydown = (e) => {
        if (e.key === "Enter") val.blur();
      };
      row.append(
        checkbox(l.on, "顯示／隱藏", (v) => set({ levels: io.get().levels.map((x, k) => (k === i ? { ...x, on: v } : x)) })),
        val,
        lbl("R"),
        textButton("×", "pop-del", () => {
          set({ levels: io.get().levels.filter((_, k) => k !== i) });
          rerender();
        }, "刪除這條 R 線"),
      );
      body.append(row);
    });
    if (!cur.levels.length) body.append(el("div", "pop-note", "沒有 R 線。在下面輸入一個，例如 1。"));
    const addRow = el("div", "pop-row");
    const input = el("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.placeholder = "例如 3";
    input.className = "pop-add";
    const msg = el("div", "pop-msg");
    const add = () => {
      const r = parseR(input.value);
      const levels = io.get().levels;
      if (!("value" in r)) msg.textContent = r.error;
      else if (levels.some((x) => x.value === r.value)) msg.textContent = "已經有這條";
      else if (levels.length >= MAX_R_LEVELS) msg.textContent = `最多 ${MAX_R_LEVELS} 條`;
      else {
        set({ levels: [...levels, { value: r.value, on: true }].sort((a, b) => a.value - b.value) });
        rerender();
        (document.querySelector(".popover .pop-add") as HTMLInputElement | null)?.focus();
        return;
      }
      flagBad(input);
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") add();
    };
    addRow.append(input, lbl("R"), textButton("新增", "text-btn", add));
    body.append(addRow, msg);

    body.append(el("div", "pop-section", "顯示"));
    const colors = el("div", "pop-row");
    const range = el("input");
    range.type = "range";
    range.min = "0";
    range.max = "100";
    range.step = "5";
    range.value = String(cur.transparency);
    range.title = "0% 不透明，100% 完全透明";
    const pct = el("span", "pop-lbl", `${cur.transparency}%`);
    range.oninput = () => {
      pct.textContent = `${range.value}%`;
      set({ transparency: Number(range.value) });
    };
    colors.append(
      lbl("獲利"),
      colorInput(cur.profit, (v) => set({ profit: v }), "止盈那一側的顏色"),
      lbl("虧損"),
      colorInput(cur.loss, (v) => set({ loss: v }), "止損那一側的顏色"),
      lbl("透明度"),
      range,
      pct,
    );
    body.append(colors, labelled(checkbox(cur.showPrices, "", (v) => set({ showPrices: v })), "標出價格"));
    extra?.(body, rerender);

    const foot = el("div", "pop-foot");
    if (one) {
      foot.append(textButton("刪除這個倉位", "text-btn danger", () => {
        closePopover();
        one.remove();
      }, "也可以選取後按 Delete"));
    }
    foot.append(el("span", "spacer"), textButton("恢復預設", "link-btn", () => {
      io.set(clone(DEFAULT_POSITION));
      rerender();
    }, "R 線、顏色和新倉位的預設；不會改已經畫好的倉位自己的資金、風險、槓桿"));
    body.append(foot);
  };
}

/** Position settings from the toolbar: defaults for new positions, and the R lines and colors all share. */
export function togglePositionPanel(anchor: HTMLElement, io: PositionIo) {
  togglePopover(anchor, "right", "倉位", renderPosition(io));
}
/** One position, from a double-click or right-click on it. */
export function positionPanelAt(x: number, y: number, io: PositionIo, one: OnePosition, extra?: Render) {
  popoverAt(x, y, "倉位", renderPosition(io, one, extra));
}
