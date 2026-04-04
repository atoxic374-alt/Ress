const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionsBitField,
  AuditLogEvent
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const colorManager = require('../utils/colorManager');
const { getDatabase } = require('../utils/database');

const backupsDir = path.join(__dirname, '..', 'backups', 'json-fallback');
const sessions = new Map();
const protectionCache = new Map();
const restoreTokens = new Map();
const guildQueues = new Map();
const protectionDebounce = new Map();
let listenersReady = false;

const DEFAULT_CONCURRENCY = 8;
const SESSION_TTL_MS = 1000 * 60 * 15;
const MAX_API_RETRIES = 4;
const rateState = { windowStart: Date.now(), hits429: 0, failures: 0, latencySum: 0, latencyCount: 0 };

function fmt(label, value) {
  return `**${label} :** ${value}`;
}

function createLimiter(concurrency = DEFAULT_CONCURRENCY) {
  const queue = [];
  let active = 0;

  const runNext = () => {
    if (active >= concurrency || queue.length === 0) return;
    const task = queue.shift();
    active += 1;
    task().finally(() => {
      active -= 1;
      runNext();
    });
  };

  return (fn) => new Promise((resolve, reject) => {
    queue.push(async () => {
      try {
        resolve(await fn());
      } catch (error) {
        reject(error);
      }
    });
    runNext();
  });
}

async function withDiscordRetry(fn, { retries = MAX_API_RETRIES } = {}) {
  let attempt = 0;
  while (attempt <= retries) {
    const startedAt = Date.now();
    try {
      const result = await fn();
      rateState.latencySum += (Date.now() - startedAt);
      rateState.latencyCount += 1;
      return result;
    } catch (error) {
      rateState.failures += 1;
      const status = error?.status || error?.code;
      const retryAfterMs = Math.ceil((error?.retryAfter || error?.rawError?.retry_after || 0) * 1000);
      const isRetryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
      if (status === 429) {
        if (Date.now() - rateState.windowStart > 60000) {
          rateState.windowStart = Date.now();
          rateState.hits429 = 0;
        }
        rateState.hits429 += 1;
      }
      if (!isRetryable || attempt === retries) throw error;
      const backoff = retryAfterMs > 0 ? retryAfterMs : (250 * (2 ** attempt));
      await new Promise(resolve => setTimeout(resolve, Math.min(backoff + Math.floor(Math.random() * 200), 8000)));
      attempt += 1;
    }
  }
  return null;
}

function adaptiveConcurrency(base) {
  if (Date.now() - rateState.windowStart > 60000) {
    rateState.windowStart = Date.now();
    rateState.hits429 = 0;
    rateState.failures = 0;
    rateState.latencySum = 0;
    rateState.latencyCount = 0;
  }
  const avgLatency = rateState.latencyCount > 0 ? (rateState.latencySum / rateState.latencyCount) : 0;
  const failureRatio = rateState.latencyCount > 0 ? (rateState.failures / rateState.latencyCount) : 0;
  let level = 0;
  if (rateState.hits429 >= 20) return Math.max(2, Math.floor(base * 0.35));
  if (rateState.hits429 >= 10) return Math.max(3, Math.floor(base * 0.6));
  if (avgLatency > 1500) level += 1;
  if (failureRatio > 0.2) level += 1;
  if (level >= 2) return Math.max(3, Math.floor(base * 0.65));
  if (level >= 1) return Math.max(4, Math.floor(base * 0.8));
  return base;
}

async function enqueueGuildTask(guildId, fn) {
  const prev = guildQueues.get(guildId) || Promise.resolve();
  const next = prev.then(fn).catch(() => null);
  guildQueues.set(guildId, next.finally(() => {
    if (guildQueues.get(guildId) === next) guildQueues.delete(guildId);
  }));
  return next;
}

async function ensureStorage() {
  await fs.promises.mkdir(backupsDir, { recursive: true });
  const db = getDatabase();
  await db.run(`CREATE TABLE IF NOT EXISTS guild_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  await db.run(`CREATE TABLE IF NOT EXISTS guild_protection (
    guild_id TEXT PRIMARY KEY,
    config_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  await db.run(`CREATE TABLE IF NOT EXISTS guild_restore_tokens (
    token TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  await db.run('CREATE INDEX IF NOT EXISTS idx_guild_backups_guild_created ON guild_backups(guild_id, created_at DESC)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_restore_tokens_created ON guild_restore_tokens(created_at DESC)');
  await db.run('DELETE FROM guild_restore_tokens WHERE created_at < ?', [Date.now() - (1000 * 60 * 60 * 24)]);
}

function permissionsToString(perm) {
  return perm?.bitfield?.toString?.() || '0';
}

async function fetchChannelMessages(guild) {
  const textChannels = guild.channels.cache.filter(c => c.type === ChannelType.GuildText).first(20);
  const collected = {};
  const limit = createLimiter(4);

  await Promise.all(textChannels.map(ch => limit(async () => {
    try {
      const msgs = await ch.messages.fetch({ limit: 50 });
      collected[ch.id] = msgs.map(m => ({
        id: m.id,
        authorId: m.author?.id,
        content: m.content,
        createdTimestamp: m.createdTimestamp
      }));
    } catch (_) {}
  })));

  return collected;
}

async function captureSnapshot(guild, options = {}) {
  const { includeMembers = true, includeMessages = true } = options;
  if (includeMembers) await guild.members.fetch().catch(() => null);
  const [bans, messages] = await Promise.all([
    guild.bans.fetch().catch(() => new Map()),
    includeMessages ? fetchChannelMessages(guild) : Promise.resolve({})
  ]);

  const roles = guild.roles.cache
    .filter(r => !r.managed && r.id !== guild.id)
    .sort((a, b) => a.position - b.position)
    .map(r => ({
      id: r.id,
      name: r.name,
      color: r.color,
      hoist: r.hoist,
      permissions: permissionsToString(r.permissions),
      mentionable: r.mentionable,
      position: r.position
    }));

  const channels = guild.channels.cache
    .filter(ch => !ch.isThread())
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map(ch => ({
      id: ch.id,
      name: ch.name,
      type: ch.type,
      parentId: ch.parentId || null,
      position: ch.rawPosition,
      topic: ch.topic || null,
      nsfw: !!ch.nsfw,
      rateLimitPerUser: ch.rateLimitPerUser || 0,
      bitrate: ch.bitrate || null,
      userLimit: ch.userLimit || null,
      permissionOverwrites: ch.permissionOverwrites?.cache?.map(ow => ({
        id: ow.id,
        type: ow.type,
        allow: permissionsToString(ow.allow),
        deny: permissionsToString(ow.deny)
      })) || []
    }));

  const members = includeMembers ? guild.members.cache.map(m => ({
    id: m.id,
    roles: m.roles.cache.filter(r => r.id !== guild.id).map(r => r.id)
  })) : [];

  return {
    guildId: guild.id,
    guildName: guild.name,
    createdAt: Date.now(),
    settings: {
      name: guild.name,
      verificationLevel: guild.verificationLevel,
      explicitContentFilter: guild.explicitContentFilter,
      defaultMessageNotifications: guild.defaultMessageNotifications,
      afkTimeout: guild.afkTimeout
    },
    roles,
    channels,
    members,
    bans: [...bans.values()].map(b => ({ id: b.user.id, reason: b.reason || null })),
    messages
  };
}

async function saveBackup(guild, userId, name, snapshot) {
  await ensureStorage();
  const db = getDatabase();
  const cleanName = String(name || 'backup').trim().slice(0, 50);
  await db.run(
    'INSERT INTO guild_backups (guild_id, user_id, name, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)',
    [guild.id, userId, cleanName, JSON.stringify(snapshot), Date.now()]
  );
  const filePath = path.join(backupsDir, `${guild.id}_${cleanName.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(snapshot, null, 2));
}

async function getBackups(guildId) {
  await ensureStorage();
  const db = getDatabase();
  return (await db.all('SELECT id, name, created_at FROM guild_backups WHERE guild_id = ? ORDER BY id DESC LIMIT 25', [guildId])) || [];
}

async function getBackupById(id) {
  await ensureStorage();
  const db = getDatabase();
  const row = await db.get('SELECT * FROM guild_backups WHERE id = ?', [id]);
  return row ? { ...row, snapshot: JSON.parse(row.snapshot_json) } : null;
}

async function saveRestoreToken(token, data) {
  const db = getDatabase();
  await db.run(
    'INSERT OR REPLACE INTO guild_restore_tokens (token, guild_id, user_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
    [token, data.guildId, data.userId, JSON.stringify(data), Date.now()]
  );
}

async function getRestoreToken(token) {
  const inMemory = restoreTokens.get(token);
  if (inMemory) return inMemory;
  const db = getDatabase();
  const row = await db.get('SELECT payload_json FROM guild_restore_tokens WHERE token = ?', [token]);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload_json);
    restoreTokens.set(token, parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function deleteRestoreToken(token) {
  restoreTokens.delete(token);
  const db = getDatabase();
  await db.run('DELETE FROM guild_restore_tokens WHERE token = ?', [token]);
}

async function restoreRoles(guild, snapshot, { removeExtra = false } = {}) {
  const limit = createLimiter(adaptiveConcurrency(5));
  const stats = { created: 0, updated: 0, deleted: 0, repositioned: 0 };
  const currentRoles = guild.roles.cache.filter(r => !r.managed && r.id !== guild.id);
  const byName = new Map(currentRoles.map(r => [r.name, r]));
  const byId = new Map(currentRoles.map(r => [r.id, r]));
  const snapshotNames = new Set(snapshot.roles.map(r => r.name));

  await Promise.all(snapshot.roles.map(sr => limit(async () => {
    const found = byId.get(sr.id) || byName.get(sr.name);
    if (!found) {
      const created = await withDiscordRetry(() => guild.roles.create({
        name: sr.name,
        color: sr.color,
        hoist: sr.hoist,
        permissions: BigInt(sr.permissions),
        mentionable: sr.mentionable
      })).catch(() => null);
      if (created) {
        byName.set(sr.name, created);
        stats.created += 1;
      }
      return;
    }

    const updates = {};
    if (found.color !== sr.color) updates.color = sr.color;
    if (found.hoist !== sr.hoist) updates.hoist = sr.hoist;
    if (found.mentionable !== sr.mentionable) updates.mentionable = sr.mentionable;
    if (permissionsToString(found.permissions) !== sr.permissions) updates.permissions = BigInt(sr.permissions);
    if (Object.keys(updates).length) {
      await withDiscordRetry(() => found.edit(updates)).catch(() => null);
      stats.updated += 1;
    }
  })));

  // positions in final pass
  const sorted = [...snapshot.roles].sort((a, b) => a.position - b.position);
  await Promise.all(sorted.map(sr => limit(async () => {
    const role = guild.roles.cache.find(r => !r.managed && r.id !== guild.id && r.name === sr.name);
    if (!role) return;
    if (role.position !== sr.position) {
      await withDiscordRetry(() => role.setPosition(sr.position)).catch(() => null);
      stats.repositioned += 1;
    }
  })));

  if (removeExtra) {
    await Promise.all(currentRoles.map(r => limit(async () => {
      if (!snapshotNames.has(r.name)) {
        await withDiscordRetry(() => r.delete('Not in backup snapshot')).catch(() => null);
        stats.deleted += 1;
      }
    })));
  }
  return stats;
}

function channelMatchKey(ch) {
  const parentPart = ch.parentId || 'root';
  return `${ch.name}::${ch.type}::${parentPart}`;
}

async function applyOverwrite(channel, snapshotChannel) {
  if (!snapshotChannel.permissionOverwrites) return;
  await withDiscordRetry(() => channel.permissionOverwrites.set(snapshotChannel.permissionOverwrites.map(ow => ({
    id: ow.id,
    type: ow.type,
    allow: BigInt(ow.allow),
    deny: BigInt(ow.deny)
  })))).catch(() => null);
}

async function restoreChannels(guild, snapshot, { removeExtra = false } = {}) {
  const limit = createLimiter(adaptiveConcurrency(5));
  const stats = { created: 0, updated: 0, deleted: 0, overwrites: 0 };
  const existing = guild.channels.cache.filter(ch => !ch.isThread());
  const existingByKey = new Map(existing.map(ch => [channelMatchKey(ch), ch]));
  const byId = new Map(existing.map(ch => [ch.id, ch]));
  const snapCats = snapshot.channels.filter(c => c.type === ChannelType.GuildCategory);
  const snapOthers = snapshot.channels.filter(c => c.type !== ChannelType.GuildCategory);
  const snapKeys = new Set(snapshot.channels.map(channelMatchKey));

  for (const sc of snapCats) {
    await limit(async () => {
      let channel = byId.get(sc.id) || existingByKey.get(channelMatchKey(sc));
      if (!channel) {
        channel = await withDiscordRetry(() => guild.channels.create({ name: sc.name, type: sc.type, position: sc.position })).catch(() => null);
        if (channel) stats.created += 1;
      } else {
        await withDiscordRetry(() => channel.edit({ name: sc.name, position: sc.position })).catch(() => null);
        stats.updated += 1;
      }
      if (channel) {
        await applyOverwrite(channel, sc);
        stats.overwrites += 1;
      }
    });
  }

  await Promise.all(snapOthers.map(sc => limit(async () => {
    let channel = byId.get(sc.id) || existingByKey.get(channelMatchKey(sc));
    const parentName = sc.parentId ? snapshot.channels.find(x => x.id === sc.parentId)?.name : null;
    const parent = parentName ? guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === parentName) : null;

    const payload = {
      name: sc.name,
      type: sc.type,
      parent: parent?.id || null,
      topic: sc.topic || undefined,
      nsfw: sc.nsfw,
      rateLimitPerUser: sc.rateLimitPerUser || 0,
      bitrate: sc.bitrate || undefined,
      userLimit: sc.userLimit || undefined,
      position: sc.position
    };

    if (!channel) {
      channel = await withDiscordRetry(() => guild.channels.create(payload)).catch(() => null);
      if (channel) stats.created += 1;
    } else {
      await withDiscordRetry(() => channel.edit(payload)).catch(() => null);
      stats.updated += 1;
    }
    if (channel) {
      await applyOverwrite(channel, sc);
      stats.overwrites += 1;
    }
  })));

  if (removeExtra) {
    await Promise.all(existing.map(ch => limit(async () => {
      if (!snapKeys.has(channelMatchKey(ch))) {
        await withDiscordRetry(() => ch.delete('Not in backup snapshot')).catch(() => null);
        stats.deleted += 1;
      }
    })));
  }
  return stats;
}

async function restoreSettings(guild, snapshot) {
  const start = Date.now();
  await Promise.all([
    withDiscordRetry(() => guild.setName(snapshot.settings.name)).catch(() => null),
    withDiscordRetry(() => guild.setVerificationLevel(snapshot.settings.verificationLevel)).catch(() => null),
    withDiscordRetry(() => guild.setExplicitContentFilter(snapshot.settings.explicitContentFilter)).catch(() => null),
    withDiscordRetry(() => guild.setDefaultMessageNotifications(snapshot.settings.defaultMessageNotifications)).catch(() => null),
    withDiscordRetry(() => guild.setAFKTimeout(snapshot.settings.afkTimeout)).catch(() => null)
  ]);
  return { updated: 5, durationMs: Date.now() - start };
}

async function restoreMemberRolesAndBans(guild, snapshot) {
  const limit = createLimiter(adaptiveConcurrency(6));
  const stats = { rolesSet: 0, bansApplied: 0 };
  await Promise.all(snapshot.members.map(m => limit(async () => {
    const member = await guild.members.fetch(m.id).catch(() => null);
    if (!member) return;
    await withDiscordRetry(() => member.roles.set(m.roles.filter(id => guild.roles.cache.has(id)))).catch(() => null);
    stats.rolesSet += 1;
  })));

  await Promise.all(snapshot.bans.map(b => limit(async () => {
    const already = await guild.bans.fetch(b.id).catch(() => null);
    if (!already) {
      await withDiscordRetry(() => guild.members.ban(b.id, { reason: b.reason || 'Restore backup' })).catch(() => null);
      stats.bansApplied += 1;
    }
  })));
  return stats;
}

async function applyBackup(guild, snapshot, types, options = {}, onProgress = null) {
  let effectiveTypes = [...types];
  const all = effectiveTypes.includes('all');
  const emergencyMode = rateState.hits429 >= 20;
  if (emergencyMode && (all || effectiveTypes.includes('members'))) {
    effectiveTypes = effectiveTypes.filter(t => t !== 'members' && t !== 'all');
    if (!effectiveTypes.includes('channels')) effectiveTypes.push('channels');
    if (!effectiveTypes.includes('roles')) effectiveTypes.push('roles');
    if (!effectiveTypes.includes('settings')) effectiveTypes.push('settings');
  }
  const stages = [];
  if (all || effectiveTypes.includes('channels')) stages.push({ name: 'channels', run: () => restoreChannels(guild, snapshot, options) });
  if (all || effectiveTypes.includes('roles')) stages.push({ name: 'roles', run: () => restoreRoles(guild, snapshot, options) });
  if (all || effectiveTypes.includes('settings')) stages.push({ name: 'settings', run: () => restoreSettings(guild, snapshot) });
  if (all || effectiveTypes.includes('members')) stages.push({ name: 'members', run: () => restoreMemberRolesAndBans(guild, snapshot) });
  const report = { startedAt: Date.now(), totalStages: stages.length, stages: {}, emergencyMode, effectiveTypes };
  for (let i = 0; i < stages.length; i += 1) {
    const stage = stages[i];
    const start = Date.now();
    const result = await stage.run();
    report.stages[stage.name] = { ...(result || {}), durationMs: Date.now() - start };
    if (onProgress) {
      await onProgress({
        stage: stage.name,
        index: i + 1,
        total: stages.length,
        percent: Math.round(((i + 1) / Math.max(1, stages.length)) * 100),
        stageResult: report.stages[stage.name]
      });
    }
  }
  report.durationMs = Date.now() - report.startedAt;
  // intentionally never restore messages (store-only as requested)
  return report;
}

function buildDiffPlan(guild, snapshot, types) {
  const all = types.includes('all');
  const currentRoles = guild.roles.cache.filter(r => !r.managed && r.id !== guild.id);
  const currentChannels = guild.channels.cache.filter(c => !c.isThread());
  const plan = { roles: null, channels: null, settings: null, members: null };

  if (all || types.includes('roles')) {
    const curByName = new Map(currentRoles.map(r => [r.name, r]));
    const snapNames = new Set(snapshot.roles.map(r => r.name));
    const curNames = new Set(currentRoles.map(r => r.name));
    const create = [...snapNames].filter(n => !curNames.has(n)).length;
    const del = [...curNames].filter(n => !snapNames.has(n)).length;
    let updates = 0;
    for (const sr of snapshot.roles) {
      const cr = currentRoles.get(sr.id) || curByName.get(sr.name);
      if (!cr) continue;
      const changed = cr.color !== sr.color ||
        cr.hoist !== sr.hoist ||
        cr.mentionable !== sr.mentionable ||
        permissionsToString(cr.permissions) !== sr.permissions ||
        cr.position !== sr.position;
      if (changed) updates += 1;
    }
    plan.roles = { create, delete: del, updateOrReposition: updates };
  }
  if (all || types.includes('channels')) {
    const snapKeys = new Set(snapshot.channels.map(channelMatchKey));
    const curKeys = new Set(currentChannels.map(channelMatchKey));
    const create = [...snapKeys].filter(k => !curKeys.has(k)).length;
    const del = [...curKeys].filter(k => !snapKeys.has(k)).length;
    const curByKey = new Map(currentChannels.map(c => [channelMatchKey(c), c]));
    let updates = 0;
    for (const sc of snapshot.channels) {
      const cc = currentChannels.get(sc.id) || curByKey.get(channelMatchKey(sc));
      if (!cc) continue;
      const changed = cc.name !== sc.name ||
        cc.parentId !== sc.parentId ||
        (cc.rawPosition ?? cc.position) !== sc.position ||
        (cc.topic || null) !== (sc.topic || null) ||
        (cc.nsfw || false) !== !!sc.nsfw;
      if (changed) updates += 1;
    }
    plan.channels = { create, delete: del, updateOrOverwrite: updates };
  }
  if (all || types.includes('settings')) {
    plan.settings = { expectedUpdates: 5 };
  }
  if (all || types.includes('members')) {
    plan.members = { rolesSetTargets: snapshot.members.length, bansTargets: snapshot.bans.length };
  }
  return plan;
}

async function writeRestoreReport(guildId, report) {
  const reportsDir = path.join(backupsDir, 'restore-reports');
  await fs.promises.mkdir(reportsDir, { recursive: true });
  const filePath = path.join(reportsDir, `${guildId}_${Date.now()}_restore_report.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(report, null, 2));
  return filePath;
}

async function getConfig(guildId) {
  await ensureStorage();
  if (protectionCache.has(guildId)) return protectionCache.get(guildId);
  const db = getDatabase();
  const row = await db.get('SELECT config_json FROM guild_protection WHERE guild_id = ?', [guildId]);
  const cfg = row ? JSON.parse(row.config_json) : null;
  if (cfg) protectionCache.set(guildId, cfg);
  return cfg;
}

async function saveConfig(guildId, cfg) {
  await ensureStorage();
  const db = getDatabase();
  await db.run(`INSERT INTO guild_protection (guild_id, config_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
  [guildId, JSON.stringify(cfg), Date.now()]);
  protectionCache.set(guildId, cfg);
}

async function getExecutorId(guild, auditType) {
  try {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 5 });
    const entry = logs.entries.find(e => (Date.now() - e.createdTimestamp) < 20000) || logs.entries.first();
    if (!entry || Date.now() - entry.createdTimestamp > 15000) return null;
    return entry.executor?.id || null;
  } catch {
    return null;
  }
}

async function punishMember(guild, userId, percentDamage) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;
  const removedRoles = member.roles.cache.filter(r => r.id !== guild.id).map(r => r.id);
  await withDiscordRetry(() => member.roles.set([])).catch(() => null);

  let adminSnapshot = [];
  if (percentDamage >= 50) {
    const adminRoles = guild.roles.cache.filter(r => !r.managed && r.permissions.has(PermissionsBitField.Flags.Administrator));
    adminSnapshot = adminRoles.map(r => ({ id: r.id, permissions: permissionsToString(r.permissions) }));
    await Promise.all(adminRoles.map(r => withDiscordRetry(() => r.setPermissions(r.permissions.remove(PermissionsBitField.Flags.Administrator))).catch(() => null)));
  }

  const token = crypto.randomBytes(6).toString('hex');
  const tokenData = { guildId: guild.id, userId, removedRoles, adminSnapshot, createdAt: Date.now() };
  restoreTokens.set(token, tokenData);
  await saveRestoreToken(token, tokenData);
  setTimeout(() => deleteRestoreToken(token).catch(() => null), 1000 * 60 * 30);

  const owners = [guild.ownerId, ...(global.BOT_OWNERS || [])];
  await Promise.all(owners.map(async (id) => {
    const user = await guild.client.users.fetch(id).catch(() => null);
    if (!user) return;
    await user.send({
      content: `**Protection :** punishment applied\n${fmt('User', `<@${userId}>`)}\n${fmt('Damage', `${percentDamage}%`)}`,
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`back_restore_admin:${guild.id}:${token}`).setLabel('Restore Admin Perms').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`back_restore_user:${guild.id}:${userId}:${token}`).setLabel('Restore User Roles').setStyle(ButtonStyle.Secondary)
        )
      ]
    }).catch(() => null);
  }));
}

async function handleProtectionChange(guild, kind, auditType) {
  const cfg = await getConfig(guild.id);
  if (!cfg?.enabled || !cfg.snapshot) return;

  const executorId = await getExecutorId(guild, auditType);
  if (executorId && cfg.trustedUsers.includes(executorId)) {
    cfg.snapshot = await captureSnapshot(guild, { includeMembers: false, includeMessages: false });
    await saveConfig(guild.id, cfg);
    return;
  }
  if (executorId && (executorId === guild.ownerId || (global.BOT_OWNERS || []).includes(executorId))) {
    return;
  }

  const options = { removeExtra: true };
  if (kind === 'channel' && cfg.toggles.channels) await restoreChannels(guild, cfg.snapshot, options);
  if (kind === 'role' && cfg.toggles.roles) await restoreRoles(guild, cfg.snapshot, options);
  if (kind === 'guild' && cfg.toggles.settings) await restoreSettings(guild, cfg.snapshot);

  const channelDamage = Math.max(0, Math.round((1 - (guild.channels.cache.filter(c => !c.isThread()).size / Math.max(1, cfg.snapshot.channels.length))) * 100));
  const roleDamage = Math.max(0, Math.round((1 - (guild.roles.cache.filter(r => !r.managed && r.id !== guild.id).size / Math.max(1, cfg.snapshot.roles.length))) * 100));
  const damage = Math.max(channelDamage, roleDamage);
  if (executorId) await punishMember(guild, executorId, damage);
}

function scheduleProtectionCheck(guild, kind, auditType) {
  const key = `${guild.id}:${kind}`;
  const existing = protectionDebounce.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    protectionDebounce.delete(key);
    enqueueGuildTask(guild.id, async () => handleProtectionChange(guild, kind, auditType)).catch(() => null);
  }, 1200);
  protectionDebounce.set(key, timer);
}

function protectionEmbed(cfg) {
  return colorManager.createEmbed()
    .setTitle('**Protection :** Live Panel')
    .setDescription([
      fmt('Status', cfg.enabled ? 'ON' : 'OFF'),
      fmt('Rooms & Categories', cfg.toggles.channels ? 'ON' : 'OFF'),
      fmt('Roles', cfg.toggles.roles ? 'ON' : 'OFF'),
      fmt('Server Settings', cfg.toggles.settings ? 'ON' : 'OFF'),
      fmt('Trusted', cfg.trustedUsers.length ? cfg.trustedUsers.map(id => `<@${id}>`).join(' , ') : 'None')
    ].join('\n'));
}

function parseAction(customId) {
  const [action, ...parts] = customId.split(':');
  return { action, parts };
}

function formatStageStats(stage, stats = {}) {
  const parts = [];
  if (typeof stats.created === 'number') parts.push(`create ${stats.created}`);
  if (typeof stats.updated === 'number') parts.push(`update ${stats.updated}`);
  if (typeof stats.deleted === 'number') parts.push(`delete ${stats.deleted}`);
  if (typeof stats.repositioned === 'number') parts.push(`reposition ${stats.repositioned}`);
  if (typeof stats.overwrites === 'number') parts.push(`overwrites ${stats.overwrites}`);
  if (typeof stats.rolesSet === 'number') parts.push(`rolesSet ${stats.rolesSet}`);
  if (typeof stats.bansApplied === 'number') parts.push(`bans ${stats.bansApplied}`);
  if (typeof stats.updated === 'number' && stage === 'settings') parts.push(`settings ${stats.updated}`);
  if (typeof stats.durationMs === 'number') parts.push(`time ${stats.durationMs}ms`);
  return parts.join(' , ') || 'no-stats';
}

module.exports = {
  name: 'back',
  aliases: ['backupx'],
  description: 'Back command with sqlite storage and live protection panel',

  async execute(message, args, { BOT_OWNERS }) {
    global.BOT_OWNERS = BOT_OWNERS;
    const allowed = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
    if (!allowed) return message.reply({ embeds: [colorManager.createEmbed().setDescription('**Access :** owners only')] });

    await ensureStorage();

    const embed = colorManager.createEmbed()
      .setTitle('**Back :** Control Panel')
      .setDescription('**Choose :** action directly with ultra parallel flow');

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`back_copy:${message.guild.id}:${message.author.id}`).setLabel('Copy Version').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`back_paste:${message.guild.id}:${message.author.id}`).setLabel('Paste').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`back_list:${message.guild.id}:${message.author.id}`).setLabel('List').setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`back_protection:${message.guild.id}:${message.author.id}`).setLabel('Protection').setStyle(ButtonStyle.Primary)
    );

    await message.channel.send({ embeds: [embed], components: [row, row2] });
  },

  registerInteractionHandler(client) {
    if (listenersReady) return;
    listenersReady = true;

    client.on('interactionCreate', async (interaction) => {
      if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
      if (!interaction.customId.startsWith('back_')) return;

      if (interaction.isButton()) {
        const { action, parts } = parseAction(interaction.customId);
        const guildId = parts[0];
        const userId = parts[1];
        if (userId && interaction.user.id !== userId && !['back_restore_admin', 'back_restore_user'].includes(action)) {
          return interaction.reply({ content: '**Denied :** this panel is private', ephemeral: true });
        }

        if (action === 'back_copy') {
          const modal = new ModalBuilder().setCustomId(`back_copy_modal:${guildId}:${interaction.user.id}`).setTitle('Copy Backup');
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('name').setLabel('Version Name').setStyle(TextInputStyle.Short).setRequired(true)
          ));
          modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('mode')
              .setLabel('Mode (full/fast)')
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setPlaceholder('full = includes members/messages , fast = skip heavy parts')
          ));
          return interaction.showModal(modal);
        }

        if (action === 'back_paste') {
          const backups = await getBackups(interaction.guild.id);
          if (!backups.length) return interaction.reply({ content: '**Backups :** none found', ephemeral: true });
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`back_paste_pick:${interaction.guild.id}:${interaction.user.id}`)
            .setPlaceholder('Choose version')
            .addOptions(backups.map(b => ({ label: b.name.slice(0, 100), value: String(b.id), description: new Date(b.created_at).toLocaleString('en-US').slice(0, 100) })));
          return interaction.reply({ ephemeral: true, embeds: [colorManager.createEmbed().setDescription('**Paste :** choose version')], components: [new ActionRowBuilder().addComponents(menu)] });
        }

        if (action === 'back_paste_confirm') {
          await interaction.deferUpdate();
          const key = `${interaction.guild.id}:${interaction.user.id}`;
          const session = sessions.get(key);
          if (!session || !session.backupId || !session.types) {
            return interaction.editReply({ content: '**Session :** expired', components: [] });
          }
          const backup = await getBackupById(session.backupId);
          if (!backup) return interaction.editReply({ content: '**Backup :** not found', components: [] });

          await interaction.editReply({
            embeds: [colorManager.createEmbed().setDescription('**Paste :** started\n**Progress :** 0%')],
            components: []
          }).catch(() => null);

          const report = await enqueueGuildTask(interaction.guild.id, async () => {
            return applyBackup(
              interaction.guild,
              backup.snapshot,
              session.types,
              { removeExtra: session.types.includes('all') },
              async (progress) => {
                await interaction.editReply({
                  embeds: [
                    colorManager.createEmbed().setDescription(
                      `**Paste :** running\n${fmt('Stage', progress.stage)}\n${fmt('Progress', `${progress.percent}%`)}`
                    )
                  ],
                  components: []
                }).catch(() => null);
              }
            );
          });

          const reportPath = await writeRestoreReport(interaction.guild.id, { backupId: backup.id, backupName: backup.name, report, types: session.types });
          sessions.delete(key);

          const details = Object.entries(report.stages)
            .map(([stage, st]) => `• **${stage} :** ${formatStageStats(stage, st)}`)
            .join('\n');

          return interaction.editReply({
            embeds: [
              colorManager.createEmbed().setDescription(
                `**Paste :** complete\n${fmt('Version', backup.name)}\n${fmt('Types', report.effectiveTypes.join(' , '))}\n${fmt('Emergency Mode', report.emergencyMode ? 'ON' : 'OFF')}\n${fmt('Report File', reportPath)}\n${details || ''}`
              )
            ],
            components: []
          });
        }

        if (action === 'back_list') {
          const backups = await getBackups(interaction.guild.id);
          const desc = backups.length
            ? backups.map((b, i) => `**${i + 1} :** ${b.name}\n${fmt('Date', new Date(b.created_at).toLocaleString('en-US'))}`).join('\n\n')
            : '**Backups :** empty';
          return interaction.reply({ ephemeral: true, embeds: [colorManager.createEmbed().setTitle('**Backups :** list').setDescription(desc)] });
        }

        if (action === 'back_protection') {
          let cfg = await getConfig(interaction.guild.id);
          if (!cfg) cfg = { enabled: false, toggles: { channels: false, roles: false, settings: false }, trustedUsers: [], snapshot: null };

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`back_toggle_channels:${interaction.guild.id}:${interaction.user.id}`).setLabel('Toggle Rooms').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`back_toggle_roles:${interaction.guild.id}:${interaction.user.id}`).setLabel('Toggle Roles').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`back_toggle_settings:${interaction.guild.id}:${interaction.user.id}`).setLabel('Toggle Settings').setStyle(ButtonStyle.Secondary)
          );
          const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`back_toggle_trusted:${interaction.guild.id}:${interaction.user.id}`).setLabel('Trusted +/-').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`back_finish_protection:${interaction.guild.id}:${interaction.user.id}`).setLabel('Finish').setStyle(ButtonStyle.Success)
          );
          return interaction.reply({ ephemeral: true, embeds: [protectionEmbed(cfg)], components: [row, row2] });
        }

        if (action.startsWith('back_toggle_')) {
          const key = action.replace('back_toggle_', '');
          let cfg = await getConfig(interaction.guild.id);
          if (!cfg) cfg = { enabled: false, toggles: { channels: false, roles: false, settings: false }, trustedUsers: [], snapshot: null };

          if (key === 'trusted') {
            const modal = new ModalBuilder().setCustomId(`back_trusted_modal:${interaction.guild.id}:${interaction.user.id}`).setTitle('Trusted Users');
            modal.addComponents(new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId('trusted').setLabel('User ID to toggle').setStyle(TextInputStyle.Short).setRequired(true)
            ));
            return interaction.showModal(modal);
          }

          cfg.toggles[key] = !cfg.toggles[key];
          await saveConfig(interaction.guild.id, cfg);
          return interaction.update({ embeds: [protectionEmbed(cfg)] });
        }

        if (action === 'back_finish_protection') {
          let cfg = await getConfig(interaction.guild.id);
          if (!cfg) cfg = { enabled: true, toggles: { channels: true, roles: true, settings: true }, trustedUsers: [], snapshot: null };
          cfg.enabled = true;
          cfg.snapshot = await captureSnapshot(interaction.guild, { includeMembers: true, includeMessages: true });
          await saveConfig(interaction.guild.id, cfg);
          return interaction.update({ embeds: [protectionEmbed(cfg).setFooter({ text: 'Snapshot saved and protection enabled' })], components: [] });
        }

        if (action === 'back_restore_user') {
          const token = parts[2];
          const data = await getRestoreToken(token);
          if (!data || data.guildId !== interaction.guild.id) return interaction.reply({ content: '**Restore :** token expired', ephemeral: true });
          const member = await interaction.guild.members.fetch(data.userId).catch(() => null);
          if (!member) return interaction.reply({ content: '**Restore :** user not found', ephemeral: true });
          await member.roles.add(data.removedRoles.filter(id => interaction.guild.roles.cache.has(id))).catch(() => null);
          await deleteRestoreToken(token);
          return interaction.reply({ content: '**Restore :** user roles restored', ephemeral: true });
        }

        if (action === 'back_restore_admin') {
          const token = parts[1];
          const data = await getRestoreToken(token);
          if (!data || data.guildId !== interaction.guild.id) return interaction.reply({ content: '**Restore :** token expired', ephemeral: true });
          await Promise.all(data.adminSnapshot.map(async (r) => {
            const role = interaction.guild.roles.cache.get(r.id);
            if (role) await role.setPermissions(BigInt(r.permissions)).catch(() => null);
          }));
          await deleteRestoreToken(token);
          return interaction.reply({ content: '**Restore :** admin permissions restored', ephemeral: true });
        }
      }

      if (interaction.isModalSubmit()) {
        const { action } = parseAction(interaction.customId);

        if (action === 'back_copy_modal') {
          await interaction.deferReply({ ephemeral: true });
          const name = interaction.fields.getTextInputValue('name').trim();
          const modeRaw = (interaction.fields.getTextInputValue('mode') || 'full').trim().toLowerCase();
          const isFast = modeRaw === 'fast';
          const snapshot = await captureSnapshot(interaction.guild, {
            includeMembers: !isFast,
            includeMessages: !isFast
          });
          await saveBackup(interaction.guild, interaction.user.id, name, snapshot);
          return interaction.editReply({ embeds: [colorManager.createEmbed().setDescription(`**Copy :** done\n${fmt('Version', name)}\n${fmt('Mode', isFast ? 'FAST' : 'FULL')}\n${fmt('Roles', snapshot.roles.length)}\n${fmt('Channels', snapshot.channels.length)}\n${fmt('Members Saved', snapshot.members.length)}`)] });
        }

        if (action === 'back_trusted_modal') {
          let cfg = await getConfig(interaction.guild.id);
          if (!cfg) cfg = { enabled: false, toggles: { channels: false, roles: false, settings: false }, trustedUsers: [], snapshot: null };
          const id = interaction.fields.getTextInputValue('trusted').replace(/\D/g, '');
          if (!id) return interaction.reply({ content: '**User :** invalid id', ephemeral: true });
          if (cfg.trustedUsers.includes(id)) cfg.trustedUsers = cfg.trustedUsers.filter(x => x !== id);
          else cfg.trustedUsers.push(id);
          await saveConfig(interaction.guild.id, cfg);
          return interaction.reply({ ephemeral: true, embeds: [protectionEmbed(cfg)] });
        }
      }

      if (interaction.isStringSelectMenu()) {
        const { action, parts } = parseAction(interaction.customId);
        const guildId = parts[0];
        const userId = parts[1];

        if (userId && interaction.user.id !== userId) {
          return interaction.reply({ content: '**Denied :** private session', ephemeral: true });
        }

        if (action === 'back_paste_pick') {
          const backupId = Number(interaction.values[0]);
          sessions.set(`${interaction.guild.id}:${interaction.user.id}`, { backupId, expiresAt: Date.now() + SESSION_TTL_MS });
          const typeMenu = new StringSelectMenuBuilder()
            .setCustomId(`back_paste_types:${guildId}:${userId}`)
            .setPlaceholder('Choose what to restore')
            .setMinValues(1)
            .setMaxValues(6)
            .addOptions([
              { label: 'All', value: 'all' },
              { label: 'Critical Fast (No Members)', value: 'critical_fast' },
              { label: 'Rooms + Categories', value: 'channels' },
              { label: 'Roles', value: 'roles' },
              { label: 'Server Settings', value: 'settings' },
              { label: 'Members + Bans', value: 'members' }
            ]);
          return interaction.update({ embeds: [colorManager.createEmbed().setDescription('**Paste :** choose scope')], components: [new ActionRowBuilder().addComponents(typeMenu)] });
        }

        if (action === 'back_paste_types') {
          await interaction.deferUpdate();
          const key = `${interaction.guild.id}:${interaction.user.id}`;
          const session = sessions.get(key);
          if (!session) return interaction.editReply({ content: '**Session :** expired', components: [] });
          if (Date.now() > session.expiresAt) {
            sessions.delete(key);
            return interaction.editReply({ content: '**Session :** expired', components: [] });
          }
          const backup = await getBackupById(session.backupId);
          if (!backup) return interaction.editReply({ content: '**Backup :** not found', components: [] });

          const chosenTypes = interaction.values.includes('critical_fast')
            ? ['channels', 'roles', 'settings']
            : interaction.values;

          const plan = buildDiffPlan(interaction.guild, backup.snapshot, chosenTypes);
          sessions.set(key, { ...session, types: chosenTypes, plan });
          const planText = [
            plan.roles ? `${fmt('Roles Plan', `create ${plan.roles.create} , delete ${plan.roles.delete} , update ${plan.roles.updateOrReposition}`)}` : null,
            plan.channels ? `${fmt('Channels Plan', `create ${plan.channels.create} , delete ${plan.channels.delete} , update ${plan.channels.updateOrOverwrite}`)}` : null,
            plan.settings ? `${fmt('Settings Plan', `${plan.settings.expectedUpdates} updates`)}` : null,
            plan.members ? `${fmt('Members Plan', `roles ${plan.members.rolesSetTargets} , bans ${plan.members.bansTargets}`)}` : null
          ].filter(Boolean).join('\n');

          const confirmRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`back_paste_confirm:${interaction.guild.id}:${interaction.user.id}`)
              .setLabel('Confirm Apply')
              .setStyle(ButtonStyle.Success)
          );

          return interaction.editReply({
            embeds: [colorManager.createEmbed().setDescription(`**Pre Restore Diff :**\n${planText || '**No Plan :** empty'}`)],
            components: [confirmRow]
          });
        }
      }
    });

    client.on('channelDelete', async (channel) => {
      scheduleProtectionCheck(channel.guild, 'channel', AuditLogEvent.ChannelDelete);
    });
    client.on('channelCreate', async (channel) => {
      scheduleProtectionCheck(channel.guild, 'channel', AuditLogEvent.ChannelCreate);
    });
    client.on('roleDelete', async (role) => {
      scheduleProtectionCheck(role.guild, 'role', AuditLogEvent.RoleDelete);
    });
    client.on('roleCreate', async (role) => {
      scheduleProtectionCheck(role.guild, 'role', AuditLogEvent.RoleCreate);
    });
    client.on('guildUpdate', async (oldGuild, newGuild) => {
      scheduleProtectionCheck(newGuild, 'guild', AuditLogEvent.GuildUpdate);
    });
  }
};
