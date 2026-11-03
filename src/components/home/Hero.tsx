import { Logo } from '@/components/layout/Logo';
import { useTranslation } from '@/i18n';
import { cn } from '@/lib/cn';
import { IS_MOBILE } from '@/lib/platform';

/**
 * The Home headline: the mark, what to do, and one sentence about what it is
 * for. It stands in for the page title, which is why it is the desktop's
 * `<h1>` -- a phone already has one in its top bar. It has no entrance of its
 * own; the screen change it arrives with is the only fade.
 *
 * The mark sits in a haze of its own colours, and the second half of the
 * headline is set in them: the one place the brand speaks at full volume,
 * on the one screen that is nothing but a welcome. Under the pointer the
 * blades turn a quarter round the plus, which brings them back to exactly the
 * same shape.
 */
export function Hero() {
  const { t } = useTranslation();
  const Heading = IS_MOBILE ? 'h2' : 'h1';
  const mark = IS_MOBILE ? 52 : 64;

  return (
    // The padding above is the glow's room: the box this sits in clips it
    // while Home folds the headline away.
    <div className="pt-7 text-center">
      <div
        className="relative mx-auto mb-6 flex items-center justify-center"
        style={{ width: mark, height: mark }}
      >
        {/* A radial fade rather than a blur: it ends inside its own box, so
            nothing around it can cut it off with a hard edge. */}
        <span
          aria-hidden="true"
          className="absolute -inset-7 rounded-full bg-[radial-gradient(closest-side,rgb(255_122_61/0.32),rgb(255_168_56/0.1)_55%,transparent)] dark:bg-[radial-gradient(closest-side,rgb(255_122_61/0.38),rgb(255_168_56/0.12)_55%,transparent)]"
        />
        {/* Under the pointer the ring takes a quarter turn round the plus,
            which stays put -- the loading mark's motion, once. */}
        <Logo
          size={mark}
          className="group relative"
          ringClassName="transition-transform duration-700 ease-out-quint group-hover:rotate-90"
        />
      </div>
      <Heading
        className={cn(
          'text-balance font-semibold leading-[1.12] tracking-[-0.035em] text-fg',
          IS_MOBILE ? 'text-[28px]' : 'text-[38px]',
        )}
      >
        {t('hero.titleLead')}{' '}
        <span className="text-brand inline-block pb-[0.06em]">{t('hero.titleAccent')}</span>
      </Heading>
      <p className={cn('mt-3 text-fg-muted', IS_MOBILE ? 'text-[14px]' : 'text-[15px]')}>
        {t('hero.subtitle')}
      </p>
    </div>
  );
}
