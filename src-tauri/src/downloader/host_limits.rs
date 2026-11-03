//! How many connections hosts have shown they accept.
//!
//! Some hosts answer too many connections by blocking the address outright, so
//! one that turned connections away is not asked for as many again. Forgotten
//! after a month: hosts change, and a limit learned on a bad day should not
//! last for good.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use crate::{log_info, log_warn, paths, util};

const KEEP_MS: i64 = 30 * 24 * 3_600_000;

/// Media hosts can be per-video, so what is kept has to stop somewhere.
const MOST_HOSTS: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limit {
    connections: u32,
    noted_at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Limits(BTreeMap<String, Limit>);

impl Limits {
    /// As many connections as are wanted, up to what `host` has shown it takes.
    pub fn allowed(&self, host: &str, wanted: u32, now_ms: i64) -> u32 {
        match self.0.get(host) {
            Some(limit) if now_ms - limit.noted_at < KEEP_MS => wanted.min(limit.connections),
            _ => wanted,
        }
    }

    /// Record that `host` served `worked` connections and refused the rest. A
    /// limit only ever comes down: one good day with few connections open
    /// says nothing about many. Says whether anything changed.
    pub fn note(&mut self, host: &str, worked: u32, now_ms: i64) -> bool {
        let worked = worked.max(1);
        self.0.retain(|_, limit| now_ms - limit.noted_at < KEEP_MS);
        if self.0.get(host).is_some_and(|limit| limit.connections <= worked) {
            return false;
        }
        self.0.insert(host.to_string(), Limit { connections: worked, noted_at: now_ms });
        while self.0.len() > MOST_HOSTS {
            let oldest = self.0.iter().min_by_key(|(_, limit)| limit.noted_at).map(|(host, _)| host.clone());
            match oldest {
                Some(host) => self.0.remove(&host),
                None => break,
            };
        }
        true
    }

    fn live(&self, now_ms: i64) -> usize {
        self.0.values().filter(|limit| now_ms - limit.noted_at < KEEP_MS).count()
    }
}

fn file() -> Option<PathBuf> {
    Some(paths::database_path().ok()?.with_file_name("host-limits.json"))
}

static SHARED: Lazy<Mutex<Limits>> = Lazy::new(|| {
    let kept = file()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok());
    Mutex::new(kept.unwrap_or_default())
});

fn save(limits: &Limits) {
    let Some(path) = file() else { return };
    let written = serde_json::to_vec(limits).map_err(|err| err.to_string()).and_then(|bytes| {
        std::fs::write(&path, bytes).map_err(|err| err.to_string())
    });
    if let Err(err) = written {
        log_warn!("downloader", "could not keep what hosts accept: {err}");
    }
}

fn host_of(url: &str) -> Option<String> {
    reqwest::Url::parse(url).ok()?.host_str().map(str::to_ascii_lowercase)
}

/// How many connections to open for `url`, of the `wanted` the settings allow.
pub fn allowed(url: &str, wanted: u32) -> u32 {
    let Some(host) = host_of(url) else {
        return wanted;
    };
    SHARED.lock().unwrap_or_else(|err| err.into_inner()).allowed(&host, wanted, util::now_ms())
}

pub fn note(url: &str, worked: u32) {
    let Some(host) = host_of(url) else { return };
    let mut limits = SHARED.lock().unwrap_or_else(|err| err.into_inner());
    if limits.note(&host, worked, util::now_ms()) {
        log_info!("downloader", "{host} takes {worked} connections; asking for no more from now on");
        save(&limits);
    }
}

/// How many hosts are being held to fewer connections.
pub fn count() -> u32 {
    SHARED.lock().unwrap_or_else(|err| err.into_inner()).live(util::now_ms()) as u32
}

pub fn forget_all() {
    let mut limits = SHARED.lock().unwrap_or_else(|err| err.into_inner());
    *limits = Limits::default();
    save(&limits);
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 24 * 3_600_000;

    #[test]
    fn a_host_is_asked_for_no_more_than_it_took() {
        let mut limits = Limits::default();
        assert_eq!(limits.allowed("cdn.example", 8, 0), 8);

        assert!(limits.note("cdn.example", 3, 0));
        assert_eq!(limits.allowed("cdn.example", 8, 0), 3);
        assert_eq!(limits.allowed("cdn.example", 2, 0), 2, "fewer were wanted anyway");
        assert_eq!(limits.allowed("other.example", 8, 0), 8);
    }

    #[test]
    fn a_limit_only_comes_down_and_never_to_nothing() {
        let mut limits = Limits::default();
        limits.note("cdn.example", 4, 0);
        assert!(!limits.note("cdn.example", 6, 0));
        assert_eq!(limits.allowed("cdn.example", 8, 0), 4);

        assert!(limits.note("cdn.example", 0, 0));
        assert_eq!(limits.allowed("cdn.example", 8, 0), 1);
    }

    #[test]
    fn a_month_on_the_host_is_given_another_chance() {
        let mut limits = Limits::default();
        limits.note("cdn.example", 2, 0);
        assert_eq!(limits.live(29 * DAY), 1);
        assert_eq!(limits.allowed("cdn.example", 8, 31 * DAY), 8);
        assert_eq!(limits.live(31 * DAY), 0);

        assert!(limits.note("cdn.example", 6, 31 * DAY), "the old limit no longer stands");
        assert_eq!(limits.allowed("cdn.example", 8, 31 * DAY), 6);
    }

    #[test]
    fn only_so_many_hosts_are_kept_and_the_oldest_goes_first() {
        let mut limits = Limits::default();
        for index in 0..=MOST_HOSTS as i64 {
            limits.note(&format!("h{index}.example"), 2, index);
        }
        assert_eq!(limits.live(1000), MOST_HOSTS);
        assert_eq!(limits.allowed("h0.example", 8, 1000), 8);
        assert_eq!(limits.allowed("h1.example", 8, 1000), 2);
    }

    #[test]
    fn limits_survive_being_written_out() {
        let mut limits = Limits::default();
        limits.note("cdn.example", 3, 5);
        let text = serde_json::to_string(&limits).unwrap();
        assert!(text.contains("cdn.example"), "{text}");
        let read: Limits = serde_json::from_str(&text).unwrap();
        assert_eq!(read.allowed("cdn.example", 8, 5), 3);
    }

    #[test]
    fn a_host_is_named_by_the_address_it_came_in() {
        assert_eq!(host_of("https://CDN.Example:8443/a.mp4?x=1").as_deref(), Some("cdn.example"));
        assert_eq!(host_of("not an address"), None);
    }
}
