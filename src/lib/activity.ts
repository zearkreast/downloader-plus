import type { DownloadTask } from '@/types';

/**
 * Everything the queue is doing, as one reading: the sidebar's activity card,
 * the summary over the Downloads list and the taskbar button all show this,
 * so they can never disagree with one another.
 */
export interface Activity {
  /** Transferring, or being prepared or merged. */
  running: number;
  /** In the queue, waiting for a free slot. */
  waiting: number;
  paused: number;
  /** All the running transfers together, in bytes per second. */
  speedBps: number;
  /**
   * How far the running transfers have got together, 0..100: bytes over
   * bytes where their sizes are known, otherwise the plain mean of the
   * percentages they report. Null when none of them knows yet.
   */
  percent: number | null;
  /**
   * When the last of the running transfers should be done -- they run side
   * by side, so the longest is the one that decides. Null while none can say.
   */
  etaSec: number | null;
}

const RUNNING = new Set<DownloadTask['status']>(['preparing', 'downloading', 'processing']);

export function summarizeActivity(tasks: readonly DownloadTask[]): Activity {
  let running = 0;
  let waiting = 0;
  let paused = 0;
  let speedBps = 0;
  let received = 0;
  let total = 0;
  let percentSum = 0;
  let percentCount = 0;
  let etaSec: number | null = null;

  for (const task of tasks) {
    if (task.status === 'queued') waiting += 1;
    else if (task.status === 'paused') paused += 1;
    if (!RUNNING.has(task.status)) continue;

    running += 1;
    const { progress } = task;
    if (Number.isFinite(progress.speedBps) && progress.speedBps > 0) speedBps += progress.speedBps;

    if (progress.totalBytes != null && progress.totalBytes > 0) {
      received += Math.min(progress.receivedBytes, progress.totalBytes);
      total += progress.totalBytes;
    }
    if (progress.percent != null && Number.isFinite(progress.percent)) {
      percentSum += Math.min(100, Math.max(0, progress.percent));
      percentCount += 1;
    }
    if (progress.etaSec != null && Number.isFinite(progress.etaSec) && progress.etaSec >= 0) {
      etaSec = Math.max(etaSec ?? 0, progress.etaSec);
    }
  }

  const percent =
    total > 0 ? (received / total) * 100 : percentCount > 0 ? percentSum / percentCount : null;

  return { running, waiting, paused, speedBps, percent, etaSec };
}

/** Whether there is anything at all to report. */
export function isBusy(activity: Activity): boolean {
  return activity.running + activity.waiting > 0;
}
