//! Following the OKX account with the user's API key: the open USDT perpetual positions, their stop-loss and
//! take-profit orders, and changes to orders, so the charts can show them as they are on the exchange (the
//! page matches them to its drawings). OKX's WebSockets push changes as they happen: positions and orders on
//! the private one, the TP/SL orders on the business one (where OKX moved them in June 2023), both logged in.
//! On every (re)connection the whole picture is read once over REST, and again every minute as a check; while
//! the WebSockets can't be used, REST is asked every 5 seconds (and the page is told why). Everything goes to
//! the page as "okx_sync" events
//! (the whole picture each time, plus the orders that changed) and "okx_sync_status". Read only: nothing here
//! places or changes orders.

use crate::{okx, trade::Trader, AppState};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio_tungstenite::{connect_async, tungstenite, tungstenite::Message, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncPos {
    pub inst_id: String,
    pub pos_id: String,
    /// "long", "short", or "net" (one position per symbol: `pos` below 0 is a short).
    pub pos_side: String,
    /// Contracts.
    pub pos: f64,
    pub avg_px: f64,
    /// Unrealized profit and loss (U) at the mark price.
    pub upl: f64,
    pub mark_px: f64,
    pub liq_px: Option<f64>,
    pub lever: f64,
    pub mgn_mode: String,
    /// When it was opened and last changed (ms).
    pub c_time: i64,
    pub u_time: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncAlgo {
    pub inst_id: String,
    pub algo_id: String,
    pub algo_cl_ord_id: String,
    /// "conditional" (a stop-loss and / or a take-profit) or "oco".
    pub ord_type: String,
    /// The side it closes with: "sell" closes a long.
    pub side: String,
    pub pos_side: String,
    /// Contracts (0 when it closes the whole position, close_fraction).
    pub sz: f64,
    pub close_fraction: bool,
    pub sl: Option<f64>,
    pub tp: Option<f64>,
    pub c_time: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncOrder {
    pub inst_id: String,
    pub ord_id: String,
    pub cl_ord_id: String,
    /// live, partially_filled, filled, canceled, mmp_canceled.
    pub state: String,
    pub side: String,
    /// Its limit price (None: a market order), and size in contracts.
    pub px: Option<f64>,
    pub sz: f64,
    pub acc_fill_sz: f64,
    pub avg_px: Option<f64>,
    /// When it last filled and last changed (ms).
    pub fill_time: i64,
    pub u_time: i64,
    /// Its attached stop-loss and take-profit as they stand (an order not filled yet).
    pub sl: Option<f64>,
    pub tp: Option<f64>,
    pub attach_algo_cl_ord_id: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncEvent {
    pub demo: bool,
    /// "rest": the whole picture read again; "ws": a change pushed.
    pub source: &'static str,
    pub positions: Vec<SyncPos>,
    pub algos: Vec<SyncAlgo>,
    /// Orders that changed since the last event.
    pub orders: Vec<SyncOrder>,
}

#[derive(Serialize, Clone)]
pub struct SyncStatus {
    /// off, connecting, ws, polling, error.
    pub state: &'static str,
    pub detail: String,
}

fn num(v: &Value, f: &str) -> Option<f64> {
    v[f].as_str().and_then(|s| s.parse::<f64>().ok()).filter(|x| x.is_finite())
}
fn ms(v: &Value, f: &str) -> i64 {
    v[f].as_str().and_then(|s| s.parse().ok()).unwrap_or(0)
}
fn text(v: &Value, f: &str) -> String {
    v[f].as_str().unwrap_or("").to_string()
}
const fn above0(x: &f64) -> bool {
    *x > 0.0
}

pub fn parse_pos(v: &Value) -> Option<SyncPos> {
    let inst_id = text(v, "instId");
    if !inst_id.ends_with("-USDT-SWAP") || text(v, "posId").is_empty() {
        return None;
    }
    Some(SyncPos {
        inst_id,
        pos_id: text(v, "posId"),
        pos_side: text(v, "posSide"),
        pos: num(v, "pos").unwrap_or(0.0),
        avg_px: num(v, "avgPx").unwrap_or(0.0),
        upl: num(v, "upl").unwrap_or(0.0),
        mark_px: num(v, "markPx").unwrap_or(0.0),
        liq_px: num(v, "liqPx").filter(above0),
        lever: num(v, "lever").unwrap_or(0.0),
        mgn_mode: text(v, "mgnMode"),
        c_time: ms(v, "cTime"),
        u_time: ms(v, "uTime"),
    })
}

pub fn parse_algo(v: &Value) -> Option<SyncAlgo> {
    let inst_id = text(v, "instId");
    let ord_type = text(v, "ordType");
    if !inst_id.ends_with("-USDT-SWAP") || !matches!(ord_type.as_str(), "conditional" | "oco") || text(v, "algoId").is_empty() {
        return None;
    }
    Some(SyncAlgo {
        inst_id,
        algo_id: text(v, "algoId"),
        algo_cl_ord_id: text(v, "algoClOrdId"),
        ord_type,
        side: text(v, "side"),
        pos_side: text(v, "posSide"),
        sz: num(v, "sz").unwrap_or(0.0),
        close_fraction: text(v, "closeFraction") == "1",
        sl: num(v, "slTriggerPx").filter(above0),
        tp: num(v, "tpTriggerPx").filter(above0),
        c_time: ms(v, "cTime"),
    })
}

/// A TP/SL order still waiting (OKX's pending list says "live"; pushes say what became of it).
fn waiting(v: &Value) -> bool {
    matches!(v["state"].as_str(), None | Some("live") | Some("partially_effective"))
}

pub fn parse_order(v: &Value) -> Option<SyncOrder> {
    let inst_id = text(v, "instId");
    if !inst_id.ends_with("-USDT-SWAP") || text(v, "ordId").is_empty() {
        return None;
    }
    let a = v["attachAlgoOrds"].get(0).cloned().unwrap_or(Value::Null);
    Some(SyncOrder {
        inst_id,
        ord_id: text(v, "ordId"),
        cl_ord_id: text(v, "clOrdId"),
        state: text(v, "state"),
        side: text(v, "side"),
        px: num(v, "px").filter(above0),
        sz: num(v, "sz").unwrap_or(0.0),
        acc_fill_sz: num(v, "accFillSz").unwrap_or(0.0),
        avg_px: num(v, "avgPx").filter(above0),
        fill_time: ms(v, "fillTime"),
        u_time: ms(v, "uTime"),
        sl: num(&a, "slTriggerPx").filter(above0),
        tp: num(&a, "tpTriggerPx").filter(above0),
        attach_algo_cl_ord_id: text(&a, "attachAlgoClOrdId"),
    })
}

/// What is known of the account: positions by posId, TP/SL orders by algoId, order changes not sent yet.
#[derive(Default)]
pub struct Book {
    positions: BTreeMap<String, SyncPos>,
    algos: BTreeMap<String, SyncAlgo>,
    orders: Vec<SyncOrder>,
}

impl Book {
    /// The whole picture, as read over REST.
    pub fn replace(&mut self, positions: &[Value], algos: &[Value]) {
        self.positions = positions.iter().filter_map(parse_pos).filter(|p| p.pos != 0.0).map(|p| (p.pos_id.clone(), p)).collect();
        self.algos = algos.iter().filter(|v| waiting(v)).filter_map(parse_algo).map(|a| (a.algo_id.clone(), a)).collect();
    }

    /// A push on one channel; true when anything changed.
    pub fn push(&mut self, channel: &str, data: &[Value]) -> bool {
        let mut changed = false;
        for v in data {
            match channel {
                "positions" => {
                    let Some(p) = parse_pos(v) else { continue };
                    changed |= if p.pos == 0.0 {
                        self.positions.remove(&p.pos_id).is_some() // closed
                    } else {
                        self.positions.insert(p.pos_id.clone(), p.clone()).as_ref() != Some(&p)
                    };
                }
                "orders-algo" => {
                    let Some(a) = parse_algo(v) else { continue };
                    changed |= if waiting(v) {
                        self.algos.insert(a.algo_id.clone(), a.clone()).as_ref() != Some(&a)
                    } else {
                        self.algos.remove(&a.algo_id).is_some() // went off, or canceled
                    };
                }
                "orders" => {
                    if let Some(o) = parse_order(v) {
                        self.orders.push(o);
                        changed = true;
                    }
                }
                _ => {}
            }
        }
        changed
    }

    /// Everything as one event (the order changes go with it once).
    pub fn event(&mut self, demo: bool, source: &'static str) -> SyncEvent {
        SyncEvent {
            demo,
            source,
            positions: self.positions.values().cloned().collect(),
            algos: self.algos.values().cloned().collect(),
            orders: std::mem::take(&mut self.orders),
        }
    }

    /// Read the whole picture again over REST.
    async fn reload(&mut self, trader: &Trader) -> Result<(), String> {
        let positions = trader.positions().await?;
        let algos = trader.algos().await?;
        self.replace(&positions, &algos);
        Ok(())
    }
}

/// Following the account on or off; a new key starts it over.
#[derive(Default)]
pub struct Syncer {
    on: Mutex<bool>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl Syncer {
    pub fn set(&self, app: &AppHandle, on: bool) {
        *self.on.lock().unwrap_or_else(|e| e.into_inner()) = on;
        self.restart(app);
    }

    /// From the start (the key may have changed), or stopped when off.
    pub fn restart(&self, app: &AppHandle) {
        let mut task = self.task.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(t) = task.take() {
            t.abort();
        }
        if !*self.on.lock().unwrap_or_else(|e| e.into_inner()) {
            status(app, "off", "");
            return;
        }
        let app = app.clone();
        *task = Some(tauri::async_runtime::spawn(async move { run(app).await }));
    }
}

fn status(app: &AppHandle, state: &'static str, detail: &str) {
    let _ = app.emit("okx_sync_status", SyncStatus { state, detail: detail.to_string() });
}

/// Keep following: the whole picture, then the WebSocket; after three failed sessions in a row, REST every
/// 5 seconds for five minutes before the WebSocket is tried again.
async fn run(app: AppHandle) {
    let mut failures = 0u32;
    loop {
        let st = app.state::<AppState>();
        let Some(demo) = st.trader.keys_set() else {
            status(&app, "off", if st.trader.status().locked { "API 已鎖定，解鎖後才會同步" } else { "還沒設定 OKX API" });
            return;
        };
        status(&app, "connecting", "");
        let mut book = Book::default();
        match book.reload(&st.trader).await {
            Ok(()) => {
                let _ = app.emit("okx_sync", book.event(demo, "rest"));
            }
            Err(e) => status(&app, "error", &e),
        }
        let mut why = String::new();
        match session(&app, &st.trader, &mut book, demo).await {
            Ok(()) => failures = 0,
            Err(e) => {
                failures += 1;
                status(&app, "error", &e);
                why = e;
            }
        }
        if failures >= 3 {
            status(&app, "polling", &why); // why the WebSocket couldn't be used, shown with "every 5 seconds"
            for _ in 0..60 {
                tokio::time::sleep(Duration::from_secs(5)).await;
                match book.reload(&st.trader).await {
                    Ok(()) => {
                        let _ = app.emit("okx_sync", book.event(demo, "rest"));
                    }
                    Err(e) => status(&app, "error", &e),
                }
            }
            failures = 0;
        } else {
            tokio::time::sleep(Duration::from_secs(1 << failures.min(4))).await;
        }
    }
}

/// One of the account's WebSockets, logged in and subscribed.
struct Feed {
    /// 私人頻道 or 業務頻道, for the messages.
    name: &'static str,
    tx: SplitSink<Ws, Message>,
    rx: SplitStream<Ws>,
}

impl Feed {
    /// Connect to `url`, log in, and subscribe to `channels` (USDT perpetuals).
    async fn open(trader: &Trader, name: &'static str, url: &str, channels: &[&str]) -> Result<Feed, String> {
        let (login, _) = trader.ws_login().await?;
        let (ws, _) = tokio::time::timeout(Duration::from_secs(10), connect_async(url))
            .await
            .map_err(|_| format!("{name}連線逾時"))?
            .map_err(|e| format!("{name}：{e}"))?;
        let (mut tx, mut rx) = ws.split();
        tx.send(Message::Text(login.to_string().into())).await.map_err(|e| format!("{name}：{e}"))?;
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(10), rx.next())
                .await
                .map_err(|_| format!("{name}登入逾時"))?
                .ok_or_else(|| format!("{name}連線被關閉"))?
                .map_err(|e| format!("{name}：{e}"))?;
            let Message::Text(t) = msg else { continue };
            let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
            match v["event"].as_str() {
                Some("login") if v["code"] == "0" => break,
                Some("login") | Some("error") => {
                    return Err(format!("OKX 拒絕{name}登入（{}：{}）", v["code"].as_str().unwrap_or(""), v["msg"].as_str().unwrap_or("")));
                }
                _ => {}
            }
        }
        let args: Vec<Value> = channels.iter().map(|c| json!({"channel": c, "instType": "SWAP"})).collect();
        tx.send(Message::Text(json!({"op": "subscribe", "args": args}).to_string().into())).await.map_err(|e| format!("{name}：{e}"))?;
        Ok(Feed { name, tx, rx })
    }

    /// One frame: a push goes into the book (and to the page when it changed something). Ok(false): the socket
    /// closed; Err: it failed, or OKX answered with an error (a channel it refused).
    async fn take(
        &mut self,
        app: &AppHandle,
        book: &mut Book,
        demo: bool,
        next: Result<Option<Result<Message, tungstenite::Error>>, tokio::time::error::Elapsed>,
    ) -> Result<bool, String> {
        let name = self.name;
        let Some(msg) = next.map_err(|_| format!("{name} 45 秒沒有收到資料"))? else { return Ok(false) };
        match msg.map_err(|e| format!("{name}：{e}"))? {
            Message::Text(t) if t.as_str() == "pong" => {}
            Message::Text(t) => {
                let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
                if v["event"] == "error" {
                    return Err(format!("OKX {name}：{} {}", v["code"].as_str().unwrap_or(""), v["msg"].as_str().unwrap_or("")));
                }
                if let (Some(ch), Some(data)) = (v["arg"]["channel"].as_str(), v["data"].as_array()) {
                    if book.push(ch, data) {
                        let _ = app.emit("okx_sync", book.event(demo, "ws"));
                    }
                }
            }
            Message::Ping(p) => self.tx.send(Message::Pong(p)).await.map_err(|e| format!("{name}：{e}"))?,
            Message::Close(_) => return Ok(false),
            _ => {}
        }
        Ok(true)
    }

    async fn ping(&mut self) -> Result<(), String> {
        let name = self.name;
        self.tx.send(Message::Text("ping".into())).await.map_err(|e| format!("{name}：{e}"))
    }
}

/// One session over both WebSockets: positions and orders on the private one, TP/SL orders on the business one;
/// pass the pushes on, ping both every 20 s, check against REST every minute; until one closes (Ok) or fails
/// (Err, with why).
async fn session(app: &AppHandle, trader: &Trader, book: &mut Book, demo: bool) -> Result<(), String> {
    let (private_url, business_url) = okx::account_ws_urls(demo);
    let mut private = Feed::open(trader, "私人頻道", &private_url, &["positions", "orders"]).await?;
    let mut business = Feed::open(trader, "業務頻道", &business_url, &["orders-algo"]).await?;
    status(app, "ws", "");
    let mut ping = tokio::time::interval(Duration::from_secs(20));
    ping.tick().await;
    let mut check = tokio::time::interval(Duration::from_secs(60));
    check.tick().await;
    let wait = Duration::from_secs(45);
    loop {
        tokio::select! {
            next = tokio::time::timeout(wait, private.rx.next()) => {
                if !private.take(app, book, demo, next).await? {
                    return Ok(());
                }
            }
            next = tokio::time::timeout(wait, business.rx.next()) => {
                if !business.take(app, book, demo, next).await? {
                    return Ok(());
                }
            }
            _ = ping.tick() => {
                private.ping().await?;
                business.ping().await?;
            }
            _ = check.tick() => {
                if book.reload(trader).await.is_ok() {
                    let _ = app.emit("okx_sync", book.event(demo, "rest"));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(id: &str, sz: &str) -> Value {
        json!({"instId": "BTC-USDT-SWAP", "posId": id, "posSide": "net", "pos": sz, "avgPx": "78000.5", "upl": "12.3",
            "markPx": "78100", "liqPx": "", "lever": "10", "mgnMode": "isolated", "cTime": "1793426400000", "uTime": "1793430000000"})
    }
    fn algo(id: &str, state: &str, sl: &str) -> Value {
        json!({"instId": "BTC-USDT-SWAP", "algoId": id, "algoClOrdId": "qtc1s", "ordType": "conditional", "side": "sell",
            "posSide": "net", "sz": "3", "closeFraction": "", "slTriggerPx": sl, "tpTriggerPx": "", "state": state, "cTime": "1"})
    }

    #[test]
    fn reads_and_follows() {
        let mut b = Book::default();
        b.replace(&[pos("1", "3"), pos("2", "0"), json!({"instId": "BTC-USDT", "posId": "9", "pos": "1"})], &[algo("5", "live", "77000")]);
        let e = b.event(false, "rest");
        assert_eq!(e.positions.len(), 1); // the empty one and the spot one are left out
        assert_eq!(e.positions[0].pos, 3.0);
        assert_eq!(e.positions[0].liq_px, None);
        assert_eq!(e.algos[0].sl, Some(77000.0));
        assert_eq!(e.algos[0].tp, None);
        // the stop moved on OKX
        assert!(b.push("orders-algo", &[algo("5", "live", "77500")]));
        assert_eq!(b.event(false, "ws").algos[0].sl, Some(77500.0));
        assert!(!b.push("orders-algo", &[algo("5", "live", "77500")])); // nothing new
        // it went off: gone; the position closed: gone
        assert!(b.push("orders-algo", &[algo("5", "effective", "77500")]));
        assert!(b.push("positions", &[pos("1", "0")]));
        let e = b.event(false, "ws");
        assert!(e.positions.is_empty() && e.algos.is_empty());
        // an order change goes out once, with its attached stop and take-profit
        let o = json!({"instId": "BTC-USDT-SWAP", "ordId": "70", "clOrdId": "qtc1", "state": "filled", "side": "buy", "sz": "3",
            "accFillSz": "3", "avgPx": "78000", "fillTime": "1793426400100", "uTime": "1793426400100",
            "attachAlgoOrds": [{"attachAlgoClOrdId": "qtc1s", "slTriggerPx": "77000", "tpTriggerPx": "80000"}]});
        assert!(b.push("orders", &[o]));
        let e = b.event(false, "ws");
        assert_eq!(e.orders.len(), 1);
        assert_eq!((e.orders[0].sl, e.orders[0].tp, e.orders[0].attach_algo_cl_ord_id.as_str()), (Some(77000.0), Some(80000.0), "qtc1s"));
        assert!(b.event(false, "ws").orders.is_empty());
    }
}
