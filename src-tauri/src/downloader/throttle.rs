//! The speed limit.
//!
//! One budget for every connection of every download: what a limit protects is
//! the user's line, not one transfer. Each chunk that arrives books its share
//! of a single clock and waits for its turn, so the total stays on the rate
//! however many connections are reading.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;

use crate::downloader::control::TaskControl;

/// Idle time is not saved up past this, or a limit would open with a burst.
const BURST: Duration = Duration::from_millis(100);

/// How often a wait looks up to see whether it is still wanted.
const WAIT_STEP: Duration = Duration::from_millis(200);

pub struct Throttle {
    /// Bytes a second. Zero is no limit.
    rate: AtomicU64,
    next: Mutex<Instant>,
}

impl Throttle {
    pub fn new(bytes_per_sec: u64) -> Self {
        Self {
            rate: AtomicU64::new(bytes_per_sec),
            next: Mutex::new(Instant::now()),
        }
    }

    /// Change the limit, for the transfers already running too.
    pub fn set(&self, bytes_per_sec: u64) {
        self.rate.store(bytes_per_sec, Ordering::Relaxed);
        *self.next.lock().unwrap_or_else(|err| err.into_inner()) = Instant::now();
    }

    /// Take `bytes` of the budget, and say how long they have to wait for it.
    fn book(&self, bytes: usize, now: Instant) -> Duration {
        let rate = self.rate.load(Ordering::Relaxed);
        if rate == 0 {
            return Duration::ZERO;
        }
        let mut next = self.next.lock().unwrap_or_else(|err| err.into_inner());
        let earliest = now.checked_sub(BURST).unwrap_or(now);
        *next = (*next).max(earliest) + Duration::from_secs_f64(bytes as f64 / rate as f64);
        next.saturating_duration_since(now)
    }

    /// Wait out `bytes` of the budget. A pause or a cancel ends the wait.
    pub async fn pace(&self, bytes: usize, control: &TaskControl) {
        let mut left = self.book(bytes, Instant::now());
        while !left.is_zero() && !control.interrupted() {
            let step = left.min(WAIT_STEP);
            tokio::time::sleep(step).await;
            left -= step;
        }
    }
}

static SHARED: Lazy<Throttle> = Lazy::new(|| Throttle::new(0));

/// The budget every download of this run of the app draws on.
pub fn shared() -> &'static Throttle {
    &SHARED
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_limit_means_no_waiting() {
        let throttle = Throttle::new(0);
        assert_eq!(throttle.book(1 << 30, Instant::now()), Duration::ZERO);
    }

    #[test]
    fn every_reader_books_on_one_clock() {
        let throttle = Throttle::new(1000);
        let now = *throttle.next.lock().unwrap();
        assert_eq!(throttle.book(500, now), Duration::from_millis(500));
        assert_eq!(throttle.book(500, now), Duration::from_secs(1));
    }

    #[test]
    fn time_nobody_used_is_not_saved_up_past_a_moment() {
        let throttle = Throttle::new(1000);
        let later = *throttle.next.lock().unwrap() + Duration::from_secs(60);
        assert_eq!(throttle.book(100, later), Duration::ZERO, "inside the burst");
        assert!(throttle.book(1000, later) > Duration::from_millis(900));
    }

    #[test]
    fn a_new_limit_forgets_what_the_old_one_had_booked() {
        let throttle = Throttle::new(1);
        throttle.book(1 << 20, Instant::now());
        throttle.set(1 << 30);
        assert!(throttle.book(1024, Instant::now()) < Duration::from_millis(10));
    }

    #[tokio::test]
    async fn a_pause_ends_the_wait() {
        let throttle = Throttle::new(1);
        let control = TaskControl::new();
        control.pause();
        let started = Instant::now();
        throttle.pace(1 << 20, &control).await;
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
