import { Events } from 'discord.js';

/**
 * Keeps players in sync with voice channel membership:
 *  - pauses and schedules a leave when the bot is left alone, resumes when someone comes back
 *  - destroys the player when the bot is removed from voice by someone else
 */
export default {
  name: Events.VoiceStateUpdate,
  /**
   * @param {import('discord.js').VoiceState} oldState
   * @param {import('discord.js').VoiceState} newState
   */
  async execute(oldState, newState, app) {
    const guild = newState.guild;
    const player = app.manager.get(guild.id);
    if (!player) return;
    const botId = guild.client.user.id;

    // The bot itself changed state.
    if (newState.id === botId) {
      if (oldState.channelId && !newState.channelId) {
        // Disconnected by a moderator (the voice connection handler also covers this; destroy is idempotent).
        setTimeout(() => {
          if (!guild.members.me?.voice.channelId && !player.destroyed) player.destroy('disconnected');
        }, 5_000).unref?.();
        return;
      }
      if (newState.channelId && oldState.channelId !== newState.channelId) {
        // Moved to another channel: re-evaluate whether anyone is listening there.
        evaluate(player, newState.channel);
      }
      return;
    }

    const botChannelId = player.voiceChannelId;
    if (!botChannelId) return;
    if (oldState.channelId === botChannelId || newState.channelId === botChannelId) {
      evaluate(player, guild.channels.cache.get(botChannelId));
    }
  },
};

function evaluate(player, channel) {
  if (!channel) return;
  const listeners = channel.members.filter((m) => !m.user.bot && !m.voice.deaf).size;
  if (listeners === 0) player.onChannelEmpty();
  else player.onChannelOccupied();
}
