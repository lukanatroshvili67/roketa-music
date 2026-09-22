import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, parseTimestamp, progressBar, escapeMarkdown } from '../src/utils/format.js';
import { parseYouTubeUrl } from '../src/music/youtubeUrl.js';
import { classifyYtDlpError, toTrackData } from '../src/music/YtDlp.js';
import { RateLimiter, Cooldown } from '../src/utils/rateLimiter.js';
import { LruCache } from '../src/utils/lruCache.js';
import { Mutex, Semaphore, sleep } from '../src/utils/concurrency.js';

describe('format', () => {
  test('formatDuration', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(65), '1:05');
    assert.equal(formatDuration(3725), '1:02:05');
    assert.equal(formatDuration(null), 'LIVE');
  });

  test('parseTimestamp accepts common formats', () => {
    assert.equal(parseTimestamp('90'), 90);
    assert.equal(parseTimestamp('1:30'), 90);
    assert.equal(parseTimestamp('01:02:03'), 3723);
    assert.equal(parseTimestamp('1m30s'), 90);
    assert.equal(parseTimestamp('2h'), 7200);
    assert.equal(parseTimestamp('1:75'), null);
    assert.equal(parseTimestamp('abc'), null);
    assert.equal(parseTimestamp(''), null);
  });

  test('progressBar', () => {
    assert.ok(progressBar(50, 100).includes('🔘'));
    assert.equal(progressBar(1, null), '🔴 LIVE');
  });

  test('escapeMarkdown neutralises formatting', () => {
    assert.equal(escapeMarkdown('**a** [x](y)'), '\\*\\*a\\*\\* \\[x\\]\\(y\\)');
  });
});

describe('YouTube URL parsing', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', { type: 'video', videoId: 'dQw4w9WgXcQ' }],
    ['https://youtu.be/dQw4w9WgXcQ?t=42', { type: 'video', videoId: 'dQw4w9WgXcQ', start: 42 }],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s', { type: 'video', videoId: 'dQw4w9WgXcQ', start: 65 }],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', { type: 'video', videoId: 'dQw4w9WgXcQ' }],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', { type: 'video', videoId: 'dQw4w9WgXcQ' }],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', { type: 'video', videoId: 'dQw4w9WgXcQ' }],
    ['https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', { type: 'playlist', listId: 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI' }],
    [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI',
      { type: 'video', videoId: 'dQw4w9WgXcQ', listId: 'PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI' },
    ],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ', { type: 'video', videoId: 'dQw4w9WgXcQ' }],
  ];
  for (const [url, expected] of cases) {
    test(url, () => assert.deepEqual(parseYouTubeUrl(url), expected));
  }

  test('search text is not a URL', () => assert.equal(parseYouTubeUrl('never gonna give you up'), null));
  test('non-YouTube URL is unsupported', () => assert.equal(parseYouTubeUrl('https://example.com/watch?v=x').type, 'unsupported'));
  test('broken video id is unsupported', () => assert.equal(parseYouTubeUrl('https://youtube.com/watch?v=short').type, 'unsupported'));
});

describe('yt-dlp error classification', () => {
  const cases = [
    ['ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access', 'PRIVATE'],
    ['ERROR: [youtube] abc: This video is unavailable', 'UNAVAILABLE'],
    ['ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader', 'UNAVAILABLE'],
    ['ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.', 'AGE_RESTRICTED'],
    ["ERROR: [youtube] abc: Sign in to confirm you're not a bot", 'BOT_CHECK'],
    ['ERROR: [youtube] abc: Join this channel to get access to members-only content', 'MEMBERS_ONLY'],
    ['ERROR: Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>', 'NETWORK'],
    ['ERROR: [youtube] abc: HTTP Error 429: Too Many Requests', 'RATE_LIMITED'],
    ['ERROR: [youtube:tab] The playlist does not exist.', 'PLAYLIST_UNAVAILABLE'],
    ['ERROR: something new and weird', 'EXTRACTION_FAILED'],
  ];
  for (const [stderr, code] of cases) {
    test(code, () => assert.equal(classifyYtDlpError(stderr).code, code));
  }
  test('network errors are retryable, private is not', () => {
    assert.equal(classifyYtDlpError('getaddrinfo failed').retryable, true);
    assert.equal(classifyYtDlpError('Private video').retryable, false);
  });
  test('toTrackData handles live and webp thumbnails', () => {
    const d = toTrackData({ id: 'dQw4w9WgXcQ', title: 'x', is_live: true, duration: 50, thumbnail: 'https://i.ytimg.com/a.webp' });
    assert.equal(d.duration, null);
    assert.equal(d.isLive, true);
    assert.match(d.thumbnail, /hqdefault\.jpg$/);
  });
});

describe('rate limiting and concurrency', () => {
  test('RateLimiter sliding window', () => {
    const rl = new RateLimiter({ limit: 2, windowMs: 1000 });
    assert.equal(rl.consume('u', 0), 0);
    assert.equal(rl.consume('u', 100), 0);
    assert.equal(rl.consume('u', 200), 800);
    assert.equal(rl.consume('other', 200), 0);
    assert.equal(rl.consume('u', 1001), 0);
    rl.prune(10_000);
    assert.equal(rl.hits.size, 0);
    rl.destroy();
  });

  test('Cooldown', () => {
    const c = new Cooldown(1000);
    assert.equal(c.check('a', 0), 0);
    assert.equal(c.check('a', 500), 500);
    assert.equal(c.check('a', 1500), 0);
  });

  test('LruCache evicts oldest and expires', async () => {
    const cache = new LruCache({ max: 2, ttlMs: 30 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a'), 1);
    await sleep(40);
    assert.equal(cache.get('a'), undefined);
  });

  test('Semaphore bounds concurrency', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        sem.run(async () => {
          peak = Math.max(peak, ++active);
          await sleep(10);
          active--;
        }),
      ),
    );
    assert.equal(peak, 2);
  });

  test('Mutex serialises and survives errors', async () => {
    const m = new Mutex();
    const order = [];
    const a = m.run(async () => {
      await sleep(20);
      order.push('a');
    });
    const b = m.run(async () => {
      throw new Error('boom');
    });
    const c = m.run(async () => order.push('c'));
    await a;
    await assert.rejects(b, /boom/);
    await c;
    assert.deepEqual(order, ['a', 'c']);
  });
});
