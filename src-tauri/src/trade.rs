//! Orders on OKX with the user's own API key.
//!
//! The key is entered once in the app and kept in a file in the app's data folder (not the store folder the
//! page can read), encrypted on Windows with the Windows user's own key (DPAPI): only this Windows account on
//! this computer can read it back. The page can only ask whether a key is set (and see the first and last
//! characters of the key), use it through the commands below, or remove it; the secret never goes back to it.
//!
//! What the commands can do is narrow on purpose: read the USDT equity and the account's position mode, open a
//! USDT perpetual position with a limit, post-only or market order that always carries its stop-loss (and the
//! take-profit when given), look an order up, cancel one. No withdrawals, transfers or closing orders.
//! Every request is signed here (HMAC-SHA256 over time + method + path + body), with OKX's server time.

use crate::okx;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Clone, Serialize, Deserialize)]
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
}

const NO_KEY: &str = "還沒設定 OKX API";

pub struct Trader {
    file: PathBuf,
    /// None: not read from the file yet.
    keys: Mutex<Option<Option<Keys>>>,
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
        Self { file, keys: Mutex::new(None), offset: Mutex::new(None), http }
    }

    fn keys(&self) -> Option<Keys> {
        let mut g = self.keys.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_none() {
            *g = Some(vault::load(&self.file));
        }
        g.clone().flatten()
    }

    pub fn status(&self) -> KeyStatus {
        match self.keys() {
            Some(k) => KeyStatus { set: true, demo: k.demo, hint: hint(&k.key) },
            None => KeyStatus { set: false, demo: false, hint: String::new() },
        }
    }

    /// Try the key on the account first; it is saved only when OKX accepts it.
    pub async fn set_keys(&self, key: String, secret: String, passphrase: String, demo: bool) -> Result<Account, String> {
        let k = Keys { key: key.trim().to_string(), secret: secret.trim().to_string(), passphrase, demo };
        for (name, v) in [("API Key", &k.key), ("Secret Key", &k.secret), ("Passphrase", &k.passphrase)] {
            if v.is_empty() || v.len() > 128 || !v.chars().all(|c| c.is_ascii_graphic() || c == ' ') {
                return Err(format!("{name} 格式不對"));
            }
        }
        let account = self.account_with(&k).await?;
        vault::save(&self.file, &k)?;
        *self.keys.lock().unwrap_or_else(|e| e.into_inner()) = Some(Some(k));
        Ok(account)
    }

    pub fn clear(&self) -> Result<(), String> {
        *self.keys.lock().unwrap_or_else(|e| e.into_inner()) = Some(None);
        vault::remove(&self.file)
    }

    pub async fn account(&self) -> Result<Account, String> {
        let k = self.keys().ok_or(NO_KEY)?;
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
        let k = self.keys().ok_or(NO_KEY)?;
        let cfg = self.call(&k, "GET", "/api/v5/account/config", "", None).await?;
        let c = cfg.first().ok_or("OKX 沒有回帳戶設定")?;
        if c["acctLv"].as_str() == Some("1") {
            return Err("這個 OKX 帳戶是現貨模式，不能開永續合約；請先在 OKX 把帳戶模式改成合約模式（單幣種保證金）".into());
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

    pub async fn order(&self, inst_id: &str, ord_id: &str) -> Result<OrderInfo, String> {
        check_ids(inst_id, ord_id)?;
        let k = self.keys().ok_or(NO_KEY)?;
        let data = self.call(&k, "GET", "/api/v5/trade/order", &format!("instId={inst_id}&ordId={ord_id}"), None).await?;
        let d = data.into_iter().next().ok_or("查不到這筆單")?;
        serde_json::from_value(d).map_err(|e| format!("訂單資料格式不對：{e}"))
    }

    pub async fn cancel(&self, inst_id: &str, ord_id: &str) -> Result<(), String> {
        check_ids(inst_id, ord_id)?;
        let k = self.keys().ok_or(NO_KEY)?;
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
    async fn now_ms(&self) -> i64 {
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
        if self.cl_ord_id.is_empty() || self.cl_ord_id.len() > 32 || !self.cl_ord_id.chars().all(|c| c.is_ascii_alphanumeric()) {
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
        "50101" => "這組 API 和環境不符（實盤的 API 不能用在模擬盤，反過來也一樣）",
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

/// The key file: DPAPI on Windows; elsewhere (development builds) plain, readable by this user only.
mod vault {
    use super::Keys;
    use std::path::Path;

    pub fn load(file: &Path) -> Option<Keys> {
        let sealed = std::fs::read(file).ok()?;
        serde_json::from_slice(&open(&sealed)?).ok()
    }

    pub fn save(file: &Path, k: &Keys) -> Result<(), String> {
        let sealed = seal(&serde_json::to_vec(k).map_err(|e| e.to_string())?)?;
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

    pub fn remove(file: &Path) -> Result<(), String> {
        match std::fs::remove_file(file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("刪不掉 API：{e}")),
            _ => Ok(()),
        }
    }

    #[cfg(windows)]
    const ENTROPY: &[u8] = b"qtchart okx api";

    #[cfg(windows)]
    fn seal(data: &[u8]) -> Result<Vec<u8>, String> {
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
    fn open(data: &[u8]) -> Option<Vec<u8>> {
        use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let entropy = CRYPT_INTEGER_BLOB { cbData: ENTROPY.len() as u32, pbData: ENTROPY.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: as in seal
        let ok = unsafe {
            CryptUnprotectData(&input, std::ptr::null_mut(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        (ok != 0).then(|| take(out))
    }

    /// Copy a blob DPAPI allocated, then free it.
    #[cfg(windows)]
    fn take(b: windows_sys::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: DPAPI returned cbData bytes at pbData, allocated with LocalAlloc
        unsafe {
            let v = std::slice::from_raw_parts(b.pbData, b.cbData as usize).to_vec();
            windows_sys::Win32::Foundation::LocalFree(b.pbData as _);
            v
        }
    }

    #[cfg(not(windows))]
    fn seal(data: &[u8]) -> Result<Vec<u8>, String> {
        Ok(data.to_vec())
    }
    #[cfg(not(windows))]
    fn open(data: &[u8]) -> Option<Vec<u8>> {
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
        let mut m = req();
        (m.ord_type, m.tp) = ("market".into(), None);
        let b = m.body(None);
        assert!(b.get("px").is_none() && b.get("posSide").is_none());
        assert!(b["attachAlgoOrds"][0].get("tpTriggerPx").is_none());
        assert_eq!(explain("50110", "Invalid IP"), "這台電腦的 IP 不在這組 API 的白名單裡（OKX 50110：Invalid IP）");
    }

    #[test]
    fn key_file_round_trip() {
        let file = std::env::temp_dir().join(format!("qtchart-key-{}.bin", std::process::id()));
        let k = Keys { key: "k".into(), secret: "s".into(), passphrase: "p p".into(), demo: true };
        vault::save(&file, &k).unwrap();
        let back = vault::load(&file).unwrap();
        assert_eq!((back.key, back.secret, back.passphrase, back.demo), ("k".into(), "s".into(), "p p".into(), true));
        vault::remove(&file).unwrap();
        vault::remove(&file).unwrap(); // already gone: fine
        assert!(vault::load(&file).is_none());
    }
}
