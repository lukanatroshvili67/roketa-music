import { EmbedBuilder, InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { Colors } from '../../ui/embeds.js';

const SECTIONS = [
  [
    '🎵 Playback',
    [
      '`/play <url|search>` — play a video, playlist or search result',
      '`/playnext <url|search>` — add to the front of the queue',
      '`/search <query>` — pick from search results',
      '`/pause` · `/resume` · `/skip [to]` · `/previous` · `/replay`',
      '`/seek <time>` — e.g. `1:30`',
      '`/volume [level]` · `/loop [mode]`',
      '`/nowplaying` (`/np`) · `/stop` (`/leave`)',
    ],
  ],
  [
    '📜 Queue',
    ['`/queue [page]` · `/shuffle` · `/clear` · `/dedupe`', '`/remove <position> [to]` · `/move <from> <to>`'],
  ],
  [
    '📚 Playlists',
    [
      '`/playlist create|delete|rename|list|view`',
      '`/playlist add <name> [query]` — adds the current song when no query is given',
      '`/playlist remove <name> <position>`',
      '`/playlist play <name>` — replace the queue · `/playlist load <name>` — append',
      '`/playlist savequeue <name>` — save the current queue',
      'Personal playlists work in every server; server playlists are shared with everyone here.',
    ],
  ],
  ['⚙️ Admin', ['`/settings view|djrole|volume|loop|duplicates|announce` (Manage Server)']],
];

export default {
  data: new SlashCommandBuilder().setName('help').setDescription('Show all music commands').setContexts(InteractionContextType.Guild),
  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor(Colors.primary)
      .setTitle('🎶 Music bot help')
      .setDescription('Join a voice channel and use `/play` to get started. The Now Playing message has buttons for quick control.')
      .addFields(SECTIONS.map(([name, lines]) => ({ name, value: lines.join('\n') })));
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
