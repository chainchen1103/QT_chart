// 設定 → AI 連線: the MCP server on or off, its port and token, what AI apps may do (read always, change the
// charts, trade) and when an order waits for the user's OK, how to set up an app, and the last calls.

import type { Setting } from "../../core/setting.ts";
import { fmtClock } from "../../core/format.ts";
import type { McpHost } from "../../mcp/host.ts";
import { CONFIRM_MODES, type ConfirmMode, type McpSettings } from "../../mcp/model.ts";
import { checkbox, el, isTextEntry, labelled, lbl, numInput, textButton } from "../dom.ts";
import { POPOVER_CLOSED, type Render } from "../popover.ts";

export type McpUi = { setting: Setting<McpSettings>; host: McpHost };

const TOOL_TEXT: Record<string, string> = {
  get_app_state: "讀取狀態", list_symbols: "幣種清單", get_candles: "讀 K 線", get_chart_image: "圖表截圖", list_drawings: "讀畫線",
  get_indicators: "讀指標", list_alerts: "讀提醒", get_account: "讀帳戶", list_pine_scripts: "讀 Pine 腳本", get_settings: "讀設定",
  set_chart: "換圖表", set_layout: "改版面", manage_tabs: "分頁", replay: "K 線重播", add_drawing: "畫線", update_drawing: "改畫線",
  delete_drawings: "刪畫線", undo_drawings: "還原畫線", save_alert: "設提醒", delete_alert: "刪提醒", save_pine_script: "存 Pine 腳本",
  delete_pine_script: "刪 Pine 腳本", update_settings: "改設定", place_order: "下單", cancel_order: "撤單", amend_order: "改掛單", move_stops: "改止損止盈",
};

async function copy(text: string, b: HTMLButtonElement) {
  const was = b.textContent;
  try {
    await navigator.clipboard.writeText(text);
    b.textContent = "已複製";
  } catch {
    b.textContent = "複製失敗";
  }
  setTimeout(() => (b.textContent = was), 1500);
}

/** A block of text to paste into an app's settings, with a copy button (`shown`: the text with the token hidden,
 *  `text` is what is copied). */
function snippet(title: string, text: string, shown = text): HTMLElement {
  const box = el("div", "mcp-snippet");
  const head = el("div", "mcp-snippet-head");
  const b = textButton("複製", "link-btn", () => void copy(text, b));
  head.append(el("span", "", title), b);
  const pre = el("pre", "mcp-code", shown);
  box.append(head, pre);
  return box;
}

/** How each app is set up: where its MCP settings are, and what goes there. */
type ClientSetup = { key: string; name: string; where: string; make(o: { url: string; exe: string; token: string }): string };
const json = (v: unknown) => JSON.stringify(v, null, 2);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const CLIENTS: ClientSetup[] = [
  {
    key: "claude-desktop", name: "Claude Desktop", where: "設定 → 開發者 → 編輯設定，貼上後重開 Claude",
    make: ({ exe }) => json({ mcpServers: { qtchart: { command: exe, args: ["--mcp-stdio"] } } }),
  },
  { key: "claude-code", name: "Claude Code", where: "在終端機執行", make: ({ url, token }) => `claude mcp add --transport http qtchart ${url} --header "Authorization: Bearer ${token}"` },
  { key: "cursor", name: "Cursor", where: "貼進 ~/.cursor/mcp.json", make: ({ url, token }) => json({ mcpServers: { qtchart: { url, headers: bearer(token) } } }) },
  { key: "vscode", name: "VS Code", where: "貼進專案的 .vscode/mcp.json", make: ({ url, token }) => json({ servers: { qtchart: { type: "http", url, headers: bearer(token) } } }) },
  { key: "windsurf", name: "Windsurf", where: "貼進 Windsurf 的 mcp_config.json", make: ({ url, token }) => json({ mcpServers: { qtchart: { serverUrl: url, headers: bearer(token) } } }) },
  { key: "gemini", name: "Gemini CLI", where: "貼進 ~/.gemini/settings.json", make: ({ url, token }) => json({ mcpServers: { qtchart: { httpUrl: url, headers: bearer(token) } } }) },
  { key: "codex", name: "Codex CLI", where: "加到 ~/.codex/config.toml", make: ({ exe }) => `[mcp_servers.qtchart]\ncommand = ${JSON.stringify(exe)}\nargs = ["--mcp-stdio"]` },
  { key: "stdio", name: "其他：啟動程式", where: "啟動這個程式，加上 --mcp-stdio", make: ({ exe }) => json({ command: exe, args: ["--mcp-stdio"] }) },
  { key: "http", name: "其他：網址", where: "連這個網址，帶上這個標頭", make: ({ url, token }) => `${url}\nAuthorization: Bearer ${token}` },
];
/** The app picked last (while QT Chart runs). */
let client = CLIENTS[0].key;

export function renderMcp(ui: McpUi): Render {
  let following = false;
  let showToken = false;
  /** Drawn last: updated in place when the server or the calls change (a redraw would wipe the port being typed). */
  let statusLine: HTMLElement | null = null;
  let callList: HTMLElement | null = null;

  const statusText = () => {
    const st = ui.host.status;
    if (!ui.setting.get().on) return "關閉";
    if (!st) return "啟動中…";
    if (st.error) return st.error;
    return st.running ? `執行中，http://127.0.0.1:${st.port}/mcp` : "沒有在執行";
  };
  const fillCalls = (box: HTMLElement) => {
    box.replaceChildren();
    const calls = ui.host.calls();
    if (!calls.length) {
      box.append(el("div", "pop-note", "還沒有 AI 應用程式呼叫過"));
      return;
    }
    for (const c of calls.slice(0, 12)) {
      const row = el("div", `mcp-call ${c.ok ? "" : "bad"}`);
      row.append(
        el("span", "mcp-call-time", fmtClock(c.time)),
        el("span", "mcp-call-app", c.client || "AI 應用程式"),
        el("span", `mcp-call-tool ${c.level}`, TOOL_TEXT[c.tool] ?? c.tool),
        el("span", "mcp-call-text", c.text || (c.ok ? "完成" : "失敗")),
      );
      box.append(row);
    }
  };

  /** The server as drawn last: when it changes (started, stopped, another port or token) the section is drawn
   *  again, unless something is being typed in it; new calls only refill their list. */
  const serverKey = () => JSON.stringify(ui.host.status);
  let drawnFor = "";

  return (body, rerender) => {
    drawnFor = serverKey();
    if (!following) {
      following = true;
      const stop = ui.host.subscribe(() => {
        if (serverKey() !== drawnFor && !(isTextEntry(document.activeElement) && body.contains(document.activeElement))) {
          rerender();
          return;
        }
        if (statusLine?.isConnected) statusLine.textContent = statusText();
        if (callList?.isConnected) fillCalls(callList);
      });
      body.addEventListener(POPOVER_CLOSED, () => {
        stop();
        following = false;
      }, { once: true });
    }
    const s = ui.setting.get();
    const set = (p: Partial<McpSettings>) => {
      ui.setting.set({ ...ui.setting.get(), ...p });
      rerender();
    };
    const st = ui.host.status;
    const port = st?.running ? st.port : s.port;
    const token = st?.token ?? "";

    // ------------------------------------------------------------------- the server
    body.append(
      labelled(checkbox(s.on, "", (v) => set({ on: v })), "開啟 AI 連線", "只有這台電腦的 AI 應用程式連得進來"),
    );
    const status = el("div", "pop-row");
    statusLine = el("span", st?.error && s.on ? "pop-msg" : "", statusText());
    status.append(lbl("狀態"), statusLine);
    body.append(status);
    const portRow = el("div", "pop-row");
    portRow.append(lbl("連接埠"), numInput(s.port, { min: 1024, max: 65535 }, { title: "被占用時換一個", width: 80 }, (v) => set({ port: v })));
    body.append(portRow);
    const tokenRow = el("div", "pop-row");
    const shown = el("span", "mcp-token", showToken ? token : token ? `${"•".repeat(12)}${token.slice(-4)}` : "—");
    const copyBtn = textButton("複製", "link-btn", () => void copy(token, copyBtn));
    tokenRow.append(
      lbl("權杖"),
      shown,
      textButton(showToken ? "隱藏" : "顯示", "link-btn", () => {
        showToken = !showToken;
        rerender();
      }),
      copyBtn,
      textButton("重新產生", "link-btn", () => {
        void ui.host.newToken().then(rerender);
      }, "換新權杖，應用程式要跟著改"),
    );
    body.append(tokenRow, el("div", "pop-note", "權杖等同密碼，不要給別人"));

    // ------------------------------------------------------------------- what AI apps may do
    body.append(el("div", "pop-section", "AI 可以做什麼"));
    const always = checkbox(true, "", () => undefined);
    always.disabled = true;
    body.append(
      labelled(always, "讀取圖表、畫線、帳戶", "一直開著"),
      labelled(checkbox(s.write, "", (v) => set({ write: v })), "修改圖表：畫線、提醒、指標、設定", "AI 畫的線可以還原"),
      labelled(checkbox(s.trade, "", (v) => set({ trade: v })), "交易：下單、撤單、改止損止盈", "金鑰和密碼不會交給 AI"),
    );
    const confirmRow = el("div", "pop-row");
    const pick = el("select");
    for (const m of CONFIRM_MODES) pick.append(new Option(m.label, m.key, false, m.key === s.confirm));
    pick.onchange = () => set({ confirm: pick.value as ConfirmMode });
    pick.disabled = !s.trade;
    confirmRow.append(lbl("下單前確認"), pick);
    body.append(confirmRow);
    if (s.trade && s.confirm !== "always")
      body.append(el("div", "trade-warn", s.confirm === "never" ? "AI 送出的單會直接送到 OKX，不會先問你" : "模擬盤直接送出，實盤才先問你"));
    body.append(
      el("div", "pop-note", "按「確認下單」才送出，五分鐘沒回應就不下單。超過預設風險或槓桿的單、移遠止損一律要確認"),
    );

    // ------------------------------------------------------------------- setting up an app
    body.append(el("div", "pop-section", "連到 AI 應用程式"));
    body.append(el("div", "pop-note", "選你的應用程式，照說明貼上設定"));
    const pickRow = el("div", "pop-row");
    const app = el("select");
    for (const c of CLIENTS) app.append(new Option(c.name, c.key, false, c.key === client));
    app.onchange = () => {
      client = app.value;
      rerender();
    };
    pickRow.append(lbl("應用程式"), app);
    body.append(pickRow);
    const c = CLIENTS.find((x) => x.key === client) ?? CLIENTS[0];
    const url = `http://127.0.0.1:${port}/mcp`;
    const exe = st?.exe || "QT Chart.exe";
    const hidden = token ? `${"•".repeat(12)}${token.slice(-4)}` : "<權杖>";
    body.append(
      el("div", "pop-note", c.where),
      snippet(c.name, c.make({ url, exe, token: token || "<權杖>" }), c.make({ url, exe, token: showToken ? token : hidden })),
    );

    // ------------------------------------------------------------------- the last calls
    body.append(el("div", "pop-section", "最近的呼叫"));
    callList = el("div", "mcp-calls");
    fillCalls(callList);
    body.append(callList);
  };
}
