import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { loopLabel, successEmbed } from '../../ui/embeds.js';
import { LoopMode } from '../../queue/Queue.js';

export default {
  data: new SlashCommandBuilder()
    .setName('loop')
    .setDescription('Set the loop mode (cycles through modes when no mode is given)')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('Loop mode')
        .addChoices(
          { name: 'Off', value: LoopMode.OFF },
          { name: 'Current track', value: LoopMode.TRACK },
          { name: 'Whole queue', value: LoopMode.QUEUE },
        ),
    ),
  voice: 'same',
  dj: true,
  async execute(interaction, ctx) {
    const mode = ctx.player.setLoop(interaction.options.getString('mode') ?? undefined);
    await interaction.reply({ embeds: [successEmbed(`Loop mode: **${loopLabel(mode)}**`)] });
  },
};
