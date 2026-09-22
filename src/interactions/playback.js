import { ChannelType } from 'discord.js';
import { Track } from '../music/Track.js';
import { formatDuration } from '../utils/format.js';
import { UserError } from '../utils/errors.js';

export function requesterOf(interaction) {
  return { id: interaction.user.id, tag: interaction.user.username };
}

/** Fisher–Yates copy. */
export function shuffled(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Drop tracks that exceed MAX_TRACK_DURATION_SECONDS. */
export function filterByDuration(tracks, maxSeconds) {
  if (!maxSeconds) return { tracks, tooLong: 0 };
  const ok = tracks.filter((t) => t.isLive || !t.duration || t.duration <= maxSeconds);
  return { tracks: ok, tooLong: tracks.length - ok.length };
}

/** Join the member's voice channel (handling stage channels) without leaking a half-created player. */
export async function connectPlayer(player, voiceChannel, logger) {
  try {
    await player.connect(voiceChannel);
  } catch (err) {
    if (!player.current) player.destroy('connect-failed');
    throw err;
  }
  if (voiceChannel.type === ChannelType.GuildStageVoice) {
    const me = voiceChannel.guild.members.me;
    await me.voice.setSuppressed(false).catch(async () => {
      await me.voice.setRequestToSpeak(true).catch(() => {});
      logger?.debug('Requested to speak on stage channel');
    });
  }
}

/**
 * Shared "put these tracks in the queue and make sure music is playing" flow.
 * @returns {Promise<{ player, result, tracks, tooLong }>}
 */
export async function enqueueTracks(ctx, interaction, voiceChannel, trackData, { position = 'end', shuffle = false, seek = 0, replace = false } = {}) {
  const requestedBy = requesterOf(interaction);
  let tracks = trackData.map((d) => (d instanceof Track ? d : new Track({ ...d, requestedBy })));
  const filtered = filterByDuration(tracks, ctx.config.player.maxTrackDuration);
  tracks = filtered.tracks;
  if (!tracks.length) {
    throw new UserError(
      filtered.tooLong
        ? `That track is longer than the allowed maximum (${formatDuration(ctx.config.player.maxTrackDuration)}).`
        : 'Nothing to add.',
    );
  }
  if (shuffle) tracks = shuffled(tracks);

  const player = ctx.manager.getOrCreate(interaction.guildId);
  player.textChannelId = interaction.channelId;
  await connectPlayer(player, voiceChannel, ctx.logger);
  const result = replace ? await player.replace(tracks) : await player.enqueue(tracks, { position, seek });
  if (!result.added.length && result.duplicates) {
    throw new UserError(
      tracks.length === 1 ? 'That track is already in the queue (duplicates are disabled on this server).' : 'All of those tracks are already in the queue.',
    );
  }
  if (!result.added.length && result.overflow) throw new UserError(`The queue is full (max ${ctx.config.player.maxQueueSize} tracks).`);
  return { player, result, tracks, tooLong: filtered.tooLong };
}
