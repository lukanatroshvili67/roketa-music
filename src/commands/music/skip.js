import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { successEmbed } from '../../ui/embeds.js';
import { trackLink } from '../../utils/format.js';
import { assertCanControl } from '../../interactions/guards.js';
import { UserError } from '../../utils/errors.js';

export default {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current track (or jump to a queue position)')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) => o.setName('to').setDescription('Queue position to jump to').setMinValue(1)),
  voice: 'same',
  async execute(interaction, ctx) {
    const { player } = ctx;
    const current = player.current;
    if (!current) throw new UserError('Nothing is playing.');
    // The requester of the current track may always skip their own song.
    if (current.requestedBy.id !== interaction.user.id) assertCanControl(ctx.member, ctx.settings);
    const to = interaction.options.getInteger('to') ?? undefined;
    await interaction.deferReply();
    const { skipped, next } = await player.skip(to);
    await interaction.editReply({
      embeds: [successEmbed(`⏭️ Skipped ${trackLink(skipped)}${next ? `\nNow playing ${trackLink(next)}` : '\nThe queue is now empty.'}`)],
    });
  },
};
