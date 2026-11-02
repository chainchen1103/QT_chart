//! The main window. Made here instead of from tauri.conf.json alone, so the web view starts with or without
//! GPU acceleration as set. Also: the window title follows the page title (no window permission for the page),
//! and on Windows the web view is asked to use less memory while the window is minimized.

use crate::prefs::Prefs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// WebView2 switches. wry's own defaults (no Office / PDF viewer UI, no SmartScreen lookups) have to be repeated
/// because setting switches replaces them. With the GPU on nothing is forced: Chromium uses the graphics card
/// for drawing and compositing wherever the driver isn't on its block list; off means software drawing.
pub fn browser_args(gpu: bool) -> String {
    let mut a = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
    if !gpu {
        a.push_str(" --disable-gpu --disable-gpu-compositing");
    }
    a
}

pub fn create(app: &AppHandle, prefs: Prefs) -> tauri::Result<WebviewWindow> {
    let conf = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .unwrap_or_default();
    #[cfg(target_os = "linux")]
    if !prefs.gpu {
        // WebKitGTK reads this when it starts the page's process, which happens when the window is built
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
    let window = WebviewWindowBuilder::from_config(app, &conf)?
        .additional_browser_args(&browser_args(prefs.gpu))
        .disable_drag_drop_handler()
        .on_document_title_changed(|w, title| {
            let _ = w.set_title(&title);
        })
        .build()?;
    let low = Arc::new(AtomicBool::new(false));
    let w = window.clone();
    window.on_window_event(move |e| {
        if let WindowEvent::Resized(_) = e {
            let minimized = w.is_minimized().unwrap_or(false);
            if low.swap(minimized, Ordering::Relaxed) != minimized {
                memory_target(&w, minimized);
            }
        }
    });
    Ok(window)
}

/// Windows: ask WebView2 to keep its memory low (it drops caches) while minimized, and normal again after.
#[cfg(windows)]
fn memory_target(w: &WebviewWindow, low: bool) {
    let _ = w.with_webview(move |pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        };
        use windows_core::Interface;
        if let Ok(core) = pw.controller().CoreWebView2() {
            if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
                let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
                let _ = core19.SetMemoryUsageTargetLevel(level);
            }
        }
    });
}

#[cfg(not(windows))]
fn memory_target(_: &WebviewWindow, _: bool) {}

#[cfg(test)]
mod tests {
    use super::browser_args;

    #[test]
    fn gpu_switches() {
        assert!(!browser_args(true).contains("disable-gpu"));
        assert!(browser_args(false).contains("--disable-gpu --disable-gpu-compositing"));
        assert!(browser_args(true).starts_with("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"));
    }
}
