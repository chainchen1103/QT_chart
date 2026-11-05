// The page may call only these commands; capabilities/default.json grants each one by name ("allow-…").
const COMMANDS: &[&str] = &[
    "list_instruments",
    "get_candles",
    "set_streams",
    "alert_notify",
    "store_load",
    "store_set",
    "store_remove",
    "trade_status",
    "trade_set_keys",
    "trade_unlock",
    "trade_lock",
    "trade_set_password",
    "trade_clear_keys",
    "trade_account",
    "trade_place",
    "trade_order",
    "trade_cancel",
    "trade_sync",
    "trade_closed_positions",
    "trade_amend_stops",
    "gpu_pref",
    "set_gpu_pref",
    "open_tradingview",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("tauri-build failed");
}
