import { HistoryScreen } from './DownloadsPage';

/**
 * The desktop's History screen, which is its Downloads screen too (see
 * `HistoryScreen`). A phone has none of its own: there the history is the
 * second half of Downloads, and the app sends anything bound for this screen
 * to that half instead.
 */
export function HistoryPage({ onGoHome }: { onGoHome: () => void }) {
  return <HistoryScreen onGoHome={onGoHome} />;
}
