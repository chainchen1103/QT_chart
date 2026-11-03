//! QT Chart backend: market data from OKX for the chart window, alert notifications, and the window itself.
//! The page can call only the commands below, and only those listed in capabilities/default.json
//! (build.rs declares them; anything else is refused).

mod bars;
mod okx;
mod prefs;
mod store;
mod stream;
mod trade;
mod window;
mod ws;

use okx::{Candle, Client, Instrument, Pair};
use std::collections::HashMap;
use std::path::PathBuf;
use store::Store;
use stream::Live;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use trade::{Account, KeyStatus, OrderInfo, OrderReq, Placed, Trader};

struct AppState {
    client: Client,
    live: Live,
    /// Where prefs.json lives.
    config_dir: PathBuf,
    store: Store,
    trader: Trader,
}

fn check(inst_id: &str, bar: &str) -> Result<(), String> {
    if okx::valid_inst(inst_id) && okx::valid_bar(bar) {
        Ok(())
    } else {
        Err(format!("不支援的商品或週期：{inst_id} {bar}"))
    }
}

/// Live USDT perpetuals, most traded first.
#[tauri::command]
async fn list_instruments(state: State<'_, AppState>) -> Result<Vec<Instrument>, String> {
    state.client.instruments().await
}

/// About `count` bars ending now, or ending just before `before` (UTC ms), oldest first.
#[tauri::command]
async fn get_candles(
    state: State<'_, AppState>,
    inst_id: String,
    bar: String,
    before: Option<i64>,
    count: Option<usize>,
) -> Result<Vec<Candle>, String> {
    check(&inst_id, &bar)?;
    let spec = bars::spec(&bar).ok_or_else(|| format!("不支援的週期：{bar}"))?;
    let count = count.unwrap_or(500).clamp(1, 3000);
    if spec.hist_n == 1 {
        return state.client.candles(&inst_id, spec.hist, before, count).await;
    }
    // put together from shorter OKX bars: one extra bar's worth, so the oldest one is whole
    let n = spec.hist_n as usize;
    let parts = state.client.candles(&inst_id, spec.hist, before, (count * n + n - 1).min(8000)).await?;
    let mut out = bars::group(&spec, &parts, bars::okx_sec(spec.hist), true);
    if out.len() > count {
        out.drain(..out.len() - count);
    }
    Ok(out)
}

/// Live candles ("candle" events) for exactly these symbols and timeframes: the charts on screen, the
/// symbols with alerts (1m), the tabs. Replaces the previous list; an empty list stops.
#[tauri::command]
fn set_streams(app: AppHandle, state: State<'_, AppState>, pairs: Vec<Pair>) -> Result<(), String> {
    if pairs.len() > stream::MAX_PAIRS {
        return Err(format!("最多同時接收 {} 組即時報價", stream::MAX_PAIRS));
    }
    if let Some(bad) = pairs.iter().find(|p| !p.valid()) {
        return Err(format!("不支援的商品或週期：{} {}", bad.inst_id, bad.bar));
    }
    state.live.set(app, state.client.clone(), pairs);
    Ok(())
}

/// An alert went off: flash the taskbar button when the window is in the background, and show a Windows
/// notification when `system` is on (with the system sound when `sound` is on). Text is cut to a sane length.
#[tauri::command]
fn alert_notify(app: AppHandle, window: WebviewWindow, title: String, body: String, system: bool, sound: bool) -> Result<(), String> {
    if !window.is_focused().unwrap_or(false) {
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Critical));
    }
    if !system {
        return Ok(());
    }
    use tauri_plugin_notification::NotificationExt;
    let mut n = app.notification().builder().title(title.chars().take(80).collect::<String>()).body(body.chars().take(300).collect::<String>());
    if sound {
        n = n.sound("Default");
    }
    n.show().map_err(|e| format!("系統通知失敗：{e}"))
}

/// Everything saved (settings, drawings, alerts), read once when the page starts.
#[tauri::command]
fn store_load(state: State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    state.store.load()
}

/// Save one value right away. Runs on the main thread, so saves land in the order they were made.
#[tauri::command]
fn store_set(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    state.store.set(&key, &value)
}

#[tauri::command]
fn store_remove(state: State<'_, AppState>, key: String) -> Result<(), String> {
    state.store.remove(&key)
}

/// Is an OKX API key set (and its first and last characters)? The secret itself never comes back to the page.
#[tauri::command]
fn trade_status(state: State<'_, AppState>) -> KeyStatus {
    state.trader.status()
}

/// Check the key on the account, then keep it (encrypted). Returns the account.
#[tauri::command]
async fn trade_set_keys(state: State<'_, AppState>, key: String, secret: String, passphrase: String, demo: bool) -> Result<Account, String> {
    state.trader.set_keys(key, secret, passphrase, demo).await
}

#[tauri::command]
fn trade_clear_keys(state: State<'_, AppState>) -> Result<(), String> {
    state.trader.clear()
}

/// USDT equity, what is free, the position mode.
#[tauri::command]
async fn trade_account(state: State<'_, AppState>) -> Result<Account, String> {
    state.trader.account().await
}

/// Open a position: set the leverage, then a limit / post-only / market order with its stop-loss attached.
#[tauri::command]
async fn trade_place(state: State<'_, AppState>, order: OrderReq) -> Result<Placed, String> {
    state.trader.place(order).await
}

#[tauri::command]
async fn trade_order(state: State<'_, AppState>, inst_id: String, ord_id: String) -> Result<OrderInfo, String> {
    state.trader.order(&inst_id, &ord_id).await
}

#[tauri::command]
async fn trade_cancel(state: State<'_, AppState>, inst_id: String, ord_id: String) -> Result<(), String> {
    state.trader.cancel(&inst_id, &ord_id).await
}

/// Whether the web view may use the graphics card (takes effect at the next start).
#[tauri::command]
fn gpu_pref(state: State<'_, AppState>) -> bool {
    prefs::load(&state.config_dir).gpu
}

#[tauri::command]
fn set_gpu_pref(state: State<'_, AppState>, on: bool) -> Result<(), String> {
    let mut p = prefs::load(&state.config_dir);
    p.gpu = on;
    prefs::save(&state.config_dir, &p)
}

/// Open https://www.tradingview.com/ in the default browser. The chart library's licence asks for a link to
/// TradingView where users see it (the status bar credit). The address is fixed: nothing else can be opened.
#[tauri::command]
fn open_tradingview() -> Result<(), String> {
    const URL: &str = "https://www.tradingview.com/";
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", URL]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(URL);
        c
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(URL);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| format!("開不了瀏覽器：{e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            let store = Store::new(data_dir.join("store"));
            // outside the store folder: the page can't read it back
            let trader = Trader::new(data_dir.join("okx-api.bin"));
            let prefs = prefs::load(&config_dir);
            app.manage(AppState { client: Client::new(), live: Live::default(), config_dir, store, trader });
            window::create(app.handle(), prefs)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_instruments,
            get_candles,
            set_streams,
            alert_notify,
            store_load,
            store_set,
            store_remove,
            trade_status,
            trade_set_keys,
            trade_clear_keys,
            trade_account,
            trade_place,
            trade_order,
            trade_cancel,
            gpu_pref,
            set_gpu_pref,
            open_tradingview
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
