// Following the OKX account on the charts (setting "與 OKX 同步"): what the backend reports (src-tauri/src/sync.rs:
// pushed by OKX's private WebSocket, read again over REST on every connection) is matched to the drawings of
// every symbol (syncmodel.ts) and saved; the charts show the live numbers. An add that fills moves the earlier
// orders' stop-loss / take-profit on OKX; a stop-loss / take-profit moved on the chart goes to OKX after a
// confirmation, or goes back.

import {
  onSync,
  onSyncStatus,
  tradeAmendStops,
  tradeClosedPositions,
  tradeSync,
  type AmendReq,
  type SyncEvent,
  type SyncStatus,
} from "../core/api.ts";
import type { Catalog } from "../chart/catalog.ts";
import type { Setting } from "../core/setting.ts";
import type { Drawing, OkxClosed, PositionDrawing, SyncSettings } from "../settings/model.ts";
import { el, textButton } from "../ui/dom.ts";
import { closePopover, popoverAt, POPOVER_CLOSED } from "../ui/popover.ts";
import type { TradeAccount } from "./account.ts";
import {
  applyClosed,
  applySync,
  findClosed,
  isLive,
  posKeyOf,
  positionOfOrder,
  stopEdits,
  stopMoves,
  type SymbolState,
} from "./syncmodel.ts";

/** What a chart shows of a position on OKX: open (size, average price, unrealized PnL) or how it ended. */
export type LiveInfo = { coins: number; avg: number; lever: number; upl: number | null; closed: OkxClosed | null; demo: boolean };

export type SyncDeps = {
  acct: TradeAccount;
  catalog: Catalog;
  setting: Setting<SyncSettings>;
  /** Change a symbol's saved drawings and every chart that shows them (not a step to undo); `edit` says
   *  whether it changed anything. */
  editDrawings(instId: string, edit: (list: Drawing[]) => boolean): void;
  /** Symbols with drawings saved. */
  symbols(): string[];
  note(text: string): void;
  /** Live numbers changed: draw the charts again. */
  redraw(): void;
};

const LOOK_AGAIN_MS = 15_000;
const GIVE_UP_MS = 5 * 60_000;

export class AccountSync {
  /** The account as last reported (null: not following). */
  state: SyncEvent | null = null;
  status: SyncStatus = { state: "off", detail: "" };
  private readonly d: SyncDeps;
  private following: boolean | null = null;
  private shape = "";
  /** Symbols whose drawings are tied to OKX (looked at on every change). */
  private readonly tied = new Set<string>();
  /** Closed positions being looked up: key → [first seen, last asked] (ms). */
  private readonly looking = new Map<string, [number, number]>();
  /** Adds whose earlier stops are being moved. */
  private readonly moving = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(d: SyncDeps) {
    this.d = d;
  }

  async start() {
    await onSync((e) => this.onEvent(e));
    await onSyncStatus((s) => {
      this.status = s;
      if (s.state === "off") this.state = null;
      this.emit();
    });
    this.d.setting.watch(() => this.follow());
    this.d.acct.subscribe(() => this.follow());
    this.follow();
  }

  /** Follow when on and a key is set and unlocked (the backend starts over by itself when the key changes). */
  private follow() {
    const on = this.d.setting.get().on && this.d.acct.usable();
    if (on === this.following) return;
    this.following = on;
    if (!on) {
      this.state = null;
      this.d.redraw();
    }
    tradeSync(on).catch((e) => this.d.note(`同步 OKX 失敗：${e}`));
    this.emit();
  }

  /** The part of the account on one symbol, as syncmodel.ts takes it (null: not following, or the symbol list
   *  isn't in yet). */
  symbolState(instId: string): SymbolState | null {
    const e = this.state;
    const inst = this.d.catalog.get(instId);
    if (!e || !inst || !(inst.ctVal > 0)) return null;
    return {
      instId,
      demo: e.demo,
      positions: e.positions.filter((p) => p.instId === instId),
      algos: e.algos.filter((a) => a.instId === instId),
      tick: Number(inst.tickSz) || 0,
      ctVal: inst.ctVal,
    };
  }

  /** Is the drawing on OKX now (its entry OKX's; its stops go to OKX when moved)? */
  isLive(instId: string, d: PositionDrawing): boolean {
    return isLive(d, this.symbolState(instId));
  }

  /** What the chart shows of a drawing tied to OKX, or null. */
  liveInfo(instId: string, d: PositionDrawing): LiveInfo | null {
    const s = this.symbolState(instId);
    if (d.okx) {
      const k = d.okx;
      const p = s?.positions.find((x) => posKeyOf(x) === posKeyOf(k));
      return {
        coins: p ? Math.abs(p.pos) * s!.ctVal : k.coins,
        avg: p ? p.avgPx : d.a.p,
        lever: p ? p.lever : k.lever,
        upl: p ? p.upl : null,
        closed: k.closed ?? null,
        demo: k.demo,
      };
    }
    const o = d.order;
    if (!o) return null;
    if (o.closed) return { coins: 0, avg: o.avgPx ?? d.a.p, lever: d.leverage, upl: null, closed: o.closed, demo: o.demo };
    const p = s ? positionOfOrder(o, s) : undefined;
    return p ? { coins: Math.abs(p.pos) * s!.ctVal, avg: p.avgPx, lever: p.lever, upl: p.upl, closed: null, demo: o.demo } : null;
  }

  private onEvent(e: SyncEvent) {
    this.state = e;
    // positions and stops as they stand (the unrealized PnL left out: it changes all the time)
    const shape = JSON.stringify([
      e.demo,
      e.positions.map((p) => [p.posId, p.cTime, p.pos, p.avgPx]),
      e.algos.map((a) => [a.algoId, a.sl, a.tp, a.sz]),
    ]);
    if (shape !== this.shape || e.orders.length || this.looking.size) {
      // a symbol left out (its contract size not known yet): matched again with the next report
      this.shape = this.match(e) ? shape : "";
    }
    this.d.redraw();
    this.emit();
  }

  /** The symbol list arrived: match what was left out for want of it. */
  catalogReady() {
    if (this.state) this.shape = this.match(this.state) ? this.shape : "";
  }

  /** Match every symbol the account or the drawings tie to OKX; false when one had to be left out. */
  private match(e: SyncEvent): boolean {
    let all = true;
    const now = Date.now() / 1000;
    if (!this.tied.size) for (const id of this.d.symbols()) this.tied.add(id); // first time: look at them all once
    const ids = new Set<string>([...this.tied, ...e.positions.map((p) => p.instId), ...e.algos.map((a) => a.instId), ...e.orders.map((o) => o.instId)]);
    for (const instId of ids) {
      const s = this.symbolState(instId);
      if (!s) {
        all = false;
        continue;
      }
      let gone: { posId: string; cTime: number }[] = [];
      let ties = false;
      this.d.editDrawings(instId, (list) => {
        const r = applySync(list, s, e.orders.filter((o) => o.instId === instId), now);
        gone = r.gone;
        ties = list.some((d) => d.kind === "position" && ((d.okx && !d.okx.closed) || (d.order && !d.order.closed)));
        return r.changed;
      });
      if (ties) this.tied.add(instId);
      else this.tied.delete(instId);
      for (const g of gone) void this.lookUp(instId, g);
      void this.moveStops(instId);
    }
    return all;
  }

  /** How a position that is gone ended (OKX's position history), onto its drawings. */
  private async lookUp(instId: string, g: { posId: string; cTime: number }) {
    const key = posKeyOf(g);
    const nowMs = Date.now();
    const [first, last] = this.looking.get(key) ?? [nowMs, 0];
    if (nowMs - last < LOOK_AGAIN_MS) return;
    this.looking.set(key, [first, nowMs]);
    let end: OkxClosed | null = null;
    try {
      end = findClosed(await tradeClosedPositions(instId), g);
    } catch {
      /* asked again later */
    }
    if (!end && nowMs - first < GIVE_UP_MS) return; // OKX may not have it in the history yet
    this.looking.delete(key);
    const closed = end ?? { t: Math.floor(nowMs / 1000), px: 0, pnl: 0 }; // px 0: how it ended is unknown
    this.d.editDrawings(instId, (list) => applyClosed(list, key, closed));
  }

  /** Adds that filled: move the earlier orders' stop-loss / take-profit on OKX to theirs, once. */
  private async moveStops(instId: string) {
    const s = this.symbolState(instId);
    if (!s) return;
    let moves: ReturnType<typeof stopMoves> = [];
    this.d.editDrawings(instId, (list) => {
      moves = stopMoves(list, s);
      return false;
    });
    for (const m of moves) {
      if (this.moving.has(m.drawingId)) continue;
      this.moving.add(m.drawingId);
      const errors: string[] = [];
      for (const a of m.amends) {
        try {
          await tradeAmendStops(a);
        } catch (err) {
          errors.push(String(err));
        }
      }
      const ok = errors.length === 0 && !m.notes.some((n) => n.startsWith("找不到"));
      const what = m.amends.length ? `前面 ${m.amends.length} 張單的止損、止盈已移過去` : "前面沒有要移的止損";
      const note = [ok ? what : "", ...m.notes, ...errors].filter(Boolean).join("；");
      this.d.editDrawings(instId, (list) => {
        const d = list.find((x) => x.id === m.drawingId);
        if (d?.kind !== "position" || !d.order) return false;
        d.order = { ...d.order, moved: { at: Date.now() / 1000, ok, note } };
        return true;
      });
      this.d.note(ok ? `加倉成交：${note}` : `加倉成交，但移止損時有問題：${note}`);
      this.moving.delete(m.drawingId);
    }
  }

  /** An order filled while the account isn't followed: an add can't move the earlier stops; say so, once. */
  orderFilled(instId: string) {
    if (this.state) {
      void this.moveStops(instId);
      return;
    }
    let told = false;
    this.d.editDrawings(instId, (list) => {
      let changed = false;
      for (const d of list) {
        if (d.kind !== "position" || !d.order?.moveOnFill || d.order.moved) continue;
        if (d.order.state !== "filled" && d.order.state !== "partially_filled") continue;
        d.order = { ...d.order, moved: { at: Date.now() / 1000, ok: false, note: "「與 OKX 同步」關著，前面那筆的止損沒有移" } };
        changed = told = true;
      }
      return changed;
    });
    if (told) this.d.note("加倉成交了，但「與 OKX 同步」關著，前面那筆在 OKX 上的止損、止盈沒有移，請到 OKX 改");
  }

  /**
   * A stop-loss / take-profit was moved on the chart (`before`: the prices it had): for a position on OKX ask,
   * at (x, y), whether to change OKX too; yes changes it there, no (or closing the window) puts the chart back.
   * `revert` puts the drawing's stops back. Returns false when the drawing isn't on OKX (nothing asked).
   */
  confirmEdit(instId: string, d: PositionDrawing, before: { stop: number; target: number }, x: number, y: number, fmt: (p: number) => string, revert: () => void): boolean {
    const s = this.symbolState(instId);
    if (!s || !isLive(d, s)) return false;
    const change: { sl?: number; tp?: number } = {};
    if (d.b.p !== before.stop) change.sl = d.b.p;
    if (d.target !== before.target) change.tp = d.target;
    const e = stopEdits(d, s, change, fmt);
    if (!e) {
      // nothing on OKX for what was moved (e.g. no take-profit there): back to OKX's
      revert();
      this.d.note("OKX 上沒有這個止損或止盈單，圖上改回 OKX 的；要新增請到 OKX 設定");
      return true;
    }
    let done = false;
    popoverAt(x, y, "改 OKX 上的止損止盈", (body) => {
      body.append(el("div", `trade-env ${s.demo ? "demo" : "live"}`, s.demo ? "模擬盤" : "實盤：會改真的委託"));
      for (const line of e.lines) body.append(el("div", "pop-note", line));
      const msg = el("div", "pop-msg");
      const go = textButton("改 OKX", "text-btn " + (s.demo ? "primary" : "danger-solid"), async () => {
        go.disabled = true;
        go.textContent = "送出中…";
        const errors: string[] = [];
        for (const a of e.amends as AmendReq[]) {
          try {
            await tradeAmendStops(a);
          } catch (err) {
            errors.push(String(err));
          }
        }
        if (errors.length) {
          msg.textContent = `沒改成：${errors.join("；")}`;
          go.textContent = "改 OKX";
          go.disabled = false;
          return;
        }
        done = true;
        closePopover();
        this.d.note("OKX 上的止損、止盈改好了");
      });
      const no = textButton("不改，圖上改回去", "text-btn", () => closePopover());
      const foot = el("div", "pop-foot");
      foot.append(no, el("span", "spacer"), go);
      body.append(msg, foot);
      body.addEventListener(POPOVER_CLOSED, () => {
        if (!done) revert(); // the chart follows OKX: what wasn't sent goes back
      }, { once: true });
    });
    return true;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }
}
