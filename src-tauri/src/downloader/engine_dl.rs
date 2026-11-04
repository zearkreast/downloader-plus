//! Downloads that the engine has to perform itself.
//!
//! Used for segmented protocols (HLS, DASH) where a single ranged GET is not
//! enough -- the stream is a manifest plus hundreds of fragments. Rather than
//! reimplementing that, the work is handed to the engine and its progress is
//! read back through a machine-readable template, so the UI shows the same real
//! byte counts, speed and ETA as the native path.
//!
//! Pause is implemented as "stop the process": the engine keeps its `.part` and
//! fragment state, so resuming continues where it left off.
//!
//! A fetch of part of a link is the one thing here that is not that shape. The
//! engine hands that transfer to an FFmpeg of its own -- `--downloader native`
//! is accepted and then silently overridden -- which makes the real downloader
//! a grandchild, costs the progress readout entirely, and is why every run
//! started here is started as a family that can be killed as one.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};

use crate::downloader::control::TaskControl;
use crate::downloader::http::ProgressSample;
use crate::downloader::plan::KeptRange;
use crate::downloader::speed::SpeedTracker;
use crate::error::{AppError, AppResult};
use crate::providers::engine;
use crate::settings::Settings;
use crate::{bridge, log_debug, logging, process, tools};

/// A sentinel-prefixed, space-separated progress line. Parsing this is far more
/// robust than scraping the human-readable progress bar.
///
/// The last field names the format the line is about. A run that fetches two
/// formats counts each from zero, and without it the second one's first line
/// reads as the whole run going backwards.
const PROGRESS_TEMPLATE: &str = "download:@P %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s %(info.format_id)s";

pub struct EngineDownload<'a> {
    pub url: &'a str,
    pub format_selector: &'a str,
    pub target: &'a Path,
    /// Set when the engine is expected to merge two streams itself.
    pub merge_container: Option<&'a str>,
    /// Fetch only this much of the source. `None` is the whole of it.
    pub section: Option<KeptRange>,
    /// Re-encode around the cuts so the fetch begins on the frame that was
    /// asked for. Only means anything alongside a section.
    pub force_keyframes: bool,
    /// Request headers the source has to be asked with: the page and browser
    /// a handed-over link was playing in. Empty for everything else.
    pub headers: &'a [(String, String)],
    /// The page a handed-over link was playing on. The other-site session is
    /// lent by it as well as by the address (see `bridge::lends_other`).
    pub page_url: Option<&'a str>,
    /// The selector names two formats and only the sound of the second is
    /// wanted: it is a rendition with a picture of its own, the only place the
    /// source keeps its sound. See [`crate::downloader::plan::DownloadPlan::sound_from_muxed`].
    pub sound_from_second: bool,
    /// The engine reads this description of the stream instead of the link.
    /// See [`crate::providers::captured`].
    pub info_file: Option<&'a Path>,
}

/// Download once with nothing behind it, and -- only for a refusal a linked
/// browser might answer -- once more with that browser's session.
///
/// The gate is the same one `analyze` uses, for the same reason: a public video
/// is the overwhelmingly common case and must never cause the stored session to
/// be written to disk. `--continue` means the second attempt picks up whatever
/// the first managed to write, so nothing is downloaded twice.
///
/// The other-site session is the one exception, as it is in `analyze`: lent
/// to the first attempt of a link on the site İndir was just pressed on, and
/// never to a second.
pub async fn run(
    options: EngineDownload<'_>,
    settings: &Settings,
    control: Arc<TaskControl>,
    on_progress: &mut (dyn FnMut(ProgressSample) + Send),
) -> AppResult<u64> {
    let other = bridge::other_lease(settings, options.url, options.page_url);
    let other_jar = other
        .as_ref()
        .map(|lease| lease.path().to_string_lossy().into_owned());
    let first = attempt(&options, settings, &control, on_progress, other_jar.as_deref()).await;
    if let Some(lease) = &other {
        match &first {
            Ok(_) => lease.fold_back(),
            Err(err) => lease.refused(options.url, err),
        }
    }
    drop(other);
    let refusal = match first {
        Ok(size) => return Ok(size),
        Err(err) => err,
    };

    let Some(session) = engine::session_for(&refusal, options.url, settings) else {
        return Err(refusal);
    };

    let jar = session.path().to_string_lossy().into_owned();
    // A wall that stands with the session behind it is not the one that asked
    // for it: it is not offered again, and the user is told the account itself
    // was refused.
    let retried = attempt(&options, settings, &control, on_progress, Some(jar.as_str()))
        .await
        .map_err(AppError::after_session);

    // The engine rewrites the jar it was handed, carrying over whatever Google
    // rotated while the download ran; folding that back is what keeps the
    // session usable without the browser ever being opened again. Only after a
    // run that succeeded, though -- the jar a refused run leaves behind may be
    // a signed-out one, and storing that over a good session would break the
    // next download rather than help it. Failing to fold back costs freshness,
    // not this download, so it does not become the user's problem.
    if retried.is_ok() {
        session.fold_back();
    }

    retried
}

async fn attempt(
    options: &EngineDownload<'_>,
    settings: &Settings,
    control: &Arc<TaskControl>,
    on_progress: &mut (dyn FnMut(ProgressSample) + Send),
    cookies: Option<&str>,
) -> AppResult<u64> {
    let binary = tools::require_engine()?;

    // A section is fetched by FFmpeg, and the engine simply gives up if there
    // is none: "You have requested downloading the video partially, but ffmpeg
    // is not installed". Asking first turns that into the card the app already
    // knows how to draw, with the Install button on it.
    if options.section.is_some() {
        tools::require_ffmpeg()?;
    }
    clear_stale_part(options);

    let mut base = engine::base_args(settings);
    base.extend(transfer_args(settings, options.section.is_some()));
    let args = download_args(options, base, cookies);
    engine::log_engine_invocation(&args);

    let mut tree = process::spawn_tree(
        process::command(&binary)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    )?;

    let stdout = tree
        .child
        .stdout
        .take()
        .ok_or_else(|| AppError::Other("the engine produced no output stream".into()))?;
    let stderr = tree.child.stderr.take();

    // stderr is drained on its own task: a full pipe buffer would otherwise
    // deadlock the child while we are busy reading stdout. Each line is cut
    // down as it arrives, so the session can never be in the text that the
    // failure message is later built from.
    let stderr_handle = tokio::spawn(async move {
        let mut collected = Diagnostics::default();
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                collected.push(&logging::redact(&line));
            }
        }
        collected.into_text()
    });

    let mut reader = BufReader::new(stdout).lines();
    let mut last_sample: Option<ProgressSample> = None;
    let mut run_progress = RunProgress::default();
    let mut rate = Rate::new(fragments_on_disk(options.target));
    let mut finishing = Finishing::default();
    let mut last_emit = Instant::now();
    let mut poll = tokio::time::interval(Duration::from_millis(250));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let interrupted = loop {
        tokio::select! {
            line = reader.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        let parsed = parse_progress(&line)
                            .map(|sample| (sample, true))
                            .or_else(|| already_on_disk(&line).map(|sample| (sample, false)));
                        if let Some((sample, moving)) = parsed {
                            let mut sample = run_progress.fold(progress_part(&line), sample);
                            rate.read(&mut sample, moving, Instant::now());
                            // Rate-limit the emission, not the parsing: the
                            // engine can print several times a second.
                            if last_emit.elapsed() >= Duration::from_millis(400) {
                                on_progress(sample.clone());
                                last_emit = Instant::now();
                            }
                            last_sample = Some(sample);
                        } else if !line.trim().is_empty() {
                            log_debug!("engine-dl", "{}", logging::redact(line.trim()));
                            if finishing.read(&line) {
                                on_progress(finishing.sample(None));
                                last_emit = Instant::now();
                            }
                        }
                    }
                    Ok(None) => break false,
                    Err(err) => {
                        tree.kill().await;
                        return Err(AppError::Io(format!("could not read engine output: {err}")));
                    }
                }
            }
            // Polls the control flag even while the engine is quiet, so a pause
            // during a slow fragment does not wait for the next output line.
            _ = poll.tick() => {
                if control.interrupted() {
                    break true;
                }
                if last_emit.elapsed() >= Duration::from_millis(400) {
                    if let Some(percent) = finishing.measure() {
                        on_progress(finishing.sample(Some(percent)));
                        last_emit = Instant::now();
                    } else if let Some(sample) = last_sample.as_mut().filter(|_| !finishing.started) {
                        // A stalled transfer prints nothing, and its last
                        // rate would otherwise stay on screen throughout.
                        if rate.quiet(sample, Instant::now()) {
                            on_progress(sample.clone());
                            last_emit = Instant::now();
                        }
                    }
                }
            }
        }
    };

    if interrupted {
        // The whole family, not just the engine. A cancelled ranged fetch that
        // killed only the parent would leave the FFmpeg underneath it
        // downloading and writing to a file nobody is waiting for any more.
        tree.kill().await;
        stderr_handle.abort();
        return Err(AppError::Canceled);
    }

    let status = tree
        .child
        .wait()
        .await
        .map_err(|err| AppError::Other(format!("the engine did not exit cleanly: {err}")))?;
    let stderr_text = stderr_handle.await.unwrap_or_default();

    if !status.success() {
        if control.interrupted() {
            return Err(AppError::Canceled);
        }
        return Err(engine::naming_the_site(
            engine::classify_engine_error(&stderr_text),
            options.url,
        ));
    }

    // Not after a merge: the last transfer figure would put the bar back on
    // the download it has already moved past.
    if let Some(sample) = last_sample.filter(|_| !finishing.started) {
        on_progress(sample);
    }

    // The engine may have chosen a different extension (a merge to mkv, an
    // audio extraction). Find what it actually wrote.
    let written = resolve_output(options.target)?;
    let size = std::fs::metadata(&written).map(|m| m.len()).unwrap_or(0);
    Ok(size)
}

/// A fragmented stream (HLS, DASH) over as many connections as a download may
/// open. A section is fetched by FFmpeg, which takes no such option.
fn transfer_args(settings: &Settings, sectioned: bool) -> Vec<String> {
    let mut args = Vec::new();
    if sectioned {
        return args;
    }
    // The engine is outside the app's shared budget and limits each of its
    // connections, not the run. So one connection, on the share of the limit
    // that leaves room for as many runs as may be going at once.
    if settings.speed_limit_kb > 0 {
        let share = settings.speed_limit_kb / settings.max_concurrent_downloads.max(1);
        args.push("--limit-rate".into());
        args.push(format!("{}K", share.max(1)));
        return args;
    }
    let at_once = fragments_at_once(settings, sectioned);
    if at_once > 1 {
        args.push("--concurrent-fragments".into());
        args.push(at_once.to_string());
    }
    args
}

/// How many pieces of a fragmented stream a run fetches at once, as
/// `transfer_args` asks for them.
pub fn fragments_at_once(settings: &Settings, sectioned: bool) -> u32 {
    if sectioned || settings.speed_limit_kb > 0 || settings.low_resource_mode {
        return 1;
    }
    settings.connections_per_download.max(1)
}

/// Everything after the shared arguments: what to fetch, how much of it, and
/// where to put it.
///
/// Split out from the run so the vector can be read in a test. What goes on an
/// engine command line is most of what this module decides, and a flag that
/// quietly stopped being passed would show up as a download that is merely
/// slower or larger rather than as a failure.
fn download_args(
    options: &EngineDownload<'_>,
    base: Vec<String>,
    cookies: Option<&str>,
) -> Vec<String> {
    let mut args = base;

    args.push("--newline".into());
    args.push("--progress".into());
    args.push("--progress-template".into());
    args.push(PROGRESS_TEMPLATE.into());
    // The engine otherwise prints a line for every block it reads, many times
    // a second on a fast link, and on a phone formatting those in Python and
    // parsing them here is real work for lines that are mostly thrown away.
    // The yt-dlp this app installs has the option; a copy chosen by hand on
    // the desktop might not.
    #[cfg(target_os = "android")]
    {
        args.push("--progress-delta".into());
        args.push("0.5".into());
    }
    args.push("--no-playlist".into());

    match options.section {
        // The star is what makes this a time range rather than a pattern
        // matched against the chapter titles: without it, "0-10" is a regular
        // expression that matches no chapter and fetches nothing.
        Some(range) => {
            args.push("--download-sections".into());
            args.push(format!(
                "*{}-{}",
                timestamp(range.start_sec),
                timestamp(range.end_sec)
            ));
            // Resuming means nothing here. The transfer is an FFmpeg process
            // writing a fresh `.part` from the first byte, so `--continue`
            // cannot pick anything up -- and a half file left by an earlier
            // run of a different range would be a file of the wrong film.
            args.push("--no-continue".into());
            if options.force_keyframes {
                // Replaces the stream copy with a real re-encode so the cut
                // begins on the frame that was asked for rather than on the
                // keyframe before it. Roughly twice the time and a third more
                // bytes, which is why it is a choice and not the default.
                args.push("--force-keyframes-at-cuts".into());
            }
        }
        // Resume whatever a previous run left behind.
        None => args.push("--continue".into()),
    }

    args.push("-f".into());
    args.push(options.format_selector.to_string());
    args.push("-o".into());
    args.push(engine::output_template(options.target));

    if let Some(container) = options.merge_container {
        args.push("--merge-output-format".into());
        args.push(container.to_string());
    }

    if options.sound_from_second {
        // Without this the engine allows one picture per file and settles it
        // by dropping the second format outright: `V+M` comes back as `V`
        // alone, the silent file this flag exists to prevent (measured,
        // 2026.08.19).
        args.push("--video-multistreams".into());
        // With it, the engine's merger maps every picture of both inputs --
        // measured, `-map 0:v:0 -map 1:a:0 -map 1:v:0`, a file with the
        // second rendition's picture as a second video track. Its own output
        // arguments come after those maps, so a negative map there takes that
        // picture back out.
        //
        // Both this and the section below lean on the order in which this
        // engine lays out an FFmpeg command line, and the engine is updated
        // from its latest release underneath the app. Should that order ever
        // flip, the file gains a stray track rather than losing its sound; the
        // ignored TikTok test in tests/pipeline.rs is what notices.
        args.push("--ppa".into());
        args.push("Merger+ffmpeg_o:-map -1:v".into());
        if options.section.is_some() {
            // A section skips the merger: one FFmpeg reads both formats and
            // keeps the first stream of each (`-map 0:0 -map 1:0`). TikTok's
            // rendition happens to list its sound first; one that lists its
            // picture first arrived with two pictures and no sound. Whatever
            // was taken from the second input is replaced by its sound. Only
            // with a section: a single-format FFmpeg download has no input 1
            // to take it from.
            args.push("--downloader-args".into());
            args.push("ffmpeg_o:-map -1 -map 1:a:0".into());
        }
    }

    // Point the engine at the same FFmpeg the app manages, so it never picks up
    // a different copy from PATH.
    if let Some(location) = tools::ffmpeg_location() {
        args.push("--ffmpeg-location".into());
        args.push(location);
    }

    args.extend(engine::header_args(options.headers));

    if let Some(jar) = cookies {
        args.push("--cookies".into());
        args.push(jar.to_string());
    }

    if let Some(file) = options.info_file {
        args.push("--load-info-json".into());
        args.push(file.to_string_lossy().into_owned());
    }
    args.push(options.url.to_string());
    args
}

/// A mark as `--download-sections` reads it. Plain seconds with milliseconds,
/// which this engine parses alongside `MM:SS` and `HH:MM:SS`, and which cannot
/// be misread whatever the length of the film.
fn timestamp(seconds: f64) -> String {
    format!("{:.3}", seconds.max(0.0))
}

/// Take away a partial file a section fetch would neither resume nor replace.
///
/// A ranged transfer has no resumable state: FFmpeg writes a fresh `.part` from
/// its first byte, which is why `--no-continue` goes with the section. What is
/// left over from a run that was cancelled halfway is therefore never picked up
/// and never overwritten either -- it simply sits there, and on the next run of
/// a *different* range it is a half file of the wrong piece of the film under a
/// name that looks like this one's.
///
/// Every scratch file is looked for rather than one, because the name is not
/// always the one that was asked for: measured, a fetch written to `job.mp4`
/// whose streams merged into WebM leaves `job.mp4.webm.part` behind.
fn clear_stale_part(options: &EngineDownload<'_>) {
    if options.section.is_none() {
        return;
    }
    let (Some(dir), Some(name)) = (options.target.parent(), options.target.file_name()) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let name = name.to_string_lossy().into_owned();
    for entry in entries.flatten() {
        let found = entry.file_name().to_string_lossy().into_owned();
        if found.starts_with(&name) && found.ends_with(".part") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// What the engine had to say about a run, kept so that the part which explains
/// the failure survives however much else there is.
///
/// A plain capped buffer does not survive a ranged fetch. The transfer goes
/// through FFmpeg, whose banner is the first thing on the pipe and whose
/// `frame=` lines then arrive several times a second; the cap is reached long
/// before anything goes wrong, so the real `ERROR:` never gets stored and the
/// message the user is shown is the version number of FFmpeg.
#[derive(Default)]
struct Diagnostics {
    /// The first reported error, kept whole and kept regardless. This is the
    /// line the classification and the message are both built from.
    reported: Option<String>,
    /// The beginning of everything else, for the log.
    context: String,
}

impl Diagnostics {
    /// How much surrounding output is worth keeping. Enough to explain a
    /// failure that never says "ERROR:", small enough that a file producing a
    /// warning per frame cannot grow it without bound.
    const CONTEXT_LIMIT: usize = 8192;

    /// As much of one message as is worth reading. The engine's own errors are
    /// a sentence; anything far longer than this is a tool quoting a signed URL
    /// back at us.
    const LINE_LIMIT: usize = 2048;

    fn push(&mut self, line: &str) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }
        if self.reported.is_none()
            && (trimmed.starts_with("ERROR:") || trimmed.starts_with("error:"))
        {
            self.reported = Some(clipped(trimmed, Self::LINE_LIMIT));
            return;
        }
        // The remaining budget rather than the whole line. FFmpeg's status is
        // one line that it rewrites with carriage returns rather than newlines,
        // so a transfer of any length arrives here as a single line of
        // unbounded size -- measured, 6 KB of it in eight seconds.
        let room = Self::CONTEXT_LIMIT.saturating_sub(self.context.len());
        if room == 0 {
            return;
        }
        self.context.push_str(&clipped(trimmed, room));
        self.context.push('\n');
    }

    /// The reported error first, so that whoever reads this finds it whether
    /// they take the first line or search the whole text for a phrase.
    fn into_text(self) -> String {
        match self.reported {
            Some(reported) => format!("{reported}\n{}", self.context),
            None => self.context,
        }
    }
}

/// The first `limit` bytes of `text`, cut on a character rather than through
/// one. Slicing a string at a byte offset that lands inside a multi-byte
/// character panics, and a title in any language but English is full of them.
fn clipped(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let end = (0..=limit)
        .rev()
        .find(|index| text.is_char_boundary(*index))
        .unwrap_or(0);
    text[..end].to_owned()
}

/// yt-dlp writes to the requested path when it can, but a container change
/// leaves a sibling with a different extension.
pub fn resolve_output(target: &Path) -> AppResult<std::path::PathBuf> {
    if target.exists() {
        return Ok(target.to_path_buf());
    }

    let (Some(dir), Some(stem)) = (target.parent(), target.file_stem()) else {
        return Err(AppError::Io("the download produced no file".into()));
    };

    let mut best: Option<(std::path::PathBuf, std::time::SystemTime)> = None;
    for entry in std::fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.file_stem() != Some(stem) || !path.is_file() {
            continue;
        }
        // Skip the engine's own scratch files.
        if matches!(
            path.extension().and_then(|e| e.to_str()),
            Some("part") | Some("ytdl") | Some("temp")
        ) {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().is_none_or(|(_, best_time)| modified > *best_time) {
            best = Some((path, modified));
        }
    }

    best.map(|(path, _)| path)
        .ok_or_else(|| AppError::Io("the download produced no file".into()))
}

/// Parse one `@P` line. Every field may be the literal "NA" when the engine
/// does not know it yet, which is why each is parsed independently.
fn parse_progress(line: &str) -> Option<ProgressSample> {
    let rest = line.strip_prefix("@P")?.trim();
    let mut parts = rest.split_whitespace();

    let downloaded = parse_number(parts.next()?)? as u64;
    let total = parse_number(parts.next().unwrap_or("NA")).map(|value| value as u64);
    let estimate = parse_number(parts.next().unwrap_or("NA")).map(|value| value as u64);
    let speed = parse_number(parts.next().unwrap_or("NA")).unwrap_or(0.0);
    let eta = parse_number(parts.next().unwrap_or("NA"));

    let total = total.or(estimate).filter(|value| *value > 0);
    let percent = total.map(|total| (downloaded as f64 / total as f64 * 100.0).clamp(0.0, 100.0));

    Some(ProgressSample {
        received: downloaded,
        total,
        speed_bps: speed.max(0.0),
        eta_sec: eta.filter(|value| *value >= 0.0),
        percent,
        // A segmented download resumes by re-running the engine, which picks up
        // its own fragment state.
        resumable: true,
        segments: Vec::new(),
        finishing: false,
    })
}

/// Which of a run's formats an `@P` line is about: its last field. `None` for
/// a line that does not name one.
fn progress_part(line: &str) -> Option<&str> {
    line.strip_prefix("@P")?
        .split_whitespace()
        .nth(5)
        .filter(|part| *part != "NA")
}

/// A format the engine found complete on disk from an earlier run, which it
/// reports as a size with no count: `@P NA 36463968 NA NA NA bytevc1_...`.
///
/// Measured (2026.08.19) on a resumed two-format run. Read as nothing, the
/// finished first part never reached [`RunProgress`], and the bar counted the
/// second part alone against the size of both. Only a line that names its
/// format is read this way; the count is the size, since it is all there.
fn already_on_disk(line: &str) -> Option<ProgressSample> {
    let mut fields = line.strip_prefix("@P")?.split_whitespace();
    if fields.next()? != "NA" {
        return None;
    }
    let size = parse_number(fields.next()?)? as u64;
    progress_part(line)?;
    Some(ProgressSample {
        received: size,
        total: Some(size),
        speed_bps: 0.0,
        eta_sec: None,
        percent: Some(100.0),
        resumable: true,
        segments: Vec::new(),
        finishing: false,
    })
}

/// Progress across every file of a run, rather than each file's own.
///
/// A run that fetches two formats reports each from zero. Measured on a TikTok
/// video whose sound comes out of a second rendition the size of the first,
/// the bar stood at 49% when the picture finished and at 0% a moment later.
/// What the finished files came to is carried into the later ones' counts.
#[derive(Default)]
struct RunProgress {
    part: Option<String>,
    carried: u64,
    last_received: u64,
}

impl RunProgress {
    fn fold(&mut self, part: Option<&str>, mut sample: ProgressSample) -> ProgressSample {
        if let Some(part) = part {
            if self.part.as_deref() != Some(part) {
                if self.part.is_some() {
                    self.carried += self.last_received;
                }
                self.part = Some(part.to_string());
            }
        }
        self.last_received = sample.received;
        if self.carried == 0 {
            return sample;
        }
        sample.received += self.carried;
        sample.total = sample.total.map(|total| total + self.carried);
        sample.percent = sample
            .total
            .filter(|total| *total > 0)
            .map(|total| (sample.received as f64 / total as f64 * 100.0).clamp(0.0, 100.0));
        sample
    }
}

/// The run's speed, worked out from the bytes it reports and averaged as the
/// native path's is. The engine's own figure is the current request's, begun
/// again with each chunk and fragment, and swings with them.
struct Rate {
    tracker: Option<SpeedTracker>,
    last: u64,
    /// Bytes still to be read back from fragments an earlier run left half
    /// fetched. The engine counts them as it resumes each, in a burst that is
    /// no part of the speed (measured 2026-11-04: 9 MB in a third of a second,
    /// on a line that carries 3 MB in a second).
    owed: u64,
}

impl Rate {
    fn new(owed: u64) -> Self {
        Self { tracker: None, last: 0, owed }
    }

    /// `moving`: a transfer's reading, rather than a part found finished on
    /// disk.
    fn read(&mut self, sample: &mut ProgressSample, moving: bool, now: Instant) {
        let fresh = sample.received.saturating_sub(self.last);
        self.last = self.last.max(sample.received);
        match &mut self.tracker {
            // What a run starts from was on disk before it began.
            None => self.tracker = Some(SpeedTracker::new(sample.received)),
            Some(tracker) => {
                let owed = fresh.min(self.owed);
                self.owed -= owed;
                tracker.record_at(if moving { fresh - owed } else { 0 }, now);
            }
        }
        self.apply(sample);
    }

    /// Nothing heard for a while: true when that moved the readout.
    fn quiet(&mut self, sample: &mut ProgressSample, now: Instant) -> bool {
        let moved = self.tracker.as_mut().is_some_and(|tracker| tracker.record_at(0, now));
        if moved {
            self.apply(sample);
        }
        moved
    }

    fn apply(&self, sample: &mut ProgressSample) {
        let speed = self.tracker.as_ref().map_or(0.0, SpeedTracker::speed_bps);
        sample.speed_bps = speed;
        sample.eta_sec = sample
            .total
            .filter(|_| speed > 0.0)
            .map(|total| total.saturating_sub(sample.received) as f64 / speed);
    }
}

/// The bytes in the fragments an earlier run of `target` left half fetched:
/// `<stem>.….part-Frag<n>.part`, beside it.
fn fragments_on_disk(target: &Path) -> u64 {
    let (Some(dir), Some(stem)) = (target.parent(), target.file_stem().and_then(|stem| stem.to_str())) else {
        return 0;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let prefix = format!("{stem}.");
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(&prefix) && name.contains(".part-Frag"))
        })
        .filter_map(|entry| entry.metadata().ok())
        .map(|meta| meta.len())
        .sum()
}

/// What the engine does once its transfers are over: merge the formats it
/// fetched, or fix a file it wrote. Each step rewrites the whole download --
/// minutes for a film on a hard disk -- with nothing printed until it is done,
/// so how far it has got is read off the size of the file it is writing.
#[derive(Default)]
struct Finishing {
    started: bool,
    /// The files the engine wrote, in the order it named them.
    parts: Vec<PathBuf>,
    /// The file the current step is writing, and the bytes it reads from.
    writing: Option<(PathBuf, u64)>,
    last_percent: Option<f64>,
}

impl Finishing {
    /// Take in a line that is not a progress line. True when a step has just
    /// begun.
    fn read(&mut self, line: &str) -> bool {
        if let Some(part) = part_written(line) {
            self.parts.push(part);
            return false;
        }
        let Some((step, rest)) = post_step(line) else {
            return false;
        };
        self.started = true;
        self.last_percent = None;
        self.writing = quoted(rest).map(PathBuf::from).and_then(|file| {
            // A merge reads every part; a fix reads the file it rewrites.
            let read: u64 = if step == "Merger" {
                self.parts.iter().filter_map(|part| std::fs::metadata(part).ok()).map(|meta| meta.len()).sum()
            } else {
                std::fs::metadata(&file).ok()?.len()
            };
            (read > 0).then(|| (temp_name(&file), read))
        });
        true
    }

    /// How far the current step has got, when that has moved since last asked.
    fn measure(&mut self) -> Option<f64> {
        let (file, read) = self.writing.as_ref()?;
        let written = std::fs::metadata(file).ok()?.len();
        // Never the whole: the step is not over until the engine says so.
        let percent = (written as f64 / *read as f64 * 100.0).clamp(0.0, 99.0).floor();
        if self.last_percent == Some(percent) {
            return None;
        }
        self.last_percent = Some(percent);
        Some(percent)
    }

    fn sample(&self, percent: Option<f64>) -> ProgressSample {
        ProgressSample {
            percent,
            finishing: true,
            ..ProgressSample::default()
        }
    }
}

/// A file the engine has written or found already written:
/// `[download] Destination: <path>` or `[download] <path> has already been
/// downloaded`.
fn part_written(line: &str) -> Option<PathBuf> {
    let rest = line.strip_prefix("[download] ")?;
    let path = rest
        .strip_prefix("Destination: ")
        .or_else(|| rest.strip_suffix(" has already been downloaded"))?;
    (!path.trim().is_empty()).then(|| PathBuf::from(path.trim()))
}

/// The step a post-processing line announces, and what follows its tag:
/// `[Merger] Merging formats into "<path>"`, `[FixupM3u8] Fixing MPEG-TS in
/// MP4 container of "<path>"`.
fn post_step(line: &str) -> Option<(&str, &str)> {
    let (tag, rest) = line.strip_prefix('[')?.split_once("] ")?;
    let known = tag == "Merger"
        || tag.starts_with("Fixup")
        || matches!(tag, "VideoRemuxer" | "VideoConvertor" | "ExtractAudio");
    known.then_some((tag, rest))
}

/// The path a post-processing line names in double quotes.
fn quoted(text: &str) -> Option<&str> {
    let start = text.find('"')? + 1;
    let end = text.rfind('"')?;
    (end > start).then(|| &text[start..end])
}

/// Where the engine writes a step's output before it replaces the original:
/// `job.e.mp4` becomes `job.e.temp.mp4` (its `prepend_extension`).
fn temp_name(file: &Path) -> PathBuf {
    let stem = file.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
    match file.extension() {
        Some(extension) => file.with_file_name(format!("{stem}.temp.{}", extension.to_string_lossy())),
        None => file.with_file_name(format!("{stem}.temp")),
    }
}

fn parse_number(value: &str) -> Option<f64> {
    if value.is_empty() || value == "NA" || value == "None" {
        return None;
    }
    value.parse::<f64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn moved(received: u64) -> ProgressSample {
        ProgressSample { received, total: Some(100_000_000), ..Default::default() }
    }

    const STEP: Duration = Duration::from_millis(450);

    #[test]
    fn a_resumed_run_s_speed_leaves_out_the_fragments_it_reads_back() {
        // As measured: fragments finished by an earlier run, then 8 MB of
        // half-fetched ones counted within moments, then 3 MB/s.
        let start = Instant::now();
        let mut rate = Rate::new(8_000_000);
        rate.read(&mut moved(2_000_000), true, start);
        let mut burst = moved(10_000_000);
        rate.read(&mut burst, true, start + STEP);
        assert_eq!(burst.speed_bps, 0.0);

        let mut sample = moved(11_350_000);
        rate.read(&mut sample, true, start + STEP * 2);
        assert!((sample.speed_bps - 3_000_000.0).abs() < 1.0, "{}", sample.speed_bps);
        let eta = sample.eta_sec.unwrap();
        assert!((eta - 88_650_000.0 / 3_000_000.0).abs() < 0.01);
    }

    #[test]
    fn a_part_found_on_disk_and_a_quiet_engine_read_as_they_are() {
        let start = Instant::now();
        let mut rate = Rate::new(0);
        rate.read(&mut moved(0), true, start);
        let mut sample = moved(1_350_000);
        rate.read(&mut sample, true, start + STEP);

        // The other format, finished by an earlier run: no speed in it.
        let mut found = moved(51_350_000);
        rate.read(&mut found, false, start + STEP * 2);
        assert!(found.speed_bps < 3_000_000.0, "{}", found.speed_bps);

        // Then the engine goes quiet, and the readout comes down with it.
        let before = found.speed_bps;
        assert!(!rate.quiet(&mut found, start + STEP * 2 + Duration::from_millis(100)));
        assert!(rate.quiet(&mut found, start + STEP * 3));
        assert!(found.speed_bps < before && found.speed_bps > 0.0, "{}", found.speed_bps);
    }

    #[test]
    fn half_fetched_fragments_are_found_beside_the_target() {
        let dir = std::env::temp_dir().join(format!("ud-frags-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("task-7.mp4");
        for (name, size) in [
            ("task-7.mp4.part-Frag3.part", 1_000),
            ("task-7.f137.mp4.part-Frag9.part", 500),
            ("task-7.mp4.part", 9_000),
            ("task-70.mp4.part-Frag1.part", 7_000),
        ] {
            std::fs::write(dir.join(name), vec![0u8; size]).unwrap();
        }
        assert_eq!(fragments_on_disk(&target), 1_500);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_engine_s_own_lines_name_its_files_and_steps() {
        assert_eq!(part_written(r"[download] Destination: C:\t\job.e.fvideo-1080p.mp4"), Some(PathBuf::from(r"C:\t\job.e.fvideo-1080p.mp4")));
        assert_eq!(part_written(r"[download] C:\t\job.e.faudio.m4a has already been downloaded"), Some(PathBuf::from(r"C:\t\job.e.faudio.m4a")));
        assert_eq!(part_written("[download] 100% of 1.70GiB in 00:00:04"), None);

        let (step, rest) = post_step(r#"[Merger] Merging formats into "C:\t\job.e.mp4""#).unwrap();
        assert_eq!((step, quoted(rest)), ("Merger", Some(r"C:\t\job.e.mp4")));
        let (step, rest) = post_step(r#"[FixupM3u8] Fixing MPEG-TS in MP4 container of "C:\t\job.e.mp4""#).unwrap();
        assert_eq!((step, quoted(rest)), ("FixupM3u8", Some(r"C:\t\job.e.mp4")));
        assert!(post_step("[download] Destination: x").is_none());
        assert!(post_step("[info] Downloading 1 format(s)").is_none());

        assert_eq!(temp_name(Path::new(r"C:\t\job.e.mp4")), PathBuf::from(r"C:\t\job.e.temp.mp4"));
    }

    #[test]
    fn a_merge_is_measured_by_what_it_has_written_of_what_it_reads() {
        let dir = std::env::temp_dir().join(format!("ud-finishing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let video = dir.join("job.e.fvideo.mp4");
        let audio = dir.join("job.e.faudio.m4a");
        std::fs::write(&video, vec![0u8; 900]).unwrap();
        std::fs::write(&audio, vec![0u8; 100]).unwrap();

        let mut finishing = Finishing::default();
        assert!(!finishing.read(&format!("[download] Destination: {}", video.display())));
        assert!(!finishing.read(&format!("[download] Destination: {}", audio.display())));
        assert!(!finishing.started);
        assert!(finishing.read(&format!(r#"[Merger] Merging formats into "{}""#, dir.join("job.e.mp4").display())));
        assert!(finishing.started);

        // Nothing written yet is nothing to say.
        assert_eq!(finishing.measure(), None);
        std::fs::write(dir.join("job.e.temp.mp4"), vec![0u8; 250]).unwrap();
        assert_eq!(finishing.measure(), Some(25.0));
        assert_eq!(finishing.measure(), None, "an unchanged figure is not sent again");
        std::fs::write(dir.join("job.e.temp.mp4"), vec![0u8; 1200]).unwrap();
        assert_eq!(finishing.measure(), Some(99.0));

        let sample = finishing.sample(Some(25.0));
        assert!(sample.finishing);
        assert_eq!(sample.percent, Some(25.0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_step_with_nothing_to_measure_is_still_announced() {
        let mut finishing = Finishing::default();
        assert!(finishing.read("[VideoRemuxer] Remuxing video from mp4 to mkv; Destination: x.mkv"));
        assert_eq!(finishing.measure(), None);
    }

    #[test]
    fn a_limit_gives_each_run_one_connection_and_a_share() {
        let settings = Settings {
            connections_per_download: 8,
            max_concurrent_downloads: 3,
            ..Settings::default()
        };
        assert_eq!(transfer_args(&settings, false), ["--concurrent-fragments", "8"]);

        let limited = Settings { speed_limit_kb: 3000, ..settings.clone() };
        assert_eq!(transfer_args(&limited, false), ["--limit-rate", "1000K"]);
        assert!(transfer_args(&limited, true).is_empty(), "FFmpeg takes neither option");

        // What the detail window is told is what the engine was asked for.
        assert_eq!(fragments_at_once(&settings, false), 8);
        assert_eq!(fragments_at_once(&limited, false), 1);
        assert_eq!(fragments_at_once(&settings, true), 1);
        let light = Settings { low_resource_mode: true, ..settings.clone() };
        assert_eq!(fragments_at_once(&light, false), 1);
        assert!(transfer_args(&light, false).is_empty());
    }

    fn options(section: Option<KeptRange>, force_keyframes: bool) -> EngineDownload<'static> {
        EngineDownload {
            url: "https://example.test/watch?v=x",
            format_selector: "137+140",
            target: Path::new("C:\\temp\\job.e.mp4"),
            merge_container: Some("mp4"),
            section,
            force_keyframes,
            headers: &[],
            page_url: None,
            sound_from_second: false,
            info_file: None,
        }
    }

    #[test]
    fn a_description_of_the_stream_goes_ahead_of_the_link() {
        let file = Path::new("C:\\cache\\1.info.json");
        let options = EngineDownload { info_file: Some(file), ..options(None, false) };
        let args = download_args(&options, Vec::new(), None);
        let at = args.iter().position(|arg| arg == "--load-info-json").unwrap();
        assert_eq!(args[at + 1], "C:\\cache\\1.info.json");
        assert_eq!(args.last().unwrap(), options.url);
    }

    fn args_for(section: Option<KeptRange>, force_keyframes: bool) -> Vec<String> {
        download_args(&options(section, force_keyframes), Vec::new(), None)
    }

    fn value_after(args: &[String], key: &str) -> Option<String> {
        args.iter()
            .position(|arg| arg == key)
            .and_then(|index| args.get(index + 1).cloned())
    }

    fn range(start: f64, end: f64) -> KeptRange {
        KeptRange {
            start_sec: start,
            end_sec: end,
        }
    }

    #[test]
    fn a_section_is_asked_for_as_a_time_range_and_not_as_a_chapter() {
        let args = args_for(Some(range(30.0, 40.0)), false);
        // The star is the whole difference: without it this is a pattern
        // matched against chapter titles, and it matches none of them.
        assert_eq!(
            value_after(&args, "--download-sections").as_deref(),
            Some("*30.000-40.000")
        );
    }

    #[test]
    fn a_section_replaces_resuming_rather_than_joining_it() {
        let args = args_for(Some(range(30.0, 40.0)), false);
        assert!(args.iter().any(|arg| arg == "--no-continue"));
        assert!(
            !args.iter().any(|arg| arg == "--continue"),
            "a section is written from the first byte by an FFmpeg that has \
             nothing to resume"
        );
    }

    #[test]
    fn a_whole_download_still_resumes_and_asks_for_no_section() {
        let args = args_for(None, false);
        assert!(args.iter().any(|arg| arg == "--continue"));
        assert!(!args.iter().any(|arg| arg == "--no-continue"));
        assert!(!args.iter().any(|arg| arg == "--download-sections"));
    }

    #[test]
    fn an_exact_cut_is_only_asked_for_alongside_a_section() {
        assert!(args_for(Some(range(30.0, 40.0)), true)
            .iter()
            .any(|arg| arg == "--force-keyframes-at-cuts"));
        assert!(!args_for(Some(range(30.0, 40.0)), false)
            .iter()
            .any(|arg| arg == "--force-keyframes-at-cuts"));
        // Nothing to force keyframes at, so the flag would only cost a
        // re-encode of the whole video.
        assert!(!args_for(None, true)
            .iter()
            .any(|arg| arg == "--force-keyframes-at-cuts"));
    }

    #[test]
    fn a_mark_is_written_in_seconds_to_the_millisecond() {
        assert_eq!(timestamp(0.0), "0.000");
        assert_eq!(timestamp(4.8), "4.800");
        assert_eq!(timestamp(3661.25), "3661.250");
        // A mark that arrived below zero is the start of the file, not a
        // negative offset the engine would refuse to parse.
        assert_eq!(timestamp(-2.0), "0.000");
    }

    #[test]
    fn the_link_is_always_the_final_argument() {
        for section in [None, Some(range(30.0, 40.0))] {
            let args = args_for(section, true);
            assert_eq!(args.last().unwrap(), "https://example.test/watch?v=x");
        }
    }

    #[test]
    fn the_page_a_link_came_from_is_sent_and_the_link_stays_last() {
        let headers = vec![
            ("Referer".to_string(), "https://site.example/watch/5".to_string()),
            ("Origin".to_string(), "https://player.example".to_string()),
            ("User-Agent".to_string(), "Mozilla/5.0 (Windows NT 10.0)".to_string()),
        ];
        let mut options = options(None, false);
        options.headers = &headers;
        // A User-Agent from Settings arrives in the shared arguments first.
        let base = vec!["--add-header".to_string(), "User-Agent:from-settings".to_string()];
        let args = download_args(&options, base, Some("C:\\temp\\jar.txt"));

        assert_eq!(value_after(&args, "--referer").as_deref(), Some("https://site.example/watch/5"));
        let added: Vec<_> = args
            .iter()
            .enumerate()
            .filter(|(_, arg)| *arg == "--add-header")
            .filter_map(|(index, _)| args.get(index + 1).map(String::as_str))
            .collect();
        assert_eq!(
            added,
            ["User-Agent:from-settings", "Origin:https://player.example", "User-Agent:Mozilla/5.0 (Windows NT 10.0)"],
            "the browser's own agent has to come after the one from Settings to win"
        );
        assert_eq!(args.last().unwrap(), "https://example.test/watch?v=x");
    }

    #[test]
    fn a_session_is_only_passed_when_there_is_one_to_pass() {
        let args = download_args(&options(None, false), Vec::new(), Some("C:\\temp\\jar.txt"));
        assert_eq!(
            value_after(&args, "--cookies").as_deref(),
            Some("C:\\temp\\jar.txt")
        );
        assert!(!args_for(None, false).iter().any(|arg| arg == "--cookies"));
    }

    #[test]
    fn a_half_file_of_an_earlier_range_is_taken_away_before_a_new_one_starts() {
        let dir = std::env::temp_dir().join("ud-engine-part");
        let _ = std::fs::create_dir_all(&dir);
        let target = dir.join("job.e.mp4");

        // Both spellings the engine uses: the name as asked for, and the name
        // with the container it actually merged into appended.
        let plain = dir.join("job.e.mp4.part");
        let remuxed = dir.join("job.e.mp4.webm.part");
        let finished = dir.join("job.e.mp4.webm");
        for path in [&plain, &remuxed, &finished] {
            std::fs::write(path, b"half a film").unwrap();
        }

        let mut options = options(Some(range(30.0, 40.0)), false);
        options.target = &target;
        clear_stale_part(&options);

        assert!(!plain.exists());
        assert!(!remuxed.exists());
        assert!(
            finished.exists(),
            "a finished file is somebody's result, not scratch"
        );
        let _ = std::fs::remove_file(&finished);
    }

    #[test]
    fn a_whole_download_keeps_its_partial_file_to_resume_from() {
        let dir = std::env::temp_dir().join("ud-engine-part-kept");
        let _ = std::fs::create_dir_all(&dir);
        let target = dir.join("job.e.mp4");
        let part = dir.join("job.e.mp4.part");
        std::fs::write(&part, b"half a film").unwrap();

        let mut options = options(None, false);
        options.target = &target;
        clear_stale_part(&options);

        assert!(part.exists(), "this is exactly what --continue picks up");
        let _ = std::fs::remove_file(&part);
    }

    #[test]
    fn the_reported_error_survives_a_flood_of_frame_lines() {
        // What a ranged fetch actually puts on the pipe: FFmpeg's banner
        // first, then a line per frame for as long as it runs, and the one
        // line that explains the failure somewhere after the cap.
        let mut log = Diagnostics::default();
        log.push("ffmpeg version N-126740-g1234567 Copyright (c) 2000-2026");
        for index in 0..4000 {
            log.push(&format!(
                "frame= {index} fps=120 q=-1.0 size=  2048kB time=00:00:0{}.00 bitrate=N/A",
                index % 10
            ));
        }
        log.push("ERROR: unable to download video data: HTTP Error 403: Forbidden");

        let text = log.into_text();
        assert!(
            text.starts_with("ERROR: unable to download video data"),
            "the explanation has to be the first line, not the version number"
        );
        assert!(text.contains("403"));
        assert_eq!(engine::classify_engine_error(&text).code(), "forbidden");
    }

    #[test]
    fn one_endless_status_line_cannot_grow_the_buffer_without_bound() {
        // FFmpeg rewrites its status with carriage returns rather than
        // newlines, so however long the transfer runs it is one line here.
        let mut log = Diagnostics::default();
        log.push(&"frame= 1 fps=45 size= 256KiB\r".repeat(4000));
        log.push("ERROR: unable to download video data: HTTP Error 403: Forbidden");
        let text = log.into_text();
        assert!(text.starts_with("ERROR: unable to download"));
        assert!(text.len() < 16_384, "{} bytes", text.len());
    }

    #[test]
    fn a_line_is_never_cut_through_a_character() {
        // A title in any language but English is full of multi-byte
        // characters, and slicing one in half is a panic rather than a
        // truncated message.
        let text = "é".repeat(100);
        for limit in 0..=200 {
            let cut = clipped(&text, limit);
            assert!(cut.len() <= limit);
            assert!(text.starts_with(&cut));
        }
    }

    #[test]
    fn the_first_reported_error_is_the_one_that_is_kept() {
        let mut log = Diagnostics::default();
        log.push("ERROR: unable to download video data: HTTP Error 403: Forbidden");
        log.push("ERROR: Postprocessing: Conversion failed");
        assert!(log.into_text().starts_with("ERROR: unable to download"));
    }

    #[test]
    fn a_failure_that_never_says_error_is_still_reported() {
        let mut log = Diagnostics::default();
        log.push("");
        log.push("  You have requested downloading the video partially, but ffmpeg is not installed. Aborting.  ");
        let text = log.into_text();
        assert_eq!(
            engine::classify_engine_error(&text).code(),
            "ffmpegMissing",
            "the one sentence a ranged fetch fails with has to survive"
        );
    }

    #[test]
    fn parses_a_complete_progress_line() {
        let sample = parse_progress("@P 1048576 10485760 NA 524288.0 18").unwrap();
        assert_eq!(sample.received, 1_048_576);
        assert_eq!(sample.total, Some(10_485_760));
        assert_eq!(sample.speed_bps, 524_288.0);
        assert_eq!(sample.eta_sec, Some(18.0));
        assert_eq!(sample.percent, Some(10.0));
    }

    #[test]
    fn falls_back_to_the_estimated_total() {
        let sample = parse_progress("@P 500 NA 1000 100.0 5").unwrap();
        assert_eq!(sample.total, Some(1000));
        assert_eq!(sample.percent, Some(50.0));
    }

    #[test]
    fn an_unknown_total_yields_no_percentage() {
        let sample = parse_progress("@P 500 NA NA NA NA").unwrap();
        assert_eq!(sample.total, None);
        assert_eq!(sample.percent, None);
        assert_eq!(sample.speed_bps, 0.0);
        assert_eq!(sample.eta_sec, None);
    }

    #[test]
    fn a_zero_total_is_treated_as_unknown() {
        let sample = parse_progress("@P 500 0 0 NA NA").unwrap();
        assert_eq!(sample.total, None);
    }

    #[test]
    fn non_progress_output_is_ignored() {
        assert!(parse_progress("[download] Destination: video.mp4").is_none());
        assert!(parse_progress("").is_none());
        assert!(parse_progress("@P").is_none());
    }

    fn borrowing(section: Option<KeptRange>) -> Vec<String> {
        let mut options = options(section, false);
        options.format_selector = "bytevc1_1080p_1511769-0+h264_720p_1207492-0";
        options.sound_from_second = true;
        download_args(&options, Vec::new(), None)
    }

    #[test]
    fn sound_out_of_a_second_rendition_keeps_one_picture_and_that_sound() {
        // Measured with yt-dlp 2026.08.19: without the first flag the second
        // format is dropped and the file is silent; without the second the
        // file carries both pictures.
        let args = borrowing(None);
        assert!(args.iter().any(|arg| arg == "--video-multistreams"));
        assert_eq!(value_after(&args, "--ppa").as_deref(), Some("Merger+ffmpeg_o:-map -1:v"));
        assert!(
            !args.iter().any(|arg| arg == "--downloader-args"),
            "a whole download goes through the merger, and a single-format FFmpeg \
             download handed `-map 1:a:0` would have no second input to take it from"
        );
        assert_eq!(args.last().unwrap(), "https://example.test/watch?v=x");
    }

    #[test]
    fn a_section_of_a_borrowed_sound_maps_the_sound_and_not_the_first_stream() {
        let args = borrowing(Some(range(10.0, 15.0)));
        assert_eq!(
            value_after(&args, "--downloader-args").as_deref(),
            Some("ffmpeg_o:-map -1 -map 1:a:0")
        );
        assert!(args.iter().any(|arg| arg == "--video-multistreams"));
        assert_eq!(args.last().unwrap(), "https://example.test/watch?v=x");
    }

    #[test]
    fn an_ordinary_merge_asks_for_none_of_it() {
        for section in [None, Some(range(10.0, 15.0))] {
            let args = args_for(section, false);
            for flag in ["--video-multistreams", "--ppa", "--downloader-args"] {
                assert!(!args.iter().any(|arg| arg == flag), "{flag}");
            }
        }
    }

    #[test]
    fn the_progress_line_names_the_format_it_is_about() {
        assert_eq!(
            progress_part("@P 1024 37655063 NA 97497.6 386 h264_720p_1207492-0"),
            Some("h264_720p_1207492-0")
        );
        // A line from before the field existed still parses, and names nothing.
        assert_eq!(progress_part("@P 1024 37655063 NA 97497.6 386"), None);
        assert!(parse_progress("@P 1024 37655063 NA 97497.6 386 h264_720p_1207492-0").is_some());
    }

    #[test]
    fn a_run_of_two_formats_never_goes_backwards() {
        // The run the engine reported for the TikTok video on 2026-10-08, cut
        // down to a few lines: the picture, then the rendition whose sound is
        // taken.
        let lines = [
            "@P 1024 36463968 NA NA NA bytevc1_1080p_1511769-0",
            "@P 18000000 36463968 NA 2.4e7 1 bytevc1_1080p_1511769-0",
            "@P 36463968 36463968 NA 2.4e7 0 bytevc1_1080p_1511769-0",
            "@P 1024 37655063 NA 97497.6 386 h264_720p_1207492-0",
            "@P 37655063 37655063 NA 2.4e7 0 h264_720p_1207492-0",
        ];
        let mut run = RunProgress::default();
        let mut previous = 0u64;
        let mut samples = Vec::new();
        for line in lines {
            let sample = run.fold(progress_part(line), parse_progress(line).unwrap());
            assert!(sample.received >= previous, "{line}: {} after {previous}", sample.received);
            previous = sample.received;
            samples.push(sample);
        }
        assert_eq!(samples[3].received, 36_463_968 + 1024);
        assert_eq!(samples[3].total, Some(36_463_968 + 37_655_063));
        assert_eq!(samples[4].received, 36_463_968 + 37_655_063);
        assert_eq!(samples[4].percent, Some(100.0));
    }

    #[test]
    fn a_single_format_run_is_reported_as_it_comes() {
        let mut run = RunProgress::default();
        let line = "@P 500 1000 NA 100.0 5 137";
        let sample = run.fold(progress_part(line), parse_progress(line).unwrap());
        assert_eq!(sample.received, 500);
        assert_eq!(sample.total, Some(1000));
        assert_eq!(sample.percent, Some(50.0));
    }

    #[test]
    fn a_resumed_run_counts_the_part_it_already_had() {
        // The lines the engine printed when the picture was already on disk.
        let lines = [
            "@P NA 36463968 NA NA NA bytevc1_1080p_1511769-1",
            "@P 1024 37655063 NA NA NA h264_720p_1207492-1",
            "@P 37655063 37655063 NA 2.2e7 NA h264_720p_1207492-1",
        ];
        let mut run = RunProgress::default();
        let samples: Vec<ProgressSample> = lines
            .iter()
            .map(|line| {
                let sample = parse_progress(line).or_else(|| already_on_disk(line)).unwrap();
                run.fold(progress_part(line), sample)
            })
            .collect();
        assert_eq!(samples[0].received, 36_463_968);
        assert_eq!(samples[1].received, 36_463_968 + 1024);
        assert_eq!(samples[2].received, 36_463_968 + 37_655_063);
        assert_eq!(samples[2].percent, Some(100.0));

        // Only a line that names its format, and only with a size in it.
        assert!(already_on_disk("@P NA 36463968 NA NA NA").is_none());
        assert!(already_on_disk("@P NA NA NA NA NA bytevc1_1080p_1511769-1").is_none());
        assert!(already_on_disk("@P 1024 37655063 NA NA NA h264_720p_1207492-1").is_none());
    }

    #[test]
    fn percent_is_clamped_when_the_total_was_underestimated() {
        let sample = parse_progress("@P 1200 1000 NA 1.0 0").unwrap();
        assert_eq!(sample.percent, Some(100.0));
    }

    #[test]
    fn connections_reach_the_engine() {
        let settings = Settings {
            connections_per_download: 8,
            low_resource_mode: false,
            ..Settings::default()
        };
        let args = transfer_args(&settings, false);
        assert_eq!(value_after(&args, "--concurrent-fragments").as_deref(), Some("8"));

        // A section is FFmpeg's to fetch, and FFmpeg takes no such option.
        assert!(transfer_args(&settings, true).is_empty());

        // One connection, or low-resource mode, says nothing at all.
        let single = Settings {
            connections_per_download: 1,
            ..Settings::default()
        };
        assert!(transfer_args(&single, false).is_empty());
        let frugal = Settings {
            connections_per_download: 8,
            low_resource_mode: true,
            ..Settings::default()
        };
        assert!(transfer_args(&frugal, false).is_empty());
    }
}
