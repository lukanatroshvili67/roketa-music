import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../ui/embeds.js';

export default {
  data: new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the upcoming tracks').setContexts(InteractionContextType.Guild),
  voice: 'same',
  dj: true,
  async execute(interaction, ctx) {
    const count = ctx.player.shuffle();
    await interaction.reply({ embeds: [successEmbed(`🔀 Shuffled **${count}** upcoming tracks.`)] });
  },
};
