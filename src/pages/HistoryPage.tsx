import { HistoryList } from '@/components/history/HistoryList';
import { useQueueStore } from '@/stores/useQueueStore';
import { QueueSection, queueHasRows } from './DownloadsPage';

/**
 * The desktop's History screen, which is its Downloads screen too: what is
 * still running or waiting comes first, then everything that finished. A phone
 * has none of its own: there the history is the second half of Downloads, and
 * the app sends anything bound for this screen to that half instead.
 */
export function HistoryPage({ onGoHome }: { onGoHome: () => void }) {
  const queued = useQueueStore((state) => queueHasRows(state.tasks));
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pb-12">
      <HistoryList onGoHome={onGoHome} queue={queued ? <QueueSection onGoHome={onGoHome} /> : undefined} />
    </div>
  );
}
