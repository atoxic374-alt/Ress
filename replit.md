# Discord Bot

A feature-rich Discord bot built with Node.js and discord.js v14.

## Stack
- **Runtime:** Node.js
- **Library:** discord.js v14
- **Database:** SQLite (sqlite3)
- **Entry point:** `bot.js`
- **Start command:** `npm start`

## Features
Commands cover a wide range: role management, moderation, voice calls, tickets, backups, activity stats, maps, and more. All commands are in the `commands/` directory.

## Running the bot
1. Install dependencies: `npm install`
2. Set required environment secrets (see below)
3. Start: `npm start`

## Required secrets
- `DISCORD_TOKEN` — your Discord bot token from the [Discord Developer Portal](https://discord.com/developers/applications)

## Optional environment variables
- `RAILWAY_VOLUME_MOUNT_PATH` — path to a persistent volume for SQLite databases and JSON data files
- `ENABLE_PRESENCE_INTENT=true` — enables GuildPresences intent (must also be enabled in Discord Developer Portal)
- `DISABLE_PRIVILEGED_INTENTS=true` — disables privileged intents if they are unavailable
- `DB_INIT_TIMEOUT_MS` — how long startup waits for SQLite (default 15000)
- `SQLITE_BUSY_TIMEOUT_MS` — SQLite busy timeout per connection (default 60000)
- `SQLITE_BUSY_RETRIES` — retry count for locked SQLite statements (default 8)
- `SQLITE_OPEN_RETRIES` — retry count when opening the database file (default 5)

## User preferences
