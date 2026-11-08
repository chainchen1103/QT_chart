// Pine scripts: the list (switch on/off, settings, report, edit, delete, add or import), the editor, a
// script's inputs, and a strategy's backtest report. Scripts are saved in settings (settings.pine); every
// chart runs the ones switched on, and these windows show the results of the chart in use.

import { ColorType, createChart, LineSeries, type IChartApi, type Time, type UTCTimestamp } from "lightweight-charts";
import type { Setting } from "../../core/setting.ts";
import { fmtChartTime, fmtTick, signed, toChartTime } from "../../core/format.ts";
import type { PineHost } from "../../indicators/pine/host.ts";
import { loadCached } from "../../indicators/pine/host.ts";
import { load, titleOf } from "../../pine/index.ts";
import { colT, hexColor, hexOf, rgbt, type InputDef } from "../../pine/runtime.ts";
import type { StrategyReport } from "../../pine/strategy.ts";
import { MAX_PINE_SCRIPTS, MAX_PINE_SOURCE, newId, type PineScript } from "../../settings/model.ts";
import { checkbox, colorInput, el, flagBad, textButton } from "../dom.ts";
import { openModal, type Modal } from "../modal.ts";
import { POPOVER_CLOSED, togglePopover } from "../popover.ts";
import { MONO_FONT, THEME } from "../theme.ts";
import type { IndSpec } from "../../indicators/specs.ts";
import { indicatorAlertSection, type AlertUi, type IndPreset, type IndSource } from "../../alerts/panel.ts";

export type PineUi = {
  scripts: Setting<PineScript[]>;
  /** The Pine scripts of the chart in use. */
  host(): PineHost;
  /** The chart in use, for titles: "BTC-USDT-SWAP · 15分". */
  chartName(): string;
  note(text: string): void;
  /** Alerts on a script, made from its settings window: on the chart in use. */
  alerts?(): AlertUi;
  sources?(id: string): IndSource[];
  preset?(id: string): IndPreset;
};

const TEMPLATE = `//@version=5
indicator("我的指標", overlay = true)
length = input.int(20, "長度", minval = 1)
plot(ta.sma(close, length), "SMA", color = color.orange)
`;

const SOURCE_NAMES: [string, string][] = [
  ["open", "開盤 open"], ["high", "最高 high"], ["low", "最低 low"], ["close", "收盤 close"], ["hl2", "hl2"], ["hlc3", "hlc3"], ["ohlc4", "ohlc4"], ["hlcc4", "hlcc4"], ["volume", "成交量 volume"],
];
const TF_NAMES: [string, string][] = [
  ["", "圖表週期"], ["1", "1分"], ["3", "3分"], ["5", "5分"], ["15", "15分"], ["30", "30分"], ["60", "1時"], ["120", "2時"], ["240", "4時"], ["360", "6時"], ["720", "12時"], ["D", "日"], ["W", "週"],
];

// ----------------------------------------------------------------------------- the list

export function togglePineManager(anchor: HTMLElement, ui: PineUi) {
  togglePopover(anchor, "below", "Pine 腳本", (body, rerender) => {
    body.classList.add("pine-pop");
    const list = ui.scripts.get();
    const host = ui.host();
    if (!list.length) body.append(el("div", "pop-note", "還沒有腳本，按「新增腳本」貼上原始碼"));
    const rows = el("div", "pine-list");
    for (const s of list) rows.append(scriptRow(s, ui, host, rerender));
    body.append(rows);
    const file = fileInput((name, text) => openPineEditor(ui, null, text, name));
    const foot = el("div", "pop-foot");
    const add = textButton("＋ 新增腳本", "text-btn primary", () => openPineEditor(ui, null, TEMPLATE), "貼上或寫一個 Pine Script（v4、v5、v6）");
    const imp = textButton("從檔案匯入…", "text-btn", () => file.click());
    if (list.length >= MAX_PINE_SCRIPTS) {
      add.disabled = true;
      imp.disabled = true;
      add.title = imp.title = `最多 ${MAX_PINE_SCRIPTS} 個腳本`;
    }
    foot.append(add, imp, file);
    body.append(foot);
    body.append(el("div", "pop-note", "支援指標、畫線和策略回測，不會下單"));
    // statuses follow the chart in use's runs while this is open
    const off = host.subscribe(() => {
      for (const s of ui.scripts.get()) {
        const st = body.querySelector<HTMLElement>(`[data-status="${CSS.escape(s.id)}"]`);
        if (st) paintStatus(st, s, host);
      }
    });
    body.addEventListener(POPOVER_CLOSED, () => off());
  });
}

function scriptRow(s: PineScript, ui: PineUi, host: PineHost, rerender: () => void): HTMLElement {
  const row = el("div", "pine-row" + (s.on ? "" : " off"));
  const top = el("div", "pine-row-top");
  const loaded = loadCached(s.source);
  const info = loaded.info;
  const kind = info?.kind === "strategy" ? "策略" : "指標";
  const sw = checkbox(s.on, s.on ? "關閉（不畫在圖上）" : "開啟", (on) => {
    update(ui, s.id, { on });
    rerender();
  });
  const name = el("span", "pine-name", s.name || info?.title || "Pine 腳本");
  name.title = `${s.name || info?.title || ""}（${kind}${info ? (info.overlay ? "，畫在 K 線上" : "，畫在下方新窗格") : ""}）`;
  const badge = el("span", "pine-badge", kind);
  top.append(sw, name, badge);
  if (info?.kind === "strategy") top.append(iconBtn("績效", "回測績效：淨利、勝率、回撤、每筆交易", () => openPineReport(ui, s.id)));
  top.append(
    iconBtn("設定", "參數設定（腳本裡的 input）", () => openPineInputs(ui, s.id)),
    iconBtn("編輯", "編輯原始碼", () => openPineEditor(ui, s)),
  );
  let armed = false;
  const del = textButton("×", "pop-del", () => {
    if (!armed) {
      armed = true;
      del.textContent = "刪除？";
      del.classList.add("armed");
      setTimeout(() => {
        armed = false;
        del.textContent = "×";
        del.classList.remove("armed");
      }, 2500);
      return;
    }
    ui.scripts.set(ui.scripts.get().filter((x) => x.id !== s.id));
    rerender();
  }, "刪除這個腳本（按兩次）");
  top.append(del);
  const status = el("div", "pine-status");
  status.dataset.status = s.id;
  paintStatus(status, s, host);
  row.append(top, status);
  return row;
}

function iconBtn(text: string, title: string, onClick: () => void): HTMLButtonElement {
  return textButton(text, "pine-act", onClick, title);
}

function paintStatus(box: HTMLElement, s: PineScript, host: PineHost) {
  box.className = "pine-status";
  if (!s.on) {
    box.textContent = "已關閉";
    return;
  }
  const loaded = loadCached(s.source);
  if (!loaded.ok) {
    box.classList.add("bad");
    box.textContent = `第 ${loaded.error.line} 行：${loaded.error.message}`;
    return;
  }
  const v = host.view(s.id);
  if (!v || !v.result) {
    box.textContent = "等待 K 線…";
    return;
  }
  if (v.error) {
    box.classList.add("bad");
    box.textContent = v.error;
    return;
  }
  const r = v.result;
  const parts = [v.loading ? "載入其他週期的 K 線…" : `已套用 · 計算 ${r.ms} ms`];
  if (r.strategy) parts.push(`${r.strategy.trades.length} 筆交易 · 淨利 ${signedMoney(r.strategy.netProfit)} ${unitOf(r.strategy.currency)}`);
  box.textContent = parts.join(" · ");
  if (r.warnings.length) {
    box.classList.add("warn");
    box.textContent += ` · 注意：${r.warnings[0]}`;
    box.title = r.warnings.join("\n");
  }
}

function update(ui: PineUi, id: string, patch: Partial<PineScript>) {
  ui.scripts.set(ui.scripts.get().map((x) => (x.id === id ? { ...x, ...patch } : x)));
}

function fileInput(got: (name: string, text: string) => void): HTMLInputElement {
  const f = el("input");
  f.type = "file";
  f.accept = ".pine,.txt,.pinescript,text/plain";
  f.hidden = true;
  f.onchange = () => {
    const file = f.files?.[0];
    f.value = "";
    if (!file) return;
    if (file.size > MAX_PINE_SOURCE) {
      alertText(`檔案太大（上限 ${Math.round(MAX_PINE_SOURCE / 1000)} KB）`);
      return;
    }
    const r = new FileReader();
    r.onload = () => got(file.name.replace(/\.[^.]+$/, ""), String(r.result ?? ""));
    r.readAsText(file);
  };
  return f;
}
function alertText(text: string) {
  const m = openModal({ title: "Pine 腳本", render: (body, foot) => {
    body.append(el("div", "pop-note", text));
    foot.append(el("span", "spacer"), textButton("好", "text-btn primary", () => m.close()));
  } });
}

// ----------------------------------------------------------------------------- the editor

/** Edit a script (null: a new one, starting from `preset`). */
export function openPineEditor(ui: PineUi, script: PineScript | null, preset = "", fileName = "") {
  const start = script ? script.source : preset || TEMPLATE;
  let saved = start;
  let nameTouched = !!script?.name && script.name !== titleOf(script.source);
  const m = openModal({
    title: script ? "編輯 Pine 腳本" : "新增 Pine 腳本",
    cls: "pine-editor",
    beforeClose: () => {
      if (area.value === saved || confirmDiscard.armed) return true;
      confirmDiscard.arm();
      return false;
    },
    render: () => {},
  });
  const body = m.body;
  const nameRow = el("div", "pop-row");
  const nameIn = el("input");
  nameIn.type = "text";
  nameIn.className = "pine-name-in";
  nameIn.placeholder = "名稱（預設用腳本的標題）";
  nameIn.value = script?.name || fileName || titleOf(start);
  nameIn.oninput = () => (nameTouched = true);
  nameRow.append(el("span", "pop-lbl", "名稱"), nameIn);
  const wrap = el("div", "pine-code");
  const gutter = el("pre", "pine-gutter");
  const area = el("textarea");
  area.className = "pine-area";
  area.spellcheck = false;
  area.wrap = "off";
  area.value = start;
  area.setAttribute("autocomplete", "off");
  wrap.append(gutter, area);
  const status = el("div", "pine-check");
  body.append(nameRow, wrap, status);

  let errLine = 0;
  const paintGutter = () => {
    const n = area.value.split("\n").length;
    const out: string[] = [];
    for (let i = 1; i <= n; i++) out.push(String(i));
    gutter.replaceChildren();
    out.forEach((t, k) => {
      const s = el("span", k + 1 === errLine ? "bad" : "", t + "\n");
      gutter.append(s);
    });
    gutter.scrollTop = area.scrollTop;
  };
  let timer = 0;
  const check = () => {
    const l = load(area.value);
    errLine = l.ok ? 0 : l.error.line;
    status.className = "pine-check " + (l.ok ? "ok" : "bad");
    if (l.ok) {
      const i = l.info;
      status.textContent = `可以執行 · ${i.kind === "strategy" ? "策略" : "指標"}「${i.title || "未命名"}」· ${i.overlay ? "畫在 K 線上" : "畫在下方新窗格"} · Pine v${i.version}`;
      if (!nameTouched) nameIn.value = i.title || nameIn.value;
    } else status.textContent = `第 ${l.error.line} 行${l.error.col ? `第 ${l.error.col} 字` : ""}：${l.error.message}`;
    paintGutter();
  };
  area.addEventListener("input", () => {
    paintGutter();
    clearTimeout(timer);
    timer = window.setTimeout(check, 300);
  });
  area.addEventListener("scroll", () => (gutter.scrollTop = area.scrollTop));
  area.addEventListener("keydown", (e) => editKey(e, area));
  status.onclick = () => {
    if (errLine) goToLine(area, errLine);
  };
  check();

  const file = fileInput((_n, text) => {
    area.value = text;
    area.dispatchEvent(new Event("input"));
  });
  const confirmDiscard = {
    armed: false,
    arm() {
      this.armed = true;
      status.className = "pine-check warn";
      status.textContent = "有還沒儲存的修改：再按一次 × 或 Esc 就放棄修改";
      setTimeout(() => (this.armed = false), 3000);
    },
  };
  const save = () => {
    const source = area.value;
    if (source.length > MAX_PINE_SOURCE) {
      status.className = "pine-check bad";
      status.textContent = `腳本太長（上限 ${Math.round(MAX_PINE_SOURCE / 1000)} KB）`;
      return;
    }
    if (!source.trim()) {
      flagBad(nameIn);
      return;
    }
    const name = nameIn.value.trim() || titleOf(source);
    const list = ui.scripts.get();
    if (script && list.some((x) => x.id === script.id)) update(ui, script.id, { source, name, on: true });
    else {
      if (list.length >= MAX_PINE_SCRIPTS) return;
      ui.scripts.set([...list, { id: newId("pine"), name, source, on: true, inputs: {} }]);
    }
    saved = source;
    ui.note(`已套用 Pine 腳本「${name}」`);
    m.close();
  };
  area.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  });
  m.foot.append(
    textButton("從檔案載入…", "text-btn", () => file.click()),
    file,
    el("span", "spacer"),
    el("span", "pop-unit", "Ctrl+S 儲存"),
    textButton("取消", "text-btn", () => m.close()),
    textButton("儲存並套用", "text-btn primary", save),
  );
  setTimeout(() => area.focus(), 0);
}

/** Tab indents (4 spaces), Shift+Tab outdents, Enter keeps the indentation (one more after `=>` / if / for …). */
function editKey(e: KeyboardEvent, a: HTMLTextAreaElement) {
  e.stopPropagation(); // keys typed here never reach the chart
  const v = a.value;
  const s = a.selectionStart;
  const end = a.selectionEnd;
  const lineStart = v.lastIndexOf("\n", s - 1) + 1;
  if (e.key === "Tab") {
    e.preventDefault();
    if (s === end && !e.shiftKey) {
      a.setRangeText("    ", s, end, "end");
    } else {
      const blockEnd = v.indexOf("\n", end - (end > s && v[end - 1] === "\n" ? 1 : 0));
      const stop = blockEnd < 0 ? v.length : blockEnd;
      const lines = v.slice(lineStart, stop).split("\n");
      const next = lines.map((l) => (e.shiftKey ? l.replace(/^( {1,4}|\t)/, "") : "    " + l)).join("\n");
      a.setRangeText(next, lineStart, stop, "select");
    }
    a.dispatchEvent(new Event("input"));
    return;
  }
  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const line = v.slice(lineStart, s);
    let indent = /^\s*/.exec(line)![0].replace(/\t/g, "    ");
    const t = line.trim();
    if (/=>\s*$/.test(t) || /^(if|else|for|while|switch|type|enum)\b/.test(t) || /^(else\s+if)\b/.test(t)) indent += "    ";
    e.preventDefault();
    a.setRangeText("\n" + indent, s, end, "end");
    a.dispatchEvent(new Event("input"));
  }
}

function goToLine(a: HTMLTextAreaElement, line: number) {
  const lines = a.value.split("\n");
  let pos = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
  a.focus();
  a.setSelectionRange(pos, pos + (lines[line - 1]?.length ?? 0));
  const lh = parseFloat(getComputedStyle(a).lineHeight) || 18;
  a.scrollTop = Math.max(0, (line - 4) * lh);
}

// ----------------------------------------------------------------------------- inputs

export function openPineInputs(ui: PineUi, id: string) {
  const script = () => ui.scripts.get().find((x) => x.id === id);
  const s0 = script();
  if (!s0) return;
  openModal({
    title: `設定：${s0.name || titleOf(s0.source)}`,
    cls: "pine-inputs",
    render: (body, foot, m) => {
      const s = script();
      if (!s) return;
      const v = ui.host().view(id);
      const defs = v?.result?.inputs ?? [];
      if (!s.on) body.append(el("div", "pop-note", "這個腳本關著：改了設定，開啟後才看得到"));
      if (!defs.length) body.append(el("div", "pop-note", v?.result ? "這個腳本沒有可以調整的參數（input）" : "腳本還沒在目前的圖表上計算過，開啟腳本、等 K 線載入後再來"));
      let group = "\u0000";
      let inlineRow: HTMLElement | null = null;
      let inlineKey = "";
      for (const d of defs) {
        if (d.group !== group) {
          group = d.group;
          if (group) body.append(el("div", "pop-section", group));
          inlineRow = null;
        }
        const value = d.key in s.inputs ? s.inputs[d.key] : d.defval;
        const set = (val: string | number | boolean | null) => {
          const cur = script();
          if (!cur) return;
          const inputs = { ...cur.inputs };
          if (val === null || val === d.defval) delete inputs[d.key];
          else inputs[d.key] = val;
          update(ui, id, { inputs });
        };
        const widget = inputWidget(d, value, set);
        const label = el("span", "pop-lbl pine-in-lbl", d.title);
        if (d.tooltip) label.title = d.tooltip;
        if (d.inline && inlineRow && inlineKey === d.inline) {
          inlineRow.append(label, widget);
          continue;
        }
        const row = el("div", "pop-row pine-in-row");
        row.append(label, widget);
        body.append(row);
        inlineRow = d.inline ? row : null;
        inlineKey = d.inline;
      }
      // alerts on its plots, on the chart in use
      if (ui.alerts && ui.sources) {
        const { alerts, sources, preset } = ui;
        const mine = (x: IndSpec) => x.type === "pine" && x.id === id;
        indicatorAlertSection(alerts(), mine, () => sources(id), () => preset?.(id) ?? {}, "這個腳本還沒畫出線，開啟後才能設提醒")(body, () => m.rerender());
      }
      foot.append(
        textButton("恢復預設", "text-btn", () => {
          update(ui, id, { inputs: {} });
          setTimeout(() => m.rerender(), 50);
        }),
        el("span", "spacer"),
        textButton("關閉", "text-btn primary", () => m.close()),
      );
    },
  });
}

function inputWidget(d: InputDef, value: unknown, set: (v: string | number | boolean | null) => void): HTMLElement {
  const sel = (opts: [string, string][], cur: string, onPick: (v: string) => void) => {
    const s = el("select");
    for (const [v, t] of opts) {
      const o = el("option", "", t);
      o.value = v;
      s.append(o);
    }
    s.value = opts.some(([v]) => v === cur) ? cur : opts[0]?.[0] ?? "";
    s.onchange = () => onPick(s.value);
    return s;
  };
  switch (d.kind) {
    case "bool":
      return checkbox(!!value, d.title, (on) => set(on));
    case "color": {
      const c = typeof value === "number" && value === value ? value : hexColor("#2962FF");
      const box = el("span", "pine-color");
      let hex = hexOf(c);
      let t = colT(c);
      const pick = colorInput(hex, (h) => {
        hex = h;
        set(rgbt(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), t));
      });
      const tr = el("input");
      tr.type = "number";
      tr.min = "0";
      tr.max = "100";
      tr.value = String(Math.round(t));
      tr.title = "透明度（0 不透明，100 看不見）";
      tr.className = "pine-transp";
      tr.onchange = () => {
        const n = Number(tr.value);
        if (!(n >= 0 && n <= 100)) {
          flagBad(tr);
          tr.value = String(Math.round(t));
          return;
        }
        t = n;
        set(rgbt(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), t));
      };
      box.append(pick, tr, el("span", "pop-unit", "%"));
      return box;
    }
    case "source":
      return sel(SOURCE_NAMES, String(value), (v) => set(v));
    case "timeframe":
      return sel(d.options ? (d.options as unknown[]).map((o) => [String(o), TF_NAMES.find(([k]) => k === String(o))?.[1] ?? String(o)]) : TF_NAMES, String(value ?? ""), (v) => set(v));
    case "enum":
      return sel((d.enumVals ?? []).map((e) => [e.name, e.title]), typeof value === "string" ? value : (value as { name?: string })?.name ?? "", (v) => set(v));
    case "int":
    case "float":
    case "price": {
      if (d.options) return sel((d.options as unknown[]).map((o) => [String(o), String(o)]), String(value), (v) => set(Number(v)));
      const i = el("input");
      i.type = "number";
      if (d.min != null) i.min = String(d.min);
      if (d.max != null) i.max = String(d.max);
      i.step = d.step != null ? String(d.step) : d.kind === "int" ? "1" : "any";
      i.value = String(value);
      i.onchange = () => {
        const n = Number(i.value);
        const bad = i.value.trim() === "" || !Number.isFinite(n) || (d.min != null && n < d.min) || (d.max != null && n > d.max) || (d.kind === "int" && !Number.isInteger(n));
        if (bad) {
          flagBad(i);
          i.value = String(value);
          return;
        }
        set(n);
      };
      return i;
    }
    case "time": {
      const i = el("input");
      i.type = "datetime-local";
      const t = typeof value === "number" ? value : NaN;
      if (t === t) {
        const dt = new Date(t);
        const pad = (x: number) => String(x).padStart(2, "0");
        i.value = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
      }
      i.onchange = () => {
        const ms = new Date(i.value).getTime();
        if (Number.isFinite(ms)) set(ms);
      };
      return i;
    }
    default: {
      if (d.options) return sel((d.options as unknown[]).map((o) => [String(o), String(o)]), String(value), (v) => set(v));
      const i = el("input");
      i.type = "text";
      i.value = String(value ?? "");
      i.onchange = () => set(i.value);
      return i;
    }
  }
}

// ----------------------------------------------------------------------------- the strategy report

export function openPineReport(ui: PineUi, id: string) {
  const s0 = ui.scripts.get().find((x) => x.id === id);
  if (!s0) return;
  let chart: IChartApi | null = null;
  let off: () => void = () => {};
  let lastKey = "";
  let timer = 0;
  const m: Modal = openModal({
    title: `回測績效：${s0.name || titleOf(s0.source)}`,
    cls: "pine-report",
    onClose: () => {
      off();
      clearTimeout(timer);
      chart?.remove();
      chart = null;
    },
    render: (body, foot) => {
      chart?.remove();
      chart = null;
      const host = ui.host();
      const v = host.view(id);
      const r = v?.result;
      const rep = r?.strategy;
      body.append(el("div", "pine-sub", `${ui.chartName()} · 用圖上已載入的 K 線回測`));
      if (!rep) {
        body.append(el("div", "pop-note", v?.error ? `腳本有錯誤：${v.error}` : "還沒有結果：腳本要開著，並且在目前的圖表上計算完"));
      } else {
        chart = reportBody(body, rep);
      }
      foot.append(el("span", "spacer"), textButton("關閉", "text-btn primary", () => m.close()));
    },
  });
  // follow the chart's new results (at most every two seconds, and only when something changed)
  off = ui.host().subscribe(() => {
    const rep = ui.host().view(id)?.result?.strategy;
    const key = rep ? `${rep.trades.length}|${rep.netProfit.toFixed(4)}|${rep.open.length}|${rep.equity.length}` : "";
    if (key === lastKey || timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      lastKey = key;
      m.rerender();
    }, 2000);
  });
}

function money(v: number): string {
  if (!(v === v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/** A signed amount with a true minus sign: "+179.72", "−51.79". */
function signedMoney(v: number): string {
  if (!(v === v)) return "—";
  const a = money(Math.abs(v));
  return `${a === "0.00" ? "" : v > 0 ? "+" : "−"}${a}`;
}
function pct(v: number): string {
  return v === v && Number.isFinite(v) ? `${v.toFixed(2)}%` : "—";
}
function signedPct(v: number): string {
  return v === v && Number.isFinite(v) ? `${signed(v)}%` : "—";
}
function signCls(v: number) {
  return v > 0 ? "up" : v < 0 ? "down" : "";
}
/** The report's currency: USD and USDT are written "U", like everywhere else in the app. */
const unitOf = (c: string) => (c === "USD" || c === "USDT" || !c ? "U" : c);

function reportBody(body: HTMLElement, rep: StrategyReport): IChartApi {
  const t = rep.trades;
  const wins = t.filter((x) => x.profit > 0);
  const losses = t.filter((x) => x.profit < 0);
  const pf = rep.grossLoss > 0 ? rep.grossProfit / rep.grossLoss : rep.grossProfit > 0 ? Infinity : NaN;
  const avgWin = wins.length ? rep.grossProfit / wins.length : NaN;
  const avgLoss = losses.length ? rep.grossLoss / losses.length : NaN;
  const u = unitOf(rep.currency);
  const amount = (v: number) => (v === v ? `${money(v)} ${u}` : "—");
  const signedAmount = (v: number) => (v === v ? `${signedMoney(v)} ${u}` : "—");

  // the four figures that say how it went
  const lead = el("div", "pine-lead");
  const leadItem = (k: string, v: string, sub: string, cls = "") => {
    const c = el("div", "pine-lead-item");
    c.append(el("div", "pine-lead-k", k), el("div", "pine-lead-v " + cls, v), el("div", "pine-lead-sub", sub));
    lead.append(c);
  };
  leadItem("淨利", signedAmount(rep.netProfit), `報酬率 ${signedPct((rep.netProfit / rep.initialCapital) * 100)}`, signCls(rep.netProfit));
  leadItem("最大回撤", amount(rep.maxDrawdown), `回撤幅度 ${pct(rep.maxDrawdownPct)}`);
  leadItem("勝率", t.length ? pct((wins.length / t.length) * 100) : "—", `${t.length} 筆交易，${wins.length} 筆獲利`);
  leadItem("獲利因子", pf === Infinity ? "∞" : pf === pf ? pf.toFixed(2) : "—", `平均獲利 / 虧損 ${avgWin === avgWin && avgLoss === avgLoss ? (avgWin / avgLoss).toFixed(2) : "—"}`);
  body.append(lead);

  // the equity curve, with buying and holding the same capital for comparison
  const chartHead = el("div", "pine-chart-head");
  const key = (text: string, color: string) => {
    const k = el("span", "pine-key", text);
    k.style.setProperty("--key", color);
    return k;
  };
  chartHead.append(el("span", "pine-chart-title", "權益曲線"), key("策略", THEME.data), key("買進持有", THEME.muted), el("span", "pine-chart-note", "每根 K 線收盤時的資金"));
  const box = el("div", "pine-equity");
  body.append(chartHead, box);
  const chart = createChart(box, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: THEME.muted, fontSize: 11, fontFamily: MONO_FONT, attributionLogo: false },
    grid: { vertLines: { visible: false }, horzLines: { color: THEME.line } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderColor: THEME.line, timeVisible: true, tickMarkFormatter: fmtTick },
    localization: { timeFormatter: (time: Time) => fmtChartTime(time, false) },
    crosshair: { vertLine: { labelBackgroundColor: THEME.hover }, horzLine: { labelBackgroundColor: THEME.hover } },
    handleScroll: false,
    handleScale: false,
  });
  const hold = chart.addSeries(LineSeries, { color: THEME.muted, lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
  const line = chart.addSeries(LineSeries, { color: THEME.data, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
  const pts: { time: UTCTimestamp; value: number }[] = [];
  const holdPts: { time: UTCTimestamp; value: number }[] = [];
  const times = rep.equityTimes;
  for (let i = 0; i < rep.equity.length; i++) {
    const time = toChartTime(times[i] / 1000);
    if (rep.equity[i] === rep.equity[i]) pts.push({ time, value: rep.equity[i] });
    const h = rep.buyHoldEquity[i];
    if (h === h) holdPts.push({ time, value: h });
  }
  hold.setData(holdPts);
  line.setData(pts);
  chart.timeScale().fitContent();

  // the rest, as a short list
  const stats = el("div", "pine-stats");
  const stat = (k: string, v: string, cls = "") => {
    const r = el("div", "pine-stat");
    r.append(el("span", "pine-stat-k", k), el("span", cls, v));
    stats.append(r);
  };
  // left: per trade; right: against holding, costs, capital
  stat("平均每筆", t.length ? signedAmount(rep.netProfit / t.length) : "—", t.length ? signCls(rep.netProfit) : "");
  stat("最大單筆獲利", wins.length ? signedAmount(Math.max(...wins.map((x) => x.profit))) : "—");
  stat("最大單筆虧損", losses.length ? signedAmount(Math.min(...losses.map((x) => x.profit))) : "—");
  stat("未平倉損益", signedAmount(rep.openProfit), signCls(rep.openProfit));
  stat("買進持有", signedPct(rep.buyHold), signCls(rep.buyHold));
  stat("手續費", amount(rep.commission));
  stat("初始資金", amount(rep.initialCapital));
  body.append(stats);

  body.append(el("div", "pop-section", `交易紀錄（新的在上面${t.length > 300 ? "，只列最近 300 筆" : ""}）`));
  const tbl = el("table", "pine-trades");
  const head = el("tr");
  for (const h of ["#", "方向", "進場", "進場價", "出場", "出場價", "數量", "損益", "%"]) head.append(el("th", "", h));
  tbl.append(head);
  const fmtT = (ms: number) => {
    const d = new Date(ms);
    const p = (x: number) => String(x).padStart(2, "0");
    return `${d.getFullYear() % 100}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const px = (v: number) => Number(v.toPrecision(8)).toString();
  const list = t.slice(-300).reverse();
  list.forEach((x, k) => {
    const tr = el("tr");
    const no = t.length - k;
    const pctV = (x.profit / (x.entryPrice * x.qty)) * 100;
    tr.append(
      el("td", "muted", String(no)),
      el("td", x.dir === 1 ? "up" : "down", x.dir === 1 ? "多" : "空"),
      el("td", "", `${fmtT(x.entryTime)} ${x.entryId}`),
      el("td", "", px(x.entryPrice)),
      el("td", "", `${fmtT(x.exitTime)} ${x.exitId}`),
      el("td", "", px(x.exitPrice)),
      el("td", "", Number(x.qty.toFixed(6)).toString()),
      el("td", signCls(x.profit), signedMoney(x.profit)),
      el("td", signCls(x.profit), signedPct(pctV)),
    );
    tbl.append(tr);
  });
  if (!t.length) {
    const tr = el("tr");
    const td = el("td", "muted", "還沒有平倉的交易");
    td.colSpan = 9;
    tr.append(td);
    tbl.append(tr);
  }
  const scroller = el("div", "pine-trades-box");
  scroller.append(tbl);
  body.append(scroller);
  if (rep.open.length) {
    const o = rep.open;
    body.append(el("div", "pop-note", `持倉中：${o.map((x) => `${x.dir === 1 ? "多" : "空"} ${Number(x.qty.toFixed(6))} @ ${px(x.price)}（${x.entryId}）`).join("，")}`));
  }
  return chart;
}

