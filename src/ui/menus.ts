// Right-click menus, Alt+A and Alt+R. On a chart's price scale: a new alert at that price, and which labels
// show. On the chart: a new alert, the default view again, and the appearance window. (A right-click on a
// drawing is taken by the drawing layer first.) Alt+A: a new alert at the crosshair's price, in whichever chart
// the mouse is over, as on TradingView; with the mouse elsewhere, at the last price of the chart in use. Alt+R:
// that chart back to its default view. No browser menu anywhere else, except in text boxes.

import { alertDialogAt, type AlertUi } from "../alerts/panel.ts";
import type { MarketFeed } from "../chart/feed.ts";
import type { ChartView } from "../chart/view.ts";
import type { Setting } from "../core/setting.ts";
import type { ScaleLabels } from "../settings/model.ts";
import { isTyping, menuItem } from "./dom.ts";
import { openScaleMenu } from "./panels/scale.ts";
import { closePopover, popoverAt } from "./popover.ts";

export type PaneMenuDeps = {
  el: HTMLElement;
  view: ChartView;
  feed: MarketFeed;
  labels: Setting<ScaleLabels>;
  alerts: AlertUi;
  /** Open the appearance window at a screen point. */
  appearanceAt(x: number, y: number): void;
  /** Back to the default view: the newest bars at the default zoom, prices fitted; the timeframe stays. */
  resetView(): void;
  /** The indicator pane at this height of the screen: its name and value there ("RSI 78.3"), and a new alert on
   *  it at that value, with its window at a screen point. */
  studyAt(clientY: number): PaneHit | null;
};
export type PaneHit = { text: string; alert(x: number, y: number): void };

/** The menus of one chart. */
export class PaneMenus {
  private readonly d: PaneMenuDeps;
  /** The crosshair's y in the price pane, while the mouse is over this chart. */
  private crossY: number | null = null;
  /** The indicator pane the mouse is over, with its value there. */
  private overStudy: PaneHit | null = null;
  private mouse = { x: 0, y: 0 };

  constructor(d: PaneMenuDeps) {
    this.d = d;
    const { el, view, feed } = d;
    el.addEventListener("contextmenu", (e) => {
      const x = e.clientX - el.getBoundingClientRect().left;
      const p = this.priceAt(e.clientY);
      const { clientX: cx, clientY: cy } = e;
      e.preventDefault();
      const addAlert = (body: HTMLElement) => {
        if (p != null) body.append(menuItem(`在 ${feed.fmtPrice(p)} 新增提醒`, () => alertDialogAt(cx, cy, d.alerts, p), "Alt+A"));
      };
      const study = d.studyAt(cy);
      if (study) {
        // an indicator's pane: an alert on it, at the value there
        popoverAt(cx, cy, "圖表", (body) => {
          body.append(menuItem(`在 ${study.text} 新增提醒`, () => study.alert(cx, cy), "Alt+A"));
          const reset = () => {
            closePopover();
            d.resetView();
          };
          body.append(menuItem("重設圖表視圖", reset, "Alt+R"), menuItem("圖表外觀…", () => d.appearanceAt(cx, cy)));
        });
        return;
      }
      if (x < view.chart.timeScale().width()) {
        popoverAt(cx, cy, "圖表", (body) => {
          addAlert(body);
          const reset = () => {
            closePopover();
            d.resetView();
          };
          body.append(menuItem("重設圖表視圖", reset, "Alt+R"), menuItem("圖表外觀…", () => d.appearanceAt(cx, cy)));
        });
      } else {
        openScaleMenu(cx, cy, d.labels, addAlert);
      }
    });
    view.chart.subscribeCrosshairMove((p) => {
      this.crossY = p.point && (p.paneIndex ?? 0) === 0 ? p.point.y : null;
    });
    el.addEventListener("mousemove", (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
      this.overStudy = d.studyAt(e.clientY);
    });
    el.addEventListener("mouseleave", () => (this.overStudy = null));
  }

  private priceAt(clientY: number): number | null {
    const p = this.d.view.priceAt(clientY - this.d.el.getBoundingClientRect().top);
    return p == null ? null : this.d.feed.roundToTick(p);
  }

  /** Alt+A with the crosshair on this chart's prices: a new alert there. False when it isn't on this chart. */
  alertAtCrosshair(): boolean {
    const st = this.overStudy;
    if (st) {
      st.alert(this.mouse.x, this.mouse.y);
      return true;
    }
    if (this.crossY == null) return false;
    const p = this.d.view.priceAt(this.crossY);
    if (p == null) return false;
    alertDialogAt(this.mouse.x, this.mouse.y, this.d.alerts, this.d.feed.roundToTick(p));
    return true;
  }

  /** The mouse is over this chart's prices. */
  hovered(): boolean {
    return this.crossY != null || this.overStudy != null;
  }
  resetView() {
    this.d.resetView();
  }

  /** Alt+A with the mouse elsewhere: a new alert at the last price, near the top of this chart. */
  alertAtLast() {
    const r = this.d.el.getBoundingClientRect();
    alertDialogAt(r.left + r.width / 2 - 150, r.top + 80, this.d.alerts, this.d.alerts.price());
  }
}

/** Page-wide: no browser menu outside text boxes, and Alt+A and Alt+R for the chart under the mouse or the one in use. */
export function setupMenus(charts: () => readonly PaneMenus[], inUse: () => PaneMenus) {
  document.addEventListener("contextmenu", (e) => {
    if (!(e.target as Element | null)?.closest?.("input, textarea")) e.preventDefault();
  });
  window.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.shiftKey || e.repeat || isTyping(document.activeElement)) return;
    if (e.code === "KeyA") {
      e.preventDefault();
      if (!charts().some((m) => m.alertAtCrosshair())) inUse().alertAtLast();
    } else if (e.code === "KeyR") {
      e.preventDefault(); // Alt+Shift+R is the rectangle
      (charts().find((m) => m.hovered()) ?? inUse()).resetView();
    }
  });
}
