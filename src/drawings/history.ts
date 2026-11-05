// Undo and redo of the drawings (Ctrl+Z, Ctrl+Y): for each symbol, a copy of its drawings before every change
// made by hand, shared by all the charts that show it and kept while the app runs (not saved). Orders placed
// from positions are not undone: a position that is still there keeps its order as it is now. Pure (no DOM),
// unit-tested in tests/history.test.ts.

import { clone, type Drawing } from "../settings/model.ts";

/** Steps kept per symbol. */
export const MAX_STEPS = 100;
/** Changes of the same thing this close together (a color being dragged across the picker) are one step. */
export const MERGE_MS = 800;

type Book = { now: Drawing[]; undo: Drawing[][]; redo: Drawing[][]; merge: string | null; at: number };

const same = (a: readonly Drawing[], b: readonly Drawing[]) => JSON.stringify(a) === JSON.stringify(b);

export class DrawingHistory {
  private readonly books = new Map<string, Book>();
  private readonly clock: () => number;
  private readonly changed: () => void;

  /** `changed`: a step was added, undone or redone (the 還原 / 重做 buttons follow). */
  constructor(clock: () => number = () => Date.now(), changed: () => void = () => undefined) {
    this.clock = clock;
    this.changed = changed;
  }

  /** Is there a step to undo, or one to redo, for this symbol? */
  canUndo(instId: string): boolean {
    return !!this.books.get(instId)?.undo.length;
  }
  canRedo(instId: string): boolean {
    return !!this.books.get(instId)?.redo.length;
  }

  /** A symbol's drawings as loaded: where its history starts (a symbol that has one keeps it). */
  start(instId: string, list: readonly Drawing[]) {
    if (!this.books.has(instId)) this.books.set(instId, { now: clone([...list]), undo: [], redo: [], merge: null, at: 0 });
  }

  /**
   * The drawings were changed by hand: one step back to how they were, and nothing left to redo. `merge` names
   * a change that goes on (a color being picked, a slider): the same name again soon after adds no step.
   */
  record(instId: string, list: readonly Drawing[], merge?: string) {
    const b = this.books.get(instId);
    if (!b) {
      this.start(instId, list); // how they were before is unknown: they start from here
      return;
    }
    const next = clone([...list]);
    if (same(b.now, next)) return;
    const t = this.clock();
    const goesOn = merge != null && b.merge === merge && t - b.at < MERGE_MS && b.undo.length > 0;
    if (!goesOn) {
      b.undo.push(b.now);
      if (b.undo.length > MAX_STEPS) b.undo.shift();
    }
    b.now = next;
    b.redo = [];
    b.merge = merge ?? null;
    b.at = t;
    this.changed();
  }

  /** A change that is no step of its own (an order's state from the exchange): taken in as it is. */
  quiet(instId: string, list: readonly Drawing[]) {
    const b = this.books.get(instId);
    if (b) b.now = clone([...list]);
    else this.start(instId, list);
  }

  /** The drawings one step back (null: nothing to undo). */
  undo(instId: string): Drawing[] | null {
    return this.step(instId, true);
  }
  /** The step undone last, again (null: nothing to redo). */
  redo(instId: string): Drawing[] | null {
    return this.step(instId, false);
  }

  private step(instId: string, back: boolean): Drawing[] | null {
    const b = this.books.get(instId);
    if (!b) return null;
    const to = (back ? b.undo : b.redo).pop();
    if (!to) return null;
    (back ? b.redo : b.undo).push(b.now);
    b.now = keepOrders(to, b.now);
    b.merge = null;
    this.changed();
    return clone(b.now);
  }
}

/** Positions that are there now keep the order placed from them as it is now: an order on the exchange is
 *  not undone. (A deleted position brought back gets the order it had.) */
function keepOrders(list: Drawing[], present: readonly Drawing[]): Drawing[] {
  const cur = new Map(present.map((d) => [d.id, d]));
  return list.map((d) => {
    const p = cur.get(d.id);
    if (d.kind !== "position" || !p || p.kind !== "position") return d;
    const { order: _old, ...rest } = d;
    return p.order ? { ...rest, order: p.order } : rest;
  });
}
