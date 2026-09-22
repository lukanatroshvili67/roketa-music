import { PermissionFlagsBits } from 'discord.js';
import { errorEmbed, infoEmbed, nowPlayingEmbed, playerButtons, warnEmbed } from './embeds.js';
import { escapeMarkdown, truncate } from '../utils/format.js';

const MIN_EDIT_INTERVAL = 2_500;

const LEAVE_MESSAGES = {
  'queue-end': '👋 The queue finished a while ago, so I left the voice channel.',
  'channel-empty': '👋 Everyone left the voice channel, so I left too.',
  inactive: '👋 Left the voice channel due to inactivity.',
  disconnected: '🔌 I was disconnected from the voice channel. The queue has been cleared.',
  'connection-lost': '⚠️ I lost the voice connection and could not reconnect. The queue has been cleared.',
  'connection-destroyed': '🔌 The voice connection was closed. The queue has been cleared.',
};

/**
 * Keeps one "Now Playing" message per guild in sync with the player, with rate-limit friendly editing.
 */
export class NowPlayingController {
  constructor({ player, client, settings, logger, updateInterval }) {
    this.player = player;
    this.client = client;
    this.settings = settings;
    this.logger = logger;
    this.updateInterval = updateInterval;
    this.message = null;
    this.lastEdit = 0;
    this.editTimer = null;
    this.progressTimer = null;
    this.errorBuffer = [];
    this.errorTimer = null;

    // UI failures must never break playback or surface as unhandled rejections.
    const safe = (fn) => (...args) => {
      try {
        Promise.resolve(fn(...args)).catch((err) => this.logger.warn({ err }, 'Now Playing update failed'));
      } catch (err) {
        this.logger.warn({ err }, 'Now Playing update failed');
      }
    };
    player.on('trackStart', safe(() => this.onTrackStart()));
    player.on('stateChange', safe(() => this.scheduleEdit()));
    player.on('trackError', safe((track, err) => this.onTrackError(track, err)));
    player.on('queueEnd', safe(() => this.onQueueEnd()));
    player.once('destroyed', safe((reason) => this.onDestroyed(reason)));
  }

  channel() {
    const id = this.player.textChannelId;
    if (!id) return null;
    const channel = this.client.channels.cache.get(id);
    if (!channel?.isTextBased() || !channel.guild) return null;
    const perms = channel.permissionsFor(channel.guild.members.me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) return null;
    return channel;
  }

  async send(payload) {
    const channel = this.channel();
    if (!channel) return null;
    try {
      return await channel.send(payload);
    } catch (err) {
      this.logger.debug({ err: err.message }, 'Failed to send message');
      return null;
    }
  }

  async onTrackStart() {
    if (!this.settings.get(this.player.guildId).announceNowPlaying) return;
    const old = this.message;
    this.message = null;
    if (old) old.delete().catch(() => {});
    this.message = await this.send({ embeds: [nowPlayingEmbed(this.player)], components: playerButtons(this.player) });
    this.lastEdit = Date.now();
    this.startProgressUpdates();
  }

  startProgressUpdates() {
    clearInterval(this.progressTimer);
    if (!this.updateInterval) return;
    this.progressTimer = setInterval(() => {
      if (this.player.isPlaying) this.scheduleEdit();
    }, this.updateInterval);
    this.progressTimer.unref?.();
  }

  /** Debounced edit: coalesces bursts of state changes into one API call. */
  scheduleEdit() {
    if (!this.message || this.editTimer) return;
    const wait = Math.max(0, MIN_EDIT_INTERVAL - (Date.now() - this.lastEdit));
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      this.edit();
    }, wait);
    this.editTimer.unref?.();
  }

  async edit() {
    const message = this.message;
    if (!message || this.player.destroyed || !this.player.current) return;
    this.lastEdit = Date.now();
    try {
      await message.edit({ embeds: [nowPlayingEmbed(this.player)], components: playerButtons(this.player) });
    } catch (err) {
      // Message deleted by someone: stop tracking it.
      if (err.code === 10008) this.message = null;
      else this.logger.debug({ err: err.message }, 'Failed to edit now playing message');
    }
  }

  onTrackError(track, err) {
    const reason = err?.message ?? 'Unknown error';
    this.errorBuffer.push(track ? `**${escapeMarkdown(truncate(track.title, 60))}** — ${reason}` : reason);
    if (this.errorTimer) return;
    // Batch failures (e.g. several dead videos in a playlist) into one message.
    this.errorTimer = setTimeout(() => {
      this.errorTimer = null;
      const lines = this.errorBuffer.splice(0);
      const shown = lines.slice(0, 8);
      const more = lines.length - shown.length;
      this.send({ embeds: [errorEmbed(`Could not play:\n${shown.join('\n')}${more > 0 ? `\n…and ${more} more` : ''}`)] });
    }, 2_000);
    this.errorTimer.unref?.();
  }

  async onQueueEnd() {
    clearInterval(this.progressTimer);
    await this.retireMessage();
    this.send({ embeds: [infoEmbed('✅ The queue has finished. Use `/play` to add more music.')] });
  }

  async retireMessage() {
    const message = this.message;
    this.message = null;
    if (!message) return;
    try {
      await message.edit({ components: [] });
    } catch {
      /* deleted */
    }
  }

  async onDestroyed(reason) {
    clearInterval(this.progressTimer);
    clearTimeout(this.editTimer);
    await this.retireMessage();
    const text = LEAVE_MESSAGES[reason];
    if (text && this.client.isReady()) await this.send({ embeds: [reason.startsWith('connection') ? warnEmbed(text) : infoEmbed(text)] });
  }
}

/** Wire a controller onto every player the manager creates. */
export function attachNowPlaying({ manager, client, settings, logger, updateInterval }) {
  manager.on('playerCreate', (player) => new NowPlayingController({ player, client, settings, logger, updateInterval }));
}
