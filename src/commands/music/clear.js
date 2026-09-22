import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../ui/embeds.js';

export default {
  data: new SlashCommandBuilder().setName('clear').setDescription('Remove all upcoming tracks (keeps the current one)').setContexts(InteractionContextType.Guild),
  voice: 'same',
  dj: true,
  async execute(interaction, ctx) {
    const count = ctx.player.clear();
    await interaction.reply({ embeds: [successEmbed(`🧹 Cleared **${count}** tracks from the queue.`)] });
  },
};
