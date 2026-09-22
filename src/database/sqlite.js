import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Ordered migrations. Each runs once; progress is tracked with PRAGMA user_version.
 * Never edit a released migration — append a new one.
 */
const MIGRATIONS = [
  `
  CREATE TABLE guild_settings (
    guild_id              TEXT PRIMARY KEY,
    dj_role_id            TEXT,
    default_volume        INTEGER,
    default_loop          TEXT,
    allow_duplicates      INTEGER,
    announce_now_playing  INTEGER,
    updated_at            INTEGER NOT NULL
  );

  CREATE TABLE playlists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type  TEXT    NOT NULL CHECK (owner_type IN ('user', 'guild')),
    owner_id    TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    name_key    TEXT    NOT NULL,
    created_by  TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (owner_type, owner_id, name_key)
  );

  CREATE TABLE playlist_tracks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id  INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,
    video_id     TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    author       TEXT,
    duration     INTEGER,
    thumbnail    TEXT,
    is_live      INTEGER NOT NULL DEFAULT 0,
    added_by     TEXT    NOT NULL,
    added_at     INTEGER NOT NULL
  );
  CREATE INDEX idx_playlist_tracks_order ON playlist_tracks (playlist_id, position);
  `,
];

const nameKey = (name) => name.trim().toLowerCase();

function mapPlaylist(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trackCount: row.track_count ?? undefined,
    totalDuration: row.total_duration ?? undefined,
  };
}

function mapTrack(row) {
  return {
    id: row.id,
    position: row.position,
    videoId: row.video_id,
    title: row.title,
    author: row.author,
    duration: row.duration,
    thumbnail: row.thumbnail,
    isLive: Boolean(row.is_live),
    addedBy: row.added_by,
    addedAt: row.added_at,
  };
}

function mapSettings(row) {
  if (!row) return null;
  const bool = (v) => (v === null || v === undefined ? null : Boolean(v));
  return {
    guildId: row.guild_id,
    djRoleId: row.dj_role_id,
    defaultVolume: row.default_volume,
    defaultLoop: row.default_loop,
    allowDuplicates: bool(row.allow_duplicates),
    announceNowPlaying: bool(row.announce_now_playing),
  };
}

const SETTINGS_COLUMNS = {
  djRoleId: 'dj_role_id',
  defaultVolume: 'default_volume',
  defaultLoop: 'default_loop',
  allowDuplicates: 'allow_duplicates',
  announceNowPlaying: 'announce_now_playing',
};

/**
 * SQLite implementation of the storage interface (see database/index.js).
 * better-sqlite3 is synchronous, which is ideal here: queries take microseconds and there are no race conditions.
 */
export class SqliteStore {
  constructor(filename) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
    this.prepare();
  }

  migrate() {
    const current = this.db.pragma('user_version', { simple: true });
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  prepare() {
    const db = this.db;
    this.stmts = {
      getSettings: db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?'),
      getPlaylist: db.prepare('SELECT * FROM playlists WHERE owner_type = ? AND owner_id = ? AND name_key = ?'),
      getPlaylistById: db.prepare('SELECT * FROM playlists WHERE id = ?'),
      listPlaylists: db.prepare(`
        SELECT p.*, COUNT(t.id) AS track_count, COALESCE(SUM(t.duration), 0) AS total_duration
        FROM playlists p LEFT JOIN playlist_tracks t ON t.playlist_id = p.id
        WHERE p.owner_type = ? AND p.owner_id = ?
        GROUP BY p.id ORDER BY p.name_key`),
      searchPlaylists: db.prepare(`
        SELECT p.*, (SELECT COUNT(*) FROM playlist_tracks t WHERE t.playlist_id = p.id) AS track_count
        FROM playlists p WHERE p.owner_type = ? AND p.owner_id = ? AND p.name_key LIKE ? ESCAPE '\\'
        ORDER BY p.name_key LIMIT ?`),
      countPlaylists: db.prepare('SELECT COUNT(*) AS n FROM playlists WHERE owner_type = ? AND owner_id = ?'),
      insertPlaylist: db.prepare(`
        INSERT INTO playlists (owner_type, owner_id, name, name_key, created_by, created_at, updated_at)
        VALUES (@ownerType, @ownerId, @name, @nameKey, @createdBy, @now, @now)`),
      renamePlaylist: db.prepare('UPDATE playlists SET name = ?, name_key = ?, updated_at = ? WHERE id = ?'),
      deletePlaylist: db.prepare('DELETE FROM playlists WHERE id = ?'),
      touchPlaylist: db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?'),
      countTracks: db.prepare('SELECT COUNT(*) AS n FROM playlist_tracks WHERE playlist_id = ?'),
      maxPosition: db.prepare('SELECT COALESCE(MAX(position), 0) AS n FROM playlist_tracks WHERE playlist_id = ?'),
      insertTrack: db.prepare(`
        INSERT INTO playlist_tracks (playlist_id, position, video_id, title, author, duration, thumbnail, is_live, added_by, added_at)
        VALUES (@playlistId, @position, @videoId, @title, @author, @duration, @thumbnail, @isLive, @addedBy, @now)`),
      getTracks: db.prepare('SELECT * FROM playlist_tracks WHERE playlist_id = ? ORDER BY position LIMIT ? OFFSET ?'),
      getTrackAt: db.prepare('SELECT * FROM playlist_tracks WHERE playlist_id = ? AND position = ?'),
      deleteTrack: db.prepare('DELETE FROM playlist_tracks WHERE id = ?'),
      shiftDown: db.prepare('UPDATE playlist_tracks SET position = position - 1 WHERE playlist_id = ? AND position > ?'),
      videoIds: db.prepare('SELECT video_id FROM playlist_tracks WHERE playlist_id = ?'),
    };
  }

  // ------------------------------------------------------------ guild settings

  getGuildSettings(guildId) {
    return mapSettings(this.stmts.getSettings.get(guildId));
  }

  updateGuildSettings(guildId, patch) {
    const entries = Object.entries(patch).filter(([k]) => k in SETTINGS_COLUMNS);
    if (!entries.length) return this.getGuildSettings(guildId);
    const cols = entries.map(([k]) => SETTINGS_COLUMNS[k]);
    const values = entries.map(([, v]) => (typeof v === 'boolean' ? Number(v) : v ?? null));
    this.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, ${cols.join(', ')}, updated_at)
         VALUES (?, ${cols.map(() => '?').join(', ')}, ?)
         ON CONFLICT(guild_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = excluded.updated_at`,
      )
      .run(guildId, ...values, Date.now());
    return this.getGuildSettings(guildId);
  }

  // ------------------------------------------------------------ playlists

  getPlaylist(ownerType, ownerId, name) {
    return mapPlaylist(this.stmts.getPlaylist.get(ownerType, ownerId, nameKey(name)));
  }

  getPlaylistById(id) {
    return mapPlaylist(this.stmts.getPlaylistById.get(id));
  }

  listPlaylists(ownerType, ownerId) {
    return this.stmts.listPlaylists.all(ownerType, ownerId).map(mapPlaylist);
  }

  searchPlaylists(ownerType, ownerId, prefix, limit = 25) {
    const escaped = nameKey(prefix).replace(/[\\%_]/g, (c) => `\\${c}`);
    return this.stmts.searchPlaylists.all(ownerType, ownerId, `%${escaped}%`, limit).map(mapPlaylist);
  }

  countPlaylists(ownerType, ownerId) {
    return this.stmts.countPlaylists.get(ownerType, ownerId).n;
  }

  createPlaylist({ ownerType, ownerId, name, createdBy }) {
    const info = this.stmts.insertPlaylist.run({ ownerType, ownerId, name: name.trim(), nameKey: nameKey(name), createdBy, now: Date.now() });
    return this.getPlaylistById(Number(info.lastInsertRowid));
  }

  renamePlaylist(id, name) {
    this.stmts.renamePlaylist.run(name.trim(), nameKey(name), Date.now(), id);
    return this.getPlaylistById(id);
  }

  deletePlaylist(id) {
    return this.stmts.deletePlaylist.run(id).changes > 0;
  }

  countTracks(playlistId) {
    return this.stmts.countTracks.get(playlistId).n;
  }

  /** Append tracks atomically. */
  addTracks(playlistId, tracks, addedBy) {
    const run = this.db.transaction(() => {
      let position = this.stmts.maxPosition.get(playlistId).n;
      const now = Date.now();
      for (const t of tracks) {
        this.stmts.insertTrack.run({
          playlistId,
          position: ++position,
          videoId: t.videoId,
          title: t.title,
          author: t.author ?? null,
          duration: t.duration ?? null,
          thumbnail: t.thumbnail ?? null,
          isLive: t.isLive ? 1 : 0,
          addedBy,
          now,
        });
      }
      this.stmts.touchPlaylist.run(now, playlistId);
      return tracks.length;
    });
    return run();
  }

  /** Remove the track at a 1-based position, keeping positions contiguous. */
  removeTrack(playlistId, position) {
    const run = this.db.transaction(() => {
      const row = this.stmts.getTrackAt.get(playlistId, position);
      if (!row) return null;
      this.stmts.deleteTrack.run(row.id);
      this.stmts.shiftDown.run(playlistId, position);
      this.stmts.touchPlaylist.run(Date.now(), playlistId);
      return mapTrack(row);
    });
    return run();
  }

  getTracks(playlistId, { limit = -1, offset = 0 } = {}) {
    return this.stmts.getTracks.all(playlistId, limit, offset).map(mapTrack);
  }

  getVideoIds(playlistId) {
    return new Set(this.stmts.videoIds.all(playlistId).map((r) => r.video_id));
  }

  close() {
    if (this.db.open) this.db.close();
  }
}
