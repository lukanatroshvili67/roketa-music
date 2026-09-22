import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../ui/embeds.js';

export default {
  data: new SlashCommandBuilder().setName('dedupe').setDescription('Remove duplicate songs from the queue').setContexts(InteractionContextType.Guild),
  voice: 'same',
  dj: true,
  async execute(interaction, ctx) {
    const count = ctx.player.dedupe();
    await interaction.reply({ embeds: [successEmbed(count ? `🧹 Removed **${count}** duplicate tracks.` : 'No duplicates found.')] });
  },
};
