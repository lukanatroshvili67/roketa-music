import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const COMMANDS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load every command module under src/commands/<category>/*.js.
 * @returns {Promise<Map<string, { data: import('discord.js').SlashCommandBuilder, execute: Function, autocomplete?: Function, voice?: 'join'|'same', dj?: boolean, category: string }>>}
 */
export async function loadCommands() {
  const commands = new Map();
  const categories = fs.readdirSync(COMMANDS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const dir of categories) {
    const files = fs.readdirSync(path.join(COMMANDS_DIR, dir.name)).filter((f) => f.endsWith('.js')).sort();
    for (const file of files) {
      const mod = await import(pathToFileURL(path.join(COMMANDS_DIR, dir.name, file)).href);
      const command = mod.default;
      if (!command?.data || typeof command.execute !== 'function') {
        throw new Error(`Command file ${dir.name}/${file} must default-export { data, execute }`);
      }
      const name = command.data.name;
      if (commands.has(name)) throw new Error(`Duplicate command name "${name}" (${dir.name}/${file})`);
      commands.set(name, { ...command, category: dir.name });
    }
  }
  return commands;
}
