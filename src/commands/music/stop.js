import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../ui/embeds.js';

export function buildStopCommand(name, description) {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild),
    voice: 'same',
    dj: true,
    async execute(interaction, ctx) {
      ctx.manager.destroy(interaction.guildId, 'stop');
      await interaction.reply({ embeds: [successEmbed('⏹️ Stopped the music, cleared the queue and left the voice channel.')] });
    },
  };
}

export default buildStopCommand('stop', 'Stop playback, clear the queue and disconnect');
