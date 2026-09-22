import { EventEmitter } from 'node:events';
import { GuildPlayer } from './GuildPlayer.js';

/**
 * Owns one GuildPlayer per guild and reclaims inactive ones so memory never grows unbounded.
 *
 * Events: playerCreate (player), playerDestroy (player, reason)
 */
export class PlayerManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./StreamFactory.js').StreamFactory} opts.streamFactory
   * @param {{ prefetch(videoId: string): void }} [opts.prefetcher]
   * @param {(guildId: string) => object} opts.getSettings synchronous guild-settings lookup
   * @param {object} opts.options player config section
   * @param {import('pino').Logger} opts.logger
   */
  constructor({ streamFactory, prefetcher, getSettings, options, logger, playerOverrides = {} }) {
    super();
    this.playerOverrides = playerOverrides;
    this.streamFactory = streamFactory;
    this.prefetcher = prefetcher;
    this.getSettings = getSettings;
    this.options = options;
    this.logger = logger;
    /** @type {Map<string, GuildPlayer>} */
    this.players = new Map();
    this.sweeper = null;
  }

  get(guildId) {
    const player = this.players.get(guildId);
    return player && !player.destroyed ? player : undefined;
  }

  getOrCreate(guildId) {
    const existing = this.get(guildId);
    if (existing) return existing;
    const player = new GuildPlayer({
      guildId,
      streamFactory: this.streamFactory,
      prefetcher: this.prefetcher,
      settings: this.getSettings(guildId),
      options: this.options,
      logger: this.logger,
      ...this.playerOverrides,
    });
    player.once('destroyed', (reason) => {
      if (this.players.get(guildId) === player) this.players.delete(guildId);
      this.emit('playerDestroy', player, reason);
    });
    this.players.set(guildId, player);
    this.emit('playerCreate', player);
    return player;
  }

  destroy(guildId, reason = 'destroyed') {
    this.players.get(guildId)?.destroy(reason);
    this.players.delete(guildId);
  }

  destroyAll(reason = 'shutdown') {
    for (const player of [...this.players.values()]) player.destroy(reason);
    this.players.clear();
  }

  /** Periodically destroy players that are idle / disconnected for too long. */
  startSweeper(intervalMs = 60_000) {
    this.stopSweeper();
    this.sweeper = setInterval(() => this.sweep(), intervalMs);
    this.sweeper.unref?.();
  }

  stopSweeper() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  sweep(now = Date.now()) {
    let removed = 0;
    for (const [guildId, player] of this.players) {
      if (player.destroyed) {
        this.players.delete(guildId);
        removed++;
      } else if (player.isInactive(now)) {
        player.destroy('inactive');
        removed++;
      }
    }
    if (removed) this.logger.info({ removed, active: this.players.size }, 'Swept inactive players');
    return removed;
  }

  stats() {
    let playing = 0;
    let queued = 0;
    for (const p of this.players.values()) {
      if (p.isPlaying) playing++;
      queued += p.queue.size;
    }
    return { players: this.players.size, playing, queued };
  }
}
