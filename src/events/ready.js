import { ActivityType, Events } from 'discord.js';

export default {
  name: Events.ClientReady,
  once: true,
  /** @param {import('discord.js').Client<true>} client */
  async execute(client, app) {
    app.logger.info({ user: client.user.tag, guilds: client.guilds.cache.size, commands: app.commands.size }, 'Bot is online');
    client.user.setPresence({ activities: [{ name: '/play', type: ActivityType.Listening }], status: 'online' });
  },
};
