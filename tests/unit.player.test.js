/**
 * GuildPlayer / PlayerManager behaviour with the real @discordjs/voice AudioPlayer and Opus encoder,
 * fed by synthetic PCM streams (no network, no Discord connection needed).
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  createAudioResource,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import pino from 'pino';
import { GuildPlayer } from '../src/music/GuildPlayer.js';
import { PlayerManager } from '../src/music/PlayerManager.js';
import { Track } from '../src/music/Track.js';
import { TrackError } from '../src/utils/errors.js';
import { LoopMode } from '../src/queue/Queue.js';

const logger = pino({ level: 'silent' });
const BYTES_PER_SECOND = 48000 * 2 * 2;
const options = {
  maxQueueSize: 100,
  historySize: 20,
  queueEndTimeout: 60_000,
  emptyChannelTimeout: 60_000,
  idlePlayerTimeout: 30_000,
  maxConsecutiveFailures: 3,
  maxVolume: 200,
};
const settings = { defaultVolume: 80, defaultLoop: LoopMode.OFF, allowDuplicates: true };

/** Fake StreamFactory: produces `seconds` of silence as raw PCM. Video ids starting with "bad" fail. */
class FakeFactory {
  constructor({ seconds = 0.4 } = {}) {
    this.seconds = seconds;
    this.created = [];
    this.killed = 0;
  }

  async create(track, { seek = 0, metadata = {} } = {}) {
    await new Promise((r) => setTimeout(r, 5));
    if (track.videoId.startsWith('bad')) throw new TrackError('This video is unavailable.', { code: 'UNAVAILABLE' });
    this.created.push({ videoId: track.videoId, seek });
    const total = Math.round(this.seconds * BYTES_PER_SECOND);
    let sent = 0;
    const stream = new Readable({
      read() {
        if (sent >= total) return this.push(null);
        const n = Math.min(3840 * 5, total - sent);
        sent += n;
        this.push(Buffer.alloc(n));
      },
    });
    const factory = this;
    const source = {
      killed: false,
      failed: false,
      exited: Promise.resolve(0),
      kill() {
        if (!this.killed) factory.killed++;
        this.killed = true;
        stream.destroy();
      },
    };
    return createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: true, metadata: { ...metadata, track, source, startOffset: seek } });
  }
}

const track = (id, duration = 0) => new Track({ videoId: id.padEnd(11, '_'), title: id, duration, requestedBy: { id: 'u1', tag: 'u1' } });

function makePlayer(factory = new FakeFactory(), extra = {}) {
  return new GuildPlayer({
    guildId: extra.guildId ?? 'g1',
    streamFactory: factory,
    settings: { ...settings, ...extra.settings },
    options: { ...options, ...extra.options },
    logger,
    noSubscriberBehavior: NoSubscriberBehavior.Play,
  });
}

function collect(player) {
  const events = { started: [], errors: [], queueEnd: 0 };
  player.on('trackStart', (t) => events.started.push(t.title));
  player.on('trackError', (t, e) => events.errors.push(t ? `${t.title}:${e.code}` : e.message));
  player.on('queueEnd', () => events.queueEnd++);
  return events;
}

const waitFor = (emitter, event, timeout = 8000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });
  });

const players = [];
afterEach(() => {
  for (const p of players.splice(0)) p.destroy('test-end');
});
const tracked = (p) => (players.push(p), p);

describe('GuildPlayer playback', () => {
  test('plays tracks in order and auto-advances to the end of the queue', async () => {
    const p = tracked(makePlayer());
    const ev = collect(p);
    const res = await p.enqueue([track('a'), track('b'), track('c')]);
    assert.equal(res.started, true);
    await waitFor(p, 'queueEnd');
    assert.deepEqual(ev.started, ['a', 'b', 'c']);
    assert.equal(p.current, null);
    assert.ok(p.leaveTimer, 'leave timer scheduled after queue end');
  });

  test('adding while playing does not interrupt the current track', async () => {
    const factory = new FakeFactory({ seconds: 0.6 });
    const p = tracked(makePlayer(factory));
    const ev = collect(p);
    await p.enqueue(track('a'));
    const res = await p.enqueue(track('b'));
    assert.equal(res.started, false);
    assert.equal(res.position, 1);
    assert.equal(p.current.title, 'a');
    await waitFor(p, 'queueEnd');
    assert.deepEqual(ev.started, ['a', 'b']);
  });

  test('loop track replays the same track until skipped', async () => {
    const p = tracked(makePlayer(new FakeFactory({ seconds: 0.25 })));
    const ev = collect(p);
    p.setLoop(LoopMode.TRACK);
    await p.enqueue([track('a'), track('b')]);
    while (ev.started.length < 3) await waitFor(p, 'trackStart');
    assert.deepEqual(ev.started.slice(0, 3), ['a', 'a', 'a']);
    await p.skip();
    assert.equal(p.current.title, 'b');
  });

  test('loop queue cycles through all tracks', async () => {
    const p = tracked(makePlayer(new FakeFactory({ seconds: 0.25 })));
    const ev = collect(p);
    p.setLoop(LoopMode.QUEUE);
    await p.enqueue([track('a'), track('b')]);
    while (ev.started.length < 5) await waitFor(p, 'trackStart');
    assert.deepEqual(ev.started.slice(0, 5), ['a', 'b', 'a', 'b', 'a']);
    assert.equal(ev.queueEnd, 0);
  });

  test('unavailable tracks are skipped without stopping playback', async () => {
    const p = tracked(makePlayer());
    const ev = collect(p);
    await p.enqueue([track('bad1'), track('a'), track('bad2'), track('b')]);
    await waitFor(p, 'queueEnd');
    assert.deepEqual(ev.started, ['a', 'b']);
    assert.deepEqual(ev.errors, ['bad1:UNAVAILABLE', 'bad2:UNAVAILABLE']);
    // Failed tracks never enter history, so /previous cannot land on them.
    assert.ok(p.queue.history.every((t) => !t.videoId.startsWith('bad')));
  });

  test('stops after too many consecutive failures', async () => {
    const p = tracked(makePlayer());
    const ev = collect(p);
    await p.enqueue([track('bad1'), track('bad2'), track('bad3'), track('bad4'), track('a')]);
    assert.equal(ev.queueEnd, 1);
    assert.equal(p.queue.size, 0);
    assert.ok(ev.errors.some((e) => /Stopped after 3/.test(e)));
    assert.deepEqual(ev.started, []);
  });

  test('a failed track in loop-track mode does not loop forever', async () => {
    const p = tracked(makePlayer());
    const ev = collect(p);
    p.setLoop(LoopMode.TRACK);
    await p.enqueue([track('bad1'), track('a')]);
    assert.equal(ev.started[0], 'a');
    assert.deepEqual(ev.errors, ['bad1:UNAVAILABLE']);
  });

  test('stream that dies mid-track is resumed from its position', async () => {
    // Duration says 30 s but each stream only yields 1.5 s → "ended early" → resume from the position (max 2 times).
    const factory = new FakeFactory({ seconds: 1.5 });
    const p = tracked(makePlayer(factory));
    const ev = collect(p);
    await p.enqueue([track('a', 30), track('b')]);
    await waitFor(p, 'queueEnd', 15_000);
    const seeks = factory.created.filter((c) => c.videoId.startsWith('a')).map((c) => c.seek);
    assert.deepEqual(seeks, [0, 1, 2]);
    assert.deepEqual(ev.started, ['a', 'b'], 'resumes are silent; playback continues with the next track');
  });

  test('skip, previous, jump, replay and seek', async () => {
    const factory = new FakeFactory({ seconds: 5 });
    const p = tracked(makePlayer(factory));
    await p.enqueue([track('a', 200), track('b', 200), track('c', 200), track('d', 200)]);
    await p.skip();
    assert.equal(p.current.title, 'b');
    await p.previous();
    assert.equal(p.current.title, 'a');
    await p.skip(2); // upcoming is [b, c, d] → position 2 is c
    assert.equal(p.current.title, 'c');
    await p.seek(42);
    assert.equal(factory.created.at(-1).seek, 42);
    assert.ok(p.position >= 42);
    await assert.rejects(p.seek(500), /between/);
    await p.replay();
    assert.equal(factory.created.at(-1).seek, 0);
    assert.ok(factory.killed >= 4, 'replaced streams are killed');
  });

  test('pause / resume / volume / shuffle / remove / move / clear', async () => {
    const p = tracked(makePlayer(new FakeFactory({ seconds: 5 })));
    await p.enqueue([track('a'), track('b'), track('c'), track('d')]);
    await waitFor(p.audioPlayer, 'stateChange');
    await p.pause();
    assert.equal(p.isPaused, true);
    await assert.rejects(p.pause(), /already paused/);
    p.resume();
    assert.equal(p.isPaused, false);
    assert.equal(p.setVolume(150), 150);
    assert.equal(p.currentResource.volume.volume, 1.5);
    assert.throws(() => p.setVolume(500), /between/);
    assert.equal(p.shuffle(), 3);
    assert.equal(p.remove(1).length, 1);
    p.move(2, 1);
    assert.equal(p.clear(), 2);
    assert.throws(() => p.shuffle(), /at least two/);
  });

  test('empty channel pauses, rejoin resumes', async () => {
    const p = tracked(makePlayer(new FakeFactory({ seconds: 5 })));
    await p.enqueue(track('a'));
    await new Promise((r) => setTimeout(r, 100));
    p.onChannelEmpty();
    assert.equal(p.autoPaused, true);
    assert.equal(p.leaveReason, 'channel-empty');
    p.onChannelOccupied();
    assert.equal(p.autoPaused, false);
    assert.equal(p.leaveTimer, null);
    assert.equal(p.isPaused, false);
  });

  test('leave timer destroys the player', async () => {
    const p = tracked(makePlayer(new FakeFactory(), { options: { queueEndTimeout: 50 } }));
    await p.enqueue(track('a'));
    const [reason] = await waitFor(p, 'destroyed');
    assert.equal(reason, 'queue-end');
    assert.equal(p.destroyed, true);
  });

  test('destroy is idempotent, kills the stream and rejects further use', async () => {
    const factory = new FakeFactory({ seconds: 5 });
    const p = makePlayer(factory);
    await p.enqueue(track('a'));
    p.destroy('x');
    p.destroy('y');
    assert.equal(factory.killed, 1);
    assert.equal(p.listenerCount('trackStart'), 0);
    await assert.rejects(p.enqueue(track('b')), /shut down/);
  });

  test('rapid concurrent skips are serialised (no double-advance races)', async () => {
    const p = tracked(makePlayer(new FakeFactory({ seconds: 5 })));
    await p.enqueue([track('a'), track('b'), track('c'), track('d'), track('e')]);
    await Promise.all([p.skip(), p.skip(), p.skip()]);
    assert.equal(p.current.title, 'd');
    assert.deepEqual(p.queue.history.map((t) => t.title), ['a', 'b', 'c']);
  });
});

describe('voice connection resilience', () => {
  /** Minimal stand-in for a VoiceConnection: emits the same events entersState() listens to. */
  class FakeConnection extends EventEmitter {
    constructor() {
      super();
      this.state = { status: VoiceConnectionStatus.Ready };
      this.joinConfig = { channelId: 'vc1' };
      this.rejoinAttempts = 0;
    }
    setState(status, extra = {}) {
      const old = this.state;
      this.state = { status, ...extra };
      this.emit('stateChange', old, this.state);
      this.emit(status, old, this.state);
    }
    rejoin() {
      this.rejoinAttempts++;
      this.setState(VoiceConnectionStatus.Signalling);
      return true;
    }
    destroy() {
      this.setState(VoiceConnectionStatus.Destroyed);
    }
  }

  const connected = async () => {
    const p = tracked(makePlayer(new FakeFactory({ seconds: 30 })));
    const conn = new FakeConnection();
    p.connection = conn;
    p.attachConnectionHandlers(conn);
    await p.enqueue(track('a'));
    return { p, conn };
  };

  test('network drop: rejoins and keeps the queue', async () => {
    const { p, conn } = await connected();
    conn.setState(VoiceConnectionStatus.Disconnected, { reason: VoiceConnectionDisconnectReason.EndpointRemoved });
    await new Promise((r) => setTimeout(r, 3300));
    assert.equal(conn.rejoinAttempts, 1);
    conn.setState(VoiceConnectionStatus.Connecting);
    conn.setState(VoiceConnectionStatus.Ready);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(p.destroyed, false);
    assert.equal(p.current.title, 'a');
  });

  test('kicked from the channel (4014 without reconnect): player is destroyed', async () => {
    const { p, conn } = await connected();
    const destroyed = waitFor(p, 'destroyed', 8000);
    conn.setState(VoiceConnectionStatus.Disconnected, { reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode: 4014 });
    const [reason] = await destroyed;
    assert.equal(reason, 'disconnected');
    assert.equal(p.queue.current, null);
  });

  test('moved to another channel (4014 then reconnect): keeps playing', async () => {
    const { p, conn } = await connected();
    conn.setState(VoiceConnectionStatus.Disconnected, { reason: VoiceConnectionDisconnectReason.WebSocketClose, closeCode: 4014 });
    conn.joinConfig.channelId = 'vc2';
    conn.setState(VoiceConnectionStatus.Connecting);
    conn.setState(VoiceConnectionStatus.Ready);
    await new Promise((r) => setTimeout(r, 5500));
    assert.equal(p.destroyed, false);
    assert.equal(p.voiceChannelId, 'vc2');
  });

  test('gives up after 5 rejoin attempts', async () => {
    const { p, conn } = await connected();
    conn.rejoinAttempts = 5;
    conn.setState(VoiceConnectionStatus.Disconnected, { reason: VoiceConnectionDisconnectReason.EndpointRemoved });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(p.destroyed, true);
  });

  test('connection destroyed externally tears down the player', async () => {
    const { p, conn } = await connected();
    conn.destroy();
    assert.equal(p.destroyed, true);
  });
});

describe('PlayerManager', () => {
  test('guilds are fully independent', async () => {
    const manager = new PlayerManager({
      streamFactory: new FakeFactory({ seconds: 0.4 }),
      getSettings: () => settings,
      options,
      logger,
      playerOverrides: { noSubscriberBehavior: NoSubscriberBehavior.Play },
    });
    const g1 = manager.getOrCreate('g1');
    const g2 = manager.getOrCreate('g2');
    assert.equal(manager.getOrCreate('g1'), g1);
    const e1 = collect(g1);
    const e2 = collect(g2);
    g2.setLoop(LoopMode.TRACK);
    g2.setVolume(30);
    await Promise.all([g1.enqueue([track('a1'), track('a2')]), g2.enqueue([track('b1'), track('b2')])]);
    await waitFor(g1, 'queueEnd');
    assert.deepEqual(e1.started, ['a1', 'a2']);
    assert.ok(e2.started.every((t) => t === 'b1'), 'g2 loops its own track');
    assert.equal(g1.volume, 80);
    assert.equal(g2.volume, 30);
    assert.equal(g1.queue.loopMode, 'off');
    manager.destroy('g1');
    assert.equal(manager.get('g1'), undefined);
    assert.equal(manager.get('g2'), g2);
    assert.ok(g2.current, 'destroying g1 does not affect g2');
    manager.destroyAll();
    assert.equal(manager.players.size, 0);
  });

  test('sweeper reclaims idle/disconnected players and keeps active ones', async () => {
    const manager = new PlayerManager({
      streamFactory: new FakeFactory({ seconds: 5 }),
      getSettings: () => settings,
      options,
      logger,
      playerOverrides: { noSubscriberBehavior: NoSubscriberBehavior.Play },
    });
    const destroyed = [];
    manager.on('playerDestroy', (p, reason) => destroyed.push(`${p.guildId}:${reason}`));
    const idle = manager.getOrCreate('idle');
    const active = manager.getOrCreate('active');
    await active.enqueue(track('a'));
    idle.lastActivity = Date.now() - 60_000;
    active.lastActivity = Date.now() - 60_000;
    // "active" is playing but has no voice connection in this test; mark it as connected.
    Object.defineProperty(active, 'voiceChannelId', { get: () => 'vc1' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(manager.sweep(), 1);
    assert.deepEqual(destroyed, ['idle:inactive']);
    assert.ok(manager.get('active'));
    assert.equal(manager.players.size, 1);
    manager.destroyAll();
  });

  test('many create/destroy cycles leave no stale objects', () => {
    const manager = new PlayerManager({ streamFactory: new FakeFactory(), getSettings: () => settings, options, logger });
    for (let i = 0; i < 500; i++) {
      const p = manager.getOrCreate(`g${i % 10}`);
      if (i % 2) p.destroy('cycle');
    }
    manager.destroyAll();
    assert.equal(manager.players.size, 0);
    assert.equal(manager.listenerCount('playerDestroy'), 0);
  });
});
