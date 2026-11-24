import { AnimatePresence, motion } from 'motion/react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Copy,
  ExternalLink,
  FolderOpen,
  Smartphone,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { SettingGroup, SettingRow, ToggleRow } from '@/components/ui/SettingRow';
import { useMomentary } from '@/hooks/useMomentary';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { cn } from '@/lib/cn';
import { COLLAPSE } from '@/lib/motion';
import { IS_MOBILE } from '@/lib/platform';
import * as ipc from '@/services/ipc';
import type {
  BridgeSite,
  BridgeSessionState,
  BridgeStatus,
  ExtensionFolder,
  Settings,
} from '@/types';
import { SendToPhoneModal } from './SendToPhoneModal';
import { sendableSites } from './phoneTransfer';

/**
 * How often the section re-reads the link while it is on screen.
 *
 * The browser pushes to a helper process, not to the app, so a session can
 * appear while this page is open and nothing in the app would know. The event
 * covers what the app itself changes; the poll covers what the browser does,
 * and it costs one small file read.
 */
const POLL_MS = 4000;

/**
 * The link's state, refreshed while the component is mounted.
 *
 * `pollMs` of 0 reads once and then only follows the event, which is all the
 * Settings page itself needs to decide whether the section exists at all.
 * `initial` is a state already read elsewhere, shown until the first read of
 * this hook's own answers.
 */
export function useBridgeStatus(
  pollMs = 0,
  initial: BridgeStatus | null = null,
): BridgeStatus | null {
  const [status, setStatus] = useState<BridgeStatus | null>(initial);

  useEffect(() => {
    let active = true;
    const read = () => {
      ipc
        .bridgeStatus()
        .then((next) => {
          if (active) setStatus(next);
        })
        .catch(() => {
          // A failed read leaves the last known state on screen rather than
          // flashing "not connected" at someone whose link is fine.
        });
    };

    read();
    const timer = pollMs > 0 ? window.setInterval(read, pollMs) : null;
    const unlisten = ipc.onBridgeChanged(read);

    return () => {
      active = false;
      if (timer !== null) window.clearInterval(timer);
      void unlisten.then((off) => off());
    };
  }, [pollMs]);

  return status;
}

/**
 * Which of the browser sign-ins' states the user is looking at, taken across
 * every site the browser lends one for.
 *
 * Ordered by what has to be fixed first. A browser lending any sign-in that
 * is fresh is connected: each site's own line below says which. A stale
 * session is reported as its own state rather than as a connection, because a
 * card that says "connected" while the popup says otherwise is worse than
 * either being wrong alone.
 *
 * A browser that cannot start the helper is not one of these: it stops the
 * extension handing over videos as much as the sign-in, whether or not the
 * sign-in is on, so the extension's own row reports it (see `ExtensionRow`).
 */
export type LinkPhase = 'waiting' | 'signedOut' | 'quiet' | 'connected';

/**
 * Taken across YouTube's and TikTok's sign-ins alone. The other-site one is
 * lent for an hour each time İndir is pressed on such a site, so it says
 * nothing about whether the connection is alive -- a state built on it would
 * read "connected" for an hour after a download and "signed out" after that,
 * with nothing having changed. Its own line below says whether one is held.
 */
export function phaseOf(status: BridgeStatus): LinkPhase {
  if (!status.connected) return 'waiting';
  const sessions = [status.session, status.tiktokSession, status.redditSession, status.xSession];
  if (sessions.includes('fresh')) return 'connected';
  if (sessions.includes('stale')) return 'quiet';
  return 'signedOut';
}

/** What each site's line says about its session. */
export const SITE_STATE: Record<BridgeSessionState, TranslationKey> = {
  fresh: 'settings.linkSiteFresh',
  stale: 'settings.linkSiteStale',
  none: 'settings.linkSiteNone',
};

/**
 * The site the other-site sign-in is held for, or null when none is. Only a
 * fresh one is named: a lapsed one has already been deleted, and the line
 * then says there is none, as it does for a site never lent.
 */
export function otherSite(status: BridgeStatus): string | null {
  return status.otherSession === 'fresh' && status.otherDomain ? status.otherDomain : null;
}

/**
 * When the browser last handed a sign-in over, whichever site's it was: the
 * question the line answers is whether the connection is alive, and a push
 * from either says it is.
 */
export function lastRefreshed(status: BridgeStatus): number | null {
  const times = [status.lastPushAt, status.tiktokLastPushAt].filter(
    (time): time is number => time != null,
  );
  return times.length > 0 ? Math.max(...times) : null;
}

interface Presentation {
  icon: LucideIcon;
  iconClass: string;
  title: TranslationKey;
  body: TranslationKey;
}

const PHASES: Record<LinkPhase, Presentation> = {
  waiting: {
    icon: CircleDashed,
    iconClass: 'text-fg-muted',
    title: 'settings.linkWaiting',
    body: 'settings.linkWaitingHint',
  },
  signedOut: {
    icon: CircleAlert,
    iconClass: 'text-warning',
    title: 'settings.linkSignedOut',
    body: 'settings.linkSignedOutHint',
  },
  quiet: {
    icon: CircleAlert,
    iconClass: 'text-warning',
    title: 'settings.linkQuiet',
    body: 'settings.linkQuietHint',
  },
  connected: {
    icon: CircleCheck,
    iconClass: 'text-success',
    title: 'settings.linkConnected',
    body: 'settings.linkConnectedHint',
  },
};

/**
 * How long ago the browser last handed a sign-in over, in the reader's own
 * language. Relative rather than a timestamp: the question this line answers is
 * whether the connection is alive, and "three days ago" answers it where a date
 * and a time leave the arithmetic to the user.
 */
function relativeTime(epochSeconds: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
  ];

  let value = epochSeconds - Date.now() / 1000;
  for (const [unit, span] of steps) {
    if (Math.abs(value) < span) return format.format(Math.round(value), unit);
    value /= span;
  }
  return format.format(Math.round(value), 'year');
}

// The sizes a `SettingRow` sets its two lines in, so the rows of a group agree.
export const TITLE_SIZE = IS_MOBILE ? 'text-[15px]' : 'text-[13.5px]';
export const BODY_SIZE = IS_MOBILE ? 'text-[13px]' : 'text-[12.5px]';

interface BrowserLinkCardProps {
  settings: Settings;
  update: (patch: Partial<Settings>) => Promise<void>;
  /**
   * The state the Settings page read to decide that the section exists, so
   * the section opens whole rather than filling in a moment later.
   */
  initialStatus?: BridgeStatus | null;
}

export function BrowserLinkCard({ settings, update, initialStatus = null }: BrowserLinkCardProps) {
  const { t, language } = useTranslation();
  const status = useBridgeStatus(POLL_MS, initialStatus);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  const [copied, markCopied] = useMomentary();
  const [sending, setSending] = useState(false);

  // Disconnect makes the backend emit `bridge://changed`, so the card is
  // refreshed by the same path a push from the browser takes; there is no
  // second copy of the state here to keep in step. That refresh is also the
  // confirmation: the state above the buttons changes. Only a failure has to
  // be put into words, because it changes nothing.
  const disconnect = async () => {
    setProblem(null);
    setWorking(true);
    try {
      await ipc.bridgeDisconnect();
    } catch {
      setProblem('settings.linkDisconnectFailed');
    } finally {
      setWorking(false);
    }
  };

  // As Disconnect, the refresh that follows is the confirmation.
  const forget = async (site: BridgeSite) => {
    setProblem(null);
    try {
      await ipc.bridgeForgetSession(site);
    } catch {
      setProblem('settings.linkForgetFailed');
    }
  };

  const copyDiagnostics = async () => {
    setProblem(null);
    try {
      await navigator.clipboard.writeText(await ipc.bridgeDiagnostics());
      // Nothing on screen changes when text reaches the clipboard, so the
      // button itself says that it did.
      markCopied();
    } catch {
      setProblem('settings.linkDiagnosticsFailed');
    }
  };

  const phase = status ? phaseOf(status) : null;
  const look = phase ? PHASES[phase] : null;
  const StateIcon = look?.icon;
  const browser = status?.browser ?? t('settings.linkBrowserFallback');
  const refreshed = status ? lastRefreshed(status) : null;
  const other = status ? otherSite(status) : null;

  // "Chrome is connected" is not an answer when two Chrome windows are open, so
  // a connected link is headed by the profile as well whenever the extension
  // could see one.
  let title = look ? t(look.title, { browser }) : '';
  if (phase === 'connected' && status?.profileLabel) {
    title = t('settings.linkConnectedProfile', { browser, profile: status.profileLabel });
  }

  return (
    <>
      <SettingGroup>
        <ExtensionRow status={status} />
        {!IS_MOBILE && <ExtensionFolderRow />}
      </SettingGroup>

      <SettingGroup>
        <ToggleRow
          title={t('settings.browserLink')}
          description={t('settings.browserLinkShort')}
          checked={settings.browserLinkEnabled}
          onChange={(value) => void update({ browserLinkEnabled: value })}
        />

        <AnimatePresence initial={false}>
          {settings.browserLinkEnabled && (
            <motion.div
              variants={COLLAPSE}
              initial="initial"
              animate="animate"
              exit="exit"
              className="overflow-hidden"
            >
              {/* Nothing at all until the first read answers: an empty frame
                  that fills in a moment later is a flicker, not information. */}
              {status && look && StateIcon && (
                <div className={cn('px-4', IS_MOBILE ? 'py-4' : 'py-3.5')}>
                  <div className="flex items-start gap-2">
                    <StateIcon
                      size={16}
                      aria-hidden="true"
                      className={cn('mt-[2px] shrink-0', look.iconClass)}
                    />
                    <span className={cn('min-w-0 text-fg', TITLE_SIZE)}>{title}</span>
                  </div>

                  {/* A link that is working needs no paragraph to say so; one
                      that is not is explained where it is seen. */}
                  {phase !== 'connected' && (
                    <p className={cn('mt-1 leading-relaxed text-fg-muted', BODY_SIZE)}>
                      {t(look.body, { browser })}
                    </p>
                  )}

                  {/* Two Chrome windows look identical from here, so a link
                      the user cannot place is a link they cannot trust. */}
                  {phase === 'connected' && !status.profileLabel && (
                    <p className={cn('mt-1.5 leading-relaxed text-fg-muted', BODY_SIZE)}>
                      {t('settings.linkNoProfileName')}
                    </p>
                  )}

                  {/* All of these describe a browser that is bound; beside
                      "no browser connected" they would describe a ghost. */}
                  {status.connected &&
                    (status.accountHint || refreshed != null || status.extensionVersion) && (
                      <div
                        className={cn(
                          'mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-fg-muted',
                          BODY_SIZE,
                        )}
                      >
                        {status.accountHint && (
                          <span>{t('settings.linkAccount', { account: status.accountHint })}</span>
                        )}
                        {refreshed != null && (
                          <span>
                            {t('settings.linkRefreshed', {
                              when: relativeTime(refreshed, language),
                            })}
                          </span>
                        )}
                        {status.extensionVersion && (
                          <span className="tabular">
                            {t('settings.linkExtensionVersion', {
                              version: status.extensionVersion,
                            })}
                          </span>
                        )}
                      </div>
                    )}

                  {/* One line per site the browser can lend a sign-in for,
                      because the extension has a switch for each and the
                      state above only says whether any of them is working.
                      The names are the sites' own and are not translated. */}
                  {status.connected && (
                    <>
                      <dl
                        className={cn(
                          'mt-2.5 grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1.5',
                          BODY_SIZE,
                        )}
                      >
                        {(
                          [
                            ['youtube', 'YouTube', status.session],
                            ['tiktok', 'TikTok', status.tiktokSession],
                            ['reddit', 'Reddit', status.redditSession ?? 'none'],
                            ['x', 'X', status.xSession ?? 'none'],
                          ] as const
                        ).map(([site, name, state]) => (
                          <SiteRow
                            key={site}
                            name={name}
                            fresh={state === 'fresh'}
                            label={t(SITE_STATE[state])}
                            onForget={state === 'none' ? null : () => void forget(site)}
                          />
                        ))}
                        {/* Whichever site İndir last lent a sign-in for,
                            named by its domain while it is held. */}
                        <SiteRow
                          name={t('settings.linkOtherSites')}
                          fresh={other != null}
                          label={
                            other
                              ? t('settings.linkOtherFresh', { site: other })
                              : t('settings.linkSiteNone')
                          }
                          onForget={other != null ? () => void forget('other') : null}
                        />
                      </dl>
                      {/* TikTok's switch is new and off until turned on, so
                          the one place that says it exists is here, beside
                          the line that says it is not in use. */}
                      {status.tiktokSession === 'none' && (
                        <p className={cn('mt-1.5 leading-relaxed text-fg-muted', BODY_SIZE)}>
                          {t('settings.linkTiktokHint')}
                        </p>
                      )}
                    </>
                  )}

                  {/* Quiet buttons have no fill to line up, so the row is
                      pulled out by their padding and the first label starts
                      where the text above it does. */}
                  <div className="-ml-3 mt-3 flex flex-wrap items-center gap-2">
                    {sendableSites(status).length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Smartphone size={13} />}
                        onClick={() => setSending(true)}
                      >
                        {t('transfer.send')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={copied ? <Check size={13} /> : <Copy size={13} />}
                      onClick={() => void copyDiagnostics()}
                    >
                      {t('settings.linkCopyDiagnostics')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={working}
                      onClick={() => void disconnect()}
                    >
                      {t('settings.linkDisconnect')}
                    </Button>
                    {/* The check is for the eye; this is the same news for a
                        screen reader. */}
                    {copied && (
                      <span role="status" className="sr-only">
                        {t('settings.linkDiagnosticsCopied')}
                      </span>
                    )}
                  </div>

                  {problem && (
                    <InlineNotice tone="error" className="mt-2">
                      {t(problem)}
                    </InlineNotice>
                  )}

                  <SendToPhoneModal
                    open={sending}
                    onClose={() => setSending(false)}
                    status={status}
                  />
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Everything worth knowing about the link that is not its state:
            said in full, to whoever asks. Above, only what is so right now. */}
        {settings.browserLinkEnabled && (
          <>
            <Disclosure title={t('settings.linkWhereKept')}>
              <p>{t('settings.browserLinkHint')}</p>
              <p className="mt-1.5">{t('settings.linkConnectedHint')}</p>
            </Disclosure>
            {/* The failure this design is most prone to, and the one a user
                reads as "the connection is broken" unless the app names it. */}
            <Disclosure
              title={
                <span className="flex items-center gap-1.5">
                  <TriangleAlert size={14} aria-hidden="true" className="shrink-0 text-warning" />
                  {t('settings.linkSecondAccount')}
                </span>
              }
            >
              <p>{t('settings.linkSecondAccountHint')}</p>
            </Disclosure>
            <Disclosure title={t('settings.linkDiagnosticsWhat')}>
              <p>{t('settings.linkDiagnosticsHint')}</p>
            </Disclosure>
          </>
        )}
      </SettingGroup>
    </>
  );
}

/**
 * One site's line: its name, whether a sign-in is held, and a quiet way to
 * remove it. Removing keeps the browser connected; the extension turns that
 * site's switch off when it next hears from the app.
 */
export function SiteRow({
  name,
  fresh,
  label,
  onForget,
}: {
  name: string;
  fresh: boolean;
  label: string;
  onForget: (() => void) | null;
}) {
  const { t } = useTranslation();
  return (
    <>
      <dt className="text-fg">{name}</dt>
      <dd className="flex min-w-0 items-center justify-end gap-1.5">
        <SiteState fresh={fresh}>{label}</SiteState>
        {onForget ? (
          <button
            type="button"
            onClick={onForget}
            aria-label={t('settings.linkForgetSite', { site: name })}
            title={t('settings.linkForgetSite', { site: name })}
            className="rounded-md px-1.5 py-0.5 text-[12px] text-fg-faint transition-colors hover:bg-fill hover:text-fg-muted"
          >
            {t('settings.linkForget')}
          </button>
        ) : (
          // Holds the place, so the marks of every row line up.
          <span aria-hidden="true" className="invisible px-1.5 py-0.5 text-[12px]">
            {t('settings.linkForget')}
          </span>
        )}
      </dd>
    </>
  );
}

/** A site's sign-in, as a mark that can be told apart at a glance. */
function SiteState({ fresh, children }: { fresh: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-block max-w-full truncate rounded-full px-2 py-px align-middle text-[12px] font-medium',
        fresh ? 'bg-success-soft text-success' : 'bg-fill text-fg-muted',
      )}
    >
      {children}
    </span>
  );
}

/** A row that opens onto an explanation, for what is true but not news. */
export function Disclosure({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex w-full items-center gap-2 px-4 text-left text-fg-muted hover:text-fg',
          IS_MOBILE ? 'py-3.5' : 'py-2.5',
          BODY_SIZE,
        )}
      >
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={cn('shrink-0 transition-transform duration-150', open && 'rotate-90')}
        />
        <span className="min-w-0 font-medium">{title}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            variants={COLLAPSE}
            initial="initial"
            animate="animate"
            exit="exit"
            className="overflow-hidden"
          >
            <div className={cn('px-4 pb-3 pl-10 leading-relaxed text-fg-muted', BODY_SIZE)}>
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * What the extension's row offers under or beside its description: the way to
 * the store listing, the note that there is none yet, or nothing.
 *
 * A bound profile is the one proof the app has that the extension is
 * installed, so once there is one the row stops asking for it; "Get the
 * extension" above "Signed in through Chrome" would contradict itself. Without
 * a binding the extension may well be there, since it hands videos over
 * without one, but the app cannot tell, so the way to it stays.
 */
export type ExtensionOffer = 'store' | 'storePending' | null;

export function extensionOffer(status: BridgeStatus | null): ExtensionOffer {
  if (!status || status.connected) return null;
  return status.storeListed ? 'store' : 'storePending';
}

/**
 * The extension itself: what it does, and where to get it.
 *
 * It hands the browser's videos over whether or not the sign-ins are on, so
 * it has a row of its own above the switch. That makes this row the
 * place for a browser that can no longer start the helper as well: that stops
 * both, so it is shown whatever the switch says.
 */
function ExtensionRow({ status }: { status: BridgeStatus | null }) {
  const { t } = useTranslation();
  const [repairing, setRepairing] = useState(false);
  const [repairFailed, setRepairFailed] = useState(false);
  const offer = extensionOffer(status);

  // A repair that worked makes the backend emit `bridge://changed`, and the
  // row turning back into the extension's is the confirmation. Only a failure
  // has to be put into words, because it changes nothing.
  const repair = async () => {
    setRepairFailed(false);
    setRepairing(true);
    try {
      const next = await ipc.bridgeRepair();
      if (!next.registered) setRepairFailed(true);
    } catch {
      setRepairFailed(true);
    } finally {
      setRepairing(false);
    }
  };

  if (status && !status.registered) {
    return (
      <div className={cn('px-4', IS_MOBILE ? 'py-4' : 'py-3.5')}>
        <div className="flex items-start gap-2">
          <CircleAlert size={16} aria-hidden="true" className="mt-[2px] shrink-0 text-error" />
          <span className={cn('min-w-0 text-fg', TITLE_SIZE)}>{t('settings.linkBroken')}</span>
        </div>
        <p className={cn('mt-1 leading-relaxed text-fg-muted', BODY_SIZE)}>
          {t('settings.linkBrokenHint')}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" loading={repairing} onClick={() => void repair()}>
            {t('settings.linkRepair')}
          </Button>
        </div>
        {repairFailed && (
          <InlineNotice tone="error" className="mt-2">
            {t('settings.linkRepairFailed')}
          </InlineNotice>
        )}
      </div>
    );
  }

  return (
    <SettingRow
      title={t('settings.browserExtension')}
      description={
        offer === 'storePending' ? (
          <>
            {t('settings.browserExtensionHint')}
            <span className="mt-1 block">{t('settings.linkStorePending')}</span>
          </>
        ) : (
          t('settings.browserExtensionHint')
        )
      }
      control={
        offer === 'store' && status ? (
          <Button
            size="sm"
            variant="secondary"
            iconRight={<ExternalLink size={13} />}
            onClick={() =>
              void openUrl(`https://chromewebstore.google.com/detail/${status.extensionId}`)
            }
          >
            {t('settings.linkGetExtension')}
          </Button>
        ) : undefined
      }
    />
  );
}

/**
 * The folder the app keeps the unpacked extension in. Loaded from there, the
 * extension is updated whenever the app is: every launch rewrites the folder,
 * and the extension reloads itself when it sees the new version.
 */
function ExtensionFolderRow() {
  const { t } = useTranslation();
  const [folder, setFolder] = useState<ExtensionFolder | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, markCopied] = useMomentary();

  useEffect(() => {
    let live = true;
    ipc
      .extensionFolder()
      .then((found) => live && setFolder(found))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const open = async () => {
    setFailed(false);
    try {
      await ipc.openExtensionDir();
    } catch {
      setFailed(true);
    }
  };

  const copy = async () => {
    if (!folder) return;
    try {
      await navigator.clipboard.writeText(folder.path);
      markCopied();
    } catch {
      setFailed(true);
    }
  };

  return (
    <>
      <SettingRow
        stacked
        title={t('settings.extensionFolder')}
        description={t('settings.extensionFolderHint')}
      >
        {folder && (
          <div className="flex min-w-0 items-center gap-1.5">
            <code
              className="min-w-0 flex-1 truncate rounded-md bg-fill px-2 py-1 font-mono text-[12px] text-fg-muted select-text"
              title={folder.path}
            >
              {folder.path}
            </code>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('settings.extensionFolderCopy')}
              title={t('settings.extensionFolderCopy')}
              className="px-2"
              icon={copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
              onClick={() => void copy()}
            />
            <Button
              size="sm"
              variant="secondary"
              icon={<FolderOpen size={13} />}
              onClick={() => void open()}
            >
              {t('settings.extensionFolderOpen')}
            </Button>
          </div>
        )}
        {folder?.version && (
          <p className={cn('text-fg-faint', BODY_SIZE)}>
            {t('settings.extensionFolderVersion', { version: folder.version })}
          </p>
        )}
        {failed && <InlineNotice tone="error">{t('settings.extensionFolderFailed')}</InlineNotice>}
      </SettingRow>
      {folder && <FirefoxAddonRow file={folder.firefoxPath ?? null} />}
    </>
  );
}

/** Where Firefox users install the add-on, which AMO then keeps up to date. */
const AMO_LISTING = 'https://addons.mozilla.org/firefox/addon/connector@umdplus.app/';

/**
 * The Firefox add-on. Release Firefox will not keep an unpacked one past a
 * restart, so it is installed either from addons.mozilla.org, which keeps it
 * up to date, or from the signed file a build carries, which Firefox updates
 * from the release.
 */
function FirefoxAddonRow({ file }: { file: string | null }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);

  const reveal = async () => {
    setFailed(false);
    try {
      await ipc.revealFirefoxAddon();
    } catch {
      setFailed(true);
    }
  };

  return (
    <SettingRow
      stacked
      title={t('settings.firefoxAddon')}
      description={t(file ? 'settings.firefoxAddonHint' : 'settings.firefoxAddonAmo')}
      control={
        <Button
          size="sm"
          variant="secondary"
          iconRight={<ExternalLink size={13} />}
          onClick={() => void openUrl(AMO_LISTING)}
        >
          {t('settings.firefoxAddonOpen')}
        </Button>
      }
    >
      {file && (
        <div className="flex min-w-0 items-center gap-1.5">
          <code
            className="min-w-0 flex-1 truncate rounded-md bg-fill px-2 py-1 font-mono text-[12px] text-fg-muted select-text"
            title={file}
          >
            {file}
          </code>
          <Button
            size="sm"
            variant="secondary"
            icon={<FolderOpen size={13} />}
            onClick={() => void reveal()}
          >
            {t('settings.firefoxAddonShow')}
          </Button>
        </div>
      )}
      {failed && <InlineNotice tone="error">{t('settings.firefoxAddonFailed')}</InlineNotice>}
    </SettingRow>
  );
}
