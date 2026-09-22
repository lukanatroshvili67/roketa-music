import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../ui/embeds.js';
import { trackLink } from '../../utils/format.js';

export default {
  data: new SlashCommandBuilder().setName('previous').setDescription('Play the previous track again').setContexts(InteractionContextType.Guild),
  voice: 'same',
  dj: true,
  async execute(interaction, ctx) {
    await interaction.deferReply();
    const track = await ctx.player.previous();
    await interaction.editReply({ embeds: [successEmbed(`⏮️ Back to ${trackLink(track)}`)] });
  },
};
