//! The download queue.
//!
//! Owns task state, decides what runs when, and is the only place that emits
//! progress to the UI. A single scheduler task does the admitting; worker tasks
//! do the downloading. The task list is behind a plain mutex that is never held
//! across an await, so a slow download cannot block a UI query.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Timelike;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::db::Database;
use crate::downloader::control::{ControlState, TaskControl};
use crate::error::{AppError, AppResult};
use crate::model::{
    DownloadProgress, DownloadRequest, DownloadStage, DownloadStatus, DownloadTask, HistoryEntry,
    ProgressEvent,
};
use crate::schedule::{self, AfterQueue};
use crate::settings::Settings;
use crate::{downloader, log_error, log_info, util};

pub const EVENT_PROGRESS: &str = "download://progress";
pub const EVENT_CHANGED: &str = "download://changed";
pub const EVENT_OUTLOOK: &str = "download://outlook";

/// How often a queue with a schedule looks at the clock. Nothing else tells it
/// when the window opens or closes.
const CLOCK_TICK: Duration = Duration::from_secs(20);

/// What the queue is waiting for and what comes after it, for the interface.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueOutlook {
    /// When the schedule next lets the queue run, while it is keeping it back.
    pub held_until: Option<String>,
    pub after: AfterQueue,
    /// Seconds until `after` happens, once it has begun.
    pub countdown: Option<u32>,
}

/// What has been asked for once the queue runs out.
#[derive(Default)]
struct Ending {
    after: AfterQueue,
    seconds_left: Option<u32>,
    countdown: Option<tauri::async_runtime::JoinHandle<()>>,
}

pub struct QueueManager {
    app: AppHandle,
    db: Arc<Database>,
    settings: Arc<Mutex<Settings>>,
    tasks: Mutex<Vec<DownloadTask>>,
    controls: Mutex<HashMap<String, Arc<TaskControl>>>,
    running: AtomicU32,
    wake: Notify,
    /// Running tasks the schedule stopped, which go back to waiting rather
    /// than to paused.
    held: Mutex<HashSet<String>>,
    /// The user started the queue outside its hours, until it runs out.
    outside_hours: AtomicBool,
    ending: Mutex<Ending>,
}

impl QueueManager {
    pub fn new(app: AppHandle, db: Arc<Database>, settings: Arc<Mutex<Settings>>) -> Arc<Self> {
        Arc::new(Self {
            app,
            db,
            settings,
            tasks: Mutex::new(Vec::new()),
            controls: Mutex::new(HashMap::new()),
            running: AtomicU32::new(0),
            wake: Notify::new(),
            held: Mutex::new(HashSet::new()),
            outside_hours: AtomicBool::new(false),
            ending: Mutex::new(Ending::default()),
        })
    }

    fn settings(&self) -> Settings {
        self.settings
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    fn with_tasks<T>(&self, f: impl FnOnce(&mut Vec<DownloadTask>) -> T) -> T {
        let mut guard = self.tasks.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut guard)
    }

    pub fn list(&self) -> Vec<DownloadTask> {
        self.with_tasks(|tasks| tasks.clone())
    }

    pub fn active_count(&self) -> u32 {
        self.with_tasks(|tasks| {
            tasks.iter().filter(|task| task.status.is_active()).count() as u32
        })
    }

    pub fn queued_count(&self) -> u32 {
        self.with_tasks(|tasks| {
            tasks
                .iter()
                .filter(|task| task.status == DownloadStatus::Queued)
                .count() as u32
        })
    }

    // -- lifecycle ---------------------------------------------------------

    /// Restore whatever was in flight when the app last closed. Anything that
    /// was mid-download comes back paused rather than silently resuming: the
    /// user did not ask for network activity at startup. With a schedule on
    /// they did, and it goes back to waiting for its hours.
    pub fn restore(self: &Arc<Self>) {
        let Ok(mut restored) = self.db.queue_load() else {
            return;
        };

        let resting = if self.settings().schedule_enabled {
            DownloadStatus::Queued
        } else {
            DownloadStatus::Paused
        };
        for task in &mut restored {
            if task.status.is_active() || task.status == DownloadStatus::Queued {
                task.status = resting;
                task.progress.speed_bps = 0.0;
                task.progress.eta_sec = None;
            }
        }

        if restored.is_empty() {
            return;
        }
        log_info!("queue", "restored {} tasks", restored.len());
        self.with_tasks(|tasks| *tasks = restored);
        self.emit_changed();
    }

    pub fn enqueue(self: &Arc<Self>, request: DownloadRequest) -> DownloadTask {
        self.enqueue_at(request, util::now_ms())
    }

    /// Enqueue with the creation time supplied by the caller, so every item of
    /// one gallery carries the same one. Persisting and emitting between two
    /// pushes costs more than a millisecond, so letting each call stamp itself
    /// would spread an album over increasing times and the newest-first list on
    /// the Downloads screen would read the album backwards.
    pub fn enqueue_at(self: &Arc<Self>, request: DownloadRequest, created_at: i64) -> DownloadTask {
        let task = DownloadTask {
            id: util::new_id("dl"),
            url: request.url.clone(),
            title: request
                .title
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| request.url.clone()),
            platform: downloader::platform_of(&request),
            thumbnail_url: request.thumbnail_url.clone(),
            status: DownloadStatus::Queued,
            progress: DownloadProgress::default(),
            format_label: downloader::provisional_label(&request),
            output_path: None,
            error: None,
            created_at,
            started_at: None,
            completed_at: None,
            attempt: 0,
            request,
        };

        self.with_tasks(|tasks| tasks.push(task.clone()));
        self.persist();
        self.emit_changed();
        self.wake.notify_one();
        task
    }

    pub fn pause(self: &Arc<Self>, id: &str) {
        if let Some(control) = self.control_for(id) {
            control.pause();
        }
        // A task that has not started yet has no control handle, so its status
        // is set directly.
        self.update_task(id, |task| {
            if task.status == DownloadStatus::Queued {
                task.status = DownloadStatus::Paused;
            }
        });
        self.emit_changed();
    }

    pub fn resume(self: &Arc<Self>, id: &str) {
        self.update_task(id, |task| {
            if matches!(task.status, DownloadStatus::Paused | DownloadStatus::Failed) {
                task.status = DownloadStatus::Queued;
                task.error = None;
            }
        });
        self.persist();
        self.emit_changed();
        self.wake.notify_one();
    }

    pub fn cancel(self: &Arc<Self>, id: &str) {
        if let Some(control) = self.control_for(id) {
            control.cancel();
        }
        self.update_task(id, |task| {
            if !task.status.is_terminal() {
                task.status = DownloadStatus::Canceled;
                task.progress.speed_bps = 0.0;
                task.progress.eta_sec = None;
            }
        });
        downloader::cleanup_task_files(id);
        self.persist();
        self.emit_changed();
        self.wake.notify_one();
    }

    pub fn retry(self: &Arc<Self>, id: &str) {
        self.update_task(id, |task| {
            if task.status.is_terminal() {
                task.status = DownloadStatus::Queued;
                task.error = None;
                task.attempt = 0;
                task.progress = DownloadProgress::default();
            }
        });
        self.persist();
        self.emit_changed();
        self.wake.notify_one();
    }

    pub fn remove(self: &Arc<Self>, id: &str) {
        if let Some(control) = self.control_for(id) {
            control.cancel();
        }
        self.with_tasks(|tasks| tasks.retain(|task| task.id != id));
        self.controls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        downloader::cleanup_task_files(id);
        self.persist();
        self.emit_changed();
    }

    pub fn pause_all(self: &Arc<Self>) {
        let ids = self.with_tasks(|tasks| {
            tasks
                .iter_mut()
                .filter(|task| !task.status.is_terminal())
                .map(|task| {
                    if task.status == DownloadStatus::Queued {
                        task.status = DownloadStatus::Paused;
                    }
                    task.id.clone()
                })
                .collect::<Vec<_>>()
        });

        let controls = self.controls.lock().unwrap_or_else(|e| e.into_inner());
        for id in ids {
            if let Some(control) = controls.get(&id) {
                control.pause();
            }
        }
        drop(controls);
        self.emit_changed();
    }

    pub fn resume_all(self: &Arc<Self>) {
        self.with_tasks(|tasks| {
            for task in tasks.iter_mut() {
                if task.status == DownloadStatus::Paused {
                    task.status = DownloadStatus::Queued;
                    task.error = None;
                }
            }
        });
        self.persist();
        self.emit_changed();
        self.wake.notify_waiters();
        self.wake.notify_one();
    }

    pub fn clear_finished(self: &Arc<Self>) {
        let removed: Vec<String> = self.with_tasks(|tasks| {
            let mut removed = Vec::new();
            tasks.retain(|task| {
                if task.status.is_terminal() {
                    removed.push(task.id.clone());
                    false
                } else {
                    true
                }
            });
            removed
        });

        for id in &removed {
            downloader::cleanup_task_files(id);
        }
        self.persist();
        self.emit_changed();
    }

    /// Move a waiting task one place up or down among the other waiting tasks.
    ///
    /// The swap deliberately skips over running and finished tasks. The UI
    /// groups the queue by status, so swapping with a raw neighbour that sits in
    /// a different group would reorder the underlying list while appearing to do
    /// nothing at all.
    pub fn reorder(self: &Arc<Self>, id: &str, delta: i32) {
        let moved = self.with_tasks(|tasks| {
            let Some(index) = tasks.iter().position(|task| task.id == id) else {
                return false;
            };
            if !is_waiting(&tasks[index]) {
                return false;
            }

            let step: i32 = if delta < 0 { -1 } else { 1 };
            let mut cursor = index as i32 + step;
            while cursor >= 0 && (cursor as usize) < tasks.len() {
                if is_waiting(&tasks[cursor as usize]) {
                    tasks.swap(index, cursor as usize);
                    return true;
                }
                cursor += step;
            }
            false
        });

        if moved {
            self.persist();
            self.emit_changed();
        }
    }

    /// Apply an explicit order, used by drag and drop.
    pub fn set_order(self: &Arc<Self>, ids: &[String]) {
        self.with_tasks(|tasks| {
            let mut ordered: Vec<DownloadTask> = Vec::with_capacity(tasks.len());
            for id in ids {
                if let Some(index) = tasks.iter().position(|task| &task.id == id) {
                    ordered.push(tasks.remove(index));
                }
            }
            // Anything the caller did not mention keeps its relative position
            // at the end, so a stale id list cannot drop tasks.
            ordered.append(tasks);
            *tasks = ordered;
        });
        self.persist();
        self.emit_changed();
    }

    // -- scheduling --------------------------------------------------------

    /// Long-lived admission loop. Started once at app setup.
    pub fn spawn_scheduler(self: &Arc<Self>) {
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut was_open = None;
            loop {
                let settings = manager.settings();
                let open = manager.may_run(&settings);
                if was_open != Some(open) {
                    was_open = Some(open);
                    if !open {
                        manager.hold_running();
                    }
                    manager.emit_outlook();
                }

                let running = manager.running.load(Ordering::Acquire);
                if open && running < settings.max_concurrent_downloads {
                    if let Some(task) = manager.take_next_queued() {
                        manager.running.fetch_add(1, Ordering::AcqRel);
                        manager.spawn_worker(task);
                        // Loop again immediately: there may be another free slot.
                        continue;
                    }
                }

                if settings.schedule_enabled {
                    tokio::select! {
                        _ = manager.wake.notified() => {}
                        _ = tokio::time::sleep(CLOCK_TICK) => {}
                    }
                } else {
                    manager.wake.notified().await;
                }
            }
        });
    }

    fn may_run(&self, settings: &Settings) -> bool {
        let now = chrono::Local::now();
        let in_hours = settings.schedule_open(now.hour() * 60 + now.minute());
        // Its hours arriving is the queue's own again.
        if in_hours {
            self.outside_hours.store(false, Ordering::Release);
        }
        in_hours || self.outside_hours.load(Ordering::Acquire)
    }

    /// Stop what is running as the schedule closes. Its partial files stay,
    /// and it carries on when the hours come round again.
    fn hold_running(&self) {
        let running: Vec<String> = self.with_tasks(|tasks| {
            tasks.iter().filter(|task| task.status.is_active()).map(|task| task.id.clone()).collect()
        });
        let controls = self.controls.lock().unwrap_or_else(|e| e.into_inner());
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        for id in running {
            if let Some(control) = controls.get(&id) {
                control.pause();
                held.insert(id);
            }
        }
    }

    /// Settings were saved, and the schedule in them may be a new one.
    pub fn schedule_changed(&self) {
        self.emit_outlook();
        self.wake.notify_one();
    }

    /// Start the queue outside its hours.
    pub fn run_outside_schedule(&self) {
        self.outside_hours.store(true, Ordering::Release);
        self.schedule_changed();
    }

    pub fn outlook(&self) -> QueueOutlook {
        let settings = self.settings();
        let ending = self.ending.lock().unwrap_or_else(|e| e.into_inner());
        QueueOutlook {
            held_until: (!self.may_run(&settings)).then_some(settings.schedule_start),
            after: ending.after,
            countdown: ending.seconds_left,
        }
    }

    fn emit_outlook(&self) {
        let _ = self.app.emit(EVENT_OUTLOOK, self.outlook());
    }

    /// Say what to do once the queue runs out, or call it off.
    pub fn set_after(self: &Arc<Self>, after: AfterQueue) {
        {
            let mut ending = self.ending.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(countdown) = ending.countdown.take() {
                countdown.abort();
            }
            ending.seconds_left = None;
            ending.after = after;
        }
        self.emit_outlook();
    }

    /// Whether anything is left to run, the schedule's waiting tasks included.
    fn has_work(&self) -> bool {
        self.running.load(Ordering::Acquire) > 0
            || self.with_tasks(|tasks| {
                tasks.iter().any(|task| task.status == DownloadStatus::Queued || task.status.is_active())
            })
    }

    /// A worker has finished. If that was the last of the queue, start whatever
    /// was asked for after it.
    fn check_ran_out(self: &Arc<Self>) {
        if self.has_work() {
            return;
        }
        self.outside_hours.store(false, Ordering::Release);
        self.emit_outlook();

        let after = {
            let ending = self.ending.lock().unwrap_or_else(|e| e.into_inner());
            if ending.countdown.is_some() { AfterQueue::Nothing } else { ending.after }
        };
        if after == AfterQueue::Nothing {
            return;
        }

        let manager = Arc::clone(self);
        let countdown = tauri::async_runtime::spawn(async move {
            #[cfg(desktop)]
            crate::tray::show_main_window(&manager.app);
            crate::notify::queue_ending(&manager.app, &manager.settings(), after);

            for left in (1..=schedule::COUNTDOWN_SEC).rev() {
                manager.show_countdown(Some(left));
                tokio::time::sleep(Duration::from_secs(1)).await;
                // A new download means the queue had not run out after all.
                // What was asked for stands, for when it does.
                if manager.has_work() {
                    let mut ending = manager.ending.lock().unwrap_or_else(|e| e.into_inner());
                    ending.countdown = None;
                    ending.seconds_left = None;
                    drop(ending);
                    manager.emit_outlook();
                    return;
                }
            }

            *manager.ending.lock().unwrap_or_else(|e| e.into_inner()) = Ending::default();
            manager.emit_outlook();
            log_info!("queue", "the queue ran out; carrying out {after:?}");
            schedule::perform(&manager.app, after);
        });
        self.ending.lock().unwrap_or_else(|e| e.into_inner()).countdown = Some(countdown);
    }

    fn show_countdown(&self, left: Option<u32>) {
        self.ending.lock().unwrap_or_else(|e| e.into_inner()).seconds_left = left;
        self.emit_outlook();
    }

    fn take_next_queued(self: &Arc<Self>) -> Option<DownloadTask> {
        self.with_tasks(|tasks| {
            let task = tasks
                .iter_mut()
                .find(|task| task.status == DownloadStatus::Queued)?;
            task.status = DownloadStatus::Preparing;
            task.started_at = Some(util::now_ms());
            task.progress.stage = DownloadStage::Resolving;
            Some(task.clone())
        })
    }

    fn spawn_worker(self: &Arc<Self>, task: DownloadTask) {
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            manager.run_task(task).await;
            manager.running.fetch_sub(1, Ordering::AcqRel);
            manager.wake.notify_one();
            manager.check_ran_out();
        });
    }

    async fn run_task(self: &Arc<Self>, task: DownloadTask) {
        let control = TaskControl::shared();
        self.controls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(task.id.clone(), Arc::clone(&control));

        self.emit_changed();

        let settings = self.settings();
        let max_attempts = settings.auto_retry_count + 1;
        let mut attempt = 0u32;

        let outcome = loop {
            attempt += 1;
            self.update_task(&task.id, |current| {
                current.attempt = attempt;
                current.status = DownloadStatus::Downloading;
                current.error = None;
            });

            let mut sink = {
                let manager = Arc::clone(self);
                let id = task.id.clone();
                move |progress: DownloadProgress| {
                    manager.on_progress(&id, progress);
                }
            };

            let result = downloader::execute(
                &task.id,
                &task.request,
                &settings,
                Arc::clone(&control),
                &mut sink,
            )
            .await;

            match result {
                Ok(outcome) => break Ok(outcome),
                Err(AppError::Canceled) => break Err(AppError::Canceled),
                Err(err) => {
                    // Only retry things that can plausibly succeed next time,
                    // and never fight a user who is trying to stop the task.
                    if attempt >= max_attempts || !err.retryable() || control.interrupted() {
                        break Err(err);
                    }
                    log_info!(
                        "queue",
                        "task {} attempt {attempt} failed ({}), retrying",
                        task.id,
                        err.code()
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(
                        800 * u64::from(attempt.min(4)),
                    ))
                    .await;
                }
            }
        };

        self.controls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&task.id);

        match outcome {
            Ok(result) => self.complete(&task.id, result),
            Err(AppError::Canceled) => self.settle_interruption(&task.id, control.state()),
            Err(err) => {
                let err = crate::net::explain_failure(&self.app, err).await;
                self.fail(&task.id, err)
            }
        }
    }

    fn complete(self: &Arc<Self>, id: &str, outcome: downloader::DownloadOutcome) {
        let path = outcome.output_path.to_string_lossy().into_owned();
        let now = util::now_ms();

        let task = self.update_task(id, |task| {
            task.status = DownloadStatus::Completed;
            task.completed_at = Some(now);
            task.output_path = Some(path.clone());
            task.format_label = outcome.label.clone();
            task.title = outcome.metadata.title.clone();
            task.thumbnail_url = outcome
                .metadata
                .thumbnail_url
                .clone()
                .or_else(|| task.thumbnail_url.clone());
            task.progress.stage = DownloadStage::Done;
            task.progress.percent = Some(100.0);
            task.progress.speed_bps = 0.0;
            task.progress.eta_sec = None;
        });

        let entry = HistoryEntry {
            id: 0,
            url: outcome.metadata.canonical_url.clone(),
            title: outcome.metadata.title.clone(),
            platform: outcome.metadata.platform,
            thumbnail_url: outcome.metadata.thumbnail_url.clone(),
            file_path: path.clone(),
            file_exists: true,
            container: outcome.container.clone(),
            quality_label: outcome.quality_label.clone(),
            file_size: Some(outcome.file_size),
            created_at: now,
            status: "completed".to_string(),
            request: task.as_ref().map(|task| task.request.clone()),
        };
        if let Err(err) = self.db.history_insert(&entry) {
            log_error!("queue", "could not write history: {err}");
        }

        downloader::cleanup_task_files(id);
        self.persist();
        self.emit_task(id);
        self.emit_changed();
        #[cfg(target_os = "android")]
        crate::android::announce_media(&self.app, &path);
        crate::notify::download_complete(&self.app, &self.settings(), &entry);
    }

    fn fail(self: &Arc<Self>, id: &str, err: AppError) {
        let info = err.to_info();
        log_error!("queue", "task {id} failed: {err}");

        let task = self.update_task(id, |task| {
            task.status = DownloadStatus::Failed;
            task.error = Some(info.clone());
            task.completed_at = Some(util::now_ms());
            task.progress.speed_bps = 0.0;
            task.progress.eta_sec = None;
        });

        self.persist();
        self.emit_task(id);
        self.emit_changed();

        if let Some(task) = task {
            crate::notify::download_failed(&self.app, &self.settings(), &task.title, &info);
        }
    }

    /// A cancelled transfer could mean either "pause" or "stop"; the control
    /// flag is what says which.
    fn settle_interruption(self: &Arc<Self>, id: &str, state: ControlState) {
        let paused = state == ControlState::Paused;
        let held = self.held.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        self.update_task(id, |task| {
            task.status = interrupted_status(paused, held);
            task.progress.speed_bps = 0.0;
            task.progress.eta_sec = None;
        });

        if !paused {
            downloader::cleanup_task_files(id);
        }
        self.persist();
        self.emit_task(id);
        self.emit_changed();
    }

    fn on_progress(self: &Arc<Self>, id: &str, progress: DownloadProgress) {
        let updated = self.update_task(id, |task| {
            if task.status == DownloadStatus::Preparing || task.status == DownloadStatus::Downloading
            {
                task.status = match progress.stage {
                    DownloadStage::Merging | DownloadStage::Converting | DownloadStage::Finalizing => {
                        DownloadStatus::Processing
                    }
                    _ => DownloadStatus::Downloading,
                };
            }
            task.progress = progress.clone();
        });

        if let Some(task) = updated {
            // Progress is sent as its own lightweight event rather than a full
            // list refresh, so a running download does not re-render the queue.
            let _ = self.app.emit(
                EVENT_PROGRESS,
                ProgressEvent {
                    id: task.id,
                    status: task.status,
                    progress: task.progress,
                    output_path: task.output_path,
                    error: task.error,
                },
            );
        }
    }

    fn update_task(
        &self,
        id: &str,
        f: impl FnOnce(&mut DownloadTask),
    ) -> Option<DownloadTask> {
        self.with_tasks(|tasks| {
            let task = tasks.iter_mut().find(|task| task.id == id)?;
            f(task);
            Some(task.clone())
        })
    }

    fn control_for(&self, id: &str) -> Option<Arc<TaskControl>> {
        self.controls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    fn persist(&self) {
        let tasks = self.list();
        if let Err(err) = self.db.queue_replace(&tasks) {
            log_error!("queue", "could not persist the queue: {err}");
        }
    }

    fn emit_changed(&self) {
        let _ = self.app.emit(EVENT_CHANGED, self.list());
    }

    fn emit_task(&self, id: &str) {
        let Some(task) = self.with_tasks(|tasks| tasks.iter().find(|t| t.id == id).cloned()) else {
            return;
        };
        let _ = self.app.emit(
            EVENT_PROGRESS,
            ProgressEvent {
                id: task.id,
                status: task.status,
                progress: task.progress,
                output_path: task.output_path,
                error: task.error,
            },
        );
    }

    /// Stop everything on the way out, so no worker writes after shutdown.
    pub fn shutdown(&self) {
        let controls = self.controls.lock().unwrap_or_else(|e| e.into_inner());
        for control in controls.values() {
            control.pause();
        }
    }
}

/// What a stopped task becomes. A pause the schedule made is no pause of the
/// user's: it goes on waiting for its hours. A cancel beats either.
fn interrupted_status(paused: bool, held: bool) -> DownloadStatus {
    match (paused, held) {
        (true, true) => DownloadStatus::Queued,
        (true, false) => DownloadStatus::Paused,
        (false, _) => DownloadStatus::Canceled,
    }
}

/// Tasks the user can still reorder: everything not running and not finished.
fn is_waiting(task: &DownloadTask) -> bool {
    matches!(task.status, DownloadStatus::Queued | DownloadStatus::Paused)
}

pub fn require_task(manager: &QueueManager, id: &str) -> AppResult<DownloadTask> {
    manager
        .list()
        .into_iter()
        .find(|task| task.id == id)
        .ok_or_else(|| AppError::Other(format!("no queued download with id {id}")))
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DownloadMode, QualityPreference, WatermarkPreference};

    fn task(id: &str, status: DownloadStatus) -> DownloadTask {
        DownloadTask {
            id: id.to_string(),
            url: "https://example.test/x".into(),
            title: id.to_string(),
            platform: crate::model::PlatformId::Generic,
            thumbnail_url: None,
            status,
            progress: DownloadProgress::default(),
            format_label: "Best".into(),
            output_path: None,
            error: None,
            created_at: 0,
            started_at: None,
            completed_at: None,
            attempt: 0,
            request: DownloadRequest {
                url: "https://example.test/x".into(),
                mode: DownloadMode::Video,
                quality: QualityPreference::Best,
                video_format_id: None,
                audio_format_id: None,
                container: None,
                watermark: WatermarkPreference::Any,
                output_dir: None,
                title: None,
                thumbnail_url: None,
                platform: None,
                entry: None,
                audio_language: None,
                collection: None,
                subtitle_language: None,
                embed_subtitles: false,
                source: None,
            },
        }
    }

    #[test]
    fn what_the_schedule_stopped_goes_back_to_waiting() {
        assert_eq!(interrupted_status(true, true), DownloadStatus::Queued);
        assert_eq!(interrupted_status(true, false), DownloadStatus::Paused);
        assert_eq!(interrupted_status(false, true), DownloadStatus::Canceled);
        assert_eq!(interrupted_status(false, false), DownloadStatus::Canceled);
    }

    /// Mirrors `QueueManager::reorder`'s inner logic on a plain vector, so the
    /// ordering rules can be checked without an `AppHandle`.
    fn reorder(tasks: &mut [DownloadTask], id: &str, delta: i32) -> bool {
        let Some(index) = tasks.iter().position(|task| task.id == id) else {
            return false;
        };
        if !is_waiting(&tasks[index]) {
            return false;
        }
        let step: i32 = if delta < 0 { -1 } else { 1 };
        let mut cursor = index as i32 + step;
        while cursor >= 0 && (cursor as usize) < tasks.len() {
            if is_waiting(&tasks[cursor as usize]) {
                tasks.swap(index, cursor as usize);
                return true;
            }
            cursor += step;
        }
        false
    }

    fn ids(tasks: &[DownloadTask]) -> Vec<&str> {
        tasks.iter().map(|task| task.id.as_str()).collect()
    }

    #[test]
    fn moving_up_swaps_with_the_previous_waiting_task() {
        let mut tasks = vec![
            task("a", DownloadStatus::Queued),
            task("b", DownloadStatus::Queued),
        ];
        assert!(reorder(&mut tasks, "b", -1));
        assert_eq!(ids(&tasks), vec!["b", "a"]);
    }

    #[test]
    fn reordering_skips_over_running_and_finished_tasks() {
        // Without the skip this would swap "c" with the running task and the
        // grouped list would look unchanged.
        let mut tasks = vec![
            task("a", DownloadStatus::Queued),
            task("running", DownloadStatus::Downloading),
            task("done", DownloadStatus::Completed),
            task("c", DownloadStatus::Queued),
        ];
        assert!(reorder(&mut tasks, "c", -1));
        assert_eq!(ids(&tasks), vec!["c", "running", "done", "a"]);
    }

    #[test]
    fn a_task_at_the_edge_of_the_queue_does_not_move() {
        let mut tasks = vec![
            task("a", DownloadStatus::Queued),
            task("running", DownloadStatus::Downloading),
        ];
        assert!(!reorder(&mut tasks, "a", -1));
        assert!(!reorder(&mut tasks, "a", 1));
        assert_eq!(ids(&tasks), vec!["a", "running"]);
    }

    #[test]
    fn a_running_task_cannot_be_reordered() {
        let mut tasks = vec![
            task("a", DownloadStatus::Queued),
            task("running", DownloadStatus::Downloading),
            task("b", DownloadStatus::Queued),
        ];
        assert!(!reorder(&mut tasks, "running", -1));
        assert_eq!(ids(&tasks), vec!["a", "running", "b"]);
    }

    #[test]
    fn paused_tasks_are_reorderable_alongside_queued_ones() {
        let mut tasks = vec![
            task("a", DownloadStatus::Queued),
            task("b", DownloadStatus::Paused),
        ];
        assert!(reorder(&mut tasks, "b", -1));
        assert_eq!(ids(&tasks), vec!["b", "a"]);
    }
}
