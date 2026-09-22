/** Offline validation: loads every command and serialises it exactly as it would be sent to Discord. */
import { loadCommands } from '../src/commands/index.js';

const commands = await loadCommands();
let options = 0;
for (const [name, cmd] of commands) {
  const json = cmd.data.toJSON();
  options += json.options?.length ?? 0;
  if (json.name !== name) throw new Error(`Name mismatch for ${name}`);
}
console.log(`OK: ${commands.size} commands valid (${options} top-level options/subcommands)`);
console.log([...commands.keys()].map((n) => `/${n}`).join(' '));
