import { describe, expect, it } from 'vitest';

import { dayLabel, groupByDay } from './historyGroups';

const LABELS = { today: 'Today', yesterday: 'Yesterday' };
// A Tuesday afternoon, local time.
const NOW = new Date(2026, 10, 3, 15, 30);
const at = (month: number, day: number, hour = 12) => new Date(2026, month, day, hour).getTime();

describe('dayLabel', () => {
  it('names today and yesterday', () => {
    expect(dayLabel(at(10, 3, 0), NOW, 'en', LABELS)).toBe('Today');
    expect(dayLabel(at(10, 2, 23), NOW, 'en', LABELS)).toBe('Yesterday');
  });

  it('gives the rest of the week its weekday', () => {
    expect(dayLabel(at(10, 1), NOW, 'en', LABELS)).toBe('Sunday');
    expect(dayLabel(at(9, 28), NOW, 'en', LABELS)).toBe('Wednesday');
  });

  it('dates anything older, with the year only when it is another one', () => {
    expect(dayLabel(at(9, 20), NOW, 'en', LABELS)).toBe('October 20');
    expect(dayLabel(new Date(2025, 0, 5).getTime(), NOW, 'en', LABELS)).toBe('January 5, 2025');
  });
});

describe('groupByDay', () => {
  it('cuts a newest-first list where the day changes, keeping its order', () => {
    const rows = [at(10, 3, 14), at(10, 3, 9), at(10, 2), at(9, 20, 18), at(9, 20, 8)];
    const groups = groupByDay(rows, (row) => row, NOW, 'en', LABELS);
    expect(groups.map((group) => group.label)).toEqual(['Today', 'Yesterday', 'October 20']);
    expect(groups.map((group) => group.items.length)).toEqual([2, 1, 2]);
    expect(groups[0]!.items).toEqual([at(10, 3, 14), at(10, 3, 9)]);
  });

  it('never names the same day twice', () => {
    const rows = [at(10, 3), at(10, 2), at(10, 3, 8)];
    const groups = groupByDay(rows, (row) => row, NOW, 'en', LABELS);
    expect(groups.map((group) => group.key)).toEqual(['2026-11-03', '2026-11-02']);
    expect(groups[0]!.items).toHaveLength(2);
  });
});
