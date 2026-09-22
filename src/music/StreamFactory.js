import { spawn } from 'node:child_process';
import { createAudioResource, StreamType } from '@discordjs/voice';
import { TrackError } from '../utils/errors.js';

const STARTUP_TIMEOUT_MS = 20_000;

/**
 * Handle for the external processes feeding one audio resource.
 * Tracks exit status so the player can tell "song finished" from "stream died".
 */
export class StreamSource {
  constructor(processes) {
    this.processes = processes;
    this.killed = false;
    this.exitCode = null;
    this.stderr = '';
    const ffmpeg = processes[0];
    ffmpeg.stderr?.on('data', (chunk) => {
      if (this.stderr.length < 8192) this.stderr += chunk.toString();
    });
    this.exited = new Promise((resolve) => {
      ffmpeg.once('close', (code) => {
        this.exitCode = code;
        resolve(code);
      });
    });
  }

  /** True when ffmpeg ended with an error that we did not cause. */
  get failed() {
    return !this.killed && this.exitCode !== null && this.exitCode !== 0;
  }

  reapHelpers() {
    for (const proc of this.processes.slice(1)) {
      if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
    }
  }

  /** Intentionally stop the stream (skip, seek, stop). */
  kill() {
    if (this.killed) return;
    this.killed = true;
    for (const proc of this.processes) {
      if (proc.exitCode === null && !proc.killed) proc.kill('SIGKILL');
    }
  }
}

/** Resolve when the stream has data, reject if the producing process dies first. */
function waitForData(stream, source, timeoutMs) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('readable', onReadable);
      source.processes[0].off('close', onClose);
      source.processes[0].off('error', onError);
    };
    const onReadable = () => {
      cleanup();
      resolve();
    };
    const onClose = (code) => {
      cleanup();
      reject(new TrackError('The audio stream ended before playback started.', { code: 'STREAM_FAILED', retryable: true, cause: new Error(`ffmpeg exited ${code}: ${source.stderr.trim().slice(-500)}`) }));
    };
    const onError = (err) => {
      cleanup();
      reject(new TrackError('FFmpeg could not be started. Is it installed?', { code: 'FFMPEG_MISSING', cause: err }));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new TrackError('Timed out while starting the audio stream.', { code: 'STREAM_TIMEOUT', retryable: true }));
    }, timeoutMs);
    stream.once('readable', onReadable);
    source.processes[0].once('close', onClose);
    source.processes[0].once('error', onError);
  });
}

function headerArgs(headers) {
  const entries = Object.entries(headers ?? {});
  if (!entries.length) return [];
  return ['-headers', entries.map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n'];
}

const OUTPUT_ARGS = ['-vn', '-sn', '-dn', '-f', 's16le', '-ar', '48000', '-ac', '2', '-loglevel', 'error', 'pipe:1'];

/**
 * Turns a Track into a playable @discordjs/voice AudioResource.
 *
 * Primary path: yt-dlp resolves the signed media URL (cached) → ffmpeg reads it directly (supports fast seeking
 * via HTTP range requests and transparent reconnects) → raw PCM → inline volume → Opus.
 * Fallback path: yt-dlp downloads to stdout → ffmpeg stdin (slower seeking, but robust to URL issues).
 */
export class StreamFactory {
  constructor({ ytdlp, ffmpegPath = 'ffmpeg', logger }) {
    this.ytdlp = ytdlp;
    this.ffmpegPath = ffmpegPath;
    this.logger = logger;
  }

  /**
   * @param {import('./Track.js').Track} track
   * @param {{ seek?: number, metadata?: object }} [opts]
   */
  async create(track, { seek = 0, metadata = {} } = {}) {
    let lastError;
    // Attempt 1: cached URL. Attempt 2: freshly resolved URL (cached one may have expired / 403).
    for (const fresh of [false, true]) {
      let stream;
      try {
        stream = await this.ytdlp.getStreamInfo(track.videoId, { fresh });
      } catch (err) {
        // Extraction errors (private, deleted, ...) are final unless transient.
        if (err instanceof TrackError && !err.retryable) throw err;
        lastError = err;
        continue;
      }
      try {
        return await this.startDirect(track, stream, seek, metadata);
      } catch (err) {
        lastError = err;
        this.ytdlp.invalidateStream(track.videoId);
        if (err.code === 'FFMPEG_MISSING') throw err;
        this.logger?.debug({ videoId: track.videoId, fresh, err: err.cause?.message ?? err.message }, 'Direct stream failed');
      }
    }
    if (track.isLive) throw lastError;
    try {
      this.logger?.info({ videoId: track.videoId }, 'Falling back to piped yt-dlp stream');
      return await this.startPiped(track, seek, metadata);
    } catch (err) {
      throw err instanceof TrackError ? err : lastError ?? err;
    }
  }

  async startDirect(track, stream, seek, metadata) {
    const inputArgs = stream.isLive
      ? []
      : ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5'];
    const args = [
      '-hide_banner', '-nostdin',
      ...inputArgs,
      ...(seek > 0 && !stream.isLive ? ['-ss', String(seek)] : []),
      ...headerArgs(stream.headers),
      '-i', stream.url,
      ...OUTPUT_ARGS,
    ];
    const ffmpeg = spawn(this.ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return this.finish(track, new StreamSource([ffmpeg]), ffmpeg.stdout, seek, metadata);
  }

  async startPiped(track, seek, metadata) {
    const dl = this.ytdlp.spawnDownload(track.videoId);
    // Seeking on a pipe decodes and discards, so -ss goes after -i here (accurate, slower).
    const args = ['-hide_banner', '-i', 'pipe:0', ...(seek > 0 ? ['-ss', String(seek)] : []), ...OUTPUT_ARGS];
    const ffmpeg = spawn(this.ffmpegPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    dl.stdout.pipe(ffmpeg.stdin);
    ffmpeg.stdin.on('error', () => {}); // EPIPE when ffmpeg is killed first
    dl.stdout.on('error', () => {});
    return this.finish(track, new StreamSource([ffmpeg, dl]), ffmpeg.stdout, seek, metadata, STARTUP_TIMEOUT_MS * 2);
  }

  async finish(track, source, output, seek, metadata, timeout = STARTUP_TIMEOUT_MS) {
    output.on('error', () => {}); // errors are surfaced via process exit codes
    try {
      await waitForData(output, source, timeout);
    } catch (err) {
      source.kill();
      throw err;
    }
    const resource = createAudioResource(output, {
      inputType: StreamType.Raw,
      inlineVolume: true,
      metadata: { ...metadata, track, source, startOffset: seek },
    });
    // When ffmpeg's output ends, make sure helper processes (the yt-dlp downloader) do not linger.
    output.once('close', () => source.reapHelpers());
    return resource;
  }
}
