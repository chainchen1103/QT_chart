//! Prices for the alerts: 1-minute candles of every symbol that has an alert switched on, over one OKX
//! WebSocket; if it keeps failing, the REST endpoint is polled every 3 seconds for a while (ws.rs). Kept apart
//! from the chart's stream, so alerts keep working whatever the chart shows. Event to the window: "watch_candle".

use crate::okx::{self, Client, WsMsg};
use crate::stream::CandleEvent;
use crate::ws;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

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
    let args: Vec<serde_json::Value> = ids.iter().map(|id| serde_json::json!({"channel": "candle1m", "instId": id})).collect();
    let session = || {
        let (app, args) = (app.clone(), args.clone());
        async move {
            ws::session(&args, |m| {
                if let WsMsg::Candles(Some(inst), cs) = m {
                    send(&app, &inst, cs);
                }
            })
            .await
        }
    };
    let poll = |how_long| {
        let (app, client, ids) = (app.clone(), client.clone(), ids.clone());
        async move { poll_for(&app, &client, &ids, how_long).await }
    };
    ws::keep_alive(session, poll).await;
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
