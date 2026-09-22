import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../ui/embeds.js';
import { trackLink } from '../../utils/format.js';
import { assertCanControl } from '../../interactions/guards.js';

export default {
  data: new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a track (or a range of tracks) from the queue')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) => o.setName('position').setDescription('Queue position').setRequired(true).setMinValue(1))
    .addIntegerOption((o) => o.setName('to').setDescription('Remove everything up to this position (inclusive)').setMinValue(1)),
  voice: 'same',
  async execute(interaction, ctx) {
    const { player } = ctx;
    const position = interaction.options.getInteger('position', true);
    const to = interaction.options.getInteger('to') ?? undefined;
    // Anyone may remove a single track they requested; ranges or others' tracks need control permission.
    const target = player.queue.upcoming[position - 1];
    if (to || !target || target.requestedBy.id !== interaction.user.id) assertCanControl(ctx.member, ctx.settings);
    const removed = player.remove(position, to);
    await interaction.reply({
      embeds: [successEmbed(removed.length === 1 ? `🗑️ Removed ${trackLink(removed[0])}` : `🗑️ Removed **${removed.length}** tracks.`)],
    });
  },
};
