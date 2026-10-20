const { ChannelType, PermissionsBitField } = require('discord.js');
const { dbManager } = require('./database');

const GROUP_CHAT_MODES = Object.freeze({ THREADS: 'threads', CHANNELS: 'channels' });
const GROUP_DEFAULTS = Object.freeze({
  enabled: false,
  chatMode: null,
  textCategoryId: null,
  voiceCategoryId: null,
  musicChannelId: null,
  logChannelId: null,
  leaderRoleId: null,
  managerRoleId: null,
  systemUsers: [],
  systemRoles: [],
  extraPermissions: false,
  countAllChannels: false,
  maxMembers: 10,
  settingsVersion: 1
});
const locks = new Map();
let schemaPromise = null;

function safeJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}
function ids(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).filter(v => /^\d{16,20}$/.test(v)))]; }
function normalizeSettings(row) {
  const parsed = safeJson(row?.settings_json, {});
  return { ...GROUP_DEFAULTS, ...parsed, guildId: String(row?.guild_id || parsed.guildId || '') , systemUsers: ids(parsed.systemUsers), systemRoles: ids(parsed.systemRoles) };
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
async function saveSettings(guildId, patch, actorId = null) {
  await schema();
  const current = await getSettings(guildId); const next = { ...current, ...patch, guildId: undefined, systemUsers: ids(patch.systemUsers ?? current.systemUsers), systemRoles: ids(patch.systemRoles ?? current.systemRoles), updatedAt: undefined };
  delete next.guildId; delete next.updatedAt;
  await dbManager.run(`INSERT INTO group_system_settings(guild_id, settings_json, updated_at) VALUES(?,?,?) ON CONFLICT(guild_id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at`, [String(guildId), JSON.stringify(next), Date.now()]);
  await audit(guildId, actorId, null, 'settings_update', { keys: Object.keys(patch) });
  return { ...GROUP_DEFAULTS, ...next, guildId: String(guildId) };
}
async function listGroups(guildId, includeArchived = false) { await schema(); const rows = await dbManager.all(`SELECT * FROM managed_groups WHERE guild_id = ? ${includeArchived ? '' : "AND status = 'active'"} ORDER BY points DESC, created_at ASC, id ASC`, [String(guildId)]); return rows.map(hydrate); }
function hydrate(row) { if (!row) return null; return { ...row, managerIds: ids(safeJson(row.manager_ids_json, [])), memberIds: ids(safeJson(row.member_ids_json, [])), blockedIds: ids(safeJson(row.blocked_ids_json, [])), points: Number(row.points) || 0 }; }
async function getGroup(guildId, groupId) { await schema(); return hydrate(await dbManager.get('SELECT * FROM managed_groups WHERE guild_id = ? AND id = ?', [String(guildId), Number(groupId)])); }
async function audit(guildId, actorId, groupId, action, details = {}) { await schema(); return dbManager.run('INSERT INTO group_audit_log(guild_id, group_id, actor_id, action, details_json, created_at) VALUES(?,?,?,?,?,?)', [String(guildId), groupId == null ? null : Number(groupId), actorId ? String(actorId) : null, String(action), JSON.stringify(details), Date.now()]); }
function isOwner(client, member) { return Boolean(member && (member.id === member.guild?.ownerId || client?.isBotOwner?.(member.id) || global.isBotOwner?.(member.id) || (global.BOT_OWNERS || []).map(String).includes(String(member.id)))); }
function isSystemManager(settings, member) { if (!member) return false; return settings.systemUsers.includes(String(member.id)) || member.roles?.cache?.some(role => settings.systemRoles.includes(String(role.id))); }
function canManageSystem(client, settings, member) { return isOwner(client, member) || isSystemManager(settings, member); }
function canManageGroup(client, settings, group, member) { if (!member || !group) return false; return canManageSystem(client, settings, member) || String(group.owner_id) === String(member.id) || group.managerIds.includes(String(member.id)); }
function channelBelongs(group, channelId) { return [group.text_channel_id, group.thread_id, group.voice_channel_id].filter(Boolean).includes(String(channelId)); }
function validateConfig(guild, settings) {
  const missing = [];
  if (!settings.chatMode) missing.push('chatMode');
  const textCategory = settings.textCategoryId && guild.channels.cache.get(settings.textCategoryId);
  const voiceCategory = settings.voiceCategoryId && guild.channels.cache.get(settings.voiceCategoryId);
  if (!textCategory || textCategory.type !== ChannelType.GuildCategory) missing.push('textCategoryId');
  if (!voiceCategory || voiceCategory.type !== ChannelType.GuildCategory) missing.push('voiceCategoryId');
  if (settings.musicChannelId) { const music = guild.channels.cache.get(settings.musicChannelId); if (!music?.isVoiceBased?.()) missing.push('musicChannelId'); }
  return missing;
}
async function setSystemUser(guildId, targetId, enabled, actorId) { const settings = await getSettings(guildId); const list = new Set(settings.systemUsers); enabled ? list.add(String(targetId)) : list.delete(String(targetId)); return saveSettings(guildId, { systemUsers: [...list] }, actorId); }
async function setSystemRole(guildId, targetId, enabled, actorId) { const settings = await getSettings(guildId); const list = new Set(settings.systemRoles); enabled ? list.add(String(targetId)) : list.delete(String(targetId)); return saveSettings(guildId, { systemRoles: [...list] }, actorId); }
async function updateGroup(guildId, groupId, patch, actorId) { await schema(); const allowed = ['name','description','owner_id','color','emoji','role_id','text_channel_id','thread_id','voice_channel_id','manager_ids_json','member_ids_json','blocked_ids_json','points','status','updated_at','archived_at']; const keys = Object.keys(patch).filter(key => allowed.includes(key)); if (!keys.length) return getGroup(guildId, groupId); const values = keys.map(key => patch[key]); values.push(String(guildId), Number(groupId)); await dbManager.run(`UPDATE managed_groups SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE guild_id = ? AND id = ?`, values); await audit(guildId, actorId, groupId, 'group_update', { keys }); return getGroup(guildId, groupId); }
async function addMember(guildId, groupId, userId, actorId) { const group = await getGroup(guildId, groupId); if (!group) throw new Error('GROUP_NOT_FOUND'); if (group.blockedIds.includes(String(userId))) throw new Error('USER_BLOCKED'); const members = new Set(group.memberIds); members.add(String(userId)); await updateGroup(guildId, groupId, { member_ids_json: JSON.stringify([...members]), updated_at: Date.now() }, actorId); return [...members]; }
async function removeMember(guildId, groupId, userId, actorId) { const group = await getGroup(guildId, groupId); if (!group) throw new Error('GROUP_NOT_FOUND'); if (String(group.owner_id) === String(userId)) throw new Error('OWNER_PROTECTED'); const members = group.memberIds.filter(id => id !== String(userId)); const managers = group.managerIds.filter(id => id !== String(userId)); await updateGroup(guildId, groupId, { member_ids_json: JSON.stringify(members), manager_ids_json: JSON.stringify(managers), updated_at: Date.now() }, actorId); return members; }
async function setManagers(guildId, groupId, managerIds, actorId) { const group = await getGroup(guildId, groupId); if (!group) throw new Error('GROUP_NOT_FOUND'); const allowed = ids(managerIds).filter(id => group.memberIds.includes(id) && id !== String(group.owner_id)); await updateGroup(guildId, groupId, { manager_ids_json: JSON.stringify(allowed), updated_at: Date.now() }, actorId); return allowed; }
async function resetPoints(guildId, groupId, actorId = null) { await schema(); if (groupId == null) await dbManager.run('UPDATE managed_groups SET points = 0, updated_at = ? WHERE guild_id = ? AND status = \'active\'', [Date.now(), String(guildId)]); else await dbManager.run('UPDATE managed_groups SET points = 0, updated_at = ? WHERE guild_id = ? AND id = ?', [Date.now(), String(guildId), Number(groupId)]); await audit(guildId, actorId, groupId, 'points_reset'); }
async function setRule(guildId, metric, threshold, points, enabled, actorId) { await schema(); const safeThreshold = Math.max(1, Math.min(1000000000, Math.floor(Number(threshold)))); const safePoints = Math.max(1, Math.min(1000000, Math.floor(Number(points)))); await dbManager.run(`INSERT INTO group_points_rules(guild_id, metric, threshold, points, enabled, updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id, metric) DO UPDATE SET threshold=excluded.threshold, points=excluded.points, enabled=excluded.enabled, updated_at=excluded.updated_at`, [String(guildId), String(metric), safeThreshold, safePoints, enabled ? 1 : 0, Date.now()]); await audit(guildId, actorId, null, 'points_rule_update', { metric, threshold: safeThreshold, points: safePoints, enabled: Boolean(enabled) }); }
async function getRules(guildId) { await schema(); return dbManager.all('SELECT * FROM group_points_rules WHERE guild_id = ? ORDER BY metric', [String(guildId)]); }
async function recordActivity(guildId, userId, metric, amount, channelId = null) {
  await schema();
  const settings = await getSettings(guildId);
  const groups = await listGroups(guildId);
  const rules = Object.fromEntries((await getRules(guildId)).map(row => [row.metric, row]));
  const rule = rules[metric];
  if (!rule || !Number(rule.enabled)) return 0;
  let awarded = 0;
  for (const group of groups) {
    if (!group.memberIds.includes(String(userId)) && String(group.owner_id) !== String(userId)) continue;
    if (!settings.countAllChannels && channelId && !channelBelongs(group, channelId)) continue;
    const column = metric === 'voice_ms' ? 'voice_ms' : metric === 'reactions' ? 'reactions' : 'messages';
    const previous = await dbManager.get('SELECT * FROM group_member_points WHERE guild_id = ? AND group_id = ? AND user_id = ?', [String(guildId), Number(group.id), String(userId)]);
    const oldAmount = Number(previous?.[column]) || 0;
    const nextAmount = oldAmount + Math.max(0, Math.floor(Number(amount) || 0));
    const beforeUnits = Math.floor(oldAmount / Number(rule.threshold));
    const afterUnits = Math.floor(nextAmount / Number(rule.threshold));
    const delta = Math.max(0, afterUnits - beforeUnits) * Number(rule.points);
    await dbManager.run(`INSERT INTO group_member_points(guild_id,group_id,user_id,${column},updated_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,group_id,user_id) DO UPDATE SET ${column}=excluded.${column},updated_at=excluded.updated_at`, [String(guildId), Number(group.id), String(userId), nextAmount, Date.now()]);
    if (delta > 0) {
      await dbManager.run('UPDATE group_member_points SET points = points + ?, updated_at = ? WHERE guild_id = ? AND group_id = ? AND user_id = ?', [delta, Date.now(), String(guildId), Number(group.id), String(userId)]);
      await dbManager.run('UPDATE managed_groups SET points = points + ?, updated_at = ? WHERE guild_id = ? AND id = ?', [delta, Date.now(), String(guildId), Number(group.id)]);
      awarded += delta;
    }
  }
  return awarded;
}
async function listMemberPoints(guildId, groupId, limit = 10) { await schema(); const rows = await dbManager.all('SELECT * FROM group_member_points WHERE guild_id = ? AND group_id = ? ORDER BY points DESC, updated_at ASC LIMIT ?', [String(guildId), Number(groupId), Math.max(1, Math.min(25, Number(limit) || 10))]); return rows; }
async function createGroup(guild, { name, description = '', ownerId, color = '#5865F2', emoji = null }, actorId) {
  const settings = await getSettings(guild.id); const missing = validateConfig(guild, settings); if (!settings.enabled) throw new Error('GROUP_SYSTEM_DISABLED'); if (missing.length) throw new Error(`GROUP_SETUP_REQUIRED:${missing.join(',')}`); const owner = await guild.members.fetch(String(ownerId));
  return withLock(`create:${guild.id}:${owner.id}`, async () => {
    const existing = await dbManager.get("SELECT id FROM managed_groups WHERE guild_id = ? AND owner_id = ? AND status = 'active'", [guild.id, owner.id]); if (existing) throw new Error('OWNER_ALREADY_HAS_GROUP');
    const now = Date.now(); let role = null; let text = null; let thread = null; let voice = null; const created = [];
    try {
      role = await guild.roles.create({ name: `Group・${String(name).trim().slice(0, 90)}`, color: color || '#5865F2', reason: 'Create managed group' }); created.push(['role', role]);
      if (!global.groupRoleGrantBypass) global.groupRoleGrantBypass = new Set();
      const ownerRoleKey = `${guild.id}:${owner.id}:${role.id}`;
      global.groupRoleGrantBypass.add(ownerRoleKey);
      setTimeout(() => global.groupRoleGrantBypass.delete(ownerRoleKey), 15000);
      await owner.roles.add(role, 'Managed group owner');
      if (settings.leaderRoleId) { const leader = guild.roles.cache.get(settings.leaderRoleId); if (leader) await owner.roles.add(leader, 'Managed group leader role'); }
      if (settings.chatMode === GROUP_CHAT_MODES.THREADS) { text = await guild.channels.create({ name: 'groups-chat', type: ChannelType.GuildText, parent: settings.textCategoryId, reason: 'Create managed groups thread parent' }); created.push(['channel', text]); thread = await text.threads.create({ name: String(name).slice(0, 100), type: ChannelType.PrivateThread, invitable: false, reason: 'Create managed group thread' }); created.push(['thread', thread]); }
      else { text = await guild.channels.create({ name: `📝・${String(name).slice(0, 90)}`, type: ChannelType.GuildText, parent: settings.textCategoryId, reason: 'Create managed group text channel' }); created.push(['channel', text]); }
      voice = await guild.channels.create({ name: `🔊・${String(name).slice(0, 90)}`, type: ChannelType.GuildVoice, parent: settings.voiceCategoryId, reason: 'Create managed group voice channel' }); created.push(['voice', voice]);
      const row = await dbManager.run(`INSERT INTO managed_groups(guild_id,name,description,owner_id,manager_ids_json,member_ids_json,blocked_ids_json,role_id,text_channel_id,thread_id,voice_channel_id,color,emoji,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [guild.id, String(name).trim().slice(0, 100), String(description).slice(0, 1000), owner.id, '[]', JSON.stringify([owner.id]), '[]', role.id, text.id, thread?.id || null, voice.id, color || '#5865F2', emoji, now, now]);
      const group = await getGroup(guild.id, row.lastID); await audit(guild.id, actorId || owner.id, group.id, 'group_create', { roleId: role.id, textId: text.id, threadId: thread?.id, voiceId: voice.id }); return group;
    } catch (error) { for (const [, resource] of created.reverse()) await resource?.delete?.('Rollback incomplete group creation').catch(() => {}); throw error; }
  });
}
async function deleteGroup(guild, groupId, actorId) { return withLock(`delete:${guild.id}:${groupId}`, async () => { const group = await getGroup(guild.id, groupId); if (!group) throw new Error('GROUP_NOT_FOUND'); const idsToDelete = [group.thread_id, group.text_channel_id, group.voice_channel_id]; for (const id of idsToDelete) { if (!id) continue; const channel = guild.channels.cache.get(id) || await guild.channels.fetch(id).catch(() => null); if (channel) await channel.delete('Delete managed group').catch(() => {}); } const role = group.role_id && (guild.roles.cache.get(group.role_id) || await guild.roles.fetch(group.role_id).catch(() => null)); if (role) await role.delete('Delete managed group').catch(() => {}); await dbManager.run("UPDATE managed_groups SET status='deleted', archived_at=?, updated_at=? WHERE guild_id=? AND id=?", [Date.now(), Date.now(), guild.id, Number(groupId)]); await audit(guild.id, actorId, groupId, 'group_delete'); return true; }); }
module.exports = { GROUP_CHAT_MODES, GROUP_DEFAULTS, schema, getSettings, saveSettings, listGroups, getGroup, audit, isOwner, isSystemManager, canManageSystem, canManageGroup, channelBelongs, validateConfig, setSystemUser, setSystemRole, updateGroup, addMember, removeMember, setManagers, resetPoints, setRule, getRules, recordActivity, listMemberPoints, createGroup, deleteGroup };
