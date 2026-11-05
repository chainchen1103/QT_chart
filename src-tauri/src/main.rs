// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // an AI app started this to talk MCP over stdin / stdout: pass it on to the running QT Chart, no window
    if std::env::args().any(|a| a == "--mcp-stdio") {
        qtchart_lib::mcp_stdio();
        return;
    }
    qtchart_lib::run()
}
