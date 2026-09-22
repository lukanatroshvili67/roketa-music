import { EmbedBuilder, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { Colors, loopLabel, successEmbed } from '../../ui/embeds.js';
import { LoopMode } from '../../queue/Queue.js';
import { config } from '../../config/index.js';

export default {
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Configure the music bot for this server')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('view').setDescription('Show the current settings'))
    .addSubcommand((s) =>
      s
        .setName('djrole')
        .setDescription('Restrict playback controls to a DJ role (omit the role to allow everyone)')
        .addRoleOption((o) => o.setName('role').setDescription('DJ role')),
    )
    .addSubcommand((s) =>
      s
        .setName('volume')
        .setDescription('Default volume for new sessions')
        .addIntegerOption((o) => o.setName('level').setDescription('0-200').setRequired(true).setMinValue(0).setMaxValue(config.player.maxVolume)),
    )
    .addSubcommand((s) =>
      s
        .setName('loop')
        .setDescription('Default loop mode for new sessions')
        .addStringOption((o) =>
          o
            .setName('mode')
            .setDescription('Loop mode')
            .setRequired(true)
            .addChoices({ name: 'Off', value: LoopMode.OFF }, { name: 'Current track', value: LoopMode.TRACK }, { name: 'Whole queue', value: LoopMode.QUEUE }),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('duplicates')
        .setDescription('Allow the same song to be queued more than once')
        .addBooleanOption((o) => o.setName('allowed').setDescription('Allow duplicates').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('announce')
        .setDescription('Post a Now Playing message with controls for each song')
        .addBooleanOption((o) => o.setName('enabled').setDescription('Enabled').setRequired(true)),
    ),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    let updated;
    let message;
    switch (sub) {
      case 'djrole': {
        const role = interaction.options.getRole('role');
        updated = ctx.settingsService.update(guildId, { djRoleId: role?.id ?? null });
        message = role ? `🎧 DJ role set to ${role}.` : '🎧 DJ role removed — everyone can control playback.';
        break;
      }
      case 'volume':
        updated = ctx.settingsService.update(guildId, { defaultVolume: interaction.options.getInteger('level', true) });
        message = `🔊 Default volume set to **${updated.defaultVolume}%** (applies to new sessions).`;
        break;
      case 'loop':
        updated = ctx.settingsService.update(guildId, { defaultLoop: interaction.options.getString('mode', true) });
        message = `🔁 Default loop mode set to **${loopLabel(updated.defaultLoop)}**.`;
        break;
      case 'duplicates': {
        const allowed = interaction.options.getBoolean('allowed', true);
        updated = ctx.settingsService.update(guildId, { allowDuplicates: allowed });
        const player = ctx.manager.get(guildId);
        if (player) player.queue.allowDuplicates = allowed;
        message = allowed ? '✅ Duplicate songs are now allowed.' : '🚫 Duplicate songs will be skipped when queueing.';
        break;
      }
      case 'announce':
        updated = ctx.settingsService.update(guildId, { announceNowPlaying: interaction.options.getBoolean('enabled', true) });
        message = updated.announceNowPlaying ? '📣 Now Playing messages enabled.' : '🔕 Now Playing messages disabled.';
        break;
      default: {
        const s = ctx.settingsService.get(guildId);
        const embed = new EmbedBuilder()
          .setColor(Colors.primary)
          .setTitle('⚙️ Music settings')
          .addFields(
            { name: 'DJ role', value: s.djRoleId ? `<@&${s.djRoleId}>` : 'None (everyone)', inline: true },
            { name: 'Default volume', value: `${s.defaultVolume}%`, inline: true },
            { name: 'Default loop', value: loopLabel(s.defaultLoop), inline: true },
            { name: 'Duplicates', value: s.allowDuplicates ? 'Allowed' : 'Skipped', inline: true },
            { name: 'Now Playing messages', value: s.announceNowPlaying ? 'On' : 'Off', inline: true },
          );
        return interaction.reply({ embeds: [embed] });
      }
    }
    return interaction.reply({ embeds: [successEmbed(message)] });
  },
};
