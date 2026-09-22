import { Track } from '../music/Track.js';
import { UserError } from '../utils/errors.js';

export const Scope = Object.freeze({ USER: 'user', GUILD: 'guild' });
const REF_PATTERN = /^([ug]):(\d+)$/;
const MAX_NAME = 50;

/**
 * Business rules for persistent playlists (validation, limits, ownership, permissions).
 * Personal playlists belong to a user and work in every server; server playlists belong to a guild.
 */
export class PlaylistService {
  constructor({ store, limits }) {
    this.store = store;
    this.limits = limits;
  }

  static validateName(raw) {
    const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!name) throw new UserError('Playlist name cannot be empty.');
    if (name.length > MAX_NAME) throw new UserError(`Playlist name must be at most ${MAX_NAME} characters.`);
    if (REF_PATTERN.test(name)) throw new UserError('That playlist name is reserved. Please pick another.');
    if (/[`@]/.test(name)) throw new UserError('Playlist names cannot contain ` or @.');
    return name;
  }

  ownerId(scope, ctx) {
    return scope === Scope.GUILD ? ctx.guildId : ctx.userId;
  }

  /** Autocomplete value for a playlist — lets users pick unambiguously between personal and server playlists. */
  static ref(playlist) {
    return `${playlist.ownerType === Scope.GUILD ? 'g' : 'u'}:${playlist.id}`;
  }

  /**
   * Find a playlist from user input: an autocomplete ref ("u:12"), or a plain name.
   * Plain names check the requested scope, or personal first then server when no scope is given.
   * @param {string} input
   * @param {{ userId: string, guildId: string }} ctx
   * @param {string} [scope]
   */
  find(input, ctx, scope) {
    const text = String(input ?? '').trim();
    const ref = REF_PATTERN.exec(text);
    let playlist = null;
    if (ref) {
      playlist = this.store.getPlaylistById(Number(ref[2]));
      if (playlist && !this.isVisible(playlist, ctx)) playlist = null;
    } else {
      const scopes = scope ? [scope] : [Scope.USER, Scope.GUILD];
      for (const s of scopes) {
        playlist = this.store.getPlaylist(s, this.ownerId(s, ctx), text);
        if (playlist) break;
      }
    }
    if (!playlist) throw new UserError(`Playlist **${text.slice(0, MAX_NAME)}** was not found.`);
    return playlist;
  }

  isVisible(playlist, ctx) {
    return (playlist.ownerType === Scope.USER && playlist.ownerId === ctx.userId) || (playlist.ownerType === Scope.GUILD && playlist.ownerId === ctx.guildId);
  }

  /**
   * @param {{ userId: string, guildId: string, isManager: boolean }} ctx isManager = ManageGuild or DJ role
   */
  assertCanEdit(playlist, ctx) {
    if (playlist.ownerType === Scope.USER) {
      if (playlist.ownerId !== ctx.userId) throw new UserError('You can only modify your own playlists.');
      return;
    }
    if (playlist.ownerId !== ctx.guildId) throw new UserError('That playlist belongs to another server.');
    if (!ctx.isManager && playlist.createdBy !== ctx.userId) {
      throw new UserError('Only the creator, DJs, or members with **Manage Server** can modify server playlists.');
    }
  }

  create(rawName, scope, ctx) {
    const name = PlaylistService.validateName(rawName);
    if (scope === Scope.GUILD && !ctx.isManager) {
      throw new UserError('Only DJs or members with **Manage Server** can create server playlists.');
    }
    const ownerId = this.ownerId(scope, ctx);
    if (this.store.getPlaylist(scope, ownerId, name)) throw new UserError(`A playlist named **${name}** already exists.`);
    if (this.store.countPlaylists(scope, ownerId) >= this.limits.maxPerOwner) {
      throw new UserError(`Playlist limit reached (${this.limits.maxPerOwner}). Delete one first.`);
    }
    return this.store.createPlaylist({ ownerType: scope, ownerId, name, createdBy: ctx.userId });
  }

  rename(playlist, rawName, ctx) {
    this.assertCanEdit(playlist, ctx);
    const name = PlaylistService.validateName(rawName);
    const clash = this.store.getPlaylist(playlist.ownerType, playlist.ownerId, name);
    if (clash && clash.id !== playlist.id) throw new UserError(`A playlist named **${name}** already exists.`);
    return this.store.renamePlaylist(playlist.id, name);
  }

  delete(playlist, ctx) {
    this.assertCanEdit(playlist, ctx);
    return this.store.deletePlaylist(playlist.id);
  }

  /**
   * Append tracks, skipping ones already in the playlist and respecting the size limit.
   * @returns {{ added: number, duplicates: number, overflow: number }}
   */
  addTracks(playlist, tracks, ctx) {
    this.assertCanEdit(playlist, ctx);
    const existing = this.store.getVideoIds(playlist.id);
    const room = this.limits.maxTracks - existing.size;
    const fresh = [];
    let duplicates = 0;
    for (const t of tracks) {
      if (existing.has(t.videoId)) {
        duplicates++;
        continue;
      }
      existing.add(t.videoId);
      fresh.push(t);
    }
    const accepted = fresh.slice(0, Math.max(0, room));
    if (accepted.length) this.store.addTracks(playlist.id, accepted, ctx.userId);
    return { added: accepted.length, duplicates, overflow: fresh.length - accepted.length };
  }

  removeTrack(playlist, position, ctx) {
    this.assertCanEdit(playlist, ctx);
    const count = this.store.countTracks(playlist.id);
    if (!Number.isInteger(position) || position < 1 || position > count) {
      throw new UserError(count ? `Position must be between 1 and ${count}.` : 'That playlist is empty.');
    }
    return this.store.removeTrack(playlist.id, position);
  }

  list(scope, ctx) {
    return this.store.listPlaylists(scope, this.ownerId(scope, ctx));
  }

  getTracks(playlist, opts) {
    return this.store.getTracks(playlist.id, opts);
  }

  countTracks(playlist) {
    return this.store.countTracks(playlist.id);
  }

  /** Convert stored rows into queueable Track objects. */
  toQueueTracks(playlist, requestedBy) {
    return this.store.getTracks(playlist.id).map((row) => new Track({ ...row, requestedBy }));
  }

  /** Autocomplete suggestions across personal and server playlists. */
  suggest(text, ctx, { scope, limit = 25 } = {}) {
    const scopes = scope ? [scope] : [Scope.USER, Scope.GUILD];
    const results = [];
    for (const s of scopes) {
      for (const p of this.store.searchPlaylists(s, this.ownerId(s, ctx), text ?? '', limit)) results.push(p);
    }
    return results.slice(0, limit);
  }
}
