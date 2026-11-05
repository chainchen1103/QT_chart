//! Orders on OKX with the user's own API key.
//!
//! The key is entered once in the app and kept in a file in the app's data folder (not the store folder the
//! page can read), sealed with the user's unlock password (Argon2id, then XChaCha20-Poly1305) and, on Windows,
//! with the Windows user's own key (DPAPI) around that. A program running under the same Windows account can undo
//! DPAPI but not the password, and a copied file is useless without both. The password is asked at every start;
//! until then (and after 上鎖) nothing can be signed. Keys in memory, the password and the derived key are wiped
//! when dropped. A key saved before unlock passwords keeps working (DPAPI only) until one is set. The page can only
//! ask whether a key is set (and see the first and last characters of the key), unlock, lock, set the password,
//! use the key through the commands below, or remove it; the secret never goes back to it.
//!
//! What the commands can do is narrow on purpose: read the USDT equity and the account's position mode, open a
//! USDT perpetual position with a limit, post-only or market order that always carries its stop-loss (and the
//! take-profit when given), look an order up, cancel one, read the open positions, their stop-loss and
//! take-profit orders and the closed positions (sync.rs follows them), and move the trigger prices of a
//! stop-loss / take-profit (nothing else about it: not its size). No withdrawals, transfers or closing orders.
//! Every request is signed here (HMAC-SHA256 over time + method + path + body), with OKX's server time; the
//! private WebSocket's login is signed here too, so the secret never leaves this file.

use crate::okx;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// The key, wiped from memory when dropped (every copy).
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct Keys {
    key: String,
    secret: String,
    passphrase: String,
    /// A key of OKX's demo trading (requests carry "x-simulated-trading: 1").
    demo: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub set: bool,
    pub demo: bool,
    /// The key's first and last four characters.
    pub hint: String,
    /// Saved with an unlock password that wasn't entered yet (or 上鎖 since): nothing can be signed.
    pub locked: bool,
    /// Saved with an unlock password (false: a key from before passwords, protected by Windows only).
    pub protected: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub demo: bool,
    /// USDT equity and what is free for new margin.
    pub equity: f64,
    pub avail: f64,
    /// "long_short_mode" (開平倉) or "net_mode" (買賣).
    pub pos_mode: String,
    /// 1 spot only, 2 single-currency margin, 3 multi-currency margin, 4 portfolio margin.
    pub acct_lv: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderReq {
    pub inst_id: String,
    /// "buy" opens a long, "sell" a short.
    pub side: String,
    /// "limit", "post_only" or "market".
    pub ord_type: String,
    /// Required unless market.
    pub px: Option<String>,
    /// Contracts.
    pub sz: String,
    /// "isolated" or "cross".
    pub td_mode: String,
    pub lever: u32,
    /// Take-profit trigger price (filled at market when hit).
    pub tp: Option<String>,
    /// Stop-loss trigger price (filled at market when hit). Always required.
    pub sl: String,
    pub cl_ord_id: String,
    /// The id the stop-loss / take-profit gets (attachAlgoClOrdId): OKX gives it to their order once this one
    /// fills, so they can be found and moved later.
    #[serde(default)]
    pub algo_cl_ord_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Placed {
    pub ord_id: String,
    pub cl_ord_id: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OrderInfo {
    /// live, partially_filled, filled, canceled, mmp_canceled.
    pub state: String,
    pub px: String,
    pub sz: String,
    pub avg_px: String,
    pub acc_fill_sz: String,
    pub ord_type: String,
    pub side: String,
    pub c_time: String,
    /// When it last filled (ms), and when it last changed.
    pub fill_time: String,
    pub u_time: String,
}

/// Moving the stop-loss and / or take-profit of an order's TP/SL. `kind` "algo": the TP/SL order itself (its
/// order filled), found by algo_id or algo_cl_ord_id; "attached": the TP/SL still attached to order ord_id (not
/// filled yet), found by algo_cl_ord_id (attachAlgoClOrdId) or algo_id (attachAlgoId). An order still waiting
/// ("attached") can also get a new price and size, in the same request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmendReq {
    pub inst_id: String,
    pub kind: String,
    #[serde(default)]
    pub ord_id: Option<String>,
    #[serde(default)]
    pub algo_id: Option<String>,
    #[serde(default)]
    pub algo_cl_ord_id: Option<String>,
    /// New trigger prices (filled at market when hit); None leaves that one as it is.
    #[serde(default)]
    pub sl: Option<String>,
    #[serde(default)]
    pub tp: Option<String>,
    /// "attached" only: the waiting order's new limit price and size (contracts); None leaves it as it is.
    #[serde(default)]
    pub px: Option<String>,
    #[serde(default)]
    pub sz: Option<String>,
}

/// A closed position (OKX's position history).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClosedPos {
    pub inst_id: String,
    pub pos_id: String,
    /// "long" or "short".
    pub direction: String,
    /// Opened and last changed (closed), ms.
    pub c_time: i64,
    pub u_time: i64,
    pub open_avg_px: f64,
    pub close_avg_px: f64,
    /// Realized profit and loss (U), fees and funding included.
    pub realized_pnl: f64,
    /// OKX's close type: 1 partly closed, 2 closed, 3 liquidated, 4 partly liquidated, 5 ADL.
    pub kind: String,
}

const NO_KEY: &str = "還沒設定 OKX API";
const LOCKED: &str = "API 已鎖定，請先輸入解鎖密碼";
const MIN_PASSWORD: usize = 8;

/// What this computer holds of the user's key.
enum KeyState {
    /// The file wasn't read yet.
    Unread,
    None,
    /// Saved before unlock passwords: only Windows protects it.
    Unprotected(Keys),
    /// Saved with an unlock password, not entered yet (or locked again).
    Locked(vault::Sealed),
    /// Unlocked for this run (with what the file holds, for changing the password).
    Open(Keys, vault::Sealed),
}

pub struct Trader {
    file: PathBuf,
    state: Mutex<KeyState>,
    /// The cost of turning a password into a key, for new files (old files say their own).
    kdf: vault::Kdf,
    /// OKX time minus this computer's time (ms), and when it was measured.
    offset: Mutex<Option<(i64, Instant)>>,
    http: reqwest::Client,
}

/// Why a request failed: it may not have reached OKX (Net), or OKX answered with an error (Okx).
enum Fail {
    Net(String),
    Okx(String),
}
impl From<Fail> for String {
    fn from(f: Fail) -> String {
        match f {
            Fail::Net(e) => format!("連不上 OKX：{e}"),
            Fail::Okx(e) => e,
        }
    }
}

impl Trader {
    pub fn new(file: PathBuf) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("qtchart/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(10))
            .build()
            .expect("HTTP client");
        Self { file, state: Mutex::new(KeyState::Unread), kdf: vault::KDF, offset: Mutex::new(None), http }
    }

    /// The key state, read from the file the first time.
    fn with_state<R>(&self, f: impl FnOnce(&mut KeyState) -> R) -> R {
        let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if matches!(*g, KeyState::Unread) {
            *g = match vault::load(&self.file) {
                None => KeyState::None,
                Some(vault::Stored::Plain(k)) => KeyState::Unprotected(k),
                Some(vault::Stored::Sealed(s)) => KeyState::Locked(s),
            };
        }
        f(&mut g)
    }

    /// A usable key's demo flag (None: no key, or locked).
    pub(crate) fn keys_set(&self) -> Option<bool> {
        self.with_state(|s| match s {
            KeyState::Unprotected(k) | KeyState::Open(k, _) => Some(k.demo),
            _ => None,
        })
    }

    /// The key to sign with, or why there is none.
    fn keys(&self) -> Result<Keys, String> {
        self.with_state(|s| match s {
            KeyState::Unprotected(k) | KeyState::Open(k, _) => Ok(k.clone()),
            KeyState::Locked(_) => Err(LOCKED.to_string()),
            _ => Err(NO_KEY.to_string()),
        })
    }

    pub fn status(&self) -> KeyStatus {
        let st = |demo: bool, hint: String, locked: bool, protected: bool| KeyStatus { set: true, demo, hint, locked, protected };
        self.with_state(|s| match s {
            KeyState::Unprotected(k) => st(k.demo, hint(&k.key), false, false),
            KeyState::Locked(v) => st(v.demo, v.hint.clone(), true, true),
            KeyState::Open(k, _) => st(k.demo, hint(&k.key), false, true),
            _ => KeyStatus { set: false, demo: false, hint: String::new(), locked: false, protected: false },
        })
    }

    /// Try the key on the account first; it is saved only when OKX accepts it, sealed with `password`.
    pub async fn set_keys(&self, key: String, secret: String, passphrase: String, demo: bool, password: String) -> Result<Account, String> {
        let (key, secret, passphrase, password) = (Zeroizing::new(key), Zeroizing::new(secret), Zeroizing::new(passphrase), Zeroizing::new(password));
        check_password(&password)?;
        let k = Keys { key: key.trim().to_string(), secret: secret.trim().to_string(), passphrase: passphrase.to_string(), demo };
        for (name, v) in [("API Key", &k.key), ("Secret Key", &k.secret), ("Passphrase", &k.passphrase)] {
            if v.is_empty() || v.len() > 128 || !v.chars().all(|c| c.is_ascii_graphic() || c == ' ') {
                return Err(format!("{name} 格式不對"));
            }
        }
        let account = self.account_with(&k).await?;
        let sealed = self.seal(k.clone(), password).await?;
        vault::save(&self.file, &sealed)?;
        self.with_state(|s| *s = KeyState::Open(k, sealed));
        Ok(account)
    }

    /// Seal the key with a password on a thread of its own (Argon2id takes a moment on purpose).
    async fn seal(&self, k: Keys, password: Zeroizing<String>) -> Result<vault::Sealed, String> {
        let kdf = self.kdf;
        tauri::async_runtime::spawn_blocking(move || vault::seal(&k, &password, kdf)).await.map_err(|e| e.to_string())?
    }

    /// Unlock with the password (nothing to do when it is open already).
    pub async fn unlock(&self, password: String) -> Result<KeyStatus, String> {
        let password = Zeroizing::new(password);
        let sealed = self.with_state(|s| match s {
            KeyState::Locked(v) => Ok(Some(v.clone())),
            KeyState::Unprotected(_) | KeyState::Open(..) => Ok(None),
            _ => Err(NO_KEY.to_string()),
        })?;
        if let Some(v) = sealed {
            let opened = tauri::async_runtime::spawn_blocking(move || vault::unseal(&v, &password).map(|k| (k, v)))
                .await
                .map_err(|e| e.to_string())??;
            self.with_state(|s| {
                if matches!(s, KeyState::Locked(_)) {
                    *s = KeyState::Open(opened.0, opened.1);
                }
            });
        }
        Ok(self.status())
    }

    /// Forget the unlocked key until the password is entered again.
    pub fn lock(&self) -> Result<KeyStatus, String> {
        self.with_state(|s| match std::mem::replace(s, KeyState::Unread) {
            KeyState::Open(k, v) => {
                drop(k); // wiped
                *s = KeyState::Locked(v);
                Ok(())
            }
            other => {
                let unprotected = matches!(other, KeyState::Unprotected(_));
                *s = other;
                if unprotected { Err("這組 API 還沒有解鎖密碼，不能上鎖".to_string()) } else { Ok(()) }
            }
        })?;
        Ok(self.status())
    }

    /// Set the unlock password of a key saved without one, or change it (with the current one) while unlocked.
    pub async fn set_password(&self, current: Option<String>, password: String) -> Result<KeyStatus, String> {
        let (current, password) = (current.map(Zeroizing::new), Zeroizing::new(password));
        check_password(&password)?;
        let (k, old) = self.with_state(|s| match s {
            KeyState::Unprotected(k) => Ok((k.clone(), None)),
            KeyState::Open(k, v) => Ok((k.clone(), Some(v.clone()))),
            KeyState::Locked(_) => Err(LOCKED.to_string()),
            _ => Err(NO_KEY.to_string()),
        })?;
        if let Some(old) = old {
            let current = current.filter(|c| !c.is_empty()).ok_or("請輸入目前的解鎖密碼")?;
            tauri::async_runtime::spawn_blocking(move || vault::unseal(&old, &current).map(drop))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|_| "目前的解鎖密碼不對".to_string())?;
        }
        let sealed = self.seal(k.clone(), password).await?;
        vault::save(&self.file, &sealed)?;
        self.with_state(|s| {
            if matches!(s, KeyState::Unprotected(_) | KeyState::Open(..)) {
                *s = KeyState::Open(k, sealed);
            }
        });
        Ok(self.status())
    }

    pub fn clear(&self) -> Result<(), String> {
        self.with_state(|s| *s = KeyState::None);
        vault::remove(&self.file)
    }

    pub async fn account(&self) -> Result<Account, String> {
        let k = self.keys()?;
        self.account_with(&k).await
    }

    async fn account_with(&self, k: &Keys) -> Result<Account, String> {
        let cfg = self.call(k, "GET", "/api/v5/account/config", "", None).await?;
        let bal = self.call(k, "GET", "/api/v5/account/balance", "ccy=USDT", None).await?;
        let c = cfg.first().ok_or("OKX 沒有回帳戶設定")?;
        let usdt = bal
            .first()
            .and_then(|b| b["details"].as_array())
            .and_then(|ds| ds.iter().find(|d| d["ccy"] == "USDT"))
            .cloned()
            .unwrap_or(Value::Null);
        let num = |f: &str| usdt[f].as_str().and_then(|s| s.parse::<f64>().ok());
        Ok(Account {
            demo: k.demo,
            equity: num("eq").unwrap_or(0.0),
            avail: num("availEq").or_else(|| num("availBal")).unwrap_or(0.0),
            pos_mode: c["posMode"].as_str().unwrap_or("").to_string(),
            acct_lv: c["acctLv"].as_str().unwrap_or("").to_string(),
        })
    }

    /// Set the leverage, then place the order with its stop-loss (and take-profit) attached.
    pub async fn place(&self, r: OrderReq) -> Result<Placed, String> {
        r.check()?;
        let k = self.keys()?;
        let cfg = self.call(&k, "GET", "/api/v5/account/config", "", None).await?;
        let c = cfg.first().ok_or("OKX 沒有回帳戶設定")?;
        if c["acctLv"].as_str() == Some("1") {
            return Err("帳戶是現貨模式，不能開永續合約，請在 OKX 改成合約模式".into());
        }
        let hedge = c["posMode"].as_str() == Some("long_short_mode");
        let pos_side = hedge.then(|| if r.side == "buy" { "long" } else { "short" });
        let mut lev = json!({"instId": r.inst_id, "lever": r.lever.to_string(), "mgnMode": r.td_mode});
        if let (Some(ps), "isolated") = (pos_side, r.td_mode.as_str()) {
            lev["posSide"] = json!(ps);
        }
        self.call(&k, "POST", "/api/v5/account/set-leverage", "", Some(&lev))
            .await
            .map_err(|e| format!("設定槓桿失敗，沒有下單：{}", String::from(e)))?;
        match self.call(&k, "POST", "/api/v5/trade/order", "", Some(&r.body(pos_side))).await {
            Ok(data) => {
                let d = data.first().ok_or("OKX 沒有回訂單編號")?;
                Ok(Placed { ord_id: d["ordId"].as_str().unwrap_or("").to_string(), cl_ord_id: r.cl_ord_id.clone() })
            }
            Err(Fail::Net(e)) => {
                // the answer got lost: the order may still be there, so look for it by its own id before saying no
                let q = format!("instId={}&clOrdId={}", r.inst_id, r.cl_ord_id);
                match self.call(&k, "GET", "/api/v5/trade/order", &q, None).await {
                    Ok(data) if data.first().and_then(|d| d["ordId"].as_str()).is_some() => Ok(Placed {
                        ord_id: data[0]["ordId"].as_str().unwrap_or("").to_string(),
                        cl_ord_id: r.cl_ord_id.clone(),
                    }),
                    _ => Err(format!("下單時連線中斷（{e}），交易所查不到這筆單，請到 OKX 確認後再試")),
                }
            }
            Err(f) => Err(f.into()),
        }
    }

    /// The private WebSocket's login message (signed with OKX's time), and whether the key is a demo one.
    pub(crate) async fn ws_login(&self) -> Result<(Value, bool), String> {
        let k = self.keys()?;
        let ts = (self.now_ms().await / 1000).to_string();
        let sig = sign(&k.secret, &format!("{ts}GET/users/self/verify"));
        Ok((json!({"op": "login", "args": [{"apiKey": k.key, "passphrase": k.passphrase, "timestamp": ts, "sign": sig}]}), k.demo))
    }

    /// Open USDT perpetual positions (OKX's records, as they come).
    pub(crate) async fn positions(&self) -> Result<Vec<Value>, String> {
        let k = self.keys()?;
        Ok(self.call(&k, "GET", "/api/v5/account/positions", "instType=SWAP", None).await?)
    }

    /// Stop-loss and take-profit orders waiting (conditional and OCO), as they come.
    pub(crate) async fn algos(&self) -> Result<Vec<Value>, String> {
        let k = self.keys()?;
        let mut out = Vec::new();
        for t in ["conditional", "oco"] {
            out.extend(self.call(&k, "GET", "/api/v5/trade/orders-algo-pending", &format!("instType=SWAP&ordType={t}"), None).await?);
        }
        Ok(out)
    }

    /// Closed positions of one symbol, newest first.
    pub async fn closed_positions(&self, inst_id: &str) -> Result<Vec<ClosedPos>, String> {
        if !okx::valid_inst(inst_id) {
            return Err("商品不對".into());
        }
        let k = self.keys()?;
        let data = self.call(&k, "GET", "/api/v5/account/positions-history", &format!("instType=SWAP&instId={inst_id}&limit=50"), None).await?;
        Ok(data.iter().filter_map(closed_pos).collect())
    }

    /// Move the trigger prices of a stop-loss / take-profit (see AmendReq).
    pub async fn amend_stops(&self, r: AmendReq) -> Result<(), String> {
        let (path, body) = r.request()?;
        let k = self.keys()?;
        self.call(&k, "POST", path, "", Some(&body)).await?;
        Ok(())
    }

    pub async fn order(&self, inst_id: &str, ord_id: &str) -> Result<OrderInfo, String> {
        check_ids(inst_id, ord_id)?;
        let k = self.keys()?;
        let data = self.call(&k, "GET", "/api/v5/trade/order", &format!("instId={inst_id}&ordId={ord_id}"), None).await?;
        let d = data.into_iter().next().ok_or("查不到這筆單")?;
        serde_json::from_value(d).map_err(|e| format!("訂單資料格式不對：{e}"))
    }

    pub async fn cancel(&self, inst_id: &str, ord_id: &str) -> Result<(), String> {
        check_ids(inst_id, ord_id)?;
        let k = self.keys()?;
        self.call(&k, "POST", "/api/v5/trade/cancel-order", "", Some(&json!({"instId": inst_id, "ordId": ord_id}))).await?;
        Ok(())
    }

    /// One signed request. `query` is already in its final form (values are checked to need no escaping).
    async fn call(&self, k: &Keys, method: &str, path: &str, query: &str, body: Option<&Value>) -> Result<Vec<Value>, Fail> {
        let request_path = if query.is_empty() { path.to_string() } else { format!("{path}?{query}") };
        let body_text = body.map(|b| b.to_string()).unwrap_or_default();
        let ts = iso_ms(self.now_ms().await);
        let sig = sign(&k.secret, &format!("{ts}{method}{request_path}{body_text}"));
        let url = format!("{}{request_path}", okx::trade_base());
        let mut rb = if method == "GET" {
            self.http.get(url)
        } else {
            self.http.post(url).header("Content-Type", "application/json").body(body_text)
        };
        rb = rb
            .header("OK-ACCESS-KEY", &k.key)
            .header("OK-ACCESS-SIGN", sig)
            .header("OK-ACCESS-TIMESTAMP", ts)
            .header("OK-ACCESS-PASSPHRASE", &k.passphrase);
        if k.demo {
            rb = rb.header("x-simulated-trading", "1");
        }
        let resp = rb.send().await.map_err(|e| Fail::Net(e.to_string()))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| Fail::Net(e.to_string()))?;
        let v: Value = serde_json::from_str(&text)
            .map_err(|_| Fail::Okx(format!("OKX 回應 HTTP {status}：{}", text.chars().take(160).collect::<String>())))?;
        let data = v["data"].as_array().cloned().unwrap_or_default();
        let code = v["code"].as_str().unwrap_or("");
        if code == "0" {
            return Ok(data);
        }
        // requests for one item answer per item: sCode and sMsg say what went wrong
        let first = data.first();
        let s_code = first.and_then(|d| d["sCode"].as_str()).filter(|s| !s.is_empty() && *s != "0");
        let s_msg = first.and_then(|d| d["sMsg"].as_str()).filter(|s| !s.is_empty());
        Err(Fail::Okx(explain(s_code.unwrap_or(code), s_msg.unwrap_or(v["msg"].as_str().unwrap_or("")))))
    }

    /// Now in OKX's time (requests more than 30 s off are refused), measured again every half hour.
    pub(crate) async fn now_ms(&self) -> i64 {
        let local = || SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        if let Some((off, at)) = *self.offset.lock().unwrap_or_else(|e| e.into_inner()) {
            if at.elapsed() < Duration::from_secs(1800) {
                return local() + off;
            }
        }
        let t0 = local();
        let server = async {
            let text = self.http.get(format!("{}/api/v5/public/time", okx::trade_base())).send().await.ok()?.text().await.ok()?;
            let v: Value = serde_json::from_str(&text).ok()?;
            v["data"][0]["ts"].as_str()?.parse::<i64>().ok()
        }
        .await;
        let off = server.map(|ts| ts - (t0 + local()) / 2).unwrap_or(0);
        *self.offset.lock().unwrap_or_else(|e| e.into_inner()) = Some((off, Instant::now()));
        local() + off
    }
}

impl OrderReq {
    fn check(&self) -> Result<(), String> {
        if !okx::valid_inst(&self.inst_id) || !self.inst_id.ends_with("-USDT-SWAP") {
            return Err(format!("只能下 USDT 永續合約：{}", self.inst_id));
        }
        if !matches!(self.side.as_str(), "buy" | "sell")
            || !matches!(self.ord_type.as_str(), "limit" | "post_only" | "market")
            || !matches!(self.td_mode.as_str(), "isolated" | "cross")
        {
            return Err("訂單的方向、類型或保證金模式不對".into());
        }
        if !(1..=125).contains(&self.lever) {
            return Err("槓桿要在 1～125 倍".into());
        }
        if !decimal(&self.sz) {
            return Err("數量不對".into());
        }
        if !decimal(&self.sl) {
            return Err("一定要有止損".into());
        }
        if self.tp.as_deref().is_some_and(|t| !decimal(t)) {
            return Err("止盈價不對".into());
        }
        if !client_id(&self.cl_ord_id) || self.algo_cl_ord_id.as_deref().is_some_and(|a| !client_id(a)) {
            return Err("訂單編號不對".into());
        }
        if self.ord_type == "market" {
            return Ok(()); // the exchange checks the stop and take-profit against the fill
        }
        let px = self.px.as_deref().filter(|p| decimal(p)).ok_or("掛單要有價格")?;
        let (px, sl): (f64, f64) = (px.parse().unwrap_or(0.0), self.sl.parse().unwrap_or(0.0));
        let tp: Option<f64> = self.tp.as_deref().and_then(|t| t.parse().ok());
        let long = self.side == "buy";
        if (long && sl >= px) || (!long && sl <= px) {
            return Err("止損要在進場價的另一邊（多單在下、空單在上）".into());
        }
        if tp.is_some_and(|t| (long && t <= px) || (!long && t >= px)) {
            return Err("止盈要在進場價的獲利那一邊".into());
        }
        Ok(())
    }

    fn body(&self, pos_side: Option<&str>) -> Value {
        let mut algo = json!({"slTriggerPx": self.sl, "slOrdPx": "-1", "slTriggerPxType": "last"});
        if let Some(a) = &self.algo_cl_ord_id {
            algo["attachAlgoClOrdId"] = json!(a);
        }
        if let Some(tp) = &self.tp {
            algo["tpTriggerPx"] = json!(tp);
            algo["tpOrdPx"] = json!("-1");
            algo["tpTriggerPxType"] = json!("last");
        }
        let mut b = json!({
            "instId": self.inst_id,
            "tdMode": self.td_mode,
            "side": self.side,
            "ordType": self.ord_type,
            "sz": self.sz,
            "clOrdId": self.cl_ord_id,
            "attachAlgoOrds": [algo],
        });
        if self.ord_type != "market" {
            if let Some(px) = &self.px {
                b["px"] = json!(px);
            }
        }
        if let Some(ps) = pos_side {
            b["posSide"] = json!(ps);
        }
        b
    }
}

impl AmendReq {
    /// Where it goes and what it says; trigger prices change (taken at market when hit, as placed), and a
    /// waiting order's price and size.
    fn request(&self) -> Result<(&'static str, Value), String> {
        if !okx::valid_inst(&self.inst_id) || !self.inst_id.ends_with("-USDT-SWAP") {
            return Err(format!("只能改 USDT 永續合約的止損止盈：{}", self.inst_id));
        }
        if self.sl.is_none() && self.tp.is_none() && self.px.is_none() && self.sz.is_none() {
            return Err("沒有要改的價格".into());
        }
        if self.sl.as_deref().is_some_and(|v| !decimal(v)) || self.tp.as_deref().is_some_and(|v| !decimal(v)) {
            return Err("止損或止盈價不對".into());
        }
        if self.px.as_deref().is_some_and(|v| !decimal(v)) || self.sz.as_deref().is_some_and(|v| !decimal(v)) {
            return Err("掛單價或張數不對".into());
        }
        if (self.px.is_some() || self.sz.is_some()) && self.kind != "attached" {
            return Err("只有還沒成交的掛單能改價格和張數".into());
        }
        let algo_id = self.algo_id.as_deref().filter(|a| !a.is_empty());
        let cl = self.algo_cl_ord_id.as_deref().filter(|a| !a.is_empty());
        if algo_id.is_some_and(|a| a.len() > 32 || !a.chars().all(|c| c.is_ascii_digit())) || cl.is_some_and(|a| !client_id(a)) {
            return Err("止損止盈單的編號不對".into());
        }
        let mut prices = serde_json::Map::new();
        if let Some(sl) = &self.sl {
            prices.insert("newSlTriggerPx".into(), json!(sl));
            prices.insert("newSlOrdPx".into(), json!("-1"));
        }
        if let Some(tp) = &self.tp {
            prices.insert("newTpTriggerPx".into(), json!(tp));
            prices.insert("newTpOrdPx".into(), json!("-1"));
        }
        match self.kind.as_str() {
            "algo" => {
                let mut b = json!({"instId": self.inst_id});
                match (algo_id, cl) {
                    (Some(a), _) => b["algoId"] = json!(a),
                    (None, Some(c)) => b["algoClOrdId"] = json!(c),
                    _ => return Err("要指定止損止盈單".into()),
                }
                for (k, v) in prices {
                    b[k] = v;
                }
                Ok(("/api/v5/trade/amend-algos", b))
            }
            "attached" => {
                let ord_id = self.ord_id.as_deref().filter(|o| !o.is_empty() && o.len() <= 32 && o.chars().all(|c| c.is_ascii_digit()));
                let ord_id = ord_id.ok_or("要指定訂單")?;
                let mut b = json!({"instId": self.inst_id, "ordId": ord_id});
                if let Some(px) = &self.px {
                    b["newPx"] = json!(px);
                }
                if let Some(sz) = &self.sz {
                    b["newSz"] = json!(sz);
                }
                if !prices.is_empty() {
                    let mut algo = Value::Object(prices);
                    match (cl, algo_id) {
                        (Some(c), _) => algo["attachAlgoClOrdId"] = json!(c),
                        (None, Some(a)) => algo["attachAlgoId"] = json!(a),
                        _ => return Err("要指定附帶的止損止盈".into()),
                    }
                    b["attachAlgoOrds"] = json!([algo]);
                }
                Ok(("/api/v5/trade/amend-order", b))
            }
            _ => Err("不知道要改哪一種止損止盈".into()),
        }
    }
}

/// One record of OKX's position history.
fn closed_pos(d: &Value) -> Option<ClosedPos> {
    let s = |f: &str| d[f].as_str().unwrap_or("").to_string();
    let n = |f: &str| d[f].as_str().and_then(|v| v.parse::<f64>().ok());
    let t = |f: &str| d[f].as_str().and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    let direction = match (s("direction").as_str(), s("posSide").as_str()) {
        ("long", _) | (_, "long") => "long",
        ("short", _) | (_, "short") => "short",
        _ => return None,
    };
    Some(ClosedPos {
        inst_id: s("instId"),
        pos_id: s("posId"),
        direction: direction.into(),
        c_time: t("cTime"),
        u_time: t("uTime"),
        open_avg_px: n("openAvgPx").unwrap_or(0.0),
        close_avg_px: n("closeAvgPx").unwrap_or(0.0),
        realized_pnl: n("realizedPnl").or_else(|| n("pnl")).unwrap_or(0.0),
        kind: s("type"),
    })
}

/// A client-made id: letters and digits, up to 32.
fn client_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 32 && s.chars().all(|c| c.is_ascii_alphanumeric())
}

/// A plain positive decimal such as "0.42" or "78110.2".
fn decimal(s: &str) -> bool {
    let mut parts = s.split('.');
    let int = parts.next().unwrap_or("");
    let frac = parts.next();
    s.len() <= 32
        && parts.next().is_none()
        && !int.is_empty()
        && int.chars().all(|c| c.is_ascii_digit())
        && frac.is_none_or(|f| !f.is_empty() && f.chars().all(|c| c.is_ascii_digit()))
        && s.parse::<f64>().is_ok_and(|v| v > 0.0)
}

fn check_ids(inst_id: &str, ord_id: &str) -> Result<(), String> {
    if okx::valid_inst(inst_id) && !ord_id.is_empty() && ord_id.len() <= 32 && ord_id.chars().all(|c| c.is_ascii_digit()) {
        Ok(())
    } else {
        Err("商品或訂單編號不對".into())
    }
}

/// An unlock password: at least MIN_PASSWORD characters, any kind.
fn check_password(p: &str) -> Result<(), String> {
    let n = p.chars().count();
    if n < MIN_PASSWORD {
        return Err(format!("解鎖密碼至少要 {MIN_PASSWORD} 個字"));
    }
    if n > 128 {
        return Err("解鎖密碼太長".into());
    }
    Ok(())
}

fn hint(key: &str) -> String {
    let c: Vec<char> = key.chars().collect();
    if c.len() <= 10 {
        return "•".repeat(c.len());
    }
    format!("{}…{}", c[..4].iter().collect::<String>(), c[c.len() - 4..].iter().collect::<String>())
}

fn sign(secret: &str, prehash: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(prehash.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

/// OKX's time stamp format: 2020-12-08T09:08:57.715Z (UTC).
fn iso_ms(ms: i64) -> String {
    let (secs, milli) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, sod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // days since 1970-01-01 → civil date (H. Hinnant's algorithm)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{milli:03}Z", sod / 3600, sod % 3600 / 60, sod % 60)
}

/// OKX's answer, with what to do about the usual problems.
fn explain(code: &str, msg: &str) -> String {
    let what = match code {
        "50101" => "API 和環境不符：實盤、模擬盤要分開",
        "50102" => "電腦時間和 OKX 差太多，請校正電腦時間",
        "50103" | "50104" | "50105" | "50111" | "50113" | "50119" => "API Key、Secret Key 或 Passphrase 不對",
        "50110" => "這台電腦的 IP 不在這組 API 的白名單裡",
        "50120" | "50121" => "這組 API 沒有交易權限",
        "51008" => "保證金不夠",
        "51000" => "訂單的參數不對",
        _ => "",
    };
    let raw = if msg.is_empty() { format!("OKX {code}") } else { format!("OKX {code}：{msg}") };
    if what.is_empty() {
        raw
    } else {
        format!("{what}（{raw}）")
    }
}

/// The key file. Inside: the key sealed with the unlock password (Argon2id makes a 256-bit key of it, then
/// XChaCha20-Poly1305), with the key's hint and demo flag beside it, bound to it, for the page while locked; or,
/// from before passwords, the key as it is. Around that, DPAPI on Windows; elsewhere (development builds) the file
/// is readable by this user only.
mod vault {
    use super::Keys;
    use argon2::{Algorithm, Argon2, Params, Version};
    use base64::Engine as _;
    use chacha20poly1305::aead::rand_core::RngCore;
    use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
    use chacha20poly1305::XChaCha20Poly1305;
    use serde::{Deserialize, Serialize};
    use std::path::Path;
    use zeroize::Zeroizing;

    /// Argon2id's cost: memory (KiB), passes, lanes.
    #[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
    pub struct Kdf {
        pub m: u32,
        pub t: u32,
        pub p: u32,
    }
    /// 64 MiB, 3 passes: about half a second on a laptop, and as much for every guess of an attacker.
    pub const KDF: Kdf = Kdf { m: 64 * 1024, t: 3, p: 1 };

    /// The file's content with an unlock password.
    #[derive(Clone, Serialize, Deserialize)]
    pub struct Sealed {
        /// Format: 2.
        pub v: u32,
        pub demo: bool,
        pub hint: String,
        pub kdf: Kdf,
        salt: String,
        nonce: String,
        ct: String,
    }

    pub enum Stored {
        Plain(Keys),
        Sealed(Sealed),
    }

    const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

    /// What the sealed key is bound to besides the password: the format, demo flag and hint (changing them in the
    /// file makes it fail to open).
    fn aad(demo: bool, hint: &str) -> Vec<u8> {
        format!("qtchart okx api v2|{demo}|{hint}").into_bytes()
    }

    fn derive(password: &str, salt: &[u8], kdf: Kdf) -> Result<Zeroizing<[u8; 32]>, String> {
        // a file asking for absurd costs is not one this program wrote
        if kdf.m > 1 << 20 || kdf.t > 20 || kdf.p > 16 {
            return Err("金鑰檔損壞".into());
        }
        let params = Params::new(kdf.m, kdf.t, kdf.p, Some(32)).map_err(|_| "金鑰檔損壞".to_string())?;
        let mut out = Zeroizing::new([0u8; 32]);
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(password.as_bytes(), salt, out.as_mut())
            .map_err(|e| format!("解鎖密碼處理失敗：{e}"))?;
        Ok(out)
    }

    /// Seal the key with a password (a new random salt and nonce each time).
    pub fn seal(k: &Keys, password: &str, kdf: Kdf) -> Result<Sealed, String> {
        let mut salt = [0u8; 16];
        OsRng.fill_bytes(&mut salt);
        let key = derive(password, &salt, kdf)?;
        let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
        let plain = Zeroizing::new(serde_json::to_vec(k).map_err(|e| e.to_string())?);
        let hint = super::hint(&k.key);
        let ct = XChaCha20Poly1305::new(key.as_ref().into())
            .encrypt(&nonce, Payload { msg: &plain, aad: &aad(k.demo, &hint) })
            .map_err(|_| "加密失敗，沒有存 API".to_string())?;
        Ok(Sealed { v: 2, demo: k.demo, hint, kdf, salt: B64.encode(salt), nonce: B64.encode(nonce), ct: B64.encode(ct) })
    }

    /// The key, with the right password; "密碼不對" otherwise.
    pub fn unseal(s: &Sealed, password: &str) -> Result<Keys, String> {
        let bad = || "金鑰檔損壞".to_string();
        let salt = B64.decode(&s.salt).map_err(|_| bad())?;
        let nonce = B64.decode(&s.nonce).map_err(|_| bad())?;
        let ct = B64.decode(&s.ct).map_err(|_| bad())?;
        if nonce.len() != 24 || salt.len() < 8 {
            return Err(bad());
        }
        let key = derive(password, &salt, s.kdf)?;
        let plain = Zeroizing::new(
            XChaCha20Poly1305::new(key.as_ref().into())
                .decrypt(nonce.as_slice().into(), Payload { msg: &ct, aad: &aad(s.demo, &s.hint) })
                .map_err(|_| "解鎖密碼不對".to_string())?,
        );
        serde_json::from_slice(&plain).map_err(|_| bad())
    }

    /// What the file holds (None: no file, or it can't be read).
    pub fn load(file: &Path) -> Option<Stored> {
        let data = Zeroizing::new(unprotect(&std::fs::read(file).ok()?)?);
        if let Ok(s) = serde_json::from_slice::<Sealed>(&data) {
            return (s.v == 2).then_some(Stored::Sealed(s));
        }
        serde_json::from_slice::<Keys>(&data).ok().map(Stored::Plain)
    }

    pub fn save(file: &Path, s: &Sealed) -> Result<(), String> {
        let sealed = protect(&serde_json::to_vec(s).map_err(|e| e.to_string())?)?;
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("存不了 API：{e}"))?;
        }
        let tmp = file.with_extension("tmp");
        std::fs::write(&tmp, sealed).map_err(|e| format!("存不了 API：{e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, file).map_err(|e| format!("存不了 API：{e}"))
    }

    /// The file, and what a save cut short left next to it.
    pub fn remove(file: &Path) -> Result<(), String> {
        let _ = std::fs::remove_file(file.with_extension("tmp"));
        match std::fs::remove_file(file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("刪不掉 API：{e}")),
            _ => Ok(()),
        }
    }

    #[cfg(windows)]
    const ENTROPY: &[u8] = b"qtchart okx api";

    #[cfg(windows)]
    fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let entropy = CRYPT_INTEGER_BLOB { cbData: ENTROPY.len() as u32, pbData: ENTROPY.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: the input blobs point at live slices; the output is freed with LocalFree below
        let ok = unsafe { CryptProtectData(&input, std::ptr::null(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
        if ok == 0 {
            return Err("Windows 加密失敗，沒有存 API".into());
        }
        Ok(take(out))
    }

    #[cfg(windows)]
    fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let entropy = CRYPT_INTEGER_BLOB { cbData: ENTROPY.len() as u32, pbData: ENTROPY.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: as in protect
        let ok = unsafe {
            CryptUnprotectData(&input, std::ptr::null_mut(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        (ok != 0).then(|| take(out))
    }

    /// Copy a blob DPAPI allocated, wipe it, then free it.
    #[cfg(windows)]
    fn take(b: windows_sys::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: DPAPI returned cbData bytes at pbData, allocated with LocalAlloc
        unsafe {
            let bytes = std::slice::from_raw_parts_mut(b.pbData, b.cbData as usize);
            let v = bytes.to_vec();
            zeroize::Zeroize::zeroize(bytes);
            windows_sys::Win32::Foundation::LocalFree(b.pbData as _);
            v
        }
    }

    #[cfg(not(windows))]
    fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        Ok(data.to_vec())
    }
    #[cfg(not(windows))]
    fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        Some(data.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_and_time_stamp() {
        // HMAC-SHA256, base64: the same as Python's hmac/base64 for these inputs
        assert_eq!(sign("secret", "2026-11-03T01:02:03.004ZGET/api/v5/account/balance?ccy=USDT"), "8t5NlCfIJr+FoPGQk060GZeFBo4IZR98l9Pin85xb60=");
        assert_eq!(iso_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_ms(1_793_667_723_004), "2026-11-03T01:02:03.004Z");
        assert_eq!(iso_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(hint("abcd1234efgh5678"), "abcd…5678");
    }

    fn req() -> OrderReq {
        OrderReq {
            inst_id: "BTC-USDT-SWAP".into(),
            side: "buy".into(),
            ord_type: "limit".into(),
            px: Some("78000.5".into()),
            sz: "0.42".into(),
            td_mode: "isolated".into(),
            lever: 10,
            tp: Some("79000".into()),
            sl: "77500".into(),
            cl_ord_id: "qtc1abc".into(),
            algo_cl_ord_id: Some("qtc1abcs".into()),
        }
    }

    #[test]
    fn orders_are_checked() {
        assert!(req().check().is_ok());
        let bad = |f: &dyn Fn(&mut OrderReq)| {
            let mut r = req();
            f(&mut r);
            r.check().is_err()
        };
        assert!(bad(&|r| r.inst_id = "BTC-USDT".into())); // spot
        assert!(bad(&|r| r.side = "close".into()));
        assert!(bad(&|r| r.ord_type = "trigger".into()));
        assert!(bad(&|r| r.td_mode = "cash".into()));
        assert!(bad(&|r| r.lever = 0));
        assert!(bad(&|r| r.lever = 126));
        assert!(bad(&|r| r.sz = "-1".into()));
        assert!(bad(&|r| r.sz = "1e3".into()));
        assert!(bad(&|r| r.sz = "0".into()));
        assert!(bad(&|r| r.sl = "".into())); // the stop is required
        assert!(bad(&|r| r.sl = "78500".into())); // above a long's entry
        assert!(bad(&|r| r.tp = Some("77000".into()))); // below a long's entry
        assert!(bad(&|r| r.px = None)); // a limit order needs its price
        assert!(bad(&|r| r.cl_ord_id = "has space".into()));
        let mut short = req();
        (short.side, short.sl, short.tp) = ("sell".into(), "78500".into(), Some("77000".into()));
        assert!(short.check().is_ok());
        let mut market = req();
        (market.ord_type, market.px) = ("market".into(), None);
        assert!(market.check().is_ok());
    }

    #[test]
    fn order_body() {
        let b = req().body(Some("long"));
        assert_eq!(b["posSide"], "long");
        assert_eq!(b["px"], "78000.5");
        assert_eq!(b["attachAlgoOrds"][0]["slTriggerPx"], "77500");
        assert_eq!(b["attachAlgoOrds"][0]["slOrdPx"], "-1");
        assert_eq!(b["attachAlgoOrds"][0]["tpTriggerPx"], "79000");
        assert_eq!(b["attachAlgoOrds"][0]["attachAlgoClOrdId"], "qtc1abcs");
        let mut bad = req();
        bad.algo_cl_ord_id = Some("qtc-1".into());
        assert!(bad.check().is_err());
        let mut m = req();
        (m.ord_type, m.tp) = ("market".into(), None);
        let b = m.body(None);
        assert!(b.get("px").is_none() && b.get("posSide").is_none());
        assert!(b["attachAlgoOrds"][0].get("tpTriggerPx").is_none());
        assert_eq!(explain("50110", "Invalid IP"), "這台電腦的 IP 不在這組 API 的白名單裡（OKX 50110：Invalid IP）");
    }

    #[test]
    fn stop_moves() {
        let amend = |kind: &str, ord: Option<&str>, id: Option<&str>, cl: Option<&str>, sl: Option<&str>, tp: Option<&str>| AmendReq {
            inst_id: "BTC-USDT-SWAP".into(),
            kind: kind.into(),
            ord_id: ord.map(Into::into),
            algo_id: id.map(Into::into),
            algo_cl_ord_id: cl.map(Into::into),
            sl: sl.map(Into::into),
            tp: tp.map(Into::into),
            px: None,
            sz: None,
        };
        // a TP/SL order of its own (its order filled), by the id we gave it
        let (path, b) = amend("algo", None, None, Some("qtc1abcs"), Some("77800.5"), Some("80000")).request().unwrap();
        assert_eq!(path, "/api/v5/trade/amend-algos");
        assert_eq!(b, json!({"instId": "BTC-USDT-SWAP", "algoClOrdId": "qtc1abcs", "newSlTriggerPx": "77800.5", "newSlOrdPx": "-1", "newTpTriggerPx": "80000", "newTpOrdPx": "-1"}));
        // by OKX's id, only the stop
        let (_, b) = amend("algo", None, Some("1234567"), None, Some("77800"), None).request().unwrap();
        assert_eq!(b["algoId"], "1234567");
        assert!(b.get("newTpTriggerPx").is_none() && b.get("algoClOrdId").is_none());
        // still attached to an order that hasn't filled
        let (path, b) = amend("attached", Some("700000000000000001"), None, Some("qtc1abcs"), Some("77800"), None).request().unwrap();
        assert_eq!(path, "/api/v5/trade/amend-order");
        assert_eq!(b, json!({"instId": "BTC-USDT-SWAP", "ordId": "700000000000000001", "attachAlgoOrds": [{"attachAlgoClOrdId": "qtc1abcs", "newSlTriggerPx": "77800", "newSlOrdPx": "-1"}]}));
        // a waiting order moved on the chart: its price, size and stops in one request
        let mut moved = amend("attached", Some("700000000000000001"), None, Some("qtc1abcs"), Some("77700"), Some("80100"));
        (moved.px, moved.sz) = (Some("78100.5".into()), Some("12".into()));
        let (path, b) = moved.request().unwrap();
        assert_eq!(path, "/api/v5/trade/amend-order");
        assert_eq!(b["newPx"], "78100.5");
        assert_eq!(b["newSz"], "12");
        assert_eq!(b["attachAlgoOrds"][0]["newTpTriggerPx"], "80100");
        // only the price: no attached part
        let mut px_only = amend("attached", Some("700000000000000001"), None, Some("qtc1abcs"), None, None);
        px_only.px = Some("78000".into());
        let (_, b) = px_only.request().unwrap();
        assert_eq!(b, json!({"instId": "BTC-USDT-SWAP", "ordId": "700000000000000001", "newPx": "78000"}));
        // not for a TP/SL order of its own, nor a bad size
        let mut algo_px = amend("algo", None, Some("1"), None, Some("5"), None);
        algo_px.px = Some("6".into());
        assert!(algo_px.request().is_err());
        let mut bad_sz = amend("attached", Some("1"), None, Some("qtc1"), None, None);
        bad_sz.sz = Some("1e3".into());
        assert!(bad_sz.request().is_err());
        // refused: nothing to change, a bad price, no id, another market, an id with odd characters
        assert!(amend("algo", None, Some("1"), None, None, None).request().is_err());
        assert!(amend("algo", None, Some("1"), None, Some("-5"), None).request().is_err());
        assert!(amend("algo", None, None, None, Some("5"), None).request().is_err());
        assert!(amend("attached", None, None, Some("qtc1"), Some("5"), None).request().is_err());
        assert!(amend("algo", None, None, Some("a b"), Some("5"), None).request().is_err());
        let mut spot = amend("algo", None, Some("1"), None, Some("5"), None);
        spot.inst_id = "BTC-USDT".into();
        assert!(spot.request().is_err());
        // position history records
        let h = json!({"instId": "ETH-USDT-SWAP", "posId": "42", "direction": "long", "posSide": "net", "cTime": "1793426400000",
            "uTime": "1793430000000", "openAvgPx": "2243.97", "closeAvgPx": "2260.5", "realizedPnl": "3.2", "type": "2"});
        let c = closed_pos(&h).unwrap();
        assert_eq!((c.direction.as_str(), c.c_time, c.close_avg_px, c.realized_pnl, c.kind.as_str()), ("long", 1_793_426_400_000, 2260.5, 3.2, "2"));
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    /// Cheap Argon2 for tests (the real one takes half a second on purpose).
    const QUICK: vault::Kdf = vault::Kdf { m: 256, t: 1, p: 1 };

    fn test_keys() -> Keys {
        Keys { key: "abcd1234efgh5678".into(), secret: "s3cr3t".into(), passphrase: "p p".into(), demo: true }
    }
    fn fields(k: &Keys) -> (String, String, String, bool) {
        (k.key.clone(), k.secret.clone(), k.passphrase.clone(), k.demo)
    }

    #[test]
    fn sealed_with_the_password() {
        let k = test_keys();
        let s = vault::seal(&k, "correct horse", QUICK).unwrap();
        assert_eq!((s.v, s.demo, s.hint.as_str()), (2, true, "abcd…5678"));
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("s3cr3t") && !json.contains("abcd1234efgh5678")); // only the hint shows
        assert_eq!(fields(&vault::unseal(&s, "correct horse").unwrap()), fields(&k));
        assert_eq!(vault::unseal(&s, "correct hors").err().unwrap(), "解鎖密碼不對");
        // the demo flag and hint beside it are bound to it
        let flipped: vault::Sealed = serde_json::from_str(&json.replace("\"demo\":true", "\"demo\":false")).unwrap();
        assert!(vault::unseal(&flipped, "correct horse").is_err());
        let rehinted: vault::Sealed = serde_json::from_str(&json.replace("abcd…5678", "zzzz…5678")).unwrap();
        assert!(vault::unseal(&rehinted, "correct horse").is_err());
        // a new salt and nonce every time
        assert_ne!(serde_json::to_string(&vault::seal(&k, "correct horse", QUICK).unwrap()).unwrap(), json);
        // absurd costs in a file are refused, not tried
        let costly: vault::Sealed = serde_json::from_str(&json.replace("\"m\":256", "\"m\":4000000000")).unwrap();
        assert_eq!(vault::unseal(&costly, "correct horse").err().unwrap(), "金鑰檔損壞");
    }

    #[test]
    fn key_file_states() {
        let file = std::env::temp_dir().join(format!("qtchart-key-{}.bin", std::process::id()));
        // a file from before passwords: usable, not protected, can't be locked
        std::fs::write(&file, serde_json::to_vec(&test_keys()).unwrap()).unwrap();
        let mut t = Trader::new(file.clone());
        t.kdf = QUICK;
        let st = t.status();
        assert!(st.set && !st.locked && !st.protected && st.demo);
        assert_eq!(t.keys_set(), Some(true));
        assert!(t.lock().is_err());
        // a password for it: sealed in the file, still open
        assert_eq!(run(t.set_password(None, "short".into())).err().unwrap(), "解鎖密碼至少要 8 個字");
        let st = run(t.set_password(None, "correct horse".into())).unwrap();
        assert!(st.protected && !st.locked);
        assert!(matches!(vault::load(&file), Some(vault::Stored::Sealed(_))));
        assert!(!std::fs::read_to_string(&file).unwrap().contains("s3cr3t"));
        // locked: nothing to sign with
        assert!(t.lock().unwrap().locked);
        assert_eq!(t.keys_set(), None);
        assert_eq!(t.keys().err().unwrap(), LOCKED);
        assert_eq!(t.status().hint, "abcd…5678"); // still shown while locked
        assert!(run(t.unlock("wrong password".into())).is_err());
        assert!(t.status().locked);
        assert!(!run(t.unlock("correct horse".into())).unwrap().locked);
        assert_eq!(fields(&t.keys().unwrap()), fields(&test_keys()));
        // changing it takes the current one
        assert!(run(t.set_password(None, "battery staple".into())).is_err());
        assert!(run(t.set_password(Some("wrong password".into()), "battery staple".into())).is_err());
        run(t.set_password(Some("correct horse".into()), "battery staple".into())).unwrap();
        // the next start: locked until the new password
        let mut again = Trader::new(file.clone());
        again.kdf = QUICK;
        assert!(again.status().locked);
        assert!(run(again.unlock("correct horse".into())).is_err());
        assert!(!run(again.unlock("battery staple".into())).unwrap().locked);
        // removed: gone in any state
        assert!(again.lock().unwrap().locked);
        again.clear().unwrap();
        assert!(!again.status().set);
        assert!(vault::load(&file).is_none());
        vault::remove(&file).unwrap(); // already gone: fine
    }
}
