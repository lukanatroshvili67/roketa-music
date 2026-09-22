import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { escapeMarkdown, formatDuration, pluralize, progressBar, trackLink, truncate } from '../utils/format.js';
import { LoopMode } from '../queue/Queue.js';

export const Colors = Object.freeze({
  primary: 0x5865f2,
  success: 0x57f287,
  warning: 0xfee75c,
  error: 0xed4245,
  neutral: 0x2b2d31,
});

const LOOP_LABEL = { [LoopMode.OFF]: 'Off', [LoopMode.TRACK]: '🔂 Track', [LoopMode.QUEUE]: '🔁 Queue' };
export const loopLabel = (mode) => LOOP_LABEL[mode] ?? mode;

export const successEmbed = (text) => new EmbedBuilder().setColor(Colors.success).setDescription(text);
export const errorEmbed = (text) => new EmbedBuilder().setColor(Colors.error).setDescription(`❌ ${text}`);
export const infoEmbed = (text) => new EmbedBuilder().setColor(Colors.primary).setDescription(text);
export const warnEmbed = (text) => new EmbedBuilder().setColor(Colors.warning).setDescription(`⚠️ ${text}`);

function statusLine(player) {
  if (player.autoPaused) return '⏸️ Paused (channel empty)';
  if (player.isPaused) return '⏸️ Paused';
  if (player.isPlaying) return '▶️ Playing';
  return '⏹️ Idle';
}

/** The rich "Now Playing" card. */
export function nowPlayingEmbed(player) {
  const track = player.current;
  if (!track) return infoEmbed('Nothing is playing right now.');
  const position = player.position;
  const next = player.queue.upcoming[0];
  const embed = new EmbedBuilder()
    .setColor(Colors.primary)
    .setAuthor({ name: 'Now Playing' })
    .setTitle(truncate(track.title, 256))
    .setURL(track.url)
    .setThumbnail(track.thumbnail)
    .setDescription(
      track.isLive
        ? '🔴 **LIVE**'
        : `${progressBar(position, track.duration)}\n\`${formatDuration(position)} / ${formatDuration(track.duration)}\``,
    )
    .addFields(
      { name: 'Channel', value: escapeMarkdown(truncate(track.author, 100)), inline: true },
      { name: 'Requested by', value: `<@${track.requestedBy.id}>`, inline: true },
      { name: 'Status', value: statusLine(player), inline: true },
      { name: 'Volume', value: `${player.volume}%`, inline: true },
      { name: 'Loop', value: loopLabel(player.queue.loopMode), inline: true },
      {
        name: 'Queue',
        value: player.queue.size ? `${pluralize(player.queue.size, 'track')} · ${formatDuration(player.queue.totalDuration)}` : 'Empty',
        inline: true,
      },
    );
  if (next) embed.addFields({ name: 'Up next', value: trackLink(next, 70) });
  return embed;
}

/** Player control buttons. Two rows keep them usable on mobile. */
export function playerButtons(player, { disabled = false } = {}) {
  const paused = player?.isPaused ?? false;
  const loop = player?.queue.loopMode ?? LoopMode.OFF;
  const btn = (id, emoji, style = ButtonStyle.Secondary, label) => {
    const b = new ButtonBuilder().setCustomId(`player:${id}`).setEmoji(emoji).setStyle(style).setDisabled(disabled);
    if (label) b.setLabel(label);
    return b;
  };
  return [
    new ActionRowBuilder().addComponents(
      btn('previous', '⏮️'),
      btn('toggle', paused ? '▶️' : '⏸️', paused ? ButtonStyle.Success : ButtonStyle.Primary),
      btn('skip', '⏭️'),
      btn('stop', '⏹️', ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      btn('shuffle', '🔀'),
      btn('loop', loop === LoopMode.TRACK ? '🔂' : '🔁', loop === LoopMode.OFF ? ButtonStyle.Secondary : ButtonStyle.Success),
      btn('queue', '📜', ButtonStyle.Secondary, 'Queue'),
    ),
  ];
}

export const QUEUE_PAGE_SIZE = 10;

export function queueView(player, page = 1) {
  const q = player.queue;
  const pages = Math.max(1, Math.ceil(q.size / QUEUE_PAGE_SIZE));
  const p = Math.min(Math.max(1, page), pages);
  const start = (p - 1) * QUEUE_PAGE_SIZE;
  const lines = q.upcoming
    .slice(start, start + QUEUE_PAGE_SIZE)
    .map((t, i) => `\`${start + i + 1}.\` ${trackLink(t, 60)} · \`${formatDuration(t.duration)}\` · <@${t.requestedBy.id}>`);

  const current = q.current
    ? `**Now playing:** ${trackLink(q.current, 70)} · \`${formatDuration(player.position)} / ${formatDuration(q.current.duration)}\``
    : '**Now playing:** nothing';
  const embed = new EmbedBuilder()
    .setColor(Colors.primary)
    .setTitle('🎶 Queue')
    .setDescription(`${current}\n\n${lines.length ? lines.join('\n') : '*No upcoming tracks. Use `/play` to add some!*'}`)
    .setFooter({
      text: `Page ${p}/${pages} · ${pluralize(q.size, 'track')} · ${formatDuration(q.totalDuration)} · Loop: ${loopLabel(q.loopMode).replace(/^\S+ /, '')} · Volume: ${player.volume}%`,
    });

  const components =
    pages > 1
      ? [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`queue:${p - 1}`).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(p <= 1),
            new ButtonBuilder().setCustomId(`queue:noop:${p}`).setLabel(`${p} / ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
            new ButtonBuilder().setCustomId(`queue:${p + 1}`).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(p >= pages),
          ),
        ]
      : [];
  return { embeds: [embed], components };
}

export function trackAddedEmbed(track, { position, started }) {
  return new EmbedBuilder()
    .setColor(Colors.success)
    .setAuthor({ name: started ? 'Now playing' : 'Added to queue' })
    .setDescription(`${trackLink(track, 100)}`)
    .setThumbnail(track.thumbnail)
    .addFields(
      { name: 'Duration', value: formatDuration(track.duration), inline: true },
      { name: 'Position', value: started ? 'Now' : `#${position}`, inline: true },
      { name: 'Requested by', value: `<@${track.requestedBy.id}>`, inline: true },
    );
}

export function bulkAddedEmbed({ title, url, added, duplicates = 0, overflow = 0, unavailable = 0, truncated = false, started }) {
  const notes = [];
  if (duplicates) notes.push(`${pluralize(duplicates, 'duplicate')} skipped`);
  if (unavailable) notes.push(`${pluralize(unavailable, 'unavailable video')} skipped`);
  if (overflow) notes.push(`${overflow} not added (queue limit reached)`);
  if (truncated) notes.push('playlist was truncated to the import limit');
  const duration = added.reduce((s, t) => s + (t.duration ?? 0), 0);
  const name = url ? `[${escapeMarkdown(truncate(title, 80))}](${url})` : `**${escapeMarkdown(truncate(title, 80))}**`;
  return new EmbedBuilder()
    .setColor(added.length ? Colors.success : Colors.warning)
    .setAuthor({ name: started ? 'Playing playlist' : 'Playlist queued' })
    .setDescription(
      `${name}\nAdded **${pluralize(added.length, 'track')}** (${formatDuration(duration)})${notes.length ? `\n-# ${notes.join(' · ')}` : ''}`,
    )
    .setThumbnail(added[0]?.thumbnail ?? null);
}
