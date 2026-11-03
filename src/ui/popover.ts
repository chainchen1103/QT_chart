// Popovers: one small window at a time, next to a button or at a point (a right-click menu). A click outside
// or Esc closes it. The body is drawn by a render function, which can redraw it after structural changes.

import { el, textButton } from "./dom.ts";

let open: { anchor: HTMLElement | null; close: () => void } | null = null;

export function closePopover() {
  open?.close();
}

export type Render = (body: HTMLElement, rerender: () => void) => void;

/** Fired on a popover's body when it closes: `body.addEventListener(POPOVER_CLOSED, stop)`. */
export const POPOVER_CLOSED = "popover-closed";

/**
 * Open a popover next to `anchor` (below it, or to its right), or close it if it is already open there.
 * `render` fills the body and is given a function that redraws the body after structural changes.
 */
export function togglePopover(anchor: HTMLElement, side: "below" | "right", title: string, render: Render) {
  if (open && open.anchor === anchor) {
    open.close();
    return;
  }
  const r = anchor.getBoundingClientRect();
  showPopover(anchor, side === "below" ? r.left : r.right + 6, side === "below" ? r.bottom + 4 : r.top, title, render);
}

/** Open a popover at a point on the screen (a right-click menu). */
export function popoverAt(x: number, y: number, title: string, render: Render) {
  showPopover(null, x, y, title, render);
}

function showPopover(anchor: HTMLElement | null, left: number, top: number, title: string, render: Render) {
  closePopover();
  const box = el("div", "popover");
  const head = el("div", "pop-head");
  head.append(el("span", "", title), textButton("×", "pop-close", () => close(), "關閉（Esc）"));
  const body = el("div", "pop-body");
  box.append(head, body);
  document.body.append(box);
  /** As close to (left, top) as fits in the window; again whenever its size changes (a redraw, a message). */
  const place = () => {
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    box.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
    box.style.top = `${Math.max(8, Math.min(top, window.innerHeight - h - 8))}px`;
  };
  const rerender = () => {
    // the box in use stays in use across a redraw (found again by its data-key), so Tab goes on from it
    const act = document.activeElement;
    const key = act instanceof HTMLElement && body.contains(act) ? act.dataset.key : undefined;
    body.replaceChildren();
    render(body, rerender);
    const again = key ? body.querySelector<HTMLElement>(`[data-key="${key}"]`) : null;
    if (again) {
      again.focus();
      if (again instanceof HTMLInputElement) again.select();
    }
  };
  rerender();
  place();
  const resized = new ResizeObserver(place);
  resized.observe(box);

  const onDown = (e: MouseEvent) => {
    const t = e.target as Node;
    if (!box.contains(t) && !(anchor && anchor.contains(t))) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation(); // Esc closes the popover only
      close();
    }
  };
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  anchor?.classList.add("open");
  const me = { anchor, close };
  function close() {
    body.dispatchEvent(new Event(POPOVER_CLOSED)); // whatever the body listens to can stop now
    resized.disconnect();
    box.remove();
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    anchor?.classList.remove("open");
    if (open === me) open = null;
  }
  open = me;
}
