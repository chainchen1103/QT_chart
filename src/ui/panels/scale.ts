// Right-click menu of the price scale: which labels show.
// Each change is applied and saved at once through the callbacks; nothing waits for an OK button.

import { type ScaleLabels, DEFAULT_LABELS, LABEL_ITEMS } from "../../settings/model.ts";
import { checkbox, el, labelled, textButton } from "../dom.ts";
import { popoverAt, type Render } from "../popover.ts";

/** Right-click menu of the price scale: switch each label on or off; `extra` goes on top (e.g. a new alert). */
export function openScaleMenu(x: number, y: number, labels: { get: () => ScaleLabels; set: (v: ScaleLabels) => void }, extra?: Render) {
  popoverAt(x, y, "價格標籤", (body, rerender) => {
    extra?.(body, rerender);
    const cur = labels.get();
    for (const it of LABEL_ITEMS) {
      body.append(labelled(checkbox(cur[it.key], "", (v) => labels.set({ ...labels.get(), [it.key]: v })), it.text, it.title));
    }
    const foot = el("div", "pop-foot");
    foot.append(el("span", "spacer"), textButton("恢復預設", "link-btn", () => {
      labels.set({ ...DEFAULT_LABELS });
      rerender();
    }));
    body.append(foot);
  });
}
