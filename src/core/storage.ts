// Saved data: entries under "qtchart.<key>" in this computer's local storage (the web view's own storage; the
// page has no file access). Reads that fail (nothing saved, storage blocked, bad JSON) give undefined / null;
// writes that fail (storage full or blocked) return false.

const PREFIX = "qtchart.";

export function readJson(key: string): unknown {
  try {
    const s = localStorage.getItem(PREFIX + key);
    return s == null ? undefined : JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function writeJson(key: string, v: unknown): boolean {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}

/** A plain string (symbol, timeframe, the background picture). */
export function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

/** "" removes the entry. */
export function writeRaw(key: string, v: string): boolean {
  try {
    if (v) localStorage.setItem(PREFIX + key, v);
    else localStorage.removeItem(PREFIX + key);
    return true;
  } catch {
    return false;
  }
}
