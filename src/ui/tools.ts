// The left bar: cursor, lines (with a menu of kinds), Fib, rectangle, position (with its settings), magnet
// (with its settings), Fib levels, and "delete all drawings" (press twice). Also the settings window a
// drawing opens on double-click or right-click.

import type { DrawingLayer, Tool } from "../drawings/layer.ts";
import { readRaw, writeRaw } from "../core/storage.ts";
import { LINE_KINDS, magnetKeyLabel, TOOL_INFO, type Drawing, type LineKind, type LineStyle, type RectStyle } from "../settings/model.ts";
import type { Settings } from "../settings/store.ts";
import { ICONS } from "./icons.ts";
import { openDrawingStyle, toggleToolMenu } from "./panels/drawing.ts";
import { toggleFibPanel } from "./panels/fib.ts";
import { toggleMagnetPanel } from "./panels/magnet.ts";
import { positionPanelAt, togglePositionPanel } from "./panels/position.ts";
import type { Render } from "./popover.ts";

export type ToolsDeps = {
  drawings: DrawingLayer;
  settings: Settings;
  /** Status-bar hint; null restores the default. */
  hint(text: string | null): void;
  instId(): string;
  /** The 提醒 section of a drawing's settings window. */
  alertSection(d: Drawing): Render;
};

const $ = (id: string) => document.getElementById(id) as HTMLElement;

export class Tools {
  private readonly d: ToolsDeps;
  private lastLine: LineKind;
  private clearArmedUntil = 0;

  constructor(d: ToolsDeps) {
    this.d = d;
    const saved = readRaw("lineTool") ?? "";
    this.lastLine = (LINE_KINDS as string[]).includes(saved) ? (saved as LineKind) : "trend";
    this.setup();
  }

  /** The drawing layer switched tools: highlight the button (the line button shows the last kind used). */
  paintTools(tool: Tool) {
    $("tool-cursor").classList.toggle("active", tool === "cursor");
    $("tool-fib").classList.toggle("active", tool === "fib");
    $("tool-rect").classList.toggle("active", tool === "rect");
    $("tool-position").classList.toggle("active", tool === "position");
    const isLine = (LINE_KINDS as string[]).includes(tool);
    if (isLine && tool !== this.lastLine) {
      this.lastLine = tool as LineKind;
      writeRaw("lineTool", this.lastLine);
    }
    const lb = $("tool-line");
    lb.innerHTML = ICONS[this.lastLine]; // our own fixed SVG
    lb.classList.toggle("active", isLine);
    const info = TOOL_INFO[this.lastLine];
    lb.title = `${info.name}${info.key ? "（" + info.key + "）" : ""}；右下角小三角或按右鍵選其他線`;
  }

  /** The magnet is in effect (always on, or its key is held). */
  paintMagnet(active: boolean) {
    const m = this.d.settings.magnet.get();
    const b = $("tool-magnet");
    b.classList.toggle("on", m.on);
    b.classList.toggle("held", active && !m.on);
    b.title = `吸附到 K 線開高低收：${m.on ? "常開（按一下關閉）" : "常關（按一下開啟）"}；按住 ${magnetKeyLabel(m.holdKey)} 暫時吸附；右邊小箭頭或按右鍵改設定`;
  }

  /** Double-click or right-click on a drawing: its settings (with its alert). */
  openSettings(d: Drawing, x: number, y: number) {
    const { drawings, settings } = this.d;
    const alert = this.d.alertSection(d);
    if (d.kind === "fib") {
      toggleFibPanel($("tool-settings"), settings.fib, alert);
      return;
    }
    if (d.kind === "position") {
      positionPanelAt(x, y, settings.position, {
        drawing: d,
        trade: () => drawings.tradeOf(d.id),
        update: (p) => drawings.updatePosition(d.id, p),
        remove: () => drawings.remove(d.id),
      }, alert);
      return;
    }
    openDrawingStyle(x, y, d, {
      set: (s) => {
        drawings.setStyle(d.id, s);
        const styles = settings.drawStyles.get();
        settings.drawStyles.set(d.kind === "rect" ? { ...styles, rect: s as RectStyle } : { ...styles, [d.kind]: s as LineStyle });
      },
      remove: () => drawings.remove(d.id),
    }, alert);
  }

  private setup() {
    const { drawings, settings } = this.d;
    const toggle = (t: Tool) => () => drawings.setTool(drawings.getTool() === t ? "cursor" : t);
    const onRight = (b: HTMLElement, open: () => void) => {
      b.oncontextmenu = (e) => {
        e.preventDefault();
        open();
      };
    };
    $("tool-cursor").onclick = () => drawings.setTool("cursor");
    $("tool-fib").onclick = toggle("fib");
    $("tool-rect").innerHTML = ICONS.rect;
    $("tool-rect").onclick = toggle("rect");
    $("tool-position").innerHTML = ICONS.position;
    $("tool-position").onclick = toggle("position");
    const positionMenu = () => togglePositionPanel($("tool-position-menu"), settings.position);
    $("tool-position-menu").onclick = positionMenu;
    onRight($("tool-position"), positionMenu);
    $("tool-line").onclick = () => drawings.setTool(drawings.getTool() === this.lastLine ? "cursor" : this.lastLine);
    const lineMenu = () => toggleToolMenu($("tool-line-menu"), "線", LINE_KINDS, this.lastLine, (k) => drawings.setTool(k));
    $("tool-line-menu").onclick = lineMenu;
    onRight($("tool-line"), lineMenu);
    const magnetMenu = () => toggleMagnetPanel($("tool-magnet-menu"), settings.magnet);
    $("tool-magnet").onclick = () => settings.magnet.set({ ...settings.magnet.get(), on: !settings.magnet.get().on });
    onRight($("tool-magnet"), magnetMenu);
    $("tool-magnet-menu").onclick = magnetMenu;
    $("tool-settings").onclick = () => toggleFibPanel($("tool-settings"), settings.fib);
    $("tool-clear").onclick = () => this.clearAll();
    this.paintTools("cursor");
    this.paintMagnet(settings.magnet.get().on);
  }

  /** Delete every drawing of the symbol: the first press arms the button for 3 seconds, the second deletes. */
  private clearAll() {
    const { drawings } = this.d;
    const btn = $("tool-clear");
    if (!drawings.count()) {
      this.d.hint("這個幣種沒有畫線");
      setTimeout(() => this.d.hint(null), 2000);
      return;
    }
    if (Date.now() < this.clearArmedUntil) {
      this.clearArmedUntil = 0;
      btn.classList.remove("armed");
      drawings.clearAll();
      this.d.hint(null);
      return;
    }
    this.clearArmedUntil = Date.now() + 3000;
    btn.classList.add("armed");
    this.d.hint(`再按一次，刪除 ${this.d.instId()} 的全部 ${drawings.count()} 個畫線`);
    setTimeout(() => {
      if (Date.now() >= this.clearArmedUntil) {
        btn.classList.remove("armed");
        this.d.hint(null);
      }
    }, 3100);
  }
}
