import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/Button';
import { useTranslation, type TranslationKey } from '@/i18n';
import { cn } from '@/lib/cn';
import { IS_MOBILE } from '@/lib/platform';

/*
 * A first-run walk through the app: one card at a time, each beside the real
 * control it is about, with the rest of the screen dimmed. It points and does
 * nothing else -- no step presses a button or changes a page -- so skipping it
 * at any moment leaves the app exactly as it was.
 */

export interface TourStep {
  /** The `data-tour` value of the element to light up. None centres the card. */
  target?: string;
  title: TranslationKey;
  body: TranslationKey;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Room left around the lit element. */
const PAD = 6;
/** The card never comes closer than this to the window's edge. */
const EDGE = 12;
const GAP = 12;
const CARD_WIDTH = IS_MOBILE ? 340 : 320;
/** How long a step waits for its element to appear before it centres instead. */
const FIND_MS = 1500;

function find(target: string | undefined): HTMLElement | null {
  if (!target) return null;
  const nodes = document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`);
  // The first one actually on screen: a collapsed layout can keep a hidden copy.
  for (const node of nodes) {
    const box = node.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return node;
  }
  return null;
}

function measure(node: HTMLElement): Rect {
  const box = node.getBoundingClientRect();
  return {
    top: box.top - PAD,
    left: box.left - PAD,
    width: box.width + PAD * 2,
    height: box.height + PAD * 2,
  };
}

/**
 * Where the card goes: beside the lit element on whichever side has room --
 * right of something narrow on the left, otherwise below, then above -- and
 * clamped inside the window.
 */
export function placeCard(
  rect: Rect | null,
  card: { width: number; height: number },
  view: { width: number; height: number },
): { top: number; left: number } {
  const clampLeft = (left: number) =>
    Math.min(Math.max(left, EDGE), Math.max(EDGE, view.width - card.width - EDGE));
  const clampTop = (top: number) =>
    Math.min(Math.max(top, EDGE), Math.max(EDGE, view.height - card.height - EDGE));
  if (!rect) {
    return {
      top: clampTop((view.height - card.height) / 2),
      left: clampLeft((view.width - card.width) / 2),
    };
  }
  const right = rect.left + rect.width + GAP;
  const narrowOnLeft = rect.left + rect.width < view.width / 3;
  if (narrowOnLeft && right + card.width <= view.width - EDGE) {
    return { top: clampTop(rect.top + rect.height / 2 - card.height / 2), left: right };
  }
  const centred = clampLeft(rect.left + rect.width / 2 - card.width / 2);
  const below = rect.top + rect.height + GAP;
  if (below + card.height <= view.height - EDGE) return { top: below, left: centred };
  const above = rect.top - GAP - card.height;
  if (above >= EDGE) return { top: above, left: centred };
  return { top: clampTop(below), left: centred };
}

export function Tour({
  steps,
  onFinish,
  onSkip,
}: {
  steps: readonly TourStep[];
  /** The last step's button. */
  onFinish: () => void;
  /** Turu atla, Escape, or the dimmed screen pressed. */
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [view, setView] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [cardSize, setCardSize] = useState({ width: CARD_WIDTH, height: 180 });
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const step = steps[index]!;
  const last = index === steps.length - 1;

  // Follow the element: it may arrive a moment after the step does, and the
  // window can be resized or the page scrolled under it.
  useEffect(() => {
    let frame = 0;
    const started = performance.now();
    let node: HTMLElement | null = null;
    const track = () => {
      // Read here as well as on resize: a window shown after the tour mounted
      // reports its size without firing one.
      setView((previous) =>
        previous.width === window.innerWidth && previous.height === window.innerHeight
          ? previous
          : { width: window.innerWidth, height: window.innerHeight },
      );
      node = node?.isConnected ? node : find(step.target);
      if (node) {
        node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        const next = measure(node);
        setRect((previous) =>
          previous &&
          Math.abs(previous.top - next.top) < 0.5 &&
          Math.abs(previous.left - next.left) < 0.5 &&
          Math.abs(previous.width - next.width) < 0.5 &&
          Math.abs(previous.height - next.height) < 0.5
            ? previous
            : next,
        );
      } else if (!step.target || performance.now() - started > FIND_MS) {
        setRect(null);
      }
      frame = window.setTimeout(track, 120);
    };
    setRect(null);
    track();
    const onResize = () => setView({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(frame);
      window.removeEventListener('resize', onResize);
    };
  }, [step.target]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const box = card.getBoundingClientRect();
    if (Math.abs(box.height - cardSize.height) > 1 || Math.abs(box.width - cardSize.width) > 1) {
      setCardSize({ width: box.width, height: box.height });
    }
  });

  // The card is the dialog, so the keyboard starts on its main button.
  useEffect(() => {
    nextRef.current?.focus({ preventScroll: true });
  }, [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onSkip();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (last) onFinish();
        else setIndex((value) => value + 1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setIndex((value) => Math.max(0, value - 1));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [last, onFinish, onSkip]);

  const width = Math.min(CARD_WIDTH, view.width - EDGE * 2);
  const place = placeCard(rect, { width, height: cardSize.height }, view);

  // On the body, above everything: the phone's tab bar is drawn outside the
  // app's own frame, and the tour has to dim it and light it up as well.
  return createPortal(
    <div className="fixed inset-0 z-[950]" role="presentation">
      {/* Pressing anywhere off the card does nothing but keep the user in the
          tour; skipping is the button's, so a stray tap does not end it. */}
      <div className="absolute inset-0" aria-hidden="true" />
      {rect ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-[12px] ring-2 ring-accent/80 transition-all duration-200 ease-out-quint motion-reduce:transition-none"
          style={{
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.62)',
          }}
        />
      ) : (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-black/60" />
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        className={cn(
          'absolute rounded-[var(--radius-panel)] border border-[var(--border)] bg-surface p-4 shadow-floating dark:border-[var(--border-strong)]',
          'transition-[top,left] duration-200 ease-out-quint motion-reduce:transition-none',
        )}
        style={{ top: place.top, left: place.left, width }}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="tabular text-[12px] font-medium text-fg-faint">
            {t('tour.progress', { current: index + 1, total: steps.length })}
          </span>
          {!last && (
            <button
              type="button"
              onClick={onSkip}
              className={cn(
                'rounded-md px-1.5 text-fg-muted hover:bg-fill hover:text-fg',
                IS_MOBILE ? 'min-h-9 text-[14px]' : 'py-0.5 text-[12.5px]',
              )}
            >
              {t('tour.skip')}
            </button>
          )}
        </div>
        <h2
          id="tour-title"
          className={cn('mt-2 font-semibold text-fg', IS_MOBILE ? 'text-[17px]' : 'text-[15px]')}
        >
          {t(step.title)}
        </h2>
        <p
          id="tour-body"
          className={cn('mt-1 leading-relaxed text-fg-muted', IS_MOBILE ? 'text-[14.5px]' : 'text-[13px]')}
        >
          {t(step.body)}
        </p>

        <div className="mt-4 flex items-center gap-2">
          <div className="flex flex-1 gap-1" aria-hidden="true">
            {steps.map((_, dot) => (
              <span
                key={dot}
                className={cn(
                  'h-1.5 rounded-full transition-all duration-200',
                  dot === index ? 'w-4 bg-accent' : 'w-1.5 bg-fg-faint/40',
                )}
              />
            ))}
          </div>
          {index > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setIndex(index - 1)}>
              {t('tour.back')}
            </Button>
          )}
          <Button
            ref={nextRef}
            size="sm"
            variant="primary"
            onClick={() => (last ? onFinish() : setIndex(index + 1))}
          >
            {t(index === 0 ? 'tour.start' : last ? 'tour.finish' : 'tour.next')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
