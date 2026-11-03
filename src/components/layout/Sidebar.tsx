import { AnimatePresence, motion } from 'motion/react';
import {
  Clock,
  Download,
  House,
  Info,
  Film,
  PanelLeft,
  Repeat,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';
import { memo, useMemo } from 'react';

import { Progress } from '@/components/ui/Progress';
import { Tooltip } from '@/components/ui/Tooltip';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/cn';
import { isBusy, summarizeActivity, type Activity } from '@/lib/activity';
import { formatEta, formatSpeed } from '@/lib/format';
import { SPRING, T } from '@/lib/motion';
import type { TranslationKey } from '@/i18n';
import { useQueueStore } from '@/stores/useQueueStore';
import { Logo, Wordmark } from './Logo';

export type Route = 'home' | 'downloads' | 'convert' | 'editor' | 'history' | 'settings' | 'about';

interface NavEntry {
  route: Route;
  label: TranslationKey;
  icon: LucideIcon;
}

/**
 * The places where work happens, in the order the phone's tab bar has them:
 * fetch, look at what is coming in, cut it, convert it. The two used to stand
 * in different orders, so Edit and Convert swapped places between the phone
 * and the desktop.
 */
const PRIMARY: NavEntry[] = [
  { route: 'home', label: 'nav.home', icon: House },
  { route: 'downloads', label: 'nav.downloads', icon: Download },
  { route: 'editor', label: 'nav.editor', icon: Film },
  { route: 'convert', label: 'nav.convert', icon: Repeat },
  { route: 'history', label: 'nav.history', icon: Clock },
];

const SECONDARY: NavEntry[] = [
  { route: 'settings', label: 'nav.settings', icon: SettingsIcon },
  { route: 'about', label: 'nav.about', icon: Info },
];

/**
 * Every place in the order it stands in the sidebar, top to bottom. Ctrl+1 is
 * the first of them, and so on (see `useHotkeys`), so the numbers a user
 * learns are the positions they see.
 */
export const NAV_ORDER: readonly Route[] = [...PRIMARY, ...SECONDARY].map((entry) => entry.route);

/** "Ctrl+3" for the third place, as the tooltip shows it. */
function shortcutFor(route: Route): string | null {
  const index = NAV_ORDER.indexOf(route);
  return index >= 0 && index < 9 ? `Ctrl+${index + 1}` : null;
}

/** The sidebar's two widths. Collapsed, the rail is the icons and nothing else. */
const WIDE = 'w-[224px]';
const RAIL = 'w-[64px]';

/**
 * Where an icon stands from the left of its row, so it is centred in the rail
 * and stays exactly there when the sidebar opens: 12px of padding beside the
 * rows, and 11px inside a 40px row for an 18px icon. Nothing moves sideways
 * while the width changes; the labels only fade in beside the icons.
 */
const ROW_PAD = 'pl-[11px] pr-2.5';

interface SidebarProps {
  route: Route;
  onNavigate: (route: Route) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  activeCount: number;
  convertingCount: number;
}

export function Sidebar({
  route,
  onNavigate,
  collapsed,
  onToggleCollapsed,
  activeCount,
  convertingCount,
}: SidebarProps) {
  const { t } = useTranslation();

  return (
    <nav
      aria-label={t('app.name')}
      className={cn(
        'relative z-20 flex shrink-0 flex-col overflow-hidden border-r border-[var(--border)] bg-surface-sunken',
        'transition-[width] duration-350 ease-out-quint',
        collapsed ? RAIL : WIDE,
      )}
    >
      {/* The lockup: the mark over the column of icons, centred in the rail,
          and the name fading in beside it. */}
      <div className="flex h-[60px] shrink-0 items-center gap-2.5 pl-5">
        <Logo size={24} className="shrink-0" />
        <Wordmark
          name={t('app.name')}
          className={cn(
            'whitespace-nowrap text-[15px] font-bold tracking-[-0.02em] text-fg',
            'transition-opacity duration-200 ease-out-quint',
            collapsed ? 'opacity-0' : 'opacity-100 delay-75',
          )}
        />
      </div>

      <div className="flex flex-1 flex-col gap-1 px-3 pt-1">
        {PRIMARY.map((entry) => (
          <NavButton
            key={entry.route}
            entry={entry}
            active={route === entry.route}
            collapsed={collapsed}
            badge={badgeFor(entry.route, activeCount, convertingCount)}
            onClick={() => onNavigate(entry.route)}
          />
        ))}
      </div>

      <ActivityCard collapsed={collapsed} onOpen={() => onNavigate('downloads')} />

      {/* The app's own pages sit at the foot of the list, apart from the places
          where work happens; the distance does what a rule would. */}
      <div className="flex flex-col gap-1 px-3 pb-3">
        {SECONDARY.map((entry) => (
          <NavButton
            key={entry.route}
            entry={entry}
            active={route === entry.route}
            collapsed={collapsed}
            badge={0}
            onClick={() => onNavigate(entry.route)}
          />
        ))}

        <Tooltip label={collapsed ? t('nav.expand') : t('nav.collapse')} side="right">
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
            aria-expanded={!collapsed}
            className={cn(
              'pressable-sm flex h-9 items-center rounded-[10px] text-fg-faint',
              'hover:bg-fill hover:text-fg-muted',
              ROW_PAD,
            )}
          >
            <PanelLeft
              size={18}
              className={cn(
                'shrink-0 transition-transform duration-350 ease-out-quint',
                collapsed && 'rotate-180',
              )}
            />
          </button>
        </Tooltip>
      </div>
    </nav>
  );
}

/** Only the two screens that do background work carry a count. */
export function badgeFor(route: Route, downloading: number, converting: number): number {
  if (route === 'downloads') return downloading;
  if (route === 'convert') return converting;
  return 0;
}

function NavButton({
  entry,
  active,
  collapsed,
  badge,
  onClick,
}: {
  entry: NavEntry;
  active: boolean;
  collapsed: boolean;
  badge: number;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const Icon = entry.icon;
  const label = t(entry.label);
  const shortcut = shortcutFor(entry.route);

  const button = (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      aria-keyshortcuts={shortcut ?? undefined}
      // No `pressable`: the highlight gliding in is a layout animation, and
      // Motion would measure it against a row it does not know is scaled.
      className={cn(
        'relative flex h-10 items-center gap-3 rounded-[10px] text-[13.5px] font-medium',
        'transition-colors duration-150 ease-out-quint',
        ROW_PAD,
        active ? 'text-fg' : 'text-fg-muted hover:bg-fill hover:text-fg',
      )}
    >
      {active && (
        <motion.span
          // One shared element slides between items, so switching pages reads
          // as the selection moving rather than two highlights crossfading.
          // The mark's gradient travels with it as a short bar on its edge.
          layoutId="sidebar-active"
          transition={SPRING.glide}
          className="absolute inset-0 rounded-[10px] bg-fill-active"
        >
          <span className="brand-track absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full" />
        </motion.span>
      )}
      <Icon
        size={18}
        strokeWidth={active ? 2.2 : 1.9}
        className={cn('relative z-10 shrink-0 transition-colors duration-150', active && 'text-accent')}
      />
      <span
        className={cn(
          'relative z-10 truncate whitespace-nowrap transition-opacity duration-200 ease-out-quint',
          collapsed ? 'opacity-0' : 'opacity-100 delay-75',
        )}
      >
        {label}
      </span>

      {badge > 0 && (
        <>
          {/* Open, the figure; on the rail there is no room for one, so a dot
              only says there is one -- a screen reader still gets the figure. */}
          <span
            className={cn(
              'tabular absolute right-2 top-1/2 z-10 min-w-5 -translate-y-1/2 rounded-full bg-accent-soft px-1.5 text-center text-[11.5px] font-semibold leading-5 text-accent',
              'transition-opacity duration-200 ease-out-quint',
              collapsed ? 'opacity-0' : 'opacity-100',
            )}
          >
            {badge > 99 ? '99+' : badge}
          </span>
          <span
            aria-hidden="true"
            className={cn(
              'brand-track absolute left-[25px] top-[8px] z-10 size-[7px] rounded-full ring-2 ring-[var(--surface-sunken)]',
              'transition-opacity duration-200 ease-out-quint',
              collapsed ? 'opacity-100' : 'opacity-0',
            )}
          />
        </>
      )}
    </button>
  );

  return collapsed ? (
    <Tooltip
      side="right"
      label={
        <span className="flex items-center gap-2">
          {label}
          {shortcut && <span className="kbd">{shortcut}</span>}
        </span>
      }
    >
      {button}
    </Tooltip>
  ) : (
    button
  );
}

/**
 * What the queue is doing, kept in view from every screen: how many are
 * running, how far they have got together, how fast and how long is left.
 * Pressing it opens Downloads. It is only there while something is running or
 * waiting, and arrives and leaves like any card.
 *
 * Its own component, subscribed to the queue on its own: progress ticks
 * several times a second, and only this card has any use for them here.
 */
const ActivityCard = memo(function ActivityCard({
  collapsed,
  onOpen,
}: {
  collapsed: boolean;
  onOpen: () => void;
}) {
  const tasks = useQueueStore((state) => state.tasks);
  const activity = useMemo(() => summarizeActivity(tasks), [tasks]);
  const busy = isBusy(activity);

  return (
    <div className="px-3 pb-2">
      <AnimatePresence initial={false} mode="popLayout">
        {busy && (
          <motion.div
            key={collapsed ? 'rail' : 'card'}
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: T.component }}
            exit={{ opacity: 0, scale: 0.97, transition: T.componentOut }}
          >
            {collapsed ? (
              <ActivityRing activity={activity} onOpen={onOpen} />
            ) : (
              <ActivityPanel activity={activity} onOpen={onOpen} />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

function useActivityWords(activity: Activity) {
  const { t } = useTranslation();
  // Nothing running and the schedule keeping the rest back: the hour it lets
  // them go is the news, not that they wait for a free slot.
  const heldUntil = useQueueStore((state) => state.outlook.heldUntil);
  const idle =
    activity.running > 0
      ? t('activity.starting')
      : heldUntil != null
        ? t('activity.heldUntil', { time: heldUntil })
        : t('activity.queuedOnly');
  const headline =
    activity.running > 0
      ? t('activity.downloading', { n: activity.running })
      : t('activity.waiting', { n: activity.waiting });
  const rate = activity.speedBps > 0 ? formatSpeed(activity.speedBps) : null;
  const left =
    activity.etaSec != null && activity.speedBps > 0
      ? t('downloads.eta', { time: formatEta(activity.etaSec) })
      : null;
  return { headline, rate, left, idle };
}

function ActivityPanel({ activity, onOpen }: { activity: Activity; onOpen: () => void }) {
  const { t } = useTranslation();
  const { headline, rate, left, idle } = useActivityWords(activity);
  const percent = activity.percent;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${headline}. ${t('activity.open')}`}
      className="pressable surface-card block w-[200px] rounded-[14px] px-3 py-2.5 text-left hover:bg-surface-hover"
    >
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className="relative flex size-2 shrink-0">
          <span
            className={cn(
              'brand-track size-2 rounded-full',
              activity.running > 0 && '[animation:ud-breathe_1.8s_ease-in-out_infinite]',
            )}
          />
        </span>
        <span className="min-w-0 truncate text-[12.5px] font-semibold text-fg">{headline}</span>
        {percent != null && activity.running > 0 && (
          <span className="tabular ml-auto shrink-0 text-[12px] font-medium text-fg-muted">
            {Math.floor(percent)}%
          </span>
        )}
      </span>
      <Progress
        value={activity.running > 0 ? percent : 0}
        tone={activity.running > 0 ? 'live' : 'muted'}
        className="mt-2.5"
      />
      <span className="tabular mt-2 flex items-center justify-between gap-2 whitespace-nowrap text-[11.5px] text-fg-muted">
        <span className="truncate">
          {rate ?? idle}
        </span>
        {left && <span className="shrink-0">{left}</span>}
      </span>
    </button>
  );
}

/** The rail's version: a ring that fills as the card's bar does. */
function ActivityRing({ activity, onOpen }: { activity: Activity; onOpen: () => void }) {
  const { t } = useTranslation();
  const { headline, rate } = useActivityWords(activity);
  const fraction = activity.running > 0 && activity.percent != null ? activity.percent / 100 : 0;
  const circumference = 2 * Math.PI * 15;

  return (
    <Tooltip
      side="right"
      label={
        <span className="tabular">
          {headline}
          {rate && ` · ${rate}`}
        </span>
      }
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${headline}. ${t('activity.open')}`}
        className="pressable-sm relative flex size-10 items-center justify-center rounded-full hover:bg-fill"
      >
        <svg viewBox="0 0 36 36" className="absolute inset-0 size-10 -rotate-90" aria-hidden="true">
          <defs>
            <linearGradient id="umd-activity-ring" x1="0" y1="0" x2="1" y2="1">
              {/* Styles, not attributes: a presentation attribute takes no var(). */}
              <stop offset="0" style={{ stopColor: 'var(--brand-ember)' }} />
              <stop offset="1" style={{ stopColor: 'var(--brand-amber)' }} />
            </linearGradient>
          </defs>
          <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3" style={{ stroke: 'var(--fill-active)' }} />
          <circle
            cx="18"
            cy="18"
            r="15"
            fill="none"
            stroke="url(#umd-activity-ring)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - fraction)}
            className="motion-essential transition-[stroke-dashoffset] duration-300 ease-linear"
          />
        </svg>
        <Download size={14} className="relative text-accent" />
      </button>
    </Tooltip>
  );
}
