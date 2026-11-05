//! A local MCP server (Model Context Protocol), so AI apps on this computer (Claude, ChatGPT, Cursor, Gemini,
//! LM Studio, ...) can read the charts and work on them with the tools the page offers (src/mcp/). Off unless
//! the page turns it on (設定 → AI 連線).
//!
//! - Streamable HTTP, as MCP defines it: JSON-RPC posted to http://127.0.0.1:<port>/mcp, answered as JSON.
//!   initialize and ping are answered here; tools/list and tools/call go to the page (the `mcp_call` event,
//!   answered with the mcp_reply command), which knows the charts, the drawings and the account.
//! - Only this computer: it listens on 127.0.0.1, takes a request only with the token shown in the settings
//!   (Authorization: Bearer), and refuses requests from web pages (an Origin header) and for other host names, so
//!   a web site can't reach it through the browser.
//! - `QT Chart --mcp-stdio` (stdio) is the same server for apps that start a program and talk over its stdin and
//!   stdout: each line goes on to the running QT Chart, with the port and token from mcp.json in the app's data.

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chacha20poly1305::aead::rand_core::RngCore;
use chacha20poly1305::aead::OsRng;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{HeaderName, HeaderValue, ALLOW, AUTHORIZATION, CONTENT_TYPE, HOST, ORIGIN, WWW_AUTHENTICATE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch};

pub const DEFAULT_PORT: u16 = 39217;
/// The app's identifier (tauri.conf.json): where its data is, for `--mcp-stdio`.
const IDENTIFIER: &str = "com.chainchen.qtchart";
/// MCP versions spoken, newest first.
const VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/// How long the page may take over a tool call: it answers an order waiting for the user's OK within a minute
/// ("still waiting"), so longer means the page is gone (reloaded, closing).
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_BODY: usize = 4 << 20;
/// Sessions remembered (which app each is), newest kept.
const MAX_SESSIONS: usize = 64;
/// Given at initialize and sent back by the app with every request (Streamable HTTP).
const SESSION_HEADER: HeaderName = HeaderName::from_static("mcp-session-id");

const INSTRUCTIONS: &str = "QT Chart is a charting and trading app for OKX USDT perpetual swaps (symbols like \
BTC-USDT-SWAP; timeframes like 1m, 5m, 15m, 1H, 4H, 1D, 1W). Times are UTC seconds; prices are plain numbers. \
Start with get_app_state: it says which charts are open, whether an OKX API key is set (demo or real money) and \
what this connection may do (read, change charts, place orders). Drawings belong to a symbol and show on every \
chart of it. Orders are always placed from a position (entry, stop-loss, take-profit): the size follows the \
user's risk settings and the stop-loss always goes with the order; the user may have to confirm each order in \
QT Chart. Never place an order the user did not ask for.";

/// The settings page shows this.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    running: bool,
    port: u16,
    token: String,
    /// Why it couldn't start, if it couldn't.
    error: String,
    /// mcp.json: where `--mcp-stdio` finds the port and token.
    config: String,
    /// This program, for apps that start it with --mcp-stdio.
    exe: String,
}

/// Port and token, kept for `--mcp-stdio` (and the next start: the token stays the same).
#[derive(Serialize, Deserialize)]
struct Config {
    port: u16,
    token: String,
}

#[derive(Default)]
pub struct Mcp {
    shared: Arc<Shared>,
    run: Mutex<Option<watch::Sender<bool>>>,
    status: Mutex<Option<(u16, String)>>,
}

#[derive(Default)]
struct Shared {
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next: AtomicU64,
    token: Mutex<String>,
    /// Session id → the app's name (from initialize), oldest first.
    sessions: Mutex<Vec<(String, String)>>,
}

impl Shared {
    fn client(&self, session: &str) -> String {
        let list = self.sessions.lock().unwrap();
        list.iter().find(|(id, _)| id == session).map(|(_, name)| name.clone()).unwrap_or_default()
    }

    /// A new session for an app that introduced itself as `name`.
    fn open(&self, name: String) -> String {
        let id = new_token()[..32].to_string();
        let mut list = self.sessions.lock().unwrap();
        if list.len() >= MAX_SESSIONS {
            list.remove(0);
        }
        list.push((id.clone(), name));
        id
    }
}

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
    shared: Arc<Shared>,
    port: u16,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("mcp.json"))
}

fn read_config(path: &Path) -> Option<Config> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn write_config(path: &Path, c: &Config) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(c).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// 32 random bytes as hex.
fn new_token() -> String {
    let mut b = [0u8; 32];
    OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The same, in time that doesn't depend on where they differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl Mcp {
    fn token(&self, app: &AppHandle) -> String {
        let mut t = self.shared.token.lock().unwrap();
        if t.is_empty() {
            *t = config_path(app).ok().and_then(|p| read_config(&p)).map(|c| c.token).filter(|t| t.len() >= 32).unwrap_or_else(new_token);
        }
        t.clone()
    }

    fn status(&self, app: &AppHandle) -> McpStatus {
        let st = self.status.lock().unwrap().clone();
        let running = self.run.lock().unwrap().is_some();
        let port = st.as_ref().map(|s| s.0).unwrap_or(DEFAULT_PORT);
        McpStatus {
            running,
            port,
            token: self.token(app),
            error: st.map(|s| s.1).unwrap_or_default(),
            config: config_path(app).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
            exe: std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        }
    }

    fn stop(&self) {
        if let Some(stop) = self.run.lock().unwrap().take() {
            let _ = stop.send(true);
        }
    }

    async fn start(&self, app: &AppHandle, port: u16) -> McpStatus {
        self.stop();
        let token = self.token(app);
        let error = match TcpListener::bind(("127.0.0.1", port)).await {
            Err(e) => format!("開不了 127.0.0.1:{port}：{e}"),
            Ok(listener) => {
                let (tx, rx) = watch::channel(false);
                *self.run.lock().unwrap() = Some(tx);
                let ctx = Ctx { app: app.clone(), shared: self.shared.clone(), port };
                tauri::async_runtime::spawn(serve(listener, ctx, rx));
                match config_path(app).and_then(|p| write_config(&p, &Config { port, token })) {
                    Ok(()) => String::new(),
                    Err(e) => format!("寫不了 mcp.json（stdio 接不上）：{e}"),
                }
            }
        };
        *self.status.lock().unwrap() = Some((port, error));
        self.status(app)
    }
}

async fn serve(listener: TcpListener, ctx: Ctx, mut stop: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            r = listener.accept() => {
                let Ok((stream, _)) = r else { continue };
                let ctx = ctx.clone();
                tauri::async_runtime::spawn(async move {
                    let svc = service_fn(move |req| {
                        let ctx = ctx.clone();
                        async move { Ok::<_, Infallible>(answer(&ctx, req).await) }
                    });
                    let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), svc).await;
                });
            }
            _ = stop.changed() => break,
        }
    }
}

fn plain(code: StatusCode, text: &str) -> Response<Full<Bytes>> {
    let mut r = Response::new(Full::new(Bytes::from(text.to_string())));
    *r.status_mut() = code;
    r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    r
}

fn json_response(v: &Value) -> Response<Full<Bytes>> {
    let mut r = Response::new(Full::new(Bytes::from(v.to_string())));
    r.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r
}

/// Is this host name (with or without the port) this server on this computer?
fn local_host(host: &str, port: u16) -> bool {
    ["127.0.0.1", "localhost"].iter().any(|h| host == *h || host == format!("{h}:{port}"))
}

async fn answer(ctx: &Ctx, req: Request<Incoming>) -> Response<Full<Bytes>> {
    if req.uri().path() != "/mcp" {
        return plain(StatusCode::NOT_FOUND, "QT Chart MCP: POST /mcp");
    }
    let header = |name| req.headers().get(name).and_then(|v: &HeaderValue| v.to_str().ok()).unwrap_or("");
    // another host name: maybe a web page that pointed its own name at 127.0.0.1 (DNS rebinding)
    if !local_host(header(HOST), ctx.port) {
        return plain(StatusCode::FORBIDDEN, "host not allowed");
    }
    // web pages send where they are from; apps don't
    if req.headers().contains_key(ORIGIN) {
        let o = header(ORIGIN);
        let own = o.strip_prefix("http://").is_some_and(|h| local_host(h, ctx.port));
        if !own {
            return plain(StatusCode::FORBIDDEN, "origin not allowed");
        }
    }
    if req.method() != Method::POST {
        let mut r = plain(StatusCode::METHOD_NOT_ALLOWED, "POST only");
        r.headers_mut().insert(ALLOW, HeaderValue::from_static("POST"));
        return r;
    }
    let token = ctx.shared.token.lock().unwrap().clone();
    let session = header(SESSION_HEADER).to_string();
    let given = header(AUTHORIZATION);
    let given = given.strip_prefix("Bearer ").or_else(|| given.strip_prefix("bearer ")).unwrap_or("");
    if token.is_empty() || !same(given.trim().as_bytes(), token.as_bytes()) {
        let mut r = plain(StatusCode::UNAUTHORIZED, "token missing or wrong (QT Chart → 設定 → AI 連線)");
        r.headers_mut().insert(WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        return r;
    }
    let body = match Limited::new(req.into_body(), MAX_BODY).collect().await {
        Ok(b) => b.to_bytes(),
        Err(_) => return plain(StatusCode::PAYLOAD_TOO_LARGE, "too large"),
    };
    let msg: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return json_response(&error(Value::Null, -32700, format!("Parse error: {e}"))),
    };
    // which app this is, when it sends the session it was given (an unknown one, say from before QT Chart was
    // restarted, is taken as it is: the app just isn't named)
    let mut client = ctx.shared.client(&session);
    let mut opened = None;
    let mut out = Vec::new();
    let batch = msg.is_array();
    for m in if let Value::Array(list) = msg { list } else { vec![msg] } {
        if let Some((r, s)) = message(ctx, m, &client).await {
            if let Some((id, name)) = s {
                client = name;
                opened = Some(id);
            }
            out.push(r);
        }
    }
    let mut r = match out.len() {
        0 => accepted(),
        1 if !batch => json_response(&out[0]),
        _ => json_response(&Value::Array(out)),
    };
    if let Some(id) = opened.and_then(|id| HeaderValue::from_str(&id).ok()) {
        r.headers_mut().insert(SESSION_HEADER, id);
    }
    r
}

/// Notifications and responses: taken, nothing to answer.
fn accepted() -> Response<Full<Bytes>> {
    let mut r = Response::new(Full::new(Bytes::new()));
    *r.status_mut() = StatusCode::ACCEPTED;
    r
}

fn error(id: Value, code: i64, message: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// One JSON-RPC message from the app named `client` ("" when unknown); the answer to it when it is a request,
/// with the new session (id, the app's name) when it was initialize.
async fn message(ctx: &Ctx, m: Value, client: &str) -> Option<(Value, Option<(String, String)>)> {
    let method = m.get("method").and_then(Value::as_str)?.to_string(); // a response from the client: nothing to say
    let id = m.get("id").cloned().filter(|v| !v.is_null())?; // a notification
    let params = m.get("params").cloned().unwrap_or(Value::Null);
    let mut session = None;
    let result = match method.as_str() {
        "initialize" => {
            let name = client_name(&params);
            session = Some((ctx.shared.open(name.clone()), name));
            Ok(initialize(&params))
        }
        "ping" => Ok(json!({})),
        "tools/list" | "tools/call" => ask(ctx, &method, params, client).await,
        _ => return Some((error(id, -32601, format!("Method not found: {method}")), None)),
    };
    let reply = match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => error(id, if e.starts_with("Unknown tool") { -32602 } else { -32603 }, e),
    };
    Some((reply, session))
}

/// The app's name as it introduces itself ("Claude", "cursor", ...), kept short and printable.
fn client_name(params: &Value) -> String {
    let info = params.get("clientInfo");
    let pick = |k| info.and_then(|i| i.get(k)).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let name = pick("title").or_else(|| pick("name")).unwrap_or("");
    name.chars().filter(|c| !c.is_control()).take(60).collect()
}

fn initialize(params: &Value) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
    let version = VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "qtchart", "title": "QT Chart", "version": env!("CARGO_PKG_VERSION") },
        "instructions": INSTRUCTIONS,
    })
}

/// Ask the page (it answers with mcp_reply); `client`: the app asking, for the page to show.
async fn ask(ctx: &Ctx, method: &str, params: Value, client: &str) -> Result<Value, String> {
    let id = ctx.shared.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = oneshot::channel();
    ctx.shared.pending.lock().unwrap().insert(id, tx);
    if let Err(e) = ctx.app.emit("mcp_call", json!({ "id": id, "method": method, "params": params, "client": client })) {
        ctx.shared.pending.lock().unwrap().remove(&id);
        return Err(format!("QT Chart 的畫面沒有回應：{e}"));
    }
    match tokio::time::timeout(CALL_TIMEOUT, rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("QT Chart 的畫面沒有回應".into()),
        Err(_) => {
            ctx.shared.pending.lock().unwrap().remove(&id);
            Err("QT Chart 太久沒有回應".into())
        }
    }
}

// ----------------------------------------------------------------------------- commands
#[tauri::command]
pub fn mcp_status(app: AppHandle, mcp: State<'_, Mcp>) -> McpStatus {
    mcp.status(&app)
}

#[tauri::command]
pub async fn mcp_start(app: AppHandle, mcp: State<'_, Mcp>, port: u16) -> Result<McpStatus, String> {
    if port < 1024 {
        return Err("連接埠要在 1024 到 65535 之間".into());
    }
    Ok(mcp.start(&app, port).await)
}

#[tauri::command]
pub fn mcp_stop(app: AppHandle, mcp: State<'_, Mcp>) -> McpStatus {
    mcp.stop();
    *mcp.status.lock().unwrap() = None;
    mcp.status(&app)
}

/// A new token; apps set up with the old one must be given this one.
#[tauri::command]
pub fn mcp_new_token(app: AppHandle, mcp: State<'_, Mcp>) -> Result<McpStatus, String> {
    let token = new_token();
    *mcp.shared.token.lock().unwrap() = token.clone();
    let port = mcp.status.lock().unwrap().as_ref().map(|s| s.0).unwrap_or(DEFAULT_PORT);
    config_path(&app).and_then(|p| write_config(&p, &Config { port, token }))?;
    Ok(mcp.status(&app))
}

/// The page's answer to an `mcp_call`.
#[tauri::command]
pub fn mcp_reply(mcp: State<'_, Mcp>, id: u64, result: Option<Value>, error: Option<String>) {
    if let Some(tx) = mcp.shared.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(match error {
            Some(e) => Err(e),
            None => Ok(result.unwrap_or(Value::Null)),
        });
    }
}

/// Bring the window to the front for the user (an order waiting for confirmation).
#[tauri::command]
pub fn window_attention(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.request_user_attention(Some(tauri::UserAttentionType::Critical));
    }
}

// ----------------------------------------------------------------------------- --mcp-stdio
/// Where the app keeps its data, worked out without the app (as Tauri's app_data_dir does).
fn data_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(not(any(windows, target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    base.map(|b| b.join(IDENTIFIER))
}

/// The ids of the requests in a message (to answer them when QT Chart can't).
fn request_ids(m: &Value) -> Vec<Value> {
    let one = |m: &Value| m.get("method").is_some().then(|| m.get("id").cloned().filter(|v| !v.is_null())).flatten();
    match m {
        Value::Array(list) => list.iter().filter_map(one).collect(),
        m => one(m).into_iter().collect(),
    }
}

/// Pass one line on; `session`: the one QT Chart gave at initialize, sent back with every later line.
async fn forward(client: &reqwest::Client, config: &Path, line: &str, session: &mut Option<String>) -> Result<Option<String>, String> {
    let c = read_config(config).ok_or("QT Chart 的 AI 連線沒有開（設定 → AI 連線）")?;
    let mut req = client
        .post(format!("http://127.0.0.1:{}/mcp", c.port))
        .bearer_auth(&c.token)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream");
    if let Some(s) = session.as_deref() {
        req = req.header(SESSION_HEADER.as_str(), s);
    }
    let r = req
        .body(line.to_string())
        .send()
        .await
        .map_err(|_| "QT Chart 沒有開，或沒有開啟 AI 連線（設定 → AI 連線）".to_string())?;
    if let Some(s) = r.headers().get(SESSION_HEADER.as_str()).and_then(|v| v.to_str().ok()) {
        *session = Some(s.to_string());
    }
    let code = r.status();
    let text = r.text().await.map_err(|e| e.to_string())?;
    if code == reqwest::StatusCode::ACCEPTED || text.trim().is_empty() {
        return Ok(None);
    }
    if !code.is_success() {
        return Err(format!("QT Chart 拒絕了這個連線（{code}）：{}", text.trim()));
    }
    // one line each: the stdio transport separates messages with new lines
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(Some(v.to_string()))
}

/// `--mcp-stdio`: newline-separated JSON-RPC on stdin / stdout, passed on to the running QT Chart. Nothing but
/// MCP messages is written to stdout; problems go to stderr, and to the app as JSON-RPC errors.
pub fn stdio() {
    use std::io::{BufRead, Write};
    let Some(config) = data_dir().map(|d| d.join("mcp.json")) else {
        eprintln!("QT Chart MCP: no data folder");
        return;
    };
    let client = match reqwest::Client::builder().no_proxy().timeout(CALL_TIMEOUT + Duration::from_secs(10)).build() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("QT Chart MCP: {e}");
            return;
        }
    };
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    let mut session = None;
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let reply = tauri::async_runtime::block_on(forward(&client, &config, line, &mut session));
        let lines: Vec<String> = match reply {
            Ok(Some(body)) => vec![body],
            Ok(None) => vec![],
            Err(e) => {
                eprintln!("QT Chart MCP: {e}");
                let ids = serde_json::from_str::<Value>(line).map(|m| request_ids(&m)).unwrap_or_default();
                ids.into_iter().map(|id| error(id, -32000, e.clone()).to_string()).collect()
            }
        };
        for l in lines {
            if writeln!(out, "{l}").and_then(|_| out.flush()).is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_and_tokens() {
        assert!(local_host("127.0.0.1:39217", 39217));
        assert!(local_host("localhost:39217", 39217));
        assert!(local_host("localhost", 39217));
        assert!(!local_host("evil.example:39217", 39217));
        assert!(!local_host("127.0.0.1:80", 39217));
        assert!(same(b"abc", b"abc"));
        assert!(!same(b"abc", b"abd"));
        assert!(!same(b"abc", b"abcd"));
        assert_eq!(new_token().len(), 64);
    }

    #[test]
    fn versions_and_ids() {
        assert_eq!(initialize(&json!({ "protocolVersion": "2025-03-26" }))["protocolVersion"], "2025-03-26");
        assert_eq!(initialize(&json!({ "protocolVersion": "1999-01-01" }))["protocolVersion"], VERSIONS[0]);
        let batch = json!([
            { "jsonrpc": "2.0", "id": 1, "method": "tools/list" },
            { "jsonrpc": "2.0", "method": "notifications/initialized" },
            { "jsonrpc": "2.0", "id": 2, "result": {} }
        ]);
        assert_eq!(request_ids(&batch), vec![json!(1)]);
    }

    #[test]
    fn sessions_name_the_app() {
        assert_eq!(client_name(&json!({ "clientInfo": { "name": "claude-ai", "title": "Claude" } })), "Claude");
        assert_eq!(client_name(&json!({ "clientInfo": { "name": "cursor\n" } })), "cursor");
        assert_eq!(client_name(&json!({})), "");
        let s = Shared::default();
        let a = s.open("Claude".into());
        let b = s.open("Cursor".into());
        assert_ne!(a, b);
        assert_eq!(s.client(&a), "Claude");
        assert_eq!(s.client(&b), "Cursor");
        assert_eq!(s.client("unknown"), "");
        for i in 0..MAX_SESSIONS {
            s.open(format!("app {i}"));
        }
        assert_eq!(s.client(&a), ""); // the oldest go first
        assert_eq!(s.sessions.lock().unwrap().len(), MAX_SESSIONS);
    }
}
