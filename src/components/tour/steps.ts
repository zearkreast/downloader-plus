import type { TourStep } from '@/components/tour/Tour';

/**
 * The computer's tour: the link field, then each entry in the sidebar. History
 * and Subscriptions are tabs in Downloads' title, and Convert in Edit's, so
 * they are told about there rather than pointed at.
 */
export const DESKTOP_TOUR: readonly TourStep[] = [
  { title: 'tour.welcomeTitle', body: 'tour.welcomeBody' },
  { target: 'link', title: 'tour.linkTitle', body: 'tour.linkBody' },
  { target: 'nav-downloads', title: 'tour.downloadsTitle', body: 'tour.downloadsBody' },
  { target: 'nav-editor', title: 'tour.editorTitle', body: 'tour.editorBody' },
  { target: 'nav-settings', title: 'tour.settingsTitle', body: 'tour.settingsBodyDesktop' },
  { target: 'nav-about', title: 'tour.aboutTitle', body: 'tour.aboutBody' },
  { title: 'tour.doneTitle', body: 'tour.doneBody' },
];

/**
 * The phone's tour: the link field, sharing from another app -- the way most
 * links arrive on a phone -- and the tabs along the bottom.
 */
export const MOBILE_TOUR: readonly TourStep[] = [
  { title: 'tour.welcomeTitle', body: 'tour.welcomeBodyMobile' },
  { target: 'link', title: 'tour.linkTitle', body: 'tour.linkBodyMobile' },
  { title: 'tour.shareTitle', body: 'tour.shareBody' },
  { target: 'nav-downloads', title: 'tour.downloadsTitle', body: 'tour.downloadsBodyMobile' },
  { target: 'nav-editor', title: 'tour.editorTitle', body: 'tour.editorBodyMobile' },
  { target: 'nav-settings', title: 'tour.settingsTitle', body: 'tour.settingsBodyMobile' },
  { title: 'tour.doneTitle', body: 'tour.doneBodyMobile' },
];

/**
 * Whether the tour still has to be shown, kept in this webview's storage.
 * `pending` is written when the first run's welcome is let go and cleared when
 * the tour is finished or skipped, so an app closed half way through takes the
 * tour up again at the next launch. A copy installed before the tour existed
 * has neither, and is not shown it.
 */
const KEY = 'umd.tour';

export function tourPending(): boolean {
  try {
    return localStorage.getItem(KEY) === 'pending';
  } catch {
    return false;
  }
}

export function markTour(state: 'pending' | 'done'): void {
  try {
    localStorage.setItem(KEY, state);
  } catch {
    // Without storage the tour is simply not resumed.
  }
}
