import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { infoEmbed, successEmbed } from '../../ui/embeds.js';
import { assertCanControl, assertSameChannel } from '../../interactions/guards.js';
import { UserError } from '../../utils/errors.js';
import { config } from '../../config/index.js';

export default {
  data: new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Show or change the playback volume')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((o) =>
      o.setName('level').setDescription(`Volume (0-${config.player.maxVolume})`).setMinValue(0).setMaxValue(config.player.maxVolume),
    ),
  async execute(interaction, ctx) {
    const player = ctx.manager.get(interaction.guildId);
    if (!player) throw new UserError('I am not playing anything right now.');
    const level = interaction.options.getInteger('level');
    if (level === null) {
      await interaction.reply({ embeds: [infoEmbed(`🔊 Volume is **${player.volume}%**.`)] });
      return;
    }
    assertSameChannel(ctx.member, player);
    assertCanControl(ctx.member, ctx.settings);
    const v = player.setVolume(level);
    await interaction.reply({ embeds: [successEmbed(`${v === 0 ? '🔇' : v < 50 ? '🔉' : '🔊'} Volume set to **${v}%**.`)] });
  },
};
