import { create } from 'zustand';

import * as ipc from '@/services/ipc';
import type { DownloadTask, QueueOutlook } from '@/types';

interface QueueState {
  tasks: DownloadTask[];
  loaded: boolean;
  outlook: QueueOutlook;
  load: () => Promise<void>;
  replace: (tasks: DownloadTask[]) => void;
  setOutlook: (outlook: QueueOutlook) => void;
  applyProgress: (event: ipc.ProgressEvent) => void;
}

export const useQueueStore = create<QueueState>((set) => ({
  tasks: [],
  loaded: false,
  outlook: { heldUntil: null, after: 'nothing', countdown: null },

  load: async () => {
    const [tasks, outlook] = await Promise.all([ipc.listDownloads(), ipc.queueOutlook()]);
    set({ tasks, outlook, loaded: true });
  },

  replace: (tasks) => set({ tasks, loaded: true }),
  setOutlook: (outlook) => set({ outlook }),

  /**
   * Progress arrives several times a second per task. Only the affected row is
   * replaced, and the array identity is preserved when nothing matched, so a
   * stale event cannot force a re-render of the whole list.
   */
  applyProgress: (event) =>
    set((state) => {
      const index = state.tasks.findIndex((task) => task.id === event.id);
      if (index === -1) return state;

      const existing = state.tasks[index]!;
      const next = state.tasks.slice();
      next[index] = {
        ...existing,
        status: event.status,
        progress: event.progress,
        outputPath: event.outputPath ?? existing.outputPath,
        error: event.error,
      };
      return { tasks: next };
    }),
}));

const ACTIVE = new Set(['preparing', 'downloading', 'processing']);

export function selectActive(tasks: DownloadTask[]): DownloadTask[] {
  return tasks.filter((task) => ACTIVE.has(task.status));
}

export function selectFinished(tasks: DownloadTask[]): DownloadTask[] {
  return tasks.filter(
    (task) =>
      task.status === 'completed' || task.status === 'failed' || task.status === 'canceled',
  );
}

/** Count used by the sidebar badge and the tray tooltip. */
export function selectInFlightCount(tasks: DownloadTask[]): number {
  return tasks.filter((task) => ACTIVE.has(task.status) || task.status === 'queued').length;
}
