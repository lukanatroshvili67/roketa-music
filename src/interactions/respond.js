import { MessageFlags } from 'discord.js';
import { errorEmbed } from '../ui/embeds.js';
import { UserError } from '../utils/errors.js';

/** Reply or edit depending on the interaction's state. */
export async function respond(interaction, payload) {
  const data = typeof payload === 'string' ? { content: payload } : payload;
  if (interaction.deferred || interaction.replied) {
    if (data.flags && (Number(data.flags) & MessageFlags.Ephemeral) && interaction.replied) return interaction.followUp(data);
    const { flags, ...rest } = data;
    return interaction.editReply(rest);
  }
  return interaction.reply(data);
}

export function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

/** Convert any error into a safe user-facing message. Internal errors are logged, not shown. */
export function userMessage(err) {
  if (err instanceof UserError) return err.message;
  if (err instanceof RangeError) return err.message; // queue position validation
  return 'Something went wrong while running that. The error has been logged.';
}

export async function respondError(interaction, err, logger) {
  if (!(err instanceof UserError) && !(err instanceof RangeError)) {
    logger.error({ err, command: interaction.commandName ?? interaction.customId, guildId: interaction.guildId }, 'Interaction failed');
  }
  if (!interaction.isRepliable()) return;
  try {
    await respond(interaction, ephemeral({ embeds: [errorEmbed(userMessage(err))] }));
  } catch (replyErr) {
    // Interaction expired (10062) or already acknowledged elsewhere — nothing more we can do.
    logger.debug({ err: replyErr.message }, 'Could not deliver error response');
  }
}
