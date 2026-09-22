import {
  ActionRowBuilder,
  ComponentType,
  EmbedBuilder,
  InteractionContextType,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { Colors, trackAddedEmbed } from '../../ui/embeds.js';
import { formatDuration, trackLink, truncate } from '../../utils/format.js';
import { UserError } from '../../utils/errors.js';
import { enqueueTracks } from '../../interactions/playback.js';
import { assertCanJoin } from '../../interactions/guards.js';

export default {
  data: new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search YouTube and pick a result to play')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) => o.setName('query').setDescription('What to search for').setRequired(true).setMaxLength(200)),
  voice: 'join',
  async execute(interaction, ctx) {
    const query = interaction.options.getString('query', true);
    await interaction.deferReply();
    const results = await ctx.ytdlp.search(query, 8);
    if (!results.length) throw new UserError('No results found.');

    const customId = `search:${interaction.id}`;
    const menu = new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Choose a track to add')
      .addOptions(
        results.map((t, i) => ({
          label: truncate(`${i + 1}. ${t.title}`, 100),
          description: truncate(`${t.author} · ${formatDuration(t.duration)}`, 100),
          value: String(i),
        })),
      );
    const embed = new EmbedBuilder()
      .setColor(Colors.primary)
      .setTitle(truncate(`🔎 Results for "${query}"`, 256))
      .setDescription(results.map((t, i) => `\`${i + 1}.\` ${trackLink(t, 70)} · \`${formatDuration(t.duration)}\``).join('\n'))
      .setFooter({ text: 'Select a track within 60 seconds' });
    const message = await interaction.editReply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });

    let selection;
    try {
      selection = await message.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.customId === customId && i.user.id === interaction.user.id,
        time: 60_000,
      });
    } catch {
      await interaction.editReply({ components: [] }).catch(() => {});
      return;
    }
    await selection.deferUpdate();
    const choice = results[Number(selection.values[0])];
    // Voice state may have changed while the user was choosing: re-validate.
    const voiceChannel = assertCanJoin(selection.member, ctx.manager.get(interaction.guildId));
    const { result, tracks } = await enqueueTracks(ctx, interaction, voiceChannel, [choice]);
    await interaction.editReply({ embeds: [trackAddedEmbed(tracks[0], result)], components: [] });
  },
};
