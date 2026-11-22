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

/**
 * The desktop's version: both names as the page's title, the one showing in
 * full colour and the other faint, a press away. A switch beside a title that
 * repeated one of its options said the same word twice.
 */
export function MediaTitle({
  current,
  onSwitch,
}: {
  current: MediaRoute;
  onSwitch: (route: MediaRoute) => void;
}) {
  const { t } = useTranslation();
  const names: [MediaRoute, string][] = [
    ['editor', t('nav.editor')],
    ['convert', t('nav.convert')],
  ];
  return (
    <span className="flex items-baseline gap-5">
      {names.map(([route, name]) =>
        route === current ? (
          <span key={route}>{name}</span>
        ) : (
          <button
            key={route}
            type="button"
            onClick={() => onSwitch(route)}
            className="rounded-md text-fg-faint transition-colors duration-150 ease-out-quint hover:text-fg-muted"
          >
            {name}
          </button>
        ),
      )}
    </span>
  );
}
