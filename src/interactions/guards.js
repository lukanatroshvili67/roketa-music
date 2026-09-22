import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { UserError } from '../utils/errors.js';

/** Members with Manage Server / Administrator, or the configured DJ role. */
export function isDj(member, settings) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  return Boolean(settings.djRoleId && member.roles?.cache?.has(settings.djRoleId));
}

function humansIn(channel) {
  return channel?.members?.filter((m) => !m.user.bot) ?? new Map();
}

/**
 * Whether a member may use "control" commands (skip others' songs, stop, clear, volume...).
 * Without a DJ role configured everyone in the bot's channel can control playback.
 * With one, DJs/managers can — and so can anyone who is alone with the bot.
 */
export function canControl(member, settings) {
  if (!settings.djRoleId) return true;
  if (isDj(member, settings)) return true;
  const channel = member.voice?.channel;
  const humans = humansIn(channel);
  return humans.size === 1 && humans.has(member.id);
}

export function assertCanControl(member, settings) {
  if (!canControl(member, settings)) {
    throw new UserError(`You need the <@&${settings.djRoleId}> role (or be alone with me) to do that.`);
  }
}

/**
 * Validate that the member can make the bot play in their voice channel.
 * @returns {import('discord.js').VoiceBasedChannel}
 */
export function assertCanJoin(member, player) {
  const channel = member.voice?.channel;
  if (!channel) throw new UserError('You need to join a voice channel first.');
  const me = member.guild.members.me;
  const botChannelId = player?.voiceChannelId ?? me?.voice?.channelId;
  if (botChannelId && botChannelId !== channel.id) {
    const botChannel = member.guild.channels.cache.get(botChannelId);
    // Allow "stealing" the bot only when nobody is listening in its current channel.
    if (humansIn(botChannel).size > 0 && player?.current) {
      throw new UserError(`I'm already playing in <#${botChannelId}>. Join that channel to control the music.`);
    }
  }
  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.Connect)) {
    throw new UserError(`I don't have permission to join <#${channel.id}>.`);
  }
  if (channel.type !== ChannelType.GuildStageVoice && !perms.has(PermissionFlagsBits.Speak)) {
    throw new UserError(`I don't have permission to speak in <#${channel.id}>.`);
  }
  if (channel.full && !perms.has(PermissionFlagsBits.MoveMembers) && channel.id !== botChannelId) {
    throw new UserError(`<#${channel.id}> is full.`);
  }
  return channel;
}

/** The member must be in the same voice channel as an active player. */
export function assertSameChannel(member, player) {
  if (!player || !player.voiceChannelId) throw new UserError('I am not playing anything right now.');
  const channelId = member.voice?.channelId;
  if (!channelId) throw new UserError('You need to join my voice channel first.');
  if (channelId !== player.voiceChannelId) {
    throw new UserError(`You need to be in <#${player.voiceChannelId}> to control the music.`);
  }
}
