//! Saved data: settings, the drawings of each symbol, alerts, the background picture. One file per key in the
//! app's data folder (Windows: %APPDATA%\com.chainchen.qtchart\store), written the moment something changes,
//! through a temporary file and a rename, so a crash or a power cut leaves the old version or the new one,
//! never half of one. The page can only touch files in that folder, with plain names, up to a size limit.
//! 清除所有資料 deletes the folder (`wipe`); nothing is written after that until the app starts again.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const EXT: &str = "json";
const CLOSED: &str = "資料已清除，重新啟動後才會存檔";
/// The background picture is the largest value (well under 2 MB).
pub const MAX_VALUE: usize = 8 * 1024 * 1024;

pub struct Store {
    dir: PathBuf,
    /// Wiped: the page still holds the old values until the app has started again, so they are not saved.
    closed: AtomicBool,
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
        Self { dir, closed: AtomicBool::new(false) }
    }

    /// No more writes until the app starts again (it is about to be wiped).
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    /// Delete every saved value (the whole folder), then make it again with only `fresh` in it. Closed from now
    /// on. A file held for a moment by another program (a virus scanner) is tried again a few times.
    pub fn wipe(&self, fresh: &HashMap<String, String>) -> Result<(), String> {
        self.close();
        let mut tries = 0;
        loop {
            match std::fs::remove_dir_all(&self.dir) {
                Ok(()) => break,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(e) if tries >= 4 => return Err(format!("刪不掉存檔資料夾：{e}")),
                Err(_) => {
                    tries += 1;
                    std::thread::sleep(Duration::from_millis(250));
                }
            }
        }
        for (k, v) in fresh {
            self.write(k, v)?;
        }
        Ok(())
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
        if self.closed.load(Ordering::SeqCst) {
            return Err(CLOSED.into());
        }
        self.write(key, value)
    }

    fn write(&self, key: &str, value: &str) -> Result<(), String> {
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
        if self.closed.load(Ordering::SeqCst) {
            return Err(CLOSED.into());
        }
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

    #[test]
    fn wipe_leaves_only_the_fresh_values_and_no_more_writes() {
        let dir = std::env::temp_dir().join(format!("qtchart-wipe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Store::new(dir.clone());
        s.set("drawings.BTC-USDT-SWAP", "[1]").unwrap();
        s.set("mcp", "{}").unwrap();
        std::fs::write(dir.join("notes.txt"), "not ours").unwrap();
        s.wipe(&HashMap::from([("store_version".to_string(), "1".to_string())])).unwrap();
        let all = s.load().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all["store_version"], "1");
        assert!(!dir.join("notes.txt").exists());
        assert!(s.set("mcp", "{}").is_err() && s.remove("store_version").is_err());
        assert_eq!(s.load().unwrap().len(), 1);
        // nothing there to begin with: fine too
        let _ = std::fs::remove_dir_all(&dir);
        let t = Store::new(dir.clone());
        t.wipe(&HashMap::new()).unwrap();
        assert!(t.load().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
