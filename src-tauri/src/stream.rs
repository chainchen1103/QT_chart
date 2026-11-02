//! Live candles for the symbol on screen: OKX WebSocket first; if it keeps failing (some networks block
//! port 8443), poll the REST endpoint every 2 seconds for a while, then try the WebSocket again.
//! Events to the window: "candle" (CandleEvent) and "stream_status" (StatusEvent).

use crate::okx::{self, Candle, Client, WsMsg};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandleEvent {
    pub inst_id: String,
    pub bar: String,
    pub candle: Candle,
}

#[derive(Clone, Serialize)]
pub struct StatusEvent {
    pub state: &'static str,
    pub detail: String,
}

#[derive(Default)]
pub struct StreamManager {
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl StreamManager {
    /// Replace any running stream with one for this symbol and bar.
    pub fn start(&self, app: AppHandle, client: Client, inst_id: String, bar: String) {
        let mut guard = self.task.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(h) = guard.take() {
            h.abort();
        }
        *guard = Some(tauri::async_runtime::spawn(run(app, client, inst_id, bar)));
    }

    pub fn stop(&self) {
        if let Some(h) = self.task.lock().unwrap_or_else(|e| e.into_inner()).take() {
            h.abort();
        }
    }
}

fn status(app: &AppHandle, state: &'static str, detail: impl Into<String>) {
    let _ = app.emit("stream_status", StatusEvent { state, detail: detail.into() });
}

fn send_candles(app: &AppHandle, inst_id: &str, bar: &str, cs: Vec<Candle>) {
    for candle in cs {
        let _ = app.emit("candle", CandleEvent { inst_id: inst_id.to_string(), bar: bar.to_string(), candle });
    }
}

async fn run(app: AppHandle, client: Client, inst_id: String, bar: String) {
    let mut failures = 0u32;
    loop {
        status(&app, "connecting", "");
        match ws_session(&app, &inst_id, &bar).await {
            Ok(()) => failures = 0,
            Err(e) => {
                failures += 1;
                status(&app, "error", format!("WebSocket {e}"));
            }
        }
        if failures >= 3 {
            poll_for(&app, &client, &inst_id, &bar, Duration::from_secs(300)).await;
            failures = 0;
        } else {
            tokio::time::sleep(Duration::from_secs(1 << failures.min(4))).await;
        }
    }
}

async fn ws_session(app: &AppHandle, inst_id: &str, bar: &str) -> Result<(), String> {
    let (ws, _) = tokio::time::timeout(Duration::from_secs(10), connect_async(okx::ws_url()))
        .await
        .map_err(|_| "連線逾時".to_string())?
        .map_err(|e| e.to_string())?;
    let (mut tx, mut rx) = ws.split();
    let sub = serde_json::json!({"op": "subscribe", "args": [{"channel": format!("candle{bar}"), "instId": inst_id}]});
    tx.send(Message::Text(sub.to_string().into())).await.map_err(|e| e.to_string())?;
    let mut ping = tokio::time::interval(Duration::from_secs(20));
    ping.tick().await; // the first tick fires at once
    let mut live = false;
    loop {
        tokio::select! {
            next = tokio::time::timeout(Duration::from_secs(45), rx.next()) => {
                let Some(msg) = next.map_err(|_| "45 秒沒有收到資料".to_string())? else { return Ok(()) };
                match msg.map_err(|e| e.to_string())? {
                    Message::Text(t) => match okx::parse_ws(t.as_str()) {
                        WsMsg::Candles(_, cs) => {
                            if !live {
                                live = true;
                                status(app, "ws", "");
                            }
                            send_candles(app, inst_id, bar, cs);
                        }
                        WsMsg::Subscribed => {
                            live = true;
                            status(app, "ws", "");
                        }
                        WsMsg::Error(e) => return Err(e),
                        WsMsg::Other => {}
                    },
                    Message::Ping(p) => tx.send(Message::Pong(p)).await.map_err(|e| e.to_string())?,
                    Message::Close(_) => return Ok(()),
                    _ => {}
                }
            }
            _ = ping.tick() => {
                tx.send(Message::Text("ping".into())).await.map_err(|e| e.to_string())?;
            }
        }
    }
}

async fn poll_for(app: &AppHandle, client: &Client, inst_id: &str, bar: &str, how_long: Duration) {
    status(app, "polling", "");
    let end = Instant::now() + how_long;
    while Instant::now() < end {
        match client.latest(inst_id, bar, 2).await {
            Ok(cs) => send_candles(app, inst_id, bar, cs),
            Err(e) => status(app, "error", format!("輪詢失敗：{e}")),
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
