import { randomUUID } from 'node:crypto';

/**
 * Description of a playable track. Stream URLs are *not* stored here because they expire;
 * they are resolved lazily right before playback (see YtDlp.getStreamInfo).
 */
export class Track {
  /**
   * @param {object} data
   * @param {string} data.videoId
   * @param {string} data.title
   * @param {string} [data.url]
   * @param {string} [data.author]
   * @param {number|null} [data.duration] seconds, null when live/unknown
   * @param {string} [data.thumbnail]
   * @param {boolean} [data.isLive]
   * @param {{id: string, tag: string}} [data.requestedBy]
   */
  constructor(data) {
    this.uid = randomUUID();
    this.videoId = data.videoId;
    this.url = data.url ?? `https://www.youtube.com/watch?v=${data.videoId}`;
    this.title = data.title || 'Unknown title';
    this.author = data.author || 'Unknown';
    this.duration = Number.isFinite(data.duration) && data.duration > 0 ? Math.round(data.duration) : null;
    this.thumbnail = data.thumbnail ?? `https://i.ytimg.com/vi/${data.videoId}/hqdefault.jpg`;
    this.isLive = Boolean(data.isLive);
    this.requestedBy = data.requestedBy ?? { id: '0', tag: 'Unknown' };
  }

  /** A copy with a new uid (and optionally a new requester). */
  clone(overrides = {}) {
    return new Track({ ...this.toJSON(), ...overrides });
  }

  toJSON() {
    return {
      videoId: this.videoId,
      url: this.url,
      title: this.title,
      author: this.author,
      duration: this.duration,
      thumbnail: this.thumbnail,
      isLive: this.isLive,
      requestedBy: this.requestedBy,
    };
  }
}
