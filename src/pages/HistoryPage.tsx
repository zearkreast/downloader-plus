import { HistoryList } from '@/components/history/HistoryList';
import { DownloadsTitle, type DownloadsRoute } from './DownloadsPage';

/**
 * The desktop's History, a tab under Downloads. A phone has none of its own:
 * there the history is the second half of Downloads, and the app sends
 * anything bound for this screen to that half instead.
 */
export function HistoryPage({
  onGoHome,
  onSwitch,
}: {
  onGoHome: () => void;
  onSwitch: (route: DownloadsRoute) => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pb-12">
      <HistoryList onGoHome={onGoHome} title={<DownloadsTitle current="history" onSwitch={onSwitch} />} />
    </div>
  );
}
