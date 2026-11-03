import { describe, expect, it } from 'vitest';

import { formatCount, formatUploadDate } from './format';

describe('formatCount', () => {
  it('keeps small figures whole', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
  });

  it('gives one decimal under ten of a unit and none from ten up', () => {
    expect(formatCount(1500)).toBe('1.5K');
    expect(formatCount(9940)).toBe('9.9K');
    expect(formatCount(12_345)).toBe('12K');
    expect(formatCount(1_234_567)).toBe('1.2M');
    expect(formatCount(45_000_000)).toBe('45M');
  });

  it('moves up a unit when the figure rounds to the next one', () => {
    expect(formatCount(9980)).toBe('10K');
    expect(formatCount(999_800)).toBe('1.0M');
    expect(formatCount(999_999_999)).toBe('1.0B');
  });

  it('says nothing for a missing figure', () => {
    expect(formatCount(null)).toBe('--');
    expect(formatCount(Number.NaN)).toBe('--');
  });
});

describe('formatUploadDate', () => {
  it('reads a bare date as that calendar day wherever the clock is', () => {
    const shown = formatUploadDate('20240312', 'en');
    expect(shown).toBe('Mar 12, 2024');
    expect(formatUploadDate('2024-03-12', 'en')).toBe('Mar 12, 2024');
  });

  it('gives nothing for what is not a date', () => {
    expect(formatUploadDate(null, 'en')).toBeNull();
    expect(formatUploadDate('soon', 'en')).toBeNull();
  });
});
