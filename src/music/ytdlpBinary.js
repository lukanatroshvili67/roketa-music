import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT_DIR } from '../config/index.js';

const execFileAsync = promisify(execFile);
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';

/**
 * yt-dlp is managed as a standalone binary inside ./bin so that it can be kept up to date independently
 * of the system (YouTube changes frequently and outdated extractors are the #1 cause of playback failures).
 */
export function managedBinaryPath() {
  return path.join(ROOT_DIR, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

function releaseAsset() {
  const { platform, arch } = process;
  if (platform === 'win32') return arch === 'arm64' ? 'yt-dlp_arm64.exe' : arch === 'ia32' ? 'yt-dlp_x86.exe' : 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform === 'linux') return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : arch === 'arm' ? 'yt-dlp_linux_armv7l' : 'yt-dlp_linux';
  return 'yt-dlp'; // python zipapp; requires python3
}

export async function downloadYtDlp(target = managedBinaryPath(), logger) {
  const asset = releaseAsset();
  logger?.info({ asset, target }, 'Downloading yt-dlp');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const res = await fetch(RELEASE_BASE + asset, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Failed to download yt-dlp (${res.status} ${res.statusText})`);
  const tmp = `${target}.download`;
  await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await fsp.chmod(tmp, 0o755);
  await fsp.rename(tmp, target);
  return target;
}

export async function getVersion(binary) {
  const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 30_000, windowsHide: true });
  return stdout.trim();
}

/**
 * Resolve the binary to use. Priority: YTDLP_PATH → ./bin managed binary (downloaded on first run).
 * @returns {Promise<{ path: string, managed: boolean, version: string }>}
 */
export async function ensureYtDlp({ configuredPath, logger } = {}) {
  if (configuredPath) {
    const version = await getVersion(configuredPath);
    return { path: configuredPath, managed: false, version };
  }
  const target = managedBinaryPath();
  if (!fs.existsSync(target)) await downloadYtDlp(target, logger);
  const version = await getVersion(target);
  return { path: target, managed: true, version };
}

/** Self-update the managed standalone binary. Returns the (possibly new) version. */
export async function updateYtDlp(binary, logger) {
  try {
    const { stdout } = await execFileAsync(binary, ['-U'], { timeout: 120_000, windowsHide: true });
    const version = await getVersion(binary);
    logger?.info({ version, output: stdout.trim().split('\n').pop() }, 'yt-dlp update check complete');
    return version;
  } catch (err) {
    logger?.warn({ err: err.message }, 'yt-dlp self-update failed (continuing with current version)');
    return null;
  }
}
