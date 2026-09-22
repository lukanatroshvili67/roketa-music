/**
 * Register slash commands with Discord.
 *
 *   npm run deploy            → to DEV_GUILD_ID if set (instant), otherwise globally
 *   npm run deploy:global     → globally (can take a few minutes to appear)
 *   node scripts/deploy-commands.js --clear [--global]  → remove all commands
 */
import { REST, Routes } from 'discord.js';
import { assertDiscordConfig, config } from '../src/config/index.js';
import { loadCommands } from '../src/commands/index.js';

const args = new Set(process.argv.slice(2));
const global = args.has('--global') || !config.discord.devGuildId;
const clear = args.has('--clear');

assertDiscordConfig({ requireClientId: true });
const commands = await loadCommands();
const body = clear ? [] : [...commands.values()].map((c) => c.data.toJSON());
const rest = new REST().setToken(config.discord.token);
const route = global
  ? Routes.applicationCommands(config.discord.clientId)
  : Routes.applicationGuildCommands(config.discord.clientId, config.discord.devGuildId);

try {
  const result = await rest.put(route, { body });
  console.log(
    `${clear ? 'Cleared' : 'Registered'} ${result.length} command(s) ${global ? 'globally' : `in guild ${config.discord.devGuildId}`}.`,
  );
  if (!clear) console.log(result.map((c) => `/${c.name}`).join(' '));
} catch (err) {
  console.error('Failed to deploy commands:', err.message);
  process.exitCode = 1;
}
