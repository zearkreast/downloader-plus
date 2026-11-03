/**
 * The desktop installs a staged build by itself only while automatic updates
 * are on; with them off, only a build the user pressed Update for installs.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { AppUpdate } from '@/types';

const backend = vi.hoisted(() => ({
  offered: null as AppUpdate | null,
  downloads: 0,
}));

vi.mock('@/lib/platform', () => ({ IS_MOBILE: false }));
vi.mock('@/services/ipc', () => ({
  checkAppUpdate: async () => backend.offered,
  installAppUpdate: async () => {
    backend.downloads += 1;
  },
  applyAppUpdate: async () => {},
  toAppError: (caught: unknown) => ({ code: 'other', message: String(caught) }),
}));
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });

const { selectInstallsItself, useUpdateStore } = await import('@/stores/useUpdateStore');

const build = (commit: string) => ({ commit, assetSize: 1, publishedAt: null }) as unknown as AppUpdate;

beforeEach(() => {
  backend.offered = build('b1');
  backend.downloads = 0;
  useUpdateStore.setState({
    update: null,
    phase: 'idle',
    stalled: false,
    asked: false,
    checked: false,
    error: null,
    progress: null,
  });
});

describe('whether a staged build installs by itself', () => {
  const staged = { phase: 'ready' as const, stalled: false, asked: false };

  test('it does while automatic updates are on', () => {
    expect(selectInstallsItself(staged, true)).toBe(true);
  });

  test('with them off, or before the settings have loaded, it waits to be asked', () => {
    expect(selectInstallsItself(staged, false)).toBe(false);
    expect(selectInstallsItself(staged, undefined)).toBe(false);
    expect(selectInstallsItself({ ...staged, asked: true }, false)).toBe(true);
  });

  test('nothing installs before it is staged, or once it has failed to take', () => {
    expect(selectInstallsItself({ ...staged, phase: 'downloading' }, true)).toBe(false);
    expect(selectInstallsItself({ ...staged, stalled: true, asked: true }, true)).toBe(false);
  });
});

describe('pressing Update', () => {
  test('fetches the build the check found, and lets it install', async () => {
    const { check, install } = useUpdateStore.getState();
    await check(true);
    await install(true);

    const state = useUpdateStore.getState();
    expect(backend.downloads).toBe(1);
    expect(state.phase).toBe('ready');
    expect(selectInstallsItself(state, false)).toBe(true);
  });

  test('takes a build already staged unasked, without fetching it again', async () => {
    const { check, install } = useUpdateStore.getState();
    await check();
    await install();
    useUpdateStore.setState({ stalled: true });
    expect(selectInstallsItself(useUpdateStore.getState(), false)).toBe(false);

    await install(true);
    expect(backend.downloads).toBe(1);
    expect(selectInstallsItself(useUpdateStore.getState(), false)).toBe(true);
  });

  test('is for that build: a newer one found later waits to be asked again', async () => {
    const { check, install } = useUpdateStore.getState();
    await check(true);
    await install(true);

    backend.offered = build('b2');
    await check(true);
    expect(useUpdateStore.getState().asked).toBe(false);
  });
});
