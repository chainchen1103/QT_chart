// Trading windows: the OKX API settings (from the account button at the bottom right), the order window a
// position's 下單 button opens (nothing is sent before 確認下單), and an order's details with 撤單.

import type { Setting } from "../core/setting.ts";
import { fmtClock } from "../core/format.ts";
import { fmtMoney, type PositionResult } from "../drawings/trade.ts";
import type { PositionDrawing, PositionOrder, PositionSettings } from "../settings/model.ts";
import { checkbox, el, labelled, lbl, textButton } from "../ui/dom.ts";
import { closePopover, popoverAt, POPOVER_CLOSED, togglePopover } from "../ui/popover.ts";
import type { TradeAccount } from "./account.ts";
import {
  fmtCoins,
  isOpenState,
  newClOrdId,
  ORD_TYPE_TEXT,
  planOrder,
  TD_MODE_TEXT,
  type ContractSpec,
  type OrderPrefs,
  type OrdType,
  type TdMode,
} from "./model.ts";

/** One position's order: what the order windows need. */
export type OrderSpot = {
  acct: TradeAccount;
  instId: string;
  base: string;
  spec: ContractSpec | null;
  drawing: PositionDrawing;
  trade: PositionResult | undefined;
  last: number | null;
  fmtPrice(p: number): string;
  prefs: Setting<OrderPrefs>;
  /** Keep the order on the position (saved with the drawings); undefined forgets it. */
  record(o: PositionOrder | undefined): void;
  note(text: string): void;
};

export const STATE_TEXT: Record<string, string> = {
  live: "掛單中",
  partially_filled: "部分成交",
  filled: "已成交",
  canceled: "已撤單",
  mmp_canceled: "已撤單（做市保護）",
  unknown: "狀態不明",
  missing: "交易所查不到（太久以前撤掉的單 OKX 不保留，或在另一個帳戶）",
};

/** OKX no longer has the order (its answer to a lookup). */
export const isMissing = (err: unknown) => /\b51603\b/.test(String(err));

const envText = (demo: boolean) => (demo ? "模擬盤" : "實盤");

function row(...items: (string | Node)[]): HTMLElement {
  const r = el("div", "pop-row");
  for (const x of items) r.append(typeof x === "string" ? el("span", "", x) : x);
  return r;
}
function select<T extends string>(options: Record<T, string>, value: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = el("select");
  for (const k of Object.keys(options) as T[]) s.append(new Option(options[k], k, false, k === value));
  s.onchange = () => onChange(s.value as T);
  return s;
}

// ----------------------------------------------------------------------------- the account button
export function paintAccountButton(btn: HTMLElement, acct: TradeAccount) {
  const { keys, account, error } = acct;
  btn.classList.toggle("live", keys.set && !keys.demo);
  btn.classList.toggle("demo", keys.set && keys.demo);
  btn.classList.toggle("failed", keys.set && !!error);
  if (!keys.set) {
    btn.textContent = "API 未設定";
    btn.title = "設定 OKX API：從倉位直接下單，倉位資金帶入帳戶權益";
    return;
  }
  btn.textContent = `${envText(keys.demo)} ${account ? fmtMoney(account.equity) + " U" : error ? "連線失敗" : "…"}`;
  btn.title = error ? `OKX API：${error}` : `OKX API（${envText(keys.demo)}）：帳戶權益 ${account ? fmtMoney(account.equity) : "…"} USDT；按一下看設定`;
}

// ----------------------------------------------------------------------------- API settings
export function toggleAccountPanel(anchor: HTMLElement, acct: TradeAccount, position: Setting<PositionSettings>) {
  let following = false;
  togglePopover(anchor, "below", "交易帳戶（OKX API）", (body, rerender) => {
    if (!following) {
      // follow the account's refreshes while the window is open (not while a key is being typed in)
      following = true;
      const stop = acct.subscribe(() => {
        if (acct.keys.set) rerender();
      });
      body.addEventListener(POPOVER_CLOSED, () => stop(), { once: true });
    }
    if (!acct.keys.set) {
      keyForm(body, acct, rerender);
      return;
    }
    const { keys, account, error } = acct;
    body.append(el("div", `trade-env ${keys.demo ? "demo" : "live"}`, keys.demo ? "模擬盤（OKX 模擬交易）" : "實盤：下單會用真的錢"));
    body.append(row(lbl("API Key"), keys.hint));
    if (account) {
      body.append(
        row(lbl("帳戶權益"), `${fmtMoney(account.equity)} U`, lbl("可用"), `${fmtMoney(account.avail)} U`),
        row(lbl("持倉模式"), account.posMode === "long_short_mode" ? "開平倉模式（多空分開）" : "買賣模式（單向）"),
      );
      if (account.acctLv === "1") body.append(el("div", "pop-msg", "這個帳戶是現貨模式，不能開永續合約；請在 OKX 把帳戶模式改成合約模式（單幣種保證金）"));
    }
    if (error) body.append(el("div", "pop-msg", error));
    const p = position.get();
    body.append(
      labelled(
        checkbox(p.capitalFromApi, "", (v) => position.set({ ...position.get(), capitalFromApi: v })),
        "倉位的初始資金用帳戶權益",
        "不勾就用倉位設定裡填的預設資金",
      ),
      el("div", "pop-note", "下單：在倉位右邊按「下單」，確認後才會送出；止損一定會一起設。"),
    );
    const foot = el("div", "pop-foot");
    foot.append(
      textButton("重新整理", "text-btn", () => void acct.refresh()),
      el("span", "spacer"),
      textButton("移除 API", "text-btn danger", async () => {
        await acct.clearKeys();
        rerender();
      }, "從這台電腦刪掉這組 API（OKX 上的 API 不受影響）"),
    );
    body.append(foot);
  });
}

function keyForm(body: HTMLElement, acct: TradeAccount, rerender: () => void) {
  body.classList.add("trade-form");
  body.append(
    el("div", "pop-note", "填你 OKX 帳戶的 API，就能從倉位直接下單，倉位的初始資金也會帶入帳戶權益。"),
    el("div", "pop-note", "到 OKX「API 管理」建立：權限只勾「交易」，不要勾「提現」；最好綁定這台電腦的 IP。手單建議用子帳戶的 API。"),
  );
  const input = (placeholder: string, secret: boolean) => {
    const i = el("input");
    i.type = secret ? "password" : "text";
    i.placeholder = placeholder;
    i.autocomplete = "off";
    i.spellcheck = false;
    i.className = "trade-key";
    return i;
  };
  const key = input("API Key", false);
  const secret = input("Secret Key", true);
  const pass = input("Passphrase（建立 API 時設的密碼）", true);
  let demo = false;
  const env = select<"live" | "demo">({ live: "實盤", demo: "模擬盤（OKX 模擬交易的 API）" }, "live", (v) => (demo = v === "demo"));
  const msg = el("div", "pop-msg");
  const save = textButton("連線並儲存", "text-btn", async () => {
    if (!key.value.trim() || !secret.value.trim() || !pass.value) {
      msg.textContent = "三個都要填";
      return;
    }
    save.disabled = true;
    save.textContent = "連線中…";
    msg.textContent = "";
    try {
      await acct.setKeys(key.value, secret.value, pass.value, demo);
      rerender(); // the boxes (and what was typed in them) are gone
    } catch (e) {
      msg.textContent = String(e);
      save.disabled = false;
      save.textContent = "連線並儲存";
    }
  });
  body.append(row(key), row(secret), row(pass), row(lbl("環境"), env), msg);
  body.append(el("div", "pop-note", "先用 OKX 讀一次帳戶確認可以用才存。金鑰用 Windows 加密存在這台電腦，只有程式本身讀得到，畫面上不會再顯示。"));
  const foot = el("div", "pop-foot");
  foot.append(el("span", "spacer"), save);
  body.append(foot);
  setTimeout(() => key.focus(), 0);
}

// ----------------------------------------------------------------------------- the order window
export function openOrderWindow(x: number, y: number, s: OrderSpot) {
  popoverAt(x, y, `下單：${s.instId}`, (body, rerender) => {
    const { acct, drawing: d, trade: t } = s;
    const prefs = s.prefs.get();
    const demo = acct.keys.demo;
    body.classList.add("order-pop");
    body.append(el("div", `trade-env ${demo ? "demo" : "live"}`, demo ? "模擬盤（OKX 模擬交易）" : "實盤：會用真的錢下單"));
    if (!t || !s.spec) {
      body.append(el("div", "pop-msg", !s.spec ? "讀不到這個幣種的合約資料，請稍後再試" : "這個倉位還算不出數量（K 線還沒載入）"));
      return;
    }
    const plan = planOrder({
      instId: s.instId,
      entry: d.a.p,
      stop: d.b.p,
      target: d.target,
      qty: t.plan.qty,
      leverage: d.leverage,
      last: s.last,
      avail: acct.account?.avail ?? null,
      spec: s.spec,
      prefs,
    });
    if (acct.account?.acctLv === "1") plan.problems.push("這個 OKX 帳戶是現貨模式，不能開永續合約");
    const long = plan.side === "buy";
    const fp = s.fmtPrice;
    const setPrefs = (p: Partial<OrderPrefs>) => {
      s.prefs.set({ ...s.prefs.get(), ...p });
      rerender();
    };

    body.append(row(el("span", `order-side ${long ? "up" : "down"}`, long ? "多單（買入開多）" : "空單（賣出開空）")));
    body.append(
      row(
        lbl("類型"),
        select<OrdType>(ORD_TYPE_TEXT, prefs.ordType, (v) => setPrefs({ ordType: v })),
        lbl("保證金模式"),
        select<TdMode>(TD_MODE_TEXT, prefs.tdMode, (v) => setPrefs({ tdMode: v })),
      ),
      row(lbl("價格"), plan.px == null ? `市價（現價約 ${s.last != null ? fp(s.last) : "—"}）` : fp(Number(plan.px))),
      row(lbl("數量"), `${plan.sz} 張（${fmtCoins(plan.coins)} ${s.base}）`, lbl("槓桿"), `${d.leverage}x`),
      row(lbl("名目"), `${fmtMoney(plan.notional)} U`, lbl("保證金"), `${fmtMoney(plan.margin)} U`, ...(acct.account ? [lbl("可用"), `${fmtMoney(acct.account.avail)} U`] : [])),
      row(lbl("止損"), `${fp(Number(plan.sl))}`, el("span", "pop-lbl", "一定會一起設，碰到後市價平倉")),
      labelled(
        checkbox(prefs.attachTp, "", (v) => setPrefs({ attachTp: v })),
        `止盈 ${fp(d.target)}`,
        "一起設止盈，碰到後市價平倉",
      ),
      row(lbl("最大虧損"), `約 ${fmtMoney(plan.risk)} U`, ...(acct.account ? [el("span", "pop-lbl", `（帳戶權益的 ${((plan.risk / Math.max(1e-9, acct.account.equity)) * 100).toFixed(2)}%）`)] : [])),
    );
    for (const p of plan.problems) body.append(el("div", "pop-msg", p));
    for (const w of plan.warnings) body.append(el("div", "trade-warn", w));
    body.append(el("div", "pop-note", "送出後在圖上移動這個倉位不會改到交易所的單；要改請先撤單再重新下。不含手續費。"));
    const msg = el("div", "pop-msg");
    const go = textButton(`確認下單（${envText(demo)}）`, "text-btn " + (demo ? "primary" : "danger-solid"), async () => {
      go.disabled = true;
      go.textContent = "送出中…";
      msg.textContent = "";
      const clOrdId = newClOrdId();
      try {
        const r = await acct.place({
          instId: s.instId,
          side: plan.side,
          ordType: prefs.ordType,
          px: plan.px,
          sz: plan.sz,
          tdMode: prefs.tdMode,
          lever: d.leverage,
          tp: plan.tp,
          sl: plan.sl,
          clOrdId,
        });
        s.record({
          ordId: r.ordId,
          clOrdId,
          demo,
          side: plan.side,
          ordType: prefs.ordType,
          px: plan.px == null ? null : Number(plan.px),
          sz: plan.contracts,
          at: Date.now() / 1000,
          state: "live",
          avgPx: null,
          fillSz: 0,
        });
        closePopover();
        s.note(`已送出：${s.base} ${long ? "多單" : "空單"} ${ORD_TYPE_TEXT[prefs.ordType]} ${plan.sz} 張（訂單 ${r.ordId}）`);
      } catch (e) {
        msg.textContent = String(e);
        go.disabled = false;
        go.textContent = `確認下單（${envText(demo)}）`;
      }
    });
    go.disabled = plan.problems.length > 0;
    const foot = el("div", "pop-foot");
    foot.append(textButton("取消", "text-btn", () => closePopover()), el("span", "spacer"), go);
    body.append(msg, foot);
  });
}

// ----------------------------------------------------------------------------- an order's details
export function openOrderDetails(x: number, y: number, s: OrderSpot) {
  popoverAt(x, y, `訂單：${s.instId}`, (body, rerender) => {
    const o = s.drawing.order;
    if (!o) {
      closePopover();
      return;
    }
    const fp = s.fmtPrice;
    const other = o.demo !== s.acct.keys.demo || !s.acct.keys.set;
    body.append(
      el("div", `trade-env ${o.demo ? "demo" : "live"}`, envText(o.demo)),
      row(lbl("狀態"), STATE_TEXT[o.state] ?? o.state),
      row(
        el("span", `order-side ${o.side === "buy" ? "up" : "down"}`, o.side === "buy" ? "多單" : "空單"),
        ORD_TYPE_TEXT[o.ordType],
        o.px != null ? fp(o.px) : "",
        `× ${fmtCoins(o.sz)} 張`,
      ),
    );
    if (o.fillSz > 0) body.append(row(lbl("已成交"), `${fmtCoins(o.fillSz)} 張`, ...(o.avgPx ? [lbl("均價"), fp(o.avgPx)] : [])));
    body.append(row(lbl("下單時間"), fmtClock(o.at)), row(lbl("訂單編號"), o.ordId));
    if (other) body.append(el("div", "pop-note", `這張單是用${envText(o.demo)}的 API 下的，現在的 API 查不到它。`));
    else body.append(el("div", "pop-note", "止損、止盈在成交後由交易所掛上，可以在 OKX 的「委託」裡看到。"));
    const msg = el("div", "pop-msg");
    const busy = (b: HTMLButtonElement, text: string, job: () => Promise<void>) => async () => {
      const was = b.textContent;
      b.disabled = true;
      b.textContent = text;
      msg.textContent = "";
      try {
        await job();
        rerender();
      } catch (e) {
        msg.textContent = String(e);
        b.disabled = false;
        b.textContent = was;
      }
    };
    const refreshFrom = async () => {
      try {
        s.record(withInfo(o, await s.acct.order(s.instId, o.ordId)));
      } catch (e) {
        if (!isMissing(e)) throw e;
        s.record({ ...o, state: "missing" });
      }
    };
    const foot = el("div", "pop-foot");
    if (!other) {
      if (isOpenState(o.state)) {
        const cancel = textButton("撤單", "text-btn danger", () => undefined);
        cancel.onclick = busy(cancel, "撤單中…", async () => {
          await s.acct.cancel(s.instId, o.ordId);
          await refreshFrom();
        });
        foot.append(cancel);
      }
      const again = textButton("重新整理", "text-btn", () => undefined);
      again.onclick = busy(again, "查詢中…", refreshFrom);
      foot.append(again);
    }
    foot.append(
      el("span", "spacer"),
      textButton("移除紀錄", "link-btn", () => {
        s.record(undefined);
        closePopover();
      }, isOpenState(o.state) && !other ? "只從圖上移除，交易所的單還在" : "從圖上移除這筆紀錄，倉位又可以下單"),
    );
    body.append(msg, foot);
  });
}

/** The order with what OKX says about it now. */
export function withInfo(o: PositionOrder, info: { state: string; avgPx: string; accFillSz: string }): PositionOrder {
  const avg = Number(info.avgPx);
  const fill = Number(info.accFillSz);
  return {
    ...o,
    state: STATE_TEXT[info.state] && info.state !== "missing" ? info.state : "unknown",
    avgPx: avg > 0 ? avg : o.avgPx,
    fillSz: Number.isFinite(fill) && fill >= 0 ? fill : o.fillSz,
  };
}
