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
  AuditLogEvent,
  EmbedBuilder
} = require("discord.js");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const colorManager = require("../utils/colorManager");
const { getDatabase } = require("../utils/database");

const { getBackupsDir } = require('../utils/storagePaths');
const backupsDir = getBackupsDir('json-fallback');
const sessions = new Map();
const protectionDebounce = new Map();
let listenersReady = false;

// PERFORMANCE CONFIGURATION (Optimized for stability)
const DEFAULT_CONCURRENCY = 20; 
const SESSION_TTL_MS = 1000 * 60 * 15;
const MAX_API_RETRIES = 3;
const DEFAULT_AVATAR = "https://cdn.discordapp.com/embed/avatars/0.png";
const PERIODIC_SNAPSHOT_INTERVAL = 1000 * 60 * 60;
const MASS_DELETE_WINDOW_MS = 1000 * 60;
const MASS_DELETE_THRESHOLD_RATIO = 0.5;
const massDeleteTracker = new Map();
const POST_RESTORE_VALIDATION_DELAY = 1000 * 60;
const activeRestoreOperations = new Map();

// --- HELPER FUNCTIONS ---
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
  return (fn) =>
    new Promise((resolve, reject) => {
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
    try {
      return await fn();
    } catch (error) {
      const status = error?.status || error?.code;
      const retryAfterMs = Math.ceil((error?.retryAfter || error?.rawError?.retry_after || 0) * 1000);
      if (status !== 429 && status < 500) throw error;
      if (attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs || 150 * 2 ** attempt));
      attempt += 1;
    }
  }
}

async function ensureStorage() {
  await fs.promises.mkdir(backupsDir, { recursive: true });
  const db = getDatabase();
  await db.run(`CREATE TABLE IF NOT EXISTS guild_backups (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, user_id TEXT, name TEXT, snapshot_json TEXT, hash TEXT, created_at INTEGER)`);
  await db.run(`CREATE TABLE IF NOT EXISTS guild_protection (guild_id TEXT PRIMARY KEY, config_json TEXT, updated_at INTEGER)`);
  await db.run(`CREATE TABLE IF NOT EXISTS punished_users (guild_id TEXT, user_id TEXT, roles_json TEXT, PRIMARY KEY (guild_id, user_id))`);

  try {
    const tableInfo = await db.all(`PRAGMA table_info(guild_backups)`);
    if (!tableInfo.some(col => col.name === 'hash')) {
      await db.run(`ALTER TABLE guild_backups ADD COLUMN hash TEXT`);
    }
  } catch (err) { console.error("Migration failed:", err); }
}

function generateSnapshotHash(data) {
  const essential = {
    roles: data.roles.map(r => ({ n: r.name, c: r.color, p: r.permissions })),
    channels: data.channels.map(c => ({ n: c.name, t: c.type, p: c.parentId, o: c.permissionOverwrites })),
    settings: data.settings
  };
  return crypto.createHash('md5').update(JSON.stringify(essential)).digest('hex');
}

async function getConfig(guildId) {
  await ensureStorage();
  const db = getDatabase();
  const row = await db.get("SELECT config_json FROM guild_protection WHERE guild_id = ?", [guildId]);
  return row ? JSON.parse(row.config_json) : { enabled: false, toggles: { channels: true, roles: true, settings: true }, trustedUsers: [], snapshot: null };
}

async function saveConfig(guildId, config) {
  await ensureStorage();
  const db = getDatabase();
  await db.run("INSERT OR REPLACE INTO guild_protection (guild_id, config_json, updated_at) VALUES (?, ?, ?)", [guildId, JSON.stringify(config), Date.now()]);
}

// --- ASSET CAPTURE & RESTORE ---
async function fetchChannelMessages(channel) {
  const unstableTypes = [ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildMedia, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread];
  if (!channel.isTextBased() || unstableTypes.includes(channel.type)) return [];
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    return messages.map((m) => ({
      username: m.author.username,
      avatar: m.author.displayAvatarURL(),
      content: m.content,
      embeds: m.embeds,
      attachments: m.attachments.map((a) => a.url),
      timestamp: m.createdTimestamp,
    })).reverse();
  } catch { return []; }
}

async function captureSnapshot(guild, options = {}) {
  const { includeMessages = false, includeMembers = false, includeAssets = false } = options;
  if (includeMembers) await guild.members.fetch().catch(() => null);
  const [bans, emojis, stickers] = await Promise.all([
    guild.bans.fetch().catch(() => new Map()),
    includeAssets ? guild.emojis.fetch().catch(() => new Map()) : Promise.resolve(new Map()),
    includeAssets ? guild.stickers.fetch().catch(() => new Map()) : Promise.resolve(new Map()),
  ]);

  const roles = guild.roles.cache.filter((r) => !r.managed && r.id !== guild.id).sort((a, b) => a.position - b.position).map((r) => ({
    id: r.id, name: r.name, color: r.color, hoist: r.hoist, permissions: r.permissions.bitfield.toString(), mentionable: r.mentionable, position: r.position,
  }));

  const channels = [];
  for (const ch of guild.channels.cache.filter((c) => !c.isThread()).values()) {
    const messages = includeMessages ? await fetchChannelMessages(ch) : [];
    channels.push({
      id: ch.id, name: ch.name, type: ch.type, parentId: ch.parentId || null, position: ch.rawPosition, topic: ch.topic || null, nsfw: !!ch.nsfw,
      permissionOverwrites: ch.permissionOverwrites?.cache?.map((ow) => ({ id: ow.id, type: ow.type, allow: ow.allow.bitfield.toString(), deny: ow.deny.bitfield.toString() })) || [],
      messages,
    });
  }

  return { guildId: guild.id, guildName: guild.name, createdAt: Date.now(), settings: { name: guild.name, verificationLevel: guild.verificationLevel, explicitContentFilter: guild.explicitContentFilter, defaultMessageNotifications: guild.defaultMessageNotifications, afkTimeout: guild.afkTimeout }, roles, channels, members: includeMembers ? guild.members.cache.map((m) => ({ id: m.id, roles: m.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.id) })) : [], bans: [...bans.values()].map((b) => ({ id: b.user.id, reason: b.reason || null })), emojis: [...emojis.values()].map((e) => ({ name: e.name, url: e.url })), stickers: [...stickers.values()].map((s) => ({ name: s.name, url: s.url, description: s.description, tags: s.tags })) };
}



function findBestChannelMatch(guild, snapshotChannel, expectedParentId = null) {
  const sameType = guild.channels.cache.filter((c) => c.type === snapshotChannel.type && c.name === snapshotChannel.name);
  if (!sameType.size) return null;

  if (expectedParentId) {
    const exactParent = sameType.find((c) => c.parentId === expectedParentId);
    if (exactParent) return exactParent;
  }

  if (sameType.size === 1) return sameType.first();
  return null;
}

async function applyBackup(guild, snapshot, types, options = {}) {
  const start = Date.now();
  const limit = createLimiter(DEFAULT_CONCURRENCY);
  const all = types.includes("all");
  const targetId = options.targetId;
  const isPasteMode = options.isPasteMode || false;

  if (all || types.includes("settings")) {
    const s = snapshot.settings;
    await withDiscordRetry(() => guild.edit({ name: s.name, verificationLevel: s.verificationLevel, explicitContentFilter: s.explicitContentFilter, defaultMessageNotifications: s.defaultMessageNotifications, afkTimeout: s.afkTimeout })).catch(() => null);
  }

  if (all || types.includes("roles")) {
    const rolesToProcess = targetId ? snapshot.roles.filter((r) => r.id === targetId) : snapshot.roles;
    const createdRoles = [];
    await Promise.all(rolesToProcess.map((sr) => limit(async () => {
      let role = guild.roles.cache.find((r) => r.name === sr.name && !r.managed);
      if (!role) role = await withDiscordRetry(() => guild.roles.create({ name: sr.name, color: sr.color, hoist: sr.hoist, permissions: BigInt(sr.permissions), mentionable: sr.mentionable })).catch(() => null);
      else await withDiscordRetry(() => role.edit({ color: sr.color, hoist: sr.hoist, permissions: BigInt(sr.permissions), mentionable: sr.mentionable })).catch(() => null);
      if (role) createdRoles.push({ role, position: sr.position });
    })));

    if (createdRoles.length > 0) {
      try {
        const botHighestRole = guild.members.me.roles.highest;
        // Fix: Use target position (r.position) for validation
        const sortedPositions = createdRoles.filter((r) => r.position < botHighestRole.position).map((r) => ({ role: r.role, position: r.position }));
        if (sortedPositions.length > 0) await withDiscordRetry(() => guild.roles.setPositions(sortedPositions)).catch(() => null);
      } catch (e) { console.error("Role position restore failed:", e); }
    }

    if (!targetId) {
      const snapshotRoleNames = new Set(snapshot.roles.map((r) => r.name));
      await Promise.all(
        guild.roles.cache
          .filter((r) => !r.managed && r.id !== guild.id && !snapshotRoleNames.has(r.name))
          .map((r) => limit(() => r.delete("Strict snapshot reconcile: extra role").catch(() => null)))
      );
    }
  }

  if (all || types.includes("channels")) {
    const channelsToProcess = targetId ? snapshot.channels.filter((c) => c.id === targetId) : snapshot.channels;
    const categoryMap = new Map();
    const requiredCategoryIds = new Set(
      channelsToProcess
        .map((c) => c.parentId)
        .filter(Boolean)
    );
    const cats = snapshot.channels.filter((c) =>
      c.type === ChannelType.GuildCategory && (!targetId || requiredCategoryIds.has(c.id) || c.id === targetId)
    );
    await Promise.all(cats.map((sc) => limit(async () => {
      let cat = guild.channels.cache.find((c) => c.name === sc.name && c.type === ChannelType.GuildCategory);
      if (!cat) cat = await withDiscordRetry(() => guild.channels.create({ name: sc.name, type: ChannelType.GuildCategory, position: sc.position })).catch(() => null);
      else await withDiscordRetry(() => cat.edit({ position: sc.position })).catch(() => null);
      if (cat) categoryMap.set(sc.id, cat.id);
    })));

    const others = channelsToProcess.filter((c) => c.type !== ChannelType.GuildCategory);
    await Promise.all(others.map((sc) => limit(async () => {
      const parentId = sc.parentId ? categoryMap.get(sc.parentId) || null : null;
      let ch = findBestChannelMatch(guild, sc, parentId);
      let wasCreated = false;
      if (!ch) {
        ch = await withDiscordRetry(() => guild.channels.create({ name: sc.name, type: sc.type, parent: parentId, position: sc.position, topic: sc.topic || undefined, nsfw: sc.nsfw })).catch(() => null);
        wasCreated = true;
      } else await withDiscordRetry(() => ch.edit({ parent: parentId, position: sc.position, topic: sc.topic || undefined, nsfw: sc.nsfw })).catch(() => null);

      if (ch && sc.permissionOverwrites) {
        const filteredOverwrites = sc.permissionOverwrites.filter((ow) => ow.type === 0 ? guild.roles.cache.has(ow.id) : true);
        await withDiscordRetry(() => ch.permissionOverwrites.set(filteredOverwrites.map((ow) => ({ id: ow.id, type: ow.type, allow: BigInt(ow.allow), deny: BigInt(ow.deny) })))).catch(() => null);
      }

      if (isPasteMode && wasCreated && ch && sc.messages?.length && ch.isTextBased() && ![ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildMedia].includes(ch.type)) {
        let webhook;
        try {
          const existingWebhooks = await ch.fetchWebhooks().catch(() => new Map());
          webhook = existingWebhooks.find(wh => wh.name === "Backup-Restore") || await withDiscordRetry(() => ch.createWebhook({ name: "Backup-Restore", avatar: guild.iconURL() || DEFAULT_AVATAR }));
          for (const msg of sc.messages) {
            try { await withDiscordRetry(() => webhook.send({ content: msg.content || " ", username: msg.username, avatarURL: msg.avatar, embeds: msg.embeds, files: (msg.attachments || []).slice(0, 10) })); await new Promise((resolve) => setTimeout(resolve, 400)); }
            catch (msgErr) { console.error("Message send failed:", msgErr); }
          }
        } catch (e) { console.error("Webhook operation failed:", e); }
      }
    })));

    if (!targetId) {
      const snapshotChannelSignatures = new Set(
        channelsToProcess.map((c) => `${c.type}:${c.name}:${c.parentId || "root"}`)
      );
      await Promise.all(
        guild.channels.cache
          .filter((c) => !c.isThread())
          .map((c) => limit(async () => {
            const signature = `${c.type}:${c.name}:${c.parentId || "root"}`;
            if (!snapshotChannelSignatures.has(signature)) {
              await c.delete("Strict snapshot reconcile: extra channel").catch(() => null);
            }
          }))
      );
    }
  }

  if (all || types.includes("assets")) {
    if (snapshot.emojis) await Promise.all(snapshot.emojis.map((e) => limit(() => guild.emojis.create({ attachment: e.url, name: e.name }).catch(() => null))));
    if (snapshot.stickers) await Promise.all(snapshot.stickers.map((s) => limit(() => guild.stickers.create({ file: s.url, name: s.name, tags: s.tags, description: s.description }).catch(() => null))));
  }

  if ((all || types.includes("members")) && snapshot.members && isPasteMode) {
    // Fix: Map Optimization for Role Lookup
    const snapRolesMap = new Map(snapshot.roles.map(r => [r.id, r.name]));
    await Promise.all(snapshot.members.map((sm) => limit(async () => {
      const member = await guild.members.fetch(sm.id).catch(() => null);
      if (member) {
        const roles = sm.roles.map((rId) => {
          const roleName = snapRolesMap.get(rId);
          return guild.roles.cache.find((r) => r.name === roleName);
        }).filter((r) => r && r.id !== guild.id && !r.managed);
        await member.roles.set(roles).catch(() => null);
      }
    })));
  }

  if (all || types.includes("bans")) { if (snapshot.bans) await Promise.all(snapshot.bans.map((b) => limit(() => guild.bans.create(b.id, { reason: b.reason }).catch(() => null)))); }
  return { durationMs: Date.now() - start };
}

function markRestoreOperation(guildId, userId) {
  const key = `${guildId}:${userId}`;
  activeRestoreOperations.set(key, Date.now() + 120000);
  return key;
}

function isRestoreOperationActive(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const exp = activeRestoreOperations.get(key);
  if (!exp) return false;
  if (Date.now() > exp) {
    activeRestoreOperations.delete(key);
    return false;
  }
  return true;
}

function clearRestoreOperation(key) {
  if (key) activeRestoreOperations.delete(key);
}

// --- PROTECTION FUNCTIONS (Restored) ---
async function cleanupOldBackups(guildId) {
  const db = getDatabase();
  const backups = await db.all("SELECT id FROM guild_backups WHERE guild_id = ? AND user_id = ? ORDER BY id DESC", [guildId, 'auto-system']);
  if (backups.length > 1) {
    const toDelete = backups.slice(1).map(b => b.id);
    await db.run(`DELETE FROM guild_backups WHERE id IN (${toDelete.join(',')})`);
  }
}

async function punishUser(guild, userId, reason) {
  try {
    const db = getDatabase();
    const member = await guild.members.fetch(userId).catch(() => null);
    const roles = member ? member.roles.cache.filter((r) => r.id !== guild.id && !r.managed).map((r) => r.id) : [];
    await db.run("INSERT OR REPLACE INTO punished_users (guild_id, user_id, roles_json) VALUES (?, ?, ?)", [guild.id, userId, JSON.stringify(roles)]);
    if (!member || member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
    await member.roles.set([]).catch(() => null);
    const ownersToNotify = [guild.ownerId, ...(guild.client.config?.owners || [])];
    const embed = colorManager.createEmbed().setTitle("🚨 Protection Triggered").setDescription(`User <@${userId}> was punished.\nReason: ${reason}`).setTimestamp();
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`back_restore_user:${guild.id}:${userId}`).setLabel("Restore Roles").setStyle(ButtonStyle.Success));
    for (const ownerId of [...new Set(ownersToNotify)]) {
      const owner = await guild.client.users.fetch(ownerId).catch(() => null);
      if (owner) await owner.send({ embeds: [embed], components: [row] }).catch(() => null);
    }
  } catch (error) { console.error("Punishment failed:", error); }
}

async function fetchAuditLogWithRetry(guild, event, targetId, retries = 6) {
  for (let i = 0; i < retries; i++) {
    const logs = await guild.fetchAuditLogs({ limit: 6, type: event }).catch(() => null);
    const entry = logs?.entries.find((e) => {
      const isRecent = Date.now() - e.createdTimestamp < 10000;
      if (!isRecent) return false;
      if (!targetId) return true;
      return e.targetId === targetId;
    });
    if (entry) return entry;
    await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}

async function scheduleProtectionCheck(guild, type, event, affectedElement = null) {
  const targetId = affectedElement?.id;
  const key = `${guild.id}:${type}:${event}:${targetId}`;
  if (protectionDebounce.has(key)) return;
  protectionDebounce.set(key, true);
  setTimeout(() => protectionDebounce.delete(key), 2000);
  try {
    const cfg = await getConfig(guild.id);
    if (!cfg.enabled || !cfg.toggles[type === "channel" ? "channels" : type === "role" ? "roles" : "settings"]) return;

    const isImmediateRestoreEvent = (event === AuditLogEvent.ChannelDelete || event === AuditLogEvent.RoleDelete) && cfg.snapshot && targetId;
    if (isImmediateRestoreEvent) {
      await applyBackup(guild, cfg.snapshot, [type === "channel" ? "channels" : "roles"], { targetId, isPasteMode: false });
      schedulePostRestoreValidation(guild, cfg.snapshot, [type === "channel" ? "channels" : "roles"], { targetId });
    }

    const entry = await fetchAuditLogWithRetry(guild, event, targetId);
    if (entry?.executorId && isRestoreOperationActive(guild.id, entry.executorId)) return;
    const isOwner = guild.client.config?.owners?.includes(entry?.executorId) || entry?.executorId === guild.ownerId;
    const isTrusted = await isTrustedExecutor(guild, cfg, entry?.executorId);
    if (entry && (isOwner || isTrusted)) {
      if (
        isTrusted &&
        !isOwner &&
        event === AuditLogEvent.ChannelDelete &&
        entry.executorId !== guild.client.user.id &&
        cfg.snapshot?.channels?.length
      ) {
        const baselineCount = cfg.snapshot.channels.filter((c) => c.type !== ChannelType.GuildCategory).length;
        const reachedMassDelete = registerMassDelete(guild.id, entry.executorId, baselineCount);
        if (reachedMassDelete) {
          await applyBackup(guild, cfg.snapshot, ["channels"], { isPasteMode: false });
          schedulePostRestoreValidation(guild, cfg.snapshot, ["channels"]);
          return;
        }
      }

      if (isTrusted && entry.executorId !== guild.client.user.id) {
        await createAutoSnapshotIfChanged(guild, "trusted-change").catch(() => null);
      }
      return;
    }

    if (!entry) {
      if (cfg.snapshot) {
        const scope = [type === "channel" ? "channels" : type === "role" ? "roles" : "settings"];
        await applyBackup(guild, cfg.snapshot, scope, { targetId, isPasteMode: false });
        schedulePostRestoreValidation(guild, cfg.snapshot, scope, { targetId });
      }
      return;
    }

    if (entry.executorId === guild.client.user.id) return;
    if (event === AuditLogEvent.ChannelCreate || event === AuditLogEvent.RoleCreate) {
      const canDelete = type === "role" ? guild.members.me.roles.highest.position > affectedElement.position : true;
      const neutralizeRole =
        type === "role" && !canDelete
          ? affectedElement.edit({
              permissions: 0n,
              mentionable: false,
              hoist: false,
              color: 0,
              name: `blocked-${affectedElement.name}`.slice(0, 100),
            }).catch(() => null)
          : Promise.resolve();
      Promise.all([
        punishUser(guild, entry.executorId, `Unauthorized ${type} creation`),
        canDelete ? affectedElement.delete().catch(() => null) : neutralizeRole,
      ]);
    } else {
      const scope = [type === "channel" ? "channels" : type === "role" ? "roles" : "settings"];
      Promise.all([
        punishUser(guild, entry.executorId, `Unauthorized ${type} action`),
        applyBackup(guild, cfg.snapshot, scope, { targetId, isPasteMode: false }),
      ]).finally(() => schedulePostRestoreValidation(guild, cfg.snapshot, scope, { targetId }));
    }
  } catch (error) { console.error("Protection check failed:", error); }
}



function isBackManager(userId, guild, client) {
  return userId === guild.ownerId || (client.config?.owners || []).includes(userId);
}

async function createAutoSnapshotIfChanged(guild, reason = "periodic") {
  const cfg = await getConfig(guild.id);
  if (!cfg.enabled) return false;
  const snap = await captureSnapshot(guild, { includeMessages: false, includeMembers: false, includeAssets: false });
  const hash = generateSnapshotHash(snap);
  const db = getDatabase();
  const lastBackup = await db.get("SELECT hash FROM guild_backups WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1", [guild.id, 'auto-system']);
  if (lastBackup?.hash === hash) return false;

  cfg.snapshot = snap;
  await saveConfig(guild.id, cfg);
  await db.run(
    "INSERT INTO guild_backups (guild_id, user_id, name, snapshot_json, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [guild.id, 'auto-system', `${reason}_${Date.now()}`, JSON.stringify(snap), hash, Date.now()]
  );
  await cleanupOldBackups(guild.id);
  return true;
}



async function isTrustedExecutor(guild, cfg, executorId) {
  if (!executorId) return false;
  if (executorId === guild.client.user.id) return false;
  const trusted = cfg.trustedUsers || [];
  if (trusted.includes(executorId)) return true;
  const member = await guild.members.fetch(executorId).catch(() => null);
  if (!member) return false;
  return member.roles.cache.some((role) => trusted.includes(role.id));
}

function registerMassDelete(guildId, executorId, baselineCount) {
  const key = `${guildId}:${executorId}`;
  const now = Date.now();
  const tracked = massDeleteTracker.get(key) || [];
  const filtered = tracked.filter((t) => now - t < MASS_DELETE_WINDOW_MS);
  filtered.push(now);
  massDeleteTracker.set(key, filtered);
  const threshold = Math.max(1, Math.ceil(baselineCount * MASS_DELETE_THRESHOLD_RATIO));
  return filtered.length >= threshold;
}



function schedulePostRestoreValidation(guild, snapshot, types, options = {}) {
  setTimeout(async () => {
    try {
      await runSmartValidation(guild, snapshot, types, options);
    } catch (err) {
      console.error(`Post-restore validation failed for guild ${guild.id}:`, err);
    }
  }, POST_RESTORE_VALIDATION_DELAY);
}

async function runSmartValidation(guild, snapshot, types, options = {}) {
  const targetId = options.targetId || null;
  const limit = createLimiter(DEFAULT_CONCURRENCY);

  if (types.includes("settings")) {
    const s = snapshot.settings;
    const needsSettingsFix =
      guild.name !== s.name ||
      guild.verificationLevel !== s.verificationLevel ||
      guild.explicitContentFilter !== s.explicitContentFilter ||
      guild.defaultMessageNotifications !== s.defaultMessageNotifications ||
      guild.afkTimeout !== s.afkTimeout;

    if (needsSettingsFix) {
      await withDiscordRetry(() => guild.edit({
        name: s.name,
        verificationLevel: s.verificationLevel,
        explicitContentFilter: s.explicitContentFilter,
        defaultMessageNotifications: s.defaultMessageNotifications,
        afkTimeout: s.afkTimeout,
      })).catch(() => null);
    }
  }

  if (types.includes("roles")) {
    const rolesToValidate = targetId ? snapshot.roles.filter((r) => r.id === targetId) : snapshot.roles;
    await Promise.all(rolesToValidate.map((sr) => limit(async () => {
      let role = guild.roles.cache.find((r) => !r.managed && r.name === sr.name);
      if (!role) {
        await withDiscordRetry(() => guild.roles.create({
          name: sr.name,
          color: sr.color,
          hoist: sr.hoist,
          permissions: BigInt(sr.permissions),
          mentionable: sr.mentionable,
        })).catch(() => null);
        return;
      }

      const needsRoleFix =
        role.color !== sr.color ||
        role.hoist !== sr.hoist ||
        role.mentionable !== sr.mentionable ||
        !role.permissions.equals(BigInt(sr.permissions));

      if (needsRoleFix) {
        await withDiscordRetry(() => role.edit({
          color: sr.color,
          hoist: sr.hoist,
          permissions: BigInt(sr.permissions),
          mentionable: sr.mentionable,
        })).catch(() => null);
      }
    })));
  }

  if (types.includes("channels")) {
    await resolveChannelConflicts(guild, snapshot, targetId);

    const channelsToValidate = (targetId ? snapshot.channels.filter((c) => c.id === targetId) : snapshot.channels);
    const categoryMap = new Map();

    await Promise.all(channelsToValidate.filter((c) => c.type === ChannelType.GuildCategory).map((sc) => limit(async () => {
      let cat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === sc.name);
      if (!cat) {
        cat = await withDiscordRetry(() => guild.channels.create({
          name: sc.name,
          type: ChannelType.GuildCategory,
          position: sc.position,
        })).catch(() => null);
      }
      else {
        await withDiscordRetry(() => cat.edit({ position: sc.position })).catch(() => null);
      }
      if (cat) categoryMap.set(sc.id, cat.id);
    })));

    await Promise.all(channelsToValidate.filter((c) => c.type !== ChannelType.GuildCategory).map((sc) => limit(async () => {
      const parentId = sc.parentId ? categoryMap.get(sc.parentId) || null : null;
      let ch = findBestChannelMatch(guild, sc, parentId);

      if (!ch) {
        await withDiscordRetry(() => guild.channels.create({
          name: sc.name,
          type: sc.type,
          parent: parentId,
          position: sc.position,
          topic: sc.topic || undefined,
          nsfw: sc.nsfw,
        })).catch(() => null);
        return;
      }

      const needsChannelFix =
        ch.parentId !== parentId ||
        ch.rawPosition !== sc.position ||
        (ch.topic || null) !== (sc.topic || null) ||
        Boolean(ch.nsfw) !== Boolean(sc.nsfw);

      if (needsChannelFix) {
        await withDiscordRetry(() => ch.edit({
          parent: parentId,
          position: sc.position,
          topic: sc.topic || undefined,
          nsfw: sc.nsfw,
        })).catch(() => null);
      }
    })));
  }
}

async function resolveChannelConflicts(guild, snapshot, targetId = null) {
  const targetChannels = (targetId ? snapshot.channels.filter((c) => c.id === targetId) : snapshot.channels)
    .filter((c) => c.type !== ChannelType.GuildCategory);

  for (const sc of targetChannels) {
    const parentSnapshot = sc.parentId ? snapshot.channels.find((x) => x.id === sc.parentId) : null;
    const expectedParentId = parentSnapshot
      ? guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === parentSnapshot.name)?.id || null
      : null;

    const exactMatches = guild.channels.cache
      .filter((c) => c.type === sc.type && c.name === sc.name && c.parentId === expectedParentId)
      .sort((a, b) => a.rawPosition - b.rawPosition);

    if (exactMatches.size <= 1) continue;

    let i = 1;
    for (const duplicate of exactMatches.values()) {
      if (i === 1) {
        i += 1;
        continue;
      }
      const safeName = `${sc.name}-dup-${i - 1}`.slice(0, 100);
      await duplicate.edit({ name: safeName }).catch(() => null);
      i += 1;
    }
  }
}

// --- MODULE EXPORT ---
module.exports = {
  name: "back",
  aliases: ["backupx"],
  async execute(message, args, client) {
    if (!isBackManager(message.author.id, message.guild, client)) return message.reply("**Denied :** owner only");
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`back_copy:${message.guild.id}:${message.author.id}`).setLabel("Copy").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`back_paste:${message.guild.id}:${message.author.id}`).setLabel("Paste").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`back_protection:${message.guild.id}:${message.author.id}`).setLabel("Protection").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`back_list:${message.guild.id}:${message.author.id}`).setLabel("List").setStyle(ButtonStyle.Secondary)
    );
    await message.channel.send({
      embeds: [colorManager.createEmbed().setTitle("**Back :** Control Panel").addFields(
        { name: "Status", value: "جاهز", inline: true },
        { name: "Snapshot", value: "غير محدد", inline: true },
        { name: "Last Action", value: "لا يوجد", inline: false },
      )],
      components: [row]
    });
  },

  registerInteractionHandler(client) {
    return this.init(client);
  },

  async init(client) {
    if (listenersReady) return;
    listenersReady = true;

    setInterval(() => {
      const now = Date.now();
      for (const [key, session] of sessions.entries()) { if (session.expiresAt < now) sessions.delete(key); }
    }, 1000 * 60 * 30);

    setInterval(async () => {
      for (const guild of client.guilds.cache.values()) {
        try {
          await createAutoSnapshotIfChanged(guild, "periodic");
        } catch (err) {
          console.error(`Periodic snapshot failed for guild ${guild.id}:`, err);
        }
      }
    }, PERIODIC_SNAPSHOT_INTERVAL);

    client.on("interactionCreate", async (interaction) => {
      try {
        const [action, guildId, userId] = interaction.customId?.split(":") || [];
        const db = getDatabase();
        let handled = false;
        if (action === "back_restore_user") {
        const targetGuild = client.guilds.cache.get(guildId);
        if (!targetGuild) return interaction.reply("Server not found.");
        if (!isBackManager(interaction.user.id, targetGuild, client)) return interaction.reply({ content: "Owner only.", ephemeral: true });
        const row = await db.get("SELECT roles_json FROM punished_users WHERE guild_id = ? AND user_id = ?", [guildId, userId]);
        if (!row) return interaction.reply({ content: "Data not found.", ephemeral: true });
        const member = await targetGuild.members.fetch(userId).catch(() => null);
        if (member) {
          await member.roles.set(JSON.parse(row.roles_json));
          await db.run("DELETE FROM punished_users WHERE guild_id = ? AND user_id = ?", [guildId, userId]);
          handled = true; return interaction.update({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor(0x00ff00).addFields({ name: "✅ Status", value: `Restored by <@${interaction.user.id}>` })], components: [] });
        } else {
          await db.run("DELETE FROM punished_users WHERE guild_id = ? AND user_id = ?", [guildId, userId]);
          return interaction.reply({ content: "Member not found. Data cleared.", ephemeral: true });
        }
      }
      if (interaction.customId?.startsWith("back_") && !isBackManager(interaction.user.id, interaction.guild, client)) { handled = true; return interaction.reply({ content: "Owner only.", ephemeral: true }); }
      if (interaction.isButton()) {
        if (action === "back_copy") {
          const modal = new ModalBuilder().setCustomId(`back_modal_copy:${guildId}:${userId}`).setTitle("اسم النسخة");
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder().setCustomId("backup_name").setLabel("اسم النسخة").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)
            )
          );
          handled = true; return interaction.showModal(modal);
        }
        if (action === "back_paste") {
          const list = await db.all("SELECT id, name FROM guild_backups WHERE guild_id = ? ORDER BY id DESC LIMIT 25", [interaction.guild.id]);
          if (!list.length) { handled = true; return interaction.reply({ content: "No backups", ephemeral: true }); }
          const menu = new StringSelectMenuBuilder().setCustomId(`back_paste_pick:${guildId}:${userId}`).setPlaceholder("Select backup").addOptions(list.map((b) => ({ label: b.name, value: String(b.id) })));
          handled = true; return interaction.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
        }
        if (action === "back_protection") {
          const cfg = await getConfig(interaction.guild.id);
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`back_prot_toggle:${guildId}:${userId}`).setLabel(cfg.enabled ? "Disable" : "Enable").setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`back_prot_snap:${guildId}:${userId}`).setLabel("Set Snapshot").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`back_prot_add_trusted:${guildId}:${userId}`).setLabel("Add Trusted").setStyle(ButtonStyle.Secondary)
          );
          const embed = colorManager.createEmbed().setTitle("Protection Status").setDescription(`Status: ${cfg.enabled ? "🟢" : "🔴"}\nTrusted Users: ${cfg.trustedUsers.length ? cfg.trustedUsers.map((u) => interaction.guild.roles.cache.has(u) ? `<@&${u}>` : `<@${u}>`).join(", ") : "None"}`);
          const rows = [row];
          if (cfg.trustedUsers.length) {
            const delMenu = new StringSelectMenuBuilder().setCustomId(`back_prot_del_trusted:${guildId}:${userId}`).setPlaceholder("Select user to remove").addOptions(cfg.trustedUsers.slice(0, 25).map((u) => ({ label: interaction.guild.roles.cache.has(u) ? `Role:${interaction.guild.roles.cache.get(u).name}` : `User:${u}`, value: u })));
            rows.push(new ActionRowBuilder().addComponents(delMenu));
          }
          handled = true; return interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
        }
        if (action === "back_prot_toggle") {
          const cfg = await getConfig(interaction.guild.id);
          cfg.enabled = !cfg.enabled;
          await saveConfig(interaction.guild.id, cfg);
          handled = true; return interaction.update({ content: `Protection ${cfg.enabled ? "Enabled" : "Disabled"}` });
        }
        if (action === "back_prot_snap") {
          const list = await db.all("SELECT id, name FROM guild_backups WHERE guild_id = ? ORDER BY id DESC LIMIT 25", [interaction.guild.id]);
          if (!list.length) {
            const cfg = await getConfig(interaction.guild.id);
            cfg.snapshot = await captureSnapshot(interaction.guild, { includeMessages: false, includeMembers: false, includeAssets: false });
            await saveConfig(interaction.guild.id, cfg);
            handled = true; return interaction.update({ content: "No copy found, created live snapshot as baseline.", components: [] });
          }
          const menu = new StringSelectMenuBuilder()
            .setCustomId(`back_prot_pick_snapshot:${guildId}:${userId}`)
            .setPlaceholder("اختر النسخة الأساسية للحماية")
            .addOptions(list.map((b) => ({ label: b.name, value: String(b.id) })));
          handled = true; return interaction.update({ content: "اختر النسخة:", components: [new ActionRowBuilder().addComponents(menu)] });
        }
        if (action === "back_prot_add_trusted") {
          const modal = new ModalBuilder().setCustomId(`back_modal_trusted:${guildId}`).setTitle("Add Trusted User");
          modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("user_id").setLabel("User/Role ID").setStyle(TextInputStyle.Short).setRequired(true)));
          handled = true; return interaction.showModal(modal);
        }
        if (action === "back_paste_confirm") {
          const session = sessions.get(`${interaction.guild.id}:${interaction.user.id}`);
          if (!session) { handled = true; return interaction.reply({ content: "Expired", ephemeral: true }); }
          await interaction.deferUpdate();
          const row = await db.get("SELECT snapshot_json FROM guild_backups WHERE id = ?", [session.backupId]);
          if (!row) { handled = true; return interaction.editReply({ content: "Backup not found.", components: [] }); }
          const operationKey = markRestoreOperation(interaction.guild.id, interaction.user.id);
          const report = await applyBackup(interaction.guild, JSON.parse(row.snapshot_json), session.types, { isPasteMode: true });
          clearRestoreOperation(operationKey);
          sessions.delete(`${interaction.guild.id}:${interaction.user.id}`);
          handled = true; return interaction.editReply({ content: `Restore complete in ${report.durationMs}ms`, components: [] });
        }
        if (action === "back_list") {
          const list = await db.all("SELECT id, name, created_at FROM guild_backups WHERE guild_id = ? ORDER BY id DESC LIMIT 25", [interaction.guild.id]);
          if (!list.length) { handled = true; return interaction.reply({ content: "لا توجد نسخ محفوظة.", ephemeral: true }); }
          const menu = new StringSelectMenuBuilder().setCustomId(`back_list_pick:${guildId}:${userId}`).setPlaceholder("اختر نسخة لعرض التفاصيل").addOptions(list.map((b) => ({ label: b.name.slice(0, 100), value: String(b.id), description: new Date(b.created_at).toLocaleString("ar-SA") })));
          handled = true; return interaction.reply({ components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
        }
      }
      if (interaction.isStringSelectMenu()) {
        if (action === "back_paste_pick") {
          sessions.set(`${interaction.guild.id}:${interaction.user.id}`, { backupId: Number(interaction.values[0]), expiresAt: Date.now() + SESSION_TTL_MS });
          const menu = new StringSelectMenuBuilder().setCustomId(`back_paste_types:${guildId}:${userId}`).setPlaceholder("Scope").addOptions([
            { label: "All", value: "all" }, { label: "Channels & 100 Messages (Webhook)", value: "channels" }, { label: "Roles", value: "roles" }, { label: "Members", value: "members" }, { label: "Assets (Emoji/Stickers)", value: "assets" },
          ]);
          handled = true; return interaction.update({ components: [new ActionRowBuilder().addComponents(menu)] });
        }
        if (action === "back_paste_types") {
          const session = sessions.get(`${interaction.guild.id}:${interaction.user.id}`);
          if (!session) { handled = true; return interaction.reply({ content: "Session expired, pick backup again.", ephemeral: true }); }
          sessions.set(`${interaction.guild.id}:${interaction.user.id}`, { ...session, types: interaction.values });
          const confirm = new ButtonBuilder().setCustomId(`back_paste_confirm:${guildId}:${userId}`).setLabel("Confirm").setStyle(ButtonStyle.Success);
          handled = true; return interaction.update({ components: [new ActionRowBuilder().addComponents(confirm)] });
        }
        if (action === "back_prot_del_trusted") {
          const cfg = await getConfig(guildId);
          cfg.trustedUsers = cfg.trustedUsers.filter((u) => u !== interaction.values[0]);
          await saveConfig(guildId, cfg);
          handled = true; return interaction.update({ content: `Removed <@${interaction.values[0]}> from trusted.`, components: [] });
        }
        if (action === "back_prot_pick_snapshot") {
          const row = await db.get("SELECT snapshot_json, name, created_at FROM guild_backups WHERE id = ? AND guild_id = ?", [interaction.values[0], guildId]);
          if (!row) { handled = true; return interaction.update({ content: "النسخة غير موجودة.", components: [] }); }
          const cfg = await getConfig(guildId);
          cfg.snapshot = JSON.parse(row.snapshot_json);
          await saveConfig(guildId, cfg);
          handled = true; return interaction.update({ content: `تم اعتماد النسخة الأساسية: ${row.name}`, components: [] });
        }
        if (action === "back_list_pick") {
          const row = await db.get("SELECT snapshot_json, name, created_at FROM guild_backups WHERE id = ? AND guild_id = ?", [interaction.values[0], guildId]);
          if (!row) { handled = true; return interaction.update({ content: "النسخة غير موجودة.", components: [] }); }
          const snap = JSON.parse(row.snapshot_json);
          const embed = colorManager.createEmbed()
            .setTitle(`تفاصيل النسخة: ${row.name}`)
            .addFields(
              { name: "التاريخ", value: new Date(row.created_at).toLocaleString("ar-SA"), inline: true },
              { name: "الرومات", value: String(snap.channels?.length || 0), inline: true },
              { name: "الرولات", value: String(snap.roles?.length || 0), inline: true },
              { name: "الأعضاء المخزنين", value: String(snap.members?.length || 0), inline: true },
              { name: "الإيموجي", value: String(snap.emojis?.length || 0), inline: true },
              { name: "الستيكرز", value: String(snap.stickers?.length || 0), inline: true }
            );
          handled = true; return interaction.update({ embeds: [embed], components: [] });
        }
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("back_modal_trusted")) {
        const gId = interaction.customId.split(":")[1];
        const tId = interaction.fields.getTextInputValue("user_id").trim();
        const targetGuild = client.guilds.cache.get(gId) || interaction.guild;
        const role = targetGuild?.roles?.cache?.get(tId) || null;
        const user = await client.users.fetch(tId).catch(() => null);
        if (!role && !user) { handled = true; return interaction.reply({ content: "Invalid ID. Send user ID or role ID.", ephemeral: true }); }
        const cfg = await getConfig(gId);
        if (!cfg.trustedUsers.includes(tId)) cfg.trustedUsers.push(tId);
        await saveConfig(gId, cfg);
        handled = true; return interaction.reply({ content: role ? `Added <@&${tId}> to trusted.` : `Added <@${tId}> to trusted.`, ephemeral: true });
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("back_modal_copy")) {
        const [_, gId] = interaction.customId.split(":");
        await interaction.deferReply({ ephemeral: true });
        const customName = interaction.fields.getTextInputValue("backup_name").trim();
        const snap = await captureSnapshot(interaction.guild, { includeMessages: true, includeMembers: true, includeAssets: true });
        const hash = generateSnapshotHash(snap);
        const dateLabel = new Date().toISOString();
        await db.run("INSERT INTO guild_backups (guild_id, user_id, name, snapshot_json, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)", [interaction.guild.id, interaction.user.id, customName, JSON.stringify(snap), hash, Date.now()]);
        handled = true; return interaction.editReply(`تم حفظ النسخة **${customName}**\nالوصف: ${dateLabel}`);
      }

      if (interaction.customId?.startsWith("back_") && !handled) {
        return interaction.reply({ content: "Unsupported or expired interaction.", ephemeral: true });
      }
    } catch (error) {
      console.error("Back interaction handler failed:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Interaction failed. Try again.", ephemeral: true }).catch(() => null);
      }
    }
    });

    client.on("channelDelete", (c) => scheduleProtectionCheck(c.guild, "channel", AuditLogEvent.ChannelDelete, c));
    client.on("channelCreate", (c) => scheduleProtectionCheck(c.guild, "channel", AuditLogEvent.ChannelCreate, c));
    client.on("channelUpdate", (oldC, newC) => {
      const channelChanged =
        oldC.name !== newC.name ||
        oldC.parentId !== newC.parentId ||
        oldC.topic !== newC.topic ||
        oldC.nsfw !== newC.nsfw ||
        oldC.rawPosition !== newC.rawPosition ||
        !oldC.permissionOverwrites.cache.equals(newC.permissionOverwrites.cache);
      if (channelChanged) scheduleProtectionCheck(newC.guild, "channel", AuditLogEvent.ChannelUpdate, newC);
    });
    client.on("roleDelete", (r) => scheduleProtectionCheck(r.guild, "role", AuditLogEvent.RoleDelete, r));
    client.on("roleCreate", (r) => scheduleProtectionCheck(r.guild, "role", AuditLogEvent.RoleCreate, r));
    client.on("roleUpdate", (oldR, newR) => {
      const roleChanged =
        oldR.name !== newR.name ||
        oldR.color !== newR.color ||
        oldR.hoist !== newR.hoist ||
        oldR.mentionable !== newR.mentionable ||
        oldR.position !== newR.position ||
        !oldR.permissions.equals(newR.permissions);
      if (roleChanged) scheduleProtectionCheck(newR.guild, "role", AuditLogEvent.RoleUpdate, newR);
    });
    client.on("guildUpdate", (oldG, newG) => scheduleProtectionCheck(newG, "settings", AuditLogEvent.GuildUpdate));
  },
};
