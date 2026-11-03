// QT Chart starts here: the saved data (settings, drawings, alerts) comes from the backend first, then the app
// itself (app.ts) is built with it. The fonts load at the same time, so the charts (drawn on canvas, which
// doesn't wait for fonts) start out with them; they are local files, and after a second the app starts anyway.

import { initStorage } from "./core/storage.ts";

function fontsReady(): Promise<unknown> {
  const fonts = ["400 13px Geist", "500 13px Geist", '400 12px "Geist Mono"'].map((f) => document.fonts.load(f).catch(() => null));
  return Promise.race([Promise.all(fonts), new Promise((done) => setTimeout(done, 1000))]);
}

void Promise.all([initStorage(), fontsReady()]).then(() => import("./app.ts"));
