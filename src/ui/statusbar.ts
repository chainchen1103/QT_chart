// The status bar: the live connection (a colored dot and its text), charts loading and what went wrong, and
// a hint line on the right (what the drawing tool expects next, short notes).

import type { StreamStatus } from "../core/api.ts";

const STATUS_TEXT: Record<StreamStatus["state"], string> = {
  connecting: "連線中…",
  ws: "即時（WebSocket）",
  polling: "輪詢更新中（每 2 秒）",
  error: "錯誤",
};

export type StatusElements = { dot: HTMLElement; status: HTMLElement; hint: HTMLElement };

export class StatusBar {
  private stream: StreamStatus = { state: "connecting", detail: "" };
  private loading = 0;
  private problem: string | null = null;
  private noteTimer = 0;
  private readonly e: StatusElements;
  private readonly defaultHint: string;

  constructor(e: StatusElements, defaultHint: string) {
    this.e = e;
    this.defaultHint = defaultHint;
  }

  /** The live connection's state, from the backend. */
  setStream(s: StreamStatus) {
    this.stream = s;
    this.problem = null;
    this.paint();
  }
  /** A chart started (true) or finished (false) loading its first bars. */
  busy(on: boolean) {
    this.loading = Math.max(0, this.loading + (on ? 1 : -1));
    this.paint();
  }
  /** Shown until the next chart loads fine or the connection changes. */
  error(text: string) {
    this.problem = text;
    this.paint();
  }
  /** A chart loaded fine. */
  ok() {
    if (this.problem == null) return;
    this.problem = null;
    this.paint();
  }

  /** The hint line; null brings back the default. */
  hint(text: string | null) {
    clearTimeout(this.noteTimer);
    this.e.hint.textContent = this.e.hint.title = text ?? this.defaultHint;
  }
  /** A hint for a few seconds. */
  note(text: string) {
    this.hint(text);
    this.noteTimer = window.setTimeout(() => this.hint(null), 4000);
  }

  private paint() {
    const s: StreamStatus = this.problem
      ? { state: "error", detail: this.problem }
      : this.loading
        ? { state: "connecting", detail: "載入 K 線" }
        : this.stream;
    this.e.dot.className = "dot " + s.state;
    this.e.status.textContent = this.e.status.title = s.detail ? `${STATUS_TEXT[s.state]}：${s.detail}` : STATUS_TEXT[s.state];
  }
}
