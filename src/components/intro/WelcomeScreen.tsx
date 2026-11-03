import { Gauge, ListOrdered, ShieldCheck, type LucideIcon } from 'lucide-react';

import { Logo } from '@/components/layout/Logo';
import { Button } from '@/components/ui/Button';
import { ListGroup } from '@/components/ui/ListGroup';
import { useTranslation } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { cn } from '@/lib/cn';
import { IS_MOBILE } from '@/lib/platform';

const POINTS: { title: TranslationKey; body: TranslationKey; icon: LucideIcon }[] = [
  {
    // A phone sees this when its film is off, and a phone is not a machine.
    title: IS_MOBILE ? 'welcome.pointPrivacyMobile' : 'welcome.pointPrivacy',
    body: 'welcome.pointPrivacyBody',
    icon: ShieldCheck,
  },
  { title: 'welcome.pointQuality', body: 'welcome.pointQualityBody', icon: Gauge },
  { title: 'welcome.pointQueue', body: 'welcome.pointQueueBody', icon: ListOrdered },
];

/**
 * Deliberately one screen, not a multi-step tour: the product is "paste a link",
 * and anything longer stands between the user and doing that. It stands still
 * for the same reason -- nothing on it is an answer to something the user did.
 */
export function WelcomeScreen({ onStart }: { onStart: () => void }) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        'fixed inset-0 z-[900] flex overflow-y-auto bg-bg',
        IS_MOBILE ? 'p-6' : 'p-8',
      )}
    >
      {/* Centred by its margins rather than by the container, so that on a
          short screen the top stays reachable instead of being cut off. */}
      <div className="m-auto w-full max-w-[400px] text-center">
        {/* The mark in a haze of its own colours, as it stands on Home. */}
        <div className="relative mx-auto flex size-[72px] items-center justify-center">
          <span
            aria-hidden="true"
            className="absolute -inset-8 rounded-full bg-[radial-gradient(closest-side,rgb(255_122_61/0.34),rgb(255_168_56/0.1)_55%,transparent)]"
          />
          <Logo size={72} className="relative" />
        </div>

        <h1 className="mt-7 text-balance text-[28px] font-semibold leading-[1.18] tracking-[-0.03em] text-fg">
          {t('welcome.title')}
        </h1>
        <p className="text-brand mt-2 inline-block text-[15px] font-semibold">{t('welcome.subtitle')}</p>

        {/* 16 padding + 32 tile + 12 gap: the hairlines start under the text. */}
        <ListGroup inset={60} className="mt-8 text-left">
          {POINTS.map((point) => {
            const Icon = point.icon;
            return (
              <div
                key={point.title}
                className={cn('flex gap-3 px-4', IS_MOBILE ? 'py-3.5' : 'py-3')}
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent"
                >
                  <Icon size={16} />
                </span>
                <div className="min-w-0">
                  <div className={cn('text-fg', IS_MOBILE ? 'text-[15px]' : 'text-[13.5px]')}>
                    {t(point.title)}
                  </div>
                  <p
                    className={cn(
                      'mt-0.5 leading-relaxed text-fg-muted',
                      IS_MOBILE ? 'text-[13px]' : 'text-[12.5px]',
                    )}
                  >
                    {t(point.body)}
                  </p>
                </div>
              </div>
            );
          })}
        </ListGroup>

        <Button variant="cta" size="lg" fullWidth className="mt-8" onClick={onStart}>
          {t('welcome.getStarted')}
        </Button>
      </div>
    </div>
  );
}
