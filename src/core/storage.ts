// Saved data: settings, the drawings of each symbol, alerts, the background picture. The backend keeps them
// as files (src-tauri/src/store.rs) and hands everything over once at start; after that reads come from
// memory and every change goes to its file at once, so closing the app right after a change loses nothing.
// Every value is kept as JSON text.
//
// Older versions kept everything in the web view's own storage (localStorage). That could miss the last
// changes when the app was closed right after them, and the development build and the built app each had
// their own. The first start of this version copies it over; if the files can't be used at all, the app
// keeps working on localStorage as before.

import { storeLoad, storeRemove, storeSet } from "./api.ts";

const PREFIX = "qtchart.";
/** Kept as plain text in localStorage by older versions (the rest was JSON already). */
const PLAIN = new Set(["instId", "bar", "lineTool", "bgimage"]);
const MIGRATED = "store_version";
const KEY = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/; // the backend accepts the same names

let cache = new Map<string, string>(); // key → JSON text
let files = true; // false: the files couldn't be read; fall back to localStorage

/** Load everything saved. Call once, before anything reads a setting. Never throws. */
export async function initStorage(): Promise<void> {
  try {
    cache = new Map(Object.entries(await storeLoad()));
  } catch (e) {
    files = false;
    console.error("存檔資料夾不能用，改用 WebView 的 local storage：", e);
    return;
  }
  if (!cache.has(MIGRATED)) {
    for (const [key, json] of fromLocalStorage(localEntries())) if (!cache.has(key)) put(key, json);
    put(MIGRATED, "1");
  }
}

/** Old localStorage entries ("qtchart.<key>", text) as file values (key → JSON text); broken ones are skipped. */
export function fromLocalStorage(entries: [string, string][]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of entries) {
    if (!k.startsWith(PREFIX)) continue;
    const key = k.slice(PREFIX.length);
    if (!KEY.test(key)) continue;
    if (PLAIN.has(key)) {
      out.set(key, JSON.stringify(v));
      continue;
    }
    try {
      JSON.parse(v);
      out.set(key, v);
    } catch {
      /* not JSON: an old leftover, skipped */
    }
  }
  return out;
}

function localEntries(): [string, string][] {
  const out: [string, string][] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) out.push([k, localStorage.getItem(k) ?? ""]);
    }
  } catch {
    /* storage blocked: nothing to copy */
  }
  return out;
}

/** Into memory now, into its file right after (`null` removes it). */
function put(key: string, json: string | null): boolean {
  if (json == null) cache.delete(key);
  else cache.set(key, json);
  (json == null ? storeRemove(key) : storeSet(key, json)).catch((e) => console.error(`存不了 ${key}：`, e));
  return true;
}

function localGet(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}
function localSet(key: string, v: string | null): boolean {
  try {
    if (v == null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, v);
    return true;
  } catch {
    return false;
  }
}

/** The saved keys that start with `prefix` (e.g. "drawings."). */
export function keysWith(prefix: string): string[] {
  if (files) return [...cache.keys()].filter((k) => k.startsWith(prefix));
  const out: string[] = [];
  for (const [k] of localEntries()) if (k.startsWith(PREFIX + prefix)) out.push(k.slice(PREFIX.length));
  return out;
}

/** undefined when nothing (or nothing readable) is saved. */
export function readJson(key: string): unknown {
  const s = files ? cache.get(key) ?? null : localGet(key);
  if (s == null) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** False when it could not be saved. */
export function writeJson(key: string, v: unknown): boolean {
  const s = JSON.stringify(v);
  return files ? put(key, s) : localSet(key, s);
}

/** A plain string (symbol, timeframe, the background picture). */
export function readRaw(key: string): string | null {
  if (!files) return localGet(key);
  const v = readJson(key);
  return typeof v === "string" ? v : null;
}

/** "" removes the entry. */
export function writeRaw(key: string, v: string): boolean {
  if (!files) return localSet(key, v || null);
  return put(key, v ? JSON.stringify(v) : null);
}
