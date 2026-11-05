// 設定 → 資料: 清除所有資料, a fresh start. The tabs and layouts, the drawings, alerts, Pine scripts and settings,
// the OKX API key and the AI connection's token are deleted from this computer, then the app starts again as on
// its first run. Asked twice: the button shows what will go, and only typing 清除 lets it go ahead.

import { el, textButton } from "../dom.ts";
import type { Render } from "../popover.ts";

export type DataIo = {
  /** Delete everything; the app starts again on its own once it is done. */
  wipe(): Promise<void>;
};

/** What has to be typed to go ahead. */
export const WIPE_WORD = "清除";

const GONE = ["分頁、版面和所有畫線", "價格提醒、Pine 腳本和所有設定", "OKX API 金鑰和 AI 連線的權杖"];

export function renderData(io: DataIo): Render {
  let asking = false;
  let error = "";
  return (body, rerender) => {
    body.append(el("div", "pop-section", "清除所有資料"));
    const list = el("ul", "data-list");
    for (const t of GONE) list.append(el("li", "", t));
    body.append(
      el("div", "pop-note", "從這台電腦刪除以下資料，無法復原"),
      list,
      el("div", "pop-note", "OKX 網站上的 API、倉位和訂單不受影響"),
    );
    if (!asking) {
      const row = el("div", "pop-row");
      row.append(textButton("清除所有資料…", "text-btn danger", () => {
        asking = true;
        error = "";
        rerender();
      }));
      body.append(row);
      return;
    }
    const box = el("div", "data-confirm");
    box.append(el("div", "trade-warn", "確定要清除？所有資料都會刪除，清除後程式會重新啟動"));
    const row = el("div", "pop-row");
    const word = el("input", "data-word");
    word.type = "text";
    word.placeholder = `輸入「${WIPE_WORD}」`;
    word.title = `輸入「${WIPE_WORD}」才能清除`;
    word.autocomplete = "off";
    word.spellcheck = false;
    word.dataset.key = "data-word";
    const msg = el("div", "pop-msg", error);
    let busy = false;
    const go = textButton("全部清除", "text-btn danger-solid", async () => {
      if (busy || word.value.trim() !== WIPE_WORD) return;
      busy = true;
      go.disabled = true;
      word.disabled = true;
      go.textContent = "清除中…";
      try {
        await io.wipe();
        showRestarting();
      } catch (e) {
        error = `清除沒有完成：${e instanceof Error ? e.message : String(e)}`;
        busy = false;
        rerender();
      }
    });
    go.disabled = true;
    const cancel = textButton("取消", "text-btn", () => {
      asking = false;
      error = "";
      rerender();
    });
    word.oninput = () => (go.disabled = busy || word.value.trim() !== WIPE_WORD);
    word.onkeydown = (e) => {
      if (e.key === "Enter") go.click();
    };
    row.append(word, go, cancel);
    box.append(row, msg);
    body.append(box);
    requestAnimationFrame(() => word.focus());
  };
}

/** Over everything while the app starts again: nothing more can be done in this run. */
function showRestarting() {
  const cover = el("div", "wipe-cover");
  cover.append(el("div", "wipe-cover-text", "已清除所有資料，正在重新啟動…"));
  document.body.append(cover);
}
