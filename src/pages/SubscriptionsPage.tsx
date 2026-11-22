import { SubscriptionsList } from '@/components/subscriptions/SubscriptionsList';
import { DownloadsTitle, type DownloadsRoute } from './DownloadsPage';

/** The desktop's Subscriptions, a tab under Downloads. */
export function SubscriptionsPage({
  onGoHome,
  onSwitch,
}: {
  onGoHome: () => void;
  onSwitch: (route: DownloadsRoute) => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pb-12">
      <SubscriptionsList
        onGoHome={onGoHome}
        title={<DownloadsTitle current="subscriptions" onSwitch={onSwitch} />}
      />
    </div>
  );
}
