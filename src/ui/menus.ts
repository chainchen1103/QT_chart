// Right-click menus and Alt+A. On the price scale: a new alert at that price, and which labels show. On the
// chart: a new alert, and the appearance window. (A right-click on a drawing is taken by the drawing layer
// first.) Alt+A: a new alert at the crosshair's price, as on TradingView. No browser menu anywhere else,
// except in text boxes.

import { alertDialogAt, type AlertUi } from "../alerts/panel.ts";
import type { MarketFeed } from "../chart/feed.ts";
import type { ChartView } from "../chart/view.ts";
import type { Setting } from "../core/setting.ts";
import type { ScaleLabels } from "../settings/model.ts";
import { isTyping, menuItem } from "./dom.ts";
import { openScaleMenu } from "./panels/scale.ts";
import { popoverAt } from "./popover.ts";

export type MenuDeps = {
  el: HTMLElement;
  view: ChartView;
  feed: MarketFeed;
  labels: Setting<ScaleLabels>;
  alerts: AlertUi;
  /** Open the appearance window at a screen point. */
  appearanceAt(x: number, y: number): void;
};

export function setupMenus(d: MenuDeps) {
  const { el, view, feed } = d;
  const priceAt = (clientY: number) => {
    const p = view.priceAt(clientY - el.getBoundingClientRect().top);
    return p == null ? null : feed.roundToTick(p);
  };

  el.addEventListener("contextmenu", (e) => {
    const x = e.clientX - el.getBoundingClientRect().left;
    const p = priceAt(e.clientY);
    const { clientX: cx, clientY: cy } = e;
    e.preventDefault();
    const addAlert = (body: HTMLElement) => {
      if (p != null) body.append(menuItem(`在 ${feed.fmtPrice(p)} 新增提醒`, () => alertDialogAt(cx, cy, d.alerts, p), "Alt+A"));
    };
    if (x < view.chart.timeScale().width()) {
      popoverAt(cx, cy, "圖表", (body) => {
        addAlert(body);
        body.append(menuItem("圖表外觀…", () => d.appearanceAt(cx, cy)));
      });
    } else {
      openScaleMenu(cx, cy, d.labels, addAlert);
    }
  });
  document.addEventListener("contextmenu", (e) => {
    if (!(e.target as Element | null)?.closest?.("input, textarea")) e.preventDefault();
  });

  // Alt+A at the crosshair (in the price pane), or at the last price
  let crossY: number | null = null;
  let mouse = { x: 0, y: 0 };
  view.chart.subscribeCrosshairMove((p) => {
    crossY = p.point && (p.paneIndex ?? 0) === 0 ? p.point.y : null;
  });
  el.addEventListener("mousemove", (e) => (mouse = { x: e.clientX, y: e.clientY }));
  window.addEventListener("keydown", (e) => {
    if (!e.altKey || e.code !== "KeyA" || e.repeat || isTyping(document.activeElement)) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const p = crossY != null ? view.priceAt(crossY) : null;
    const at = crossY != null ? mouse : { x: r.left + r.width / 2 - 150, y: r.top + 80 };
    alertDialogAt(at.x, at.y, d.alerts, p != null ? feed.roundToTick(p) : d.alerts.price());
  });
}
