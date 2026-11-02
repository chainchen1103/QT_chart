// How an alert reaches you: a popup in the window (stays until closed), a short chime, and through the backend
// a Windows notification plus a flashing taskbar button when the window is in the background.

import { el, textButton } from "../ui/dom.ts";
import type { AlertOptions } from "./model.ts";
import type { AlertNotice } from "./service.ts";

export type NotifierHost = {
  /** Where the popups stack. */
  box: HTMLElement;
  options(): AlertOptions;
  /** The backend's notification (see alertNotify in api.ts). */
  system(title: string, body: string, system: boolean, sound: boolean): Promise<void>;
  /** "前往": show this symbol on the chart. */
  open(instId: string): void;
  fmtClock(t: number): string;
};

const MAX_POPUPS = 5;

export class Notifier {
  private readonly host: NotifierHost;
  private audio: AudioContext | null = null;

  constructor(host: NotifierHost) {
    this.host = host;
    // browsers only let a page make sound after the first click or key press: get the audio ready then
    const unlock = () => {
      this.ctx();
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
    };
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
  }

  show(n: AlertNotice) {
    const o = this.host.options();
    const focused = document.hasFocus();
    // in front: our chime; in the background: Windows plays its own with the notification
    if (o.sound && (focused || !o.system)) this.chime();
    this.host.system(n.title, n.body, o.system, o.sound && !focused).catch(() => {
      /* no system notification: the popup is still there */
    });
    this.popup(n);
  }

  private popup(n: AlertNotice) {
    const box = this.host.box;
    const p = el("div", "toast");
    const head = el("div", "toast-head");
    head.append(
      el("span", "toast-title", n.title),
      el("span", "toast-time", this.host.fmtClock(n.alert.fired ?? Date.now() / 1000)),
      textButton("×", "pop-close", () => p.remove(), "關閉"),
    );
    const body = el("div", "toast-body");
    body.append(el("span", "toast-text", n.body), textButton("前往", "link-btn", () => {
      this.host.open(n.alert.instId);
      p.remove();
    }, "在圖上打開這個幣種"));
    p.append(head, body);
    box.prepend(p); // the newest sits at the bottom, nearest the corner
    while (box.children.length > MAX_POPUPS) box.lastElementChild?.remove();
  }

  private ctx(): AudioContext | null {
    try {
      this.audio ??= new AudioContext();
      if (this.audio.state === "suspended") void this.audio.resume();
      return this.audio;
    } catch {
      return null;
    }
  }

  /** Two short rising tones. */
  private chime() {
    const ctx = this.ctx();
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.02;
    [880, 1320].forEach((hz, k) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      const t = t0 + k * 0.18;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.17);
    });
  }
}
