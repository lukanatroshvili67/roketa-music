/**
 * Pure, synchronous queue model. Knows nothing about Discord or audio, which keeps it fully unit-testable.
 *
 * Layout:  history (oldest → newest)  |  current  |  upcoming (next → last)
 */
export const LoopMode = Object.freeze({ OFF: 'off', TRACK: 'track', QUEUE: 'queue' });
export const LOOP_MODES = Object.values(LoopMode);

export class Queue {
  constructor({ maxSize = 1000, historySize = 50, loopMode = LoopMode.OFF, allowDuplicates = true } = {}) {
    this.maxSize = maxSize;
    this.historySize = historySize;
    this.loopMode = loopMode;
    this.allowDuplicates = allowDuplicates;
    /** @type {import('../music/Track.js').Track[]} */
    this.upcoming = [];
    /** @type {import('../music/Track.js').Track | null} */
    this.current = null;
    /** @type {import('../music/Track.js').Track[]} */
    this.history = [];
  }

  get size() {
    return this.upcoming.length;
  }

  get isEmpty() {
    return !this.current && this.upcoming.length === 0;
  }

  get totalDuration() {
    return this.upcoming.reduce((sum, t) => sum + (t.duration ?? 0), 0);
  }

  hasVideo(videoId) {
    return this.current?.videoId === videoId || this.upcoming.some((t) => t.videoId === videoId);
  }

  /**
   * Add tracks, respecting the max size and the duplicate policy.
   * @returns {{ added: import('../music/Track.js').Track[], duplicates: number, overflow: number }}
   */
  add(tracks, { position = 'end' } = {}) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    const added = [];
    let duplicates = 0;
    let overflow = 0;
    const seen = new Set();
    for (const track of list) {
      if (!this.allowDuplicates && (this.hasVideo(track.videoId) || seen.has(track.videoId))) {
        duplicates++;
        continue;
      }
      if (this.upcoming.length + added.length >= this.maxSize) {
        overflow++;
        continue;
      }
      seen.add(track.videoId);
      added.push(track);
    }
    if (position === 'next') this.upcoming.unshift(...added);
    else this.upcoming.push(...added);
    return { added, duplicates, overflow };
  }

  pushHistory(track) {
    this.history.push(track);
    if (this.history.length > this.historySize) this.history.splice(0, this.history.length - this.historySize);
  }

  /**
   * Move to the next track.
   * @param {object} [opts]
   * @param {boolean} [opts.forced] a user skip: ignores "loop track".
   * @param {boolean} [opts.dropCurrent] the current track failed: never re-queue it (even in loop modes).
   * @returns the new current track, or null when the queue is exhausted.
   */
  next({ forced = false, dropCurrent = false } = {}) {
    const previous = this.current;
    if (previous && !dropCurrent && !forced && this.loopMode === LoopMode.TRACK) {
      return previous; // replay the same track
    }
    if (previous) {
      if (!dropCurrent) this.pushHistory(previous);
      if (this.loopMode === LoopMode.QUEUE && !dropCurrent) this.upcoming.push(previous);
    }
    this.current = this.upcoming.shift() ?? null;
    return this.current;
  }

  /** Go back to the previously played track. Returns it, or null if there is no history. */
  previous() {
    const prev = this.history.pop();
    if (!prev) return null;
    // In loop-queue mode the previous track was also re-appended to the end of the queue: undo that.
    if (this.loopMode === LoopMode.QUEUE && this.upcoming[this.upcoming.length - 1] === prev) this.upcoming.pop();
    if (this.current) this.upcoming.unshift(this.current);
    this.current = prev;
    return prev;
  }

  /** Skip directly to the given 1-based upcoming position. Tracks jumped over go to history. */
  jump(position) {
    this.assertPosition(position);
    const skipped = this.upcoming.splice(0, position - 1);
    const target = this.upcoming.shift();
    for (const t of [this.current, ...skipped]) {
      if (!t) continue;
      this.pushHistory(t);
      if (this.loopMode === LoopMode.QUEUE) this.upcoming.push(t);
    }
    this.current = target;
    return target;
  }

  /** Remove the upcoming track at a 1-based position. */
  remove(position) {
    this.assertPosition(position);
    return this.upcoming.splice(position - 1, 1)[0];
  }

  /** Remove an inclusive 1-based range. */
  removeRange(from, to) {
    this.assertPosition(from);
    this.assertPosition(to);
    if (to < from) [from, to] = [to, from];
    return this.upcoming.splice(from - 1, to - from + 1);
  }

  move(from, to) {
    this.assertPosition(from);
    this.assertPosition(to);
    const [track] = this.upcoming.splice(from - 1, 1);
    this.upcoming.splice(to - 1, 0, track);
    return track;
  }

  /** Fisher–Yates shuffle of the upcoming tracks (the current track is untouched). */
  shuffle(random = Math.random) {
    const arr = this.upcoming;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.length;
  }

  /** Remove duplicate videos from upcoming (keeps the first occurrence; the current track counts as seen). */
  dedupe() {
    const seen = new Set(this.current ? [this.current.videoId] : []);
    const before = this.upcoming.length;
    this.upcoming = this.upcoming.filter((t) => {
      if (seen.has(t.videoId)) return false;
      seen.add(t.videoId);
      return true;
    });
    return before - this.upcoming.length;
  }

  /** Clear upcoming tracks (keeps the current track playing). */
  clear() {
    const count = this.upcoming.length;
    this.upcoming = [];
    return count;
  }

  /** Remove everything including history and the current track. */
  reset() {
    this.upcoming = [];
    this.history = [];
    this.current = null;
  }

  setLoopMode(mode) {
    if (!LOOP_MODES.includes(mode)) throw new RangeError(`Invalid loop mode: ${mode}`);
    this.loopMode = mode;
    return mode;
  }

  cycleLoopMode() {
    const idx = LOOP_MODES.indexOf(this.loopMode);
    return this.setLoopMode(LOOP_MODES[(idx + 1) % LOOP_MODES.length]);
  }

  assertPosition(position) {
    if (!Number.isInteger(position) || position < 1 || position > this.upcoming.length) {
      throw new RangeError(
        this.upcoming.length === 0 ? 'The queue is empty.' : `Position must be between 1 and ${this.upcoming.length}.`,
      );
    }
  }
}
