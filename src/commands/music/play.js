import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { bulkAddedEmbed, trackAddedEmbed } from '../../ui/embeds.js';
import { enqueueTracks } from '../../interactions/playback.js';

export function buildPlayCommand(name, description, { forceNext = false } = {}) {
  const data = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o.setName('query').setDescription('YouTube video/playlist URL or search terms').setRequired(true).setMaxLength(500),
    );
  if (!forceNext) {
    data.addBooleanOption((o) => o.setName('next').setDescription('Put it at the front of the queue'));
  }
  data.addBooleanOption((o) => o.setName('shuffle').setDescription('Shuffle playlist tracks before adding them'));

  return {
    data,
    voice: 'join',
    async execute(interaction, ctx) {
      const query = interaction.options.getString('query', true);
      const next = forceNext || (interaction.options.getBoolean('next') ?? false);
      const shuffle = interaction.options.getBoolean('shuffle') ?? false;
      await interaction.deferReply();

      const resolved = await ctx.ytdlp.resolve(query, { playlistLimit: ctx.config.player.maxPlaylistImport });
      const { result, tracks, tooLong } = await enqueueTracks(ctx, interaction, ctx.voiceChannel, resolved.tracks, {
        position: next ? 'next' : 'end',
        shuffle,
        seek: resolved.start ?? 0,
      });

      if (resolved.kind === 'playlist') {
        await interaction.editReply({
          embeds: [
            bulkAddedEmbed({
              title: resolved.playlist.title,
              url: resolved.playlist.url,
              added: result.added,
              duplicates: result.duplicates,
              overflow: result.overflow,
              unavailable: resolved.playlist.unavailable + tooLong,
              truncated: resolved.playlist.truncated,
              started: result.started,
            }),
          ],
        });
      } else {
        await interaction.editReply({ embeds: [trackAddedEmbed(tracks[0], result)] });
      }
    },
  };
}

export default buildPlayCommand('play', 'Play a song or playlist from YouTube (URL or search)');
