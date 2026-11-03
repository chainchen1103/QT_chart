// A window in the middle of the screen over a dimmed backdrop, for work that takes a while (the Pine editor,
// a script's settings, a backtest report). Esc or × closes it; a click on the backdrop doesn't, so typing is
// never lost by a stray click.

import { closePopover } from "./popover.ts";
import { el, textButton } from "./dom.ts";

export type Modal = { box: HTMLElement; body: HTMLElement; foot: HTMLElement; close(): void; rerender(): void };

let current: { close: () => void } | null = null;

export function openModal(o: {
  title: string;
  cls?: string;
  render: (body: HTMLElement, foot: HTMLElement, m: Modal) => void;
  /** Return false to keep it open (e.g. to ask first about unsaved changes). */
  beforeClose?: () => boolean;
  onClose?: () => void;
}): Modal {
  closePopover();
  current?.close();
  const back = el("div", "modal-back");
  const box = el("div", "modal" + (o.cls ? " " + o.cls : ""));
  const head = el("div", "pop-head");
  const titleEl = el("span", "", o.title);
  head.append(titleEl, textButton("×", "pop-close", () => m.close(), "關閉（Esc）"));
  const body = el("div", "modal-body");
  const foot = el("div", "modal-foot");
  box.append(head, body, foot);
  back.append(box);
  document.body.append(back);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      m.close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  let closed = false;
  const m: Modal = {
    box,
    body,
    foot,
    close() {
      if (closed) return;
      if (o.beforeClose && !o.beforeClose()) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      if (current === me) current = null;
      o.onClose?.();
    },
    rerender() {
      body.replaceChildren();
      foot.replaceChildren();
      o.render(body, foot, m);
    },
  };
  const me = { close: () => m.close() };
  current = me;
  m.rerender();
  return m;
}
