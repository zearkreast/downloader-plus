import { useId, useState } from 'react';

import { cn } from '@/lib/cn';
import { IS_MOBILE } from '@/lib/platform';

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  label?: string;
  formatValue?: (value: number) => string;
  disabled?: boolean;
  className?: string;
  /** Report every step as the thumb passes it, for a value that is heard or
   *  seen at once and saved nowhere -- the editor's volume. */
  live?: boolean;
}

/**
 * Native range input, restyled. Keeping the native element means keyboard and
 * screen-reader behaviour come for free; only the track and thumb are painted.
 *
 * The value follows the thumb while it is dragged, but `onChange` hears only
 * where it was let go. Every setting behind a slider is saved and acted on --
 * the queue reschedules on a new limit, the cache trims to a new size -- and a
 * drag from one end to the other used to save, and act, once for every step it
 * passed over, with the saves free to land out of order.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  formatValue,
  disabled = false,
  className,
  live = false,
}: SliderProps) {
  const id = useId();
  // Where the thumb is while it is held; null when it rests on `value`.
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const percent = max === min ? 0 : ((shown - min) / (max - min)) * 100;

  const commit = () => {
    if (draft == null) return;
    setDraft(null);
    if (draft !== value) onChange(draft);
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {/* The current value is always shown -- a slider whose position means
          nothing is not a control, it is a guess. The inline label is optional
          because the title often lives in the surrounding settings row. */}
      <div className="flex items-baseline justify-between gap-3">
        {label ? (
          <label htmlFor={id} className="text-[12.5px] font-medium text-fg-muted">
            {label}
          </label>
        ) : (
          <span aria-hidden="true" />
        )}
        <span className={cn('tabular text-fg-muted', IS_MOBILE ? 'text-[14px]' : 'text-[13px]')}>
          {formatValue ? formatValue(shown) : shown}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (live) onChange(next);
          else setDraft(next);
        }}
        // A drag ends with the pointer let go, an arrow key with the key let
        // go; leaving the control covers anything that ended neither way.
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        style={{
          background: `var(--brand-bar) 0 0 / ${percent}% 100% no-repeat, var(--fill-active)`,
        }}
        className={cn(
          'w-full cursor-pointer appearance-none rounded-full outline-none',
          'disabled:pointer-events-none disabled:opacity-40',
          '[&::-webkit-slider-thumb]:appearance-none',
          // A thumb a finger can find without covering the value it sets.
          IS_MOBILE
            ? 'my-3 h-1.5 [&::-webkit-slider-thumb]:size-7'
            : 'my-2 h-1.5 [&::-webkit-slider-thumb]:size-[18px]',
          '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white',
          '[&::-webkit-slider-thumb]:shadow-[0_0_0_0.5px_rgb(0_0_0/0.1),0_2px_8px_rgb(0_0_0/0.25)]',
          // The thumb swells a little under the pointer and while held.
          '[&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-150',
          'hover:[&::-webkit-slider-thumb]:scale-110 active:[&::-webkit-slider-thumb]:scale-115',
        )}
      />
    </div>
  );
}
