import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config({ quiet: true });

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function str(name, fallback = undefined) {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  return value.trim();
}

function int(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = str(name);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Environment variable ${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function bool(name, fallback) {
  const raw = str(name);
  if (raw === undefined) return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`Environment variable ${name} must be a boolean (got "${raw}")`);
}

function oneOf(name, fallback, allowed) {
  const raw = str(name, fallback);
  if (!allowed.includes(raw)) {
    throw new Error(`Environment variable ${name} must be one of ${allowed.join(', ')} (got "${raw}")`);
  }
  return raw;
}

function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.resolve(ROOT_DIR, p);
}

/**
 * Central, validated configuration. Everything configurable lives here; nothing else reads process.env.
 */
export const config = Object.freeze({
  env: str('NODE_ENV', 'development'),
  logLevel: str('LOG_LEVEL', 'info'),
  logPretty: bool('LOG_PRETTY', str('NODE_ENV', 'development') !== 'production'),

  discord: Object.freeze({
    token: str('DISCORD_TOKEN'),
    clientId: str('DISCORD_CLIENT_ID'),
    devGuildId: str('DEV_GUILD_ID'),
  }),

  database: Object.freeze({
    driver: oneOf('DATABASE_DRIVER', 'sqlite', ['sqlite']),
    path: resolvePath(str('DATABASE_PATH', 'data/roketa.db')),
  }),

  player: Object.freeze({
    defaultVolume: int('DEFAULT_VOLUME', 80, { min: 0, max: 200 }),
    maxVolume: int('MAX_VOLUME', 200, { min: 1, max: 200 }),
    maxQueueSize: int('MAX_QUEUE_SIZE', 1000, { min: 1, max: 20000 }),
    maxPlaylistImport: int('MAX_PLAYLIST_IMPORT', 500, { min: 1, max: 5000 }),
    maxTrackDuration: int('MAX_TRACK_DURATION_SECONDS', 0, { min: 0 }), // 0 = unlimited
    historySize: int('HISTORY_SIZE', 50, { min: 1, max: 500 }),
    queueEndTimeout: int('QUEUE_END_TIMEOUT_SECONDS', 180, { min: 0 }) * 1000,
    emptyChannelTimeout: int('EMPTY_CHANNEL_TIMEOUT_SECONDS', 120, { min: 0 }) * 1000,
    idlePlayerTimeout: int('IDLE_PLAYER_TIMEOUT_SECONDS', 600, { min: 30 }) * 1000,
    maxConsecutiveFailures: int('MAX_CONSECUTIVE_FAILURES', 5, { min: 1, max: 50 }),
    nowPlayingUpdateInterval: int('NOW_PLAYING_UPDATE_SECONDS', 30, { min: 0 }) * 1000,
  }),

  ytdlp: Object.freeze({
    path: str('YTDLP_PATH') ? resolvePath(str('YTDLP_PATH')) : undefined,
    autoUpdate: bool('YTDLP_AUTO_UPDATE', true),
    updateIntervalHours: int('YTDLP_UPDATE_INTERVAL_HOURS', 24, { min: 1 }),
    cookiesPath: str('YTDLP_COOKIES') ? resolvePath(str('YTDLP_COOKIES')) : undefined,
    maxConcurrency: int('YTDLP_MAX_CONCURRENCY', 3, { min: 1, max: 16 }),
    timeoutMs: int('YTDLP_TIMEOUT_SECONDS', 45, { min: 5 }) * 1000,
    extraArgs: (str('YTDLP_EXTRA_ARGS', '') ?? '').split(/\s+/).filter(Boolean),
  }),

  ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),

  playlists: Object.freeze({
    maxPerOwner: int('MAX_PLAYLISTS_PER_OWNER', 25, { min: 1 }),
    maxTracks: int('MAX_PLAYLIST_TRACKS', 500, { min: 1 }),
  }),

  rateLimit: Object.freeze({
    commandsPerWindow: int('COMMAND_RATE_LIMIT', 5, { min: 1 }),
    windowMs: int('COMMAND_RATE_WINDOW_SECONDS', 10, { min: 1 }) * 1000,
    buttonCooldownMs: int('BUTTON_COOLDOWN_MS', 1000, { min: 0 }),
  }),
});

export function assertDiscordConfig({ requireClientId = false } = {}) {
  const missing = [];
  if (!config.discord.token) missing.push('DISCORD_TOKEN');
  if (requireClientId && !config.discord.clientId) missing.push('DISCORD_CLIENT_ID');
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}. Copy .env.example to .env and fill it in.`);
  }
}
