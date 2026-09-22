import { EmbedBuilder, InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { Scope, PlaylistService } from '../../playlists/PlaylistService.js';
import { bulkAddedEmbed, Colors, successEmbed } from '../../ui/embeds.js';
import { escapeMarkdown, formatDuration, pluralize, trackLink, truncate } from '../../utils/format.js';
import { UserError } from '../../utils/errors.js';
import { assertCanControl, assertCanJoin, isDj } from '../../interactions/guards.js';
import { enqueueTracks, requesterOf } from '../../interactions/playback.js';

const PAGE_SIZE = 15;

const nameOption = (o, description = 'Playlist name') =>
  o.setName('name').setDescription(description).setRequired(true).setAutocomplete(true).setMaxLength(60);
const scopeOption = (o, description = 'Personal (yours, works in every server) or server playlist') =>
  o
    .setName('scope')
    .setDescription(description)
    .addChoices({ name: 'Personal', value: Scope.USER }, { name: 'Server', value: Scope.GUILD });

const data = new SlashCommandBuilder()
  .setName('playlist')
  .setDescription('Manage and play saved playlists')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) =>
    s
      .setName('create')
      .setDescription('Create a new playlist')
      .addStringOption((o) => o.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(50))
      .addStringOption((o) => scopeOption(o)),
  )
  .addSubcommand((s) => s.setName('delete').setDescription('Delete a playlist').addStringOption((o) => nameOption(o)))
  .addSubcommand((s) =>
    s
      .setName('rename')
      .setDescription('Rename a playlist')
      .addStringOption((o) => nameOption(o))
      .addStringOption((o) => o.setName('new_name').setDescription('New name').setRequired(true).setMaxLength(50)),
  )
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Add songs to a playlist (defaults to the current song)')
      .addStringOption((o) => nameOption(o))
      .addStringOption((o) => o.setName('query').setDescription('YouTube URL, playlist URL or search (empty = current song)').setMaxLength(500)),
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Remove a song from a playlist')
      .addStringOption((o) => nameOption(o))
      .addIntegerOption((o) => o.setName('position').setDescription('Track position (see /playlist view)').setRequired(true).setMinValue(1)),
  )
  .addSubcommand((s) =>
    s.setName('list').setDescription('List your playlists and this server\'s playlists').addStringOption((o) => scopeOption(o, 'Only show one kind')),
  )
  .addSubcommand((s) =>
    s
      .setName('view')
      .setDescription('Show the songs in a playlist')
      .addStringOption((o) => nameOption(o))
      .addIntegerOption((o) => o.setName('page').setDescription('Page').setMinValue(1)),
  )
  .addSubcommand((s) =>
    s
      .setName('play')
      .setDescription('Replace the queue with a playlist and start playing it')
      .addStringOption((o) => nameOption(o))
      .addBooleanOption((o) => o.setName('shuffle').setDescription('Shuffle before playing')),
  )
  .addSubcommand((s) =>
    s
      .setName('load')
      .setDescription('Append a playlist to the current queue')
      .addStringOption((o) => nameOption(o))
      .addBooleanOption((o) => o.setName('shuffle').setDescription('Shuffle before adding')),
  )
  .addSubcommand((s) =>
    s
      .setName('savequeue')
      .setDescription('Save the current song and queue as a new playlist')
      .addStringOption((o) => o.setName('name').setDescription('New playlist name').setRequired(true).setMaxLength(50))
      .addStringOption((o) => scopeOption(o)),
  );

function scopeLabel(p) {
  return p.ownerType === Scope.GUILD ? 'Server' : 'Personal';
}

function playlistTitle(p) {
  return `${p.ownerType === Scope.GUILD ? '🏠' : '👤'} ${escapeMarkdown(p.name)}`;
}

const handlers = {
  create(interaction, ctx, svc, pctx) {
    const scope = interaction.options.getString('scope') ?? Scope.USER;
    const playlist = svc.create(interaction.options.getString('name', true), scope, pctx);
    return interaction.reply({
      embeds: [successEmbed(`📁 Created ${scopeLabel(playlist).toLowerCase()} playlist **${escapeMarkdown(playlist.name)}**.\nAdd songs with \`/playlist add\`.`)],
    });
  },

  delete(interaction, ctx, svc, pctx) {
    const playlist = svc.find(interaction.options.getString('name', true), pctx);
    svc.delete(playlist, pctx);
    return interaction.reply({ embeds: [successEmbed(`🗑️ Deleted playlist **${escapeMarkdown(playlist.name)}**.`)] });
  },

  rename(interaction, ctx, svc, pctx) {
    const playlist = svc.find(interaction.options.getString('name', true), pctx);
    const renamed = svc.rename(playlist, interaction.options.getString('new_name', true), pctx);
    return interaction.reply({
      embeds: [successEmbed(`✏️ Renamed **${escapeMarkdown(playlist.name)}** to **${escapeMarkdown(renamed.name)}**.`)],
    });
  },

  async add(interaction, ctx, svc, pctx) {
    const playlist = svc.find(interaction.options.getString('name', true), pctx);
    svc.assertCanEdit(playlist, pctx);
    const query = interaction.options.getString('query');
    let tracks;
    let sourceTitle;
    if (!query) {
      const current = ctx.manager.get(interaction.guildId)?.current;
      if (!current) throw new UserError('Nothing is playing. Provide a `query` to add a song.');
      tracks = [current];
      sourceTitle = current.title;
      await interaction.deferReply();
    } else {
      await interaction.deferReply();
      const resolved = await ctx.ytdlp.resolve(query, { playlistLimit: ctx.config.playlists.maxTracks });
      tracks = resolved.tracks;
      sourceTitle = resolved.playlist?.title ?? tracks[0].title;
    }
    const result = svc.addTracks(playlist, tracks, pctx);
    const notes = [];
    if (result.duplicates) notes.push(`${pluralize(result.duplicates, 'duplicate')} skipped`);
    if (result.overflow) notes.push(`${result.overflow} not added (playlist limit ${ctx.config.playlists.maxTracks})`);
    if (!result.added) {
      throw new UserError(`Nothing was added to **${escapeMarkdown(playlist.name)}**${notes.length ? ` (${notes.join(', ')})` : ''}.`);
    }
    const what = tracks.length === 1 ? `**${escapeMarkdown(truncate(sourceTitle, 80))}**` : `**${pluralize(result.added, 'track')}**`;
    return interaction.editReply({
      embeds: [successEmbed(`➕ Added ${what} to **${escapeMarkdown(playlist.name)}**.${notes.length ? `\n-# ${notes.join(' · ')}` : ''}`)],
    });
  },

  remove(interaction, ctx, svc, pctx) {
    const playlist = svc.find(interaction.options.getString('name', true), pctx);
    const removed = svc.removeTrack(playlist, interaction.options.getInteger('position', true), pctx);
    return interaction.reply({
      embeds: [successEmbed(`🗑️ Removed **${escapeMarkdown(truncate(removed.title, 80))}** from **${escapeMarkdown(playlist.name)}**.`)],
    });
  },

  list(interaction, ctx, svc, pctx) {
    const only = interaction.options.getString('scope');
    const embed = new EmbedBuilder().setColor(Colors.primary).setTitle('📚 Playlists');
    const section = (scope, title) => {
      const lists = svc.list(scope, pctx);
      const value = lists.length
        ? lists
            .slice(0, 25)
            .map((p) => `• **${escapeMarkdown(p.name)}** — ${pluralize(p.trackCount, 'track')} · ${formatDuration(p.totalDuration)}`)
            .join('\n')
        : '*None yet*';
      embed.addFields({ name: title, value: truncate(value, 1024) });
    };
    if (!only || only === Scope.USER) section(Scope.USER, '👤 Your playlists');
    if (!only || only === Scope.GUILD) section(Scope.GUILD, `🏠 ${truncate(interaction.guild.name, 80)} playlists`);
    return interaction.reply({ embeds: [embed] });
  },

  view(interaction, ctx, svc, pctx) {
    const playlist = svc.find(interaction.options.getString('name', true), pctx);
    const total = svc.countTracks(playlist);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(interaction.options.getInteger('page') ?? 1, pages);
    const rows = svc.getTracks(playlist, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
    const lines = rows.map(
      (t) => `\`${t.position}.\` ${trackLink({ title: t.title, url: `https://www.youtube.com/watch?v=${t.videoId}` }, 60)} · \`${formatDuration(t.duration)}\``,
    );
    const embed = new EmbedBuilder()
      .setColor(Colors.primary)
      .setTitle(truncate(playlistTitle(playlist), 256))
      .setDescription(lines.length ? lines.join('\n') : '*This playlist is empty. Add songs with `/playlist add`.*')
      .setFooter({ text: `${scopeLabel(playlist)} playlist · ${pluralize(total, 'track')} · Page ${page}/${pages}` });
    return interaction.reply({ embeds: [embed] });
  },

  async play(interaction, ctx, svc, pctx) {
    return playPlaylist(interaction, ctx, svc, pctx, { replace: true });
  },

  async load(interaction, ctx, svc, pctx) {
    return playPlaylist(interaction, ctx, svc, pctx, { replace: false });
  },

  savequeue(interaction, ctx, svc, pctx) {
    const player = ctx.manager.get(interaction.guildId);
    const tracks = player ? [player.current, ...player.queue.upcoming].filter(Boolean) : [];
    if (!tracks.length) throw new UserError('The queue is empty — nothing to save.');
    const scope = interaction.options.getString('scope') ?? Scope.USER;
    const playlist = svc.create(interaction.options.getString('name', true), scope, pctx);
    const result = svc.addTracks(playlist, tracks, pctx);
    const notes = [];
    if (result.duplicates) notes.push(`${pluralize(result.duplicates, 'duplicate')} skipped`);
    if (result.overflow) notes.push(`${result.overflow} not saved (limit ${ctx.config.playlists.maxTracks})`);
    return interaction.reply({
      embeds: [
        successEmbed(
          `💾 Saved **${pluralize(result.added, 'track')}** to ${scopeLabel(playlist).toLowerCase()} playlist **${escapeMarkdown(playlist.name)}**.${notes.length ? `\n-# ${notes.join(' · ')}` : ''}`,
        ),
      ],
    });
  },
};

async function playPlaylist(interaction, ctx, svc, pctx, { replace }) {
  const playlist = svc.find(interaction.options.getString('name', true), pctx);
  const shuffle = interaction.options.getBoolean('shuffle') ?? false;
  const existing = ctx.manager.get(interaction.guildId);
  const voiceChannel = assertCanJoin(ctx.member, existing);
  // Replacing someone else's queue is a control action.
  if (replace && existing?.current) assertCanControl(ctx.member, ctx.settings);

  const tracks = svc.toQueueTracks(playlist, requesterOf(interaction));
  if (!tracks.length) throw new UserError(`Playlist **${escapeMarkdown(playlist.name)}** is empty.`);
  await interaction.deferReply();

  const { result } = await enqueueTracks(ctx, interaction, voiceChannel, tracks, { shuffle, replace });
  await interaction.editReply({
    embeds: [
      bulkAddedEmbed({
        title: playlist.name,
        added: result.added,
        duplicates: result.duplicates,
        overflow: result.overflow,
        started: result.started,
      }),
    ],
  });
}

export default {
  data,
  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    const handler = handlers[sub];
    if (!handler) throw new UserError('Unknown subcommand.');
    const svc = ctx.playlists;
    const pctx = { userId: interaction.user.id, guildId: interaction.guildId, isManager: isDj(ctx.member, ctx.settings) };
    await handler(interaction, ctx, svc, pctx);
  },

  async autocomplete(interaction, ctx) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'name') return interaction.respond([]);
    const pctx = { userId: interaction.user.id, guildId: interaction.guildId };
    const suggestions = ctx.playlists.suggest(String(focused.value ?? ''), pctx, { limit: 25 });
    return interaction.respond(
      suggestions.map((p) => ({
        name: truncate(`${p.ownerType === Scope.GUILD ? '🏠' : '👤'} ${p.name} · ${pluralize(p.trackCount ?? 0, 'track')}`, 100),
        value: PlaylistService.ref(p),
      })),
    );
  },
};
