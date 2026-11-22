import { Segmented } from '@/components/ui/Segmented';
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
