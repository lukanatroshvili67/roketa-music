import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../ui/embeds.js';

export default {
  data: new SlashCommandBuilder().setName('pause').setDescription('Pause playback').setContexts(InteractionContextType.Guild),
  voice: 'same',
  async execute(interaction, ctx) {
    await ctx.player.pause();
    await interaction.reply({ embeds: [successEmbed('⏸️ Paused. Use `/resume` to continue.')] });
  },
};
