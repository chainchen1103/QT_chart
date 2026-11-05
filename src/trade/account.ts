// The OKX account behind the user's API key: whether a key is set and unlocked, the account (equity, free
// margin, position mode; refreshed every minute while the window is open), and the calls that unlock, lock,
// place, look up and cancel orders. The key and the unlock password stay in the backend (src-tauri/src/trade.rs);
// nothing here keeps them.

import {
  tradeAccount,
  tradeAmendStops,
  tradeCancel,
  tradeClearKeys,
  tradeLock,
  tradeOrder,
  tradePlace,
  tradeSetKeys,
  tradeSetPassword,
  tradeStatus,
  tradeUnlock,
  type Account,
  type AmendReq,
  type KeyStatus,
  type OrderInfo,
  type OrderReq,
  type Placed,
} from "../core/api.ts";

const REFRESH_MS = 60_000;

const NO_KEYS: KeyStatus = { set: false, demo: false, hint: "", locked: false, protected: false };

export class TradeAccount {
  keys: KeyStatus = NO_KEYS;
  account: Account | null = null;
  /** The last refresh failed: why. */
  error: string | null = null;
  private readonly listeners = new Set<() => void>();

  async start() {
    try {
      this.keys = await tradeStatus();
    } catch (e) {
      this.error = String(e);
    }
    this.emit();
    await this.refresh();
    window.setInterval(() => {
      if (!document.hidden) void this.refresh();
    }, REFRESH_MS);
  }

  /** A key is set and unlocked: orders and the account can be used. */
  usable(): boolean {
    return this.keys.set && !this.keys.locked;
  }

  async refresh() {
    if (!this.usable()) return;
    try {
      this.account = await tradeAccount();
      this.error = null;
    } catch (e) {
      this.error = String(e);
    }
    this.emit();
  }

  /** Check the key on the account and keep it sealed with `password`; throws OKX's answer when it isn't accepted. */
  async setKeys(key: string, secret: string, passphrase: string, demo: boolean, password: string) {
    this.account = await tradeSetKeys(key, secret, passphrase, demo, password);
    this.keys = await tradeStatus();
    this.error = null;
    this.emit();
  }

  /** Throws "解鎖密碼不對" when it is wrong. */
  async unlock(password: string) {
    this.keys = await tradeUnlock(password);
    this.error = null;
    this.emit();
    await this.refresh();
  }

  async lock() {
    this.keys = await tradeLock();
    this.account = null;
    this.emit();
  }

  /** Set the unlock password, or change it (`current`: the one it has). */
  async setPassword(current: string | null, password: string) {
    this.keys = await tradeSetPassword(current, password);
    this.emit();
  }

  async clearKeys() {
    await tradeClearKeys();
    this.keys = NO_KEYS;
    this.account = null;
    this.error = null;
    this.emit();
  }

  /** USDT equity, when a key is set, unlocked and the account was read. */
  equity(): number | null {
    return this.usable() && this.account ? this.account.equity : null;
  }

  async place(o: OrderReq): Promise<Placed> {
    const r = await tradePlace(o);
    void this.refresh();
    return r;
  }
  order(instId: string, ordId: string): Promise<OrderInfo> {
    return tradeOrder(instId, ordId);
  }
  async cancel(instId: string, ordId: string) {
    await tradeCancel(instId, ordId);
    void this.refresh();
  }
  /** Change an order still waiting (price, size, its stops) or a stop-loss / take-profit. */
  async amend(r: AmendReq) {
    await tradeAmendStops(r);
    void this.refresh();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }
}
