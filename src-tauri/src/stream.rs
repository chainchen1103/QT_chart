//! Live candles for everything that needs them (the charts on screen, the price alerts, the prices on the
//! tabs) over one OKX WebSocket, whose subscriptions follow the page's list without reconnecting. If the
//! WebSocket keeps failing (some networks block port 8443), the REST endpoint is polled every 2 seconds for a
//! while, then the WebSocket is tried again (ws.rs).
//!
//! The page asks for its own timeframes (bars.rs): those OKX streams itself are passed on as they come; the
//! others are put together here from the OKX channel they are made of (5s from 1s, 45m from 15m, …), after
//! loading the start of the bar now forming from REST.
//! Events to the window: "candle" (CandleEvent) and "stream_status" (StatusEvent).

use crate::bars::{self, Builder, Spec};
use crate::okx::{Candle, Client, Pair, WsMsg};
use crate::ws;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};
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

/// One of the page's timeframes, fed by an OKX channel.
struct Route {
    app: Pair,
    spec: Spec,
    /// Seconds of the OKX bars it is made of.
    part_sec: i64,
    /// None: the channel's candles are its bars.
    builder: Option<Builder>,
}

/// The page's timeframes by the OKX channel they come from.
#[derive(Default)]
struct Router {
    routes: BTreeMap<Pair, Vec<Route>>,
}

impl Router {
    /// Follow a new list (builders of timeframes still wanted keep their bar). Returns the OKX channels to
    /// subscribe, and the timeframes whose forming bar needs its start loaded.
    fn set(&mut self, pairs: &[Pair]) -> (Vec<Pair>, Vec<Pair>) {
        let mut old: Vec<Route> = std::mem::take(&mut self.routes).into_values().flatten().collect();
        let mut fills = Vec::new();
        for p in pairs {
            let Some(spec) = bars::spec(&p.bar) else { continue };
            let channel = Pair { inst_id: p.inst_id.clone(), bar: spec.live.to_string() };
            let route = match old.iter().position(|r| r.app == *p) {
                Some(i) => old.swap_remove(i),
                None => {
                    let built = spec.live_n > 1;
                    if built {
                        fills.push(p.clone());
                    }
                    Route { app: p.clone(), part_sec: bars::okx_sec(spec.live), builder: built.then(Builder::default), spec }
                }
            };
            self.routes.entry(channel).or_default().push(route);
        }
        (self.routes.keys().cloned().collect(), fills)
    }

    /// Candles of an OKX channel: the bars to send, for every timeframe made from it.
    fn on_candles(&mut self, channel: &Pair, cs: &[Candle]) -> Vec<(Pair, Candle)> {
        let mut out = Vec::new();
        for r in self.routes.get_mut(channel).into_iter().flatten() {
            for c in cs {
                match &mut r.builder {
                    None => out.push((r.app.clone(), c.clone())),
                    Some(b) => out.extend(b.push(&r.spec, r.part_sec, c.clone()).into_iter().map(|bar| (r.app.clone(), bar))),
                }
            }
        }
        out
    }

    /// The start of a forming bar, loaded from REST.
    fn fill(&mut self, app: &Pair, recent: &[Candle]) -> Option<Candle> {
        let r = self.routes.values_mut().flatten().find(|r| r.app == *app)?;
        let (spec, part_sec) = (r.spec.clone(), r.part_sec);
        r.builder.as_mut()?.fill(&spec, part_sec, recent)
    }

    /// A new connection may have missed parts: every built timeframe loads its forming bar again.
    fn refill_all(&mut self) -> Vec<Pair> {
        let mut out = Vec::new();
        for r in self.routes.values_mut().flatten() {
            if let Some(b) = &mut r.builder {
                *b = Builder::default();
                out.push(r.app.clone());
            }
        }
        out
    }

    fn apps(&self) -> Vec<Pair> {
        self.routes.values().flatten().map(|r| r.app.clone()).collect()
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Default)]
pub struct Live {
    state: Mutex<State>,
    router: Arc<Mutex<Router>>,
}

#[derive(Default)]
struct State {
    /// The OKX channels the running feed follows.
    subs: Option<watch::Sender<Vec<Pair>>>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Live {
    /// Stream exactly these (an empty list stops). A change goes to the open connection; the same list again
    /// changes nothing.
    pub fn set(&self, app: AppHandle, client: Client, mut pairs: Vec<Pair>) {
        pairs.sort();
        pairs.dedup();
        let (channels, fills) = lock(&self.router).set(&pairs);
        let mut s = lock(&self.state);
        if pairs.is_empty() {
            if let Some(h) = s.task.take() {
                h.abort();
            }
            s.subs = None;
            return;
        }
        for p in fills {
            spawn_fill(app.clone(), client.clone(), self.router.clone(), p);
        }
        if let Some(tx) = &s.subs {
            tx.send_if_modified(|cur| {
                if *cur == channels {
                    return false;
                }
                *cur = channels;
                true
            });
            return;
        }
        let (tx, rx) = watch::channel(channels);
        s.task = Some(tauri::async_runtime::spawn(run(app, client, rx, self.router.clone())));
        s.subs = Some(tx);
    }
}

/// Load the start of a built timeframe's forming bar (the OKX bars it is made of, from REST).
fn spawn_fill(app: AppHandle, client: Client, router: Arc<Mutex<Router>>, p: Pair) {
    tauri::async_runtime::spawn(async move {
        let Some(spec) = bars::spec(&p.bar) else { return };
        let Ok(recent) = client.latest(&p.inst_id, spec.live, (spec.live_n + 1) as usize).await else { return };
        let bar = lock(&router).fill(&p, &recent);
        if let Some(c) = bar {
            send_candles(&app, &p, vec![c]);
        }
    });
}

fn status(app: &AppHandle, state: &'static str, detail: impl Into<String>) {
    let _ = app.emit("stream_status", StatusEvent { state, detail: detail.into() });
}

fn send_candles(app: &AppHandle, p: &Pair, cs: Vec<Candle>) {
    for candle in cs {
        let _ = app.emit("candle", CandleEvent { inst_id: p.inst_id.clone(), bar: p.bar.clone(), candle });
    }
}

async fn run(app: AppHandle, client: Client, subs: watch::Receiver<Vec<Pair>>, router: Arc<Mutex<Router>>) {
    // each attempt gets its own copies, so its future owns everything it uses
    let session = || {
        let (app, client, mut subs, router) = (app.clone(), client.clone(), subs.clone(), router.clone());
        async move {
            status(&app, "connecting", "");
            for p in lock(&router).refill_all() {
                spawn_fill(app.clone(), client.clone(), router.clone(), p);
            }
            let mut live = false;
            let r = ws::session(&mut subs, |m| match m {
                WsMsg::Candles(Some(channel), cs) => {
                    if !live {
                        live = true;
                        status(&app, "ws", "");
                    }
                    let out = lock(&router).on_candles(&channel, &cs);
                    for (p, c) in out {
                        send_candles(&app, &p, vec![c]);
                    }
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
        let (app, client, router) = (app.clone(), client.clone(), router.clone());
        async move { poll_for(&app, &client, &router, how_long).await }
    };
    ws::keep_alive(session, poll).await;
}

/// The newest two bars of a timeframe from REST (put together when OKX hasn't got it).
async fn latest_bars(client: &Client, p: &Pair) -> Result<Vec<Candle>, String> {
    let spec = bars::spec(&p.bar).ok_or_else(|| format!("不支援的週期：{}", p.bar))?;
    if spec.hist_n == 1 {
        return client.latest(&p.inst_id, spec.hist, 2).await;
    }
    let parts = client.latest(&p.inst_id, spec.hist, (spec.hist_n * 2) as usize).await?;
    let mut out = bars::group(&spec, &parts, bars::okx_sec(spec.hist), true);
    if out.len() > 2 {
        out.drain(..out.len() - 2);
    }
    Ok(out)
}

async fn poll_for(app: &AppHandle, client: &Client, router: &Arc<Mutex<Router>>, how_long: Duration) {
    status(app, "polling", "");
    let mut failing = false;
    let end = Instant::now() + how_long;
    while Instant::now() < end {
        let pairs = lock(router).apps();
        for p in &pairs {
            match latest_bars(client, p).await {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(bar: &str) -> Pair {
        Pair { inst_id: "BTC-USDT-SWAP".into(), bar: bar.into() }
    }
    fn c(time: i64, close: f64, confirmed: bool) -> Candle {
        Candle { time, open: close, high: close, low: close, close, volume: 1.0, confirmed }
    }

    #[test]
    fn routes_timeframes_to_channels() {
        let mut r = Router::default();
        let (channels, fills) = r.set(&[pair("1s"), pair("5s"), pair("10s"), pair("15m"), pair("45m")]);
        assert_eq!(channels, vec![pair("15m"), pair("1s")]);
        assert_eq!(fills, vec![pair("5s"), pair("10s"), pair("45m")]);
        // 1s passes through at once; 5s and 10s, joined in the middle of a bar, wait for its start
        let out = r.on_candles(&pair("1s"), &[c(1003, 5.0, false)]);
        assert_eq!(out, vec![(pair("1s"), c(1003, 5.0, false))]);
        assert_eq!(r.fill(&pair("5s"), &[c(1002, 4.0, true), c(1003, 5.0, false)]).unwrap().time, 1000);
        let out = r.on_candles(&pair("1s"), &[c(1004, 6.0, false)]);
        assert_eq!(out.iter().filter(|(p, _)| p.bar == "5s").count(), 1);
        assert_eq!(out.iter().filter(|(p, _)| p.bar == "10s").count(), 0);
        // the same list again keeps the built bars; a smaller one drops the rest
        let (_, fills) = r.set(&[pair("5s")]);
        assert!(fills.is_empty());
        assert_eq!(r.apps(), vec![pair("5s")]);
        assert_eq!(r.refill_all(), vec![pair("5s")]);
    }
}
