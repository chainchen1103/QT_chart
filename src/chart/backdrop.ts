// What sits behind every chart: the background color and picture, and the up / down colors the rest of the
// page uses. Set once on the page as CSS variables, so every chart (and every chart made later) follows; the
// picture is decoded once and shown from a blob: URL, so the page doesn't keep a second copy of the long data
// URL in its styles.

import type { Appearance } from "../settings/model.ts";

export class Backdrop {
  private url = "";
  private src: string | null = null;
  private readonly root: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  apply(a: Appearance, picture: string) {
    const css = this.root.style;
    css.setProperty("--chart-bg", a.bg);
    css.setProperty("--chart-pic-size", a.imageFit === "stretch" ? "100% 100%" : a.imageFit);
    css.setProperty("--chart-pic-opacity", String(1 - a.imageTransparency / 100));
    css.setProperty("--up", a.up);
    css.setProperty("--down", a.down);
    if (picture === this.src) return; // colors changed, not the picture
    this.src = picture;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = picture ? URL.createObjectURL(dataUrlToBlob(picture)) : "";
    css.setProperty("--chart-pic", this.url ? `url("${this.url}")` : "none");
  }
}

/** "data:image/jpeg;base64,…" → Blob, without fetch (the page's content policy allows no fetching). */
function dataUrlToBlob(url: string): Blob {
  const comma = url.indexOf(",");
  const type = url.slice(5, url.indexOf(";")) || "image/jpeg";
  const bin = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
