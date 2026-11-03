//! A stream read from the playlists the browser was given.
//!
//! Some players ask for their playlists with a token good for that one
//! request, so the address alone is a 404 to everyone after them: the app, the
//! engine, and the extension itself. The extension keeps what the player was
//! answered (see `extension/src/page-playlists.js`), and here that text becomes the
//! engine's input. `hls_media_playlist_data` on a format is read in place of
//! the format's address, so the engine asks for the segments and nothing else.
//!
//! The text comes from a page, so the engine is never given `--enable-file-urls`
//! to read it with. DRM is refused here as `engine` refuses it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use reqwest::Url;
use serde_json::{json, Map, Value};

use super::engine::UNNAMED_SITE;
use crate::error::{AppError, AppResult};
use crate::model::{CapturedPlaylist, SourceContext};
use crate::paths;

const VIDEO_CODECS: &[&str] = &["avc", "hvc", "hev", "av01", "vp0", "dvh"];

/// The description the engine reads instead of a link, gone with its run: it
/// holds the stream's tokens, and a retry writes a new one.
pub struct InfoFile(PathBuf);

impl InfoFile {
    pub fn path(&self) -> &Path {
        &self.0
    }

    /// The engine ignores the link written after these, with a warning.
    pub fn args(&self) -> [String; 2] {
        ["--load-info-json".to_string(), self.0.to_string_lossy().into_owned()]
    }
}

impl Drop for InfoFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Write the description of `url` for the engine, when `source` holds
/// playlists that make one.
pub fn prepare(url: &str, source: &SourceContext) -> AppResult<Option<InfoFile>> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    let Some(info) = describe(url, source)? else {
        return Ok(None);
    };
    let dir = paths::cache_dir()?.join("captured");
    std::fs::create_dir_all(&dir)?;
    let name = format!(
        "{}-{}.info.json",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let path = dir.join(name);
    std::fs::write(&path, serde_json::to_vec(&info)?)?;
    Ok(Some(InfoFile(path)))
}

/// What the engine's own extractor would have reported for this stream, had
/// it been able to read it.
fn describe(url: &str, source: &SourceContext) -> AppResult<Option<Value>> {
    let lists = &source.playlists;
    if lists.is_empty() {
        return Ok(None);
    }
    if lists.iter().any(|list| is_protected(&list.text)) {
        return Err(AppError::Protected(UNNAMED_SITE.to_string()));
    }

    let headers: Map<String, Value> = source
        .headers()
        .into_iter()
        .map(|(name, value)| (name, Value::String(value)))
        .collect();
    let master = lists
        .iter()
        .find(|list| is_master(&list.text) && list.url == url)
        .or_else(|| lists.iter().find(|list| is_master(&list.text)));
    let streams = match master {
        Some(master) => from_master(master, lists),
        None => from_media_playlists(lists),
    };
    if streams.is_empty() {
        return Ok(None);
    }

    let duration = streams.iter().map(|stream| stream.seconds).fold(0.0, f64::max);
    let manifest_url = master.map_or(url, |master| master.url.as_str());
    let formats: Vec<Value> = streams
        .into_iter()
        .map(|stream| {
            let mut format = stream.fields;
            format.extend([
                ("url".to_string(), json!(stream.url)),
                ("manifest_url".to_string(), json!(manifest_url)),
                ("protocol".to_string(), json!("m3u8_native")),
                ("hls_media_playlist_data".to_string(), json!(stream.text)),
                ("http_headers".to_string(), Value::Object(headers.clone())),
                // A host that checks for a browser turns the engine's own
                // requests away.
                ("impersonate".to_string(), json!(true)),
            ]);
            Value::Object(format)
        })
        .collect();

    Ok(Some(json!({
        "id": "stream",
        "title": "Video",
        "extractor": "generic",
        "extractor_key": "Generic",
        "webpage_url": url,
        "original_url": url,
        "duration": (duration > 0.0).then_some(duration),
        "formats": formats,
    })))
}

/// One media playlist, and what the engine is to be told about it.
struct Stream {
    url: String,
    text: String,
    seconds: f64,
    fields: Map<String, Value>,
}

impl Stream {
    fn new(list: &CapturedPlaylist, fields: Value) -> Self {
        Self {
            url: list.url.clone(),
            text: list.text.clone(),
            seconds: seconds_of(&list.text),
            fields: fields.as_object().cloned().unwrap_or_default(),
        }
    }
}

/// The renditions of `master` the player fetched. No one can ask for the others
/// now, whatever quality they promise.
fn from_master(master: &CapturedPlaylist, lists: &[CapturedPlaylist]) -> Vec<Stream> {
    let Ok(base) = Url::parse(&master.url) else {
        return Vec::new();
    };
    let held = |uri: &str| base.join(uri).ok().and_then(|wanted| find(lists, &wanted));

    let mut streams = Vec::new();
    let mut variant: Option<HashMap<String, String>> = None;
    for line in master.text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line.starts_with("#EXT-X-MEDIA:") {
            let attrs = attributes(line);
            if attrs.get("TYPE").map(String::as_str) != Some("AUDIO") {
                continue;
            }
            let Some(list) = attrs.get("URI").and_then(|uri| held(uri)) else {
                continue;
            };
            // The id goes through a format selector and the engine's console,
            // where a comma means something else and "Türkçe" is not UTF-8. The
            // name stays where it is only ever shown.
            streams.push(Stream::new(list, json!({
                "format_id": format!("audio-{}", streams.len()),
                "format_note": attrs.get("NAME").or_else(|| attrs.get("LANGUAGE")),
                "language": attrs.get("LANGUAGE"),
                "ext": "m4a",
                "vcodec": "none",
                "acodec": "mp4a.40.2",
            })));
        } else if line.starts_with("#EXT-X-STREAM-INF:") {
            variant = Some(attributes(line));
        } else if !line.starts_with('#') {
            let Some(attrs) = variant.take() else {
                continue;
            };
            let Some(list) = held(line) else {
                continue;
            };
            streams.push(Stream::new(list, variant_fields(&attrs)));
        }
    }
    streams
}

fn variant_fields(attrs: &HashMap<String, String>) -> Value {
    let bandwidth = attrs.get("BANDWIDTH").and_then(|value| value.parse::<f64>().ok());
    let size = attrs.get("RESOLUTION").and_then(|value| {
        let (width, height) = value.split_once(['x', 'X'])?;
        Some((width.parse::<u32>().ok()?, height.parse::<u32>().ok()?))
    });
    let codecs: Vec<&str> = attrs
        .get("CODECS")
        .map(|value| value.split(',').map(str::trim).collect())
        .unwrap_or_default();
    let video = codecs
        .iter()
        .find(|codec| VIDEO_CODECS.iter().any(|prefix| codec.starts_with(prefix)));
    let audio = codecs
        .iter()
        .find(|codec| !VIDEO_CODECS.iter().any(|prefix| codec.starts_with(prefix)));

    let height = size.map(|(_, height)| height);
    let label = height.map_or_else(
        || format!("{}k", bandwidth.unwrap_or(0.0) as u64 / 1000),
        |height| format!("{height}p"),
    );
    json!({
        "format_id": format!("video-{label}"),
        "ext": "mp4",
        "width": size.map(|(width, _)| width),
        "height": height,
        "tbr": bandwidth.map(|value| value / 1000.0),
        "fps": attrs.get("FRAME-RATE").and_then(|value| value.parse::<f64>().ok()),
        "vcodec": video,
        // Sound in a rendition of its own leaves this one without any.
        "acodec": if attrs.contains_key("AUDIO") { Some(&"none") } else { audio },
    })
}

/// Playlists with no master above them. Nothing says which is which but their
/// names, and only a pair needs telling apart.
fn from_media_playlists(lists: &[CapturedPlaylist]) -> Vec<Stream> {
    let is_audio = |list: &CapturedPlaylist| {
        Url::parse(&list.url)
            .ok()
            .and_then(|url| url.path_segments()?.next_back().map(str::to_ascii_lowercase))
            .is_some_and(|name| name.contains("audio"))
    };
    let paired = lists.iter().any(is_audio) && lists.iter().any(|list| !is_audio(list));
    lists
        .iter()
        .enumerate()
        .map(|(index, list)| {
            let fields = if is_audio(list) {
                json!({ "format_id": format!("audio-{index}"), "ext": "m4a", "vcodec": "none" })
            } else if paired {
                json!({ "format_id": format!("video-{index}"), "ext": "mp4", "acodec": "none" })
            } else {
                json!({ "format_id": format!("stream-{index}"), "ext": "mp4" })
            };
            Stream::new(list, fields)
        })
        .collect()
}

/// The playlist kept for `wanted`. A token a master puts in a variant's address
/// can differ from the one the player sent, so the path decides when the whole
/// address does not.
fn find<'a>(lists: &'a [CapturedPlaylist], wanted: &Url) -> Option<&'a CapturedPlaylist> {
    let parsed = || lists.iter().filter_map(|list| Some((list, Url::parse(&list.url).ok()?)));
    parsed()
        .find(|(_, url)| url == wanted)
        .or_else(|| {
            parsed().find(|(_, url)| {
                url.origin() == wanted.origin() && url.path() == wanted.path()
            })
        })
        .map(|(list, _)| list)
}

fn is_master(text: &str) -> bool {
    text.contains("#EXT-X-STREAM-INF:")
}

fn seconds_of(text: &str) -> f64 {
    text.lines()
        .filter_map(|line| line.trim().strip_prefix("#EXTINF:"))
        .filter_map(|rest| rest.split(',').next()?.trim().parse::<f64>().ok())
        .sum()
}

/// DRM, the counterpart of `drmKey` in extension/src/media.js. AES-128 is plain HLS:
/// its key is an ordinary request.
fn is_protected(text: &str) -> bool {
    text.lines()
        .map(str::trim)
        .filter(|line| line.starts_with("#EXT-X-KEY:") || line.starts_with("#EXT-X-SESSION-KEY:"))
        .any(|line| {
            let attrs = attributes(line);
            let method = attrs.get("METHOD").map(String::as_str).unwrap_or("NONE");
            let format = attrs.get("KEYFORMAT").map(String::as_str).unwrap_or("identity");
            !matches!(method.to_ascii_uppercase().as_str(), "NONE" | "AES-128")
                || !format.eq_ignore_ascii_case("identity")
        })
}

/// `NAME=value,NAME="value, with a comma"` after a tag's colon.
fn attributes(line: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut rest = line.split_once(':').map_or("", |(_, list)| list);
    while let Some((name, tail)) = rest.split_once('=') {
        let (value, after) = match tail.strip_prefix('"') {
            Some(quoted) => match quoted.split_once('"') {
                Some((value, after)) => (value, after.strip_prefix(',').unwrap_or(after)),
                None => (quoted, ""),
            },
            None => tail.split_once(',').unwrap_or((tail, "")),
        };
        out.insert(name.trim().to_string(), value.to_string());
        rest = after;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://cdn.example/manifests/abc";

    fn list(name: &str, text: &str) -> CapturedPlaylist {
        CapturedPlaylist { url: format!("{BASE}/{name}"), text: text.to_string() }
    }

    fn media(segment: &str) -> String {
        format!("#EXTM3U\n#EXTINF:4.0,\n{segment}1.ts\n#EXTINF:6.5,\n{segment}2.ts\n#EXT-X-ENDLIST\n")
    }

    fn master() -> String {
        [
            "#EXTM3U",
            r#"#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Türkçe, ana",LANGUAGE="tr",URI="tur~audio.txt?verify=1""#,
            r#"#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",URI="eng~audio.txt?verify=1""#,
            r#"#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,FRAME-RATE=24,CODECS="avc1.64001e,mp4a.40.2",AUDIO="a""#,
            "video~video.txt?verify=1",
            r#"#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="a""#,
            "hd~video.txt?verify=1",
        ]
        .join("\n")
    }

    fn source(playlists: Vec<CapturedPlaylist>) -> SourceContext {
        SourceContext {
            referer: Some("https://player.example/".into()),
            origin: Some("https://player.example".into()),
            user_agent: Some("Mozilla/5.0".into()),
            playlists,
            ..SourceContext::default()
        }
    }

    fn described(playlists: Vec<CapturedPlaylist>) -> Value {
        describe(&format!("{BASE}/master.txt?verify=1"), &source(playlists)).unwrap().unwrap()
    }

    fn ids(info: &Value) -> Vec<&str> {
        info["formats"].as_array().unwrap().iter().map(|f| f["format_id"].as_str().unwrap()).collect()
    }

    #[test]
    fn a_master_offers_only_the_renditions_the_player_fetched() {
        let info = described(vec![
            list("master.txt?verify=1", &master()),
            list("video~video.txt?verify=1", &media("v")),
            list("tur~audio.txt?verify=1", &media("a")),
        ]);
        assert_eq!(ids(&info), ["audio-0", "video-360p"]);
        assert_eq!(info["formats"][0]["format_note"], "Türkçe, ana");
        assert_eq!(info["duration"], 10.5);
        assert_eq!(info["webpage_url"], format!("{BASE}/master.txt?verify=1"));

        let audio = &info["formats"][0];
        assert_eq!(audio["vcodec"], "none");
        assert_eq!(audio["language"], "tr");
        let video = &info["formats"][1];
        assert_eq!(video["height"], 360);
        assert_eq!(video["tbr"], 900.0);
        assert_eq!(video["vcodec"], "avc1.64001e");
        assert_eq!(video["acodec"], "none");
    }

    #[test]
    fn every_format_carries_its_text_and_the_players_headers() {
        let info = described(vec![list("master.txt?verify=1", &master()), list("video~video.txt?verify=1", &media("v"))]);
        let video = &info["formats"][0];
        assert_eq!(video["protocol"], "m3u8_native");
        assert_eq!(video["url"], format!("{BASE}/video~video.txt?verify=1"));
        assert_eq!(video["manifest_url"], format!("{BASE}/master.txt?verify=1"));
        assert_eq!(video["hls_media_playlist_data"], media("v"));
        assert_eq!(video["http_headers"]["Referer"], "https://player.example/");
        assert_eq!(video["http_headers"]["Origin"], "https://player.example");
        assert_eq!(video["impersonate"], true);
    }

    #[test]
    fn a_variant_is_found_by_its_path_when_the_token_differs() {
        let info = described(vec![list("master.txt?verify=1", &master()), list("video~video.txt?verify=2", &media("v"))]);
        assert_eq!(ids(&info), ["video-360p"]);
    }

    #[test]
    fn a_rendition_with_its_sound_inside_keeps_it() {
        let text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS=\"avc1.64001e,mp4a.40.2\"\nv.txt\n";
        let info = described(vec![list("master.txt?verify=1", text), list("v.txt", &media("v"))]);
        assert_eq!(info["formats"][0]["acodec"], "mp4a.40.2");
    }

    #[test]
    fn a_pair_of_media_playlists_is_told_apart_by_name() {
        let info = described(vec![list("video~video.txt", &media("v")), list("tur~audio.txt", &media("a"))]);
        assert_eq!(info["formats"][0]["acodec"], "none");
        assert_eq!(info["formats"][1]["vcodec"], "none");
    }

    #[test]
    fn one_media_playlist_claims_nothing_about_its_streams() {
        let info = described(vec![list("index.txt", &media("v"))]);
        assert_eq!(ids(&info), ["stream-0"]);
        assert!(info["formats"][0].get("acodec").is_none());
    }

    #[test]
    fn a_master_with_nothing_fetched_behind_it_describes_nothing() {
        let found = describe(&format!("{BASE}/master.txt"), &source(vec![list("master.txt", &master())])).unwrap();
        assert!(found.is_none());
    }

    #[test]
    fn no_playlists_describe_nothing() {
        assert!(describe("https://cdn.example/a", &SourceContext::default()).unwrap().is_none());
    }

    #[test]
    fn drm_is_refused_and_plain_encryption_is_not() {
        for key in [
            r#"#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key""#,
            r#"#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT="com.widevine",URI="data:x""#,
            r#"#EXT-X-SESSION-KEY:METHOD=AES-128,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://key""#,
        ] {
            let text = format!("#EXTM3U\n{key}\n#EXTINF:4,\nv.ts\n");
            let err = describe("https://cdn.example/a", &source(vec![list("v.txt", &text)])).unwrap_err();
            assert_eq!(err.code(), "protected");
        }

        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4,\nv.ts\n";
        assert!(describe("https://cdn.example/a", &source(vec![list("v.txt", text)])).unwrap().is_some());
    }

    #[test]
    fn attributes_keep_commas_inside_quotes() {
        let attrs = attributes(r#"#EXT-X-MEDIA:TYPE=AUDIO,NAME="a, b",DEFAULT=YES"#);
        assert_eq!(attrs["TYPE"], "AUDIO");
        assert_eq!(attrs["NAME"], "a, b");
        assert_eq!(attrs["DEFAULT"], "YES");
    }

    #[test]
    fn the_file_is_gone_with_its_run() {
        let file = tempfile_like();
        let path = file.path().to_path_buf();
        assert!(path.exists());
        drop(file);
        assert!(!path.exists());
    }

    fn tempfile_like() -> InfoFile {
        let path = std::env::temp_dir().join(format!("ud-captured-test-{}", std::process::id()));
        std::fs::write(&path, b"{}").unwrap();
        InfoFile(path)
    }
}
