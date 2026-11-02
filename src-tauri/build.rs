// The page may call only these commands; capabilities/default.json grants each one by name ("allow-…").
const COMMANDS: &[&str] = &[
    "list_instruments",
    "get_candles",
    "start_stream",
    "watch_symbols",
    "alert_notify",
    "store_load",
    "store_set",
    "store_remove",
    "gpu_pref",
    "set_gpu_pref",
    "open_tradingview",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("tauri-build failed");
}
