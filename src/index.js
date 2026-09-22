import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, GatewayIntentBits, Options, Partials, RESTEvents } from 'discord.js';
import { assertDiscordConfig, config } from './config/index.js';
import { logger } from './utils/logger.js';
import { createStore } from './database/index.js';
import { GuildSettingsService } from './settings/GuildSettingsService.js';
import { PlaylistService } from './playlists/PlaylistService.js';
import { ensureYtDlp, updateYtDlp } from './music/ytdlpBinary.js';
import { YtDlp } from './music/YtDlp.js';
import { StreamFactory } from './music/StreamFactory.js';
import { PlayerManager } from './music/PlayerManager.js';
import { attachNowPlaying } from './ui/NowPlayingController.js';
import { loadCommands } from './commands/index.js';
import { Cooldown, RateLimiter } from './utils/rateLimiter.js';

const execFileAsync = promisify(execFile);
const EVENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'events');

async function checkFfmpeg() {
  try {
    const { stdout } = await execFileAsync(config.ffmpegPath, ['-version'], { timeout: 15_000, windowsHide: true });
    return stdout.split('\n')[0].trim();
  } catch (err) {
    throw new Error(`FFmpeg was not found at "${config.ffmpegPath}". Install FFmpeg or set FFMPEG_PATH. (${err.message})`);
  }
}

async function registerEvents(client, app) {
  for (const file of fs.readdirSync(EVENTS_DIR).filter((f) => f.endsWith('.js'))) {
    const { default: event } = await import(pathToFileURL(path.join(EVENTS_DIR, file)).href);
    const handler = async (...args) => {
      try {
        await event.execute(...args, app);
      } catch (err) {
        logger.error({ err, event: event.name }, 'Event handler failed');
      }
    };
    if (event.once) client.once(event.name, handler);
    else client.on(event.name, handler);
  }
}

async function main() {
  assertDiscordConfig();
  logger.info({ env: config.env, node: process.version }, 'Starting Roketa Music');

  const ffmpegVersion = await checkFfmpeg();
  logger.info({ ffmpeg: ffmpegVersion }, 'FFmpeg found');

  const binary = await ensureYtDlp({ configuredPath: config.ytdlp.path, logger });
  logger.info({ path: binary.path, version: binary.version, managed: binary.managed }, 'yt-dlp ready');
  let updateTimer = null;
  if (binary.managed && config.ytdlp.autoUpdate) {
    await updateYtDlp(binary.path, logger);
    updateTimer = setInterval(() => updateYtDlp(binary.path, logger), config.ytdlp.updateIntervalHours * 3600_000);
    updateTimer.unref();
  }

  const store = createStore(config.database);
  logger.info({ driver: config.database.driver, path: config.database.path }, 'Database ready');
  const settingsService = new GuildSettingsService({ store, defaults: config.player });
  const playlists = new PlaylistService({ store, limits: config.playlists });

  const ytdlp = new YtDlp({
    binaryPath: binary.path,
    cookiesPath: config.ytdlp.cookiesPath,
    extraArgs: config.ytdlp.extraArgs,
    timeoutMs: config.ytdlp.timeoutMs,
    maxConcurrency: config.ytdlp.maxConcurrency,
    logger: logger.child({ module: 'ytdlp' }),
  });
  const streamFactory = new StreamFactory({ ytdlp, ffmpegPath: config.ffmpegPath, logger: logger.child({ module: 'stream' }) });
  const manager = new PlayerManager({
    streamFactory,
    prefetcher: ytdlp,
    getSettings: (guildId) => settingsService.get(guildId),
    options: config.player,
    logger: logger.child({ module: 'player' }),
  });

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    partials: [Partials.Channel],
    // Keep memory flat: this bot never needs message history or presence data.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      PresenceManager: 0,
      ReactionManager: 0,
      GuildEmojiManager: 0,
      GuildStickerManager: 0,
    }),
    sweepers: { ...Options.DefaultSweeperSettings },
  });

  client.rest.on(RESTEvents.RateLimited, (info) =>
    logger.warn({ route: info.route, retryAfter: info.retryAfter, global: info.global }, 'Hit a Discord rate limit'),
  );
  client.on('error', (err) => logger.error({ err }, 'Discord client error'));
  client.on('warn', (msg) => logger.warn(msg));
  client.on('shardDisconnect', (event, id) => logger.warn({ shard: id, code: event.code }, 'Gateway disconnected'));
  client.on('shardReconnecting', (id) => logger.info({ shard: id }, 'Gateway reconnecting'));
  client.on('shardResume', (id, replayed) => logger.info({ shard: id, replayed }, 'Gateway resumed'));

  const app = {
    client,
    config,
    logger,
    store,
    settingsService,
    playlists,
    ytdlp,
    manager,
    commands: await loadCommands(),
    rateLimiter: new RateLimiter({ limit: config.rateLimit.commandsPerWindow, windowMs: config.rateLimit.windowMs }),
    buttonCooldown: new Cooldown(config.rateLimit.buttonCooldownMs),
  };

  attachNowPlaying({ manager, client, settings: settingsService, logger: logger.child({ module: 'ui' }), updateInterval: config.player.nowPlayingUpdateInterval });
  manager.startSweeper();
  await registerEvents(client, app);

  // ---------------------------------------------------------------- graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(code || 1), 10_000);
    force.unref();
    try {
      clearInterval(updateTimer);
      manager.stopSweeper();
      manager.destroyAll('shutdown');
      ytdlp.killAll();
      app.rateLimiter.destroy();
      await client.destroy();
      store.close();
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    }
    logger.flush?.();
    setTimeout(() => process.exit(code), 200);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — shutting down');
    shutdown('uncaughtException', 1);
  });

  // Periodic health log (helps spotting leaks in long-running deployments).
  setInterval(() => {
    const mem = process.memoryUsage();
    logger.info({ ...manager.stats(), rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576) }, 'Health');
  }, 15 * 60_000).unref();

  await client.login(config.discord.token);
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  setTimeout(() => process.exit(1), 200);
});
