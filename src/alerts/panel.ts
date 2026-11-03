// Alert windows: the list with the log and options, a new price alert at a point, and the alert section in a
// drawing's settings. Changes go straight to the AlertService; the windows redraw when it changes.

import type { Drawing } from "../settings/model.ts";
import { shortName } from "../core/format.ts";
import { checkbox, el, flagBad, labelled, lbl, textButton } from "../ui/dom.ts";
import { closePopover, popoverAt, POPOVER_CLOSED, togglePopover, type Render } from "../ui/popover.ts";
import { COND_TEXT, condsFor, MAX_NOTE, oneShot, REPEAT_TEXT, type Alert, type AlertCond, type Repeat, type TradeStage } from "./model.ts";
import { STAGE_TEXT, type AlertService } from "./service.ts";

export type AlertUi = {
  service: AlertService;
  /** The symbol and timeframe on screen. */
  instId(): string;
  bar(): string;
  /** Latest price of the symbol on screen. */
  price(): number | null;
  fmtPrice(instId: string, p: number): string;
  /** "11/02 16:23" in local time. */
  fmtClock(t: number): string;
  /** Show this symbol on the chart. */
  open(instId: string): void;
};


// ----------------------------------------------------------------------------- inputs
function select<T extends string>(options: T[], text: Record<T, string>, value: T, onChange: (v: T) => void, title = ""): HTMLSelectElement {
  const s = el("select");
  for (const o of options) s.append(new Option(text[o], o, false, o === value));
  if (title) s.title = title;
  s.onchange = () => onChange(s.value as T);
  return s;
}
const condSelect = (conds: AlertCond[], value: AlertCond, onChange: (v: AlertCond) => void) =>
  select(conds, COND_TEXT, value, onChange, "觸及：從哪一邊碰到都算；突破、跌破：只算往那個方向穿過");
const repeatSelect = (value: Repeat, onChange: (v: Repeat) => void) =>
  select<Repeat>(["once", "every"], REPEAT_TEXT, value, onChange, "只提醒一次：響過就關掉；每次：一直開著，最多每分鐘響一次");

function noteInput(value: string, onCommit: (v: string) => void): HTMLInputElement {
  const i = el("input");
  i.type = "text";
  i.value = value;
  i.maxLength = MAX_NOTE;
  i.placeholder = "備註（可以不填）";
  i.className = "alert-note";
  i.onchange = () => onCommit(i.value.trim());
  i.onkeydown = (e) => {
    if (e.key === "Enter") i.blur();
  };
  return i;
}

/** A price box: a bad entry flashes red and returns null. */
function priceInput(value: number | null, onEnter?: () => void): { box: HTMLInputElement; get: () => number | null } {
  const box = el("input");
  box.type = "number";
  box.step = "any";
  box.min = "0";
  box.className = "alert-price";
  if (value != null) box.value = String(value);
  box.onkeydown = (e) => {
    if (e.key === "Enter") onEnter?.();
  };
  return {
    box,
    get: () => {
      const v = Number(box.value);
      if (box.value.trim() === "" || !Number.isFinite(v) || v <= 0) {
        flagBad(box);
        return null;
      }
      return v;
    },
  };
}

function status(a: Alert, fmtClock: (t: number) => string): string {
  if (a.cond === "trade" && a.on) return STAGE_TEXT[a.stage ?? "wait"];
  if (!a.on) return a.fired != null ? `已響 ${fmtClock(a.fired)}` : "暫停";
  return a.count ? `已響 ${a.count} 次` : "等待中";
}

// ----------------------------------------------------------------------------- the list
/** The alert list (all symbols), the log and the options; from the toolbar button. */
export function toggleAlertManager(anchor: HTMLElement, ui: AlertUi) {
  let editing: string | null = null;
  let listening = false;
  togglePopover(anchor, "below", "提醒", (body, rerender) => {
    if (!listening) {
      listening = true;
      const stop = ui.service.subscribe(() => {
        const typing = document.activeElement && body.contains(document.activeElement) && document.activeElement !== document.body;
        if (!typing) rerender();
      });
      body.addEventListener(POPOVER_CLOSED, stop, { once: true });
    }
    const s = ui.service;
    const inst = ui.instId();
    body.classList.add("alert-pop");

    // new price alert for the symbol on screen
    body.append(el("div", "pop-section", `新增價格提醒：${shortName(inst)}`));
    let cond: AlertCond = "touch";
    let repeat: Repeat = "once";
    const msg = el("div", "pop-msg");
    const price = priceInput(roundish(ui.price()), () => add());
    const note = noteInput("", () => {});
    const add = () => {
      const p = price.get();
      if (p == null) return;
      const r = s.add({ instId: inst, target: { kind: "price", price: p }, cond, repeat, tf: ui.bar(), note: note.value.trim() });
      if (typeof r === "string") msg.textContent = r;
      else rerender();
    };
    const r1 = el("div", "pop-row");
    r1.append(lbl("價格"), price.box, condSelect(condsFor("price"), cond, (v) => (cond = v)));
    const r2 = el("div", "pop-row");
    r2.append(repeatSelect(repeat, (v) => (repeat = v)), note, textButton("新增", "text-btn", add));
    body.append(r1, r2, msg);

    // the list: this symbol first
    const list = [...s.all()].sort((a, b) => Number(b.instId === inst) - Number(a.instId === inst) || a.instId.localeCompare(b.instId));
    body.append(el("div", "pop-section", `全部提醒（${list.length}）`));
    if (!list.length) body.append(el("div", "pop-note", "還沒有提醒。也可以在價格標尺或圖上按右鍵、按 Alt+A，或在畫線的設定裡加。"));
    const rows = el("div", "alert-list");
    for (const a of list) {
      const row = el("div", "alert-row" + (a.on ? "" : " off"));
      const sym = textButton(shortName(a.instId), "alert-sym", () => {
        ui.open(a.instId);
        closePopover();
      }, `在圖上打開 ${shortName(a.instId)}`);
      const label = el("span", "alert-label", s.label(a) + (a.note ? `　${a.note}` : ""));
      label.title = "按一下修改";
      label.onclick = () => {
        editing = editing === a.id ? null : a.id;
        rerender();
      };
      row.append(
        checkbox(a.on, a.on ? "開著：按一下暫停" : "關著：按一下重新開啟", (v) => s.update(a.id, { on: v })),
        sym,
        label,
        el("span", "alert-status", status(a, ui.fmtClock)),
        textButton("×", "pop-del", () => s.remove(a.id), "刪除這個提醒"),
      );
      rows.append(row);
      if (editing === a.id) rows.append(editor(a, ui, () => {
        editing = null;
        rerender();
      }));
    }
    body.append(rows);

    // the log
    const log = s.log();
    body.append(el("div", "pop-section", "紀錄"));
    if (!log.length) body.append(el("div", "pop-note", "還沒有響過"));
    const lr = el("div", "alert-log");
    for (const e of log.slice(0, 30)) {
      const line = el("div", "alert-log-row");
      line.append(el("span", "alert-time", ui.fmtClock(e.t)), el("span", "alert-sym-text", shortName(e.instId)), el("span", "", e.text + (e.note ? `（${e.note}）` : "")));
      lr.append(line);
    }
    body.append(lr);

    const o = s.options();
    const opts = el("div", "pop-row");
    opts.append(
      labelled(checkbox(o.sound, "", (v) => s.setOptions({ ...s.options(), sound: v })), "聲音"),
      labelled(checkbox(o.system, "", (v) => s.setOptions({ ...s.options(), system: v })), "Windows 通知", "視窗在背景時，右下角跳出通知，工作列按鈕也會閃"),
    );
    body.append(opts);
    const foot = el("div", "pop-foot");
    foot.append(el("span", "pop-note", "程式開著（可以縮到最小）才會提醒"), el("span", "spacer"));
    if (log.length) foot.append(textButton("清除紀錄", "link-btn", () => s.clearLog()));
    body.append(foot);
  });
}

/** Edit one alert in place: price (price alerts), condition, repeat, note. */
function editor(a: Alert, ui: AlertUi, done: () => void): HTMLElement {
  const s = ui.service;
  const box = el("div", "alert-edit");
  const row = el("div", "pop-row");
  if (a.target.kind === "price") {
    const price = priceInput(a.target.price, () => save());
    const save = () => {
      const p = price.get();
      if (p != null) s.update(a.id, { target: { kind: "price", price: p } });
    };
    price.box.onchange = save;
    row.append(lbl("價格"), price.box);
  }
  const d = s.drawingOf(a);
  const conds = condsFor(a.target.kind === "price" ? "price" : d?.kind ?? "hline");
  if (conds.length > 1) row.append(condSelect(conds, a.cond, (v) => s.update(a.id, { cond: v })));
  if (!oneShot(a.cond)) row.append(repeatSelect(a.repeat, (v) => s.update(a.id, { repeat: v })));
  const row2 = el("div", "pop-row");
  row2.append(noteInput(a.note, (v) => s.update(a.id, { note: v })), textButton("完成", "text-btn", done));
  box.append(row, row2);
  return box;
}

/** A price with a sensible number of digits for the box. */
function roundish(p: number | null): number | null {
  if (p == null) return null;
  const d = p >= 1000 ? 1 : p >= 1 ? 4 : 8;
  return Number(p.toFixed(d));
}

// ----------------------------------------------------------------------------- a new alert at a point
/** New price alert for the symbol on screen, at `price` (right-click menu, Alt+A). */
export function alertDialogAt(x: number, y: number, ui: AlertUi, price: number | null) {
  popoverAt(x, y, `新增提醒：${shortName(ui.instId())}`, (body) => {
    let cond: AlertCond = "touch";
    let repeat: Repeat = "once";
    const msg = el("div", "pop-msg");
    const p = priceInput(roundish(price), () => make());
    const note = noteInput("", () => {});
    const make = () => {
      const v = p.get();
      if (v == null) return;
      const r = ui.service.add({ instId: ui.instId(), target: { kind: "price", price: v }, cond, repeat, tf: ui.bar(), note: note.value.trim() });
      if (typeof r === "string") msg.textContent = r;
      else closePopover();
    };
    const r1 = el("div", "pop-row");
    r1.append(lbl("價格"), p.box, condSelect(condsFor("price"), cond, (v) => (cond = v)));
    const r2 = el("div", "pop-row");
    r2.append(repeatSelect(repeat, (v) => (repeat = v)), note);
    const foot = el("div", "pop-foot");
    foot.append(el("span", "pop-note", "Enter 建立"), el("span", "spacer"), textButton("建立", "text-btn", make));
    body.append(r1, r2, msg, foot);
    requestAnimationFrame(() => {
      p.box.focus();
      p.box.select();
    });
  });
}

// ----------------------------------------------------------------------------- inside a drawing's settings
const WHAT: Partial<Record<Drawing["kind"], string>> = {
  trend: "價格碰到這條線時提醒；線段畫完之後，照同樣斜率往右延伸",
  info: "價格碰到這條線時提醒；線段畫完之後，照同樣斜率往右延伸",
  angle: "價格碰到這條線時提醒；線段畫完之後，照同樣斜率往右延伸",
  ray: "價格碰到這條射線時提醒",
  extended: "價格碰到這條線時提醒",
  hline: "價格碰到這條水平線時提醒",
  hray: "價格碰到這條水平射線時提醒",
  cross: "價格碰到十字線的水平線時提醒",
  vline: "到了這條垂直線的時間時提醒",
  rect: "價格進入或離開矩形的價格範圍時提醒（右邊界之後也算）",
  fib: "價格碰到任何一條勾選的 Fib 線時提醒",
  position: "價格到進場價時提醒一次，之後碰到止盈或止損再提醒一次",
};

/** Why this drawing can't have an alert, or null. */
function cannot(d: Drawing, stage: TradeStage | null): string | null {
  const now = Date.now() / 1000;
  if (d.kind === "ray" && d.b.t <= d.a.t) return "往左的射線碰不到之後的價格，不能設提醒";
  if ((d.kind === "trend" || d.kind === "info" || d.kind === "angle" || d.kind === "extended") && d.a.t === d.b.t) return "垂直的線沒辦法用價格提醒";
  if (d.kind === "vline" && d.a.t <= now) return "這條垂直線的時間已經過了";
  if (d.kind === "position" && stage === "done") return "這個倉位已經出場了";
  return null;
}

/**
 * The 提醒 section of a drawing's settings. `stage`: for a position, where it stands on the chart now
 * ("done" once it hit its stop or take-profit), so an alert made after the entry waits for the exit.
 */
export function drawingAlertSection(ui: AlertUi, d: Drawing, stage: () => TradeStage | null): Render {
  return (body, rerender) => {
    const s = ui.service;
    const inst = ui.instId();
    body.append(el("div", "pop-section", "提醒"));
    body.append(el("div", "pop-note", WHAT[d.kind] ?? ""));
    const a = s.forDrawing(inst, d.id);
    const conds = condsFor(d.kind);
    if (!a) {
      const why = cannot(d, stage());
      if (why) {
        body.append(el("div", "pop-msg", why));
        return;
      }
      let cond = conds[0];
      let repeat: Repeat = "once";
      const row = el("div", "pop-row");
      if (conds.length > 1) row.append(condSelect(conds, cond, (v) => (cond = v)));
      if (!oneShot(cond)) row.append(repeatSelect(repeat, (v) => (repeat = v)));
      const note = noteInput("", () => {});
      const msg = el("div", "pop-msg");
      const row2 = el("div", "pop-row");
      row2.append(note, textButton("設提醒", "text-btn", () => {
        const r = s.add({ instId: inst, target: { kind: "drawing", id: d.id }, cond, repeat, tf: ui.bar(), note: note.value.trim(), stage: stage() ?? undefined });
        if (typeof r === "string") msg.textContent = r;
        else rerender();
      }));
      if (row.childElementCount) body.append(row);
      body.append(row2, msg);
      return;
    }
    const row = el("div", "pop-row");
    row.append(
      labelled(checkbox(a.on, "", (v) => {
        s.update(a.id, { on: v });
        rerender();
      }), "開啟"),
      el("span", "alert-status", status(a, ui.fmtClock)),
    );
    if (conds.length > 1) row.append(condSelect(conds, a.cond, (v) => s.update(a.id, { cond: v })));
    if (!oneShot(a.cond)) row.append(repeatSelect(a.repeat, (v) => s.update(a.id, { repeat: v })));
    const row2 = el("div", "pop-row");
    row2.append(noteInput(a.note, (v) => s.update(a.id, { note: v })), textButton("刪除提醒", "text-btn danger", () => {
      s.remove(a.id);
      rerender();
    }));
    body.append(row, row2);
  };
}
