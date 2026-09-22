/** Formatting and parsing helpers (pure functions, unit tested). */

export function formatDuration(totalSeconds) {
  if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return 'LIVE';
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Parse "90", "1:30", "01:02:03", "1m30s", "2h", "45s" into seconds. Returns null when invalid.
 */
export function parseTimestamp(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim().toLowerCase();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.floor(Number(text));
  if (/^\d+(:\d{1,2}){1,2}$/.test(text)) {
    const parts = text.split(':').map(Number);
    if (parts.slice(1).some((p) => p >= 60)) return null;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }
  const match = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/.exec(text);
  if (match && (match[1] || match[2] || match[3])) {
    return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
  }
  return null;
}

export function progressBar(current, total, size = 16) {
  if (!Number.isFinite(total) || total <= 0) return '🔴 LIVE';
  const ratio = Math.min(1, Math.max(0, current / total));
  const pos = Math.min(size - 1, Math.round(ratio * (size - 1)));
  return `${'▬'.repeat(pos)}🔘${'▬'.repeat(size - 1 - pos)}`;
}

export function truncate(text, max) {
  const str = String(text ?? '');
  return str.length > max ? `${str.slice(0, Math.max(0, max - 1))}…` : str;
}

/** Escape Discord markdown so video titles can't break formatting. */
export function escapeMarkdown(text) {
  return String(text ?? '').replace(/([\\*_~`|>[\]()])/g, '\\$1');
}

export function trackLink(track, max = 80) {
  return `[${escapeMarkdown(truncate(track.title, max))}](${track.url})`;
}

export function pluralize(count, word, plural = `${word}s`) {
  return `${count} ${count === 1 ? word : plural}`;
}
