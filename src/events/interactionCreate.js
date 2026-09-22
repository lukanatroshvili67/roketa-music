import { Events, MessageFlags } from 'discord.js';
import { errorEmbed, warnEmbed } from '../ui/embeds.js';
import { assertCanJoin, assertCanControl, assertSameChannel } from '../interactions/guards.js';
import { respondError } from '../interactions/respond.js';
import { handleButton } from '../interactions/buttons.js';
import { UserError } from '../utils/errors.js';

export default {
  name: Events.InteractionCreate,
  /**
   * @param {import('discord.js').Interaction} interaction
   * @param {object} app application context
   */
  async execute(interaction, app) {
    if (interaction.isChatInputCommand()) return handleCommand(interaction, app);
    if (interaction.isAutocomplete()) return handleAutocomplete(interaction, app);
    if (interaction.isButton()) {
      try {
        await handleButton(interaction, app);
      } catch (err) {
        await respondError(interaction, err, app.logger);
      }
    }
    // Select menus (e.g. /search) are handled by component collectors on their messages.
  },
};

async function handleCommand(interaction, app) {
  const command = app.commands.get(interaction.commandName);
  if (!command) {
    await interaction.reply({ embeds: [errorEmbed('Unknown command. It may have been removed.')], flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ embeds: [errorEmbed('This command can only be used in a server.')], flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }

  const retryIn = app.rateLimiter.consume(interaction.user.id);
  if (retryIn > 0) {
    await interaction
      .reply({ embeds: [warnEmbed(`You're going too fast — try again in ${Math.ceil(retryIn / 1000)}s.`)], flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }

  const started = Date.now();
  try {
    const member = interaction.member;
    const settings = app.settingsService.get(interaction.guildId);
    const player = app.manager.get(interaction.guildId);
    const ctx = { ...app, member, settings, player, voiceChannel: null };

    if (command.voice === 'join') ctx.voiceChannel = assertCanJoin(member, player);
    if (command.voice === 'same') {
      assertSameChannel(member, player);
      if (!player.current && !player.queue.size) throw new UserError('Nothing is playing right now.');
    }
    if (command.dj) assertCanControl(member, settings);

    await command.execute(interaction, ctx);
    app.logger.debug({ command: interaction.commandName, guildId: interaction.guildId, ms: Date.now() - started }, 'Command executed');
  } catch (err) {
    await respondError(interaction, err, app.logger);
  }
}

async function handleAutocomplete(interaction, app) {
  const command = app.commands.get(interaction.commandName);
  try {
    if (!command?.autocomplete || !interaction.inCachedGuild()) return await interaction.respond([]);
    await command.autocomplete(interaction, app);
  } catch (err) {
    app.logger.debug({ err: err.message, command: interaction.commandName }, 'Autocomplete failed');
    await interaction.respond([]).catch(() => {});
  }
}
