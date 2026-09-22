import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../ui/embeds.js';

export default {
  data: new SlashCommandBuilder().setName('resume').setDescription('Resume playback').setContexts(InteractionContextType.Guild),
  voice: 'same',
  async execute(interaction, ctx) {
    ctx.player.resume();
    await interaction.reply({ embeds: [successEmbed('▶️ Resumed.')] });
  },
};
