# 🎶 Roketa Music

A Discord music bot for YouTube, built with **discord.js v14**, **@discordjs/voice**, **yt-dlp**, **FFmpeg** and **SQLite**.

- Plays YouTube videos, playlists and search results, with a separate queue and player for every server
- Queue tools: skip, previous, jump, remove, move, shuffle, dedupe and clear
- Loop the current track or the whole queue, plus volume, seek, replay, pause and resume
- A **Now Playing** card with progress, requester, queue info and control buttons (⏮ ⏯ ⏭ ⏹ 🔀 🔁 📜)
- **Persistent playlists**, both personal (they follow a user across servers) and shared server playlists
- An optional DJ role, voice-channel checks, and per-user rate limits
- Recovers from failures: dead or private videos are skipped, dropped streams resume where they stopped, voice disconnects trigger a reconnect, and idle players are cleaned up

---

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | **20.12+** (22 LTS or 24 recommended) | |
| FFmpeg | any recent build | must be on `PATH`, or set `FFMPEG_PATH` |
| yt-dlp | managed automatically | the bot downloads the latest standalone binary into `./bin` and keeps it updated |

Install FFmpeg:

- **Windows:** `winget install Gyan.FFmpeg`
- **macOS:** `brew install ffmpeg`
- **Debian/Ubuntu:** `sudo apt install ffmpeg`

yt-dlp runs YouTube's JavaScript challenges with the same Node.js that runs the bot, so you don't need a separate runtime such as Deno.

---

## 1. Discord Developer Portal setup

1. Open <https://discord.com/developers/applications> and click **New Application**.
2. **General Information:** copy the **Application ID**. This is `DISCORD_CLIENT_ID`.
3. **Bot** tab:
   - Click **Reset Token** and copy the token. This is `DISCORD_TOKEN`. Keep it secret.
   - Leave all **Privileged Gateway Intents** off. The bot only uses the non-privileged `Guilds` and `GuildVoiceStates` intents.
4. **Installation** (or **OAuth2 → URL Generator**):
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: **View Channels, Send Messages, Embed Links, Connect, Speak**
   - For stage channels, also grant **Mute Members** (so the bot can become a speaker) or make it a stage moderator.

Invite URL (replace `YOUR_CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=3165184
```

`3165184` = View Channels + Send Messages + Embed Links + Connect + Speak.

---

## 2. Installation

```bash
git clone <your repo> roketa-music
cd roketa-music
npm install
cp .env.example .env        # Windows: copy .env.example .env
```

Edit `.env` and set at least `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. Every variable is documented in `.env.example`, and the most important ones are listed below.

Optionally download yt-dlp ahead of time. The bot also does this on first start.

```bash
npm run setup
```

---

## 3. Register slash commands

```bash
npm run deploy          # to DEV_GUILD_ID if set (appears instantly), otherwise global
npm run deploy:global   # global (can take up to an hour to show up everywhere)
node scripts/deploy-commands.js --clear [--global]   # remove all commands
npm run check           # offline check that all command definitions are valid
```

Re-run the deploy step whenever you add or change command options. It isn't needed for code-only changes.

---

## 4. Running

**Development** (restarts on file changes, pretty logs):

```bash
npm run dev
```

**Production:**

```bash
NODE_ENV=production npm start
```

With **PM2**, which restarts the bot on crashes and keeps it running across reboots:

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

With **Docker**:

```bash
docker build -t roketa-music .
docker run -d --name roketa --restart unless-stopped --env-file .env -v roketa-data:/app/data roketa-music
```

On `SIGINT`/`SIGTERM` the bot shuts down in this order: it destroys every player, kills FFmpeg and yt-dlp processes, logs out of Discord, and closes the database.

---

## 5. Database

The bot uses **SQLite** through `better-sqlite3`, stored in a single file (`DATABASE_PATH`, default `data/roketa.db`).

- The database is created automatically on first start, so there's nothing to set up.
- Migrations run automatically, and progress is tracked with `PRAGMA user_version`.
- WAL mode keeps writes durable and fast.
- To back up, copy `data/roketa.db` (or use `sqlite3 data/roketa.db ".backup backup.db"` while the bot runs).

What it stores:

| Table | Contents |
|---|---|
| `playlists` | personal (`owner_type='user'`) and server (`owner_type='guild'`) playlists |
| `playlist_tracks` | ordered tracks: video id, title, author, duration, thumbnail |
| `guild_settings` | DJ role, default volume, default loop mode, duplicate policy, Now Playing messages |

The storage interface is documented in `src/database/index.js`. To swap in another database (Postgres, MongoDB and so on), implement those methods and add a case to `createStore()`. Nothing outside `src/database/` touches SQL.

---

## Commands

### Playback

| Command | Description |
|---|---|
| `/play <query> [next] [shuffle]` | Play a YouTube URL, playlist URL or search. Adds to the queue if something is playing. |
| `/playnext <query>` | Add to the front of the queue |
| `/search <query>` | Pick one of 8 search results from a menu |
| `/pause` · `/resume` | Pause or resume |
| `/skip [to]` | Skip, or jump to a queue position. The requester can always skip their own song. |
| `/previous` | Go back to the previous track |
| `/replay` | Restart the current track |
| `/seek <time>` | Jump to a timestamp (`1:30`, `90`, `1m30s`, `1:02:03`) |
| `/volume [level]` | Show or set the volume (0–200) |
| `/loop [off\|track\|queue]` | Set the loop mode, or cycle through modes when none is given |
| `/nowplaying` · `/np` | Show the Now Playing card with controls |
| `/stop` · `/leave` | Stop, clear the queue and disconnect |

### Queue

| Command | Description |
|---|---|
| `/queue [page]` | Paged queue view (with page buttons) |
| `/shuffle` | Shuffle upcoming tracks |
| `/remove <position> [to]` | Remove one track or a range |
| `/move <from> <to>` | Move a track |
| `/clear` | Remove all upcoming tracks |
| `/dedupe` | Remove duplicate songs |

### Playlists

| Command | Description |
|---|---|
| `/playlist create <name> [scope]` | Create a personal (default) or server playlist |
| `/playlist delete <name>` | Delete a playlist |
| `/playlist rename <name> <new_name>` | Rename a playlist |
| `/playlist add <name> [query]` | Add a video, search result or whole YouTube playlist. With no query, adds the current song. |
| `/playlist remove <name> <position>` | Remove a track |
| `/playlist list [scope]` | List your playlists and the server's playlists |
| `/playlist view <name> [page]` | Show a playlist's tracks |
| `/playlist play <name> [shuffle]` | Replace the queue with the playlist and play it now |
| `/playlist load <name> [shuffle]` | Append the playlist to the queue |
| `/playlist savequeue <name> [scope]` | Save the current song and queue as a new playlist |

Playlist names autocomplete. 👤 marks personal playlists and 🏠 marks server playlists.

### Admin (requires Manage Server)

| Command | Description |
|---|---|
| `/settings view` | Show the settings |
| `/settings djrole [role]` | Restrict controls to a DJ role (omit the role to allow everyone) |
| `/settings volume <level>` | Default volume for new sessions |
| `/settings loop <mode>` | Default loop mode |
| `/settings duplicates <allowed>` | Allow or skip duplicate songs when queueing |
| `/settings announce <enabled>` | Turn Now Playing messages on or off |

`/help` shows everything in Discord.

### Permission model

- Every control needs the user to be **in the bot's voice channel**. Someone elsewhere can't control the music, and can't pull the bot away while people are listening.
- Before joining, the bot checks that it can **View, Connect and Speak** in the channel, and that the channel isn't full.
- **With no DJ role set**, everyone in the channel can use every control.
- **With a DJ role set**, the control commands (skip others' songs, previous, stop, clear, shuffle, loop, move, seek, volume, replay, dedupe, replacing the queue) need one of these:
  - the DJ role
  - **Manage Server**
  - being alone with the bot

  Anyone can still add songs, skip their own song and remove their own tracks.
- Server playlists can be created by DJs and managers, and edited by their creator, DJs or managers. Everyone in the server can play them.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` | **required** | Bot token |
| `DISCORD_CLIENT_ID` | required for deploy | Application ID |
| `DEV_GUILD_ID` | – | Guild used for instant command deployment |
| `NODE_ENV` | `development` | `production` switches logs to JSON |
| `LOG_LEVEL` | `info` | pino log level |
| `DATABASE_PATH` | `data/roketa.db` | SQLite file |
| `DEFAULT_VOLUME` | `80` | Volume for new players (per-server override: `/settings volume`) |
| `MAX_QUEUE_SIZE` | `1000` | Queue cap per server |
| `MAX_PLAYLIST_IMPORT` | `500` | Max tracks taken from one YouTube playlist |
| `MAX_TRACK_DURATION_SECONDS` | `0` | Reject longer tracks (0 = no limit) |
| `QUEUE_END_TIMEOUT_SECONDS` | `180` | Leave this long after the queue ends |
| `EMPTY_CHANNEL_TIMEOUT_SECONDS` | `120` | Auto-pause, then leave, when the channel is empty |
| `IDLE_PLAYER_TIMEOUT_SECONDS` | `600` | The sweeper reclaims idle players |
| `MAX_CONSECUTIVE_FAILURES` | `5` | Stop after this many broken tracks in a row |
| `NOW_PLAYING_UPDATE_SECONDS` | `30` | Progress refresh interval (0 = off) |
| `MAX_PLAYLISTS_PER_OWNER` / `MAX_PLAYLIST_TRACKS` | `25` / `500` | Playlist limits |
| `COMMAND_RATE_LIMIT` / `COMMAND_RATE_WINDOW_SECONDS` | `5` / `10` | Per-user spam protection |
| `YTDLP_PATH` | managed | Use your own yt-dlp binary instead |
| `YTDLP_AUTO_UPDATE` | `true` | Self-update the managed binary on start and every `YTDLP_UPDATE_INTERVAL_HOURS` |
| `YTDLP_COOKIES` | – | Netscape cookies file (age-restricted videos, bot checks) |
| `YTDLP_MAX_CONCURRENCY` | `3` | Max parallel yt-dlp processes |
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg executable |

---

## Architecture

```
src/
├── index.js                  bootstrap, dependency wiring, graceful shutdown
├── config/                   validated environment configuration
├── commands/                 slash commands, one file each (music/, playlist/, general/)
├── events/                   interactionCreate, voiceStateUpdate, ready, guildDelete
├── interactions/             guards (voice/DJ checks), buttons, shared play flow, replies
├── music/
│   ├── GuildPlayer.js        per-guild player: queue + audio player + voice connection
│   ├── PlayerManager.js      guild → player map, idle sweeper
│   ├── StreamFactory.js      yt-dlp URL → FFmpeg → PCM → AudioResource (with fallbacks)
│   ├── YtDlp.js              yt-dlp client: resolve/search/playlists, error mapping, cache
│   ├── ytdlpBinary.js        downloads and self-updates the yt-dlp binary
│   ├── youtubeUrl.js         URL parsing
│   └── Track.js
├── queue/Queue.js            pure queue model (loop modes, history, shuffle, ...)
├── playlists/                playlist business rules (ownership, limits, validation)
├── settings/                 guild settings with defaults and cache
├── database/                 storage interface + SQLite implementation and migrations
├── ui/                       embeds, buttons, NowPlayingController
└── utils/                    logger, errors, formatting, rate limiter, LRU cache, mutex
```

Design notes:

- **Separated layers.** `Queue` is pure logic. `GuildPlayer` owns audio and voice but knows nothing about embeds; it emits events that `NowPlayingController` turns into messages. Commands are thin: they validate input and call the player.
- **Serialised state changes.** Every playback change for a guild (enqueue, skip, previous, seek, track end) runs through a per-guild mutex, so spamming buttons can't corrupt state. Each audio resource carries a token, so stale "track ended" events from replaced streams are ignored.
- **Streaming pipeline.**
  1. yt-dlp resolves the signed audio URL, cached until it expires.
  2. The next track is prefetched while the current one plays.
  3. FFmpeg reads the URL directly, with reconnect support, and seeks fast via HTTP range requests.
  4. FFmpeg outputs raw PCM, which goes through the inline volume transformer and then the Opus encoder.

  If the direct URL fails, the bot re-resolves it once. If that also fails, it pipes yt-dlp's download into FFmpeg.
- **Failure handling.** Extraction errors are classified (private, deleted, age-restricted, geo-blocked, bot check, network, rate limit...). Failed tracks are dropped, even in loop modes, and the user gets one batched message. Streams that die mid-track resume from their position up to twice. After `MAX_CONSECUTIVE_FAILURES` failures in a row, playback stops instead of spinning.
- **Voice resilience.** When the connection drops, the bot rejoins with backoff. If the bot is kicked (close code 4014), it destroys the player cleanly. If it's moved to another channel, it keeps playing. A connection stuck in "connecting" is destroyed after 20 seconds.
- **Memory safety.**
  - Queue and history sizes are bounded.
  - The LRU caches have TTLs.
  - The rate-limiter maps are pruned.
  - The discord.js message and presence caches are turned off.
  - Players are destroyed when the queue ends, the channel empties, the bot is removed from the server, or the sweeper finds them inactive.
  - Health (players, RSS, heap) is logged every 15 minutes.
- **Discord API friendliness.** Now Playing edits are debounced to at most one every 2.5 seconds, bursts of errors are batched, and REST rate-limit events are logged.

---

## Testing

```bash
npm test                         # everything (unit + live YouTube integration)
npm run test:unit                # offline only (~20 s)
SKIP_NETWORK_TESTS=1 npm test    # skip the live YouTube tests
```

| Suite | Covers |
|---|---|
| `unit.queue` | ordering, loop modes, previous/jump, shuffle permutation and uniformity, dedupe, limits |
| `unit.utils` | timestamps, URL parsing, yt-dlp error classification, rate limiter, LRU, mutex, semaphore |
| `unit.database` | playlist CRUD, ownership rules, limits, settings, **persistence across a restart** |
| `unit.player` | the real AudioPlayer and Opus encoder on synthetic audio: auto-advance, loops, failure skipping, mid-stream resume, seek/skip/previous, concurrent skip races, multi-guild isolation, idle sweeping |
| `unit.commands` | **every** slash command, button and autocomplete through the real interaction handler with simulated guilds, members and voice channels, including permission and DJ checks |
| `integration.youtube` | live YouTube: video, search and playlist resolution, unavailable-video errors, real Opus output, seek, natural track end → next track, playlist playback in two guilds at once |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Sign in to confirm you're not a bot" | YouTube is flagging your server's IP. Set `YTDLP_COOKIES` to a cookies file exported from a throwaway account, or run from a residential IP. |
| Age-restricted videos fail | They need `YTDLP_COOKIES` from an age-verified account. |
| Many "Failed to extract" errors | yt-dlp is probably outdated. Run `npm run setup`, or check that `YTDLP_AUTO_UPDATE=true`. |
| "FFmpeg was not found" | Install FFmpeg or set `FFMPEG_PATH`. |
| Commands don't appear | Run `npm run deploy`. Global commands can take a while, so use `DEV_GUILD_ID` for testing. |
| Bot joins but there's no sound | Check the **Speak** permission. On stage channels, invite the bot to speak or grant **Mute Members**. |

## Known limitations

- Only YouTube is supported (videos, Shorts, live streams, playlists, YouTube Music links). Radio "mix" lists (`list=RD…`) play just the linked video.
- Seeking isn't available in live streams.
- Queues are kept in memory, so a restart clears them. Save a queue with `/playlist savequeue` first if you want to keep it.
- YouTube actively fights automated clients. Reliability depends on keeping yt-dlp up to date (automatic) and, on data-center IPs, on providing cookies.
- One process serves all servers. For thousands of servers, use discord.js sharding (`ShardingManager`).
