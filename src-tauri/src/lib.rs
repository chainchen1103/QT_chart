//! QT Chart backend: market data from OKX for the chart window, alert notifications, and the window itself.
//! The page can call only the commands below, and only those listed in capabilities/default.json
//! (build.rs declares them; anything else is refused).

mod okx;
mod prefs;
mod store;
mod stream;
mod watch;
mod window;
mod ws;

use okx::{Candle, Client, Instrument};
use std::collections::HashMap;
use std::path::PathBuf;
use store::Store;
use stream::StreamManager;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use watch::Watcher;

struct AppState {
    client: Client,
    streams: StreamManager,
    watcher: Watcher,
    /// Where prefs.json lives.
    config_dir: PathBuf,
    store: Store,
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
    state.client.candles(&inst_id, &bar, before, count.unwrap_or(500)).await
}

/// Stream live candles for this symbol and bar (replaces the previous stream).
#[tauri::command]
fn start_stream(app: AppHandle, state: State<'_, AppState>, inst_id: String, bar: String) -> Result<(), String> {
    check(&inst_id, &bar)?;
    state.streams.start(app, state.client.clone(), inst_id, bar);
    Ok(())
}

/// Stream 1-minute candles of these symbols for the price alerts ("watch_candle" events); an empty list stops.
#[tauri::command]
fn watch_symbols(app: AppHandle, state: State<'_, AppState>, inst_ids: Vec<String>) -> Result<(), String> {
    if inst_ids.len() > watch::MAX_WATCH {
        return Err(format!("最多同時盯 {} 個幣種", watch::MAX_WATCH));
    }
    if let Some(bad) = inst_ids.iter().find(|i| !okx::valid_inst(i)) {
        return Err(format!("不支援的商品：{bad}"));
    }
    state.watcher.set(app, state.client.clone(), inst_ids);
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
            let store = Store::new(app.path().app_data_dir()?.join("store"));
            let prefs = prefs::load(&config_dir);
            app.manage(AppState { client: Client::new(), streams: StreamManager::default(), watcher: Watcher::default(), config_dir, store });
            window::create(app.handle(), prefs)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_instruments,
            get_candles,
            start_stream,
            watch_symbols,
            alert_notify,
            store_load,
            store_set,
            store_remove,
            gpu_pref,
            set_gpu_pref,
            open_tradingview
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
