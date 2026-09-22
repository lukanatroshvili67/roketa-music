import { LOOP_MODES, LoopMode } from '../queue/Queue.js';

/**
 * Guild settings with config-driven defaults and a small in-memory cache (settings are read on every command).
 */
export class GuildSettingsService {
  constructor({ store, defaults }) {
    this.store = store;
    this.defaults = defaults;
    this.cache = new Map();
  }

  /** @returns {{ djRoleId: string|null, defaultVolume: number, defaultLoop: string, allowDuplicates: boolean, announceNowPlaying: boolean }} */
  get(guildId) {
    const cached = this.cache.get(guildId);
    if (cached) return cached;
    const row = this.store.getGuildSettings(guildId) ?? {};
    const settings = Object.freeze({
      djRoleId: row.djRoleId ?? null,
      defaultVolume: row.defaultVolume ?? this.defaults.defaultVolume,
      defaultLoop: LOOP_MODES.includes(row.defaultLoop) ? row.defaultLoop : LoopMode.OFF,
      allowDuplicates: row.allowDuplicates ?? true,
      announceNowPlaying: row.announceNowPlaying ?? true,
    });
    if (this.cache.size > 10_000) this.cache.clear();
    this.cache.set(guildId, settings);
    return settings;
  }

  update(guildId, patch) {
    this.store.updateGuildSettings(guildId, patch);
    this.cache.delete(guildId);
    return this.get(guildId);
  }

  forget(guildId) {
    this.cache.delete(guildId);
  }
}
