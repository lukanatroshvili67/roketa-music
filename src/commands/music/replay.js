import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../ui/embeds.js';
import { trackLink } from '../../utils/format.js';

export default {
  data: new SlashCommandBuilder().setName('replay').setDescription('Restart the current track from the beginning').setContexts(InteractionContextType.Guild),
  voice: 'same',
  dj: true,
  async execute(interaction, ctx) {
    await interaction.deferReply();
    const track = await ctx.player.replay();
    await interaction.editReply({ embeds: [successEmbed(`🔄 Replaying ${trackLink(track)}`)] });
  },
};
