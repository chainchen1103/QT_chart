// The position tool: R lines, colors, defaults for new positions, and one position's prices (entry, stop-loss,
// take-profit), capital, risk and leverage. Each change is applied and saved at once through the callbacks;
// nothing waits for an OK button. Typed prices that don't make a position together yet (a long's entry moved
// above its stop before the stop is typed) wait, marked, until they do.

import { fmtChange } from "../../core/format.ts";
import { parseR, positionDir, rewardRisk } from "../../drawings/geometry.ts";
import {
  clone,
  DEFAULT_POSITION,
  MAX_R_LEVELS,
  POSITION_LIMITS,
  type PositionDrawing,
  type PositionSettings,
} from "../../settings/model.ts";
import { checkPrices, fmtMoney, fmtQty, type PositionPrices, type PositionResult, type RiskMode } from "../../drawings/trade.ts";
import { checkbox, colorInput, el, flagBad, labelled, lbl, numInput, textButton } from "../dom.ts";
import { closePopover, popoverAt, togglePopover, type Render } from "../popover.ts";

export type PositionIo = {
  get: () => PositionSettings;
  set: (v: PositionSettings) => void;
  /** The trading account's equity (null or missing: no API set). */
  apiEquity?: () => number | null;
};
/** One position opened from the chart: its own prices, capital, risk and leverage, and how it turned out. */
export type OnePosition = {
  drawing: PositionDrawing;
  trade: () => PositionResult | undefined;
  update: (p: Partial<Pick<PositionDrawing, "capital" | "risk" | "riskMode" | "leverage">>) => void;
  setPrices: (p: PositionPrices) => void;
  /** A price on the symbol's price step, and as plain digits for a box. */
  roundPrice: (p: number) => number;
  priceText: (p: number) => string;
  remove: () => void;
};

type PriceKey = keyof PositionPrices;
const PRICE_ROWS: { key: PriceKey; name: string; title: string }[] = [
  { key: "entry", name: "進場", title: "進場價：當成掛單，K 線碰到就成交" },
  { key: "stop", name: "止損", title: "止損價：多單在進場價下面，空單在上面" },
  { key: "target", name: "止盈", title: "止盈價：多單在進場價上面，空單在下面" },
];
/** Prices typed but not applied yet (they don't make a position with the others). */
type Typed = Partial<Record<PriceKey, string>>;

/**
 * Entry, stop-loss and take-profit boxes. A typed price is put on the price step and applied once the three
 * make a position; until then it stays in its box, red, with what is wrong below. Beside each box (while no
 * price waits): the direction, how far the stop and take-profit are from the entry, and how many R the
 * take-profit is.
 */
function priceRows(one: OnePosition, typed: Typed, applied: () => void): HTMLElement[] {
  const d = one.drawing;
  const now: PositionPrices = { entry: d.a.p, stop: d.b.p, target: d.target };
  const boxes = new Map<PriceKey, HTMLInputElement>();
  const infos: HTMLElement[] = [];
  const msg = el("div", "pop-msg");
  /** The prices with the typed ones in place: what to apply, or what is wrong. */
  const merged = (): { prices: PositionPrices } | { error: string } => {
    const p = { ...now };
    for (const { key } of PRICE_ROWS) {
      const s = typed[key];
      if (s == null) continue;
      const v = Number(s);
      if (s.trim() === "" || !Number.isFinite(v) || v <= 0) return { error: "價格要是大於 0 的數字" };
      p[key] = one.roundPrice(v);
    }
    const error = checkPrices(p);
    return error ? { error } : { prices: p };
  };
  const mark = () => {
    for (const [k, b] of boxes) b.classList.toggle("bad", typed[k] != null);
    const waiting = Object.keys(typed).length > 0;
    for (const s of infos) s.hidden = waiting; // they describe the position as it is, about to change
    const m = waiting ? merged() : null;
    msg.textContent = m && "error" in m ? `${m.error}。紅框的價格還沒套用。` : "";
  };
  const pct = (p: number) => fmtChange((p - now.entry) / now.entry);
  // the last add of a position built up by adds: its stop and take-profit are the whole position's
  const sc = one.trade()?.scale;
  const whole = sc && sc.step === sc.count ? sc : null;
  const side = positionDir(now.entry, now.stop) === 1 ? "多單" : "空單";
  const info: Record<PriceKey, string> = {
    entry: whole ? `${side}加倉` : side,
    stop: pct(now.stop),
    target: whole
      ? `${pct(now.target)}　整筆 ${whole.risk > 0 ? `${(whole.reward / whole.risk).toFixed(2)} R` : "止損也獲利"}`
      : `${pct(now.target)}　${rewardRisk(now.entry, now.stop, now.target).toFixed(2)} R`,
  };
  const rows: HTMLElement[] = [];
  for (const { key, name, title } of PRICE_ROWS) {
    const box = el("input", "pos-price");
    box.type = "number";
    box.step = "any";
    box.min = "0";
    box.title = title;
    box.dataset.key = key;
    box.value = typed[key] ?? one.priceText(now[key]);
    box.onkeydown = (e) => {
      if (e.key === "Enter") box.blur();
    };
    box.onchange = () => {
      typed[key] = box.value;
      const m = merged();
      if ("error" in m) {
        mark();
        return;
      }
      for (const k of Object.keys(typed)) delete typed[k as PriceKey];
      one.setPrices(m.prices);
      applied();
    };
    boxes.set(key, box);
    const note = lbl(info[key]);
    infos.push(note);
    const row = el("div", "pop-row");
    row.append(lbl(name), box, note);
    rows.push(row);
  }
  mark();
  rows.push(msg);
  const o = d.order;
  if (o && o.state !== "canceled" && o.state !== "mmp_canceled" && o.state !== "missing") {
    rows.push(el("div", "pop-note", "這個倉位已經下單：這裡改的是圖上的價格，OKX 上的委託和止盈止損不會跟著改"));
  }
  return rows;
}

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

export function renderPosition(io: PositionIo, one?: OnePosition, extra?: Render): Render {
  const typed: Typed = {}; // kept across redraws of this window
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
      body.append(...priceRows(one, typed, later));
      const capRow = el("div", "pop-row");
      const auto = d.capital == null;
      const cap = numInput(t ? Math.round(t.capital * 100) / 100 : cur.capital, POSITION_LIMITS.capital, { title: "這筆用多少資金算倉位", width: 96, step: "1", int: false }, (v) =>
        upd({ capital: v }),
      );
      cap.dataset.key = "capital";
      cap.disabled = auto;
      capRow.append(
        lbl("初始資金"),
        cap,
        lbl("U"),
        labelled(checkbox(auto, "", (v) => upd({ capital: v ? null : Number(cap.value) || cur.capital })), "接續前一個倉位", "用前一個倉位結算後的資金"),
      );
      const riskRow = el("div", "pop-row");
      const [riskBox, riskUnit] = riskInputs(d.risk, d.riskMode, (v, m) => upd({ risk: v, riskMode: m }));
      riskBox.dataset.key = "risk";
      riskUnit.dataset.key = "riskMode";
      riskRow.append(lbl("風險"), riskBox, riskUnit);
      const levRow = el("div", "pop-row");
      const lev = numInput(d.leverage, POSITION_LIMITS.leverage, { title: "1～125 倍", width: 64, step: "1", int: false }, (v) => upd({ leverage: v }));
      lev.dataset.key = "leverage";
      levRow.append(lbl("槓桿"), lev, lbl("倍"));
      body.append(capRow, riskRow, levRow);
      if (t) {
        const pl = t.plan;
        const sc = t.scale;
        const money = (v: number) => `${v >= 0 ? "+" : "−"}${fmtMoney(Math.abs(v))} U`;
        const result = (pnl: number) =>
          `結果：${OUTCOME_TEXT[t.outcome.status]}` + (t.outcome.exit != null ? `　${money(pnl)}，資金變成 ${fmtMoney(t.endCapital)} U` : "");
        const size = `數量 ${fmtQty(pl.qty)}　名目 ${fmtMoney(pl.notional)} U　保證金 ${fmtMoney(pl.margin)} U`;
        let lines: string[];
        if (!sc) {
          lines = [size, `最大虧損 ${fmtMoney(pl.riskAmount)} U　止盈獲利 ${fmtMoney(pl.reward)} U`, result(t.pnl)];
        } else if (sc.step < sc.count) {
          lines = [size, `已加倉：這是第 ${sc.step} 筆，整筆改用第 ${sc.count} 筆的止損、止盈，結果看那一筆`];
        } else {
          const after = t.outcome.status === "pending" ? "成交後整筆" : "整筆";
          lines = [
            `加倉${sc.count > 2 ? `（第 ${sc.step} 筆）` : ""}：${size}`,
            `${after}：數量 ${fmtQty(sc.qty)}　均價 ${one.priceText(sc.avg)}`,
            sc.risk > 0
              ? `${after}最大虧損 ${fmtMoney(sc.risk)} U　止盈獲利 ${fmtMoney(sc.reward)} U`
              : `${after}在止損還有 ${money(-sc.risk)} 的獲利　止盈獲利 ${fmtMoney(sc.reward)} U`,
            result(sc.pnl),
          ];
        }
        for (const s of lines) body.append(el("div", "pop-note", s));
        if (sc?.full && sc.step === sc.count) {
          body.append(el("div", "pop-msg", "前面的部位在這個止損就已經虧到這筆設定的風險（或更多），所以這筆不加，數量是 0"));
        }
        if (pl.capped) body.append(el("div", "pop-msg", "保證金超過資金，數量已減到這個槓桿能開的最大值，實際風險會比設定小"));
      }
    } else {
      body.append(el("div", "pop-section", "新倉位的預設"));
      const capRow = el("div", "pop-row");
      const eq = io.apiEquity?.() ?? null;
      const fromApi = eq != null && cur.capitalFromApi;
      const capBox = numInput(fromApi ? Math.round(eq * 100) / 100 : cur.capital, POSITION_LIMITS.capital, { title: "第一個倉位（或不接續時）用的資金", width: 96, step: "1", int: false }, (v) => set({ capital: v }));
      capBox.disabled = fromApi;
      capRow.append(lbl("初始資金"), capBox, lbl("U"));
      if (eq != null) {
        capRow.append(
          labelled(checkbox(cur.capitalFromApi, "", (v) => {
            set({ capitalFromApi: v });
            rerender();
          }), "用 OKX 帳戶權益", "有設定 API 時，初始資金帶入帳戶的 USDT 權益"),
        );
      }
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
    if (!cur.levels.length) body.append(el("div", "pop-note", "還沒有 R 線，在下方輸入"));
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
