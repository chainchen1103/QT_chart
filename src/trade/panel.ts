// Trading windows: the OKX API settings (from the account button at the bottom right), the order window a
// position's 下單 button opens (nothing is sent before 確認下單), and an order's details with 撤單.

import type { Setting } from "../core/setting.ts";
import { fmtClock, shortName } from "../core/format.ts";
import { fmtMoney, type PositionResult } from "../drawings/trade.ts";
import type { PositionDrawing, PositionOrder, PositionSettings, SyncSettings } from "../settings/model.ts";
import type { AccountSync } from "./sync.ts";
import { checkbox, el, labelled, lbl, textButton } from "../ui/dom.ts";
import { readRaw, writeRaw } from "../core/storage.ts";
import { closePopover, popoverAt, POPOVER_CLOSED, togglePopover, type Render } from "../ui/popover.ts";
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
  btn.classList.toggle("failed", acct.usable() && !!error);
  btn.classList.toggle("locked", keys.locked);
  if (!keys.set) {
    btn.textContent = "API 未設定";
    btn.title = "設定 OKX API：從倉位直接下單，倉位資金帶入帳戶權益";
    return;
  }
  if (keys.locked) {
    btn.textContent = `${envText(keys.demo)} 已鎖定`;
    btn.title = "按一下輸入解鎖密碼，才能下單和同步持倉";
    return;
  }
  btn.textContent = `${envText(keys.demo)} ${account ? fmtMoney(account.equity) + " U" : error ? "連線失敗" : "…"}`;
  btn.title = error ? `OKX API：${error}` : `OKX API（${envText(keys.demo)}）：帳戶權益 ${account ? fmtMoney(account.equity) : "…"} USDT，按一下看設定`;
}

// ----------------------------------------------------------------------------- API settings
export function toggleAccountPanel(anchor: HTMLElement, acct: TradeAccount, position: Setting<PositionSettings>) {
  togglePopover(anchor, "below", "交易帳戶（OKX API）", renderAccount(acct, position));
}

const SYNC_TEXT: Record<string, string> = {
  connecting: "連線中…",
  ws: "即時（WebSocket）",
  polling: "改成每 5 秒用 REST 查，WebSocket 連不上",
  error: "出了問題",
  off: "關閉",
};

/** Following the OKX account on the charts: on / off, and how it is going. */
export function renderSync(sync: AccountSync, setting: Setting<SyncSettings>, acct: TradeAccount): Render {
  let following = false;
  /** The status line as last drawn. What the account sends only changes its text, in place: the window it shares
   *  with the account section is never redrawn for it (that would wipe a password being typed there). */
  let statusLine: HTMLElement | null = null;
  const statusText = () => {
    const st = sync.status;
    const e = sync.state;
    // the backend says why: an error, or why the WebSocket couldn't be used while REST is asked instead
    const why = (st.state === "error" || st.state === "polling") && st.detail ? `：${st.detail}` : "";
    return !acct.keys.set
      ? "還沒設定 API"
      : `${SYNC_TEXT[st.state] ?? st.state}${why}` + (e ? `，${e.positions.length} 個持倉、${e.algos.length} 張止損止盈單` : "");
  };
  return (body, rerender) => {
    if (!following) {
      following = true;
      const stop = sync.subscribe(() => {
        if (statusLine?.isConnected) statusLine.textContent = statusText();
      });
      body.addEventListener(POPOVER_CLOSED, () => {
        stop();
        following = false; // the next time the window opens, follow again
      }, { once: true });
    }
    body.append(el("div", "pop-section", "與 OKX 同步"));
    const on = setting.get().on;
    body.append(
      labelled(
        checkbox(on, "", (v) => {
          setting.set({ on: v });
          rerender();
        }),
        "與 OKX 同步持倉和止盈止損",
        "OKX 的私人頻道（WebSocket）即時推送，連不上時每 5 秒用 REST 查一次",
      ),
    );
    statusLine = null;
    if (on) {
      const line = row(lbl("狀態"), statusText());
      statusLine = line.lastElementChild as HTMLElement;
      body.append(line);
    }
    body.append(
      el(
        "div",
        "pop-note",
        "OKX 上的持倉與圖上倉位會進行同步" 
      ),
    );
  };
}

/** The account window's contents (also a section of the settings window, where `extra`, the sync section, comes
 *  before the buttons at the bottom). */
export function renderAccount(acct: TradeAccount, position: Setting<PositionSettings>, extra?: Render): Render {
  let following = false;
  /** The change-password boxes are open; the security notes are shown (kept across redraws). */
  let changing = false;
  let showSafety = false;
  return (body, rerender) => {
    if (!following) {
      // follow the account's refreshes while the window is open, but never while something is being typed
      following = true;
      const stop = acct.subscribe(() => {
        if (acct.keys.set && !typingIn(body)) rerender();
      });
      body.addEventListener(POPOVER_CLOSED, () => {
        stop();
        following = false; // the next time the window opens, follow again
      }, { once: true });
    }
    const safety = () => {
      showSafety = !showSafety;
      rerender();
    };
    if (!acct.keys.set) {
      keyForm(body, acct, rerender, showSafety, safety);
      return;
    }
    if (acct.keys.locked) {
      unlockForm(body, acct, rerender, extra);
      return;
    }
    const { keys, account, error } = acct;
    body.classList.add("trade-form");
    body.append(el("div", `trade-env ${keys.demo ? "demo" : "live"}`, keys.demo ? "模擬盤（OKX 模擬交易）" : "實盤：下單會用真的錢"));
    body.append(row(lbl("API Key"), keys.hint));
    if (!keys.protected) {
      // a key from before unlock passwords
      body.append(el("div", "trade-warn", "這組 API 還沒有解鎖密碼，只有 Windows 帳號保護。設一個解鎖密碼，之後每次開 QT Chart 輸入一次。"));
      passwordForm(body, acct, rerender, false, () => {});
      body.append(safetyLink(showSafety, safety));
      if (showSafety) body.append(safetyNotes());
    }
    if (account) {
      body.append(
        row(lbl("帳戶權益"), `${fmtMoney(account.equity)} U`, lbl("可用"), `${fmtMoney(account.avail)} U`),
        row(lbl("持倉模式"), account.posMode === "long_short_mode" ? "開平倉模式（多空分開）" : "買賣模式（單向）"),
      );
      if (account.acctLv === "1") body.append(el("div", "pop-msg", "這個帳戶是現貨模式，不能開永續合約。請在 OKX 把帳戶模式改成合約模式（單幣種保證金）"));
    }
    if (error) body.append(el("div", "pop-msg", error));
    const p = position.get();
    body.append(
      labelled(
        checkbox(p.capitalFromApi, "", (v) => position.set({ ...position.get(), capitalFromApi: v })),
        "倉位的初始資金用帳戶權益",
        "不勾就用倉位設定裡填的預設資金",
      ),
      el("div", "pop-note", "下單：在倉位右邊按「下單」，確認後才會送出。止損一定會一起設"),
    );
    if (keys.protected && changing) {
      body.append(el("div", "pop-section", "改解鎖密碼"));
      passwordForm(body, acct, rerender, true, () => {
        changing = false;
        rerender();
      });
    }
    extra?.(body, rerender);
    const foot = el("div", "pop-foot");
    foot.append(textButton("重新整理", "text-btn", () => void acct.refresh()), el("span", "spacer"));
    if (keys.protected) {
      foot.append(
        textButton(changing ? "取消改密碼" : "改解鎖密碼", "text-btn", () => {
          changing = !changing;
          rerender();
        }),
        textButton("上鎖", "text-btn", async () => {
          await acct.lock();
          rerender();
        }, "先把 API 鎖起來，要下單時再輸入解鎖密碼"),
      );
    }
    foot.append(removeButton(acct, rerender));
    body.append(foot);
  };
}

/** A box for a key, a secret or a password (found again by its placeholder when the window is redrawn). */
function keyInput(placeholder: string, secret: boolean, autocomplete: AutoFill = "off"): HTMLInputElement {
  const i = el("input");
  i.type = secret ? "password" : "text";
  i.placeholder = placeholder;
  i.autocomplete = autocomplete;
  i.spellcheck = false;
  i.className = "trade-key";
  i.dataset.key = placeholder;
  return i;
}

/** A key or password box in this window has text or the focus: a redraw now would wipe it. */
function typingIn(body: HTMLElement): boolean {
  return [...body.querySelectorAll<HTMLInputElement>("input.trade-key")].some((i) => i.value !== "" || i === document.activeElement);
}

const MIN_PASSWORD = 8;
/** Why a new unlock password typed twice can't be used, or null. */
function passwordProblem(a: string, b: string): string | null {
  if ([...a].length < MIN_PASSWORD) return `解鎖密碼至少要 ${MIN_PASSWORD} 個字`;
  if (a !== b) return "兩次輸入的解鎖密碼不一樣";
  return null;
}

/** 移除 API: the first press arms it for 3 seconds, the second removes the key from this computer. */
function removeButton(acct: TradeAccount, rerender: () => void, text = "移除 API"): HTMLButtonElement {
  let armed = 0;
  const b = textButton(text, "text-btn danger", async () => {
    if (Date.now() > armed) {
      armed = Date.now() + 3000;
      b.textContent = "再按一次確認移除";
      setTimeout(() => {
        if (Date.now() > armed) b.textContent = text;
      }, 3100);
      return;
    }
    await acct.clearKeys();
    rerender();
  }, "從這台電腦刪掉這組 API，OKX 上的 API 不受影響");
  return b;
}

/** The security notes: how the key is kept, what that can't stop, and what to set on OKX. */
function safetyNotes(): HTMLElement {
  const box = el("div", "trade-safety");
  const part = (title: string, lines: string[]) => {
    box.append(el("div", "trade-safety-title", title));
    const ul = el("ul");
    for (const l of lines) ul.append(el("li", "", l));
    box.append(ul);
  };
  part("金鑰怎麼存", [
    "只存在這台電腦，先用你設的解鎖密碼加密，再用 Windows 帳號加密",
    "每次開 QT Chart 要輸入解鎖密碼，才能下單和同步持倉",
    "金鑰檔被複製走，沒有解鎖密碼也打不開。Secret Key 不會再顯示在畫面上",
    "只會連到 OKX，金鑰不會傳到其他地方",
  ]);
  part("擋不住的情況", ["電腦已經中毒，在你解鎖之後被讀取記憶體或側錄鍵盤。所以 OKX 那邊也要設好限制"]);
  part("在 OKX 建立 API 時", [
    "權限只勾「讀取」和「交易」，不要勾「提現」",
    "綁定這台電腦的 IP，金鑰就算被偷也不能從別的地方用",
    "用子帳戶的 API，子帳戶只放要拿來交易的資金",
    "不再使用或懷疑外洩時，到 OKX 刪掉這組 API",
  ]);
  part("忘記解鎖密碼", ["無法找回，只能移除 API 再重新輸入一次"]);
  return box;
}

function safetyLink(open: boolean, toggle: () => void): HTMLElement {
  const r = el("div", "pop-row");
  r.append(textButton(open ? "收起安全性說明" : "安全性說明", "link-btn", toggle));
  return r;
}

/** The first time an API is added: the security notes first, then the boxes. */
const SAFETY_SEEN = "apiSafetySeen";

function keyForm(body: HTMLElement, acct: TradeAccount, rerender: () => void, showSafety: boolean, toggleSafety: () => void) {
  body.classList.add("trade-form");
  if (readRaw(SAFETY_SEEN) !== "1") {
    body.append(el("div", "pop-note", "設定之前，先看一下 QT Chart 怎麼保護你的 API："), safetyNotes());
    const foot = el("div", "pop-foot");
    foot.append(el("span", "spacer"), textButton("我了解，開始設定", "text-btn primary", () => {
      writeRaw(SAFETY_SEEN, "1");
      rerender();
    }));
    body.append(foot);
    return;
  }
  body.append(el("div", "pop-note", "填你 OKX 帳戶的 API，就能從倉位直接下單，倉位的初始資金也會帶入帳戶權益"), safetyLink(showSafety, toggleSafety));
  if (showSafety) body.append(safetyNotes());
  const key = keyInput("API Key", false);
  const secret = keyInput("Secret Key", true);
  const pass = keyInput("Passphrase：建立 API 時設的密碼", true);
  const pw = keyInput(`解鎖密碼：至少 ${MIN_PASSWORD} 個字`, true, "new-password");
  const pw2 = keyInput("再輸入一次解鎖密碼", true, "new-password");
  let demo = false;
  const env = select<"live" | "demo">({ live: "實盤", demo: "模擬盤（OKX 模擬交易的 API）" }, "live", (v) => (demo = v === "demo"));
  const msg = el("div", "pop-msg");
  const save = textButton("連線並儲存", "text-btn primary", async () => {
    if (!key.value.trim() || !secret.value.trim() || !pass.value) {
      msg.textContent = "API Key、Secret Key、Passphrase 都要填";
      return;
    }
    const bad = passwordProblem(pw.value, pw2.value);
    if (bad) {
      msg.textContent = bad;
      return;
    }
    save.disabled = true;
    save.textContent = "連線中…";
    msg.textContent = "";
    try {
      await acct.setKeys(key.value, secret.value, pass.value, demo, pw.value);
      for (const i of [key, secret, pass, pw, pw2]) i.value = "";
      rerender(); // the boxes (and what was typed in them) are gone
    } catch (e) {
      msg.textContent = String(e);
      save.disabled = false;
      save.textContent = "連線並儲存";
    }
  });
  body.append(row(key), row(secret), row(pass), row(lbl("環境"), env), row(pw), row(pw2), msg);
  body.append(el("div", "pop-note", "先用 OKX 讀一次帳戶確認可以用才存。之後每次開 QT Chart 要輸入解鎖密碼，忘記了只能移除 API 再重新輸入。"));
  const foot = el("div", "pop-foot");
  foot.append(el("span", "spacer"), save);
  body.append(foot);
  setTimeout(() => key.focus(), 0);
}

/** A key saved with a password, not unlocked yet: the password box (asked at every start). */
function unlockForm(body: HTMLElement, acct: TradeAccount, rerender: () => void, extra?: Render) {
  const { keys } = acct;
  body.classList.add("trade-form");
  body.append(el("div", `trade-env ${keys.demo ? "demo" : "live"}`, keys.demo ? "模擬盤（OKX 模擬交易）" : "實盤：下單會用真的錢"));
  body.append(row(lbl("API Key"), keys.hint), el("div", "pop-note", "API 已鎖定：輸入解鎖密碼才能下單和同步持倉"));
  const pw = keyInput("解鎖密碼", true, "current-password");
  const msg = el("div", "pop-msg");
  const go = textButton("解鎖", "text-btn primary", async () => {
    if (!pw.value) {
      msg.textContent = "請輸入解鎖密碼";
      return;
    }
    go.disabled = true;
    go.textContent = "解鎖中…";
    msg.textContent = "";
    try {
      await acct.unlock(pw.value);
      pw.value = "";
      rerender();
    } catch (e) {
      msg.textContent = String(e);
      pw.value = "";
      pw.focus();
      go.disabled = false;
      go.textContent = "解鎖";
    }
  });
  pw.onkeydown = (e) => {
    if (e.key === "Enter" && !go.disabled) go.click();
  };
  body.append(row(pw), msg);
  extra?.(body, rerender);
  const foot = el("div", "pop-foot");
  foot.append(removeButton(acct, rerender, "忘記密碼：移除 API"), el("span", "spacer"), go);
  body.append(foot);
  setTimeout(() => pw.focus(), 0);
}

/** Set an unlock password (a key from before them), or change it (`change`: the current one is asked). */
function passwordForm(body: HTMLElement, acct: TradeAccount, rerender: () => void, change: boolean, done: () => void) {
  const cur = keyInput("目前的解鎖密碼", true, "current-password");
  const pw = keyInput(`新的解鎖密碼：至少 ${MIN_PASSWORD} 個字`, true, "new-password");
  const pw2 = keyInput("再輸入一次新的解鎖密碼", true, "new-password");
  const msg = el("div", "pop-msg");
  const save = textButton(change ? "儲存新密碼" : "設定解鎖密碼", "text-btn primary", async () => {
    const bad = passwordProblem(pw.value, pw2.value);
    if (bad) {
      msg.textContent = bad;
      return;
    }
    if (change && !cur.value) {
      msg.textContent = "請輸入目前的解鎖密碼";
      return;
    }
    save.disabled = true;
    msg.textContent = "";
    try {
      await acct.setPassword(change ? cur.value : null, pw.value);
      for (const i of [cur, pw, pw2]) i.value = "";
      done();
      rerender();
    } catch (e) {
      msg.textContent = String(e);
      save.disabled = false;
    }
  });
  if (change) body.append(row(cur));
  const r = row(pw2);
  r.append(save);
  body.append(row(pw), r, msg);
}

// ----------------------------------------------------------------------------- the order window
export function openOrderWindow(x: number, y: number, s: OrderSpot) {
  let move = true; // an add: move the earlier stops once it fills (kept across redraws)
  popoverAt(x, y, `下單：${shortName(s.instId)}`, (body, rerender) => {
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
    const isAdd = !!t.scale && t.scale.step > 1;
    if (isAdd) {
      const where = `${fp(Number(plan.sl))}${plan.tp != null ? `、${fp(Number(plan.tp))}` : ""}`;
      body.append(
        labelled(
          checkbox(move, "", (v) => {
            move = v;
          }),
          `成交後把前面那筆在 OKX 上的止損${plan.tp != null ? "、止盈" : ""}移到 ${where}`,
          "加倉單成交時才移。那時 QT Chart 要開著，設定裡的「與 OKX 同步」要開",
        ),
        el("div", "pop-note", "這張單只開加倉的部分。成交時 QT Chart 要開著、「與 OKX 同步」要開才會自動移，沒勾的話請自己到 OKX 改。"),
      );
    }
    body.append(el("div", "pop-note", "送出後在圖上拖止損、止盈，會問要不要一起改 OKX（要開「與 OKX 同步」）。進場價不能改，要改請撤單重下。不含手續費。"));
    const msg = el("div", "pop-msg");
    const go = textButton(`確認下單（${envText(demo)}）`, "text-btn " + (demo ? "primary" : "danger-solid"), async () => {
      go.disabled = true;
      go.textContent = "送出中…";
      msg.textContent = "";
      const clOrdId = newClOrdId();
      const algoClOrdId = `qts${clOrdId.slice(3)}`; // its stop-loss / take-profit, to find them again
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
          algoClOrdId,
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
          sl: Number(plan.sl),
          tp: plan.tp == null ? null : Number(plan.tp),
          algoClOrdId,
          ...(isAdd && move ? { moveOnFill: true } : {}),
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
  popoverAt(x, y, `訂單：${shortName(s.instId)}`, (body, rerender) => {
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
    if (other) body.append(el("div", "pop-note", `這張單是用${envText(o.demo)}的 API 下的，現在的 API 查不到它`));
    else body.append(el("div", "pop-note", "止損、止盈在成交後由交易所掛上，可以在 OKX 的「委託」裡看到"));
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
export function withInfo(o: PositionOrder, info: { state: string; avgPx: string; accFillSz: string; fillTime?: string; uTime?: string }): PositionOrder {
  const avg = Number(info.avgPx);
  const fill = Number(info.accFillSz);
  const fillT = Number(info.fillTime) || Number(info.uTime) || 0;
  return {
    ...o,
    state: STATE_TEXT[info.state] && info.state !== "missing" ? info.state : "unknown",
    avgPx: avg > 0 ? avg : o.avgPx,
    fillSz: Number.isFinite(fill) && fill >= 0 ? fill : o.fillSz,
    ...(fill > 0 && fillT > 0 ? { fillT } : {}),
  };
}
