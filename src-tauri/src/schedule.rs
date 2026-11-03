//! When the queue may run, and what happens once it has run out.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// How long a shutdown, a sleep or a quit can still be called off. The queue
/// runs out while nobody is looking, so this is the only warning there is.
pub const COUNTDOWN_SEC: u32 = 60;

/// What to do when nothing is left to download.
///
/// Never kept in the settings. A shutdown armed for tonight's queue and still
/// armed after next week's download would be a very bad surprise, so it lasts
/// until it fires or the app closes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AfterQueue {
    #[default]
    Nothing,
    Quit,
    Sleep,
    Shutdown,
}

/// Minutes past midnight of an `HH:MM`.
pub fn minute_of(text: &str) -> Option<u32> {
    let (hour, minute) = text.split_once(':')?;
    let (hour, minute): (u32, u32) = (hour.parse().ok()?, minute.parse().ok()?);
    (hour < 24 && minute < 60).then_some(hour * 60 + minute)
}

/// Whether `now` is in the window that opens at `start` and closes at `end`,
/// all in minutes past midnight. A window may run past midnight, and one that
/// closes as it opens is the whole day.
pub fn in_window(now: u32, start: u32, end: u32) -> bool {
    use std::cmp::Ordering;
    match start.cmp(&end) {
        Ordering::Equal => true,
        Ordering::Less => start <= now && now < end,
        Ordering::Greater => now >= start || now < end,
    }
}

/// The program and arguments that shut Windows down. No delay of its own: the
/// countdown has already run, and it runs where it can be called off.
pub fn shutdown_command() -> (&'static str, [&'static str; 3]) {
    ("shutdown.exe", ["/s", "/t", "0"])
}

/// Carry the action out. Tests never get here: the two that reach the system
/// are empty in a test build, so nothing in the suite can put this machine to
/// sleep or turn it off.
pub fn perform(app: &AppHandle, action: AfterQueue) {
    match action {
        AfterQueue::Nothing => {}
        AfterQueue::Quit => {
            #[cfg(desktop)]
            {
                use tauri::Manager;
                if let Some(state) = app.try_state::<crate::commands::AppState>() {
                    state.queue.shutdown();
                }
                app.exit(0);
            }
        }
        AfterQueue::Sleep => suspend(),
        AfterQueue::Shutdown => power_off(),
    }
    let _ = app;
}

#[cfg(all(windows, not(test)))]
fn suspend() {
    // Sleep rather than hibernate, and let anything that may refuse refuse.
    // Safety: takes plain flags and keeps nothing of them.
    unsafe {
        windows_sys::Win32::System::Power::SetSuspendState(0, 0, 0);
    }
}

#[cfg(all(windows, not(test)))]
fn power_off() {
    let (program, args) = shutdown_command();
    if let Err(err) = crate::process::command(std::path::Path::new(program)).args(args).spawn() {
        crate::log_error!("schedule", "could not start the shutdown: {err}");
    }
}

#[cfg(any(not(windows), test))]
fn suspend() {}

#[cfg(any(not(windows), test))]
fn power_off() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_are_read_or_refused() {
        assert_eq!(minute_of("00:00"), Some(0));
        assert_eq!(minute_of("02:30"), Some(150));
        assert_eq!(minute_of("23:59"), Some(1439));
        for wrong in ["24:00", "12:60", "12", "", "ab:cd", "-1:00"] {
            assert_eq!(minute_of(wrong), None, "{wrong}");
        }
    }

    #[test]
    fn a_window_inside_a_day_holds_its_start_and_not_its_end() {
        let (start, end) = (9 * 60, 17 * 60);
        assert!(in_window(start, start, end));
        assert!(in_window(end - 1, start, end));
        assert!(!in_window(end, start, end));
        assert!(!in_window(start - 1, start, end));
    }

    #[test]
    fn a_window_may_run_past_midnight() {
        let (start, end) = (23 * 60, 7 * 60);
        assert!(in_window(23 * 60 + 30, start, end));
        assert!(in_window(0, start, end));
        assert!(in_window(6 * 60 + 59, start, end));
        assert!(!in_window(7 * 60, start, end));
        assert!(!in_window(12 * 60, start, end));
    }

    #[test]
    fn a_window_that_closes_as_it_opens_is_the_whole_day() {
        assert!(in_window(0, 300, 300));
        assert!(in_window(1000, 300, 300));
    }

    #[test]
    fn the_action_is_read_as_the_interface_names_it() {
        assert_eq!(serde_json::from_str::<AfterQueue>("\"shutdown\"").unwrap(), AfterQueue::Shutdown);
        assert_eq!(serde_json::to_string(&AfterQueue::Nothing).unwrap(), "\"nothing\"");
        assert_eq!(AfterQueue::default(), AfterQueue::Nothing);
        assert!(serde_json::from_str::<AfterQueue>("\"reboot\"").is_err());
    }

    #[test]
    fn the_shutdown_is_asked_for_and_never_run_here() {
        assert_eq!(shutdown_command(), ("shutdown.exe", ["/s", "/t", "0"]));
    }
}
