use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    embed_commit();
    embed_extension();
    embed_firefox_addon();
    tauri_build::build()
}

/// List the browser extension's files for the app to carry, so it can keep an
/// unpacked copy current in its data folder. The same files as the full build
/// that `scripts/extension/pack.mjs --full` zips: everything in extension/src
/// but a stray key, zip or test.
fn embed_extension() {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../extension/src");
    let mut files = Vec::new();
    collect(&source, &mut files);
    files.sort();
    let mut out = String::from("&[\n");
    for file in &files {
        let name = file
            .strip_prefix(&source)
            .expect("listed under the source")
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        let path = file.display().to_string();
        out.push_str(&format!("    ({name:?}, include_bytes!({path:?}) as &[u8]),\n"));
    }
    out.push_str("]\n");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    let target = out_dir.join("extension_files.rs");
    std::fs::write(target, out).expect("OUT_DIR is writable");
    println!("cargo:rerun-if-changed={}", source.display());
}

/// The signed Firefox add-on, when the build was handed one: the release
/// workflow signs it with addons.mozilla.org and names the file in
/// `UD_FIREFOX_XPI`. A build without it carries none, and says so on the
/// Connection page. Named by a variable rather than looked for at a fixed path,
/// because a watched path that does not exist reruns this script every build.
fn embed_firefox_addon() {
    println!("cargo:rerun-if-env-changed=UD_FIREFOX_XPI");
    let file = std::env::var("UD_FIREFOX_XPI")
        .ok()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from);
    let body = match file {
        Some(path) => {
            assert!(
                path.is_file(),
                "UD_FIREFOX_XPI names {}, which is not a file",
                path.display()
            );
            println!("cargo:rerun-if-changed={}", path.display());
            format!("Some(include_bytes!({:?}) as &[u8])", path.display().to_string())
        }
        None => "None".to_string(),
    };
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"));
    std::fs::write(out_dir.join("firefox_addon.rs"), body).expect("OUT_DIR is writable");
}

fn collect(dir: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let left_out =
            matches!(name.as_str(), "key.pem" | ".gitignore" | ".DS_Store" | "Thumbs.db")
            || name.ends_with(".zip")
            || name.ends_with(".test.js")
            || name.ends_with(".test.mjs")
            || name.ends_with(".test.cjs");
        if left_out {
            continue;
        }
        if path.is_dir() {
            collect(&path, files);
        } else {
            files.push(path);
        }
    }
}

/// Record the commit this build was made from.
///
/// Releases carry no version number -- one rolling release is replaced in
/// place -- so the commit is what tells two builds apart. The app compares it
/// with the commit the release tag points at to learn whether a newer build
/// exists. A build made outside a git checkout records nothing and never
/// reports an update.
fn embed_commit() {
    let commit = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|text| text.trim().to_string())
        .filter(|sha| sha.len() == 40)
        .unwrap_or_default();
    println!("cargo:rustc-env=UD_BUILD_COMMIT={commit}");

    // A new commit has to rebuild this crate, or the old hash would be kept.
    // Cargo reruns a script on every build for a path that does not exist, so
    // only paths that do are named.
    let git = Path::new("../.git");
    let mut watched = vec![git.join("HEAD"), git.join("packed-refs")];
    if let Ok(head) = std::fs::read_to_string(git.join("HEAD")) {
        if let Some(reference) = head.trim().strip_prefix("ref: ") {
            watched.push(git.join(reference));
        }
    }
    for path in watched.iter().filter(|path| path.exists()) {
        println!("cargo:rerun-if-changed={}", path.display());
    }
}
