//! Live candles for everything that needs them (the charts on screen, the price alerts, the prices on the
//! tabs) over one OKX WebSocket, whose subscriptions follow the page's list without reconnecting. If the
//! WebSocket keeps failing (some networks block port 8443), the REST endpoint is polled every 2 seconds for a
//! while, then the WebSocket is tried again (ws.rs).
//! Events to the window: "candle" (CandleEvent) and "stream_status" (StatusEvent).

use crate::okx::{Candle, Client, Pair, WsMsg};
use crate::ws;
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

/// At most this many symbol-and-timeframe channels at once (charts, every alerted symbol, tabs).
pub const MAX_PAIRS: usize = 300;

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
pub struct Live {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// The list the running feed follows.
    subs: Option<watch::Sender<Vec<Pair>>>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Live {
    /// Stream exactly these (an empty list stops). A change goes to the open connection; the same list again
    /// changes nothing.
    pub fn set(&self, app: AppHandle, client: Client, mut pairs: Vec<Pair>) {
        pairs.sort();
        pairs.dedup();
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if pairs.is_empty() {
            if let Some(h) = s.task.take() {
                h.abort();
            }
            s.subs = None;
            return;
        }
        if let Some(tx) = &s.subs {
            tx.send_if_modified(|cur| {
                if *cur == pairs {
                    return false;
                }
                *cur = pairs;
                true
            });
            return;
        }
        let (tx, rx) = watch::channel(pairs);
        s.task = Some(tauri::async_runtime::spawn(run(app, client, rx)));
        s.subs = Some(tx);
    }
}

fn status(app: &AppHandle, state: &'static str, detail: impl Into<String>) {
    let _ = app.emit("stream_status", StatusEvent { state, detail: detail.into() });
}

fn send_candles(app: &AppHandle, p: &Pair, cs: Vec<Candle>) {
    for candle in cs {
        let _ = app.emit("candle", CandleEvent { inst_id: p.inst_id.clone(), bar: p.bar.clone(), candle });
    }
}

async fn run(app: AppHandle, client: Client, subs: watch::Receiver<Vec<Pair>>) {
    // each attempt gets its own copies, so its future owns everything it uses
    let session = || {
        let (app, mut subs) = (app.clone(), subs.clone());
        async move {
            status(&app, "connecting", "");
            let mut live = false;
            let r = ws::session(&mut subs, |m| match m {
                WsMsg::Candles(Some(p), cs) => {
                    if !live {
                        live = true;
                        status(&app, "ws", "");
                    }
                    send_candles(&app, &p, cs);
                }
                WsMsg::Subscribed if !live => {
                    live = true;
                    status(&app, "ws", "");
                }
                WsMsg::Error(e) => status(&app, if live { "ws" } else { "error" }, format!("有一項訂閱失敗：{e}")),
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
        let (app, client, subs) = (app.clone(), client.clone(), subs.clone());
        async move { poll_for(&app, &client, &subs, how_long).await }
    };
    ws::keep_alive(session, poll).await;
}

async fn poll_for(app: &AppHandle, client: &Client, subs: &watch::Receiver<Vec<Pair>>, how_long: Duration) {
    status(app, "polling", "");
    let mut failing = false;
    let end = Instant::now() + how_long;
    while Instant::now() < end {
        let pairs = subs.borrow().clone();
        for p in &pairs {
            match client.latest(&p.inst_id, &p.bar, 2).await {
                Ok(cs) => {
                    if failing {
                        failing = false;
                        status(app, "polling", "");
                    }
                    send_candles(app, p, cs);
                }
                Err(e) => {
                    failing = true;
                    status(app, "error", format!("輪詢失敗：{e}"));
                }
            }
            if pairs.len() > 1 {
                tokio::time::sleep(Duration::from_millis(60)).await; // stay well under 20 requests a second
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
