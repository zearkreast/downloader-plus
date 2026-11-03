import { motion } from 'motion/react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Gauge,
  Keyboard,
  Link2,
  Palette,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BrowserLinkCard, useBridgeStatus } from '@/components/settings/BrowserLinkCard';
import { HotkeyRecorder } from '@/components/settings/HotkeyRecorder';
import { ToolCard } from '@/components/settings/ToolCard';
import { Button } from '@/components/ui/Button';
import { Dropdown } from '@/components/ui/Dropdown';
import { InlineNotice } from '@/components/ui/InlineNotice';
import { ListGroup } from '@/components/ui/ListGroup';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Segmented } from '@/components/ui/Segmented';
import { SettingGroup, SettingRow, ToggleRow } from '@/components/ui/SettingRow';
import { Slider } from '@/components/ui/Slider';
import { TextInput } from '@/components/ui/TextInput';
import { Tooltip } from '@/components/ui/Tooltip';
import { useMomentary } from '@/hooks/useMomentary';
import { LANGUAGES, translate, useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { cn } from '@/lib/cn';
import { containersFor, decodeQuality, encodeQuality, fitContainer } from '@/lib/downloadOptions';
import { formatBytes, formatSpeed, truncateMiddle } from '@/lib/format';
import { SPRING, T } from '@/lib/motion';
import { IS_MOBILE } from '@/lib/platform';
import * as ipc from '@/services/ipc';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useToolsStore } from '@/stores/useToolsStore';
import type {
  CacheStats,
  DownloadMode,
  HotkeyAction,
  QualityPreference,
  LanguageCode,
  Settings,
  ThemePreference,
  ToolKind,
} from '@/types';

export type SettingsSection =
  | 'general'
  | 'downloads'
  | 'connection'
  | 'appearance'
  | 'performance'
  | 'shortcuts'
  | 'advanced';

const ALL_SECTIONS: {
  id: SettingsSection;
  label: TranslationKey;
  summary: TranslationKey;
  icon: typeof Sparkles;
}[] = [
  { id: 'general', label: 'settings.general', summary: 'settings.generalSummary', icon: Sparkles },
  // Second, not further down: this is the only place left to switch between
  // light and dark, so it is kept where it is seen without looking for it.
  {
    id: 'appearance',
    label: 'settings.appearance',
    summary: 'settings.appearanceSummary',
    icon: Palette,
  },
  {
    id: 'downloads',
    label: 'settings.downloads',
    summary: 'settings.downloadsSummary',
    icon: FolderOpen,
  },
  {
    id: 'connection',
    label: 'settings.connection',
    summary: 'settings.connectionSummary',
    icon: Link2,
  },
  {
    id: 'performance',
    label: 'settings.performance',
    summary: 'settings.performanceSummary',
    icon: Gauge,
  },
  { id: 'shortcuts', label: 'settings.hotkeys', summary: 'settings.hotkeys', icon: Keyboard },
  {
    id: 'advanced',
    label: 'settings.advanced',
    summary: 'settings.advancedSummary',
    icon: SlidersHorizontal,
  },
];

/** Mirrors the defaults in `settings.rs`, for the per-hotkey reset button. */
const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  pasteUrl: 'Ctrl+V',
  download: 'Ctrl+Enter',
  openDownloads: 'Ctrl+Shift+D',
  openHistory: 'Ctrl+Shift+H',
  openSettings: 'Ctrl+,',
};

/**
 * A default quality that belongs to the default type: a height means nothing
 * for audio, nor a bitrate for video, and Auto -- the best picture that needs
 * no merge -- is a video choice.
 */
function fitDefaultQuality(quality: QualityPreference, mode: DownloadMode): QualityPreference {
  if (mode === 'audio' && (quality.type === 'maxHeight' || quality.type === 'auto')) {
    return { type: 'best' };
  }
  if (mode === 'video' && quality.type === 'audioBitrate') return { type: 'best' };
  return quality;
}

const VIDEO_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];
const AUDIO_BITRATES = [320, 256, 192, 128];

/** A control's width beside its label on the desktop; a phone gives it the row. */
function controlWidth(desktop: string): string {
  return IS_MOBILE ? 'w-full' : desktop;
}

interface SettingsPageProps {
  settings: Settings;
  /**
   * On a phone, the section open on its own page, or null for the list of
   * sections. Owned by the app so the Back gesture can close it. On the
   * desktop, the section to open at, when something elsewhere pointed here --
   * the sections themselves are switched in place.
   */
  section?: SettingsSection | null;
  onSectionChange?: (section: SettingsSection | null) => void;
}

export function SettingsPage({ settings, section: openSection, onSectionChange }: SettingsPageProps) {
  const { t } = useTranslation();
  const update = useSettingsStore((state) => state.update);
  const reset = useSettingsStore((state) => state.reset);
  // Opened at the section asked for from the first frame, rather than at
  // General and then moved: an effect alone would show General first and
  // then slide the other in, as if the user had asked twice.
  const [desktopSection, setDesktopSection] = useState<SettingsSection>(
    () => (!IS_MOBILE && openSection) || 'general',
  );
  useEffect(() => {
    if (!IS_MOBILE && openSection) setDesktopSection(openSection);
  }, [openSection]);
  const [confirmReset, setConfirmReset] = useState(false);
  const link = useBridgeStatus();

  /**
   * Which sections exist on this machine. This used to be settled once at
   * module scope; Connection cannot be, because whether it is offered depends
   * on what the backend answers.
   */
  const sections = useMemo(
    () =>
      ALL_SECTIONS.filter((candidate) => {
        // Keyboard shortcuts mean nothing without a keyboard.
        if (candidate.id === 'shortcuts') return !IS_MOBILE;
        // The browser extension is a desktop feature. Whether it has a
        // published listing decides what the section OFFERS, not whether it
        // exists: hiding it outright would also hide a link that is already
        // working, which is the state every install is in before the listing
        // is approved.
        if (candidate.id === 'connection') {
          return !IS_MOBILE && link != null && link.supported;
        }
        return true;
      }),
    [link],
  );

  const section = IS_MOBILE ? (openSection ?? null) : desktopSection;
  const entry = sections.find((candidate) => candidate.id === section);

  // The screen change has already brought the page in; what is animated here is
  // only a change of section after that, which the user asked for.
  const opened = useRef(false);
  useEffect(() => {
    opened.current = true;
  }, []);
  const arrive = opened.current ? { opacity: 0, y: 6 } : false;

  const content = section && (
    <motion.div
      key={section}
      initial={arrive}
      animate={{ opacity: 1, y: 0 }}
      transition={T.component}
      className="min-w-0 flex-1 space-y-6"
    >
      {section === 'general' && <GeneralSection settings={settings} update={update} />}
      {section === 'downloads' && <DownloadsSection settings={settings} update={update} />}
      {section === 'connection' && (
        <BrowserLinkCard settings={settings} update={update} initialStatus={link} />
      )}
      {section === 'appearance' && <AppearanceSection settings={settings} update={update} />}
      {section === 'performance' && <PerformanceSection settings={settings} update={update} />}
      {section === 'shortcuts' && <ShortcutsSection settings={settings} update={update} />}
      {section === 'advanced' && (
        <AdvancedSection
          settings={settings}
          update={update}
          onRequestReset={() => setConfirmReset(true)}
        />
      )}
    </motion.div>
  );

  const resetModal = (
    <Modal
      open={confirmReset}
      onClose={() => setConfirmReset(false)}
      title={t('settings.resetConfirm')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="ghost" onClick={() => setConfirmReset(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            data-autofocus
            onClick={async () => {
              await reset();
              setConfirmReset(false);
            }}
          >
            {t('settings.resetSettings')}
          </Button>
        </>
      }
    />
  );

  if (IS_MOBILE) {
    // A phone shows the sections as a list of large rows, and each one opens
    // on a page of its own -- the pattern of the phone's own Settings app. A
    // strip of small tabs scrolling sideways was hard to hit, and easy to
    // scroll when a tap was meant.
    return (
      <div className="mx-auto flex w-full max-w-[880px] flex-col px-4 pb-12">
        {entry ? (
          <>
            {/* Stands in for the screen's own bar, which the shell takes away
                while a section is open: the same height, and the page's heading. */}
            <div className="sticky top-0 z-10 -mx-4 mb-2 flex h-12 items-center gap-1 bg-bg px-1.5">
              <button
                type="button"
                onClick={() => onSectionChange?.(null)}
                aria-label={t('common.back')}
                className="pressable-sm flex size-11 shrink-0 items-center justify-center rounded-full text-fg active:bg-surface-active"
              >
                <ChevronLeft size={24} />
              </button>
              <h1 className="truncate text-[17px] font-semibold tracking-[-0.01em] text-fg">
                {t(entry.label)}
              </h1>
            </div>
            {content}
          </>
        ) : (
          <motion.nav
            initial={arrive}
            animate={{ opacity: 1, y: 0 }}
            transition={T.component}
            aria-label={t('settings.title')}
            className="mt-4"
          >
            {/* 16 padding + 36 tile + 14 gap: the hairlines start under the text. */}
            <ListGroup inset={66}>
              {sections.map((candidate) => {
                const Icon = candidate.icon;
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => onSectionChange?.(candidate.id)}
                    className="flex min-h-[68px] w-full items-center gap-3.5 px-4 py-3 text-left transition-colors duration-150 ease-out-quint active:bg-fill"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-fill text-fg-muted">
                      <Icon size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] text-fg">{t(candidate.label)}</span>
                      <span className="mt-0.5 block truncate text-[13px] text-fg-muted">
                        {t(candidate.summary)}
                      </span>
                    </span>
                    <ChevronRight size={18} className="shrink-0 text-fg-faint" />
                  </button>
                );
              })}
            </ListGroup>
          </motion.nav>
        )}
        {resetModal}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[840px] px-6 pb-12">
      <PageHeader title={t('settings.title')} />

      <div className="flex gap-7">
        {/* Words only. The app's own sidebar stands right beside this list, and
            a second column of icons next to the first is a lot to look at. */}
        <nav
          className="sticky top-6 flex h-fit w-[148px] shrink-0 flex-col gap-0.5"
          aria-label={t('settings.title')}
        >
          {sections.map((candidate) => {
            const active = section === candidate.id;
            return (
              <button
                key={candidate.id}
                type="button"
                onClick={() => setDesktopSection(candidate.id)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'relative flex h-[34px] w-full items-center rounded-[8px] px-2.5 text-left text-[13px] font-medium',
                  'transition-colors duration-150 ease-out-quint',
                  active ? 'text-fg' : 'text-fg-muted hover:bg-fill hover:text-fg',
                )}
              >
                {active && (
                  <motion.span
                    layoutId="settings-active"
                    transition={SPRING.glide}
                    className="absolute inset-0 rounded-[8px] bg-fill-active"
                  >
                    <span className="brand-track absolute left-0 top-1/2 h-3.5 w-[3px] -translate-y-1/2 rounded-r-full" />
                  </motion.span>
                )}
                <span className="relative z-10 truncate">{t(candidate.label)}</span>
              </button>
            );
          })}
        </nav>

        {content}
      </div>
      {resetModal}
    </div>
  );
}

type UpdateFn = (patch: Partial<Settings>) => Promise<void>;

function GeneralSection({ settings, update }: { settings: Settings; update: UpdateFn }) {
  const { t } = useTranslation();

  return (
    <>
      <SettingGroup>
        {!IS_MOBILE && (
          <>
            <ToggleRow
              title={t('settings.startWithWindows')}
              description={t('settings.startWithWindowsHint')}
              checked={settings.startWithWindows}
              onChange={(value) => void update({ startWithWindows: value })}
            />
            <ToggleRow
              title={t('settings.minimizeToTray')}
              description={t('settings.minimizeToTrayHint')}
              checked={settings.minimizeToTray}
              onChange={(value) => void update({ minimizeToTray: value })}
            />
            <ToggleRow
              title={t('settings.closeToTray')}
              description={t('settings.closeToTrayHint')}
              checked={settings.closeToTray}
              onChange={(value) => void update({ closeToTray: value })}
            />
          </>
        )}
        <ToggleRow
          title={t('settings.clipboard')}
          description={t('settings.clipboardHint')}
          checked={settings.clipboardMonitoring}
          onChange={(value) => void update({ clipboardMonitoring: value })}
        />
      </SettingGroup>

      <SettingGroup title={t('settings.notifications')}>
        <ToggleRow
          title={t('settings.notifications')}
          description={t('settings.notificationsHint')}
          checked={settings.notificationsEnabled}
          onChange={(value) => void update({ notificationsEnabled: value })}
        />
        <ToggleRow
          title={t('settings.notifyComplete')}
          checked={settings.notifyOnComplete}
          disabled={!settings.notificationsEnabled}
          onChange={(value) => void update({ notifyOnComplete: value })}
        />
        <ToggleRow
          title={t('settings.notifyError')}
          checked={settings.notifyOnError}
          disabled={!settings.notificationsEnabled}
          onChange={(value) => void update({ notifyOnError: value })}
        />
      </SettingGroup>
    </>
  );
}

function DownloadsSection({ settings, update }: { settings: Settings; update: UpdateFn }) {
  const { t } = useTranslation();
  const [template, setTemplate] = useState(settings.filenameTemplate);
  const [preview, setPreview] = useState('');

  useEffect(() => setTemplate(settings.filenameTemplate), [settings.filenameTemplate]);

  // The preview comes from the same renderer the downloader uses, so what is
  // shown here is exactly the name a file will get.
  useEffect(() => {
    let active = true;
    ipc.previewFilename(template).then((value) => {
      if (active) setPreview(value);
    });
    return () => {
      active = false;
    };
  }, [template]);

  const pickFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: settings.downloadDir,
    });
    if (typeof selected === 'string') void update({ downloadDir: selected });
  };

  return (
    <>
      <SettingGroup>
        <SettingRow
          title={t('settings.downloadDir')}
          description={
            IS_MOBILE ? (
              <>
                <span className="block [overflow-wrap:anywhere]">{settings.downloadDir}</span>
                <span className="mt-1 block">{t('settings.downloadDirMobileHint')}</span>
              </>
            ) : (
              <Tooltip label={settings.downloadDir}>
                <span>{truncateMiddle(settings.downloadDir, 52)}</span>
              </Tooltip>
            )
          }
          control={
            // The Android folder picker hands back a document tree, not a
            // path the downloader could write to, so the folder is fixed there.
            IS_MOBILE ? undefined : (
              <Button size="sm" variant="secondary" onClick={pickFolder}>
                {t('settings.browse')}
              </Button>
            )
          }
        />

        <SettingRow
          title={t('settings.defaultMode')}
          stacked={IS_MOBILE}
          control={
            <div className={controlWidth('w-[220px]')}>
              <Segmented
                value={settings.defaultMode}
                options={[
                  { value: 'video', label: t('options.modeVideo') },
                  { value: 'audio', label: t('options.modeAudio') },
                ]}
                // The quality and the container are chosen for a kind of file,
                // so they follow the type: an MP4 container or a 1080p ceiling
                // kept for audio used to be applied to every song.
                onChange={(value) => {
                  const mode = value as DownloadMode;
                  void update({
                    defaultMode: mode,
                    defaultQuality: fitDefaultQuality(settings.defaultQuality, mode),
                    defaultContainer: fitContainer(settings.defaultContainer, mode),
                  });
                }}
                size="sm"
              />
            </div>
          }
        />

        <SettingRow
          title={t('settings.defaultQuality')}
          stacked={IS_MOBILE}
          control={
            <div className={controlWidth('w-[200px]')}>
              <Dropdown
                value={encodeQuality(fitDefaultQuality(settings.defaultQuality, settings.defaultMode))}
                options={
                  settings.defaultMode === 'audio'
                    ? [
                        { value: 'best', label: t('options.audioBest') },
                        ...AUDIO_BITRATES.map((kbps) => ({ value: `a:${kbps}`, label: `${kbps} kbps` })),
                      ]
                    : [
                        { value: 'best', label: t('options.qualityBest') },
                        { value: 'auto', label: t('options.qualityAuto') },
                        ...VIDEO_HEIGHTS.map((height) => ({ value: `h:${height}`, label: `${height}p` })),
                      ]
                }
                onChange={(key) => void update({ defaultQuality: decodeQuality(key) })}
              />
            </div>
          }
        />

        <SettingRow
          title={t('settings.defaultContainer')}
          stacked={IS_MOBILE}
          control={
            <div className={controlWidth('w-[200px]')}>
              <Dropdown
                value={fitContainer(settings.defaultContainer, settings.defaultMode) ?? ''}
                options={[
                  { value: '', label: t('settings.containerKeep') },
                  ...containersFor(settings.defaultMode).map((container) => ({
                    value: container,
                    label: container.toUpperCase(),
                  })),
                ]}
                onChange={(value) => void update({ defaultContainer: value || null })}
              />
            </div>
          }
        />

        <SettingRow
          title={t('settings.maxConcurrent')}
          description={t('settings.maxConcurrentHint')}
          stacked={IS_MOBILE}
          control={
            <div className={controlWidth('w-[180px]')}>
              <Slider
                value={settings.maxConcurrentDownloads}
                min={1}
                max={10}
                onChange={(value) => void update({ maxConcurrentDownloads: value })}
                formatValue={(value) => String(value)}
              />
            </div>
          }
        />

        <SettingRow
          title={t('settings.connections')}
          description={
            // Low resource mode holds every download to two, whatever this
            // says; the row says so rather than show a number that is not used.
            settings.lowResourceMode
              ? `${t('settings.connectionsHint')} ${t('settings.connectionsCapped')}`
              : t('settings.connectionsHint')
          }
          stacked={IS_MOBILE}
          control={
            <div className={controlWidth('w-[180px]')}>
              <Slider
                value={settings.connectionsPerDownload}
                min={1}
                max={32}
                onChange={(value) => void update({ connectionsPerDownload: value })}
                formatValue={(value) => String(value)}
              />
            </div>
          }
        />

        <HostLimitsRow />

        <SettingRow
          title={t('settings.speedLimit')}
          description={t('settings.speedLimitHint')}
          stacked={IS_MOBILE}
          control={
            <div className={controlWidth('w-[200px]')}>
              <Dropdown
                value={String(settings.speedLimitKb)}
                options={speedLimitOptions(settings.speedLimitKb)}
                onChange={(value) => void update({ speedLimitKb: Number(value) })}
              />
            </div>
          }
        />

        <ToggleRow
          title={t('settings.schedule')}
          description={t('settings.scheduleHint')}
          checked={settings.scheduleEnabled}
          onChange={(checked) => void update({ scheduleEnabled: checked })}
        />

        {settings.scheduleEnabled && (
          <SettingRow
            title={t('settings.scheduleHours')}
            stacked={IS_MOBILE}
            control={
              <div className={cn('flex items-center gap-2', controlWidth('w-[240px]'))}>
                <TextInput
                  type="time"
                  value={settings.scheduleStart}
                  onChange={(event) => {
                    // A time being typed reads as empty until it is whole.
                    if (event.target.value) void update({ scheduleStart: event.target.value });
                  }}
                  aria-label={t('settings.scheduleStart')}
                />
                <span className="text-fg-muted" aria-hidden="true">
                  –
                </span>
                <TextInput
                  type="time"
                  value={settings.scheduleEnd}
                  onChange={(event) => {
                    if (event.target.value) void update({ scheduleEnd: event.target.value });
                  }}
                  aria-label={t('settings.scheduleEnd')}
                />
              </div>
            }
          />
        )}

        <ToggleRow
          title={t('settings.embedMetadata')}
          description={t('settings.embedMetadataHint')}
          checked={settings.embedMetadata}
          onChange={(checked) => void update({ embedMetadata: checked })}
        />

        <SettingRow
          title={t('settings.autoRetry')}
          description={t('settings.autoRetryHint')}
          stacked={IS_MOBILE}
          control={
            <div className={controlWidth('w-[180px]')}>
              <Slider
                value={settings.autoRetryCount}
                min={0}
                max={10}
                onChange={(value) => void update({ autoRetryCount: value })}
                formatValue={(value) => String(value)}
              />
            </div>
          }
        />

        <SettingRow
          title={t('settings.filenameTemplate')}
          description={t('settings.filenameTemplateHint')}
          stacked
          control={
            <div className="space-y-2">
              <TextInput
                value={template}
                onChange={(event) => setTemplate(event.target.value)}
                onBlur={() => void update({ filenameTemplate: template })}
                aria-label={t('settings.filenameTemplate')}
              />
              <p className={cn('truncate text-fg-muted', IS_MOBILE ? 'text-[13px]' : 'text-[12.5px]')}>
                {t('settings.filenamePreview')}: {preview}
              </p>
            </div>
          }
        />
      </SettingGroup>
    </>
  );
}

/** Shown only once a host has turned connections away, and until that is reset. */
function HostLimitsRow() {
  const { t } = useTranslation();
  const [count, setCount] = useState(0);
  useEffect(() => {
    ipc.hostLimitCount().then(setCount).catch(() => {});
  }, []);
  if (count === 0) return null;

  return (
    <SettingRow
      title={t('settings.hostLimits')}
      description={t('settings.hostLimitsHint', { n: count })}
      control={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setCount(0);
            void ipc.forgetHostLimits();
          }}
        >
          {t('settings.hostLimitsReset')}
        </Button>
      }
    />
  );
}

const SPEED_LIMITS_KB = [256, 512, 1024, 2048, 5120, 10240, 20480, 51200, 102400];

/** The limits on offer, plus the current one if it was set some other way. */
function speedLimitOptions(current: number) {
  const limits = [...new Set([...SPEED_LIMITS_KB, current])].filter((kb) => kb > 0).sort((a, b) => a - b);
  return [
    { value: '0', label: translate('settings.speedLimitOff') },
    ...limits.map((kb) => ({ value: String(kb), label: formatSpeed(kb * 1024) })),
  ];
}

function AppearanceSection({ settings, update }: { settings: Settings; update: UpdateFn }) {
  const { t } = useTranslation();

  return (
    <SettingGroup>
      {/* The only place the theme is switched, so it leads the section and
          says in so many words that light and dark are what it chooses between. */}
      <SettingRow
        title={t('settings.theme')}
        description={t('settings.themeHint')}
        stacked={IS_MOBILE}
        control={
          <div className={controlWidth('w-[240px]')}>
            <Segmented
              value={settings.theme}
              options={[
                { value: 'system', label: t('settings.themeSystem') },
                { value: 'light', label: t('settings.themeLight') },
                { value: 'dark', label: t('settings.themeDark') },
              ]}
              onChange={(theme) => void update({ theme: theme as ThemePreference })}
              size="sm"
            />
          </div>
        }
      />
      <SettingRow
        title={t('settings.language')}
        stacked={IS_MOBILE}
        control={
          <div className={controlWidth('w-[180px]')}>
            <Dropdown
              value={settings.language}
              options={LANGUAGES.map((entry) => ({ value: entry.code, label: entry.label }))}
              onChange={(language) => void update({ language: language as LanguageCode })}
            />
          </div>
        }
      />
      <ToggleRow
        title={t('settings.reduceMotion')}
        description={t('settings.reduceMotionHint')}
        checked={settings.reduceMotion}
        onChange={(value) => void update({ reduceMotion: value })}
      />
      {/* On a phone only low resource mode takes the glow away (see App), so
          the switch would have nothing to switch there. */}
      {!IS_MOBILE && (
        <ToggleRow
          title={t('settings.animatedBackground')}
          description={t('settings.animatedBackgroundHint')}
          checked={settings.showAnimatedBackground}
          onChange={(value) => void update({ showAnimatedBackground: value })}
        />
      )}
    </SettingGroup>
  );
}

function PerformanceSection({ settings, update }: { settings: Settings; update: UpdateFn }) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [cleared, markCleared] = useMomentary();
  const [clearError, setClearError] = useState<string | null>(null);

  const refreshStats = useCallback(() => {
    ipc.cacheStats().then(setStats).catch(() => setStats(null));
  }, []);

  useEffect(refreshStats, [refreshStats]);

  const clearCache = async () => {
    setClearError(null);
    try {
      await ipc.clearCache();
      refreshStats();
      // The usage figure a row up drops as well, but that is easy to miss, so
      // the button answers for itself.
      markCleared();
    } catch (caught) {
      setClearError(ipc.toAppError(caught).message);
    }
  };

  return (
    <SettingGroup>
      <ToggleRow
        title={t('settings.lowResource')}
        description={t('settings.lowResourceHint')}
        checked={settings.lowResourceMode}
        onChange={(value) => void update({ lowResourceMode: value })}
      />
      {/* The GPU pass is an NVIDIA encoder, which no phone has. */}
      {!IS_MOBILE && (
        <ToggleRow
          title={t('settings.hardwareAcceleration')}
          description={t('settings.hardwareAccelerationHint')}
          checked={settings.hardwareAcceleration}
          onChange={(value) => void update({ hardwareAcceleration: value })}
        />
      )}
      <SettingRow
        title={t('settings.cacheLimit')}
        stacked={IS_MOBILE}
        description={
          stats
            ? t('settings.cacheUsage', {
                used: formatBytes(stats.totalBytes),
                limit: formatBytes(settings.cacheLimitMb * 1024 * 1024),
              })
            : undefined
        }
        control={
          <div className={controlWidth('w-[200px]')}>
            <Slider
              value={settings.cacheLimitMb}
              min={32}
              max={2048}
              step={32}
              onChange={(value) => void update({ cacheLimitMb: value })}
              formatValue={(value) => `${value} MB`}
            />
          </div>
        }
      />
      <SettingRow
        title={t('settings.cacheTitle')}
        description={t('settings.cacheHint')}
        control={
          <Button
            size="sm"
            variant="secondary"
            icon={cleared ? <Check size={13} /> : <Trash2 size={13} />}
            onClick={() => void clearCache()}
          >
            {t('settings.clearCache')}
          </Button>
        }
      >
        {/* The check is for the eye; this is the same news for a screen reader. */}
        {cleared && (
          <span role="status" className="sr-only">
            {t('settings.cacheCleared')}
          </span>
        )}
        {clearError && (
          <InlineNotice tone="error" className="-mt-2 w-full">
            {clearError}
          </InlineNotice>
        )}
      </SettingRow>
    </SettingGroup>
  );
}

function ShortcutsSection({ settings, update }: { settings: Settings; update: UpdateFn }) {
  const { t } = useTranslation();
  const actions = Object.keys(DEFAULT_HOTKEYS) as HotkeyAction[];

  // Another action holding the combination, by name. The action being
  // recorded is left out: pressing its own keys again is not a clash with
  // itself. Compared as the shortcut is matched, so "ctrl+d" and "Ctrl+D"
  // are the same keys.
  const findConflict = useCallback(
    (accelerator: string, own: HotkeyAction) => {
      const wanted = accelerator.toLowerCase();
      const clash = actions.find(
        (action) =>
          action !== own &&
          (settings.hotkeys[action] ?? DEFAULT_HOTKEYS[action]).toLowerCase() === wanted,
      );
      return clash ? t(`hotkey.${clash}` as TranslationKey) : null;
    },
    [actions, settings.hotkeys, t],
  );

  return (
    <SettingGroup>
      {actions.map((action) => (
        <SettingRow
          key={action}
          title={t(`hotkey.${action}` as TranslationKey)}
          control={
            <HotkeyRecorder
              value={settings.hotkeys[action] ?? DEFAULT_HOTKEYS[action]}
              defaultValue={DEFAULT_HOTKEYS[action]}
              findConflict={(accelerator) => findConflict(accelerator, action)}
              onChange={(accelerator) =>
                void update({ hotkeys: { ...settings.hotkeys, [action]: accelerator } })
              }
            />
          }
        />
      ))}
      {/* Fixed rather than recorded: the numbers are the sidebar's order. */}
      <SettingRow
        title={t('settings.placeShortcuts')}
        description={t('settings.placeShortcutsHint')}
        control={<span className="kbd h-8 px-3 text-[12.5px] leading-8">Ctrl + 1 … 7</span>}
      />
    </SettingGroup>
  );
}

function AdvancedSection({
  settings,
  update,
  onRequestReset,
}: {
  settings: Settings;
  update: UpdateFn;
  onRequestReset: () => void;
}) {
  const { t } = useTranslation();
  const tools = useToolsStore((state) => state.tools);
  const installing = useToolsStore((state) => state.installing);
  const install = useToolsStore((state) => state.install);
  const checks = useToolsStore((state) => state.checks);
  const checkUpdate = useToolsStore((state) => state.checkUpdate);
  const [installErrors, setInstallErrors] = useState<Partial<Record<ToolKind, string>>>({});
  // The folder opening is its own answer; only a failure needs words, and they
  // go where the hint was, under the button that failed.
  const [logsFailed, setLogsFailed] = useState(false);

  const [proxy, setProxy] = useState(settings.proxyUrl ?? '');
  const [userAgent, setUserAgent] = useState(settings.customUserAgent ?? '');

  useEffect(() => setProxy(settings.proxyUrl ?? ''), [settings.proxyUrl]);
  useEffect(() => setUserAgent(settings.customUserAgent ?? ''), [settings.customUserAgent]);

  // A tool that installed says so itself: its row turns to the version it now
  // has. Only a failure needs words, and it gets them in the row it belongs to.
  const runInstall = async (tool: ToolKind) => {
    setInstallErrors((current) => ({ ...current, [tool]: undefined }));
    if (await install(tool)) return true;
    const message = useToolsStore.getState().error ?? t('error.network.message');
    setInstallErrors((current) => ({ ...current, [tool]: message }));
    return false;
  };

  // Asked first, fetched only when there is something newer. Once the new copy
  // is in, it is asked about again without a spinner, so the row can say it is
  // current rather than leave the user to trust that it is.
  const runUpdate = async (tool: ToolKind) => {
    setInstallErrors((current) => ({ ...current, [tool]: undefined }));
    if (!(await checkUpdate(tool))) return;
    if (await runInstall(tool)) void checkUpdate(tool, { quiet: true });
  };

  const engine = tools?.engine ?? {
    name: 'engine' as const,
    available: false,
    path: null,
    version: null,
    source: 'missing' as const,
  };
  const ffmpeg = tools?.ffmpeg ?? {
    name: 'ffmpeg' as const,
    available: false,
    path: null,
    version: null,
    source: 'missing' as const,
  };
  const jsRuntime = tools?.jsRuntime ?? {
    name: 'jsRuntime' as const,
    available: false,
    path: null,
    version: null,
    source: 'missing' as const,
  };

  return (
    <>
      <SettingGroup title={t('about.externalTools')}>
        <ToolCard
          status={engine}
          titleKey="settings.engine"
          hintKey="settings.engineHint"
          installing={installing.engine}
          installError={installErrors.engine}
          check={checks.engine}
          customPath={settings.enginePath}
          onInstall={() => void runInstall('engine')}
          onCheck={() => void runUpdate('engine')}
          onLocate={(path) => void update({ enginePath: path })}
          onResetPath={() => void update({ enginePath: null })}
        />
        <ToolCard
          status={ffmpeg}
          titleKey="settings.ffmpeg"
          hintKey="settings.ffmpegHint"
          installing={installing.ffmpeg}
          installError={installErrors.ffmpeg}
          check={checks.ffmpeg}
          customPath={settings.ffmpegPath}
          optionalNoteKey="setup.ffmpegOptional"
          onInstall={() => void runInstall('ffmpeg')}
          onCheck={() => void runUpdate('ffmpeg')}
          onLocate={(path) => void update({ ffmpegPath: path })}
          onResetPath={() => void update({ ffmpegPath: null })}
        />
        {/* The phone already carries a JavaScript engine inside the APK, so
            there is nothing here for it to offer. */}
        {!IS_MOBILE && (
          <ToolCard
            status={jsRuntime}
            titleKey="settings.jsRuntime"
            hintKey="settings.jsRuntimeHint"
            installing={installing.jsRuntime}
            installError={installErrors.jsRuntime}
            check={checks.jsRuntime}
            optionalNoteKey="settings.jsRuntimeOptional"
            optional
            onInstall={() => void runInstall('jsRuntime')}
            onCheck={() => void runUpdate('jsRuntime')}
          />
        )}
      </SettingGroup>

      <SettingGroup title={t('settings.advanced')}>
        <SettingRow
          title={t('settings.networkTimeout')}
          stacked={IS_MOBILE}
          control={
            <div className={controlWidth('w-[200px]')}>
              <Slider
                value={settings.networkTimeoutSec}
                min={5}
                max={180}
                step={5}
                onChange={(value) => void update({ networkTimeoutSec: value })}
                formatValue={(value) => t('common.seconds', { n: value })}
              />
            </div>
          }
        />
        <SettingRow
          title={t('settings.proxy')}
          stacked
          control={
            <TextInput
              value={proxy}
              placeholder={t('settings.proxyPlaceholder')}
              onChange={(event) => setProxy(event.target.value)}
              onBlur={() => void update({ proxyUrl: proxy.trim() || null })}
              aria-label={t('settings.proxy')}
            />
          }
        />
        <SettingRow
          title={t('settings.userAgent')}
          stacked
          control={
            <TextInput
              value={userAgent}
              placeholder={t('settings.userAgentPlaceholder')}
              onChange={(event) => setUserAgent(event.target.value)}
              onBlur={() => void update({ customUserAgent: userAgent.trim() || null })}
              aria-label={t('settings.userAgent')}
            />
          }
        />
        <ToggleRow
          title={t('settings.debugLogging')}
          description={t('settings.debugLoggingHint')}
          checked={settings.debugLogging}
          onChange={(value) => void update({ debugLogging: value })}
        />
        {!IS_MOBILE && (
          <SettingRow
            title={t('settings.logs')}
            description={
              logsFailed ? (
                <span className="text-error">{t('file.revealFailed')}</span>
              ) : (
                t('settings.logsHint')
              )
            }
            control={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setLogsFailed(false);
                  void ipc.openLogDir().catch(() => setLogsFailed(true));
                }}
              >
                {t('settings.openLogs')}
              </Button>
            }
          />
        )}
        <SettingRow
          title={t('settings.resetTitle')}
          description={t('settings.resetHint')}
          control={
            <Button size="sm" variant="danger" onClick={onRequestReset}>
              {t('settings.resetSettings')}
            </Button>
          }
        />
      </SettingGroup>
    </>
  );
}

export { DEFAULT_HOTKEYS };
