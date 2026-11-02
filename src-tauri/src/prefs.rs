//! Preferences the backend needs before the window opens, so the web page can't keep them: GPU on or off.
//! Saved as prefs.json in the app's config folder (Windows: %APPDATA%\com.chainchen.qtchart).

use serde::{Deserialize, Serialize};
use std::path::Path;

const FILE: &str = "prefs.json";

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Prefs {
    /// Let the web view draw with the graphics card when Windows / the driver allow it.
    pub gpu: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { gpu: true }
    }
}

/// The saved preferences, or the defaults when there are none (or the file is damaged).
pub fn load(dir: &Path) -> Prefs {
    std::fs::read_to_string(dir.join(FILE)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save(dir: &Path, p: &Prefs) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(p).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(FILE), text).map_err(|e| format!("存不了設定：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_damaged_file_gives_defaults() {
        let dir = std::env::temp_dir().join(format!("qtchart-prefs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load(&dir), Prefs { gpu: true });
        save(&dir, &Prefs { gpu: false }).unwrap();
        assert_eq!(load(&dir), Prefs { gpu: false });
        std::fs::write(dir.join(FILE), "{not json").unwrap();
        assert_eq!(load(&dir), Prefs::default());
        std::fs::write(dir.join(FILE), "{}").unwrap();
        assert!(load(&dir).gpu);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
