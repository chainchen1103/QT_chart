// Every saved setting as a Setting<T> (read once, saved on change, watched by what depends on it), the
// drawings of each symbol, and the background picture.

import { setting } from "../core/setting.ts";
import { cleanOrderPrefs } from "../trade/model.ts";
import { readJson, readRaw, writeJson, writeRaw } from "../core/storage.ts";
import {
  clone,
  cleanAppearance,
  cleanDrawings,
  cleanDrawStyles,
  cleanFib,
  cleanFvgs,
  cleanGroups,
  cleanLabels,
  cleanMagnet,
  cleanMaOptions,
  cleanMas,
  cleanObs,
  cleanPosition,
  cleanSrs,
  DEFAULT_FIB,
  DEFAULT_FVG,
  DEFAULT_GROUPS,
  DEFAULT_MAGNET,
  DEFAULT_MAS,
  DEFAULT_OB,
  DEFAULT_SR,
  type Drawing,
} from "./model.ts";

export function loadSettings() {
  return {
    mas: setting("mas", (r) => cleanMas(r) ?? clone(DEFAULT_MAS)),
    maOptions: setting("maopts", cleanMaOptions),
    fvgs: setting("fvgs", (r) => cleanFvgs(r) ?? [clone(DEFAULT_FVG)]),
    obs: setting("obs", (r) => cleanObs(r) ?? [clone(DEFAULT_OB)]),
    srs: setting("srs", (r) => cleanSrs(r) ?? [clone(DEFAULT_SR)]),
    // first run of the version with switch groups: the old moving-average switch decides the "均線" one
    groups: setting("groups", (r) => (r === undefined ? { ...DEFAULT_GROUPS, ma: readJson("ma") !== 0 } : cleanGroups(r))),
    labels: setting("labels", cleanLabels),
    fib: setting("fib", (r) => cleanFib(r) ?? clone(DEFAULT_FIB)),
    magnet: setting("magnet", (r) => cleanMagnet(r) ?? clone(DEFAULT_MAGNET)),
    drawStyles: setting("drawstyles", cleanDrawStyles),
    appearance: setting("appearance", cleanAppearance),
    position: setting("position", cleanPosition),
    /** The order window's last choices (type, margin mode, take-profit on or off). */
    orderPrefs: setting("orderprefs", cleanOrderPrefs),
  };
}
export type Settings = ReturnType<typeof loadSettings>;

export const loadDrawings = (instId: string): Drawing[] => cleanDrawings(readJson("drawings." + instId));
export const saveDrawings = (instId: string, list: Drawing[]) => writeJson("drawings." + instId, list);

/** The background picture, as a data URL ("" = none). Kept apart from the appearance because it is large. */
export function loadBgImage(): string {
  const s = readRaw("bgimage") ?? "";
  return s.startsWith("data:image/") ? s : "";
}
/** False when it could not be saved (storage full). */
export const saveBgImage = (dataUrl: string): boolean => writeRaw("bgimage", dataUrl);
