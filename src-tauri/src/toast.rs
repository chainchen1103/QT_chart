//! Alerts as Windows notifications of QT Chart's own. The app's identifier is registered for the Windows user
//! (HKCU\Software\Classes\AppUserModelId, Microsoft's way for programs that aren't installed as packages: no
//! installer, no admin rights, no Start menu shortcut) with QT Chart's name and icon, so the notifications say
//! QT Chart wherever the program runs from, and Windows lists QT Chart in its notification settings. Clicking one
//! brings the window back and opens the symbol (while QT Chart is running). Elsewhere, and if registering
//! fails, the notification plugin shows them as before.

use std::sync::OnceLock;
use tauri::{AppHandle, WebviewWindow};

/// The app id notifications are sent with, once registered (None: registering failed, or not Windows).
static APP_ID: OnceLock<Option<String>> = OnceLock::new();

/// Register QT Chart's notifications for the Windows user (at startup; does nothing elsewhere).
pub fn init(app: &AppHandle) {
    #[cfg(windows)]
    let id = win::register(app);
    #[cfg(not(windows))]
    let id: Option<String> = {
        let _ = app;
        None
    };
    let _ = APP_ID.set(id);
}

/// Show an alert as a notification (with the system sound when `sound` is on). A click on it shows `window`
/// and tells the page to open `inst_id` (the `alert_open` event).
pub fn show(app: &AppHandle, window: &WebviewWindow, title: &str, body: &str, sound: bool, inst_id: String) -> Result<(), String> {
    #[cfg(windows)]
    if let Some(Some(id)) = APP_ID.get() {
        return win::show(id, window.clone(), title, body, sound, inst_id).map_err(|e| format!("Windows 通知失敗：{e}"));
    }
    let _ = (window, inst_id);
    use tauri_plugin_notification::NotificationExt;
    let mut n = app.notification().builder().title(title).body(body);
    if sound {
        n = n.sound("Default");
    }
    n.show().map_err(|e| format!("系統通知失敗：{e}"))
}

#[cfg(windows)]
mod win {
    use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
    use tauri_winrt_notification::{Duration, Sound, Toast};

    /// The picture Windows shows with the notifications (written next to the app's data on first use).
    const ICON: &[u8] = include_bytes!("../icons/128x128.png");

    /// Register the app's identifier as a Windows app id, with QT Chart's name and icon. The id, or None when
    /// any step failed (then the plugin shows the notifications).
    pub fn register(app: &AppHandle) -> Option<String> {
        let id = app.config().identifier.clone();
        let dir = app.path().app_local_data_dir().ok()?;
        std::fs::create_dir_all(&dir).ok()?;
        let icon = dir.join("notification-icon.png");
        if std::fs::read(&icon).ok().as_deref() != Some(ICON) {
            std::fs::write(&icon, ICON).ok()?;
        }
        let key = windows_registry::CURRENT_USER.create(format!(r"Software\Classes\AppUserModelId\{id}")).ok()?;
        key.set_string("DisplayName", "QT Chart").ok()?;
        key.set_string("IconUri", icon.to_string_lossy().as_ref()).ok()?;
        Some(id)
    }

    /// Show one notification under the registered id; it stays about 25 seconds, then waits in the
    /// notification center.
    pub fn show(id: &str, window: WebviewWindow, title: &str, body: &str, sound: bool, inst_id: String) -> tauri_winrt_notification::Result<()> {
        Toast::new(id)
            .title(title)
            .text1(body)
            .sound(if sound { Some(Sound::Default) } else { None })
            .duration(Duration::Long)
            .on_activated(move |_| {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.app_handle().emit("alert_open", inst_id.clone());
                Ok(())
            })
            .show()
    }
}
