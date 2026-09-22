import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { nowPlayingEmbed, playerButtons } from '../../ui/embeds.js';
import { UserError } from '../../utils/errors.js';

export function buildNowPlayingCommand(name) {
  return {
    data: new SlashCommandBuilder().setName(name).setDescription('Show the currently playing track').setContexts(InteractionContextType.Guild),
    async execute(interaction, ctx) {
      const player = ctx.manager.get(interaction.guildId);
      if (!player?.current) throw new UserError('Nothing is playing right now.');
      await interaction.reply({ embeds: [nowPlayingEmbed(player)], components: playerButtons(player) });
    },
  };
}

export default buildNowPlayingCommand('nowplaying');
