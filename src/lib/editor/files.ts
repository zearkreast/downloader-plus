import type { HistoryEntry } from '@/types';

/** Containers FFmpeg can read and the editor can cut: what the picker offers. */
export const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'ts', 'mpg', 'mpeg'];

/** Sound the editor can cut, or lay under a clip. */
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma'];

const EDITABLE = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);

/** A download the editor can open: a video, or sound alone. */
export function isEditableDownload(entry: HistoryEntry): boolean {
  return EDITABLE.has(entry.container.toLowerCase());
}
