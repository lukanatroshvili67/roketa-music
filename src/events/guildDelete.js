import { Events } from 'discord.js';

/** Bot was removed from a server (or the server went unavailable): free its player immediately. */
export default {
  name: Events.GuildDelete,
  async execute(guild, app) {
    app.manager.destroy(guild.id, 'guild-removed');
    app.settingsService.forget(guild.id);
    app.logger.info({ guildId: guild.id }, 'Removed from guild');
  },
};
