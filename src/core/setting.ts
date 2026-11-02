// A saved setting: read once at start, written on every change, and watched by whatever depends on it, so the
// panel that changes it and the parts that use it never need to know about each other.

import { readJson, writeJson } from "./storage.ts";

export type Setting<T> = {
  get(): T;
  /** Save and tell every watcher. */
  set(v: T): void;
  /** Called after each set; returns the function that stops it. */
  watch(fn: (v: T) => void): () => void;
};

/** `clean` turns whatever is saved (possibly nothing, or something old or broken) into a valid value. */
export function setting<T>(key: string, clean: (raw: unknown) => T): Setting<T> {
  let value = clean(readJson(key));
  const watchers = new Set<(v: T) => void>();
  return {
    get: () => value,
    set(v: T) {
      value = v;
      writeJson(key, v);
      for (const fn of watchers) fn(v);
    },
    watch(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
  };
}
