/**
 * Live integration tests: real yt-dlp + ffmpeg + @discordjs/voice audio pipeline against YouTube.
 * Needs network access. Skip with SKIP_NETWORK_TESTS=1.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NoSubscriberBehavior } from '@discordjs/voice';
import pino from 'pino';
import { ensureYtDlp } from '../src/music/ytdlpBinary.js';
import { YtDlp } from '../src/music/YtDlp.js';
import { StreamFactory } from '../src/music/StreamFactory.js';
import { GuildPlayer } from '../src/music/GuildPlayer.js';
import { Track } from '../src/music/Track.js';
import { TrackError } from '../src/utils/errors.js';
import { LoopMode } from '../src/queue/Queue.js';
import { config } from '../src/config/index.js';

const skip = process.env.SKIP_NETWORK_TESTS === '1';
const logger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });
const RICK = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // 19 seconds long
const PLAYLIST = 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI';
const requester = { id: 'tester', tag: 'tester' };

const options = {
  maxQueueSize: 100,
  historySize: 20,
  queueEndTimeout: 60_000,
  emptyChannelTimeout: 60_000,
  idlePlayerTimeout: 60_000,
  maxConsecutiveFailures: 5,
  maxVolume: 200,
};

const waitFor = (emitter, event, timeout = 60_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });

/** Pull Opus packets out of a resource for `ms` and count them (50 packets = 1 s of audio). */
function countOpusPackets(resource, ms) {
  return new Promise((resolve) => {
    let packets = 0;
    const stream = resource.playStream;
    const onData = () => packets++;
    stream.on('data', onData);
    setTimeout(() => {
      stream.off('data', onData);
      stream.destroy();
      resolve(packets);
    }, ms);
  });
}

describe('YouTube integration', { skip, timeout: 300_000 }, () => {
  let ytdlp;
  let factory;
  const players = [];

  before(async () => {
    const binary = await ensureYtDlp({ configuredPath: config.ytdlp.path, logger });
    ytdlp = new YtDlp({ binaryPath: binary.path, cookiesPath: config.ytdlp.cookiesPath, logger, timeoutMs: 60_000 });
    factory = new StreamFactory({ ytdlp, ffmpegPath: config.ffmpegPath, logger });
  });

  after(() => {
    for (const p of players) p.destroy('test-end');
    ytdlp?.killAll();
  });

  const newPlayer = (guildId) => {
    const p = new GuildPlayer({
      guildId,
      streamFactory: factory,
      prefetcher: ytdlp,
      settings: { defaultVolume: 80, defaultLoop: LoopMode.OFF, allowDuplicates: true },
      options,
      logger,
      noSubscriberBehavior: NoSubscriberBehavior.Play,
    });
    players.push(p);
    return p;
  };

  test('resolves a single video URL', async () => {
    const res = await ytdlp.resolve(RICK);
    assert.equal(res.kind, 'video');
    assert.equal(res.tracks[0].videoId, 'dQw4w9WgXcQ');
    assert.match(res.tracks[0].title, /never gonna give you up/i);
    assert.ok(res.tracks[0].duration > 200 && res.tracks[0].duration < 220);
    assert.ok(ytdlp.streamCache.get('dQw4w9WgXcQ'), 'stream URL cached from metadata call');
  });

  test('resolves a search query', async () => {
    const res = await ytdlp.resolve('rick astley never gonna give you up');
    assert.equal(res.kind, 'search');
    assert.equal(res.tracks.length, 1);
    assert.ok(res.tracks[0].videoId.length === 11);
  });

  test('resolves a playlist (flat, capped by limit)', async () => {
    const res = await ytdlp.resolve(PLAYLIST, { playlistLimit: 25 });
    assert.equal(res.kind, 'playlist');
    assert.ok(res.tracks.length > 5 && res.tracks.length <= 25, `got ${res.tracks.length}`);
    assert.ok(res.playlist.title.length > 0);
    assert.ok(res.playlist.total >= res.tracks.length);
    assert.ok(res.tracks.every((t) => t.videoId && t.title));
  });

  test('unavailable video, invalid URL and missing playlist produce friendly errors', async () => {
    await assert.rejects(ytdlp.resolve('https://www.youtube.com/watch?v=aaaaaaaaaab'), (e) => e instanceof TrackError && e.code === 'UNAVAILABLE');
    await assert.rejects(ytdlp.resolve('https://vimeo.com/123'), (e) => e.code === 'INVALID_URL');
    await assert.rejects(
      ytdlp.resolve('https://www.youtube.com/playlist?list=PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
      (e) => e instanceof TrackError && ['PLAYLIST_UNAVAILABLE', 'UNAVAILABLE', 'EXTRACTION_FAILED'].includes(e.code),
    );
  });

  test('stream factory produces real Opus audio, including after a seek', async () => {
    const track = new Track({ ...(await ytdlp.getVideo('dQw4w9WgXcQ')), requestedBy: requester });
    const r1 = await factory.create(track);
    const packets = await countOpusPackets(r1, 1500);
    r1.metadata.source.kill();
    assert.ok(packets >= 50, `expected ≥50 opus packets, got ${packets}`);

    const t0 = Date.now();
    const r2 = await factory.create(track, { seek: 150 });
    assert.ok(Date.now() - t0 < 10_000, 'seek should start quickly (HTTP range)');
    assert.equal(r2.metadata.startOffset, 150);
    const packets2 = await countOpusPackets(r2, 1000);
    r2.metadata.source.kill();
    assert.ok(packets2 >= 30, `expected audio after seek, got ${packets2}`);
  });

  test('player: dead video is skipped, real song plays, seek works, skip → queue end', async () => {
    const p = newPlayer('int-1');
    const errors = [];
    p.on('trackError', (t, e) => errors.push(e.code));
    const bad = new Track({ videoId: 'aaaaaaaaaab', title: 'deleted', requestedBy: requester });
    const good = new Track({ ...(await ytdlp.getVideo('dQw4w9WgXcQ')), requestedBy: requester });
    const started = waitFor(p, 'trackStart');
    await p.enqueue([bad, good]);
    const [track] = await started;
    assert.equal(track.videoId, 'dQw4w9WgXcQ');
    assert.deepEqual(errors, ['UNAVAILABLE']);

    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(p.position > 1, `position should advance, got ${p.position}`);
    await p.seek(120);
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(p.position >= 120.5, `position after seek: ${p.position}`);

    const ended = waitFor(p, 'queueEnd');
    await p.skip();
    await ended;
    assert.equal(p.current, null);
  });

  test('player: natural end of a real track auto-advances to the next one', async () => {
    const p = newPlayer('int-2');
    const zoo = new Track({ ...(await ytdlp.getVideo('jNQXAC9IVRw')), requestedBy: requester });
    const rick = new Track({ ...(await ytdlp.getVideo('dQw4w9WgXcQ')), requestedBy: requester });
    assert.ok(zoo.duration < 30);
    const starts = [];
    p.on('trackStart', (t) => starts.push(t.videoId));
    await p.enqueue([zoo, rick]);
    await waitFor(p, 'trackStart', 60_000); // rick starts after zoo (19 s) ends
    assert.deepEqual(starts, ['jNQXAC9IVRw', 'dQw4w9WgXcQ']);
    p.destroy('done');
  });

  test('player: YouTube playlist tracks play one after another, two guilds at once', async () => {
    const res = await ytdlp.resolve(PLAYLIST, { playlistLimit: 3 });
    const a = newPlayer('int-a');
    const b = newPlayer('int-b');
    const startsA = [];
    const startsB = [];
    a.on('trackStart', (t) => startsA.push(t.videoId));
    b.on('trackStart', (t) => startsB.push(t.videoId));
    await Promise.all([
      a.enqueue(res.tracks.map((t) => new Track({ ...t, requestedBy: requester }))),
      b.enqueue([new Track({ ...(await ytdlp.getVideo('jNQXAC9IVRw')), requestedBy: requester })]),
    ]);
    // Skip through the playlist in guild A while guild B keeps playing its own track.
    for (let i = 1; i < res.tracks.length; i++) {
      await a.skip();
    }
    assert.deepEqual(startsA, res.tracks.map((t) => t.videoId));
    assert.deepEqual(startsB, ['jNQXAC9IVRw']);
    assert.ok(b.isPlaying, 'guild B unaffected by guild A skips');
    assert.equal(b.current.videoId, 'jNQXAC9IVRw');
  });
});
