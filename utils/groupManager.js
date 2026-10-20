const { ChannelType, PermissionsBitField, ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder, MessageFlags } = require('discord.js');
const { dbManager } = require('./database');
const colorManager = require('./colorManager');
const { colorToNumber } = require('./structuredContainer');

const GROUP_CHAT_MODES = Object.freeze({ THREADS: 'threads', CHANNELS: 'channels' });
const GROUP_DEFAULTS = Object.freeze({
  enabled: false,
  chatMode: null,
  textCategoryId: null,
  voiceCategoryId: null,
  musicChannelId: null,
  logChannelId: null,
  mainRoleId: null,
  leaderRoleId: null,
  managerRoleId: null,
  systemUsers: [],
  systemRoles: [],
  extraPermissions: false,
  countAllChannels: false,
  maxMembers: 10,
  settingsVersion: 1
});
const GROUP_SETTING_KEYS = new Set([
  'enabled', 'chatMode', 'textCategoryId', 'voiceCategoryId', 'musicChannelId',
  'logChannelId', 'mainRoleId', 'leaderRoleId', 'managerRoleId', 'systemUsers', 'systemRoles',
  'extraPermissions', 'countAllChannels', 'maxMembers'
]);
const GROUP_METRICS = new Set(['messages', 'voice_ms', 'reactions']);
const MAX_ACTIVITY_AMOUNT = 1000000000000;
const locks = new Map();
let schemaPromise = null;

function safeJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}
function isSnowflake(value) { return /^\d{16,20}$/.test(String(value ?? '')); }
function ids(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).filter(isSnowflake))]; }
function normalizeSettings(row) {
  const parsed = safeJson(row?.settings_json, {});
  const source = parsed && !Array.isArray(parsed) ? parsed : {};
  const idOrNull = value => isSnowflake(value) ? String(value) : null;
  const maxMembers = Number(source.maxMembers);
  const settingsVersion = Number(source.settingsVersion);
  return {
    ...GROUP_DEFAULTS,
    ...source,
    guildId: String(row?.guild_id || source.guildId || ''),
    enabled: source.enabled === true || source.enabled === 1,
    chatMode: Object.values(GROUP_CHAT_MODES).includes(source.chatMode) ? source.chatMode : null,
    textCategoryId: idOrNull(source.textCategoryId),
    voiceCategoryId: idOrNull(source.voiceCategoryId),
    musicChannelId: idOrNull(source.musicChannelId),
    logChannelId: idOrNull(source.logChannelId),
    mainRoleId: idOrNull(source.mainRoleId),
    leaderRoleId: idOrNull(source.leaderRoleId),
    managerRoleId: idOrNull(source.managerRoleId),
    systemUsers: ids(source.systemUsers),
    systemRoles: ids(source.systemRoles),
    extraPermissions: source.extraPermissions === true || source.extraPermissions === 1,
    countAllChannels: source.countAllChannels === true || source.countAllChannels === 1,
    maxMembers: Number.isInteger(maxMembers) && maxMembers >= 1 && maxMembers <= 1000 ? maxMembers : GROUP_DEFAULTS.maxMembers,
    settingsVersion: Number.isInteger(settingsVersion) && settingsVersion >= 1 ? settingsVersion : GROUP_DEFAULTS.settingsVersion
  };
}
function booleanSetting(value, key) {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1 || value === '0' || value === '1') return Boolean(Number(value));
  throw new Error(`INVALID_SETTING:${key}`);
}
function settingId(value, key) {
  if (value == null || value === '') return null;
  if (!isSnowflake(value)) throw new Error(`INVALID_SETTING:${key}`);
  return String(value);
}
function validateSettingsPatch(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('INVALID_SETTINGS');
  const unknown = Object.keys(patch).filter(key => !GROUP_SETTING_KEYS.has(key));
  if (unknown.length) throw new Error(`INVALID_SETTING_KEY:${unknown[0]}`);
  const next = {};
  if ('enabled' in patch) next.enabled = booleanSetting(patch.enabled, 'enabled');
  if ('chatMode' in patch) {
    if (patch.chatMode !== null && !Object.values(GROUP_CHAT_MODES).includes(patch.chatMode)) throw new Error('INVALID_SETTING:chatMode');
    next.chatMode = patch.chatMode;
  }
  for (const key of ['textCategoryId', 'voiceCategoryId', 'musicChannelId', 'logChannelId', 'mainRoleId', 'leaderRoleId', 'managerRoleId']) {
    if (key in patch) next[key] = settingId(patch[key], key);
  }
  for (const key of ['systemUsers', 'systemRoles']) {
    if (key in patch) {
      if (!Array.isArray(patch[key]) || patch[key].some(value => !isSnowflake(value))) throw new Error(`INVALID_SETTING:${key}`);
      next[key] = ids(patch[key]);
    }
  }
  for (const key of ['extraPermissions', 'countAllChannels']) if (key in patch) next[key] = booleanSetting(patch[key], key);
  if ('maxMembers' in patch) {
    const maxMembers = Number(patch.maxMembers);
    if (!Number.isInteger(maxMembers) || maxMembers < 1 || maxMembers > 1000) throw new Error('INVALID_SETTING:maxMembers');
    next.maxMembers = maxMembers;
  }
  return next;
}
async function schema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await dbManager.initialize();
    await dbManager.run(`CREATE TABLE IF NOT EXISTS group_system_settings (guild_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
    await dbManager.run(`CREATE TABLE IF NOT EXISTS managed_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '',
      owner_id TEXT NOT NULL, manager_ids_json TEXT NOT NULL DEFAULT '[]', member_ids_json TEXT NOT NULL DEFAULT '[]',
      blocked_ids_json TEXT NOT NULL DEFAULT '[]', role_id TEXT, text_channel_id TEXT, thread_id TEXT, voice_channel_id TEXT,
      color TEXT DEFAULT '#5865F2', emoji TEXT, points INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
    )`);
    await dbManager.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_groups_active_name ON managed_groups(guild_id, name) WHERE status = 'active'`);
    await dbManager.run(`CREATE INDEX IF NOT EXISTS idx_managed_groups_guild_status ON managed_groups(guild_id, status, points DESC)`);
    await dbManager.run(`CREATE TABLE IF NOT EXISTS group_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, group_id INTEGER, actor_id TEXT, action TEXT NOT NULL, details_json TEXT DEFAULT '{}', created_at INTEGER NOT NULL)`);
    await dbManager.run(`CREATE TABLE IF NOT EXISTS group_points_rules (guild_id TEXT NOT NULL, metric TEXT NOT NULL, threshold INTEGER NOT NULL, points INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY(guild_id, metric))`);
    await dbManager.run(`CREATE TABLE IF NOT EXISTS group_member_points (guild_id TEXT NOT NULL, group_id INTEGER NOT NULL, user_id TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0, messages INTEGER NOT NULL DEFAULT 0, voice_ms INTEGER NOT NULL DEFAULT 0, reactions INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(guild_id, group_id, user_id))`);
    // Optional event ids make retries safe without changing the existing activity API.
    await dbManager.run(`CREATE TABLE IF NOT EXISTS group_activity_events (guild_id TEXT NOT NULL, event_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(guild_id, event_id))`);
    await dbManager.run(`CREATE INDEX IF NOT EXISTS idx_group_activity_events_created ON group_activity_events(guild_id, created_at)`);
    return true;
  })().catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}
async function withLock(key, operation) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  locks.set(key, current);
  await previous.catch(() => {});
  try { return await operation(); } finally { release(); if (locks.get(key) === current) locks.delete(key); }
}
async function getSettings(guildId) { await schema(); const row = await dbManager.get('SELECT * FROM group_system_settings WHERE guild_id = ?', [String(guildId)]); return normalizeSettings(row || { guild_id: guildId, settings_json: JSON.stringify({}) }); }
async function saveSettingsLocked(guildId, patch, actorId = null) {
  const result = await dbManager.transaction(async tx => {
    const row = await tx.get('SELECT * FROM group_system_settings WHERE guild_id = ?', [String(guildId)]);
    const current = normalizeSettings(row || { guild_id: guildId, settings_json: JSON.stringify({}) });
    const validated = validateSettingsPatch(patch);
    const next = { ...current, ...validated, guildId: undefined, updatedAt: undefined, settingsVersion: current.settingsVersion + 1 };
    delete next.guildId;
    delete next.updatedAt;
    await tx.run(`INSERT INTO group_system_settings(guild_id, settings_json, updated_at) VALUES(?,?,?) ON CONFLICT(guild_id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at`, [String(guildId), JSON.stringify(next), Date.now()]);
    return { ...GROUP_DEFAULTS, ...next, guildId: String(guildId) };
  }, 'group-settings');
  await audit(guildId, actorId, null, 'settings_update', { keys: Object.keys(patch || {}), settingsVersion: result.settingsVersion });
  return result;
}
async function saveSettings(guildId, patch, actorId = null) {
  await schema();
  return withLock(`settings:${String(guildId)}`, () => saveSettingsLocked(guildId, patch, actorId));
}
async function listGroups(guildId, includeArchived = false) { await schema(); const rows = await dbManager.all(`SELECT * FROM managed_groups WHERE guild_id = ? ${includeArchived ? '' : "AND status = 'active'"} ORDER BY points DESC, created_at ASC, id ASC`, [String(guildId)]); return rows.map(hydrate); }
function hydrate(row) { if (!row) return null; return { ...row, managerIds: ids(safeJson(row.manager_ids_json, [])), memberIds: ids(safeJson(row.member_ids_json, [])), blockedIds: ids(safeJson(row.blocked_ids_json, [])), points: Number(row.points) || 0 }; }
async function getGroup(guildId, groupId) { await schema(); return hydrate(await dbManager.get('SELECT * FROM managed_groups WHERE guild_id = ? AND id = ?', [String(guildId), Number(groupId)])); }
async function getGroupForChannel(guildId, channelId) { await schema(); const rows = await dbManager.all("SELECT * FROM managed_groups WHERE guild_id = ? AND status = 'active' AND (text_channel_id = ? OR thread_id = ? OR voice_channel_id = ?)", [String(guildId), String(channelId), String(channelId), String(channelId)]); return hydrate(rows[0]); }
async function audit(guildId, actorId, groupId, action, details = {}) { await schema(); return dbManager.run('INSERT INTO group_audit_log(guild_id, group_id, actor_id, action, details_json, created_at) VALUES(?,?,?,?,?,?)', [String(guildId), groupId == null ? null : Number(groupId), actorId ? String(actorId) : null, String(action), JSON.stringify(details), Date.now()]); }
/**
 * Best-effort delivery of a structured audit event. Logging must never make a
 * group operation fail: missing settings, deleted channels, permission errors,
 * and Discord API failures are intentionally swallowed and returned as null.
 */
async function logGroupEvent(guild, event, details = {}, actorId = null) {
  try {
    if (!guild?.id) return null;
    const settings = await getSettings(guild.id);
    if (!settings.logChannelId) return null;
    let channel = guild.channels?.cache?.get(settings.logChannelId) || null;
    if (!channel && typeof guild.channels?.fetch === 'function') channel = await guild.channels.fetch(settings.logChannelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') return null;
    const safeDetails = details && typeof details === 'object' ? details : { value: String(details) };
    const eventNames = { create: 'إنشاء قروب', update: 'تعديل القروب', delete: 'حذف قروب', member_add: 'إضافة عضو', member_remove: 'إزالة عضو', manager_update: 'تعديل المسؤولين', owner: 'تغيير المالك', block: 'منع عضو', unblock: 'السماح لعضو', rule_update: 'تعديل قاعدة نقاط', music: 'نقل بوت الميوزك', group_import: 'استيراد قروب' };
    const eventLabel = eventNames[String(event)] || String(event || 'حدث غير معروف');
    const detailText = JSON.stringify(safeDetails).slice(0, 3500);
    const actorText = actorId ? `\nالمنفذ : <@${String(actorId).replace(/[^0-9]/g, '')}>` : '';
    const container = new ContainerBuilder().setAccentColor(colorToNumber(colorManager.getColor?.() || '#5865F2'));
    const eventText = [
      new TextDisplayBuilder().setContent(`## حدث القروب : ${eventLabel.slice(0, 80)}`),
      new TextDisplayBuilder().setContent(`السيرفر : ${guild.name ? String(guild.name).slice(0, 100) : guild.id}${actorText}\n\`\`\`json\n${detailText}\n\`\`\``)
    ];
    const icon = guild.iconURL?.({ extension: 'png', size: 128 });
    if (icon) container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(eventText).setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
    else container.addTextDisplayComponents(eventText);
    return await channel.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch {
    return null;
  }
}
function isOwner(client, member) { return Boolean(member && (member.id === member.guild?.ownerId || client?.isBotOwner?.(member.id) || global.isBotOwner?.(member.id) || (global.BOT_OWNERS || []).map(String).includes(String(member.id)))); }
function isSystemManager(settings, member) { if (!member) return false; return settings.systemUsers.includes(String(member.id)) || member.roles?.cache?.some(role => settings.systemRoles.includes(String(role.id))); }
function canManageSystem(client, settings, member) { return isOwner(client, member) || isSystemManager(settings, member); }
function canManageGroup(client, settings, group, member) { if (!member || !group) return false; return canManageSystem(client, settings, member) || String(group.owner_id) === String(member.id) || group.managerIds.includes(String(member.id)); }
function channelBelongs(group, channelId) { return [group.text_channel_id, group.thread_id, group.voice_channel_id].filter(Boolean).includes(String(channelId)); }
function validateConfig(guild, settings) {
  const missing = [];
  const me = guild.members?.me;
  const requiredPermissions = ['ManageChannels', 'ManageRoles', 'ManageMessages', 'ManageThreads', 'MoveMembers', 'ManageNicknames'];
  if (me?.permissions) for (const permission of requiredPermissions) if (!me.permissions.has(permission)) missing.push(`permission:${permission}`);
  if (!settings.chatMode) missing.push('chatMode');
  const textCategory = settings.textCategoryId && guild.channels.cache.get(settings.textCategoryId);
  const voiceCategory = settings.voiceCategoryId && guild.channels.cache.get(settings.voiceCategoryId);
  if (!textCategory || textCategory.type !== ChannelType.GuildCategory) missing.push('textCategoryId');
  if (!voiceCategory || voiceCategory.type !== ChannelType.GuildCategory) missing.push('voiceCategoryId');
  if (settings.musicChannelId) { const music = guild.channels.cache.get(settings.musicChannelId); if (!music?.isVoiceBased?.()) missing.push('musicChannelId'); }
  for (const roleId of [settings.mainRoleId, settings.leaderRoleId, settings.managerRoleId].filter(Boolean)) { const role = guild.roles.cache.get(roleId); if (!role) missing.push(`role:${roleId}`); else if (me?.roles?.highest && role.position >= me.roles.highest.position) missing.push(`roleHierarchy:${roleId}`); }
  if (settings.mainRoleId) {
    const mainRole = guild.roles.cache.get(settings.mainRoleId);
    if (mainRole && (mainRole.id === guild.id || mainRole.position < 2)) missing.push('mainRolePosition');
  }
  return missing;
}
async function setSystemUser(guildId, targetId, enabled, actorId) {
  if (!isSnowflake(targetId)) throw new Error('INVALID_USER_ID');
  return withLock(`settings:${String(guildId)}`, async () => {
    const settings = await getSettings(guildId); const list = new Set(settings.systemUsers);
    enabled ? list.add(String(targetId)) : list.delete(String(targetId));
    return saveSettingsLocked(guildId, { systemUsers: [...list] }, actorId);
  });
}
async function setSystemRole(guildId, targetId, enabled, actorId) {
  if (!isSnowflake(targetId)) throw new Error('INVALID_ROLE_ID');
  return withLock(`settings:${String(guildId)}`, async () => {
    const settings = await getSettings(guildId); const list = new Set(settings.systemRoles);
    enabled ? list.add(String(targetId)) : list.delete(String(targetId));
    return saveSettingsLocked(guildId, { systemRoles: [...list] }, actorId);
  });
}
async function updateGroup(guildId, groupId, patch, actorId) { await schema(); const allowed = ['name','description','owner_id','color','emoji','role_id','text_channel_id','thread_id','voice_channel_id','manager_ids_json','member_ids_json','blocked_ids_json','points','status','updated_at','archived_at']; const keys = Object.keys(patch).filter(key => allowed.includes(key)); if (!keys.length) return getGroup(guildId, groupId); const values = keys.map(key => patch[key]); values.push(String(guildId), Number(groupId)); await dbManager.run(`UPDATE managed_groups SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE guild_id = ? AND id = ?`, values); await audit(guildId, actorId, groupId, 'group_update', { keys }); return getGroup(guildId, groupId); }
async function addMember(guildId, groupId, userId, actorId) { return withLock(`member:${guildId}:${groupId}`, async () => { const group = await getGroup(guildId, groupId); if (!group) throw new Error('GROUP_NOT_FOUND'); if (group.blockedIds.includes(String(userId))) throw new Error('USER_BLOCKED'); if (group.memberIds.length >= Number((await getSettings(guildId)).maxMembers || 10) && !group.memberIds.includes(String(userId))) throw new Error('GROUP_FULL'); const members = new Set(group.memberIds); members.add(String(userId)); await updateGroup(guildId, groupId, { member_ids_json: JSON.stringify([...members]), updated_at: Date.now() }, actorId); return [...members]; }); }
async function removeMember(guildId, groupId, userId, actorId) { return withLock(`member:${guildId}:${groupId}`, async () => { const group = await getGroup(guildId, groupId); if (!group) throw new Error('GROUP_NOT_FOUND'); if (String(group.owner_id) === String(userId)) throw new Error('OWNER_PROTECTED'); const members = group.memberIds.filter(id => id !== String(userId)); const managers = group.managerIds.filter(id => id !== String(userId)); await updateGroup(guildId, groupId, { member_ids_json: JSON.stringify(members), manager_ids_json: JSON.stringify(managers), updated_at: Date.now() }, actorId); return members; }); }
async function setManagers(guildId, groupId, managerIds, actorId) { return withLock(`member:${guildId}:${groupId}`, async () => { const group = await getGroup(guildId, groupId); if (!group) throw new Error('GROUP_NOT_FOUND'); const allowed = ids(managerIds).filter(id => group.memberIds.includes(id) && id !== String(group.owner_id)); await updateGroup(guildId, groupId, { manager_ids_json: JSON.stringify(allowed), updated_at: Date.now() }, actorId); return allowed; }); }
async function setBlocked(guildId, groupId, userId, blocked, actorId) { return withLock(`member:${guildId}:${groupId}`, async () => { const group = await getGroup(guildId, groupId); if (!group) throw new Error('GROUP_NOT_FOUND'); const set = new Set(group.blockedIds); blocked ? set.add(String(userId)) : set.delete(String(userId)); await updateGroup(guildId, groupId, { blocked_ids_json: JSON.stringify([...set]), updated_at: Date.now() }, actorId); return [...set]; }); }
async function resetPoints(guildId, groupId, actorId = null) {
  await schema();
  if (groupId != null && (!Number.isInteger(Number(groupId)) || Number(groupId) <= 0)) throw new Error('INVALID_GROUP_ID');
  return withLock(`points:${String(guildId)}`, async () => {
    await dbManager.transaction(async tx => {
      const now = Date.now();
      if (groupId == null) {
        await tx.run("UPDATE managed_groups SET points = 0, updated_at = ? WHERE guild_id = ? AND status = 'active'", [now, String(guildId)]);
        await tx.run('UPDATE group_member_points SET points = 0, messages = 0, voice_ms = 0, reactions = 0, updated_at = ? WHERE guild_id = ?', [now, String(guildId)]);
      } else {
        await tx.run('UPDATE managed_groups SET points = 0, updated_at = ? WHERE guild_id = ? AND id = ?', [now, String(guildId), Number(groupId)]);
        await tx.run('UPDATE group_member_points SET points = 0, messages = 0, voice_ms = 0, reactions = 0, updated_at = ? WHERE guild_id = ? AND group_id = ?', [now, String(guildId), Number(groupId)]);
      }
    }, 'group-points-reset');
    await audit(guildId, actorId, groupId, 'points_reset');
  });
}
async function setRule(guildId, metric, threshold, points, enabled, actorId) {
  await schema();
  // Keep compatibility with the historical five-argument form: (guild, metric, threshold, points, actor).
  if (arguments.length < 6 && typeof enabled === 'string') { actorId = enabled; enabled = true; }
  const safeMetric = String(metric);
  if (!GROUP_METRICS.has(safeMetric)) throw new Error('INVALID_METRIC');
  const safeThreshold = Number(threshold); const safePoints = Number(points);
  if (!Number.isInteger(safeThreshold) || safeThreshold < 1 || safeThreshold > 1000000000) throw new Error('INVALID_THRESHOLD');
  if (!Number.isInteger(safePoints) || safePoints < 1 || safePoints > 1000000) throw new Error('INVALID_POINTS');
  const enabledValue = enabled === undefined ? 0 : (enabled === true || enabled === 1 || enabled === '1' ? 1 : (enabled === false || enabled === 0 || enabled === '0' ? 0 : (() => { throw new Error('INVALID_RULE_ENABLED'); })()));
  return withLock(`rules:${String(guildId)}`, async () => {
    await dbManager.transaction(tx => tx.run(`INSERT INTO group_points_rules(guild_id, metric, threshold, points, enabled, updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id, metric) DO UPDATE SET threshold=excluded.threshold, points=excluded.points, enabled=excluded.enabled, updated_at=excluded.updated_at`, [String(guildId), safeMetric, safeThreshold, safePoints, enabledValue, Date.now()]), 'group-points-rule');
    await audit(guildId, actorId, null, 'points_rule_update', { metric: safeMetric, threshold: safeThreshold, points: safePoints, enabled: Boolean(enabledValue) });
  });
}
async function getRules(guildId) { await schema(); return dbManager.all('SELECT * FROM group_points_rules WHERE guild_id = ? ORDER BY metric', [String(guildId)]); }
function activityArguments(channelId, eventId) {
  if (channelId && typeof channelId === 'object') return { channelId: channelId.channelId ?? null, eventId: channelId.eventId ?? eventId ?? null };
  return { channelId, eventId };
}
async function recordActivity(guildId, userId, metric, amount, channelId = null, eventId = null) {
  await schema();
  const args = activityArguments(channelId, eventId);
  const safeMetric = String(metric);
  if (!GROUP_METRICS.has(safeMetric)) return 0;
  const numericAmount = Number(amount);
  const increment = Number.isFinite(numericAmount) ? Math.min(MAX_ACTIVITY_AMOUNT, Math.max(0, Math.floor(numericAmount))) : 0;
  if (!increment) return 0;
  const normalizedEventId = args.eventId == null || args.eventId === '' ? null : String(args.eventId);
  if (normalizedEventId && normalizedEventId.length > 255) throw new Error('INVALID_EVENT_ID');
  return withLock(`points:${String(guildId)}`, async () => dbManager.transaction(async tx => {
    if (normalizedEventId) {
      const inserted = await tx.run('INSERT OR IGNORE INTO group_activity_events(guild_id, event_id, created_at) VALUES(?,?,?)', [String(guildId), normalizedEventId, Date.now()]);
      if (!inserted.changes) return 0;
    }
    const settingsRow = await tx.get('SELECT * FROM group_system_settings WHERE guild_id = ?', [String(guildId)]);
    const settings = normalizeSettings(settingsRow || { guild_id: guildId, settings_json: JSON.stringify({}) });
    if (!settings.enabled) return 0;
    const rule = await tx.get('SELECT * FROM group_points_rules WHERE guild_id = ? AND metric = ?', [String(guildId), safeMetric]);
    const threshold = Number(rule?.threshold); const rulePoints = Number(rule?.points);
    if (!rule || Number(rule.enabled) !== 1 || !Number.isInteger(threshold) || threshold < 1 || !Number.isInteger(rulePoints) || rulePoints < 1) return 0;
    const rows = await tx.all("SELECT * FROM managed_groups WHERE guild_id = ? AND status = 'active'", [String(guildId)]);
    const column = safeMetric === 'voice_ms' ? 'voice_ms' : safeMetric === 'reactions' ? 'reactions' : 'messages';
    let awarded = 0;
    for (const row of rows) {
      const group = hydrate(row);
      if (!group.memberIds.includes(String(userId)) && String(group.owner_id) !== String(userId)) continue;
      if (!settings.countAllChannels && args.channelId && !channelBelongs(group, args.channelId)) continue;
      const previous = await tx.get('SELECT * FROM group_member_points WHERE guild_id = ? AND group_id = ? AND user_id = ?', [String(guildId), Number(group.id), String(userId)]);
      const oldAmount = Number(previous?.[column]) || 0;
      const nextAmount = Math.min(MAX_ACTIVITY_AMOUNT, oldAmount + increment);
      const beforeUnits = Math.floor(oldAmount / threshold);
      const afterUnits = Math.floor(nextAmount / threshold);
      const delta = Math.max(0, afterUnits - beforeUnits) * rulePoints;
      await tx.run(`INSERT INTO group_member_points(guild_id,group_id,user_id,${column},updated_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,group_id,user_id) DO UPDATE SET ${column}=excluded.${column},updated_at=excluded.updated_at`, [String(guildId), Number(group.id), String(userId), nextAmount, Date.now()]);
      if (delta > 0) {
        await tx.run('UPDATE group_member_points SET points = points + ?, updated_at = ? WHERE guild_id = ? AND group_id = ? AND user_id = ?', [delta, Date.now(), String(guildId), Number(group.id), String(userId)]);
        await tx.run("UPDATE managed_groups SET points = points + ?, updated_at = ? WHERE guild_id = ? AND id = ? AND status = 'active'", [delta, Date.now(), String(guildId), Number(group.id)]);
        awarded += delta;
      }
    }
    return awarded;
  }, 'group-record-activity'));
}
async function listMemberPoints(guildId, groupId, limit = 10) { await schema(); const rows = await dbManager.all('SELECT * FROM group_member_points WHERE guild_id = ? AND group_id = ? ORDER BY points DESC, updated_at ASC LIMIT ?', [String(guildId), Number(groupId), Math.max(1, Math.min(25, Number(limit) || 10))]); return rows; }
async function createGroup(guild, { name, description = '', ownerId, color = '#5865F2', emoji = null }, actorId) {
  const settings = await getSettings(guild.id); const missing = validateConfig(guild, settings); if (!settings.enabled) throw new Error('GROUP_SYSTEM_DISABLED'); if (missing.length) throw new Error(`GROUP_SETUP_REQUIRED:${missing.join(',')}`); const owner = await guild.members.fetch(String(ownerId));
  return withLock(`create:${guild.id}:${owner.id}`, async () => {
    const existing = await dbManager.get("SELECT id FROM managed_groups WHERE guild_id = ? AND owner_id = ? AND status = 'active'", [guild.id, owner.id]); if (existing) throw new Error('OWNER_ALREADY_HAS_GROUP');
    const now = Date.now(); let role = null; let text = null; let thread = null; let voice = null; const created = [];
    try {
      role = await guild.roles.create({ name: `Group・${String(name).trim().slice(0, 90)}`, color: color || '#5865F2', reason: 'Create managed group' }); created.push(['role', role]);
      if (settings.mainRoleId) {
        const mainRole = guild.roles.cache.get(settings.mainRoleId) || await guild.roles.fetch(settings.mainRoleId).catch(() => null);
        if (!mainRole || mainRole.id === guild.id || mainRole.position < 2) throw new Error('MAIN_ROLE_INVALID');
        await role.setPosition(Math.max(1, mainRole.position - 1), 'Place managed group role under Main Role');
      }
      if (!global.groupRoleGrantBypass) global.groupRoleGrantBypass = new Set();
      const ownerRoleKey = `${guild.id}:${owner.id}:${role.id}`;
      global.groupRoleGrantBypass.add(ownerRoleKey);
      setTimeout(() => global.groupRoleGrantBypass.delete(ownerRoleKey), 15000);
      await owner.roles.add(role, 'Managed group owner');
      if (settings.leaderRoleId) { const leader = guild.roles.cache.get(settings.leaderRoleId); if (leader) await owner.roles.add(leader, 'Managed group leader role'); }
      if (settings.chatMode === GROUP_CHAT_MODES.THREADS) { text = await guild.channels.create({ name: 'groups-chat', type: ChannelType.GuildText, parent: settings.textCategoryId, reason: 'Create managed groups thread parent' }); created.push(['channel', text]); thread = await text.threads.create({ name: String(name).slice(0, 100), type: ChannelType.PrivateThread, invitable: false, reason: 'Create managed group thread' }); created.push(['thread', thread]); }
      else { text = await guild.channels.create({ name: `📝・${String(name).slice(0, 90)}`, type: ChannelType.GuildText, parent: settings.textCategoryId, reason: 'Create managed group text channel' }); created.push(['channel', text]); }
      voice = await guild.channels.create({ name: `🔊・${String(name).slice(0, 90)}`, type: ChannelType.GuildVoice, parent: settings.voiceCategoryId, reason: 'Create managed group voice channel' }); created.push(['voice', voice]);
      const overwrites = [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }, { id: role.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] }];
      await text.permissionOverwrites.set(overwrites, 'Secure managed group text space').catch(error => { throw Object.assign(new Error('GROUP_TEXT_PERMISSIONS_FAILED'), { cause: error }); });
      await voice.permissionOverwrites.set(overwrites, 'Secure managed group voice space').catch(error => { throw Object.assign(new Error('GROUP_VOICE_PERMISSIONS_FAILED'), { cause: error }); });
      const row = await dbManager.run(`INSERT INTO managed_groups(guild_id,name,description,owner_id,manager_ids_json,member_ids_json,blocked_ids_json,role_id,text_channel_id,thread_id,voice_channel_id,color,emoji,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [guild.id, String(name).trim().slice(0, 100), String(description).slice(0, 1000), owner.id, '[]', JSON.stringify([owner.id]), '[]', role.id, text.id, thread?.id || null, voice.id, color || '#5865F2', emoji, now, now]);
      const group = await getGroup(guild.id, row.id ?? row.lastID); await audit(guild.id, actorId || owner.id, group.id, 'group_create', { roleId: role.id, textId: text.id, threadId: thread?.id, voiceId: voice.id }); return group;
    } catch (error) { for (const [, resource] of created.reverse()) await resource?.delete?.('Rollback incomplete group creation').catch(() => {}); throw error; }
  });
}
async function deleteGroup(guild, groupId, actorId) { return withLock(`delete:${guild.id}:${groupId}`, async () => { const group = await getGroup(guild.id, groupId); if (!group) throw new Error('GROUP_NOT_FOUND'); const idsToDelete = [group.thread_id, group.text_channel_id, group.voice_channel_id]; for (const id of idsToDelete) { if (!id) continue; const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null); if (channel) await channel.delete('Delete managed group').catch(() => {}); } const role = group.role_id && (guild.roles.cache.get(group.role_id) || await guild.roles.fetch(group.role_id).catch(() => null)); if (role) await role.delete('Delete managed group').catch(() => {}); await dbManager.run("UPDATE managed_groups SET status='deleted', archived_at=?, updated_at=? WHERE guild_id=? AND id=?", [Date.now(), Date.now(), guild.id, Number(groupId)]); await audit(guild.id, actorId, groupId, 'group_delete'); return true; }); }
module.exports = { GROUP_CHAT_MODES, GROUP_DEFAULTS, schema, getSettings, saveSettings, listGroups, getGroup, getGroupForChannel, audit, logGroupEvent, isOwner, isSystemManager, canManageSystem, canManageGroup, channelBelongs, validateConfig, setSystemUser, setSystemRole, updateGroup, addMember, removeMember, setManagers, setBlocked, resetPoints, setRule, getRules, recordActivity, listMemberPoints, createGroup, deleteGroup };
