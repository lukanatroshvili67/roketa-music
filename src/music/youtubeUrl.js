/** YouTube URL parsing (pure, unit tested). */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,}$/;
const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be',
]);

export function isUrl(input) {
  return /^https?:\/\//i.test(String(input).trim());
}

/**
 * @returns {null |
 *   { type: 'video', videoId: string, listId?: string, start?: number } |
 *   { type: 'playlist', listId: string } |
 *   { type: 'unsupported', reason: string }}
 *   null means "not a URL" (treat as a search query).
 */
export function parseYouTubeUrl(input) {
  const text = String(input ?? '').trim();
  if (!isUrl(text)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return { type: 'unsupported', reason: 'That does not look like a valid URL.' };
  }
  const host = url.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) {
    return { type: 'unsupported', reason: 'Only YouTube links are supported.' };
  }

  const listId = url.searchParams.get('list') ?? undefined;
  const start = parseStart(url.searchParams.get('t') ?? url.searchParams.get('start'));
  let videoId;

  if (host.endsWith('youtu.be')) {
    videoId = url.pathname.split('/')[1];
  } else {
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] === 'watch') videoId = url.searchParams.get('v') ?? undefined;
    else if (['shorts', 'live', 'embed', 'v', 'e'].includes(segments[0])) videoId = segments[1];
    else if (segments[0] === 'playlist' && listId && LIST_ID.test(listId)) return { type: 'playlist', listId };
  }

  if (videoId && VIDEO_ID.test(videoId)) {
    // Auto-generated "mix"/radio lists (RD...) are effectively endless — play just the video.
    const usableList = listId && LIST_ID.test(listId) && !listId.startsWith('RD') ? listId : undefined;
    return { type: 'video', videoId, ...(usableList ? { listId: usableList } : {}), ...(start ? { start } : {}) };
  }
  if (listId && LIST_ID.test(listId) && !listId.startsWith('RD')) return { type: 'playlist', listId };
  return { type: 'unsupported', reason: 'Could not find a video or playlist in that YouTube link.' };
}

function parseStart(value) {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!m) return undefined;
  const s = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return s || undefined;
}

export const videoUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
export const playlistUrl = (id) => `https://www.youtube.com/playlist?list=${id}`;
