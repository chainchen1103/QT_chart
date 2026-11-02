//! Saved data: settings, the drawings of each symbol, alerts, the background picture. One file per key in the
//! app's data folder (Windows: %APPDATA%\com.chainchen.qtchart\store), written the moment something changes,
//! through a temporary file and a rename, so a crash or a power cut leaves the old version or the new one,
//! never half of one. The page can only touch files in that folder, with plain names, up to a size limit.

use std::collections::HashMap;
use std::path::PathBuf;

const EXT: &str = "json";
/// The background picture is the largest value (well under 2 MB).
pub const MAX_VALUE: usize = 8 * 1024 * 1024;

pub struct Store {
    dir: PathBuf,
}

/// Letters, digits, "-", "_" and "." (not first), at most 100: no folders, no "..", nothing hidden.
pub fn valid_key(k: &str) -> bool {
    !k.is_empty()
        && k.len() <= 100
        && !k.starts_with('.')
        && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn file(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.{EXT}"))
    }

    /// Every saved key and its value (files that aren't ours or are too large are skipped).
    pub fn load(&self) -> Result<HashMap<String, String>, String> {
        let mut out = HashMap::new();
        let entries = match std::fs::read_dir(&self.dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out), // nothing saved yet
            Err(e) => return Err(format!("讀不到存檔資料夾：{e}")),
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|x| x.to_str()) != Some(EXT) {
                continue;
            }
            let Some(key) = path.file_stem().and_then(|s| s.to_str()) else { continue };
            if !valid_key(key) || entry.metadata().map(|m| m.len() as usize > MAX_VALUE).unwrap_or(true) {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&path) {
                out.insert(key.to_string(), text);
            }
        }
        Ok(out)
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        if !valid_key(key) {
            return Err(format!("不能用這個名字存檔：{key}"));
        }
        if value.len() > MAX_VALUE {
            return Err("資料太大，無法保存".into());
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("資料夾建立失敗：{e}"))?;
        let tmp = self.dir.join(format!("{key}.{EXT}.tmp"));
        std::fs::write(&tmp, value).map_err(|e| format!("存檔失敗：{e}"))?;
        std::fs::rename(&tmp, self.file(key)).map_err(|e| format!("存檔失敗：{e}"))
    }

    pub fn remove(&self, key: &str) -> Result<(), String> {
        if !valid_key(key) {
            return Err(format!("不能用這個名字存檔：{key}"));
        }
        match std::fs::remove_file(self.file(key)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("刪除失敗：{e}")),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_stay_inside_the_folder() {
        assert!(valid_key("drawings.BTC-USDT-SWAP") && valid_key("mas") && valid_key("store_version"));
        for bad in ["", "../x", "a/b", "a\\b", ".hidden", "C:x", "a b", &"k".repeat(101)] {
            assert!(!valid_key(bad), "{bad}");
        }
    }

    #[test]
    fn write_read_replace_remove() {
        let dir = std::env::temp_dir().join(format!("qtchart-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Store::new(dir.clone());
        assert!(s.load().unwrap().is_empty()); // no folder yet
        s.set("drawings.BTC-USDT-SWAP", "[1]").unwrap();
        s.set("drawings.BTC-USDT-SWAP", "[1,2]").unwrap(); // replaced whole
        s.set("instId", "\"ETH-USDT-SWAP\"").unwrap();
        std::fs::write(dir.join("notes.txt"), "not ours").unwrap();
        let all = s.load().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all["drawings.BTC-USDT-SWAP"], "[1,2]");
        assert!(!dir.join("drawings.BTC-USDT-SWAP.json.tmp").exists());
        assert!(s.set("../evil", "x").is_err());
        assert!(s.set("big", &"x".repeat(MAX_VALUE + 1)).is_err());
        s.remove("instId").unwrap();
        s.remove("instId").unwrap(); // already gone: fine
        assert_eq!(s.load().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
