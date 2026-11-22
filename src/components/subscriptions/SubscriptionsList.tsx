import { AnimatePresence, motion } from 'motion/react';
import { Bell, ChevronRight, RotateCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListGroup, ListGroupLabel } from '@/components/ui/ListGroup';
import { PageHeader } from '@/components/ui/PageHeader';
import { PlatformBadge } from '@/components/ui/PlatformBadge';
import { Segmented } from '@/components/ui/Segmented';
import { Toggle } from '@/components/ui/Toggle';
import { useThumbnail } from '@/hooks/useThumbnail';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatDate, formatTime } from '@/lib/format';
import { COLLAPSE } from '@/lib/motion';
import { IS_MOBILE } from '@/lib/platform';
import { platformPresentation } from '@/lib/platforms';
import * as ipc from '@/services/ipc';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { Subscription } from '@/types';

/** A reading that failed this many times in a row is worth saying so. */
const FAILURES_SHOWN = 3;

/** The time alone today, the day as well before it. */
function when(at: number, language: string): string {
  const today = new Date().toDateString() === new Date(at).toDateString();
  return today ? formatTime(at, language) : formatDate(at, language);
}

/**
 * The lists the user follows, each with when it was last read, what that
 * found, and its own few options. The desktop gives it a screen of its own;
 * a phone shows it as the third part of Downloads, without a title.
 */
export function SubscriptionsList({
  onGoHome,
  title,
}: {
  onGoHome: () => void;
  /** The desktop's title, when it names the screens beside this one. */
  title?: React.ReactNode;
}) {
  const { t, language } = useTranslation();
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [reading, setReading] = useState(false);
  const interval = useSettingsStore((state) => state.settings?.subscriptionIntervalHours ?? 6);

  const refresh = useCallback(() => {
    void ipc.listSubscriptions().then(setSubscriptions, () => setSubscriptions([]));
  }, []);

  useEffect(() => {
    refresh();
    const unlisten = ipc.onSubscriptionsChanged(() => {
      setReading(false);
      refresh();
    });
    return () => void unlisten.then((off) => off());
  }, [refresh]);

  const readNow = () => {
    setReading(true);
    void ipc.checkSubscriptions();
    // A list with nothing due answers with no event; the spinner is not left on.
    window.setTimeout(() => setReading(false), 15_000);
  };

  const last = subscriptions?.reduce<number | null>(
    (latest, entry) => Math.max(latest ?? 0, entry.lastCheckedAt ?? 0) || latest,
    null,
  );
  const readNowButton = (subscriptions?.length ?? 0) > 0 && (
    <Button size="sm" variant="ghost" icon={<RotateCw size={14} />} loading={reading} onClick={readNow}>
      {t('subs.checkNow')}
    </Button>
  );

  return (
    <>
      {IS_MOBILE ? (
        readNowButton && <div className="flex justify-end pb-3">{readNowButton}</div>
      ) : (
        <PageHeader title={title ?? t('subs.title')} actions={readNowButton || undefined} />
      )}

      {subscriptions != null && subscriptions.length === 0 && (
        <EmptyState
          icon={Bell}
          title={t('subs.emptyTitle')}
          body={t('subs.emptyBody')}
          action={
            <Button variant="secondary" onClick={onGoHome}>
              {t('downloads.goHome')}
            </Button>
          }
        />
      )}

      {subscriptions != null && subscriptions.length > 0 && (
        <section>
          <ListGroupLabel className="tabular mb-2 flex justify-between gap-3">
            <span>{t('subs.count', { n: subscriptions.length })}</span>
            <span className="font-medium text-fg-faint">
              {last ? t('subs.lastRead', { time: when(last, language), hours: interval }) : null}
            </span>
          </ListGroupLabel>
          <ListGroup inset={IS_MOBILE ? 64 : 68}>
            {subscriptions.map((entry) => (
              <SubscriptionRow
                key={entry.id}
                entry={entry}
                open={open === entry.id}
                onToggleOpen={() => setOpen((current) => (current === entry.id ? null : entry.id))}
                onChanged={refresh}
              />
            ))}
          </ListGroup>
        </section>
      )}
    </>
  );
}

function SubscriptionRow({
  entry,
  open,
  onToggleOpen,
  onChanged,
}: {
  entry: Subscription;
  open: boolean;
  onToggleOpen: () => void;
  onChanged: () => void;
}) {
  const { t, language } = useTranslation();
  const { src } = useThumbnail(entry.thumbnailUrl);
  const [confirming, setConfirming] = useState(false);

  const change = (change: ipc.SubscriptionChange) =>
    void ipc.updateSubscription(entry.id, change).then(onChanged, onChanged);

  const failing = entry.failures >= FAILURES_SHOWN && entry.lastError;
  const state = !entry.enabled
    ? { text: t('subs.paused'), tone: 'muted' as const }
    : failing
      ? { text: t('subs.failing'), tone: 'error' as const }
      : entry.lastFound > 0
        ? { text: t('subs.found', { n: entry.lastFound }), tone: 'accent' as const }
        : { text: t('subs.nothingNew'), tone: 'muted' as const };

  // Beside the title a phone leaves the title a few letters wide, so there it
  // joins the line under it.
  const badge = (
    <span
      className={cn(
        'shrink-0 whitespace-nowrap rounded-full px-2 py-px text-[12px] font-medium',
        state.tone === 'accent' && 'bg-accent-soft text-accent',
        state.tone === 'error' && 'bg-error-soft text-error',
        state.tone === 'muted' && 'bg-fill text-fg-muted',
      )}
    >
      {state.text}
    </span>
  );

  return (
    <div>
      <div className={cn('flex min-w-0 items-center gap-3 px-4', IS_MOBILE ? 'py-3' : 'py-2.5', open && 'bg-fill')}>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggleOpen}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-[var(--border)]">
            {src ? (
              <img src={src} alt="" aria-hidden="true" className="size-full object-cover" />
            ) : (
              <PlatformBadge platform={entry.platform} size="sm" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-medium text-fg">{entry.title}</span>
            <span className="tabular flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12.5px] text-fg-muted">
              <span className="whitespace-nowrap">{platformPresentation(entry.platform).label}</span>
              {entry.lastCheckedAt != null && (
                <span className="min-w-0 max-w-full truncate">
                  {t('subs.readAt', { time: when(entry.lastCheckedAt, language) })}
                </span>
              )}
              {IS_MOBILE && badge}
            </span>
          </span>
          {!IS_MOBILE && badge}
          <ChevronRight
            size={14}
            aria-hidden="true"
            className={cn('shrink-0 text-fg-faint transition-transform duration-150', open && 'rotate-90')}
          />
        </button>
        <Toggle
          checked={entry.enabled}
          onChange={(enabled) => change({ enabled })}
          label={t('subs.enabled', { title: entry.title })}
        />
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            variants={COLLAPSE}
            initial="initial"
            animate="animate"
            exit="exit"
            className="overflow-hidden bg-fill"
          >
            <div className="flex flex-col gap-3 px-4 pb-3.5 pt-1" style={{ paddingLeft: IS_MOBILE ? 64 : 68 }}>
              {failing && <p className="text-[12.5px] text-error">{entry.lastError}</p>}
              {/* Beside its label on a phone, "Yalnızca ses" has no room. */}
              <div
                className={cn(
                  'flex gap-2',
                  IS_MOBILE ? 'flex-col' : 'flex-wrap items-center justify-between',
                )}
              >
                <span className="text-[13px] text-fg">{t('options.mode')}</span>
                <Segmented
                  size="sm"
                  className={IS_MOBILE ? 'w-full' : undefined}
                  value={entry.template.mode === 'audio' ? 'audio' : 'video'}
                  onChange={(mode) => change({ mode })}
                  options={[
                    { value: 'video', label: t('options.modeVideo') },
                    { value: 'audio', label: t('options.modeAudio') },
                  ]}
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-[13px] text-fg">{t('subs.skipShorts')}</span>
                  <span className="block text-[12px] text-fg-muted">{t('subs.skipShortsHint')}</span>
                </span>
                <Toggle
                  checked={entry.skipShorts}
                  onChange={(skipShorts) => change({ skipShorts })}
                  label={t('subs.skipShorts')}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {confirming ? (
                  <>
                    <span className="text-[12.5px] text-fg-muted">{t('subs.removeConfirm')}</span>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void ipc.removeSubscription(entry.id).then(onChanged, onChanged)}
                    >
                      {t('subs.remove')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                      {t('common.cancel')}
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setConfirming(true)}>
                    {t('subs.remove')}
                  </Button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
