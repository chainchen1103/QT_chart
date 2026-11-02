// Saved settings: JSON under "qtchart.<key>" in this computer's local storage. Reads that fail (nothing saved,
// storage blocked, bad JSON) give undefined; writes that fail (storage full or blocked) return false.

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
