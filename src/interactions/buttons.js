import { MessageFlags } from 'discord.js';
import { loopLabel, nowPlayingEmbed, playerButtons, queueView, successEmbed, warnEmbed } from '../ui/embeds.js';
import { assertCanControl, assertSameChannel } from './guards.js';
import { UserError } from '../utils/errors.js';
import { trackLink } from '../utils/format.js';

/** Buttons that modify playback for everyone require control permission (DJ role when configured). */
const CONTROL_ACTIONS = new Set(['previous', 'stop', 'shuffle', 'loop']);

/**
 * Handles `player:<action>` and `queue:<page>` buttons. Buttons are stateless: they always act on the
 * guild's *current* player, so old messages can't control stale state.
 */
export async function handleButton(interaction, app) {
  const [scope, action] = interaction.customId.split(':');
  if (scope !== 'player' && scope !== 'queue') return;
  if (!interaction.inCachedGuild()) return;

  const wait = app.buttonCooldown.check(interaction.user.id);
  if (wait > 0) {
    await interaction.reply({ embeds: [warnEmbed('Slow down a little!')], flags: MessageFlags.Ephemeral });
    return;
  }

  const player = app.manager.get(interaction.guildId);

  if (scope === 'queue') {
    if (action === 'noop') return interaction.deferUpdate();
    if (!player || player.queue.isEmpty) throw new UserError('The queue is empty.');
    return interaction.update(queueView(player, Number(action) || 1));
  }

  if (!player?.current) {
    // Stale Now Playing message — strip its buttons.
    await interaction.update({ components: [] }).catch(() => {});
    return;
  }

  const member = interaction.member;
  const settings = app.settingsService.get(interaction.guildId);
  assertSameChannel(member, player);
  if (CONTROL_ACTIONS.has(action)) assertCanControl(member, settings);

  const refresh = () => interaction.update({ embeds: [nowPlayingEmbed(player)], components: playerButtons(player) });
  const note = (text) => interaction.followUp({ embeds: [successEmbed(text)], flags: MessageFlags.Ephemeral }).catch(() => {});

  switch (action) {
    case 'toggle':
      await player.togglePause();
      return refresh();
    case 'skip': {
      if (player.current.requestedBy.id !== interaction.user.id) assertCanControl(member, settings);
      await interaction.deferUpdate();
      const { skipped } = await player.skip();
      return interaction.channel
        ?.send({ embeds: [successEmbed(`⏭️ ${interaction.user} skipped ${trackLink(skipped)}`)] })
        .catch(() => {});
    }
    case 'previous': {
      await interaction.deferUpdate();
      await player.previous();
      return;
    }
    case 'stop':
      await interaction.update({ components: [] });
      app.manager.destroy(interaction.guildId, 'stop');
      return interaction.channel?.send({ embeds: [successEmbed(`⏹️ ${interaction.user} stopped the music.`)] }).catch(() => {});
    case 'shuffle': {
      const count = player.shuffle();
      await refresh();
      return note(`🔀 Shuffled ${count} tracks.`);
    }
    case 'loop': {
      const mode = player.setLoop();
      await refresh();
      return note(`Loop mode: **${loopLabel(mode)}**`);
    }
    case 'queue':
      return interaction.reply({ ...queueView(player, 1), flags: MessageFlags.Ephemeral });
    default:
      return interaction.deferUpdate();
  }
}
