//! One OKX WebSocket session (business endpoint): connect, subscribe, keep it alive with "ping" every 20 s,
//! and hand each frame to the caller until the connection closes (Ok) or fails (Err). And the retry policy
//! around it. Shared by the chart's stream and the alert watcher, which only say what to subscribe to and what
//! to do with the candles.

use crate::okx::{self, WsMsg};
use futures_util::{SinkExt, StreamExt};
use std::future::Future;
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub async fn session(args: &[serde_json::Value], mut on: impl FnMut(WsMsg) + Send) -> Result<(), String> {
    let (ws, _) = tokio::time::timeout(Duration::from_secs(10), connect_async(okx::ws_url()))
        .await
        .map_err(|_| "連線逾時".to_string())?
        .map_err(|e| e.to_string())?;
    let (mut tx, mut rx) = ws.split();
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
                        WsMsg::Error(e) => return Err(e),
                        m => on(m),
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

/// Keep a feed going forever: WebSocket sessions with growing pauses after failures (1, 2, 4… up to 16 s);
/// after three failures in a row, `poll` instead for five minutes (some networks block port 8443), then try
/// the WebSocket again.
pub async fn keep_alive<S, SF, P, PF>(mut session: S, mut poll: P)
where
    S: FnMut() -> SF,
    SF: Future<Output = Result<(), String>>,
    P: FnMut(Duration) -> PF,
    PF: Future<Output = ()>,
{
    let mut failures = 0u32;
    loop {
        match session().await {
            Ok(()) => failures = 0,
            Err(_) => failures += 1,
        }
        if failures >= 3 {
            poll(Duration::from_secs(300)).await;
            failures = 0;
        } else {
            tokio::time::sleep(Duration::from_secs(1 << failures.min(4))).await;
        }
    }
}
