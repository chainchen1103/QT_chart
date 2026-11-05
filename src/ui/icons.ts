// Small line icons (20 × 20, current color, 1.5 stroke like every icon in the app) for the drawing tools.

import type { DrawKind } from "../settings/model.ts";

const svg = (body: string) =>
  `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">${body}</svg>`;
/** An anchor point: a hollow dot, filled with the button's own background (--icon-hole in style.css). */
const dot = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="1.8" style="fill: var(--icon-hole, var(--bg-deep))"/>`;

/** The lock button: closed while the drawings are locked, open while they aren't. */
export const LOCK_ICONS = {
  locked: svg(`<rect x="4.5" y="9" width="11" height="8" rx="1.5"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>`),
  open: svg(`<rect x="4.5" y="9" width="11" height="8" rx="1.5"/><path d="M7 9V6.5a3 3 0 0 1 5.8-1.1"/>`),
};

export const ICONS: Record<DrawKind, string> = {
  fib: svg(`<path d="M3 4h14M3 8h14M3 12h14M3 16h14"/><path d="M4 16 16 4" stroke-dasharray="2 2"/>`),
  trend: svg(`<path d="M4.5 15.5 15.5 4.5"/>${dot(4.5, 15.5)}${dot(15.5, 4.5)}`),
  ray: svg(`<path d="M4.5 15.5 18.5 1.5"/>${dot(4.5, 15.5)}${dot(10, 10)}`),
  info: svg(`<path d="M3.5 16.5 11 9"/>${dot(3.5, 16.5)}${dot(11, 9)}<rect x="12.5" y="2.5" width="5.5" height="5" rx="1"/>`),
  extended: svg(`<path d="M1.5 18.5 18.5 1.5"/>${dot(7, 13)}${dot(13, 7)}`),
  angle: svg(`<path d="M4 16 15 5M4 16h12"/><path d="M10 16a6 6 0 0 0-1.8-4.2"/>${dot(4, 16)}`),
  hline: svg(`<path d="M1.5 10h17"/>${dot(10, 10)}`),
  hray: svg(`<path d="M5 10h13.5"/>${dot(5, 10)}`),
  vline: svg(`<path d="M10 1.5v17"/>${dot(10, 10)}`),
  cross: svg(`<path d="M1.5 10h17M10 1.5v17"/>${dot(10, 10)}`),
  // two lines the same way up; the third point sets the second line
  channel: svg(`<path d="M2.5 11.5 11.5 2.5M8.5 17.5 17.5 8.5"/>${dot(2.5, 11.5)}${dot(11.5, 2.5)}${dot(17.5, 8.5)}`),
  // the fitted line (dashed) between its two outer lines
  regression: svg(`<path d="M2 12 12 2M8 18 18 8"/><path d="M5 15 15 5" stroke-dasharray="2 2"/>${dot(5, 15)}${dot(15, 5)}`),
  // a level top over a rising line
  flat: svg(`<path d="M2.5 4.5h15M2.5 16.5 17.5 10"/>${dot(2.5, 16.5)}${dot(17.5, 10)}${dot(17.5, 4.5)}`),
  // the second line mirrors the first: they open apart
  disjoint: svg(`<path d="M2.5 8.5 17.5 3M2.5 12 17.5 17.5"/>${dot(2.5, 8.5)}${dot(17.5, 3)}${dot(2.5, 12)}`),
  rect: svg(`<rect x="4" y="5" width="12" height="10"/>${dot(4, 5)}${dot(16, 15)}`),
  position: svg(`<rect x="4" y="3" width="12" height="14" rx="1"/><path d="M4 11h12"/><path d="M7.5 7.5 10 5l2.5 2.5"/>${dot(4, 11)}`),
};
