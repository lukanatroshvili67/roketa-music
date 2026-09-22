import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../ui/embeds.js';
import { trackLink } from '../../utils/format.js';

export default {
  data: new SlashCommandBuilder()
    .setName('move')
    .setDescription('Move a track to another position in the queue')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) => o.setName('from').setDescription('Current position').setRequired(true).setMinValue(1))
    .addIntegerOption((o) => o.setName('to').setDescription('New position').setRequired(true).setMinValue(1)),
  voice: 'same',
  dj: true,
  async execute(interaction, ctx) {
    const from = interaction.options.getInteger('from', true);
    const to = interaction.options.getInteger('to', true);
    const track = ctx.player.move(from, to);
    await interaction.reply({ embeds: [successEmbed(`↕️ Moved ${trackLink(track)} to position **${to}**.`)] });
  },
};
