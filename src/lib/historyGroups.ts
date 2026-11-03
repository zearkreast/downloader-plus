/**
 * History read the way people remember downloads: by the day. Rows come in
 * newest first and stay in that order; this only cuts them where the day
 * changes and names each run of them.
 */

export interface DayGroup<T> {
  /** The day's local date, "2026-11-03", unique within the list. */
  key: string;
  label: string;
  items: T[];
}

export interface DayLabels {
  today: string;
  yesterday: string;
}

function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Whole local days from `then` to `now`: 0 today, 1 yesterday. */
function daysBetween(then: Date, now: Date): number {
  const start = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((start(now) - start(then)) / 86_400_000);
}

/**
 * Today and Yesterday by name; the rest of the past week by its weekday, which
 * is how a recent day is spoken of; anything older by its date, with the year
 * only once it is not this one.
 */
export function dayLabel(timestampMs: number, now: Date, locale: string, labels: DayLabels): string {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return '--';
  const ago = daysBetween(date, now);
  if (ago === 0) return labels.today;
  if (ago === 1) return labels.yesterday;
  if (ago > 1 && ago < 7) {
    return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date);
  }
  return new Intl.DateTimeFormat(locale, {
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

export function groupByDay<T>(
  items: readonly T[],
  timeOf: (item: T) => number,
  now: Date,
  locale: string,
  labels: DayLabels,
): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const at = timeOf(item);
    const date = new Date(at);
    const key = Number.isNaN(date.getTime()) ? 'unknown' : dayKey(date);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(item);
      continue;
    }
    // A day met again further down -- rows that arrived out of order -- joins
    // its own group rather than opening a second one with the same name.
    const earlier = groups.find((group) => group.key === key);
    if (earlier) {
      earlier.items.push(item);
      continue;
    }
    groups.push({ key, label: dayLabel(at, now, locale, labels), items: [item] });
  }
  return groups;
}
