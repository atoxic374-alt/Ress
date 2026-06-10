# Railway deployment notes

## Persistent storage

This bot automatically detects `RAILWAY_VOLUME_MOUNT_PATH` and stores runtime files under that mounted volume:

- SQLite databases: `<volume>/database`
- JSON data files: `<volume>/data`
- backup snapshots: `<volume>/backups`

Recommended Railway volume mount paths:

- `/app/data` if you mainly need JSON data persistence.
- `/app/database` if you only want the SQLite database persisted.
- Any other absolute mount path also works because the bot reads `RAILWAY_VOLUME_MOUNT_PATH` at runtime.

Railway mounts volumes only when the service starts, so database migrations and data writes must happen during the normal start command (`npm start`).

## Discord gateway intents

By default, the bot enables `MessageContent` and `GuildMembers` because many prefix commands and member features need them. The `GuildPresences` privileged intent is disabled by default to avoid Railway crashes when it is not enabled in the Discord Developer Portal.

Optional environment variables:

- `ENABLE_PRESENCE_INTENT=true` — enables `GuildPresences` only if it is also enabled in the Discord Developer Portal.
- `DISABLE_PRIVILEGED_INTENTS=true` — disables `MessageContent`, `GuildMembers`, and `GuildPresences` if you need the bot to start while privileged intents are unavailable. Prefix commands that depend on message content may not work in this mode.

## Startup safety mode

The bot is designed to keep Discord online even if SQLite is temporarily locked during a Railway redeploy:

- SQLite writes are retried and serialized through one write queue.
- Startup does not stop at database errors; ticket state falls back to JSON files and in-memory runtime sessions.
- If the SQLite file cannot be safely initialized, the database layer can temporarily use an in-memory fallback so the bot can still log in.

Useful tuning variables:

- `DB_INIT_TIMEOUT_MS=15000` — how long startup waits for SQLite before continuing with fallbacks.
- `SQLITE_BUSY_TIMEOUT_MS=60000` — SQLite busy timeout per connection.
- `SQLITE_BUSY_RETRIES=8` — retry count for locked SQLite statements.
- `SQLITE_OPEN_RETRIES=5` — retry count when opening the database file.
