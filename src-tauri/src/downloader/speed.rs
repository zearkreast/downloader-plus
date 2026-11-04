//! Speed and ETA smoothing.
//!
//! A raw "bytes since last tick" figure swings wildly -- TCP delivers in bursts,
//! and at a 100 ms sampling interval the number visibly flickers. Everything the
//! user sees comes from an exponential moving average over fixed-length windows,
//! which settles on a change of pace within seconds without jittering on a
//! steady one.

use std::time::{Duration, Instant};

/// How long the average remembers. A home line can stop dead for a few seconds
/// (measured 2026-11-04: plain single-connection reads stalled for up to four),
/// and a readout that fell to zero each time read as a download lurching along;
/// a change that lasts still shows within seconds.
const MEMORY: Duration = Duration::from_secs(3);

/// Samples shorter than this are folded into the next one, so a burst of small
/// chunks cannot produce an absurd instantaneous rate.
const WINDOW: Duration = Duration::from_millis(400);

/// A rate averaged over [`MEMORY`], from readings that come at any pace: each
/// weighs as much as the time it covers. Until that much time has gone by the
/// average is over what there is, so a new download's readout does not climb
/// slowly from zero; readings of nothing before the first data are no part of
/// it, as a connection's first moments bring none.
#[derive(Debug, Default, Clone)]
struct SmoothedRate {
    sum: f64,
    weight: f64,
}

impl SmoothedRate {
    /// A reading of `bps` that held for `over`.
    fn push(&mut self, bps: f64, over: Duration) {
        let bps = if bps.is_finite() { bps.max(0.0) } else { 0.0 };
        if self.weight == 0.0 && bps == 0.0 {
            return;
        }
        let fresh = 1.0 - (-over.as_secs_f64() / MEMORY.as_secs_f64()).exp();
        self.sum = fresh * bps + (1.0 - fresh) * self.sum;
        self.weight = fresh + (1.0 - fresh) * self.weight;
    }

    fn bps(&self) -> f64 {
        if self.weight > 0.0 {
            self.sum / self.weight
        } else {
            0.0
        }
    }
}

pub struct SpeedTracker {
    smoothed: SmoothedRate,
    window_bytes: u64,
    window_start: Instant,
    started: Instant,
    total_bytes: u64,
    /// Bytes already on disk when a resumed download started -- excluded from
    /// the rate so resuming does not report an instant gigabyte per second.
    baseline_bytes: u64,
}

impl SpeedTracker {
    pub fn new(baseline_bytes: u64) -> Self {
        let now = Instant::now();
        Self {
            smoothed: SmoothedRate::default(),
            window_bytes: 0,
            window_start: now,
            started: now,
            total_bytes: baseline_bytes,
            baseline_bytes,
        }
    }

    /// Record freshly received bytes. Returns true when a window closed, which
    /// is the signal to emit a progress update.
    pub fn record(&mut self, bytes: u64) -> bool {
        self.record_at(bytes, Instant::now())
    }

    pub(crate) fn record_at(&mut self, bytes: u64, now: Instant) -> bool {
        self.total_bytes += bytes;
        self.window_bytes += bytes;

        let elapsed = now.saturating_duration_since(self.window_start);
        if elapsed < WINDOW {
            return false;
        }

        let instant_bps = self.window_bytes as f64 / elapsed.as_secs_f64();
        self.smoothed.push(instant_bps, elapsed);

        self.window_bytes = 0;
        self.window_start = now;
        true
    }

    /// Called when a transfer stalls, so the readout decays toward zero rather
    /// than freezing at the last healthy rate.
    pub fn decay(&mut self) {
        let elapsed = self.window_start.elapsed();
        if elapsed >= WINDOW * 2 {
            self.smoothed.push(0.0, elapsed);
            self.window_start = Instant::now();
            self.window_bytes = 0;
        }
    }

    pub fn speed_bps(&self) -> f64 {
        let bps = self.smoothed.bps();
        if bps < 1.0 {
            0.0
        } else {
            bps
        }
    }

    pub fn received(&self) -> u64 {
        self.total_bytes
    }

    /// Average over the whole transfer. Used for the ETA once enough of the
    /// file has arrived, because it is steadier than the moving average.
    pub fn average_bps(&self) -> f64 {
        let elapsed = self.started.elapsed().as_secs_f64();
        if elapsed < 0.25 {
            return 0.0;
        }
        (self.total_bytes.saturating_sub(self.baseline_bytes)) as f64 / elapsed
    }

    pub fn eta_sec(&self, total: Option<u64>) -> Option<f64> {
        let total = total?;
        if total <= self.total_bytes {
            return Some(0.0);
        }
        let remaining = (total - self.total_bytes) as f64;

        // Blend the moving average with the overall average, weighting the
        // overall one more as the download progresses. Early on the moving
        // average is the only signal; later it is the noisier of the two.
        let progress = (self.total_bytes as f64 / total as f64).clamp(0.0, 1.0);
        let moving = self.speed_bps();
        let overall = self.average_bps();

        let rate = if overall <= 0.0 {
            moving
        } else if moving <= 0.0 {
            overall
        } else {
            moving * (1.0 - progress * 0.6) + overall * (progress * 0.6)
        };

        (rate > 1.0).then(|| remaining / rate)
    }

    pub fn percent(&self, total: Option<u64>) -> Option<f64> {
        let total = total?;
        if total == 0 {
            return None;
        }
        Some((self.total_bytes as f64 / total as f64 * 100.0).clamp(0.0, 100.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_window_closes_before_the_interval_elapses() {
        let mut tracker = SpeedTracker::new(0);
        assert!(!tracker.record(1024));
        assert_eq!(tracker.received(), 1024);
        assert_eq!(tracker.speed_bps(), 0.0);
    }

    #[test]
    fn a_closed_window_produces_a_rate() {
        let mut tracker = SpeedTracker::new(0);
        std::thread::sleep(WINDOW + Duration::from_millis(20));
        assert!(tracker.record(1_000_000));
        assert!(tracker.speed_bps() > 0.0);
    }

    #[test]
    fn resumed_bytes_are_excluded_from_the_average() {
        let tracker = SpeedTracker::new(5_000_000);
        assert_eq!(tracker.received(), 5_000_000);
        // Nothing new has arrived, so the overall rate must stay at zero rather
        // than crediting the pre-existing bytes to this session.
        assert_eq!(tracker.average_bps(), 0.0);
    }

    #[test]
    fn percent_needs_a_known_total() {
        let mut tracker = SpeedTracker::new(0);
        tracker.record(50);
        assert_eq!(tracker.percent(None), None);
        assert_eq!(tracker.percent(Some(200)), Some(25.0));
        assert_eq!(tracker.percent(Some(0)), None);
    }

    #[test]
    fn percent_is_clamped_when_a_source_understates_its_size() {
        let mut tracker = SpeedTracker::new(0);
        tracker.record(300);
        assert_eq!(tracker.percent(Some(200)), Some(100.0));
    }

    #[test]
    fn eta_is_none_without_a_total_or_a_rate() {
        let mut tracker = SpeedTracker::new(0);
        tracker.record(10);
        assert_eq!(tracker.eta_sec(None), None);
        assert_eq!(tracker.eta_sec(Some(1_000_000)), None);
    }

    #[test]
    fn eta_is_zero_once_the_total_is_reached() {
        let mut tracker = SpeedTracker::new(0);
        tracker.record(1000);
        assert_eq!(tracker.eta_sec(Some(1000)), Some(0.0));
    }

    /// What the readout says at the end of each half-second window, given the
    /// bytes each run of windows brought: `(bytes per window, windows)`.
    fn readout(runs: &[(u64, u32)]) -> Vec<f64> {
        let mut tracker = SpeedTracker::new(0);
        let mut at = tracker.window_start;
        let mut out = Vec::new();
        for &(bytes, windows) in runs {
            for _ in 0..windows {
                at += Duration::from_millis(500);
                assert!(tracker.record_at(bytes, at));
                out.push(tracker.speed_bps());
            }
        }
        out
    }

    #[test]
    fn a_two_second_stall_of_the_line_leaves_half_the_rate_showing() {
        // 3 MB/s for a while, two seconds of nothing, then 3 MB/s again.
        let shown = readout(&[(1_500_000, 30), (0, 4), (1_500_000, 6)]);
        let lowest = shown.iter().copied().fold(f64::MAX, f64::min);
        assert!(lowest >= 1_500_000.0, "fell to {lowest}");
        let after_three_seconds = *shown.last().unwrap();
        assert!(after_three_seconds >= 2_400_000.0, "only back to {after_three_seconds}");
    }

    #[test]
    fn a_lasting_change_of_pace_shows_within_seconds() {
        // 3 MB/s, then 1 MB/s for five seconds.
        let shown = readout(&[(1_500_000, 30), (500_000, 10)]);
        let settled = *shown.last().unwrap();
        assert!(settled <= 1_500_000.0, "still at {settled} five seconds in");
    }

    #[test]
    fn a_new_download_shows_its_rate_from_the_first_window() {
        // A first window with nothing in it -- the request on its way -- and
        // then 3 MB/s from the first window that brings anything.
        let shown = readout(&[(0, 1), (1_500_000, 3)]);
        assert_eq!(shown[0], 0.0);
        assert!(shown[1..].iter().all(|bps| (*bps - 3_000_000.0).abs() < 1.0), "{shown:?}");
    }

    #[test]
    fn a_stall_decays_the_reported_rate() {
        let mut tracker = SpeedTracker::new(0);
        std::thread::sleep(WINDOW + Duration::from_millis(20));
        tracker.record(1_000_000);
        let before = tracker.speed_bps();
        assert!(before > 0.0);

        std::thread::sleep(WINDOW * 2 + Duration::from_millis(20));
        tracker.decay();
        assert!(tracker.speed_bps() < before);
    }
}
