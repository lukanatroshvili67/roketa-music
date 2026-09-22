import { EventEmitter } from 'node:events';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { Queue } from '../queue/Queue.js';
import { Mutex, sleep } from '../utils/concurrency.js';
import { TrackError, UserError } from '../utils/errors.js';

const MAX_RESUME_ATTEMPTS = 2;

/**
 * Per-guild music player. Owns the queue, the audio player, the voice connection and all playback state.
 * It knows nothing about text channels or embeds: the UI layer listens to the events below.
 *
 * Events:
 *  - trackStart (track)                      a new track started (not emitted for seeks/resumes)
 *  - trackError (track, error)               a track failed and was skipped
 *  - queueEnd ()                             nothing left to play
 *  - stateChange ()                          pause/resume/loop/volume/queue changes (refresh UI)
 *  - destroyed (reason)                      the player was torn down; do not use it anymore
 */
export class GuildPlayer extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.guildId
   * @param {import('./StreamFactory.js').StreamFactory} opts.streamFactory
   * @param {{ prefetch?: (videoId: string) => void }} [opts.prefetcher]
   * @param {object} opts.settings resolved guild settings
   * @param {object} opts.options player config (timeouts, limits)
   * @param {import('pino').Logger} opts.logger
   */
  constructor({ guildId, streamFactory, prefetcher, settings, options, logger, noSubscriberBehavior = NoSubscriberBehavior.Pause }) {
    super();
    this.guildId = guildId;
    this.streamFactory = streamFactory;
    this.prefetcher = prefetcher;
    this.options = options;
    this.logger = logger.child({ guildId });
    this.queue = new Queue({
      maxSize: options.maxQueueSize,
      historySize: options.historySize,
      loopMode: settings.defaultLoop,
      allowDuplicates: settings.allowDuplicates,
    });
    this.volume = settings.defaultVolume;
    this.textChannelId = null;
    /** @type {import('@discordjs/voice').VoiceConnection | null} */
    this.connection = null;
    this.mutex = new Mutex();
    this.token = 0;
    this.currentResource = null;
    this.consecutiveFailures = 0;
    this.lastActivity = Date.now();
    this.autoPaused = false;
    this.destroyed = false;
    this.leaveTimer = null;
    this.leaveReason = null;
    this.readyWaiting = false;

    this.audioPlayer = createAudioPlayer({
      behaviors: { noSubscriber: noSubscriberBehavior, maxMissedFrames: 250 },
    });
    this.audioPlayer.on('stateChange', (oldState, newState) => this.onAudioStateChange(oldState, newState));
    this.audioPlayer.on('error', (error) => {
      const meta = error.resource?.metadata;
      if (meta) meta.error = error;
      this.logger.warn({ err: error.message, videoId: meta?.track?.videoId }, 'Audio player error');
    });
  }

  // ---------------------------------------------------------------- state

  get current() {
    return this.queue.current;
  }

  get status() {
    return this.audioPlayer.state.status;
  }

  get isPlaying() {
    return this.status === AudioPlayerStatus.Playing || this.status === AudioPlayerStatus.Buffering;
  }

  get isPaused() {
    return this.status === AudioPlayerStatus.Paused || this.status === AudioPlayerStatus.AutoPaused;
  }

  get voiceChannelId() {
    const c = this.connection;
    if (!c || c.state.status === VoiceConnectionStatus.Destroyed) return null;
    return c.joinConfig.channelId;
  }

  /** Current playback position in seconds. */
  get position() {
    const resource = this.currentResource;
    if (!resource || !this.current) return 0;
    return (resource.metadata.startOffset ?? 0) + resource.playbackDuration / 1000;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  // ---------------------------------------------------------------- voice connection

  /**
   * Join (or move to) a voice channel and wait until the connection is ready.
   * @param {import('discord.js').VoiceBasedChannel} channel
   */
  async connect(channel) {
    this.assertAlive();
    if (this.connection && this.voiceChannelId === channel.id && this.connection.state.status === VoiceConnectionStatus.Ready) {
      return this.connection;
    }
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    if (this.connection !== connection) {
      this.connection = connection;
      this.attachConnectionHandlers(connection);
      connection.subscribe(this.audioPlayer);
    }
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      this.logger.warn({ err: err.message, channelId: channel.id }, 'Voice connection failed to become ready');
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      if (this.connection === connection) this.connection = null;
      throw new UserError('I could not connect to your voice channel. Please check my permissions and try again.', { cause: err });
    }
    this.touch();
    return connection;
  }

  attachConnectionHandlers(connection) {
    connection.on('stateChange', (oldState, newState) => {
      this.onConnectionStateChange(connection, oldState, newState).catch((err) =>
        this.logger.error({ err }, 'Voice connection state handler failed'),
      );
    });
    connection.on('error', (err) => this.logger.warn({ err: err.message }, 'Voice connection error'));
  }

  /** Reconnect / cleanup logic for the voice connection (follows the @discordjs/voice recommended recipe). */
  async onConnectionStateChange(connection, oldState, newState) {
    if (this.connection !== connection) return;
    if (newState.status === VoiceConnectionStatus.Disconnected) {
      if (newState.reason === VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === 4014) {
        // 4014: kicked from the channel OR moved to another channel. If moved, it reconnects by itself.
        try {
          await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
        } catch {
          this.destroy('disconnected');
        }
      } else if (connection.rejoinAttempts < 5) {
        this.logger.info({ attempt: connection.rejoinAttempts + 1 }, 'Voice connection lost, attempting to rejoin');
        await sleep((connection.rejoinAttempts + 1) * 3_000);
        if (connection.state.status === VoiceConnectionStatus.Disconnected && this.connection === connection) {
          if (!connection.rejoin()) this.destroy('connection-lost');
        }
      } else {
        this.logger.warn('Voice connection could not be re-established');
        this.destroy('connection-lost');
      }
    } else if (newState.status === VoiceConnectionStatus.Destroyed) {
      if (!this.destroyed) this.destroy('connection-destroyed');
    } else if (
      !this.readyWaiting &&
      (newState.status === VoiceConnectionStatus.Connecting || newState.status === VoiceConnectionStatus.Signalling) &&
      oldState.status !== VoiceConnectionStatus.Connecting && oldState.status !== VoiceConnectionStatus.Signalling
    ) {
      // Guard against a connection stuck in connecting/signalling forever.
      this.readyWaiting = true;
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      } catch {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
          this.logger.warn('Voice connection stuck while (re)connecting, destroying');
          this.destroy('connection-lost');
        }
      } finally {
        this.readyWaiting = false;
      }
    }
  }

  // ---------------------------------------------------------------- playback core

  onAudioStateChange(oldState, newState) {
    if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
      const meta = oldState.resource?.metadata;
      // Ignore resources that were superseded (skip/seek/stop bump the token before replacing).
      if (!meta || meta.token !== this.token || this.destroyed) return;
      const playedMs = oldState.resource.playbackDuration;
      this.mutex.run(() => this.onTrackEnd(meta, playedMs)).catch((err) => this.logger.error({ err }, 'onTrackEnd failed'));
    }
    if (newState.status !== oldState.status) this.emit('stateChange');
  }

  async onTrackEnd(meta, playedMs) {
    if (meta.token !== this.token || this.destroyed) return;
    const track = meta.track;
    // Give ffmpeg a moment to report its exit status.
    await Promise.race([meta.source?.exited, sleep(500)]);
    if (meta.token !== this.token || this.destroyed) return;

    const position = (meta.startOffset ?? 0) + playedMs / 1000;
    const endedEarly = track.duration ? position < track.duration - 5 : false;
    const broken = Boolean(meta.error) || Boolean(meta.source?.failed) || (endedEarly && playedMs < 1000);

    if ((broken || endedEarly) && !track.isLive && track.duration) {
      const attempts = meta.resumeAttempts ?? 0;
      if (endedEarly && attempts < MAX_RESUME_ATTEMPTS) {
        this.logger.warn(
          { videoId: track.videoId, position: Math.round(position), attempts, stderr: meta.source?.stderr?.slice(-300) },
          'Stream ended early, resuming',
        );
        await this.startCurrent({ seek: Math.max(0, Math.floor(position)), resumeAttempts: attempts + 1, silent: true });
        return;
      }
      if (broken && playedMs < 5000) {
        return this.handleFailure(track, new TrackError('The audio stream failed while playing.', { code: 'STREAM_BROKEN', cause: meta.error }));
      }
    }

    this.consecutiveFailures = 0;
    const next = this.queue.next();
    if (next) await this.startCurrent();
    else await this.finishQueue();
  }

  /**
   * Start (or restart) the queue's current track.
   * Must be called inside the mutex.
   */
  async startCurrent({ seek = 0, resumeAttempts = 0, silent = false } = {}) {
    const track = this.queue.current;
    if (!track) return this.finishQueue();
    const token = ++this.token;
    this.clearLeaveTimer();
    this.touch();

    let resource;
    try {
      resource = await this.streamFactory.create(track, { seek, metadata: { token, resumeAttempts } });
    } catch (err) {
      if (token !== this.token || this.destroyed) return;
      return this.handleFailure(track, err);
    }
    if (token !== this.token || this.destroyed) {
      resource.metadata.source?.kill();
      return;
    }
    resource.volume?.setVolume(this.volume / 100);
    const previous = this.currentResource;
    this.currentResource = resource;
    this.autoPaused = false;
    this.audioPlayer.play(resource);
    previous?.metadata.source?.kill();
    this.consecutiveFailures = 0;
    if (!silent) this.emit('trackStart', track);
    this.emit('stateChange');

    const upcoming = this.queue.upcoming[0];
    if (upcoming) this.prefetcher?.prefetch(upcoming.videoId);
  }

  async handleFailure(track, error) {
    this.consecutiveFailures++;
    const level = error instanceof TrackError ? 'warn' : 'error';
    this.logger[level]({ videoId: track.videoId, code: error.code, err: error.cause?.message ?? error.message }, 'Track failed');
    this.emit('trackError', track, error);

    if (this.consecutiveFailures >= this.options.maxConsecutiveFailures) {
      this.logger.warn({ failures: this.consecutiveFailures }, 'Too many consecutive failures, stopping playback');
      this.emit('trackError', null, new UserError(`Stopped after ${this.consecutiveFailures} failed tracks in a row.`));
      this.queue.clear();
      this.queue.current = null;
      return this.finishQueue();
    }
    const next = this.queue.next({ dropCurrent: true });
    if (next) await this.startCurrent();
    else await this.finishQueue();
  }

  async finishQueue() {
    this.token++;
    this.queue.current = null;
    const resource = this.currentResource;
    this.currentResource = null;
    this.audioPlayer.stop(true);
    resource?.metadata.source?.kill();
    this.consecutiveFailures = 0;
    this.emit('queueEnd');
    this.emit('stateChange');
    this.scheduleLeave(this.options.queueEndTimeout, 'queue-end');
  }

  // ---------------------------------------------------------------- public API (all serialised)

  /**
   * Add tracks and start playback if idle.
   * @returns {Promise<{ added: object[], duplicates: number, overflow: number, started: boolean, position: number }>}
   */
  enqueue(tracks, { position = 'end', seek = 0 } = {}) {
    return this.mutex.run(async () => {
      this.assertAlive();
      const before = this.queue.size;
      const result = this.queue.add(tracks, { position });
      this.touch();
      let started = false;
      if (!this.queue.current && result.added.length) {
        this.queue.next();
        started = true;
        await this.startCurrent({ seek });
      } else if (result.added.length) {
        this.emit('stateChange');
      }
      const queuePosition = position === 'next' ? 1 : before + 1;
      return { ...result, started, position: started ? 0 : queuePosition };
    });
  }

  /**
   * Replace the whole queue (current + upcoming) with new tracks and start the first one now.
   * The old current track goes to history but is not re-queued, even in loop-queue mode.
   */
  replace(tracks) {
    return this.mutex.run(async () => {
      this.assertAlive();
      const previous = this.queue.current;
      this.queue.current = null;
      this.queue.clear();
      const result = this.queue.add(tracks);
      if (!result.added.length) {
        this.queue.current = previous;
        return { ...result, started: false, position: 0 };
      }
      if (previous) this.queue.pushHistory(previous);
      this.queue.next();
      this.touch();
      await this.startCurrent();
      return { ...result, started: true, position: 0 };
    });
  }

  skip(to) {
    return this.mutex.run(async () => {
      this.assertAlive();
      const skipped = this.queue.current;
      if (!skipped) throw new UserError('Nothing is playing.');
      const next = to ? this.queue.jump(to) : this.queue.next({ forced: true });
      this.touch();
      if (next) await this.startCurrent();
      else await this.finishQueue();
      return { skipped, next };
    });
  }

  previous() {
    return this.mutex.run(async () => {
      this.assertAlive();
      const prev = this.queue.previous();
      if (!prev) throw new UserError('There is no previous track.');
      await this.startCurrent();
      return prev;
    });
  }

  seek(seconds) {
    return this.mutex.run(async () => {
      this.assertAlive();
      const track = this.queue.current;
      if (!track) throw new UserError('Nothing is playing.');
      if (track.isLive || !track.duration) throw new UserError('You cannot seek in a live stream.');
      if (seconds < 0 || seconds >= track.duration) {
        throw new UserError(`Timestamp must be between 0:00 and the track length.`);
      }
      const wasPaused = this.isPaused && !this.autoPaused;
      await this.startCurrent({ seek: seconds, silent: true });
      if (wasPaused) {
        await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 5_000).catch(() => {});
        this.audioPlayer.pause(true);
      }
      return seconds;
    });
  }

  replay() {
    return this.mutex.run(async () => {
      this.assertAlive();
      if (!this.queue.current) throw new UserError('Nothing is playing.');
      await this.startCurrent({ silent: true });
      return this.queue.current;
    });
  }

  async pause() {
    if (!this.queue.current) throw new UserError('Nothing is playing.');
    if (this.isPaused && !this.autoPaused) throw new UserError('Playback is already paused.');
    // A track that is still buffering cannot be paused yet: wait briefly for it to start.
    if (this.status === AudioPlayerStatus.Buffering) {
      await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 5_000).catch(() => {});
    }
    if (!this.isPaused && !this.audioPlayer.pause(true)) throw new UserError('The track is still loading, try again in a moment.');
    this.autoPaused = false;
    this.touch();
    this.emit('stateChange');
    return true;
  }

  resume() {
    if (!this.queue.current) throw new UserError('Nothing is playing.');
    if (!this.isPaused) throw new UserError('Playback is not paused.');
    this.autoPaused = false;
    this.audioPlayer.unpause();
    this.clearLeaveTimer();
    this.touch();
    this.emit('stateChange');
    return true;
  }

  async togglePause() {
    if (this.isPaused) {
      this.resume();
      return 'resumed';
    }
    await this.pause();
    return 'paused';
  }

  setVolume(volume) {
    const max = this.options.maxVolume ?? 200;
    if (!Number.isFinite(volume) || volume < 0 || volume > max) throw new UserError(`Volume must be between 0 and ${max}.`);
    this.volume = Math.round(volume);
    this.currentResource?.volume?.setVolume(this.volume / 100);
    this.touch();
    this.emit('stateChange');
    return this.volume;
  }

  setLoop(mode) {
    const result = mode ? this.queue.setLoopMode(mode) : this.queue.cycleLoopMode();
    this.touch();
    this.emit('stateChange');
    return result;
  }

  shuffle() {
    if (this.queue.size < 2) throw new UserError('Add at least two upcoming tracks to shuffle.');
    this.queue.shuffle();
    this.touch();
    this.emit('stateChange');
    return this.queue.size;
  }

  remove(position, to) {
    const removed = to ? this.queue.removeRange(position, to) : [this.queue.remove(position)];
    this.touch();
    this.emit('stateChange');
    return removed;
  }

  move(from, to) {
    const track = this.queue.move(from, to);
    this.touch();
    this.emit('stateChange');
    return track;
  }

  clear() {
    const count = this.queue.clear();
    this.touch();
    this.emit('stateChange');
    return count;
  }

  dedupe() {
    const count = this.queue.dedupe();
    this.emit('stateChange');
    return count;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Called by the voiceStateUpdate handler when the bot is alone in its channel. */
  onChannelEmpty() {
    if (this.destroyed) return;
    if (this.status === AudioPlayerStatus.Playing || this.status === AudioPlayerStatus.Buffering) {
      this.audioPlayer.pause(true);
      this.autoPaused = true;
      this.emit('stateChange');
    }
    this.scheduleLeave(this.options.emptyChannelTimeout, 'channel-empty');
  }

  /** Called when a listener joins the bot's channel again. */
  onChannelOccupied() {
    if (this.destroyed) return;
    if (this.leaveReason === 'channel-empty') this.clearLeaveTimer();
    if (this.autoPaused) {
      this.autoPaused = false;
      this.audioPlayer.unpause();
      this.emit('stateChange');
    }
  }

  scheduleLeave(ms, reason) {
    this.clearLeaveTimer();
    this.leaveReason = reason;
    this.leaveTimer = setTimeout(() => this.destroy(reason), ms);
    this.leaveTimer.unref?.();
  }

  clearLeaveTimer() {
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
    this.leaveReason = null;
  }

  /** Whether the idle sweeper may reclaim this player. */
  isInactive(now = Date.now()) {
    if (this.destroyed) return true;
    const idleFor = now - this.lastActivity;
    if (!this.voiceChannelId && !this.isPlaying) return idleFor > 30_000;
    if (this.status === AudioPlayerStatus.Idle) return idleFor > this.options.idlePlayerTimeout;
    if (this.isPaused) return idleFor > this.options.idlePlayerTimeout * 3;
    return false;
  }

  assertAlive() {
    if (this.destroyed) throw new UserError('The player was just shut down. Please try again.');
  }

  /** Tear everything down. Idempotent. */
  destroy(reason = 'destroyed') {
    if (this.destroyed) return;
    this.destroyed = true;
    this.token++;
    this.clearLeaveTimer();
    this.logger.info({ reason }, 'Destroying guild player');
    const resource = this.currentResource;
    this.currentResource = null;
    try {
      this.audioPlayer.stop(true);
    } catch {
      /* ignore */
    }
    resource?.metadata.source?.kill();
    const connection = this.connection;
    this.connection = null;
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        connection.destroy();
      } catch {
        /* ignore */
      }
    }
    this.queue.reset();
    this.emit('destroyed', reason);
    this.removeAllListeners();
    this.audioPlayer.removeAllListeners();
    this.audioPlayer.on('error', () => {}); // a late stream error must never become an uncaught 'error' event
  }
}
