// The interface's colors and type, for code that draws on canvas or sets up the chart library. The stylesheet
// has the same values as CSS variables (:root in style.css): a graphite ramp for every surface, three text roles,
// selection shown as a lighter surface rather than a color, and colors that each mean one thing (green / red: up
// and down, profit and loss; amber: price alerts; blue: the line that matters in a chart).

export const THEME = {
  bgDeep: "#0f0f10",
  bg: "#141415",
  panel: "#19191b",
  raised: "#232325",
  hover: "#2d2d30",
  line: "rgba(237, 237, 237, 0.08)",
  text: "#ededed",
  text2: "#a1a1a6",
  muted: "#85858b",
  data: "#5b9cf6",
  up: "#26a69a",
  down: "#ef5350",
  alert: "#f7a600",
};

/** Text: Geist for Latin, the system's Chinese font for the rest. */
export const UI_FONT = `Geist, -apple-system, "Segoe UI", "Microsoft JhengHei", "PingFang TC", sans-serif`;
/** Figures: prices, changes, times, axis labels. */
export const MONO_FONT = `"Geist Mono", ui-monospace, "Cascadia Mono", Consolas, "Microsoft JhengHei", monospace`;
