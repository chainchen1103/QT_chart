//! Live candles for the symbol on screen: OKX WebSocket first; if it keeps failing (some networks block
//! port 8443), poll the REST endpoint every 2 seconds for a while, then try the WebSocket again (ws.rs).
//! Events to the window: "candle" (CandleEvent) and "stream_status" (StatusEvent).

use crate::okx::{Candle, Client, WsMsg};
use crate::ws;
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

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
    let args = vec![serde_json::json!({"channel": format!("candle{bar}"), "instId": inst_id})];
    // each attempt gets its own copies, so its future owns everything it uses
    let session = || {
        let (app, args, inst_id, bar) = (app.clone(), args.clone(), inst_id.clone(), bar.clone());
        async move {
            status(&app, "connecting", "");
            let mut live = false;
            let r = ws::session(&args, |m| match m {
                WsMsg::Candles(_, cs) => {
                    if !live {
                        live = true;
                        status(&app, "ws", "");
                    }
                    send_candles(&app, &inst_id, &bar, cs);
                }
                WsMsg::Subscribed if !live => {
                    live = true;
                    status(&app, "ws", "");
                }
                _ => {}
            })
            .await;
            if let Err(e) = &r {
                status(&app, "error", format!("WebSocket {e}"));
            }
            r
        }
    };
    let poll = |how_long| {
        let (app, client, inst_id, bar) = (app.clone(), client.clone(), inst_id.clone(), bar.clone());
        async move { poll_for(&app, &client, &inst_id, &bar, how_long).await }
    };
    ws::keep_alive(session, poll).await;
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
