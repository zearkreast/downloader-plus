//! Subtitles, fetched after the video and apart from it.
//!
//! A video may have come over the app's own connections, so the engine cannot
//! be asked for them along the way. One short engine run that downloads nothing
//! else serves both paths the same.
//!
//! They are an extra: anything that goes wrong here costs the subtitles, never
//! the video.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::model::SubtitleTrack;
use crate::providers::engine;
use crate::settings::Settings;
use crate::{log_info, process, tools};

/// A stuck host cannot hold a finished video back for longer than this.
const RUN_LIMIT: Duration = Duration::from_secs(60);

const EXTENSIONS: &[&str] = &["srt", "vtt", "ass", "ttml", "srv3", "json3"];

/// The track to fetch for a language: that one exactly, or else a form of it,
/// a person's ahead of a machine's. A list is asked for "en" before any of its
/// videos has been read, and one of them may only have "en-GB".
pub fn pick<'a>(tracks: &'a [SubtitleTrack], wanted: &str) -> Option<&'a SubtitleTrack> {
    fn base(language: &str) -> String {
        language.split('-').next().unwrap_or(language).to_ascii_lowercase()
    }
    let family = base(wanted);
    tracks.iter().find(|track| track.language == wanted).or_else(|| {
        tracks
            .iter()
            .filter(|track| base(&track.language) == family)
            .min_by_key(|track| track.automatic)
    })
}

pub struct FetchTarget<'a> {
    pub page: &'a str,
    pub language: &'a str,
    pub headers: &'a [(String, String)],
    /// The name is this, a dot, the language and the format.
    pub stem: &'a Path,
}

/// Fetch one track, and say where it landed.
pub async fn fetch(target: FetchTarget<'_>, settings: &Settings) -> Option<PathBuf> {
    let binary = tools::engine_path()?;
    let args = fetch_args(&target, engine::base_args(settings), tools::ffmpeg_location());
    engine::log_engine_invocation(&args);

    match tokio::time::timeout(RUN_LIMIT, process::run_tree(&binary, &args)).await {
        Ok(Ok(output)) if output.success() => {}
        Ok(Ok(output)) => log_info!("subtitles", "the engine refused them: {}", engine::classify_engine_error(&output.stderr)),
        Ok(Err(err)) => log_info!("subtitles", "the engine could not run: {err}"),
        Err(_) => log_info!("subtitles", "gave up after {} seconds", RUN_LIMIT.as_secs()),
    }
    written(target.stem)
}

fn fetch_args(target: &FetchTarget<'_>, base: Vec<String>, ffmpeg_location: Option<String>) -> Vec<String> {
    let mut args = base;
    args.extend(
        ["--skip-download", "--no-playlist", "--write-subs", "--write-auto-subs", "--sub-format", "srt/best"]
            .map(str::to_string),
    );
    args.push("--sub-langs".into());
    args.push(target.language.to_string());
    if let Some(location) = ffmpeg_location {
        // Only FFmpeg can convert, and without it the source's own format is
        // still a file a player can read.
        args.push("--convert-subs".into());
        args.push("srt".into());
        args.push("--ffmpeg-location".into());
        args.push(location);
    }
    args.push("-o".into());
    args.push(format!("{}.%(ext)s", target.stem.display()));
    args.extend(engine::header_args(target.headers));
    args.push(target.page.to_string());
    args
}

fn written(stem: &Path) -> Option<PathBuf> {
    let prefix = format!("{}.", stem.file_name()?.to_str()?);
    std::fs::read_dir(stem.parent()?)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            let named = path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(&prefix));
            let extension = path.extension().and_then(|extension| extension.to_str());
            named && extension.is_some_and(|extension| EXTENSIONS.contains(&extension))
        })
}

/// Where subtitles sit beside a video: a player finds `film.tr.srt` for
/// `film.mp4` by itself.
pub fn path_beside(video: &Path, subtitle: &Path, language: &str) -> Option<PathBuf> {
    let stem = video.file_stem()?.to_str()?;
    let extension = subtitle.extension()?.to_str()?;
    Some(video.with_file_name(format!("{stem}.{language}.{extension}")))
}

/// Move them there. Across volumes a rename fails, as it does for the video.
pub fn keep_beside(video: &Path, subtitle: &Path, language: &str) {
    let Some(target) = path_beside(video, subtitle, language) else {
        return;
    };
    if std::fs::rename(subtitle, &target).is_err() && std::fs::copy(subtitle, &target).is_ok() {
        let _ = std::fs::remove_file(subtitle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(language: &str, automatic: bool) -> SubtitleTrack {
        SubtitleTrack {
            language: language.into(),
            name: None,
            automatic,
        }
    }

    #[test]
    fn the_language_asked_for_is_taken_before_any_form_of_it() {
        let tracks = [track("en-GB", false), track("en", true), track("tr", false)];
        assert_eq!(pick(&tracks, "en").unwrap().language, "en");
        assert_eq!(pick(&tracks, "tr").unwrap().language, "tr");
        assert!(pick(&tracks, "de").is_none());
    }

    #[test]
    fn of_the_forms_of_a_language_a_person_comes_before_a_machine() {
        let tracks = [track("en-orig", true), track("en-GB", false), track("en-US", false)];
        assert_eq!(pick(&tracks, "en").unwrap().language, "en-GB");
        assert_eq!(pick(&[track("tr-TR", true)], "tr").unwrap().language, "tr-TR");
    }

    #[test]
    fn a_run_asks_for_subtitles_and_nothing_else() {
        let headers = vec![("Referer".to_string(), "https://site.example/".to_string())];
        let target = FetchTarget {
            page: "https://site.example/watch/5",
            language: "tr",
            headers: &headers,
            stem: Path::new("temp/dl_1.subtitle"),
        };
        let args = fetch_args(&target, vec!["--ignore-config".into()], Some("tools".into()));
        let after = |flag: &str| {
            args.iter().position(|arg| arg == flag).and_then(|at| args.get(at + 1)).map(String::as_str)
        };

        assert!(args.iter().any(|arg| arg == "--skip-download"));
        assert!(args.iter().any(|arg| arg == "--write-subs"));
        assert!(args.iter().any(|arg| arg == "--write-auto-subs"));
        assert_eq!(after("--sub-langs"), Some("tr"));
        assert_eq!(after("--convert-subs"), Some("srt"));
        assert_eq!(after("--referer"), Some("https://site.example/"));
        assert!(after("-o").unwrap().ends_with("dl_1.subtitle.%(ext)s"));
        assert_eq!(args.last().map(String::as_str), Some("https://site.example/watch/5"));

        let plain = fetch_args(&target, Vec::new(), None);
        assert!(!plain.iter().any(|arg| arg == "--convert-subs"), "there is nothing to convert with");
    }

    #[test]
    fn subtitles_are_found_by_their_stem_and_named_for_the_video() {
        let dir = std::env::temp_dir().join(format!("ud-subtitles-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stem = dir.join("dl_1.subtitle");

        std::fs::write(dir.join("dl_1.v.mp4"), b"not this").unwrap();
        std::fs::write(dir.join("dl_1.subtitle.tr.srt"), b"1").unwrap();
        let found = written(&stem).unwrap();
        assert!(found.ends_with("dl_1.subtitle.tr.srt"));

        let video = dir.join("Film [1080p].mp4");
        assert_eq!(path_beside(&video, &found, "tr"), Some(dir.join("Film [1080p].tr.srt")));
        keep_beside(&video, &found, "tr");
        assert!(dir.join("Film [1080p].tr.srt").is_file());
        assert!(!found.exists());

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
