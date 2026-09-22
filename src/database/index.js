import { SqliteStore } from './sqlite.js';

/**
 * Storage interface used by the rest of the bot. Any replacement driver (Postgres, MongoDB, ...) must implement:
 *
 *   getGuildSettings(guildId) → settings | null
 *   updateGuildSettings(guildId, patch) → settings
 *   getPlaylist(ownerType, ownerId, name) → playlist | null
 *   getPlaylistById(id) → playlist | null
 *   listPlaylists(ownerType, ownerId) → playlist[] (with trackCount, totalDuration)
 *   searchPlaylists(ownerType, ownerId, text, limit) → playlist[]
 *   countPlaylists(ownerType, ownerId) → number
 *   createPlaylist({ ownerType, ownerId, name, createdBy }) → playlist
 *   renamePlaylist(id, name) → playlist
 *   deletePlaylist(id) → boolean
 *   countTracks(playlistId) → number
 *   addTracks(playlistId, tracks, addedBy) → number
 *   removeTrack(playlistId, position) → track | null
 *   getTracks(playlistId, { limit, offset }) → track[]
 *   getVideoIds(playlistId) → Set<string>
 *   close()
 *
 * ownerType is 'user' (personal playlist, owned by a user id, usable in every server)
 * or 'guild' (server playlist, owned by a guild id).
 */
export function createStore(dbConfig) {
  switch (dbConfig.driver) {
    case 'sqlite':
      return new SqliteStore(dbConfig.path);
    default:
      throw new Error(`Unsupported DATABASE_DRIVER "${dbConfig.driver}"`);
  }
}
