/**
 * Runs every slash command, button and autocomplete handler through the real interaction handler with
 * simulated Discord objects (guild, members, voice channels). Catches wiring/permission bugs without a live bot.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { ChannelType, Collection, PermissionFlagsBits } from 'discord.js';
import { createAudioResource, NoSubscriberBehavior, StreamType } from '@discordjs/voice';
import pino from 'pino';
import { loadCommands } from '../src/commands/index.js';
import interactionCreate from '../src/events/interactionCreate.js';
import voiceStateUpdate from '../src/events/voiceStateUpdate.js';
import { GuildPlayer } from '../src/music/GuildPlayer.js';
import { PlayerManager } from '../src/music/PlayerManager.js';
import { SqliteStore } from '../src/database/sqlite.js';
import { GuildSettingsService } from '../src/settings/GuildSettingsService.js';
import { PlaylistService } from '../src/playlists/PlaylistService.js';
import { attachNowPlaying } from '../src/ui/NowPlayingController.js';
import { RateLimiter, Cooldown } from '../src/utils/rateLimiter.js';
import { TrackError } from '../src/utils/errors.js';
import { config } from '../src/config/index.js';

const logger = pino({ level: 'silent' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ fakes

class FakeFactory {
  async create(track, { seek = 0, metadata = {} } = {}) {
    if (track.videoId.startsWith('dead')) throw new TrackError('This video is unavailable.', { code: 'UNAVAILABLE' });
    const stream = new Readable({ read() { this.push(Buffer.alloc(3840)); } }); // endless silence
    const source = { killed: false, failed: false, exited: Promise.resolve(0), kill() { this.killed = true; stream.destroy(); } };
    return createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: true, metadata: { ...metadata, track, source, startOffset: seek } });
  }
}

const vid = (n) => `vid${String(n).padStart(8, '0')}`;
const data = (n, extra = {}) => ({ videoId: vid(n), url: `https://www.youtube.com/watch?v=${vid(n)}`, title: `Song ${n}`, author: 'Artist', duration: 180, ...extra });

const fakeYtDlp = {
  calls: [],
  async resolve(query) {
    this.calls.push(query);
    if (query.includes('list=')) return { kind: 'playlist', tracks: [data(10), data(11), data(12), data(13)], playlist: { title: 'Mix', url: query, unavailable: 1, total: 5, truncated: false } };
    if (query.includes('bad')) throw new TrackError('This video is private.', { code: 'PRIVATE' });
    if (query.startsWith('http')) return { kind: 'video', tracks: [data(Number(query.match(/v=vid0*(\d+)/)?.[1] ?? 1))] };
    return { kind: 'search', tracks: [data(99, { title: `Result for ${query}` })] };
  },
  async search() {
    return [data(50), data(51)];
  },
  prefetch() {},
};

function makeWorld() {
  const sent = [];
  const textChannel = {
    id: 'text1',
    guild: null,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      const msg = { payload, edits: [], deleted: false, edit: async (p) => (msg.edits.push(p), msg), delete: async () => (msg.deleted = true) };
      sent.push(msg);
      return msg;
    },
  };
  const guild = { id: 'g1', name: 'Test Guild', channels: { cache: new Collection() }, members: { me: null }, voiceAdapterCreator: () => ({}) };
  guild.client = { user: { id: 'bot' } };
  textChannel.guild = guild;

  const makeVoice = (id) => ({
    id,
    type: ChannelType.GuildVoice,
    guild,
    full: false,
    members: new Collection(),
    permissionsFor: () => ({ has: () => true }),
  });
  const vc1 = makeVoice('vc1');
  const vc2 = makeVoice('vc2');
  guild.channels.cache.set('vc1', vc1).set('vc2', vc2).set('text1', textChannel);

  const makeMember = (id, { admin = false, roles = [] } = {}) => {
    const member = {
      id,
      user: { id, bot: false, username: id },
      guild,
      permissions: { has: (p) => admin && (p === PermissionFlagsBits.ManageGuild || p === PermissionFlagsBits.Administrator) },
      roles: { cache: new Collection(roles.map((r) => [r, { id: r }])) },
      voice: { channel: null, channelId: null, deaf: false },
    };
    return member;
  };
  const moveTo = (member, channel) => {
    const prev = member.voice.channel;
    prev?.members.delete(member.id);
    member.voice.channel = channel;
    member.voice.channelId = channel?.id ?? null;
    channel?.members.set(member.id, member);
  };
  guild.members.me = { id: 'bot', voice: { channelId: null } };
  const client = { channels: { cache: new Collection([['text1', textChannel]]) }, isReady: () => true, user: { id: 'bot' } };
  return { guild, textChannel, vc1, vc2, makeMember, moveTo, sent, client };
}

function makeInteraction(world, member, commandName, opts = {}, { sub } = {}) {
  const replies = [];
  const message = {
    awaitMessageComponent: async () => ({ values: ['1'], member, deferUpdate: async () => {} }),
  };
  const interaction = {
    id: `i${Math.random()}`,
    commandName,
    user: member.user,
    member,
    guild: world.guild,
    guildId: 'g1',
    channelId: 'text1',
    channel: world.textChannel,
    replies,
    replied: false,
    deferred: false,
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isRepliable: () => true,
    inCachedGuild: () => true,
    options: {
      getString: (n, req) => opts[n] ?? (req ? assert.fail(`missing ${n}`) : null),
      getInteger: (n) => opts[n] ?? null,
      getBoolean: (n) => opts[n] ?? null,
      getRole: (n) => opts[n] ?? null,
      getSubcommand: () => sub,
      getFocused: () => ({ name: 'name', value: opts.focused ?? '' }),
    },
    async reply(p) {
      this.replied = true;
      replies.push(p);
      return message;
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply(p) {
      replies.push(p);
      return message;
    },
    async followUp(p) {
      replies.push(p);
      return message;
    },
    async update(p) {
      this.replied = true;
      replies.push(p);
    },
    async deferUpdate() {
      this.deferred = true;
    },
  };
  return interaction;
}

const text = (payload) => {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  const e = payload.embeds?.[0];
  const j = e?.toJSON ? e.toJSON() : e;
  return [payload.content, j?.author?.name, j?.title, j?.description, ...(j?.fields ?? []).map((f) => `${f.name}: ${f.value}`), j?.footer?.text]
    .filter(Boolean)
    .join(' | ');
};
const last = (i) => text(i.replies.at(-1));
const isError = (i) => /❌/.test(last(i));

// ------------------------------------------------------------------ suite

describe('commands through the interaction handler', () => {
  let app;
  let world;
  let alice;
  let bob;
  let admin;
  let origConnect;

  before(async () => {
    // Stub the voice connection: pretend we joined instantly.
    origConnect = GuildPlayer.prototype.connect;
    GuildPlayer.prototype.connect = async function (channel) {
      this.connection = { state: { status: 'ready' }, joinConfig: { channelId: channel.id }, destroy() { this.state.status = 'destroyed'; } };
      channel.guild.members.me.voice.channelId = channel.id;
    };
    world = makeWorld();
    const store = new SqliteStore(':memory:');
    const settingsService = new GuildSettingsService({ store, defaults: config.player });
    const manager = new PlayerManager({
      streamFactory: new FakeFactory(),
      prefetcher: fakeYtDlp,
      getSettings: (id) => settingsService.get(id),
      options: { ...config.player, queueEndTimeout: 60_000 },
      logger,
      playerOverrides: { noSubscriberBehavior: NoSubscriberBehavior.Play },
    });
    app = {
      client: world.client,
      config,
      logger,
      store,
      settingsService,
      playlists: new PlaylistService({ store, limits: config.playlists }),
      ytdlp: fakeYtDlp,
      manager,
      commands: await loadCommands(),
      rateLimiter: new RateLimiter({ limit: 1000, windowMs: 1000 }),
      buttonCooldown: new Cooldown(0),
    };
    attachNowPlaying({ manager, client: world.client, settings: settingsService, logger, updateInterval: 0 });
    alice = world.makeMember('alice');
    bob = world.makeMember('bob');
    admin = world.makeMember('admin', { admin: true });
  });

  after(() => {
    GuildPlayer.prototype.connect = origConnect;
    app.manager.destroyAll();
    app.rateLimiter.destroy();
    app.store.close();
  });

  const used = new Set();
  const run = async (member, name, opts, extra) => {
    used.add(name);
    const i = makeInteraction(world, member, name, opts, extra);
    await interactionCreate.execute(i, app);
    return i;
  };

  test('/play requires the user to be in voice', async () => {
    const i = await run(alice, 'play', { query: 'hello' });
    assert.ok(isError(i));
    assert.match(last(i), /join a voice channel/);
  });

  test('/play single video starts playback and posts a Now Playing message', async () => {
    world.moveTo(alice, world.vc1);
    world.moveTo(bob, world.vc1);
    const i = await run(alice, 'play', { query: 'https://www.youtube.com/watch?v=vid00000001' });
    assert.match(last(i), /Now playing/);
    const player = app.manager.get('g1');
    assert.equal(player.current.title, 'Song 1');
    assert.equal(player.textChannelId, 'text1');
    await sleep(50);
    assert.match(text(world.sent.at(-1).payload), /Now Playing.*Song 1/);
    assert.equal(world.sent.at(-1).payload.components.length, 2, 'control buttons attached');
  });

  test('/play search + playlist + /playnext + private video error', async () => {
    let i = await run(bob, 'play', { query: 'some search' });
    assert.match(last(i), /Added to queue.*Result for some search/);
    i = await run(bob, 'play', { query: 'https://www.youtube.com/playlist?list=PL123', shuffle: true });
    assert.match(last(i), /Playlist queued/);
    assert.match(last(i), /4 tracks/);
    assert.match(last(i), /1 unavailable video skipped/);
    i = await run(alice, 'playnext', { query: 'https://www.youtube.com/watch?v=vid00000002' });
    assert.equal(app.manager.get('g1').queue.upcoming[0].title, 'Song 2');
    i = await run(alice, 'play', { query: 'https://www.youtube.com/watch?v=bad' });
    assert.match(last(i), /private/);
  });

  test('/search picks a result via the select menu', async () => {
    const i = await run(alice, 'search', { query: 'anything' });
    assert.match(last(i), /Song 51/);
  });

  test('/queue, /nowplaying and /np render', async () => {
    let i = await run(bob, 'queue', {});
    assert.match(last(i), /Queue/);
    assert.match(last(i), /Page 1\/1/);
    i = await run(bob, 'nowplaying', {});
    assert.match(last(i), /Now Playing/);
    i = await run(bob, 'np', {});
    assert.match(last(i), /Song 1/);
  });

  test('users in another channel cannot control the music', async () => {
    const carol = world.makeMember('carol');
    world.moveTo(carol, world.vc2);
    for (const cmd of ['pause', 'skip', 'shuffle', 'stop', 'clear']) {
      const i = await run(carol, cmd, {});
      assert.ok(isError(i), `${cmd} should be rejected`);
      assert.match(last(i), /<#vc1>/);
    }
    // ...and cannot pull the bot away while people are listening.
    const i = await run(carol, 'play', { query: 'x' });
    assert.match(last(i), /already playing in <#vc1>/);
    world.moveTo(carol, null);
  });

  test('queue management commands', async () => {
    const player = app.manager.get('g1');
    const size = player.queue.size;
    let i = await run(alice, 'shuffle', {});
    assert.match(last(i), new RegExp(`Shuffled \\*\\*${size}\\*\\*`));
    i = await run(alice, 'move', { from: size, to: 1 });
    assert.match(last(i), /Moved/);
    i = await run(alice, 'remove', { position: 1 });
    assert.match(last(i), /Removed/);
    i = await run(alice, 'remove', { position: 99 });
    assert.match(last(i), /between 1 and/);
    i = await run(alice, 'loop', { mode: 'queue' });
    assert.match(last(i), /Queue/);
    assert.equal(player.queue.loopMode, 'queue');
    i = await run(alice, 'loop', {});
    assert.equal(player.queue.loopMode, 'off');
    i = await run(alice, 'volume', { level: 150 });
    assert.match(last(i), /150%/);
    i = await run(bob, 'volume', {});
    assert.match(last(i), /150%/);
    i = await run(alice, 'pause', {});
    assert.match(last(i), /Paused/);
    i = await run(alice, 'pause', {});
    assert.match(last(i), /already paused/);
    i = await run(alice, 'resume', {});
    assert.match(last(i), /Resumed/);
    i = await run(alice, 'seek', { time: '1:30' });
    assert.match(last(i), /1:30/);
    i = await run(alice, 'seek', { time: 'nonsense' });
    assert.match(last(i), /Invalid timestamp/);
    i = await run(alice, 'replay', {});
    assert.match(last(i), /Replaying/);
    player.queue.add(player.queue.upcoming[0].clone());
    i = await run(alice, 'dedupe', {});
    assert.match(last(i), /Removed \*\*1\*\* duplicate/);
    const before = player.current.title;
    i = await run(alice, 'skip', {});
    assert.match(last(i), new RegExp(`Skipped.*${before}`));
    i = await run(alice, 'previous', {});
    assert.match(last(i), new RegExp(`Back to.*${before}`));
    i = await run(alice, 'skip', { to: 2 });
    assert.match(last(i), /Skipped/);
  });

  test('DJ role restricts control commands; requester can still skip own song; admins bypass', async () => {
    app.settingsService.update('g1', { djRoleId: 'dj' });
    const player = app.manager.get('g1');
    let i = await run(bob, 'shuffle', {});
    assert.match(last(i), /<@&dj>/);
    i = await run(bob, 'volume', { level: 10 });
    assert.match(last(i), /<@&dj>/);
    // bob requests a song and skips it himself.
    player.queue.current.requestedBy = { id: 'bob', tag: 'bob' };
    i = await run(bob, 'skip', {});
    assert.match(last(i), /Skipped/);
    world.moveTo(admin, world.vc1);
    i = await run(admin, 'shuffle', {});
    assert.match(last(i), /Shuffled/);
    const dj = world.makeMember('dan', { roles: ['dj'] });
    world.moveTo(dj, world.vc1);
    i = await run(dj, 'loop', { mode: 'track' });
    assert.match(last(i), /Track/);
    world.moveTo(dj, null);
    world.moveTo(admin, null);
    app.settingsService.update('g1', { djRoleId: null });
    player.setLoop('off');
  });

  test('buttons: toggle, loop, shuffle, skip, queue pages, stale message', async () => {
    const player = app.manager.get('g1');
    player.queue.add(Array.from({ length: 25 }, (_, n) => player.queue.upcoming[0]?.clone() ?? player.current.clone()));
    const press = async (member, customId) => {
      const i = makeInteraction(world, member, undefined);
      i.customId = customId;
      i.isChatInputCommand = () => false;
      i.isButton = () => true;
      await interactionCreate.execute(i, app);
      return i;
    };
    let i = await press(alice, 'player:toggle');
    assert.equal(player.isPaused, true);
    assert.match(last(i), /Paused/);
    i = await press(alice, 'player:toggle');
    assert.equal(player.isPaused, false);
    i = await press(alice, 'player:loop');
    assert.equal(player.queue.loopMode, 'track');
    i = await press(alice, 'player:shuffle');
    assert.match(last(i), /Shuffled/);
    i = await press(alice, 'queue:2');
    assert.match(last(i), /Page 2\//);
    i = await press(alice, 'player:queue');
    assert.match(last(i), /Page 1\//);
    const outsider = world.makeMember('eve');
    i = await press(outsider, 'player:skip');
    assert.ok(isError(i));
    const before = player.current;
    i = await press(alice, 'player:skip');
    assert.notEqual(player.current, before);
    player.setLoop('off');
  });

  test('playlists: create, add, view, list, rename, remove, savequeue, load, play, delete, autocomplete', async () => {
    const pl = (sub, opts, member = alice) => run(member, 'playlist', opts, { sub });
    // Make the current song deterministic (not one of the playlist's tracks).
    await run(alice, 'playnext', { query: 'https://www.youtube.com/watch?v=vid00000077' });
    await run(alice, 'skip', {});
    assert.equal(app.manager.get('g1').current.title, 'Song 77');
    let i = await pl('create', { name: 'Faves' });
    assert.match(last(i), /Created personal playlist \*\*Faves\*\*/);
    i = await pl('create', { name: 'faves' });
    assert.match(last(i), /already exists/);
    i = await pl('add', { name: 'Faves' }); // current song
    assert.match(last(i), /Added \*\*Song/);
    i = await pl('add', { name: 'Faves', query: 'https://www.youtube.com/playlist?list=PL9' });
    assert.match(last(i), /Added \*\*4 tracks\*\*/);
    i = await pl('add', { name: 'Faves', query: 'https://www.youtube.com/playlist?list=PL9' });
    assert.match(last(i), /Nothing was added.*4 duplicates/);
    i = await pl('view', { name: 'faves' });
    assert.match(last(i), /5 tracks/);
    i = await pl('remove', { name: 'Faves', position: 1 });
    assert.match(last(i), /Removed/);
    i = await pl('rename', { name: 'Faves', new_name: 'Best' });
    assert.match(last(i), /Renamed/);
    i = await pl('list', {});
    assert.match(last(i), /Best.*4 tracks/);
    i = await pl('savequeue', { name: 'Snapshot' });
    assert.match(last(i), /Saved/);
    i = await pl('create', { name: 'Server Mix', scope: 'guild' });
    assert.match(last(i), /Manage Server/);
    world.moveTo(admin, world.vc1);
    i = await pl('create', { name: 'Server Mix', scope: 'guild' }, admin);
    assert.match(last(i), /server playlist/);
    world.moveTo(admin, null);

    // Autocomplete returns refs for personal and server playlists.
    const ac = makeInteraction(world, alice, 'playlist', { focused: '' });
    let choices;
    ac.isChatInputCommand = () => false;
    ac.isAutocomplete = () => true;
    ac.respond = async (c) => (choices = c);
    await interactionCreate.execute(ac, app);
    assert.deepEqual(choices.map((c) => c.value.split(':')[0]).sort(), ['g', 'u', 'u']);

    const player = app.manager.get('g1');
    player.setLoop('queue'); // replacing the queue must not keep the old track in the loop rotation
    const queueBefore = player.queue.size;
    i = await pl('load', { name: 'Best' });
    assert.equal(player.queue.size, queueBefore + 4);
    const ref = choices.find((c) => c.name.includes('Best')).value;
    i = await pl('play', { name: ref, shuffle: true });
    assert.match(last(i), /Playing playlist/);
    assert.equal(player.queue.size, 3, 'queue replaced by the playlist (1 playing + 3 upcoming)');
    assert.ok(['Song 10', 'Song 11', 'Song 12', 'Song 13'].includes(player.current.title));
    i = await pl('delete', { name: 'Best' }, bob);
    assert.match(last(i), /not found/);
    i = await pl('delete', { name: 'Best' });
    assert.match(last(i), /Deleted/);
  });

  test('/settings changes persist and apply', async () => {
    const s = (sub, opts) => run(admin, 'settings', opts, { sub });
    let i = await s('volume', { level: 42 });
    assert.match(last(i), /42%/);
    i = await s('duplicates', { allowed: false });
    assert.equal(app.manager.get('g1').queue.allowDuplicates, false);
    i = await s('announce', { enabled: false });
    i = await s('view', {});
    assert.match(last(i), /42%/);
    assert.match(last(i), /Skipped/);
    await s('duplicates', { allowed: true });
    await s('announce', { enabled: true });
  });

  test('voice state: channel empty pauses, rejoin resumes', async () => {
    const player = app.manager.get('g1');
    world.guild.members.me.voice.channelId = 'vc1';
    world.moveTo(alice, null);
    world.moveTo(bob, null);
    await voiceStateUpdate.execute({ id: 'bob', channelId: 'vc1', guild: world.guild }, { id: 'bob', channelId: null, guild: world.guild }, app);
    assert.equal(player.autoPaused, true);
    assert.equal(player.leaveReason, 'channel-empty');
    world.moveTo(alice, world.vc1);
    await voiceStateUpdate.execute({ id: 'alice', channelId: null, guild: world.guild }, { id: 'alice', channelId: 'vc1', guild: world.guild }, app);
    assert.equal(player.autoPaused, false);
    assert.equal(player.leaveTimer, null);
  });

  test('command spam is rate limited', async () => {
    const saved = app.rateLimiter;
    app.rateLimiter = new RateLimiter({ limit: 2, windowMs: 10_000 });
    await run(alice, 'help', {});
    await run(alice, 'help', {});
    const i = await run(alice, 'help', {});
    assert.match(last(i), /going too fast/);
    app.rateLimiter.destroy();
    app.rateLimiter = saved;
  });

  test('/stop destroys the player and leaves', async () => {
    world.moveTo(bob, world.vc1);
    const i = await run(alice, 'stop', {});
    assert.match(last(i), /Stopped/);
    assert.equal(app.manager.get('g1'), undefined);
    const q = await run(alice, 'queue', {});
    assert.match(last(q), /queue is empty/);
    const p = await run(alice, 'pause', {});
    assert.match(last(p), /not playing/);
  });

  test('/clear and /leave', async () => {
    await run(alice, 'play', { query: 'https://www.youtube.com/playlist?list=PL1' });
    let i = await run(alice, 'clear', {});
    assert.match(last(i), /Cleared \*\*3\*\* tracks/);
    i = await run(alice, 'leave', {});
    assert.match(last(i), /left the voice channel/);
    assert.equal(app.manager.players.size, 0, 'no stale players left behind');
  });

  test('every registered command was exercised', () => {
    const missing = [...app.commands.keys()].filter((n) => !used.has(n));
    assert.deepEqual(missing, []);
  });
});
