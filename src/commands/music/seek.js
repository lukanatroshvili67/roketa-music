import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../ui/embeds.js';
import { formatDuration, parseTimestamp } from '../../utils/format.js';
import { UserError } from '../../utils/errors.js';

export default {
  data: new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Jump to a timestamp in the current track')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('time').setDescription('e.g. 1:30, 90, 1m30s, 1:02:03').setRequired(true).setMaxLength(20)),
  voice: 'same',
  dj: true,
  async execute(interaction, ctx) {
    const seconds = parseTimestamp(interaction.options.getString('time', true));
    if (seconds === null) throw new UserError('Invalid timestamp. Try formats like `1:30`, `90` or `1m30s`.');
    await interaction.deferReply();
    await ctx.player.seek(seconds);
    await interaction.editReply({ embeds: [successEmbed(`⏩ Seeked to **${formatDuration(seconds)}**.`)] });
  },
};
