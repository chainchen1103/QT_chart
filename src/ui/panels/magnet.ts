// The magnet: always on, or held with a key.
// Each change is applied and saved at once through the callbacks; nothing waits for an OK button.

import { MAGNET_KEYS, type MagnetKey, type MagnetSettings } from "../../settings/model.ts";
import { checkbox, el, labelled } from "../dom.ts";
import { togglePopover } from "../popover.ts";

export function toggleMagnetPanel(anchor: HTMLElement, magnet: { get: () => MagnetSettings; set: (v: MagnetSettings) => void }) {
  togglePopover(anchor, "right", "吸附", (body) => {
    const mg = magnet.get();
    body.append(el("div", "pop-note", "所有畫線、矩形、Fib、倉位的點，靠近游標那根 K 線的開、高、低、收時，會吸到最近的那個價格。"));
    body.append(labelled(checkbox(mg.on, "", (v) => magnet.set({ ...magnet.get(), on: v })), "常開（磁鐵按鈕按一下也能切換）"));
    const keyRow = el("div", "pop-row");
    const keySel = el("select");
    for (const k of MAGNET_KEYS) keySel.append(new Option(k.label, k.key, false, k.key === mg.holdKey));
    keySel.onchange = () => magnet.set({ ...magnet.get(), holdKey: keySel.value as MagnetKey });
    keyRow.append(el("span", "", "按住"), keySel, el("span", "", "時暫時吸附，放開就關"));
    body.append(keyRow);
  });
}
