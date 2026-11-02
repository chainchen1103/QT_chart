// The OKX account behind the user's API key: whether a key is set, the account (equity, free margin,
// position mode; refreshed every minute while the window is open), and the calls that place, look up and
// cancel orders. The key itself stays in the backend (src-tauri/src/trade.rs); nothing here keeps it.

import {
  tradeAccount,
  tradeCancel,
  tradeClearKeys,
  tradeOrder,
  tradePlace,
  tradeSetKeys,
  tradeStatus,
  type Account,
  type KeyStatus,
  type OrderInfo,
  type OrderReq,
  type Placed,
} from "../core/api.ts";

const REFRESH_MS = 60_000;

export class TradeAccount {
  keys: KeyStatus = { set: false, demo: false, hint: "" };
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

  async refresh() {
    if (!this.keys.set) return;
    try {
      this.account = await tradeAccount();
      this.error = null;
    } catch (e) {
      this.error = String(e);
    }
    this.emit();
  }

  /** Check the key on the account and keep it; throws OKX's answer when it isn't accepted. */
  async setKeys(key: string, secret: string, passphrase: string, demo: boolean) {
    this.account = await tradeSetKeys(key, secret, passphrase, demo);
    this.keys = await tradeStatus();
    this.error = null;
    this.emit();
  }

  async clearKeys() {
    await tradeClearKeys();
    this.keys = { set: false, demo: false, hint: "" };
    this.account = null;
    this.error = null;
    this.emit();
  }

  /** USDT equity, when a key is set and the account was read. */
  equity(): number | null {
    return this.keys.set && this.account ? this.account.equity : null;
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

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }
}
