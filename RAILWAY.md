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
