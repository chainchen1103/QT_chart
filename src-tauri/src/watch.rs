//! Prices for the alerts: 1-minute candles of every symbol that has an alert switched on, over one OKX
//! WebSocket; if it keeps failing, the REST endpoint is polled every 3 seconds for a while. Kept apart from the
//! chart's stream, so alerts keep working whatever the chart shows. Event to the window: "watch_candle".

use crate::okx::{self, Client, WsMsg};
use crate::stream::CandleEvent;
use futures_util::{SinkExt, StreamExt};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// At most this many symbols are watched at once.
pub const MAX_WATCH: usize = 50;

#[derive(Default)]
pub struct Watcher {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    ids: Vec<String>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Watcher {
    /// Watch exactly these symbols (an empty list stops watching). The same list again changes nothing.
    pub fn set(&self, app: AppHandle, client: Client, mut ids: Vec<String>) {
        ids.sort();
        ids.dedup();
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if s.ids == ids && (s.task.is_some() || ids.is_empty()) {
            return;
        }
        if let Some(h) = s.task.take() {
            h.abort();
        }
        s.ids = ids.clone();
        if !ids.is_empty() {
            s.task = Some(tauri::async_runtime::spawn(run(app, client, ids)));
        }
    }
}

fn send(app: &AppHandle, inst_id: &str, cs: Vec<okx::Candle>) {
    for candle in cs {
        let _ = app.emit("watch_candle", CandleEvent { inst_id: inst_id.to_string(), bar: "1m".into(), candle });
    }
}

async fn run(app: AppHandle, client: Client, ids: Vec<String>) {
    let mut failures = 0u32;
    loop {
        match session(&app, &ids).await {
            Ok(()) => failures = 0,
            Err(_) => failures += 1,
        }
        if failures >= 3 {
            poll_for(&app, &client, &ids, Duration::from_secs(300)).await;
            failures = 0;
        } else {
            tokio::time::sleep(Duration::from_secs(1 << failures.min(4))).await;
        }
    }
}

async fn session(app: &AppHandle, ids: &[String]) -> Result<(), String> {
    let (ws, _) = tokio::time::timeout(Duration::from_secs(10), connect_async(okx::ws_url()))
        .await
        .map_err(|_| "連線逾時".to_string())?
        .map_err(|e| e.to_string())?;
    let (mut tx, mut rx) = ws.split();
    let args: Vec<serde_json::Value> = ids.iter().map(|id| serde_json::json!({"channel": "candle1m", "instId": id})).collect();
    let sub = serde_json::json!({"op": "subscribe", "args": args});
    tx.send(Message::Text(sub.to_string().into())).await.map_err(|e| e.to_string())?;
    let mut ping = tokio::time::interval(Duration::from_secs(20));
    ping.tick().await; // the first tick fires at once
    loop {
        tokio::select! {
            next = tokio::time::timeout(Duration::from_secs(45), rx.next()) => {
                let Some(msg) = next.map_err(|_| "45 秒沒有收到資料".to_string())? else { return Ok(()) };
                match msg.map_err(|e| e.to_string())? {
                    Message::Text(t) => match okx::parse_ws(t.as_str()) {
                        WsMsg::Candles(Some(inst), cs) => send(app, &inst, cs),
                        WsMsg::Error(e) => return Err(e),
                        _ => {}
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

async fn poll_for(app: &AppHandle, client: &Client, ids: &[String], how_long: Duration) {
    let end = Instant::now() + how_long;
    while Instant::now() < end {
        for id in ids {
            if let Ok(cs) = client.latest(id, "1m", 2).await {
                send(app, id, cs);
            }
            tokio::time::sleep(Duration::from_millis(60)).await; // stay well under 20 requests a second
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}
