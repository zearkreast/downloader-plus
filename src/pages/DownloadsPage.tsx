import {
  AnimatePresence,
  motion,
  Reorder,
  useDragControls,
  useReducedMotionConfig,
} from 'motion/react';
import { Clock, Download, FolderOpen, GripVertical, Pause, Play } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';

import { DownloadCard } from '@/components/downloads/DownloadCard';
import { DownloadDetailDialog, openDownloadDetails } from '@/components/downloads/DownloadDetailDialog';
import { HistoryList } from '@/components/history/HistoryList';
import { SubscriptionsList } from '@/components/subscriptions/SubscriptionsList';
import { Button } from '@/components/ui/Button';
import { Dropdown } from '@/components/ui/Dropdown';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconButton } from '@/components/ui/IconButton';
import { ListGroup, ListGroupLabel } from '@/components/ui/ListGroup';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { TitleTabs } from '@/components/ui/TitleTabs';
import { Progress } from '@/components/ui/Progress';
import { Segmented } from '@/components/ui/Segmented';
import { useTranslation } from '@/i18n';
import { isBusy, summarizeActivity } from '@/lib/activity';
import { cn } from '@/lib/cn';
import { groupDownloads, placesInLine, reconcileOrder } from '@/lib/downloadGroups';
import { formatEta, formatSpeed } from '@/lib/format';
import { RISE, SIDEWAYS } from '@/lib/motion';
import { IS_MOBILE } from '@/lib/platform';
import * as ipc from '@/services/ipc';
import {
  selectActive,
  selectFinished,
  selectInFlightCount,
  useQueueStore,
} from '@/stores/useQueueStore';
import type { AfterQueue, DownloadTask } from '@/types';

/**
 * Defined once, outside the component. The rows are memoised, and handlers
 * recreated on every render -- which progress causes several times a second --
 * would make every row re-render on every tick instead of only the one that
 * moved.
 */
const HANDLERS = {
  onPause: (id: string) => void ipc.pauseDownload(id),
  onResume: (id: string) => void ipc.resumeDownload(id),
  onCancel: (id: string) => void ipc.cancelDownload(id),
  onRetry: (id: string) => void ipc.retryDownload(id),
  onRemove: (id: string) => void ipc.removeDownload(id),
  // The queue starts the first waiting download in its own order, so putting
  // this one first makes it the next to start; the rest keep theirs.
  onNext: (id: string) => void ipc.setDownloadOrder([id]),
  onDetails: openDownloadDetails,
};

/** Where a row's text starts: its padding, the 72px thumbnail, the gap. */
const TEXT_INSET = IS_MOBILE ? 96 : 104;

/** How a removed row leaves; see the same choice in `HistoryList`. */
const LEAVING = IS_MOBILE ? 'sync' : 'popLayout';

export function DownloadsPage({ onGoHome }: { onGoHome: () => void }) {
  if (IS_MOBILE) return <PhoneDownloads onGoHome={onGoHome} />;

  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pb-12">
      <CurrentDownloads onGoHome={onGoHome} />
    </div>
  );
}

// -- the phone's two halves ---------------------------------------------------

export type DownloadsSegment = 'active' | 'history' | 'subscriptions';

/**
 * Which half of Downloads the phone shows, once it has shown one. Kept outside
 * the screen, which is unmounted whenever another tab is
 * open, so coming back finds the half that was left -- and in a store rather
 * than a plain variable, so a request for History that arrives while Downloads
 * is already on screen switches it there.
 */
const useSegmentStore = create<{ chosen: DownloadsSegment | null }>(() => ({ chosen: null }));

/**
 * Settle which half Downloads opens at on the phone: the user's own pick, or a
 * request the app makes for them -- History asked for by name, or the list of
 * current downloads just after one was started.
 */
export function showDownloadsSegment(segment: DownloadsSegment) {
  useSegmentStore.setState({ chosen: segment });
}

/** Anything still to finish, including what is waiting or paused. */
function hasWork(tasks: DownloadTask[]): boolean {
  return selectInFlightCount(tasks) > 0 || tasks.some((task) => task.status === 'paused');
}

/**
 * A phone has no room for a History tab, so History is the second half of
 * this screen, behind a two-way switch at its top.
 */
function useDownloadsSegment(): DownloadsSegment {
  const chosen = useSegmentStore((state) => state.chosen);

  // The first time, the screen opens where something is to be seen: the
  // running downloads if there are any, the finished ones if not. Read once
  // rather than subscribed to, so a download finishing while the screen is open
  // does not pull the list away from under the user -- and kept once shown, so
  // it does not either between one visit and the next.
  const [fallback] = useState<DownloadsSegment>(() =>
    hasWork(useQueueStore.getState().tasks) ? 'active' : 'history',
  );
  useEffect(() => {
    if (chosen == null) showDownloadsSegment(fallback);
  }, [chosen, fallback]);
  return chosen ?? fallback;
}

function PhoneDownloads({ onGoHome }: { onGoHome: () => void }) {
  const { t } = useTranslation();
  const segment = useDownloadsSegment();

  // The new list comes in from the side of the half that was picked, and
  // under the system's reduced motion only fades: a transform string is beyond
  // the reach of `MotionConfig` (see App).
  const still = useReducedMotionConfig() ?? false;
  const direction = still ? 0 : segment === 'active' ? -1 : 1;

  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pb-12 pt-2">
      <Segmented
        value={segment}
        onChange={showDownloadsSegment}
        options={[
          { value: 'active', label: t('downloads.active') },
          { value: 'history', label: t('nav.history') },
          { value: 'subscriptions', label: t('nav.subscriptions') },
        ]}
      />

      <AnimatePresence mode="wait" initial={false} custom={direction}>
        <motion.div
          key={segment}
          custom={direction}
          variants={SIDEWAYS}
          initial="initial"
          animate="animate"
          exit="exit"
          className="mt-3"
        >
          {segment === 'active' ? (
            <CurrentDownloads onGoHome={onGoHome} />
          ) : segment === 'history' ? (
            <HistoryList onGoHome={onGoHome} />
          ) : (
            <SubscriptionsList onGoHome={onGoHome} />
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// -- the queue's hours and what comes after it ---------------------------------

const AFTER_LABELS = {
  nothing: 'downloads.afterNothing',
  quit: 'downloads.afterQuit',
  sleep: 'downloads.afterSleep',
  shutdown: 'downloads.afterShutdown',
} as const;

/** The last chance to stop what was asked for after the queue. */
export function QueueEndingDialog() {
  const { t } = useTranslation();
  const outlook = useQueueStore((state) => state.outlook);
  const after = outlook.after === 'nothing' ? null : outlook.after;
  const stop = () => void ipc.setAfterQueue('nothing');

  return (
    <Modal
      open={outlook.countdown != null && after != null}
      onClose={stop}
      title={t('downloads.endingTitle')}
      description={after ? t(ENDING_LINES[after], { n: outlook.countdown ?? 0 }) : undefined}
      footer={
        <Button variant="primary" onClick={stop}>
          {t('downloads.endingStop')}
        </Button>
      }
    />
  );
}

const ENDING_LINES = {
  quit: 'downloads.endingQuit',
  sleep: 'downloads.endingSleep',
  shutdown: 'downloads.endingShutdown',
} as const;

// -- the downloads themselves ---------------------------------------------------

/**
 * The desktop's History screen, which holds its downloads too: two tabs in the
 * title, as Edit and Convert have. It opens where something is to be seen, as
 * the phone's Downloads does, and keeps the tab that was left.
 */
export function HistoryScreen({ onGoHome }: { onGoHome: () => void }) {
  const { t } = useTranslation();
  const segment = useDownloadsSegment() === 'active' ? 'active' : 'history';
  const title = (
    <TitleTabs
      value={segment}
      onChange={showDownloadsSegment}
      options={[
        { value: 'history', label: t('nav.history') },
        { value: 'active', label: t('downloads.title') },
      ]}
    />
  );
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pb-12">
      {segment === 'active' ? (
        <CurrentDownloads onGoHome={onGoHome} title={title} withinHistory />
      ) : (
        <HistoryList onGoHome={onGoHome} title={title} />
      )}
    </div>
  );
}

/**
 * What is downloading, waiting, or finished and not yet cleared away, with the
 * actions that apply to all of it. On a phone this is the first half of
 * Downloads. `withinHistory`, a tab of the desktop's History, it leaves the
 * completed ones to the history, which already lists them.
 */
function CurrentDownloads({
  onGoHome,
  title,
  withinHistory = false,
}: {
  onGoHome: () => void;
  title?: React.ReactNode;
  withinHistory?: boolean;
}) {
  const { t } = useTranslation();
  const tasks = useQueueStore((state) => state.tasks);

  // Three lists, by what a row is doing. A progress tick changes no row's
  // status or place in the queue, so it rebuilds each list in the same order
  // and no row moves.
  const { groups, anyRunning, anyQueued, anyPaused, anyFinished } = useMemo(
    () => ({
      groups: withinHistory ? withoutCompleted(groupDownloads(tasks)) : groupDownloads(tasks),
      anyRunning: selectActive(tasks).length > 0,
      anyQueued: tasks.some((task) => task.status === 'queued'),
      anyPaused: tasks.some((task) => task.status === 'paused'),
      anyFinished: selectFinished(tasks).length > 0,
    }),
    [tasks, withinHistory],
  );
  const activity = useMemo(() => summarizeActivity(tasks), [tasks]);

  // Only what applies right now. Left undefined when nothing does, so a phone,
  // which shows the actions and no title, renders no header at all. Pause all
  // holds what is waiting as well as what is running, so it is offered while
  // either is there -- not only once something has started.
  const canPause = anyRunning || anyQueued;
  const actions =
    canPause || anyPaused || anyFinished || !IS_MOBILE ? (
      <>
        {/* The folder the downloads land in, a press away from the list of
            them. A phone's downloads are in its own Downloads app. */}
        {!IS_MOBILE && (
          <IconButton
            icon={<FolderOpen size={16} />}
            label={t('downloads.openFolder')}
            onClick={() => void ipc.openDownloadDir().catch(() => {})}
          />
        )}
        {canPause && (
          <IconButton
            icon={<Pause size={15} />}
            label={t('downloads.pauseAll')}
            onClick={() => void ipc.pauseAllDownloads()}
          />
        )}
        {anyPaused && (
          <IconButton
            icon={<Play size={15} />}
            label={t('downloads.resumeAll')}
            onClick={() => void ipc.resumeAllDownloads()}
          />
        )}
        {/* Within History, whose own Clear empties the history, this one
            says what it clears. */}
        {(withinHistory ? groups.finished.length > 0 : anyFinished) && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={t(withinHistory ? 'downloads.clearUnfinished' : 'downloads.clearFinished')}
            onClick={() => void ipc.clearFinishedDownloads()}
          >
            {t(withinHistory ? 'downloads.clearUnfinished' : 'downloads.clear')}
          </Button>
        )}
      </>
    ) : undefined;

  return (
    <>
      <PageHeader
        title={title ?? t('downloads.title')}
        actions={actions}
        // Under the switch, the actions start the half, so they take no room
        // above them.
        className={IS_MOBILE ? 'pt-0' : undefined}
      />

      <AnimatePresence initial={false}>
        {isBusy(activity) && (
          <motion.div
            key="summary"
            variants={RISE}
            initial="initial"
            animate="animate"
            exit="exit"
            className="mb-4"
          >
            <QueueSummary activity={activity} tasks={tasks} />
          </motion.div>
        )}
      </AnimatePresence>

      {groups.running.length + groups.pending.length + groups.finished.length === 0 ? (
        <EmptyState
          icon={Download}
          title={t('downloads.emptyTitle')}
          body={t('downloads.emptyBody')}
          action={
            <Button variant="secondary" onClick={onGoHome}>
              {t('downloads.goHome')}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-5">
          {groups.running.length > 0 && (
            <DownloadGroup label={t('downloads.active')} count={groups.running.length}>
              <Rows tasks={groups.running} />
            </DownloadGroup>
          )}
          {groups.pending.length > 0 && (
            <DownloadGroup label={t('downloads.pendingGroup')} count={groups.pending.length}>
              <PendingRows tasks={groups.pending} />
            </DownloadGroup>
          )}
          {groups.finished.length > 0 && (
            <DownloadGroup
              label={t(withinHistory ? 'downloads.unfinishedGroup' : 'downloads.finishedGroup')}
              count={groups.finished.length}
            >
              <FinishedRows tasks={groups.finished} />
            </DownloadGroup>
          )}
        </div>
      )}

      <DownloadDetailDialog />
    </>
  );
}

/** Failed and cancelled downloads stay; completed ones are in the history. */
function withoutCompleted(groups: ReturnType<typeof groupDownloads>) {
  return { ...groups, finished: groups.finished.filter((task) => task.status !== 'completed') };
}

function DownloadGroup({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={label}>
      <ListGroupLabel className="tabular mb-2">
        {label} · {count}
      </ListGroupLabel>
      {children}
    </section>
  );
}

function Rows({ tasks }: { tasks: DownloadTask[] }) {
  return (
    // `relative` gives a row that is leaving something to be positioned
    // against while the rows under it close the gap.
    <ListGroup inset={TEXT_INSET} className="relative">
      <AnimatePresence initial={false} mode={LEAVING}>
        {tasks.map((task) => (
          <DownloadCard key={task.id} task={task} {...HANDLERS} />
        ))}
      </AnimatePresence>
    </ListGroup>
  );
}

/** How many finished rows show before the rest fold away. */
const FINISHED_SHOWN = 5;

/**
 * What is over is a record, and a long one pushes nothing useful off the
 * screen by being short: the latest few show, the rest on request.
 */
function FinishedRows({ tasks }: { tasks: DownloadTask[] }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const hidden = all ? 0 : Math.max(0, tasks.length - FINISHED_SHOWN);

  return (
    <>
      <Rows tasks={hidden > 0 ? tasks.slice(0, FINISHED_SHOWN) : tasks} />
      {hidden > 0 && (
        <div className="mt-2 flex justify-center">
          <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
            {t('downloads.showRest', { n: hidden })}
          </Button>
        </div>
      )}
    </>
  );
}

/** The handle and the number a waiting row starts with, before its thumbnail. */
const PLACE_WIDTH = 46;

/**
 * What is still to run, in the order the queue will start it. A pointer drags
 * a row by its handle to change that order; a phone shows the order and
 * changes it with nothing, having no room for a handle beside the title.
 *
 * The order shown is the user's own while they drag and until the backend
 * sends the list back in it; any other change to the list takes it over again.
 */
function PendingRows({ tasks }: { tasks: DownloadTask[] }) {
  const ids = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const [dragged, setDragged] = useState<string[] | null>(null);
  const latest = useRef<string[]>(ids);

  const key = ids.join('|');
  useEffect(() => setDragged(null), [key]);

  const order = dragged ? reconcileOrder(dragged, ids) : ids;
  latest.current = order;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const shown = order.map((id) => byId.get(id)!);
  const places = placesInLine(shown);

  if (IS_MOBILE) {
    return (
      <ListGroup inset={TEXT_INSET} className="relative">
        <AnimatePresence initial={false} mode={LEAVING}>
          {shown.map((task) => (
            <DownloadCard key={task.id} task={task} {...HANDLERS} />
          ))}
        </AnimatePresence>
      </ListGroup>
    );
  }

  return (
    <ListGroup inset={TEXT_INSET + PLACE_WIDTH}>
      <Reorder.Group as="div" axis="y" values={order} onReorder={setDragged}>
        {shown.map((task) => (
          <PendingRow
            key={task.id}
            task={task}
            place={places.get(task.id) ?? null}
            onDropped={() => void ipc.setDownloadOrder(latest.current)}
          />
        ))}
      </Reorder.Group>
    </ListGroup>
  );
}

function PendingRow({
  task,
  place,
  onDropped,
}: {
  task: DownloadTask;
  place: number | null;
  onDropped: () => void;
}) {
  const { t } = useTranslation();
  const controls = useDragControls();

  return (
    <Reorder.Item
      as="div"
      value={task.id}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDropped}
      className="pending-row relative flex items-center bg-surface"
    >
      <button
        type="button"
        aria-label={t('downloads.dragToReorder')}
        title={t('downloads.dragToReorder')}
        onPointerDown={(event) => controls.start(event)}
        className="ml-1.5 flex h-9 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-fg-faint hover:text-fg-muted active:cursor-grabbing"
      >
        <GripVertical size={14} />
      </button>
      <span
        aria-hidden={place == null}
        className={cn(
          'tabular flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
          place === 1 ? 'bg-accent-soft text-accent' : 'bg-fill text-fg-muted',
          place == null && 'invisible',
        )}
      >
        {place ?? 0}
      </span>
      <div className="-ml-2.5 min-w-0 flex-1">
        <DownloadCard task={task} {...HANDLERS} />
      </div>
    </Reorder.Item>
  );
}

/**
 * The whole queue at a glance, over the list: how many are running and
 * waiting, how far they have got together, how fast and how long is left --
 * the same reading as the sidebar's card (see `summarizeActivity`). Its foot
 * holds what the queue does about time: the hours the schedule keeps it back,
 * and what happens once it has run out.
 */
function QueueSummary({
  activity,
  tasks,
}: {
  activity: ReturnType<typeof summarizeActivity>;
  tasks: DownloadTask[];
}) {
  const { t } = useTranslation();
  const outlook = useQueueStore((state) => state.outlook);
  const running = activity.running > 0;
  const percent = activity.percent;

  const held = outlook.heldUntil != null && tasks.some((task) => task.status === 'queued');
  // Choosing an ending for a queue with nothing in flight would have nothing
  // to end; a phone cannot be turned off from an app, and quitting one means
  // nothing.
  const offerAfter = !IS_MOBILE && selectInFlightCount(tasks) > 0;
  const heldLine = held && (
    <span className="flex min-w-0 items-center gap-1.5">
      <Clock size={13} className="shrink-0" />
      <span className="truncate">{t('downloads.heldUntil', { time: outlook.heldUntil! })}</span>
    </span>
  );

  const parts = [
    running && t('activity.downloading', { n: activity.running }),
    activity.waiting > 0 && t('activity.waiting', { n: activity.waiting }),
    activity.paused > 0 && t('activity.paused', { n: activity.paused }),
  ].filter(Boolean);

  return (
    <div className="surface-card rounded-[var(--radius-card)] px-4 py-3.5">
      <div className="flex items-center gap-3">
        {/* Lit while something moves; at rest, the reason it is at rest. */}
        <span
          aria-hidden="true"
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-[11px] transition-colors duration-300',
            running ? 'brand-fill' : 'bg-surface-sunken text-fg-muted',
          )}
        >
          {running ? (
            <Download size={17} strokeWidth={2.2} />
          ) : held ? (
            <Clock size={17} strokeWidth={2.2} />
          ) : activity.waiting > 0 ? (
            <Download size={17} strokeWidth={2.2} />
          ) : (
            <Pause size={16} strokeWidth={2.2} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          {/* On a phone it wraps between the counts rather than cutting the
              last one off mid-word. */}
          <div className={cn('text-[13.5px] font-semibold text-fg', IS_MOBILE ? 'leading-snug' : 'truncate')}>
            {parts.map((part, index) => (
              <Fragment key={index}>
                {index > 0 && ' '}
                <span className={IS_MOBILE ? 'whitespace-nowrap' : undefined}>
                  {index > 0 && '· '}
                  {part}
                </span>
              </Fragment>
            ))}
          </div>
          <div className="tabular mt-0.5 flex gap-3 text-[12.5px] text-fg-muted">
            {running && activity.speedBps > 0 ? (
              <>
                <span>{formatSpeed(activity.speedBps)}</span>
                {activity.etaSec != null && (
                  <span>{t('downloads.eta', { time: formatEta(activity.etaSec) })}</span>
                )}
              </>
            ) : held && !running ? (
              heldLine
            ) : (
              <span>
                {running
                  ? t(activity.offline ? 'downloads.waitingForNetwork' : 'activity.starting')
                  : activity.waiting > 0
                    ? t('activity.queuedOnly')
                    : t('activity.pausedOnly')}
              </span>
            )}
          </div>
        </div>
        {running && percent != null && (
          <span
            className={cn(
              'tabular shrink-0 font-semibold tracking-[-0.02em] text-fg',
              IS_MOBILE ? 'text-[18px]' : 'text-[22px]',
            )}
          >
            {Math.floor(percent)}
            <span className="text-[0.6em] font-medium text-fg-muted">%</span>
          </span>
        )}
      </div>
      <Progress
        value={running ? percent : 0}
        tone={running ? 'live' : 'muted'}
        label={parts.join(', ')}
        className="mt-3"
      />

      {(held || offerAfter) && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[var(--border)] pt-3">
          {/* While something runs the line above shows its speed, so the
              hours that hold the rest back are said here instead. */}
          {held && running && <p className="min-w-0 flex-1 text-[12.5px] text-fg-muted">{heldLine}</p>}
          {held && (
            <Button size="sm" variant="secondary" onClick={() => void ipc.runOutsideSchedule()}>
              {t('downloads.startNow')}
            </Button>
          )}
          {offerAfter && (
            <div className="ml-auto w-[230px]">
              <Dropdown
                aria-label={t('downloads.after')}
                value={outlook.after}
                options={(Object.keys(AFTER_LABELS) as AfterQueue[]).map((after) => ({
                  value: after,
                  label: t(AFTER_LABELS[after]),
                }))}
                onChange={(after) => void ipc.setAfterQueue(after)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
