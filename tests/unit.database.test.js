import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/database/sqlite.js';
import { PlaylistService, Scope } from '../src/playlists/PlaylistService.js';
import { GuildSettingsService } from '../src/settings/GuildSettingsService.js';
import { UserError } from '../src/utils/errors.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roketa-db-'));
const file = path.join(dir, 'test.db');
const limits = { maxPerOwner: 3, maxTracks: 5 };
const alice = { userId: 'alice', guildId: 'g1', isManager: false };
const bob = { userId: 'bob', guildId: 'g1', isManager: false };
const admin = { userId: 'admin', guildId: 'g1', isManager: true };
const tr = (id, extra = {}) => ({ videoId: id.padEnd(11, 'x'), title: `Song ${id}`, author: 'A', duration: 120, ...extra });

describe('persistent playlists (SQLite)', () => {
  let store;
  let svc;
  before(() => {
    store = new SqliteStore(file);
    svc = new PlaylistService({ store, limits });
  });
  after(() => {
    store?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('create, find (case-insensitive), duplicate names rejected', () => {
    const p = svc.create('Chill Vibes', Scope.USER, alice);
    assert.equal(p.name, 'Chill Vibes');
    assert.equal(svc.find('chill vibes', alice).id, p.id);
    assert.throws(() => svc.create('CHILL VIBES', Scope.USER, alice), UserError);
    // Another user can have the same name.
    assert.ok(svc.create('Chill Vibes', Scope.USER, bob));
  });

  test('name validation', () => {
    assert.throws(() => svc.create('   ', Scope.USER, alice), /empty/);
    assert.throws(() => svc.create('x'.repeat(51), Scope.USER, alice), /at most/);
    assert.throws(() => svc.create('u:12', Scope.USER, alice), /reserved/);
  });

  test('add tracks, dedupe, size limit, ordering', () => {
    const p = svc.find('Chill Vibes', alice);
    let r = svc.addTracks(p, [tr('a'), tr('b'), tr('a')], alice);
    assert.deepEqual(r, { added: 2, duplicates: 1, overflow: 0 });
    r = svc.addTracks(p, [tr('b'), tr('c'), tr('d'), tr('e'), tr('f'), tr('g')], alice);
    assert.deepEqual(r, { added: 3, duplicates: 1, overflow: 2 });
    assert.deepEqual(svc.getTracks(p).map((t) => t.title), ['Song a', 'Song b', 'Song c', 'Song d', 'Song e']);
  });

  test('remove keeps positions contiguous', () => {
    const p = svc.find('Chill Vibes', alice);
    assert.equal(svc.removeTrack(p, 2, alice).title, 'Song b');
    const rows = svc.getTracks(p);
    assert.deepEqual(rows.map((t) => t.position), [1, 2, 3, 4]);
    assert.deepEqual(rows.map((t) => t.title), ['Song a', 'Song c', 'Song d', 'Song e']);
    assert.throws(() => svc.removeTrack(p, 9, alice), /between 1 and 4/);
  });

  test('ownership: others cannot modify personal playlists or even see them', () => {
    const p = svc.find('Chill Vibes', alice);
    assert.throws(() => svc.addTracks(p, [tr('z')], bob), /your own/);
    assert.throws(() => svc.delete(p, bob), /your own/);
    assert.throws(() => svc.find(PlaylistService.ref(p), bob), /not found/);
  });

  test('server playlists: managers create, everyone plays, creator/managers edit', () => {
    assert.throws(() => svc.create('Party', Scope.GUILD, alice), /Manage Server/);
    const party = svc.create('Party', Scope.GUILD, admin);
    assert.equal(svc.find('party', bob).id, party.id); // visible to all members of the guild
    assert.throws(() => svc.addTracks(party, [tr('q')], bob), /creator, DJs/);
    assert.equal(svc.addTracks(party, [tr('q')], admin).added, 1);
    // Not visible from another guild.
    assert.throws(() => svc.find(PlaylistService.ref(party), { userId: 'bob', guildId: 'g2' }), /not found/);
  });

  test('refs disambiguate personal vs server playlists with the same name', () => {
    svc.create('Mix', Scope.USER, admin);
    const guildMix = svc.create('Mix', Scope.GUILD, admin);
    assert.equal(svc.find('Mix', admin).ownerType, Scope.USER); // personal first
    assert.equal(svc.find(PlaylistService.ref(guildMix), admin).ownerType, Scope.GUILD);
    assert.equal(svc.find('Mix', admin, Scope.GUILD).id, guildMix.id);
  });

  test('rename and limits', () => {
    const p = svc.find('Chill Vibes', alice);
    svc.rename(p, 'Study', alice);
    assert.equal(svc.find('study', alice).id, p.id);
    svc.create('Two', Scope.USER, alice);
    svc.create('Three', Scope.USER, alice);
    assert.throws(() => svc.create('Four', Scope.USER, alice), /limit/);
  });

  test('list includes counts and durations; suggest searches both scopes', () => {
    const list = svc.list(Scope.USER, alice);
    const study = list.find((p) => p.name === 'Study');
    assert.equal(study.trackCount, 4);
    assert.equal(study.totalDuration, 480);
    const sugg = svc.suggest('mi', admin);
    assert.equal(sugg.length, 2);
  });

  test('toQueueTracks produces Track objects with requester', () => {
    const p = svc.find('Study', alice);
    const tracks = svc.toQueueTracks(p, { id: 'alice', tag: 'alice' });
    assert.equal(tracks.length, 4);
    assert.equal(tracks[0].requestedBy.id, 'alice');
    assert.match(tracks[0].url, /watch\?v=/);
  });

  test('delete cascades tracks', () => {
    const p = svc.find('Two', alice);
    svc.addTracks(p, [tr('k')], alice);
    svc.delete(p, alice);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM playlist_tracks WHERE playlist_id = ?').get(p.id).n, 0);
  });

  test('guild settings with defaults and persistence', () => {
    const settings = new GuildSettingsService({ store, defaults: { defaultVolume: 80 } });
    assert.deepEqual({ ...settings.get('g1') }, { djRoleId: null, defaultVolume: 80, defaultLoop: 'off', allowDuplicates: true, announceNowPlaying: true });
    settings.update('g1', { djRoleId: 'role1', defaultVolume: 55, allowDuplicates: false, defaultLoop: 'queue' });
    assert.equal(settings.get('g1').defaultVolume, 55);
    settings.update('g1', { announceNowPlaying: false });
    const s = settings.get('g1');
    assert.equal(s.djRoleId, 'role1');
    assert.equal(s.allowDuplicates, false);
    assert.equal(s.announceNowPlaying, false);
  });

  test('data survives closing and reopening the database (bot restart)', () => {
    store.close();
    store = new SqliteStore(file);
    svc = new PlaylistService({ store, limits });
    const p = svc.find('Study', alice);
    assert.deepEqual(svc.getTracks(p).map((t) => t.title), ['Song a', 'Song c', 'Song d', 'Song e']);
    assert.equal(svc.find('Party', bob).ownerType, Scope.GUILD);
    const settings = new GuildSettingsService({ store, defaults: { defaultVolume: 80 } });
    assert.equal(settings.get('g1').defaultVolume, 55);
    assert.equal(store.db.pragma('user_version', { simple: true }), 1);
  });
});
