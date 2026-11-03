import { getCurrentWindow, ProgressBarStatus } from '@tauri-apps/api/window';
import { useEffect, useMemo, useRef } from 'react';

import { translate } from '@/i18n';
import { summarizeActivity } from '@/lib/activity';
import { useQueueStore } from '@/stores/useQueueStore';

/**
 * The queue's progress on the window itself, where it can be seen with the
 * window behind others or down in the tray: the taskbar button fills as the
 * running downloads do, and the title -- what Alt+Tab and the taskbar's
 * preview show -- leads with the figure.
 *
 * Only told when what it shows would change, a whole percent at a time: the
 * queue ticks several times a second, and every tick an IPC call to repaint a
 * taskbar button no one could tell had moved.
 *
 * Every call is allowed to fail. Neither is anything the app depends on, and a
 * system without a taskbar has no progress bar to set.
 */
export function useTaskbarProgress(enabled: boolean) {
  const tasks = useQueueStore((state) => state.tasks);
  const activity = useMemo(() => summarizeActivity(tasks), [tasks]);
  const shown = useRef<string | null>(null);

  const running = activity.running > 0;
  const percent = activity.percent == null ? null : Math.floor(activity.percent);

  useEffect(() => {
    if (!enabled) return;
    const key = running ? `run:${percent ?? '?'}` : 'idle';
    if (shown.current === key) return;
    shown.current = key;

    const window = getCurrentWindow();
    const name = translate('app.fullName');
    if (running) {
      void window
        .setProgressBar(
          percent == null
            ? { status: ProgressBarStatus.Indeterminate }
            : { status: ProgressBarStatus.Normal, progress: percent },
        )
        .catch(() => {});
      void window.setTitle(percent == null ? name : `${percent}% · ${name}`).catch(() => {});
    } else {
      void window.setProgressBar({ status: ProgressBarStatus.None }).catch(() => {});
      void window.setTitle(name).catch(() => {});
    }
  }, [enabled, running, percent]);
}
