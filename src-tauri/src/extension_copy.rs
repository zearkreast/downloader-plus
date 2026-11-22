//! The unpacked copy of the browser extension that the app keeps current.
//!
//! The full build is not in any store, so it is loaded unpacked, and a browser
//! reads an unpacked extension from its folder each time it starts it. The app
//! carries the same files as `extension-full.zip` and writes them to one folder
//! in its data directory at every launch: an extension loaded from there is
//! updated whenever the app is. The extension notices the new version through
//! the host's status and reloads itself (see `reloadIfUpdated` in
//! background.js).

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::paths;

#[cfg(not(target_os = "android"))]
static FILES: &[(&str, &[u8])] = include!(concat!(env!("OUT_DIR"), "/extension_files.rs"));
#[cfg(target_os = "android")]
static FILES: &[(&str, &[u8])] = &[];

/// The Firefox add-on as addons.mozilla.org signed it, when this build was
/// handed one (see `embed_firefox_addon` in build.rs). Release Firefox installs
/// nothing unsigned, so an unpacked folder is no use to it; this one file is.
#[cfg(not(target_os = "android"))]
static FIREFOX_XPI: Option<&[u8]> = include!(concat!(env!("OUT_DIR"), "/firefox_addon.rs"));
#[cfg(target_os = "android")]
static FIREFOX_XPI: Option<&[u8]> = None;

const FIREFOX_NAME: &str = "extension-firefox.xpi";

/// What the last sync wrote, so a file a later version drops is removed from
/// the folder. Kept beside it rather than in it: the folder holds only what
/// the browser loads.
const LIST_NAME: &str = "extension-files.json";

pub fn dir() -> AppResult<PathBuf> {
    Ok(paths::root()?.join("extension"))
}

/// Beside the Chromium folder rather than in it: that folder is the extension
/// a Chromium browser loads, file for file.
pub fn firefox_file() -> AppResult<PathBuf> {
    Ok(paths::root()?.join(FIREFOX_NAME))
}

/// Whether there is a signed add-on to offer: this build's, or one an earlier
/// build wrote, which Firefox will update by itself once installed.
pub fn firefox_on_disk() -> Option<PathBuf> {
    firefox_file().ok().filter(|path| path.is_file())
}

/// Write this build's signed add-on beside the folder, when it carries one and
/// the file there differs. Returns whether it wrote.
fn sync_firefox(target: &Path, bytes: Option<&[u8]>) -> AppResult<bool> {
    let Some(bytes) = bytes else { return Ok(false) };
    if std::fs::read(target).is_ok_and(|held| held == bytes) {
        return Ok(false);
    }
    let staged = target.with_extension("ud-new");
    std::fs::write(&staged, bytes)?;
    std::fs::rename(&staged, target)?;
    Ok(true)
}

fn version_of(manifest: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(manifest).ok()?;
    value.get("version")?.as_str().map(str::to_owned)
}

/// The version the app carries.
pub fn bundled_version() -> Option<String> {
    FILES
        .iter()
        .find(|(name, _)| *name == "manifest.json")
        .and_then(|(_, bytes)| version_of(bytes))
}

/// The version in the folder now, which is what a browser that loaded it will
/// run after its next reload.
pub fn version_on_disk() -> Option<String> {
    let manifest = std::fs::read(dir().ok()?.join("manifest.json")).ok()?;
    version_of(&manifest)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Synced {
    pub written: usize,
    pub removed: usize,
}

/// Bring the folder in line with the files the app carries. A file already
/// holding the right bytes is left alone, so a launch with nothing new writes
/// nothing. The manifest goes last: its version is what tells the extension
/// to reload, and it must not change before the files it describes.
pub fn sync() -> AppResult<Synced> {
    if FILES.is_empty() {
        return Err(AppError::Other("this build carries no extension".into()));
    }
    let root = dir()?;
    let mut synced = sync_into(&root, &paths::root()?.join(LIST_NAME), FILES)?;
    if sync_firefox(&firefox_file()?, FIREFOX_XPI)? {
        synced.written += 1;
    }
    Ok(synced)
}

fn sync_into(root: &Path, list: &Path, files: &[(&str, &[u8])]) -> AppResult<Synced> {
    std::fs::create_dir_all(root)?;
    let mut ordered: Vec<&(&str, &[u8])> = files.iter().collect();
    ordered.sort_by_key(|(name, _)| *name == "manifest.json");

    let mut synced = Synced::default();
    for (name, bytes) in ordered {
        let target = root.join(name);
        if std::fs::read(&target).is_ok_and(|held| held == *bytes) {
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Written beside and moved over, so a browser starting meanwhile never
        // reads half a script.
        let staged = target.with_extension("ud-new");
        std::fs::write(&staged, bytes)?;
        std::fs::rename(&staged, &target)?;
        synced.written += 1;
    }

    let now: Vec<&str> = files.iter().map(|(name, _)| *name).collect();
    let before: Vec<String> = std::fs::read(list)
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default();
    for gone in before.iter().filter(|name| !now.contains(&name.as_str())) {
        // Only a plain relative name from the list this wrote, never a way out
        // of the folder.
        if gone.split('/').any(|part| part.is_empty() || part == "..") || gone.contains('\\') {
            continue;
        }
        if std::fs::remove_file(root.join(gone)).is_ok() {
            synced.removed += 1;
        }
    }
    std::fs::write(list, serde_json::to_vec(&now)?)?;
    Ok(synced)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("ud-extension-copy-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn carries_the_extension_with_its_version() {
        assert!(FILES.iter().any(|(name, _)| *name == "background.js"));
        assert!(FILES.iter().any(|(name, _)| name.starts_with("_locales/")));
        assert!(!FILES.iter().any(|(name, _)| name.ends_with(".pem") || name.contains(".test.")));
        assert_eq!(bundled_version().as_deref(), Some(env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn writes_only_what_changed_and_removes_what_went() {
        let base = scratch("sync");
        let root = base.join("extension");
        let list = base.join("list.json");
        let first: &[(&str, &[u8])] = &[
            ("manifest.json", br#"{"version":"1.0.0"}"#),
            ("a.js", b"a"),
            ("icons/old.png", b"old"),
        ];
        assert_eq!(sync_into(&root, &list, first).unwrap(), Synced { written: 3, removed: 0 });
        assert_eq!(sync_into(&root, &list, first).unwrap(), Synced { written: 0, removed: 0 });

        let second: &[(&str, &[u8])] =
            &[("manifest.json", br#"{"version":"1.0.1"}"#), ("a.js", b"a")];
        assert_eq!(sync_into(&root, &list, second).unwrap(), Synced { written: 1, removed: 1 });
        assert!(!root.join("icons/old.png").exists());
        let manifest = std::fs::read(root.join("manifest.json")).unwrap();
        assert_eq!(manifest, br#"{"version":"1.0.1"}"#);
        assert!(!root.join("manifest.ud-new").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_signed_firefox_file_is_written_only_when_carried_and_changed() {
        let base = scratch("firefox");
        let target = base.join(FIREFOX_NAME);
        assert!(!sync_firefox(&target, None).unwrap());
        assert!(!target.exists());
        assert!(sync_firefox(&target, Some(b"signed 1")).unwrap());
        assert!(!sync_firefox(&target, Some(b"signed 1")).unwrap());
        assert!(sync_firefox(&target, Some(b"signed 2")).unwrap());
        assert_eq!(std::fs::read(&target).unwrap(), b"signed 2");
        // A build without one leaves the earlier file for Firefox to update.
        assert!(!sync_firefox(&target, None).unwrap());
        assert!(target.exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_listed_name_cannot_reach_out_of_the_folder() {
        let base = scratch("escape");
        let root = base.join("extension");
        let list = base.join("list.json");
        std::fs::write(base.join("keep.txt"), b"keep").unwrap();
        std::fs::write(&list, br#"["../keep.txt"]"#).unwrap();
        sync_into(&root, &list, &[("manifest.json", b"{}")]).unwrap();
        assert!(base.join("keep.txt").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
