// Performance: drawing with the graphics card (GPU) when Windows and the driver allow it, and what draws the
// page right now. The switch is kept by the backend (the web view reads it when it starts), so it takes effect
// the next time the app opens.

import { checkbox, el, labelled } from "../dom.ts";
import type { Render } from "../popover.ts";

export type PerformanceIo = {
  gpu(): Promise<boolean>;
  setGpu(on: boolean): Promise<void>;
};

let renderer: { gpu: boolean; name: string } | null = null;

/** What draws the page: a graphics card, or software (SwiftShader, llvmpipe, …). Asked once, then remembered. */
export function detectRenderer(): { gpu: boolean; name: string } {
  if (renderer) return renderer;
  renderer = { gpu: false, name: "" };
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    if (gl) {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
      gl.getExtension("WEBGL_lose_context")?.loseContext(); // give the context back right away
      // WebKit (Linux, macOS) hides the real name behind "Apple GPU"; WebView2 on Windows tells the truth
      const masked = name === "Apple GPU" && !/Mac/.test(navigator.platform);
      renderer = masked ? { gpu: false, name: "" } : { gpu: !!name && !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(name), name };
    }
  } catch {
    /* no WebGL: treat as software */
  }
  return renderer;
}

/** `header`: start with the section's name (not when the window already says it). */
export function performanceSection(io: PerformanceIo, header = true): Render {
  return (body) => {
    if (header) body.append(el("div", "pop-section", "效能"));
    const r = detectRenderer();
    const now = el("div", "pop-note", r.gpu ? `目前用顯示卡繪圖（${r.name}）` : r.name ? "目前用軟體繪圖" : "無法判斷目前用什麼繪圖");
    const row = el("div", "pop-row");
    const msg = el("div", "pop-note");
    const box = checkbox(true, "", async (v) => {
      box.disabled = true;
      try {
        await io.setGpu(v);
        msg.textContent = "重新開啟程式後生效";
      } catch (e) {
        box.checked = !v;
        msg.textContent = `存不了：${e}`;
      } finally {
        box.disabled = false;
      }
    });
    box.disabled = true;
    io.gpu()
      .then((on) => (box.checked = on))
      .catch(() => (box.checked = true))
      .finally(() => (box.disabled = false));
    row.append(labelled(box, "使用顯示卡加速", "顯示卡和驅動程式允許時，用顯示卡畫圖。畫面有問題時可以關掉，改用軟體繪圖"));
    body.append(now, row, msg);
  };
}
