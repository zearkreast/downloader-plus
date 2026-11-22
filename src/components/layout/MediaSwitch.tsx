import { Segmented } from '@/components/ui/Segmented';
import { TitleTabs } from '@/components/ui/TitleTabs';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/cn';
import { IS_MOBILE } from '@/lib/platform';

export type MediaRoute = 'editor' | 'convert';

/**
 * Edit and Convert share one entry in the navigation; this is the switch
 * between them, at the top of whichever is showing.
 */
export function MediaSwitch({
  current,
  onSwitch,
  className,
}: {
  current: MediaRoute;
  onSwitch: (route: MediaRoute) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Segmented
      size="sm"
      value={current}
      onChange={onSwitch}
      className={cn(IS_MOBILE ? 'w-full' : 'w-[220px]', className)}
      options={[
        { value: 'editor', label: t('nav.editor') },
        { value: 'convert', label: t('nav.convert') },
      ]}
    />
  );
}

/** The desktop's version: both names as the page's title. */
export function MediaTitle({
  current,
  onSwitch,
}: {
  current: MediaRoute;
  onSwitch: (route: MediaRoute) => void;
}) {
  const { t } = useTranslation();
  return (
    <TitleTabs
      value={current}
      onChange={onSwitch}
      options={[
        { value: 'editor', label: t('nav.editor') },
        { value: 'convert', label: t('nav.convert') },
      ]}
    />
  );
}
