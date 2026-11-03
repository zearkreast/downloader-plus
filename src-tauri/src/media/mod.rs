//! Everything that runs FFmpeg over a file, or reads one for the editor.
//!
//! - [`ffmpeg`] builds and runs FFmpeg's command lines: merging the streams of a
//!   download, converting, and the editor's export passes. It decides nothing.
//! - [`converter`] converts files that are already on disk (the Convert screen).
//! - [`export`] keeps ranges of one file and joins them into one result (the
//!   editor's Export).
//! - [`range`] fetches only a piece of a link, so the editor can open it.
//! - [`editor_media`] reads the editor timeline's waveform and frame strip.

pub mod converter;
pub mod editor_media;
pub mod export;
pub mod ffmpeg;
pub mod range;
