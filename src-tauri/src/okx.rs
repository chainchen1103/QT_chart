//! OKX public market data: instruments, tickers and candles over REST; candle messages from the WebSocket.
//! Public endpoints only: no keys.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::time::Duration;

pub const REST: &str = "https://www.okx.com";
pub const WS_BUSINESS: &str = "wss://ws.okx.com:8443/ws/v5/business";

/// The WebSocket address. QTCHART_WS_URL can point at another OKX host (e.g. wss://wsaws.okx.com:8443/ws/v5/business
/// when a network blocks the default one); debug builds also accept any address, for a local test server.
pub fn ws_url() -> String {
    let custom = std::env::var("QTCHART_WS_URL").ok().map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    match custom {
        Some(u) if cfg!(debug_assertions) || is_okx_ws(&u) => u,
        _ => WS_BUSINESS.to_string(),
    }
}

/// The private WebSocket (the account's own pushes, sync.rs); a demo key goes to OKX's demo-trading host.
/// Debug builds accept QTCHART_PRIVATE_WS_URL (a local test server).
pub fn private_ws_url(demo: bool) -> String {
    if cfg!(debug_assertions) {
        if let Ok(u) = std::env::var("QTCHART_PRIVATE_WS_URL") {
            let u = u.trim().to_string();
            if !u.is_empty() {
                return u;
            }
        }
    }
    if demo {
        "wss://wspap.okx.com:8443/ws/v5/private?brokerId=9999".to_string()
    } else {
        "wss://ws.okx.com:8443/ws/v5/private".to_string()
    }
}

/// Where orders and account requests go (trade.rs). Debug builds accept QTCHART_TRADE_URL (a local test
/// server); release builds always use OKX.
pub fn trade_base() -> String {
    if cfg!(debug_assertions) {
        if let Ok(u) = std::env::var("QTCHART_TRADE_URL") {
            let u = u.trim().trim_end_matches('/').to_string();
            if !u.is_empty() {
                return u;
            }
        }
    }
    REST.to_string()
}

/// wss:// on an okx.com host.
fn is_okx_ws(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("wss://") else { return false };
    let host = rest.split(['/', ':', '?']).next().unwrap_or("");
    host == "okx.com" || host.ends_with(".okx.com")
}

/// A timeframe the app can show (bars.rs: OKX's own, or put together from them).
pub fn valid_bar(bar: &str) -> bool {
    crate::bars::spec(bar).is_some()
}

pub fn valid_inst(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-')
}

/// A symbol and a timeframe, e.g. BTC-USDT-SWAP and 15m: one candle channel on the WebSocket.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pair {
    pub inst_id: String,
    pub bar: String,
}

impl Pair {
    pub fn valid(&self) -> bool {
        valid_inst(&self.inst_id) && valid_bar(&self.bar)
    }
    /// The subscription argument for this channel.
    pub fn arg(&self) -> serde_json::Value {
        serde_json::json!({"channel": format!("candle{}", self.bar), "instId": self.inst_id})
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Candle {
    /// Bar start, UTC seconds.
    pub time: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    /// Volume in the base currency (e.g. BTC).
    pub volume: f64,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instrument {
    pub inst_id: String,
    pub base: String,
    pub tick_sz: String,
    pub price_decimals: u32,
    pub last: f64,
    pub change_24h: f64,
    pub vol_usdt_24h: f64,
    /// Coins in one contract (orders are in contracts), the contract step and minimum, the highest leverage.
    pub ct_val: f64,
    pub lot_sz: String,
    pub min_sz: String,
    pub max_lever: u32,
}

/// One OKX candle row: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm] (strings).
pub fn parse_row(r: &[String]) -> Option<Candle> {
    let f = |i: usize| r.get(i).and_then(|s| s.parse::<f64>().ok());
    let ts: i64 = r.first()?.parse().ok()?;
    Some(Candle {
        time: ts / 1000,
        open: f(1)?,
        high: f(2)?,
        low: f(3)?,
        close: f(4)?,
        volume: f(6).or_else(|| f(5)).unwrap_or(0.0),
        confirmed: r.get(8).map(|s| s == "1").unwrap_or(true),
    })
}

/// Number of decimals in a tick size such as "0.01" (2) or "1" (0).
pub fn decimals_of(tick: &str) -> u32 {
    match tick.split_once('.') {
        Some((_, frac)) => frac.trim_end_matches('0').len() as u32,
        None => 0,
    }
}

#[derive(Deserialize)]
struct Envelope<T> {
    code: String,
    #[serde(default)]
    msg: String,
    data: Option<T>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawInstrument {
    inst_id: String,
    #[serde(default)]
    ct_val_ccy: String,
    #[serde(default)]
    settle_ccy: String,
    #[serde(default)]
    tick_sz: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    ct_val: String,
    #[serde(default)]
    lot_sz: String,
    #[serde(default)]
    min_sz: String,
    #[serde(default)]
    lever: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTicker {
    inst_id: String,
    #[serde(default)]
    last: String,
    #[serde(default)]
    open24h: String,
    #[serde(default)]
    vol_ccy24h: String,
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
}

impl Default for Client {
    fn default() -> Self {
        Self::new()
    }
}

impl Client {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("qtchart/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(20))
            .build()
            .expect("HTTP client");
        Self { http }
    }

    async fn get<T: DeserializeOwned>(&self, path: &str, query: &[(&str, String)]) -> Result<T, String> {
        let mut last_err = String::from("沒有回應");
        for attempt in 0..4u64 {
            match self.http.get(format!("{REST}{path}")).query(query).send().await {
                Ok(resp) => {
                    let status = resp.status();
                    let text = resp.text().await.map_err(|e| e.to_string())?;
                    if status.as_u16() == 429 {
                        last_err = "請求太頻繁（HTTP 429）".into();
                        tokio::time::sleep(Duration::from_millis(600 * (attempt + 1))).await;
                        continue;
                    }
                    if !status.is_success() {
                        return Err(format!("HTTP {status}：{}", text.chars().take(200).collect::<String>()));
                    }
                    let env: Envelope<T> = serde_json::from_str(&text).map_err(|e| format!("回應格式不對：{e}"))?;
                    if env.code == "0" {
                        return env.data.ok_or_else(|| "回應沒有資料".to_string());
                    }
                    if env.code == "50011" {
                        last_err = format!("OKX 限流：{}", env.msg);
                        tokio::time::sleep(Duration::from_millis(600 * (attempt + 1))).await;
                        continue;
                    }
                    return Err(format!("OKX {}：{}", env.code, env.msg));
                }
                Err(e) => {
                    last_err = e.to_string();
                    tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))).await;
                }
            }
        }
        Err(last_err)
    }

    /// Live USDT-margined perpetuals, most traded first.
    pub async fn instruments(&self) -> Result<Vec<Instrument>, String> {
        let raw: Vec<RawInstrument> = self.get("/api/v5/public/instruments", &[("instType", "SWAP".into())]).await?;
        let tickers: Vec<RawTicker> = self.get("/api/v5/market/tickers", &[("instType", "SWAP".into())]).await?;
        let by_id: std::collections::HashMap<&str, &RawTicker> = tickers.iter().map(|t| (t.inst_id.as_str(), t)).collect();
        let mut out: Vec<Instrument> = raw
            .iter()
            .filter(|i| i.settle_ccy == "USDT" && i.state == "live" && i.inst_id.ends_with("-USDT-SWAP"))
            .map(|i| {
                let t = by_id.get(i.inst_id.as_str());
                let num = |s: Option<&String>| s.and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
                let last = num(t.map(|t| &t.last));
                let open = num(t.map(|t| &t.open24h));
                let vol = num(t.map(|t| &t.vol_ccy24h));
                let base = if i.ct_val_ccy.is_empty() {
                    i.inst_id.split('-').next().unwrap_or_default().to_string()
                } else {
                    i.ct_val_ccy.clone()
                };
                Instrument {
                    inst_id: i.inst_id.clone(),
                    base,
                    tick_sz: i.tick_sz.clone(),
                    price_decimals: decimals_of(&i.tick_sz),
                    last,
                    change_24h: if open > 0.0 { last / open - 1.0 } else { 0.0 },
                    vol_usdt_24h: vol * last,
                    ct_val: i.ct_val.parse().unwrap_or(0.0),
                    lot_sz: i.lot_sz.clone(),
                    min_sz: i.min_sz.clone(),
                    max_lever: i.lever.parse().unwrap_or(0),
                }
            })
            .collect();
        out.sort_by(|a, b| b.vol_usdt_24h.partial_cmp(&a.vol_usdt_24h).unwrap_or(std::cmp::Ordering::Equal));
        Ok(out)
    }

    /// The newest `limit` bars (at most 300), oldest first; the last one may still be forming.
    pub async fn latest(&self, inst_id: &str, bar: &str, limit: usize) -> Result<Vec<Candle>, String> {
        let rows: Vec<Vec<String>> = self
            .get(
                "/api/v5/market/candles",
                &[("instId", inst_id.into()), ("bar", bar.into()), ("limit", limit.clamp(1, 300).to_string())],
            )
            .await?;
        let mut out: Vec<Candle> = rows.iter().filter_map(|r| parse_row(r)).collect();
        out.sort_by_key(|c| c.time);
        Ok(out)
    }

    /// About `count` bars, oldest first. Without `before_ms`: ending with the newest bar.
    /// With it: only bars that start before that time (UTC milliseconds), for scrolling back.
    pub async fn candles(&self, inst_id: &str, bar: &str, before_ms: Option<i64>, count: usize) -> Result<Vec<Candle>, String> {
        let count = count.clamp(1, 8000); // up to 8000 when they are parts of a longer timeframe (bars.rs)
        let mut out: Vec<Candle> = Vec::new();
        let mut cursor = before_ms;
        if cursor.is_none() {
            out = self.latest(inst_id, bar, count.min(300)).await?;
            cursor = out.first().map(|c| c.time * 1000);
        }
        while out.len() < count {
            let Some(after) = cursor else { break };
            let need = (count - out.len()).min(100);
            let rows: Vec<Vec<String>> = self
                .get(
                    "/api/v5/market/history-candles",
                    &[
                        ("instId", inst_id.into()),
                        ("bar", bar.into()),
                        ("after", after.to_string()),
                        ("limit", need.to_string()),
                    ],
                )
                .await?;
            let mut page: Vec<Candle> = rows.iter().filter_map(|r| parse_row(r)).filter(|c| c.time * 1000 < after).collect();
            if page.is_empty() {
                break;
            }
            page.sort_by_key(|c| c.time);
            cursor = page.first().map(|c| c.time * 1000);
            page.append(&mut out);
            out = page;
            tokio::time::sleep(Duration::from_millis(120)).await; // history endpoint: 20 requests / 2 s
        }
        out.dedup_by_key(|c| c.time);
        Ok(out)
    }
}

/// What a WebSocket text frame contains.
#[derive(Debug, PartialEq)]
pub enum WsMsg {
    /// Candles, and the symbol and timeframe they belong to (from the frame's "arg").
    Candles(Option<Pair>, Vec<Candle>),
    Subscribed,
    Error(String),
    Other,
}

pub fn parse_ws(text: &str) -> WsMsg {
    let v: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return WsMsg::Other,
    };
    if let Some(ev) = v.get("event").and_then(|e| e.as_str()) {
        return match ev {
            "subscribe" => WsMsg::Subscribed,
            "error" => WsMsg::Error(format!(
                "{} {}",
                v.get("code").and_then(|c| c.as_str()).unwrap_or(""),
                v.get("msg").and_then(|m| m.as_str()).unwrap_or("")
            )),
            _ => WsMsg::Other,
        };
    }
    if let Some(data) = v.get("data").and_then(|d| d.as_array()) {
        let cs: Vec<Candle> = data
            .iter()
            .filter_map(|row| {
                let r: Vec<String> = row.as_array()?.iter().map(|x| x.as_str().unwrap_or("").to_string()).collect();
                parse_row(&r)
            })
            .collect();
        if !cs.is_empty() {
            let pair = v.get("arg").and_then(|a| {
                let inst_id = a.get("instId")?.as_str()?.to_string();
                let bar = a.get("channel")?.as_str()?.strip_prefix("candle")?.to_string();
                Some(Pair { inst_id, bar })
            });
            return WsMsg::Candles(pair, cs);
        }
    }
    WsMsg::Other
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_a_candle_row() {
        let c = parse_row(&row(&["1793520000000", "78000.1", "78100", "77900.5", "78050", "1200", "12.5", "975000", "0"])).unwrap();
        assert_eq!(c.time, 1_793_520_000);
        assert_eq!((c.open, c.high, c.low, c.close), (78000.1, 78100.0, 77900.5, 78050.0));
        assert_eq!(c.volume, 12.5);
        assert!(!c.confirmed);
        assert!(parse_row(&row(&["x", "1", "1", "1", "1"])).is_none());
    }

    #[test]
    fn decimals_from_tick_size() {
        assert_eq!(decimals_of("0.1"), 1);
        assert_eq!(decimals_of("0.0001"), 4);
        assert_eq!(decimals_of("1"), 0);
        assert_eq!(decimals_of("0.010"), 2);
    }

    #[test]
    fn websocket_address_override_stays_on_okx() {
        assert!(is_okx_ws("wss://wsaws.okx.com:8443/ws/v5/business"));
        assert!(is_okx_ws("wss://ws.okx.com:8443/ws/v5/business"));
        assert!(!is_okx_ws("ws://ws.okx.com:8443/ws/v5/business"));
        assert!(!is_okx_ws("wss://okx.com.evil.example/ws"));
        assert!(!is_okx_ws("wss://evilokx.com/ws"));
    }

    #[test]
    fn validates_inputs() {
        assert!(valid_bar("15m") && valid_bar("1Dutc") && !valid_bar("15M") && !valid_bar("1d"));
        assert!(valid_inst("BTC-USDT-SWAP") && valid_inst("1000PEPE-USDT-SWAP"));
        assert!(!valid_inst("btc-usdt") && !valid_inst("BTC USDT") && !valid_inst("BTC/../x") && !valid_inst(""));
        let p: Pair = serde_json::from_str(r#"{"instId":"BTC-USDT-SWAP","bar":"4H"}"#).unwrap();
        assert!(p.valid());
        assert_eq!(p.arg(), serde_json::json!({"channel": "candle4H", "instId": "BTC-USDT-SWAP"}));
        assert!(!Pair { inst_id: "BTC-USDT-SWAP".into(), bar: "4h".into() }.valid());
    }

    #[test]
    fn parses_websocket_frames() {
        let data = r#"{"arg":{"channel":"candle15m","instId":"ETH-USDT-SWAP"},"data":[["1793520000000","2270.1","2275","2269","2274.5","5000","50","113000","0"]]}"#;
        match parse_ws(data) {
            WsMsg::Candles(pair, cs) => {
                assert_eq!(pair, Some(Pair { inst_id: "ETH-USDT-SWAP".into(), bar: "15m".into() }));
                assert_eq!(cs.len(), 1);
                assert_eq!(cs[0].close, 2274.5);
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(parse_ws(r#"{"event":"subscribe","arg":{"channel":"candle15m","instId":"ETH-USDT-SWAP"},"connId":"a"}"#), WsMsg::Subscribed);
        assert_eq!(parse_ws(r#"{"event":"error","code":"60012","msg":"Invalid request"}"#), WsMsg::Error("60012 Invalid request".into()));
        assert_eq!(parse_ws("pong"), WsMsg::Other);
    }
}
