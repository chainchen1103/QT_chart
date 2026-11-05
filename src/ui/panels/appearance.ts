// Chart appearance: background color and picture, grid and text, candle colors, text sizes.
// Each change is applied and saved at once through the callbacks; nothing waits for an OK button.

import { AXIS_SIZES, DEFAULT_APPEARANCE, IMAGE_FITS, LABEL_SIZES, type Appearance, type ImageFit } from "../../settings/model.ts";
import { colorInput, el, lbl, textButton } from "../dom.ts";
import { popoverAt, togglePopover, type Render } from "../popover.ts";

export type AppearanceIo = {
  get: () => Appearance;
  set: (v: Appearance) => void;
  image: () => string;
  /** Returns false when the picture could not be saved. */
  setImage: (dataUrl: string) => boolean;
};

/** Read a picture file and shrink it (longest side at most 1920 × 1200) to a JPEG data URL. */
async function pictureToDataUrl(file: File, bg: string): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => fail(new Error("讀不到這張圖片"));
      i.src = url;
    });
    const scale = Math.min(1, 1920 / img.naturalWidth, 1200 / img.naturalHeight);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("無法處理圖片");
    ctx.fillStyle = bg; // transparent parts of a PNG take the background color
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** `extra`: another section above the foot. (Also a section of the settings window.) */
export function renderAppearance(io: AppearanceIo, extra?: Render): Render {
  return (body, rerender) => {
    const a = io.get();
    const set = (p: Partial<Appearance>) => io.set({ ...io.get(), ...p });

    const bg = el("div", "pop-row");
    bg.append(lbl("背景顏色"), colorInput(a.bg, (v) => set({ bg: v })));

    body.append(bg, el("div", "pop-section", "背景圖片"));
    const pic = el("div", "pop-row");
    const file = el("input");
    file.type = "file";
    file.accept = "image/*";
    file.hidden = true;
    const msg = el("div", "pop-msg");
    file.onchange = async () => {
      const f = file.files?.[0];
      if (!f) return;
      msg.textContent = "處理中…";
      try {
        const data = await pictureToDataUrl(f, io.get().bg);
        if (!io.setImage(data)) {
          msg.textContent = "圖片太大";
          return;
        }
        rerender();
      } catch (e) {
        msg.textContent = e instanceof Error ? e.message : String(e);
      }
    };
    const img = io.image();
    if (img) {
      const thumb = el("span", "pop-thumb");
      thumb.style.backgroundImage = `url("${img}")`;
      pic.append(thumb);
    }
    pic.append(file, textButton(img ? "換一張…" : "選擇圖片…", "text-btn", () => file.click()));
    if (img) {
      pic.append(textButton("移除", "link-btn", () => {
        io.setImage("");
        rerender();
      }));
    }
    body.append(pic, msg);
    if (img) {
      const opts = el("div", "pop-row");
      const range = el("input");
      range.type = "range";
      range.min = "0";
      range.max = "100";
      range.step = "5";
      range.value = String(a.imageTransparency);
      const pct = el("span", "pop-lbl", `${a.imageTransparency}%`);
      range.oninput = () => {
        pct.textContent = `${range.value}%`;
        set({ imageTransparency: Number(range.value) });
      };
      const fit = el("select");
      for (const f of IMAGE_FITS) fit.append(new Option(f.label, f.key, false, f.key === a.imageFit));
      fit.onchange = () => set({ imageFit: fit.value as ImageFit });
      opts.append(lbl("透明度"), range, pct, fit);
      body.append(opts);
    }

    body.append(el("div", "pop-section", "顏色"));
    const lines = el("div", "pop-row");
    lines.append(lbl("格線"), colorInput(a.grid, (v) => set({ grid: v })), lbl("文字"), colorInput(a.text, (v) => set({ text: v })));
    const candles = el("div", "pop-row");
    candles.append(
      lbl("K 線上漲"),
      colorInput(a.up, (v) => set({ up: v }), "上漲 K 線、成交量和最新價的顏色"),
      lbl("下跌"),
      colorInput(a.down, (v) => set({ down: v }), "下跌 K 線、成交量和最新價的顏色"),
    );
    body.append(lines, candles);

    body.append(el("div", "pop-section", "文字大小"));
    const sizes = el("div", "pop-row");
    const sizeSelect = (value: number, options: number[], fallback: number, title: string, pick: (v: number) => void) => {
      const sel = el("select");
      for (const v of options) sel.append(new Option(`${v} px`, String(v), false, v === value));
      sel.title = `${title}，預設 ${fallback} px`;
      sel.onchange = () => pick(Number(sel.value));
      return sel;
    };
    sizes.append(
      lbl("圖上標籤"),
      sizeSelect(a.labelSize, LABEL_SIZES, DEFAULT_APPEARANCE.labelSize, "畫圖工具、指標和高低價的標籤", (v) => set({ labelSize: v })),
      lbl("座標軸"),
      sizeSelect(a.axisSize, AXIS_SIZES, DEFAULT_APPEARANCE.axisSize, "價格和時間座標軸", (v) => set({ axisSize: v })),
    );
    body.append(sizes, el("div", "pop-note", "圖上標籤包括畫圖工具、指標和高低價的標籤，Pine 腳本的文字也跟著等比縮放。標籤會自動避開彼此。"));
    extra?.(body, rerender);

    const foot = el("div", "pop-foot");
    foot.append(el("span", "spacer"), textButton("恢復預設顏色", "link-btn", () => {
      const cur = io.get();
      io.set({ ...DEFAULT_APPEARANCE, labelSize: cur.labelSize, axisSize: cur.axisSize });
      rerender();
    }, "背景圖片和文字大小不會變"));
    body.append(foot);
  };
}

export function toggleAppearancePanel(anchor: HTMLElement, io: AppearanceIo, extra?: Render) {
  togglePopover(anchor, "below", "圖表外觀", renderAppearance(io, extra));
}
export function appearanceAt(x: number, y: number, io: AppearanceIo, extra?: Render) {
  popoverAt(x, y, "圖表外觀", renderAppearance(io, extra));
}
