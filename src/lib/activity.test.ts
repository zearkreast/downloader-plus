import { describe, expect, it } from 'vitest';

import type { DownloadProgress, DownloadTask } from '@/types';

import { isBusy, summarizeActivity } from './activity';

let nextId = 1;

const progress = (patch: Partial<DownloadProgress> = {}): DownloadProgress => ({
  receivedBytes: 0,
  totalBytes: null,
  percent: null,
  speedBps: 0,
  etaSec: null,
  stage: 'video',
  stageIndex: 1,
  stageCount: 1,
  resumable: true,
  ...patch,
});

const task = (status: DownloadTask['status'], patch: Partial<DownloadProgress> = {}): DownloadTask =>
  ({
    id: String(nextId++),
    url: 'https://example.com/v',
    title: 'A video',
    platform: 'youtube',
    thumbnailUrl: null,
    status,
    progress: progress(patch),
    formatLabel: '1080p - MP4',
    outputPath: null,
    error: null,
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    attempt: 1,
    request: {} as DownloadTask['request'],
  }) as DownloadTask;

describe('summarizeActivity', () => {
  it('reports nothing for an idle queue', () => {
    const activity = summarizeActivity([task('completed'), task('failed')]);
    expect(activity).toEqual({
      running: 0,
      waiting: 0,
      paused: 0,
      speedBps: 0,
      percent: null,
      etaSec: null,
    });
    expect(isBusy(activity)).toBe(false);
  });

  it('counts each state on its own', () => {
    const activity = summarizeActivity([
      task('downloading'),
      task('preparing'),
      task('processing'),
      task('queued'),
      task('queued'),
      task('paused'),
    ]);
    expect(activity.running).toBe(3);
    expect(activity.waiting).toBe(2);
    expect(activity.paused).toBe(1);
    expect(isBusy(activity)).toBe(true);
  });

  it('weighs progress by bytes where sizes are known', () => {
    const activity = summarizeActivity([
      task('downloading', { receivedBytes: 90, totalBytes: 100, percent: 90, speedBps: 10 }),
      task('downloading', { receivedBytes: 100, totalBytes: 900, percent: 11, speedBps: 30 }),
    ]);
    expect(activity.percent).toBeCloseTo(19);
    expect(activity.speedBps).toBe(40);
  });

  it('falls back to the mean percentage when no size is known', () => {
    const activity = summarizeActivity([
      task('downloading', { percent: 20 }),
      task('downloading', { percent: 60 }),
      task('downloading'),
    ]);
    expect(activity.percent).toBe(40);
  });

  it('takes the longest time left, and ignores what is not running', () => {
    const activity = summarizeActivity([
      task('downloading', { etaSec: 30 }),
      task('downloading', { etaSec: 120 }),
      task('paused', { etaSec: 999, speedBps: 50 }),
    ]);
    expect(activity.etaSec).toBe(120);
    expect(activity.speedBps).toBe(0);
  });

  it('never lets a bad reading through', () => {
    const activity = summarizeActivity([
      task('downloading', { speedBps: Number.NaN, etaSec: -4, percent: Number.NaN }),
    ]);
    expect(activity.speedBps).toBe(0);
    expect(activity.etaSec).toBeNull();
    expect(activity.percent).toBeNull();
  });
});
