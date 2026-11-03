import type { DropdownOption } from '@/components/ui/Dropdown';
import { getLanguage, translate } from '@/i18n';
import { formatBitrate, formatBytes, prettyCodec } from '@/lib/format';
import type { DownloadMode, MediaFormat, MediaMetadata, QualityPreference } from '@/types';

/**
 * Derives the choices offered for a given piece of media.
 *
 * This decides what is *shown*; which stream actually gets downloaded is
 * decided by `plan::build` in Rust, and the panel asks that same code for the
 * resulting label and size (see `summarizePlan`). Only the source's real
 * renditions appear here -- no aspirational "4K" entry for a 720p video.
 */

export type QualityKey = string;

const LIST_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];

export function encodeQuality(quality: QualityPreference): QualityKey {
  switch (quality.type) {
    case 'best':
      return 'best';
    case 'auto':
      return 'auto';
    case 'maxHeight':
      return `h:${quality.height}`;
    case 'audioBitrate':
      return `a:${quality.kbps}`;
  }
}

export function decodeQuality(key: QualityKey): QualityPreference {
  if (key === 'best') return { type: 'best' };
  if (key === 'auto') return { type: 'auto' };
  if (key.startsWith('h:')) return { type: 'maxHeight', height: Number(key.slice(2)) };
  if (key.startsWith('a:')) return { type: 'audioBitrate', kbps: Number(key.slice(2)) };
  return { type: 'best' };
}

export function availableModes(metadata: MediaMetadata): DownloadMode[] {
  if (metadata.listing) return ['video', 'audio'];
  const modes: DownloadMode[] = [];
  if (metadata.formats.some((format) => format.hasVideo)) modes.push('video');
  if (metadata.formats.some((format) => format.hasAudio)) modes.push('audio');
  if (metadata.formats.some((format) => format.kind === 'image')) modes.push('image');
  return modes.length > 0 ? modes : ['video'];
}

export function qualityOptions(
  metadata: MediaMetadata,
  mode: DownloadMode,
): DropdownOption<QualityKey>[] {
  if (mode === 'image') {
    return [{ value: 'best', label: translate('options.qualityBest') }];
  }

  if (mode === 'audio') {
    if (metadata.listing) return [{ value: 'best', label: translate('options.audioBest') }];
    const bitrates = bitratesOf(metadata);

    return [
      { value: 'best', label: translate('options.audioBest') },
      ...bitrates.map((kbps) => ({
        value: `a:${kbps}` satisfies QualityKey,
        label: `${kbps} kbps`,
      })),
    ];
  }

  // No item of a list has been read yet, so these are ceilings rather than
  // renditions: each video takes the best it has up to the one chosen.
  if (metadata.listing) {
    return [
      {
        value: 'best',
        label: translate('options.qualityBest'),
        description: translate('options.qualityBestHint'),
      },
      { value: 'auto', label: translate('options.qualityAuto') },
      ...LIST_HEIGHTS.map((height) => ({
        value: `h:${height}` satisfies QualityKey,
        label: translate('options.upTo', { height }),
      })),
    ];
  }

  // Distinct heights, best first. A source that reports no height at all still
  // gets Best/Auto rather than an empty menu.
  const heights = heightsOf(metadata);

  const options: DropdownOption<QualityKey>[] = [
    {
      value: 'best',
      label: translate('options.qualityBest'),
      description: translate('options.qualityBestHint'),
    },
    { value: 'auto', label: translate('options.qualityAuto') },
  ];

  for (const height of heights) {
    const best = metadata.formats
      .filter((format) => format.height === height && format.hasVideo)
      .sort((a, b) => (b.tbr ?? 0) - (a.tbr ?? 0))[0];

    options.push({
      value: `h:${height}`,
      label: `${height}p`,
      description: describeStream(best),
      meta: best?.filesize != null ? formatBytes(best.filesize) : undefined,
    });
  }

  return options;
}

const VIDEO_CONTAINERS = ['mp4', 'webm', 'mkv'];
const AUDIO_CONTAINERS = ['mp3', 'm4a', 'wav', 'opus'];
const IMAGE_CONTAINERS = ['jpg', 'png', 'webp'];

/** The containers a download of this kind can be written as. */
export function containersFor(mode: DownloadMode): readonly string[] {
  return mode === 'audio' ? AUDIO_CONTAINERS : mode === 'image' ? IMAGE_CONTAINERS : VIDEO_CONTAINERS;
}

/**
 * A preferred container that still means something for this kind of file, or
 * null -- "keep the source's" -- when it does not. An MP4 preference set for
 * video, carried into an audio download, wrapped the sound in a video file
 * and left the Format menu showing nothing it offered.
 */
export function fitContainer(container: string | null, mode: DownloadMode): string | null {
  return container && containersFor(mode).includes(container) ? container : null;
}

/** The heights a medium's pictures come in, tallest first. */
function heightsOf(metadata: MediaMetadata): number[] {
  return [
    ...new Set(
      metadata.formats
        .filter((format) => format.hasVideo && format.height != null)
        .map((format) => format.height!),
    ),
  ].sort((a, b) => b - a);
}

/** The bitrates a medium's sound comes in apart from any picture, highest first. */
function bitratesOf(metadata: MediaMetadata): number[] {
  return [
    ...new Set(
      metadata.formats
        .filter((format) => format.kind === 'audio' && format.abr != null)
        .map((format) => Math.round(format.abr!)),
    ),
  ].sort((a, b) => b - a);
}

/**
 * A quality preference brought into line with what this medium offers in this
 * mode, so the Quality menu always opens on one of its own entries.
 *
 * A height is a ceiling, and the downloader already treats it as one: asked
 * for 1080p of a video that tops out at 720p, it fetches the 720p. So the
 * preference is moved to the tallest height at or under it -- the same file,
 * now named in the menu -- and to the shortest there is when every height is
 * over it. A bitrate is handled alike. A preference made for another kind of
 * file -- a height for a song, a bitrate for a video -- means nothing here,
 * and becomes Best.
 */
export function fitQuality(
  quality: QualityPreference,
  mode: DownloadMode,
  metadata: MediaMetadata,
): QualityPreference {
  if (mode === 'image') return { type: 'best' };

  if (quality.type === 'maxHeight') {
    if (mode !== 'video') return { type: 'best' };
    // A list offers ceilings, not the renditions of one video.
    const heights = metadata.listing ? LIST_HEIGHTS : heightsOf(metadata);
    if (heights.length === 0) return { type: 'best' };
    const height = heights.find((candidate) => candidate <= quality.height) ?? heights[heights.length - 1]!;
    return { type: 'maxHeight', height };
  }

  if (quality.type === 'audioBitrate') {
    if (mode !== 'audio') return { type: 'best' };
    const rates = bitratesOf(metadata);
    if (rates.length === 0) return { type: 'best' };
    const kbps = rates.find((candidate) => candidate <= quality.kbps) ?? rates[rates.length - 1]!;
    return { type: 'audioBitrate', kbps };
  }

  // Auto is a video choice: the best picture that needs no merge.
  if (quality.type === 'auto' && mode !== 'video') return { type: 'best' };
  return quality;
}

export function containerOptions(
  mode: DownloadMode,
  ffmpegAvailable: boolean,
): DropdownOption<string>[] {
  const list = containersFor(mode);

  return [
    { value: '', label: translate('settings.containerKeep') },
    ...list.map((container) => ({
      value: container,
      label: container.toUpperCase(),
      // Changing container is an FFmpeg job; offering it without FFmpeg would
      // be a button that cannot work.
      disabled: !ffmpegAvailable,
      disabledReason: !ffmpegAvailable ? translate('error.ffmpegMissing.message') : undefined,
    })),
  ];
}

/**
 * The languages a video's sound comes in, when it comes in more than one: the
 * original first, as the empty value that means "the original", then the
 * dubs by name.
 */
export function audioLanguageOptions(metadata: MediaMetadata): DropdownOption<string>[] {
  const tracks = metadata.formats.filter((format) => format.kind === 'audio' && format.language);
  const codes = [...new Set(tracks.map((format) => format.language!))];
  if (codes.length < 2) return [];

  const top = Math.max(...tracks.map((format) => format.languagePreference ?? -Infinity));
  const original =
    Number.isFinite(top) && tracks.filter((format) => format.languagePreference === top).length < tracks.length
      ? tracks.find((format) => format.languagePreference === top)?.language
      : undefined;

  const names = displayNames();
  const name = (code: string) => {
    const shown = names?.of(code) ?? code;
    return shown.charAt(0).toLocaleUpperCase(getLanguage()) + shown.slice(1);
  };

  const options: DropdownOption<string>[] = [
    {
      value: '',
      label: original
        ? translate('options.audioOriginalNamed', { name: name(original) })
        : translate('options.audioOriginal'),
    },
  ];
  for (const code of codes.sort((a, b) => name(a).localeCompare(name(b), getLanguage()))) {
    if (code === original) continue;
    options.push({ value: code, label: name(code) });
  }
  return options;
}

/** What a list is offered, since none of its videos has been read yet. */
const LIST_SUBTITLES = ['tr', 'en', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ar', 'ja', 'ko'];

/**
 * The subtitles to pick from, starting with none. Machine captions come in
 * every language a site can translate into, so only the two worth having are
 * offered: the one the video speaks, which the source marks `-orig`, and the
 * language of this app.
 */
export function subtitleOptions(metadata: MediaMetadata): DropdownOption<string>[] {
  const names = displayNames();
  const nameOf = (code: string) => {
    let shown: string | undefined;
    try {
      shown = names?.of(code);
    } catch {
      // A code `Intl` will not take, such as `en-orig`: the language in front of it may do.
      shown = code.includes('-') ? names?.of(code.split('-')[0]!) : undefined;
    }
    const text = shown ?? code;
    return text.charAt(0).toLocaleUpperCase(getLanguage()) + text.slice(1);
  };

  const none = { value: '', label: translate('options.none') };
  if (metadata.listing) {
    return [none, ...LIST_SUBTITLES.map((code) => ({ value: code, label: nameOf(code) }))];
  }

  const tracks = metadata.subtitles ?? [];
  if (tracks.length === 0) return [];
  const worthOffering = (language: string) =>
    language.endsWith('-orig') || language.split('-')[0] === getLanguage();
  const byName = (a: string, b: string) => a.localeCompare(b, getLanguage());

  const people = tracks
    .filter((track) => !track.automatic)
    .map((track) => ({ value: track.language, label: track.name ?? nameOf(track.language) }))
    .sort((a, b) => byName(a.label, b.label));
  const machines = tracks
    .filter((track) => track.automatic && worthOffering(track.language))
    .map((track) => ({
      value: track.language,
      label: translate('options.subtitleAuto', { name: nameOf(track.language) }),
    }))
    .sort((a, b) => byName(a.label, b.label));

  const offered = [...people, ...machines];
  return offered.length > 0 ? [none, ...offered] : [];
}

function displayNames(): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames([getLanguage()], { type: 'language' });
  } catch {
    return null;
  }
}

/** "H.264 · 30 fps · 4.2 Mbps" for the advanced stream pickers. */
export function describeStream(format: MediaFormat | undefined): string | undefined {
  if (!format) return undefined;

  const parts: string[] = [];
  const codec = prettyCodec(format.vcodec ?? format.acodec);
  if (codec) parts.push(codec);
  if (format.fps != null && format.fps > 0) parts.push(`${Math.round(format.fps)} fps`);

  const bitrate = formatBitrate(format.vbr ?? format.abr ?? format.tbr);
  if (bitrate) parts.push(bitrate);
  parts.push(format.container.toUpperCase());

  return parts.join(' · ');
}

/**
 * The picture menu of the advanced panel. `chosen` is the picture the plan
 * took (or the one picked by hand); see `onePerRendition`.
 */
export function videoStreamOptions(
  metadata: MediaMetadata,
  chosen?: string | null,
): DropdownOption<string>[] {
  return onePerRendition(
    metadata.formats.filter((format) => format.hasVideo),
    (format) => ({
      value: format.id,
      label: format.hasAudio
        ? translate('options.withSound', { quality: format.qualityLabel })
        : format.qualityLabel,
      description: describeStream(format),
      meta: sizeLabel(format),
    }),
    chosen,
  );
}

/**
 * The sound menu of the advanced panel. `chosen` is the sound the plan took
 * (or the one picked by hand), so that the copy it names is the copy listed:
 * the menu otherwise has nothing to show for it but a bare "--".
 */
export function audioStreamOptions(
  metadata: MediaMetadata,
  chosen?: string | null,
): DropdownOption<string>[] {
  const apart = metadata.formats.filter((format) => format.kind === 'audio');
  const options =
    apart.length > 0
      ? apart.map((format) => ({
          value: format.id,
          label: format.qualityLabel,
          description: describeStream(format),
          meta: sizeLabel(format),
        }))
      : borrowedSoundOptions(metadata, chosen);

  return [{ value: '', label: translate('options.none') }, ...options];
}

/**
 * The sound of each rendition that carries one, for a source that keeps no
 * sound apart.
 *
 * TikTok publishes its sharpest picture without sound and its sound only
 * inside another rendition, and the plan takes it from there (see
 * `sound_donor` in plan.rs); without these the menu shows a bare "--" for
 * that choice, and has nothing to offer someone who picks the picture by
 * hand. Only renditions that name their sound codec, as the plan requires,
 * and a stamped one only when nothing clean has sound -- but what the plan
 * took is always listed, and once per rendition (see `onePerRendition`).
 *
 * Nothing at all where every picture brings its own sound and none was taken
 * out of one: lent to a picture that already has sound, it is dropped, and an
 * entry for it would be a choice that changes nothing.
 */
function borrowedSoundOptions(
  metadata: MediaMetadata,
  chosen: string | null | undefined,
): DropdownOption<string>[] {
  const muxed = metadata.formats.filter((format) => format.kind === 'muxed' && format.hasAudio);
  const picked = muxed.find((format) => format.id === chosen);
  if (!picked && !metadata.formats.some((format) => format.kind === 'video')) return [];

  const named = muxed.filter((format) => format.acodec != null && format.acodec !== 'none');
  const clean = named.filter((format) => format.watermarked !== true);
  const pool = [...(clean.length > 0 ? clean : named)];
  if (picked && !pool.includes(picked)) pool.push(picked);

  return onePerRendition(
    pool,
    (format) => ({
      value: format.id,
      label: translate('options.soundOf', { quality: format.qualityLabel }),
      description: describeSound(format),
      meta: sizeLabel(format),
    }),
    chosen,
  );
}

/**
 * One entry for each choice that reads differently. TikTok lists every
 * rendition twice, once per CDN, and two entries that say the same thing are
 * one choice to the person reading them. The copy kept is `chosen` when it is
 * one of them, so the menu shows what the plan took rather than a bare "--";
 * otherwise the last listed, which is the copy the plan takes itself.
 */
function onePerRendition(
  formats: MediaFormat[],
  toOption: (format: MediaFormat) => DropdownOption<string>,
  chosen: string | null | undefined,
): DropdownOption<string>[] {
  const kept = new Map<string, DropdownOption<string>>();
  for (const format of formats) {
    const option = toOption(format);
    // What the entry says, and what it carries without saying: two entries
    // that differ only in the language of their sound are still two choices.
    const key = [
      option.label,
      option.description,
      option.meta,
      format.language,
      format.note,
      format.protocol,
    ].join('|');
    const held = kept.get(key);
    if (held == null || held.value !== chosen) kept.set(key, option);
  }
  return [...kept.values()];
}

/** "AAC · 128 kbps": the sound of a rendition, without its picture. */
function describeSound(format: MediaFormat): string | undefined {
  const parts = [prettyCodec(format.acodec), formatBitrate(format.abr)].filter(
    (part): part is string => part != null,
  );
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function sizeLabel(format: MediaFormat): string | undefined {
  const size = format.filesize ?? format.filesizeApprox;
  if (size == null) return undefined;
  return format.filesize == null ? `~${formatBytes(size)}` : formatBytes(size);
}

/** Whether the watermark control is meaningful for this source. */
export function watermarkState(
  metadata: MediaMetadata,
): 'hidden' | 'available' | 'unavailable' {
  switch (metadata.watermarkSupport) {
    case 'cleanAvailable':
      return 'available';
    case 'watermarkedOnly':
      return 'unavailable';
    default:
      return 'hidden';
  }
}
