import { describe, expect, test, vi } from 'vitest';

import { placeCard } from '@/components/tour/Tour';
import { DESKTOP_TOUR, MOBILE_TOUR, markTour, tourPending } from '@/components/tour/steps';
import { en } from '@/i18n/en';
import { tr } from '@/i18n/tr';

const view = { width: 1200, height: 800 };
const card = { width: 320, height: 160 };

describe('placeCard', () => {
  test('centres the card when there is nothing to point at', () => {
    expect(placeCard(null, card, view)).toEqual({ top: 320, left: 440 });
  });

  test('sits to the right of something narrow on the left, like a sidebar item', () => {
    const item = { top: 100, left: 8, width: 160, height: 40 };
    expect(placeCard(item, card, view)).toEqual({ top: 40, left: 180 });
  });

  test('goes below a wide element, or above it when there is no room under it', () => {
    const field = { top: 300, left: 300, width: 600, height: 60 };
    expect(placeCard(field, card, view)).toEqual({ top: 372, left: 440 });
    const tab = { top: 740, left: 300, width: 600, height: 56 };
    expect(placeCard(tab, card, view)).toEqual({ top: 568, left: 440 });
  });

  test('never leaves the window', () => {
    const corner = { top: 10, left: 1150, width: 40, height: 40 };
    const placed = placeCard(corner, card, view);
    expect(placed.left + card.width).toBeLessThanOrEqual(view.width - 12);
    expect(placed.top).toBeGreaterThanOrEqual(12);
  });
});

describe('the tours', () => {
  test('begin and end with a card of their own, and every word is translated', () => {
    for (const steps of [DESKTOP_TOUR, MOBILE_TOUR]) {
      expect(steps[0]!.target).toBeUndefined();
      expect(steps[steps.length - 1]!.target).toBeUndefined();
      for (const step of steps) {
        for (const key of [step.title, step.body]) {
          expect(en[key], key).toBeTruthy();
          expect(tr[key], key).toBeTruthy();
        }
      }
    }
  });

  test('are pending from the welcome until finished or skipped', () => {
    const kept = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => kept.set(key, value),
    });
    expect(tourPending()).toBe(false);
    markTour('pending');
    expect(tourPending()).toBe(true);
    markTour('done');
    expect(tourPending()).toBe(false);
    vi.unstubAllGlobals();
  });
});
