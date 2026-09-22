import { spawn } from 'node:child_process';
import { Semaphore, sleep } from '../utils/concurrency.js';
import { LruCache } from '../utils/lruCache.js';
import { TrackError } from '../utils/errors.js';
import { parseYouTubeUrl, playlistUrl, videoUrl } from './youtubeUrl.js';

const AUDIO_FORMAT = 'bestaudio[acodec=opus]/bestaudio/best';
const MAX_STDOUT = 64 * 1024 * 1024; // guard against runaway output on huge playlists

/** Map yt-dlp stderr to a user-friendly, typed error. */
export function classifyYtDlpError(stderr) {
  const text = String(stderr ?? '');
  const line = text.split('\n').find((l) => l.startsWith('ERROR:')) ?? text.trim().split('\n').pop() ?? '';
  const rules = [
    [/private video/i, 'PRIVATE', 'This video is private.'],
    [/confirm your age|age[- ]restricted|inappropriate for some users/i, 'AGE_RESTRICTED',
      'This video is age-restricted. The bot owner can enable it by configuring YTDLP_COOKIES.'],
    [/confirm you.?re not a bot|sign in to confirm/i, 'BOT_CHECK',
      'YouTube is asking the bot to sign in (anti-bot check). Try again later or configure YTDLP_COOKIES.'],
    [/members[- ]only|join this channel/i, 'MEMBERS_ONLY', 'This video is for channel members only.'],
    [/premieres in|live event will begin|scheduled/i, 'NOT_STARTED', 'This live stream / premiere has not started yet.'],
    [/not available in your country|blocked it in your country|geo.?restrict/i, 'GEO_BLOCKED', 'This video is not available in the bot\'s region.'],
    [/copyright/i, 'COPYRIGHT', 'This video was removed due to a copyright claim.'],
    [/playlist does not exist|this playlist (is private|type is unviewable)|unable to recognize playlist/i, 'PLAYLIST_UNAVAILABLE',
      'That playlist does not exist or is private.'],
    [/video unavailable|this video is unavailable|has been removed|account .* terminated|not available|does not exist|incomplete youtube id/i,
      'UNAVAILABLE', 'This video is unavailable (deleted, private or blocked).'],
    [/requested format is not available|no video formats found/i, 'NO_FORMAT', 'No playable audio format was found for this video.'],
    [/HTTP Error 429|too many requests/i, 'RATE_LIMITED', 'YouTube is rate-limiting the bot right now. Please try again shortly.', true],
    [/timed out|getaddrinfo|ENOTFOUND|ECONNRESET|connection (reset|refused|aborted)|network is unreachable|unable to download (webpage|api)|HTTP Error 5\d\d|SSL/i,
      'NETWORK', 'A network error occurred while contacting YouTube.', true],
  ];
  for (const [re, code, message, retryable = false] of rules) {
    if (re.test(text)) return new TrackError(message, { code, retryable, cause: new Error(line) });
  }
  return new TrackError('Failed to extract this video from YouTube.', { code: 'EXTRACTION_FAILED', retryable: true, cause: new Error(line) });
}

function pickThumbnail(info) {
  if (info.thumbnail && !info.thumbnail.endsWith('.webp')) return info.thumbnail;
  return info.id ? `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg` : info.thumbnail;
}

function isUnavailableEntry(entry) {
  if (!entry || !entry.id) return true;
  const title = String(entry.title ?? '');
  return /^\[(deleted|private) video\]$/i.test(title) || entry.availability === 'needs_auth' || entry.availability === 'subscriber_only';
}

/** Convert a yt-dlp info dict (full or flat) into plain track data. */
export function toTrackData(info) {
  const live = info.is_live === true || info.live_status === 'is_live';
  return {
    videoId: info.id,
    url: videoUrl(info.id),
    title: info.title ?? info.fulltitle ?? 'Unknown title',
    author: info.channel ?? info.uploader ?? info.artist ?? 'Unknown',
    duration: live ? null : info.duration ?? null,
    thumbnail: pickThumbnail(info),
    isLive: live,
  };
}

function streamFromInfo(info) {
  const fmt = info.requested_formats?.find((f) => f.acodec && f.acodec !== 'none') ?? info;
  if (!fmt.url) return null;
  const expire = Number(new URL(fmt.url).searchParams.get('expire'));
  const expiresAt = Number.isFinite(expire) && expire > 0 ? expire * 1000 : Date.now() + 3 * 3600 * 1000;
  return {
    url: fmt.url,
    headers: fmt.http_headers ?? info.http_headers ?? {},
    isLive: info.is_live === true,
    protocol: fmt.protocol ?? info.protocol ?? 'https',
    expiresAt,
  };
}

/**
 * Thin, concurrency-limited client around the yt-dlp binary.
 */
export class YtDlp {
  constructor({ binaryPath, cookiesPath, extraArgs = [], timeoutMs = 45_000, maxConcurrency = 3, logger }) {
    this.binaryPath = binaryPath;
    this.cookiesPath = cookiesPath;
    this.extraArgs = extraArgs;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.semaphore = new Semaphore(maxConcurrency);
    /** videoId → stream info (direct media URL). Expires with the signed URL. */
    this.streamCache = new LruCache({ max: 300 });
    /** videoId → in-flight promise, so concurrent requests for the same video share one process. */
    this.inflight = new Map();
    /** Child processes currently running, so shutdown can kill them. */
    this.children = new Set();
  }

  baseArgs() {
    return [
      '--ignore-config',
      '--no-warnings',
      '--no-progress',
      '--no-update',
      '--js-runtimes', `node:${process.execPath}`,
      ...(this.cookiesPath ? ['--cookies', this.cookiesPath] : []),
      ...this.extraArgs,
    ];
  }

  /** Run yt-dlp and collect stdout. Rejects with a classified TrackError. */
  exec(args, { timeoutMs = this.timeoutMs } = {}) {
    return this.semaphore.run(
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(this.binaryPath, [...this.baseArgs(), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
          this.children.add(child);
          const out = [];
          let outLen = 0;
          let stderr = '';
          let settled = false;
          const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.children.delete(child);
            fn(value);
          };
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(reject, new TrackError('YouTube took too long to respond.', { code: 'TIMEOUT', retryable: true }));
          }, timeoutMs);
          child.stdout.on('data', (chunk) => {
            outLen += chunk.length;
            if (outLen > MAX_STDOUT) {
              child.kill('SIGKILL');
              finish(reject, new TrackError('The response from YouTube was too large.', { code: 'TOO_LARGE' }));
              return;
            }
            out.push(chunk);
          });
          child.stderr.on('data', (chunk) => {
            if (stderr.length < 16_384) stderr += chunk.toString();
          });
          child.on('error', (err) =>
            finish(reject, new TrackError('The YouTube extractor (yt-dlp) could not be started.', { code: 'SPAWN_FAILED', cause: err })),
          );
          child.on('close', (code) => {
            if (code === 0) finish(resolve, Buffer.concat(out).toString('utf8'));
            else finish(reject, classifyYtDlpError(stderr));
          });
        }),
    );
  }

  async execJson(args, opts) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const stdout = await this.exec(args, opts);
        return JSON.parse(stdout);
      } catch (err) {
        lastErr = err instanceof TrackError ? err : new TrackError('Unexpected response from YouTube.', { code: 'BAD_JSON', cause: err });
        if (!lastErr.retryable || attempt === 1) break;
        this.logger?.debug({ code: lastErr.code, args: args.at(-1) }, 'yt-dlp retrying after retryable error');
        await sleep(1500);
      }
    }
    throw lastErr;
  }

  /** Full metadata for one video (also warms the stream cache, since we get the media URL for free). */
  async getVideo(videoId) {
    const info = await this.execJson(['-J', '--no-playlist', '-f', AUDIO_FORMAT, videoUrl(videoId)]);
    const stream = streamFromInfo(info);
    if (stream && !stream.isLive) this.cacheStream(info.id, stream);
    return toTrackData(info);
  }

  /**
   * Flat playlist extraction (fast: one request per ~100 entries, no per-video extraction).
   * @returns {Promise<{ title: string, url: string, tracks: object[], unavailable: number, total: number, truncated: boolean }>}
   */
  async getPlaylist(listId, limit) {
    const info = await this.execJson(
      ['-J', '--flat-playlist', '--playlist-end', String(limit), playlistUrl(listId)],
      { timeoutMs: Math.max(this.timeoutMs, 120_000) },
    );
    const entries = Array.isArray(info.entries) ? info.entries : [];
    const valid = entries.filter((e) => !isUnavailableEntry(e));
    const total = Number(info.playlist_count) || entries.length;
    return {
      title: info.title ?? 'YouTube playlist',
      url: playlistUrl(listId),
      tracks: valid.map(toTrackData),
      unavailable: entries.length - valid.length,
      total,
      truncated: total > entries.length,
    };
  }

  async search(query, limit = 5) {
    const safe = String(query).replace(/[\r\n]/g, ' ').slice(0, 200);
    const info = await this.execJson(['-J', '--flat-playlist', `ytsearch${limit}:${safe}`]);
    return (info.entries ?? []).filter((e) => !isUnavailableEntry(e)).map(toTrackData);
  }

  /**
   * Resolve free-form user input (URL or search text) into tracks.
   * @returns {Promise<{ kind: 'video'|'playlist'|'search', tracks: object[], playlist?: object, start?: number }>}
   */
  async resolve(input, { playlistLimit = 500 } = {}) {
    const parsed = parseYouTubeUrl(input);
    if (parsed?.type === 'unsupported') throw new TrackError(parsed.reason, { code: 'INVALID_URL' });
    if (parsed?.type === 'playlist') {
      const playlist = await this.getPlaylist(parsed.listId, playlistLimit);
      if (playlist.tracks.length === 0) throw new TrackError('That playlist has no playable videos.', { code: 'EMPTY_PLAYLIST' });
      return { kind: 'playlist', tracks: playlist.tracks, playlist };
    }
    if (parsed?.type === 'video') {
      return { kind: 'video', tracks: [await this.getVideo(parsed.videoId)], start: parsed.start };
    }
    const results = await this.search(input, 1);
    if (!results.length) throw new TrackError(`No results found for "${String(input).slice(0, 100)}".`, { code: 'NO_RESULTS' });
    return { kind: 'search', tracks: results };
  }

  cacheStream(videoId, stream) {
    const ttl = Math.min(stream.expiresAt - Date.now() - 5 * 60_000, 4 * 3600_000);
    if (ttl > 60_000) this.streamCache.set(videoId, stream, ttl);
  }

  invalidateStream(videoId) {
    this.streamCache.delete(videoId);
  }

  /** Get a playable direct media URL for a video, using the cache when possible. */
  async getStreamInfo(videoId, { fresh = false } = {}) {
    if (!fresh) {
      const cached = this.streamCache.get(videoId);
      if (cached) return cached;
    }
    const key = `${videoId}:${fresh}`;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const promise = (async () => {
      const info = await this.execJson(['-J', '--no-playlist', '-f', AUDIO_FORMAT, videoUrl(videoId)]);
      const stream = streamFromInfo(info);
      if (!stream) throw new TrackError('No playable audio stream was found.', { code: 'NO_FORMAT' });
      if (!stream.isLive) this.cacheStream(videoId, stream);
      return stream;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /** Best-effort warm-up of the stream cache for an upcoming track. Never throws. */
  prefetch(videoId) {
    if (!videoId || this.streamCache.get(videoId)) return;
    this.getStreamInfo(videoId).catch((err) => this.logger?.debug({ videoId, code: err.code }, 'Prefetch failed'));
  }

  /** Spawn yt-dlp writing raw media to stdout (fallback path when ffmpeg cannot read the URL directly). */
  spawnDownload(videoId) {
    const child = spawn(
      this.binaryPath,
      [...this.baseArgs(), '-f', AUDIO_FORMAT, '--no-playlist', '--no-part', '--quiet', '-o', '-', videoUrl(videoId)],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.children.add(child);
    child.on('close', () => this.children.delete(child));
    child.on('error', () => this.children.delete(child));
    return child;
  }

  killAll() {
    for (const child of this.children) child.kill('SIGKILL');
    this.children.clear();
  }
}
