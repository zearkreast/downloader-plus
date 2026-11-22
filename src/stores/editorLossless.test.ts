/**
 * The rule that keeps the mode and the settings from disagreeing: a lossless
 * copy is only on offer while nothing it cannot do has been asked for, and a
 * change that asks for such a thing moves the mode off lossless in the same
 * step -- whichever tab the change was made on.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ExportOptions, MediaProbe } from '@/types';

const backend = vi.hoisted(() => ({
  probe: null as unknown as MediaProbe,
  keyframes: [] as number[],
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

vi.mock('@/services/ipc', () => ({
  probeMedia: async () => backend.probe,
  allowMediaPreview: async () => {},
  mediaKeyframes: async () => backend.keyframes,
  requestTimeline: async () => {},
  startExport: async () => {},
  cancelExport: async () => {},
  cancelRangeFetch: async () => {},
  toAppError: (value: unknown) => ({
    code: 'unknown',
    title: 'Something went wrong',
    message: String(value),
    technical: null,
    retryable: true,
  }),
}));

const {
  losslessBlocker,
  selectCuts,
  selectLosslessBlocker,
  selectOptions,
  snapDistance,
  useEditorStore,
  withLegalMode,
} = await import('@/stores/useEditorStore');

function probeOf(patch: Partial<MediaProbe> = {}): MediaProbe {
  return {
    path: 'C:/tmp/a.mp4',
    fileName: 'a.mp4',
    container: 'mp4',
    sizeBytes: 21_000_000,
    durationSec: 20,
    width: 1920,
    height: 1080,
    fps: 30,
    videoDurationSec: 20,
    pixelAspect: null,
    videoCodec: 'h264',
    audioCodec: 'aac',
    audioBitrateKbps: 192,
    hasVideo: true,
    hasAudio: true,
    still: false,
    ...patch,
  };
}

async function openLossless(): Promise<void> {
  backend.probe = probeOf();
  await useEditorStore.getState().open('C:/tmp/a.mp4', false);
  expect(selectOptions(useEditorStore.getState())!.mode).toBe('lossless');
}

function options(): ExportOptions {
  return selectOptions(useEditorStore.getState())!;
}

beforeEach(() => {
  useEditorStore.getState().closeAll();
  backend.keyframes = [];
});

describe('what rules a lossless copy out', () => {
  test('a new clip in a copyable box has nothing in the way', async () => {
    await openLossless();
    expect(selectLosslessBlocker(useEditorStore.getState())).toBeNull();
  });

  test('a level off 100 % does, and a level on it does not', async () => {
    await openLossless();
    const base = options();
    expect(losslessBlocker({ ...base, volume: 1.5 }, probeOf())).toBe('volume');
    expect(losslessBlocker({ ...base, volume: 0 }, probeOf())).toBe('volume');
    // A slider parked on 100 must not rule anything out over rounding.
    expect(losslessBlocker({ ...base, volume: 1.004 }, probeOf())).toBeNull();
  });

  test('a custom rate does not: a copy has no rate to set', async () => {
    await openLossless();
    expect(losslessBlocker({ ...options(), videoBitrateKbps: 8000 }, probeOf())).toBeNull();
  });

  test('removing the audio does not: a copy can leave a track out', async () => {
    await openLossless();
    expect(losslessBlocker({ ...options(), mute: true }, probeOf())).toBeNull();
  });

  test('a level on sound that is not written does not either', async () => {
    await openLossless();
    const base = options();
    // Muted, the slider keeps its value but nothing is played at it.
    expect(losslessBlocker({ ...base, mute: true, volume: 1.5 }, probeOf())).toBeNull();
    // A silent source has no sound to be louder.
    const silent = probeOf({ hasAudio: false, audioCodec: null, audioBitrateKbps: null });
    expect(losslessBlocker({ ...base, volume: 1.5 }, silent)).toBeNull();
  });

  test('nor does a level under an added sound, which is encoded anyway', async () => {
    await openLossless();
    const base = options();
    expect(losslessBlocker({ ...base, volume: 1.5, soundPath: 'C:/tmp/song.mp3' }, probeOf())).toBeNull();
  });
});

describe('the mode follows the settings', () => {
  test('turning the level up leaves lossless in the same step', async () => {
    await openLossless();

    useEditorStore.getState().setOptions({ volume: 1.5 });

    expect(options().volume).toBe(1.5);
    expect(options().mode).toBe('reencode');
  });

  test('removing the audio stays lossless', async () => {
    await openLossless();

    useEditorStore.getState().setOptions({ mute: true });

    expect(options().mute).toBe(true);
    expect(options().mode).toBe('lossless');
  });

  test('so does another shape of frame', async () => {
    await openLossless();

    useEditorStore.getState().setAspect('1:1', 'fill');

    expect(options().aspect).toBe('1:1');
    expect(options().mode).toBe('reencode');
  });

  test('and another box', async () => {
    await openLossless();

    useEditorStore.getState().setOptions({ container: 'mkv' });

    expect(options().mode).toBe('reencode');
  });

  test('putting the setting back leaves the mode where the user can see it', async () => {
    await openLossless();
    useEditorStore.getState().setOptions({ volume: 1.5 });

    useEditorStore.getState().setOptions({ volume: 1 });

    expect(options().mode).toBe('reencode');
    expect(selectLosslessBlocker(useEditorStore.getState())).toBeNull();
  });

  test('a choice lossless can live with leaves it alone', async () => {
    await openLossless();

    useEditorStore.getState().setOptions({ hardware: true });

    expect(options().mode).toBe('lossless');
  });

  test('asking for lossless while something rules it out is refused', () => {
    const probe = probeOf();
    const blocked: ExportOptions = {
      mode: 'lossless',
      container: 'mp4',
      videoCodec: 'h264',
      quality: 'balanced',
      videoBitrateKbps: null,
      fps: 24,
      maxHeight: null,
      aspect: 'source',
      fit: 'fill',
      mute: false,
      volume: 1,
      audioCodec: 'aac',
      audioBitrateKbps: 192,
      toneMapSdr: false,
      hardware: false,
      soundPath: null,
      soundVolume: 1,
      fadeInSec: 0,
      fadeOutSec: 0,
      normalize: false,
    };
    expect(withLegalMode(blocked, probe).mode).toBe('reencode');
    expect(withLegalMode({ ...blocked, fps: null }, probe).mode).toBe('lossless');
  });
});

describe('a cut a copy cannot make', () => {
  // Keyframes ten seconds apart, as a lot of downloaded video has: a copy of
  // anything that starts inside the first ten seconds starts at zero.
  async function openSparse(): Promise<void> {
    backend.keyframes = [0, 10];
    await openLossless();
    await useEditorStore.getState().loadKeyframes();
  }

  function cutAwayTheFront(at: number): void {
    const store = useEditorStore.getState();
    store.split(at);
    store.remove(selectCuts(useEditorStore.getState())[0]!.id);
  }

  test('cutting the front off inside the first group moves the export to re-encode', async () => {
    await openSparse();
    useEditorStore.getState().split(3);
    // A split alone cuts nothing out, so a copy still does it.
    expect(options().mode).toBe('lossless');
    useEditorStore.getState().remove(selectCuts(useEditorStore.getState())[0]!.id);
    expect(selectCuts(useEditorStore.getState())[0]!.startSec).toBe(3);
    expect(options().mode).toBe('reencode');
    // One step: undoing the cut brings the copy back with it.
    useEditorStore.getState().undo();
    expect(options().mode).toBe('lossless');
  });

  test('a cut a few frames past a keyframe stays a copy', async () => {
    await openSparse();
    cutAwayTheFront(10.1);
    expect(options().mode).toBe('lossless');
  });

  test('choosing lossless again is kept while the marks move', async () => {
    await openSparse();
    cutAwayTheFront(3);
    useEditorStore.getState().setOptions({ mode: 'lossless' });
    const cut = selectCuts(useEditorStore.getState())[0]!;
    useEditorStore.getState().drag(cut.id, 'start', 4);
    expect(options().mode).toBe('lossless');
  });

  test('cuts made before the keyframes arrive are held to it when they do', async () => {
    backend.keyframes = [0, 10];
    await openLossless();
    cutAwayTheFront(3);
    expect(options().mode).toBe('lossless');
    await useEditorStore.getState().loadKeyframes();
    expect(options().mode).toBe('reencode');
  });

  test('how far a copy would start early', () => {
    const cut = (startSec: number) => ({ id: 'c', startSec, endSec: 20 });
    expect(snapDistance([cut(3)], [0, 10])).toBe(3);
    expect(snapDistance([cut(10)], [0, 10])).toBe(0);
    expect(snapDistance([cut(3)], [])).toBe(0);
    expect(snapDistance([cut(3)], null)).toBe(0);
    // Two pieces end to end are exported as one, which starts at zero.
    expect(snapDistance([{ id: 'a', startSec: 0, endSec: 3 }, cut(3)], [0, 10])).toBe(0);
  });
});
