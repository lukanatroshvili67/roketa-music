import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { queueView } from '../../ui/embeds.js';
import { UserError } from '../../utils/errors.js';

export default {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the queue')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  async execute(interaction, ctx) {
    const player = ctx.manager.get(interaction.guildId);
    if (!player || player.queue.isEmpty) throw new UserError('The queue is empty. Use `/play` to add music.');
    await interaction.reply(queueView(player, interaction.options.getInteger('page') ?? 1));
  },
};
