const { ChannelType, PermissionsBitField, ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder, MessageFlags } = require('discord.js');
const { dbManager } = require('./database');
const colorManager = require('./colorManager');
const { colorToNumber } = require('./structuredContainer');
const { randomBytes } = require('node:crypto');

const GROUP_CHAT_MODES = Object.freeze({ THREADS: 'threads', CHANNELS: 'channels' });
const GROUP_DEFAULTS = Object.freeze({
  enabled: false,
  chatMode: null,
  textCategoryId: null,
  voiceCategoryId: null,
  musicChannelId: null,
  logChannelId: null,
  topChannelId: null,
  adminControlChannelId: null,
  memberControlChannelId: null,
  mainRoleId: null,
  leaderRoleId: null,
  managerRoleId: null,
  systemUsers: [],
  systemRoles: [],
  extraPermissions: false,
  countAllChannels: false,
  minMessageLength: 0,
  maxMembers: 10,
  settingsVersion: 1
});
const GROUP_SETTING_KEYS = new Set([
  'enabled', 'chatMode', 'textCategoryId', 'voiceCategoryId', 'musicChannelId',
  'logChannelId', 'topChannelId', 'adminControlChannelId', 'memberControlChannelId', 'mainRoleId', 'leaderRoleId', 'managerRoleId', 'systemUsers', 'systemRoles',
  'extraPermissions', 'countAllChannels', 'minMessageLength', 'maxMembers'
]);
const GROUP_METRICS = new Set(['messages', 'voice_ms', 'reactions']);
const MAX_ACTIVITY_AMOUNT = 1000000000000;
const locks = new Map();
let schemaPromise = null;
let lastActivityEventPruneAt = 0;

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
  const valueOf = (key, ...aliases) => [key, ...aliases].map(name => source[name]).find(value => value !== undefined);
  const idOrNull = value => isSnowflake(value) ? String(value) : null;
  const maxMembers = Number(source.maxMembers);
  const settingsVersion = Number(source.settingsVersion);
  return {
    ...GROUP_DEFAULTS,
    ...source,
    guildId: String(row?.guild_id || source.guildId || ''),
    enabled: source.enabled === true || source.enabled === 1,
    chatMode: Object.values(GROUP_CHAT_MODES).includes(valueOf('chatMode', 'chat_mode')) ? valueOf('chatMode', 'chat_mode') : null,
    textCategoryId: idOrNull(valueOf('textCategoryId', 'text_category_id')),
    voiceCategoryId: idOrNull(valueOf('voiceCategoryId', 'voice_category_id')),
    musicChannelId: idOrNull(valueOf('musicChannelId', 'music_channel_id')),
    logChannelId: idOrNull(valueOf('logChannelId', 'log_channel_id')),
    topChannelId: idOrNull(valueOf('topChannelId', 'top_channel_id')),
    adminControlChannelId: idOrNull(valueOf('adminControlChannelId', 'admin_control_channel_id')),
    memberControlChannelId: idOrNull(valueOf('memberControlChannelId', 'member_control_channel_id')),
    mainRoleId: idOrNull(valueOf('mainRoleId', 'main_role_id')),
    leaderRoleId: idOrNull(valueOf('leaderRoleId', 'leader_role_id')),
    managerRoleId: idOrNull(valueOf('managerRoleId', 'manager_role_id')),
    systemUsers: ids(valueOf('systemUsers', 'system_users')),
    systemRoles: ids(valueOf('systemRoles', 'system_roles')),
    extraPermissions: valueOf('extraPermissions', 'extra_permissions') === true || valueOf('extraPermissions', 'extra_permissions') === 1,
    countAllChannels: valueOf('countAllChannels', 'count_all_channels') === true || valueOf('countAllChannels', 'count_all_channels') === 1,
    minMessageLength: Number.isInteger(Number(valueOf('minMessageLength', 'min_message_length'))) && Number(valueOf('minMessageLength', 'min_message_length')) >= 0 && Number(valueOf('minMessageLength', 'min_message_length')) <= 2000 ? Number(valueOf('minMessageLength', 'min_message_length')) : GROUP_DEFAULTS.minMessageLength,
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
  for (const key of ['textCategoryId', 'voiceCategoryId', 'musicChannelId', 'logChannelId', 'topChannelId', 'adminControlChannelId', 'memberControlChannelId', 'mainRoleId', 'leaderRoleId', 'managerRoleId']) {
    if (key in patch) next[key] = settingId(patch[key], key);
  }
  for (const key of ['systemUsers', 'systemRoles']) {
    if (key in patch) {
      if (!Array.isArray(patch[key]) || patch[key].some(value => !isSnowflake(value))) throw new Error(`INVALID_SETTING:${key}`);
      next[key] = ids(patch[key]);
    }
  }
  for (const key of ['extraPermissions', 'countAllChannels']) if (key in patch) next[key] = booleanSetting(patch[key], key);
  if ('minMessageLength' in patch) {
    const minMessageLength = Number(patch.minMessageLength);
    if (!Number.isInteger(minMessageLength) || minMessageLength < 0 || minMessageLength > 2000) throw new Error('INVALID_SETTING:minMessageLength');
    next.minMessageLength = minMessageLength;
  }
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
    await dbManager.run(`CREATE TABLE IF NOT EXISTS group_operation_locks (lock_key TEXT PRIMARY KEY, owner_token TEXT NOT NULL, locked_until INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    await dbManager.run(`CREATE TABLE IF NOT EXISTS managed_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '',
      owner_id TEXT NOT NULL, manager_ids_json TEXT NOT NULL DEFAULT '[]', member_ids_json TEXT NOT NULL DEFAULT '[]',
      blocked_ids_json TEXT NOT NULL DEFAULT '[]', role_id TEXT, text_channel_id TEXT, thread_id TEXT, voice_channel_id TEXT,
      color TEXT DEFAULT '#5865F2', emoji TEXT, avatar_url TEXT, points INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', sync_state TEXT NOT NULL DEFAULT 'ready',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER
    )`);
    const managedGroupColumns = await dbManager.all('PRAGMA table_info(managed_groups)');
    if (!managedGroupColumns.some(column => String(column.name) === 'avatar_url')) {
      await dbManager.run(`ALTER TABLE managed_groups ADD COLUMN avatar_url TEXT`);
    }
    if (!managedGroupColumns.some(column => String(column.name) === 'sync_state')) {
      await dbManager.run(`ALTER TABLE managed_groups ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'ready'`);
    }
    if (!managedGroupColumns.some(column => String(column.name) === 'archive_json')) {
      await dbManager.run(`ALTER TABLE managed_groups ADD COLUMN archive_json TEXT`);
    }
    await dbManager.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_groups_active_name ON managed_groups(guild_id, name) WHERE status = 'active'`);
    await dbManager.run(`CREATE INDEX IF NOT EXISTS idx_managed_groups_role_lookup ON managed_groups(guild_id, role_id, status)`);
    await dbManager.run(`CREATE INDEX IF NOT EXISTS idx_managed_groups_text_lookup ON managed_groups(guild_id, text_channel_id, status)`);
    await dbManager.run(`CREATE INDEX IF NOT EXISTS idx_managed_groups_thread_lookup ON managed_groups(guild_id, thread_id, status)`);
    await dbManager.run(`CREATE INDEX IF NOT EXISTS idx_managed_groups_voice_lookup ON managed_groups(guild_id, voice_channel_id, status)`);
    await dbManager.run(`CREATE INDEX IF NOT EXISTS idx_managed_groups_guild_status ON managed_groups(guild_id, status, points DESC)`);
    await dbManager.run(`CREATE TABLE IF NOT EXISTS group_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, group_id INTEGER, actor_id TEXT, action TEXT NOT NULL, details_json TEXT DEFAULT '{}', created_at INTEGER NOT NULL)`);
    await dbManager.run(`CREATE TABLE IF NOT EXISTS group_runtime_log (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, group_id INTEGER, operation TEXT NOT NULL, level TEXT NOT NULL, details_json TEXT DEFAULT '{}', created_at INTEGER NOT NULL)`);
    await dbManager.run(`CREATE INDEX IF NOT EXISTS idx_group_audit_log_lookup ON group_audit_log(guild_id, group_id, created_at DESC)`);
    await dbManager.run(`CREATE INDEX IF NOT EXISTS idx_group_audit_log_time ON group_audit_log(guild_id, created_at DESC)`);
    await dbManager.run(`CREATE TABLE IF NOT EXISTS group_points_rules (guild_id TEXT NOT NULL, metric TEXT NOT NULL, threshold INTEGER NOT NULL, points INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY(guild_id, metric))`);
    await dbManager.run(`CREATE TABLE IF NOT EXISTS group_member_points (guild_id TEXT NOT NULL, group_id INTEGER NOT NULL, user_id TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0, messages INTEGER NOT NULL DEFAULT 0, voice_ms INTEGER NOT NULL DEFAULT 0, reactions INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(guild_id, group_id, user_id))`);
    await dbManager.run(`CREATE INDEX IF NOT EXISTS idx_group_member_points_user ON group_member_points(guild_id, user_id, group_id)`);
    // Optional event ids make retries safe without changing the existing activity API.
    await dbManager.run(`CREATE TABLE IF NOT EXISTS group_activity_events (guild_id TEXT NOT NULL, event_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(guild_id, event_id))`);
    await dbManager.run(`CREATE TABLE IF NOT EXISTS group_points_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, group_id INTEGER NOT NULL, user_id TEXT NOT NULL, metric TEXT NOT NULL, activity_amount INTEGER NOT NULL DEFAULT 0, points_delta INTEGER NOT NULL DEFAULT 0, member_before INTEGER NOT NULL DEFAULT 0, member_after INTEGER NOT NULL DEFAULT 0, group_before INTEGER NOT NULL DEFAULT 0, group_after INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL, event_id TEXT, created_at INTEGER NOT NULL)`);
    await dbManager.run(`CREATE INDEX IF NOT EXISTS idx_group_points_ledger_lookup ON group_points_ledger(guild_id, group_id, created_at DESC)`);
    await dbManager.run(`CREATE TABLE IF NOT EXISTS group_voice_sessions (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, channel_id TEXT NOT NULL, checkpoint_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(guild_id, user_id))`);
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
async function getOrCreateSharedGroupChat(guild, settings, options = {}) {
  if (settings?.chatMode !== GROUP_CHAT_MODES.THREADS) throw new Error('THREAD_CHAT_MODE_REQUIRED');
  const createIfMissing = options.createIfMissing !== false;
  return withLock(`group-chat:${guild.id}`, async () => {
    const candidates = new Map();
    const rows = await dbManager.all("SELECT text_channel_id, thread_id FROM managed_groups WHERE guild_id = ? AND status != 'deleted' AND text_channel_id IS NOT NULL", [guild.id]);
    for (const row of rows) {
      const channel = guild.channels.cache.get(String(row.text_channel_id)) || await guild.channels.fetch(String(row.text_channel_id)).catch(() => null);
      if (channel?.type === ChannelType.GuildText && (String(channel.name || '').toLowerCase() === 'groups-chat' || row.thread_id)) candidates.set(channel.id, channel);
    }
    const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
    for (const channel of channels.values()) {
      if (channel?.type === ChannelType.GuildText && String(channel.name || '').toLowerCase() === 'groups-chat'
        && (!settings.textCategoryId || String(channel.parentId || '') === String(settings.textCategoryId))) candidates.set(channel.id, channel);
    }
    const scored = await Promise.all([...candidates.values()].map(async channel => ({
      channel,
      count: (await channel.threads?.fetchActive?.().catch(() => ({ threads: new Map() })))?.threads?.size || 0
    })));
    scored.sort((a, b) => b.count - a.count || String(a.channel.id).localeCompare(String(b.channel.id)));
    if (scored[0]?.channel) return { text: scored[0].channel, reused: true };
    if (!createIfMissing) throw new Error('SHARED_GROUP_CHAT_UNAVAILABLE');
    const text = await guild.channels.create({
      name: 'groups-chat', type: ChannelType.GuildText, parent: settings.textCategoryId || undefined,
      permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }],
      reason: 'Create the single shared managed group chat parent'
    });
    return { text, reused: false };
  });
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
async function getGroupForChannel(guildId, channelId) {
  await schema();
  const rows = await dbManager.all("SELECT * FROM managed_groups WHERE guild_id = ? AND status = 'active' AND (text_channel_id = ? OR thread_id = ? OR voice_channel_id = ?)", [String(guildId), String(channelId), String(channelId), String(channelId)]);
  // Ambiguous channel links must never route a destructive command to an arbitrary group.
  return rows.length === 1 ? hydrate(rows[0]) : null;
}
async function audit(guildId, actorId, groupId, action, details = {}) { await schema(); return dbManager.run('INSERT INTO group_audit_log(guild_id, group_id, actor_id, action, details_json, created_at) VALUES(?,?,?,?,?,?)', [String(guildId), groupId == null ? null : Number(groupId), actorId ? String(actorId) : null, String(action), JSON.stringify(details), Date.now()]); }
async function runtimeLog(guildId, groupId, operation, level, details = {}) { await schema(); return dbManager.run('INSERT INTO group_runtime_log(guild_id, group_id, operation, level, details_json, created_at) VALUES(?,?,?,?,?,?)', [String(guildId), groupId == null ? null : Number(groupId), String(operation), String(level), JSON.stringify(details), Date.now()]); }
/**
 * Best-effort delivery of a structured audit event. Logging must never make a
 * group operation fail: missing settings, deleted channels, permission errors,
 * and Discord API failures are intentionally swallowed and returned as null.
 */
const GROUP_EVENT_VIEWS = Object.freeze({
  create: ['GROUP CREATED', 'تم إنشاء قروب جديد.'], update: ['GROUP UPDATED', 'تم تحديث بيانات أو موارد القروب.'], delete: ['GROUP DELETED', 'تم حذف القروب وموارده.'],
  member_add: ['MEMBER ADDED', 'تمت إضافة عضو للقروب.'], member_remove: ['MEMBER REMOVED', 'تمت إزالة عضو من القروب.'], manager_update: ['MANAGERS UPDATED', 'تم تحديث مسؤولي القروب.'],
  owner: ['OWNER UPDATED', 'تم تغيير مالك القروب أو حالته.'], block: ['MEMBER BLOCKED', 'تم منع عضو من القروب.'], unblock: ['MEMBER UNBLOCKED', 'تم السماح لعضو بالعودة.'],
  rule_update: ['POINT RULE UPDATED', 'تم تعديل قاعدة احتساب النقاط.'], rule_enable: ['POINT RULE ENABLED', 'تم تفعيل قاعدة احتساب النقاط.'], rule_disable: ['POINT RULE DISABLED', 'تم تعطيل قاعدة احتساب النقاط.'],
  music: ['MUSIC BOT UPDATED', 'تمت معالجة بوت الميوزك.'], group_import: ['GROUP IMPORTED', 'تم استيراد قروب موجود.'], group_resource_restored: ['RESOURCES RESTORED', 'تمت استعادة موارد القروب.'],
  membership_reconciliation_drift: ['MEMBERSHIP DRIFT', 'تم اكتشاف اختلاف في عضوية القروب.'], membership_reconciliation_clean: ['MEMBERSHIP SYNCED', 'تمت مزامنة العضوية بنجاح.'],
  member_role_restored: ['MEMBER ROLE RESTORED', 'تمت استعادة رتبة القروب للعضو.'], member_role_restore_failed: ['ROLE RESTORE FAILED', 'تعذر استعادة رتبة القروب.'],
  role_guard_removed: ['ROLE GUARD REMOVED', 'تمت إزالة رتبة القروب.'], group_role_cleanup_incomplete: ['CLEANUP INCOMPLETE', 'لم تكتمل إزالة موارد القروب.'],
  points_reset: ['POINTS RESET', 'تم تصفير نقاط القروب وعداداته.'], activity_skipped: ['ACTIVITY SKIPPED', 'لم تتم إضافة نقاط لهذا النشاط.'],
  group_create: ['GROUP CREATED', 'تم إنشاء قروب جديد.'], group_update: ['GROUP UPDATED', 'تم تحديث بيانات أو موارد القروب.'], group_delete: ['GROUP DELETED', 'تم حذف القروب وموارده.'],
  member_block: ['MEMBER BLOCKED', 'تم منع عضو من القروب.'], member_unblock: ['MEMBER UNBLOCKED', 'تم السماح لعضو بالعودة.'], owner_transferred: ['OWNER TRANSFERRED', 'تم نقل ملكية القروب.'], owner_left: ['OWNER LEFT', 'غادر مالك القروب ويحتاج القروب للمعالجة.']
});
const GROUP_EVENT_FIELDS = Object.freeze({
  groupId: 'القروب', groupName: 'اسم القروب', name: 'الاسم', ownerId: 'المالك', userId: 'العضو', from: 'من', to: 'إلى',
  field: 'الحقل', value: 'القيمة', metric: 'المقياس', threshold: 'الحد', points: 'النقاط', enabled: 'الحالة', reason: 'السبب',
  scope: 'النطاق', channelId: 'القناة', roleId: 'الرتبة', issueCount: 'عدد المشاكل', resolved: 'تم الحل', status: 'الحالة',
  code: 'النتيجة', ok: 'نجح', members: 'الأعضاء', type: 'النوع', detail: 'التفاصيل', issues: 'المشاكل'
});
const GROUP_LOG_TRANSLATIONS = Object.freeze({
  membership_reconciliation_drift: 'اختلاف عضوية', thread_member_not_in_db: 'عضو الثريد غير مسجل', MUSIC_CHANNEL_NOT_CONFIGURED: 'قناة الميوزك غير محددة',
  MUSIC_CHANNEL_INVALID: 'قناة الميوزك غير صالحة', member_left: 'العضو غادر القروب', role_guard_removed: 'إزالة حماية الرتبة'
});
function groupEventView(event, details) {
  if (String(event) === 'update' && String(details?.reason) === 'membership_reconciliation_drift') return ['MEMBERSHIP DRIFT', 'تم العثور على اختلاف يحتاج إلى معالجة.'];
  return GROUP_EVENT_VIEWS[String(event)] || ['GROUP EVENT', 'تم تسجيل حدث في نظام القروبات.'];
}
function groupLogFieldLines(key, value) {
  if (key !== 'issues' || !Array.isArray(value)) return [`**${GROUP_EVENT_FIELDS[key] || key} :** ${groupLogValue(key, value)}`];
  return value.slice(0, 5).flatMap(issue => {
    if (!issue || typeof issue !== 'object') return [`**المشكلة :** ${groupLogValue(key, issue)}`];
    return Object.entries(issue).slice(0, 4).map(([childKey, childValue]) => `**${GROUP_EVENT_FIELDS[childKey] || childKey} :** ${groupLogValue(childKey, childValue)}`);
  });
}
function groupLogValue(key, value, depth = 0) {
  if (value == null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'نعم' : 'لا';
  if (Array.isArray(value)) return value.slice(0, 8).map(item => groupLogValue(key, item, depth + 1)).join(depth ? '\n' : '، ') || '—';
  if (typeof value === 'object') {
    return Object.entries(value).slice(0, 8).map(([childKey, childValue]) => `**${GROUP_EVENT_FIELDS[childKey] || childKey} :** ${groupLogValue(childKey, childValue, depth + 1)}`).join(' • ').slice(0, 500);
  }
  const rawValue = String(value);
  const stringValue = GROUP_LOG_TRANSLATIONS[rawValue] || rawValue.slice(0, 300);
  if (/^(userId|ownerId|from|to)$/.test(key) && /^\d{16,20}$/.test(stringValue)) return `<@${stringValue}>`;
  if (key === 'groupId') return `\`#${stringValue}\``;
  if (key === 'enabled' || key === 'resolved' || key === 'ok') return ['1', 'true', 'yes'].includes(stringValue.toLowerCase()) ? 'نعم' : 'لا';
  return stringValue;
}
async function logGroupEvent(guild, event, details = {}, actorId = null) {
  try {
    if (!guild?.id) return null;
    const settings = await getSettings(guild.id);
    if (!settings.logChannelId) return null;
    let channel = guild.channels?.cache?.get(settings.logChannelId) || null;
    if (!channel && typeof guild.channels?.fetch === 'function') channel = await guild.channels.fetch(settings.logChannelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') return null;
    const safeDetails = details && typeof details === 'object' ? details : { value: String(details) };
    const logDetails = { ...safeDetails };
    if (logDetails.groupId != null) {
      const group = await getGroup(guild.id, logDetails.groupId).catch(() => null);
      const groupName = group?.name || logDetails.groupName || logDetails.name;
      if (groupName) { logDetails.groupName = String(groupName).slice(0, 100); delete logDetails.groupId; }
    }
    const [title, description] = groupEventView(event, logDetails);
    const fields = Object.entries(logDetails).filter(([, value]) => value !== undefined && value !== null).slice(0, 12);
    const actor = actorId ? `<@${String(actorId).replace(/[^0-9]/g, '')}>` : 'النظام';
    const compactMembership = String(event) === 'update' && String(logDetails.reason) === 'membership_reconciliation_drift';
    const visibleFields = compactMembership ? fields.filter(([key]) => key !== 'reason') : fields;
    const fieldLines = visibleFields.flatMap(([key, value]) => groupLogFieldLines(key, value));
    const fieldText = fieldLines.length
      ? fieldLines.join('\n')
      : '**التفاصيل :** لا توجد تفاصيل إضافية.';
    const container = new ContainerBuilder().setAccentColor(colorToNumber(colorManager.getColor?.() || '#5865F2'));
    const header = [new TextDisplayBuilder().setContent(`## ${title}`), new TextDisplayBuilder().setContent(`**الحدث :** ${description}\n**المنفذ :** ${actor}`)];
    const body = new TextDisplayBuilder().setContent(fieldText.slice(0, 3800));
    const footer = new TextDisplayBuilder().setContent(`-# ${guild.name ? String(guild.name).slice(0, 100) : guild.id} • لوق القروبات`);
    const icon = guild.iconURL?.({ extension: 'png', size: 128 });
    if (icon) container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(header).setThumbnailAccessory(new ThumbnailBuilder().setURL(icon)));
    else header.forEach(text => container.addTextDisplayComponents(text));
    container.addTextDisplayComponents(body, footer);
    return await channel.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
  } catch {
    return null;
  }
}
function isOwner(client, member) { return Boolean(member && (member.id === member.guild?.ownerId || client?.isBotOwner?.(member.id) || global.isBotOwner?.(member.id) || (global.BOT_OWNERS || []).map(String).includes(String(member.id)))); }
function isBotOwner(client, member) {
  const userId = String(member?.id || member?.user?.id || '');
  if (!userId) return false;
  if (client?.isBotOwner?.(userId) || global.isBotOwner?.(member || userId)) return true;
  if ((global.BOT_OWNERS || []).map(String).includes(userId)) return true;
  const ownerRoles = new Set((global.BOT_OWNER_ROLES || []).map(String));
  return Boolean(ownerRoles.size && member?.roles?.cache?.some(role => ownerRoles.has(String(role.id))));
}
function isSystemManager(settings, member) { if (!member) return false; return settings.systemUsers.includes(String(member.id)) || member.roles?.cache?.some(role => settings.systemRoles.includes(String(role.id))); }
function canManageGroupAdmin(client, settings, member) { return isBotOwner(client, member) || isSystemManager(settings, member); }
function canManageSystem(client, settings, member) { return isOwner(client, member) || isSystemManager(settings, member); }
function canManageGroup(client, settings, group, member) { if (!member || !group) return false; return canManageSystem(client, settings, member) || String(group.owner_id) === String(member.id) || group.managerIds.includes(String(member.id)); }
function channelBelongs(group, channelId) { return [group.text_channel_id, group.thread_id, group.voice_channel_id].filter(Boolean).includes(String(channelId)); }
function validateConfig(guild, settings) {
  const missing = [];
  const me = guild.members?.me;
  const requiredPermissions = ['ManageChannels', 'ManageRoles'];
  if (settings.extraPermissions) requiredPermissions.push('ManageMessages', 'ModerateMembers', 'MoveMembers');
  if (!me?.permissions) missing.push('permission:BOT_MEMBER');
  else for (const permission of requiredPermissions) if (!me.permissions.has(permission)) missing.push(`permission:${permission}`);
  if (!settings.chatMode) missing.push('chatMode');
  const textCategory = settings.textCategoryId && guild.channels.cache.get(settings.textCategoryId);
  const voiceCategory = settings.voiceCategoryId && guild.channels.cache.get(settings.voiceCategoryId);
  if (!textCategory || textCategory.type !== ChannelType.GuildCategory) missing.push('textCategoryId');
  if (!voiceCategory || voiceCategory.type !== ChannelType.GuildCategory) missing.push('voiceCategoryId');
  const checkCategoryPermissions = (category, key, extra = []) => {
    if (!category || !me) return;
    const permissions = category.permissionsFor?.(me);
    for (const permission of ['ViewChannel', 'ManageChannels', ...extra]) {
      if (!permissions?.has(permission)) missing.push(`categoryPermission:${key}:${permission}`);
    }
  };
  checkCategoryPermissions(textCategory, 'textCategoryId', settings.chatMode === GROUP_CHAT_MODES.THREADS
    ? ['CreatePrivateThreads', 'ManageThreads', 'SendMessages', 'SendMessagesInThreads']
    : ['SendMessages', 'ReadMessageHistory']);
  checkCategoryPermissions(voiceCategory, 'voiceCategoryId', settings.musicChannelId ? ['Connect', 'MoveMembers'] : []);
  if (settings.musicChannelId) {
    const music = guild.channels.cache.get(settings.musicChannelId);
    if (!music?.isVoiceBased?.()) missing.push('musicChannelId');
    else if (me) {
      const permissions = music.permissionsFor?.(me);
      for (const permission of ['ViewChannel', 'Connect', 'MoveMembers']) if (!permissions?.has(permission)) missing.push(`channelPermission:musicChannelId:${permission}`);
    }
  }
  for (const key of ['logChannelId', 'topChannelId', 'adminControlChannelId', 'memberControlChannelId']) {
    if (settings[key]) {
      const channel = guild.channels.cache.get(settings[key]);
      if (!channel?.isTextBased?.() || channel.type === ChannelType.GuildCategory) missing.push(key);
      else if (me) {
        const permissions = channel.permissionsFor?.(me);
        const required = key === 'topChannelId' ? ['ViewChannel', 'SendMessages', 'AttachFiles'] : ['ViewChannel', 'SendMessages'];
        for (const permission of required) if (!permissions?.has(permission)) missing.push(`channelPermission:${key}:${permission}`);
      }
    }
  }
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
async function updateGroup(guildId, groupId, patch, actorId) { await schema(); const allowed = ['name','description','owner_id','color','emoji','avatar_url','role_id','text_channel_id','thread_id','voice_channel_id','manager_ids_json','member_ids_json','blocked_ids_json','points','status','sync_state','updated_at','archived_at']; const keys = Object.keys(patch).filter(key => allowed.includes(key)); if (!keys.length) return getGroup(guildId, groupId); const values = keys.map(key => patch[key]); values.push(String(guildId), Number(groupId)); await dbManager.run(`UPDATE managed_groups SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE guild_id = ? AND id = ?`, values); await audit(guildId, actorId, groupId, 'group_update', { keys }); return getGroup(guildId, groupId); }
async function addMember(guildId, groupId, userId, actorId) { return withLock(`members:${guildId}`, async () => {
  const safeUserId = String(userId);
  if (!isSnowflake(safeUserId)) throw new Error('INVALID_USER_ID');
  const group = await getGroup(guildId, groupId);
  if (!group || group.status !== 'active') throw new Error('GROUP_NOT_FOUND');
  if (group.blockedIds.includes(safeUserId)) throw new Error('USER_BLOCKED');
  // A member may belong to multiple groups. Membership is intentionally
  // independent per group; only the target group's blocked list is enforced.
  const members = new Set(group.memberIds); members.add(safeUserId);
  await updateGroup(guildId, groupId, { member_ids_json: JSON.stringify([...members]), updated_at: Date.now() }, actorId);
  // Keep the current leaderboard clean while the member is away, but restore
  // the historical counters from the immutable ledger when they rejoin.
  const historical = await dbManager.get(`
    SELECT COALESCE(SUM(points_delta), 0) AS points,
           COALESCE(SUM(CASE WHEN metric = 'messages' THEN activity_amount ELSE 0 END), 0) AS messages,
           COALESCE(SUM(CASE WHEN metric = 'voice_ms' THEN activity_amount ELSE 0 END), 0) AS voice_ms,
           COALESCE(SUM(CASE WHEN metric = 'reactions' THEN activity_amount ELSE 0 END), 0) AS reactions,
           COALESCE(MAX(created_at), 0) AS updated_at
    FROM group_points_ledger WHERE guild_id = ? AND group_id = ? AND user_id = ?`,
  [String(guildId), Number(groupId), safeUserId]);
  if (historical && [historical.points, historical.messages, historical.voice_ms, historical.reactions].some(value => Number(value) !== 0)) {
    await dbManager.run(`INSERT OR REPLACE INTO group_member_points(guild_id, group_id, user_id, points, messages, voice_ms, reactions, updated_at) VALUES(?,?,?,?,?,?,?,?)`, [
      String(guildId), Number(groupId), safeUserId, Number(historical.points) || 0, Number(historical.messages) || 0,
      Number(historical.voice_ms) || 0, Number(historical.reactions) || 0, Number(historical.updated_at) || Date.now()
    ]);
  }
  return [...members];
}); }
async function removeMember(guildId, groupId, userId, actorId) { return withLock(`members:${guildId}`, async () => {
  const safeUserId = String(userId);
  const group = await getGroup(guildId, groupId);
  if (!group) throw new Error('GROUP_NOT_FOUND');
  if (String(group.owner_id) === safeUserId) throw new Error('OWNER_PROTECTED');
  const members = group.memberIds.filter(id => id !== safeUserId);
  const managers = group.managerIds.filter(id => id !== safeUserId);
    await dbManager.transaction(async tx => {
      await tx.run('UPDATE managed_groups SET member_ids_json = ?, manager_ids_json = ?, updated_at = ? WHERE guild_id = ? AND id = ?', [JSON.stringify(members), JSON.stringify(managers), Date.now(), String(guildId), Number(groupId)]);
      await tx.run('DELETE FROM group_member_points WHERE guild_id = ? AND group_id = ? AND user_id = ?', [String(guildId), Number(groupId), safeUserId]);
    }, 'group-member-remove');
  await audit(guildId, actorId, groupId, 'group_update', { removedMemberId: safeUserId });
  return members;
}); }
async function setManagers(guildId, groupId, managerIds, actorId) { return withLock(`members:${guildId}`, async () => {
  const group = await getGroup(guildId, groupId);
  if (!group) throw new Error('GROUP_NOT_FOUND');
  if (String(actorId || '') !== String(group.owner_id)) throw new Error('OWNER_ONLY');
  const allowed = ids(managerIds).filter(id => group.memberIds.includes(id) && id !== String(group.owner_id));
  const otherRows = await dbManager.all("SELECT manager_ids_json FROM managed_groups WHERE guild_id = ? AND status = 'active' AND id <> ?", [String(guildId), Number(groupId)]);
  const occupiedManagerIds = new Set();
  for (const row of otherRows) {
    try { for (const id of JSON.parse(row.manager_ids_json || '[]')) occupiedManagerIds.add(String(id)); } catch {}
  }
  const conflict = allowed.find(id => occupiedManagerIds.has(String(id)));
  if (conflict) throw new Error('USER_ALREADY_MANAGER');
  await updateGroup(guildId, groupId, { manager_ids_json: JSON.stringify(allowed), updated_at: Date.now() }, actorId);
  return allowed;
}); }
async function setBlocked(guildId, groupId, userId, blocked, actorId) { return withLock(`members:${guildId}`, async () => {
  const safeUserId = String(userId);
  if (!isSnowflake(safeUserId)) throw new Error('INVALID_USER_ID');
  const group = await getGroup(guildId, groupId);
  if (!group) throw new Error('GROUP_NOT_FOUND');
  if (blocked && String(group.owner_id) === safeUserId) throw new Error('OWNER_PROTECTED');
  const blockedIds = new Set(group.blockedIds);
  blocked ? blockedIds.add(safeUserId) : blockedIds.delete(safeUserId);
  const members = blocked ? group.memberIds.filter(id => id !== safeUserId) : group.memberIds;
  const managers = blocked ? group.managerIds.filter(id => id !== safeUserId) : group.managerIds;
  await dbManager.transaction(async tx => {
      await tx.run('UPDATE managed_groups SET blocked_ids_json = ?, member_ids_json = ?, manager_ids_json = ?, updated_at = ? WHERE guild_id = ? AND id = ?', [JSON.stringify([...blockedIds]), JSON.stringify(members), JSON.stringify(managers), Date.now(), String(guildId), Number(groupId)]);
      if (blocked) await tx.run('DELETE FROM group_member_points WHERE guild_id = ? AND group_id = ? AND user_id = ?', [String(guildId), Number(groupId), safeUserId]);
    }, 'group-member-block');
  await audit(guildId, actorId, groupId, blocked ? 'member_block' : 'member_unblock', { userId: safeUserId });
  return [...blockedIds];
}); }
async function resetPoints(guildId, groupId, actorId = null) {
  await schema();
  if (groupId != null && (!Number.isInteger(Number(groupId)) || Number(groupId) <= 0)) throw new Error('INVALID_GROUP_ID');
  return withLock(`points:${String(guildId)}`, async () => {
    const resetDetails = await dbManager.transaction(async tx => {
      const now = Date.now();
      const groups = groupId == null
        ? await tx.all("SELECT id, points FROM managed_groups WHERE guild_id = ? AND status = 'active'", [String(guildId)])
        : await tx.all("SELECT id, points FROM managed_groups WHERE guild_id = ? AND id = ?", [String(guildId), Number(groupId)]);
      let memberRows = 0;
      let memberPointsBefore = 0;
      for (const group of groups) {
        const members = await tx.all('SELECT user_id, points FROM group_member_points WHERE guild_id = ? AND group_id = ?', [String(guildId), Number(group.id)]);
        memberRows += members.length;
        memberPointsBefore += members.reduce((sum, row) => sum + Math.max(0, Number(row.points) || 0), 0);
        for (const member of members) {
          await tx.run(`INSERT INTO group_points_ledger(guild_id,group_id,user_id,metric,activity_amount,points_delta,member_before,member_after,group_before,group_after,reason,event_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [String(guildId), Number(group.id), String(member.user_id), 'manual', 0, -Math.max(0, Number(member.points) || 0), Math.max(0, Number(member.points) || 0), 0, Math.max(0, Number(group.points) || 0), 0, 'points_reset', null, now]);
        }
      }
      if (groupId == null) {
        await tx.run("UPDATE managed_groups SET points = 0, updated_at = ? WHERE guild_id = ? AND status = 'active'", [now, String(guildId)]);
        await tx.run('UPDATE group_member_points SET points = 0, messages = 0, voice_ms = 0, reactions = 0, updated_at = ? WHERE guild_id = ?', [now, String(guildId)]);
      } else {
        await tx.run('UPDATE managed_groups SET points = 0, updated_at = ? WHERE guild_id = ? AND id = ?', [now, String(guildId), Number(groupId)]);
        await tx.run('UPDATE group_member_points SET points = 0, messages = 0, voice_ms = 0, reactions = 0, updated_at = ? WHERE guild_id = ? AND group_id = ?', [now, String(guildId), Number(groupId)]);
      }
      return { groupsAffected: groups.length, memberRows, groupPointsBefore: groups.reduce((sum, row) => sum + Math.max(0, Number(row.points) || 0), 0), memberPointsBefore };
    }, 'group-points-reset');
    await audit(guildId, actorId, groupId, 'points_reset', resetDetails);
  });
}
function validateManualPointsDelta(delta) {
  const value = Number(delta);
  if (!Number.isSafeInteger(value) || value === 0 || Math.abs(value) > MAX_ACTIVITY_AMOUNT) throw new Error('INVALID_POINTS_ADJUSTMENT');
  return value;
}
async function adjustGroupPoints(guildId, groupId, delta, actorId = null) {
  await schema();
  const safeGroupId = Number(groupId), safeDelta = validateManualPointsDelta(delta);
  if (!Number.isInteger(safeGroupId) || safeGroupId <= 0) throw new Error('INVALID_GROUP_ID');
  return withLock(`points:${String(guildId)}`, () => dbManager.transaction(async tx => {
    const row = await tx.get("SELECT * FROM managed_groups WHERE guild_id = ? AND id = ? AND status = 'active'", [String(guildId), safeGroupId]);
    if (!row) throw new Error('GROUP_NOT_FOUND');
    const before = Math.max(0, Number(row.points) || 0), after = before + safeDelta;
    if (after < 0) throw new Error('INSUFFICIENT_GROUP_POINTS');
    if (after > MAX_ACTIVITY_AMOUNT) throw new Error('POINTS_LIMIT_EXCEEDED');
    const now = Date.now();
    await tx.run('UPDATE managed_groups SET points = ?, updated_at = ? WHERE guild_id = ? AND id = ? AND status = \'active\'', [after, now, String(guildId), safeGroupId]);
    await tx.run('INSERT INTO group_audit_log(guild_id,group_id,actor_id,action,details_json,created_at) VALUES(?,?,?,?,?,?)', [String(guildId), safeGroupId, actorId ? String(actorId) : null, 'manual_group_points', JSON.stringify({ delta: safeDelta, before, after }), now]);
    return { before, after, delta: safeDelta, group: hydrate(await tx.get('SELECT * FROM managed_groups WHERE guild_id = ? AND id = ?', [String(guildId), safeGroupId])) };
  }, 'group-manual-points'));
}
async function adjustAllGroupPoints(guildId, delta, actorId = null) {
  await schema();
  const safeDelta = validateManualPointsDelta(delta);
  return withLock(`points:${String(guildId)}`, () => dbManager.transaction(async tx => {
    const rows = await tx.all("SELECT * FROM managed_groups WHERE guild_id = ? AND status = 'active' ORDER BY id ASC", [String(guildId)]);
    if (!rows.length) throw new Error('GROUP_NOT_FOUND');
    const before = rows.reduce((total, row) => total + Math.max(0, Number(row.points) || 0), 0);
    let deltaTotal = 0, changedGroups = 0;
    const now = Date.now();
    for (const row of rows) {
      const groupBefore = Math.max(0, Number(row.points) || 0);
      const actualDelta = safeDelta > 0 ? safeDelta : -Math.min(Math.abs(safeDelta), groupBefore);
      if (!actualDelta) continue;
      const after = groupBefore + actualDelta;
      if (after < 0) throw new Error('INSUFFICIENT_GROUP_POINTS');
      if (after > MAX_ACTIVITY_AMOUNT) throw new Error('POINTS_LIMIT_EXCEEDED');
      await tx.run("UPDATE managed_groups SET points = ?, updated_at = ? WHERE guild_id = ? AND id = ? AND status = 'active'", [after, now, String(guildId), Number(row.id)]);
      await tx.run('INSERT INTO group_audit_log(guild_id,group_id,actor_id,action,details_json,created_at) VALUES(?,?,?,?,?,?)', [String(guildId), Number(row.id), actorId ? String(actorId) : null, 'manual_all_group_points', JSON.stringify({ requestedDelta: safeDelta, actualDelta, before: groupBefore, after }), now]);
      deltaTotal += actualDelta;
      changedGroups += 1;
    }
    if (safeDelta < 0 && deltaTotal === 0) throw new Error('NO_POINTS_TO_REMOVE');
    return { before, after: before + deltaTotal, delta: deltaTotal, groups: rows.length, changedGroups };
  }, 'group-manual-all-points'));
}
async function adjustMemberPoints(guildId, groupId, userId, delta, actorId = null) {
  await schema();
  const safeGroupId = Number(groupId), safeUserId = String(userId || ''), safeDelta = validateManualPointsDelta(delta);
  if (!Number.isInteger(safeGroupId) || safeGroupId <= 0) throw new Error('INVALID_GROUP_ID');
  if (!isSnowflake(safeUserId)) throw new Error('INVALID_USER_ID');
  return withLock(`points:${String(guildId)}`, () => dbManager.transaction(async tx => {
    const row = await tx.get("SELECT * FROM managed_groups WHERE guild_id = ? AND id = ? AND status = 'active'", [String(guildId), safeGroupId]);
    if (!row) throw new Error('GROUP_NOT_FOUND');
    const group = hydrate(row);
    if (![String(group.owner_id), ...group.memberIds, ...group.managerIds].includes(safeUserId)) throw new Error('MEMBER_NOT_IN_GROUP');
    const balanceRow = await tx.get('SELECT points FROM group_member_points WHERE guild_id = ? AND group_id = ? AND user_id = ?', [String(guildId), safeGroupId, safeUserId]);
    const before = Math.max(0, Number(balanceRow?.points) || 0), after = before + safeDelta;
    if (after < 0) throw new Error('INSUFFICIENT_MEMBER_POINTS');
    if (after > MAX_ACTIVITY_AMOUNT) throw new Error('POINTS_LIMIT_EXCEEDED');
    const groupBefore = Math.max(0, Number(group.points) || 0), groupAfter = groupBefore + safeDelta;
    if (groupAfter < 0) throw new Error('INSUFFICIENT_GROUP_POINTS');
    if (groupAfter > MAX_ACTIVITY_AMOUNT) throw new Error('POINTS_LIMIT_EXCEEDED');
    const now = Date.now();
    await tx.run(`INSERT INTO group_member_points(guild_id,group_id,user_id,points,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(guild_id,group_id,user_id) DO UPDATE SET points = excluded.points, updated_at = excluded.updated_at`, [String(guildId), safeGroupId, safeUserId, after, now]);
    await tx.run("UPDATE managed_groups SET points = ?, updated_at = ? WHERE guild_id = ? AND id = ? AND status = 'active'", [groupAfter, now, String(guildId), safeGroupId]);
    await tx.run('INSERT INTO group_audit_log(guild_id,group_id,actor_id,action,details_json,created_at) VALUES(?,?,?,?,?,?)', [String(guildId), safeGroupId, actorId ? String(actorId) : null, 'manual_member_points', JSON.stringify({ userId: safeUserId, delta: safeDelta, before, after, groupBefore, groupAfter }), now]);
    await tx.run(`INSERT INTO group_points_ledger(guild_id,group_id,user_id,metric,activity_amount,points_delta,member_before,member_after,group_before,group_after,reason,event_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [String(guildId), safeGroupId, safeUserId, 'manual', 0, safeDelta, before, after, groupBefore, groupAfter, 'manual_adjustment', null, now]);
    return { userId: safeUserId, before, after, delta: safeDelta, groupBefore, groupAfter };
  }, 'group-manual-member-points'));
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
  const rawEventId = args.eventId == null || args.eventId === '' ? null : String(args.eventId);
  if (rawEventId && rawEventId.length > 200) throw new Error('INVALID_EVENT_ID');
  const normalizedEventId = rawEventId ? `${safeMetric}:${String(userId)}:${rawEventId}` : null;
  if (normalizedEventId && normalizedEventId.length > 255) throw new Error('INVALID_EVENT_ID');
  if (normalizedEventId && Date.now() - lastActivityEventPruneAt > 24 * 60 * 60 * 1000) {
    lastActivityEventPruneAt = Date.now();
    await dbManager.run('DELETE FROM group_activity_events WHERE created_at < ?', [Date.now() - 90 * 24 * 60 * 60 * 1000]).catch(() => {});
  }
  return withLock(`points:${String(guildId)}`, async () => dbManager.transaction(async tx => {
    const settingsRow = await tx.get('SELECT * FROM group_system_settings WHERE guild_id = ?', [String(guildId)]);
    const settings = normalizeSettings(settingsRow || { guild_id: guildId, settings_json: JSON.stringify({}) });
    if (!settings.enabled) return 0;
    const rule = await tx.get('SELECT * FROM group_points_rules WHERE guild_id = ? AND metric = ?', [String(guildId), safeMetric]);
    const threshold = Number(rule?.threshold); const rulePoints = Number(rule?.points);
    if (!rule || Number(rule.enabled) !== 1 || !Number.isInteger(threshold) || threshold < 1 || !Number.isInteger(rulePoints) || rulePoints < 1) return 0;
    const rows = await tx.all("SELECT * FROM managed_groups WHERE guild_id = ? AND status = 'active'", [String(guildId)]);
    const column = safeMetric === 'voice_ms' ? 'voice_ms' : safeMetric === 'reactions' ? 'reactions' : 'messages';
    const eligibleGroups = rows.map(hydrate).filter(group =>
      (group.memberIds.includes(String(userId)) || String(group.owner_id) === String(userId) || group.managerIds.includes(String(userId)))
      && (settings.countAllChannels || !args.channelId || channelBelongs(group, args.channelId))
    );
    if (!eligibleGroups.length) return 0;
    if (normalizedEventId) {
      const inserted = await tx.run('INSERT OR IGNORE INTO group_activity_events(guild_id, event_id, created_at) VALUES(?,?,?)', [String(guildId), normalizedEventId, Date.now()]);
      if (!inserted.changes) return 0;
    }
    let awarded = 0;
    for (const group of eligibleGroups) {
      const previous = await tx.get('SELECT * FROM group_member_points WHERE guild_id = ? AND group_id = ? AND user_id = ?', [String(guildId), Number(group.id), String(userId)]);
      const oldAmount = Number(previous?.[column]) || 0;
      const nextAmount = Math.min(MAX_ACTIVITY_AMOUNT, oldAmount + increment);
      const beforeUnits = Math.floor(oldAmount / threshold);
      const afterUnits = Math.floor(nextAmount / threshold);
      const requestedDelta = Math.max(0, afterUnits - beforeUnits) * rulePoints;
      const memberPoints = Math.max(0, Number(previous?.points) || 0);
      const groupPoints = Math.max(0, Number(group.points) || 0);
      // Keep persisted points within the safe, shared system limit even when a rule is configured very high.
      const delta = Math.max(0, Math.min(requestedDelta, MAX_ACTIVITY_AMOUNT - memberPoints, MAX_ACTIVITY_AMOUNT - groupPoints));
      await tx.run(`INSERT INTO group_member_points(guild_id,group_id,user_id,${column},updated_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,group_id,user_id) DO UPDATE SET ${column}=excluded.${column},updated_at=excluded.updated_at`, [String(guildId), Number(group.id), String(userId), nextAmount, Date.now()]);
      if (delta > 0) {
        const now = Date.now();
        await tx.run('UPDATE group_member_points SET points = points + ?, updated_at = ? WHERE guild_id = ? AND group_id = ? AND user_id = ?', [delta, now, String(guildId), Number(group.id), String(userId)]);
        await tx.run("UPDATE managed_groups SET points = points + ?, updated_at = ? WHERE guild_id = ? AND id = ? AND status = 'active'", [delta, now, String(guildId), Number(group.id)]);
        await tx.run(`INSERT INTO group_points_ledger(guild_id,group_id,user_id,metric,activity_amount,points_delta,member_before,member_after,group_before,group_after,reason,event_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [String(guildId), Number(group.id), String(userId), safeMetric, increment, delta, memberPoints, memberPoints + delta, groupPoints, groupPoints + delta, 'activity_award', normalizedEventId, now]);
        awarded += delta;
      }
    }
    return awarded;
  }, 'group-record-activity'));
}
async function explainActivity(guildId, userId, metric, channelId = null, amount = 1) {
  await schema();
  const settings = await getSettings(guildId);
  if (!settings.enabled) return { counted: false, reason: 'system_disabled' };
  const safeMetric = String(metric);
  if (!GROUP_METRICS.has(safeMetric)) return { counted: false, reason: 'unsupported_metric' };
  const rule = (await getRules(guildId)).find(row => row.metric === safeMetric);
  if (!rule || Number(rule.enabled) !== 1) return { counted: false, reason: 'rule_disabled', metric: safeMetric };
  const groups = (await listGroups(guildId)).filter(group =>
    group.memberIds.includes(String(userId)) || String(group.owner_id) === String(userId) || group.managerIds.includes(String(userId))
  );
  if (!groups.length) return { counted: false, reason: 'member_not_eligible', metric: safeMetric };
  const scopedGroups = settings.countAllChannels || !channelId
    ? groups
    : groups.filter(group => channelBelongs(group, channelId));
  if (!scopedGroups.length) return { counted: false, reason: 'channel_out_of_scope', metric: safeMetric, groupIds: groups.map(group => group.id) };
  const column = safeMetric === 'voice_ms' ? 'voice_ms' : safeMetric === 'reactions' ? 'reactions' : 'messages';
  const threshold = Number(rule.threshold) || 1;
  const amountValue = Math.max(0, Math.floor(Number(amount) || 0));
  const progress = [];
  for (const group of scopedGroups) {
    const row = await getMemberPoints(guildId, group.id, userId);
    const before = Number(row?.[column]) || 0;
    progress.push({ groupId: group.id, before, after: before + amountValue, threshold });
  }
  if (progress.every(item => Math.floor(item.after / threshold) === Math.floor(item.before / threshold))) {
    return { counted: false, reason: 'threshold_not_completed', metric: safeMetric, threshold, progress };
  }
  return { counted: true, reason: 'eligible', metric: safeMetric, threshold, progress };
}
async function listMemberPoints(guildId, groupId, limit = 10) {
  await schema();
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 10));
  const group = await getGroup(guildId, groupId);
  if (!group || group.status !== 'active') return [];
  const memberIds = [...new Set([String(group.owner_id), ...group.memberIds, ...group.managerIds])];
  if (!memberIds.length) return [];
  const placeholders = memberIds.map(() => '?').join(', ');
  const rows = await dbManager.all(`SELECT * FROM group_member_points WHERE guild_id = ? AND group_id = ? AND user_id IN (${placeholders})`, [String(guildId), Number(groupId), ...memberIds]);
  // Only persisted activity rows belong in the leaderboard. This avoids
  // showing synthetic zero-score rows for owners/new members and ensures
  // removed members disappear immediately while their ledger remains intact.
  return rows.sort((a, b) => Number(b.points || 0) - Number(a.points || 0)
    || String(a.user_id).localeCompare(String(b.user_id), 'en', { numeric: true }))
    .slice(0, safeLimit);
}
async function listPointsLedger(guildId, { groupId = null, userId = null, limit = 25, offset = 0 } = {}) {
  await schema();
  const filters = ['guild_id = ?']; const params = [String(guildId)];
  if (groupId != null) { filters.push('group_id = ?'); params.push(Number(groupId)); }
  if (userId != null) { filters.push('user_id = ?'); params.push(String(userId)); }
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const safeOffset = Math.max(0, Number(offset) || 0);
  return dbManager.all(`SELECT * FROM group_points_ledger WHERE ${filters.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, safeLimit, safeOffset]);
}
async function pruneGroupHistory({ ledgerDays = 180, auditDays = 365, eventDays = 90 } = {}) {
  await schema();
  const now = Date.now();
  const days = value => Math.max(1, Math.min(3650, Number(value) || 1));
  const cutoffs = {
    ledger: now - days(ledgerDays) * 24 * 60 * 60 * 1000,
    audit: now - days(auditDays) * 24 * 60 * 60 * 1000,
    events: now - days(eventDays) * 24 * 60 * 60 * 1000
  };
  return dbManager.transaction(async tx => {
    const ledger = await tx.run('DELETE FROM group_points_ledger WHERE created_at < ?', [cutoffs.ledger]);
    const audit = await tx.run('DELETE FROM group_audit_log WHERE created_at < ?', [cutoffs.audit]);
    const events = await tx.run('DELETE FROM group_activity_events WHERE created_at < ?', [cutoffs.events]);
    return { ledger: Number(ledger?.changes || 0), audit: Number(audit?.changes || 0), events: Number(events?.changes || 0), cutoffs };
  }, 'group-history-retention');
}
async function upsertVoiceSession(guildId, userId, channelId, checkpointAt = Date.now()) {
  await schema();
  await dbManager.run(`INSERT INTO group_voice_sessions(guild_id,user_id,channel_id,checkpoint_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET channel_id=excluded.channel_id,checkpoint_at=excluded.checkpoint_at,updated_at=excluded.updated_at`, [String(guildId), String(userId), String(channelId), Number(checkpointAt), Date.now()]);
}
async function listVoiceSessions(guildId = null) {
  await schema();
  return guildId == null ? dbManager.all('SELECT * FROM group_voice_sessions') : dbManager.all('SELECT * FROM group_voice_sessions WHERE guild_id = ?', [String(guildId)]);
}
async function deleteVoiceSession(guildId, userId) {
  await schema();
  await dbManager.run('DELETE FROM group_voice_sessions WHERE guild_id = ? AND user_id = ?', [String(guildId), String(userId)]);
}
async function getMemberPoints(guildId, groupId, userId) {
  await schema();
  return dbManager.get('SELECT * FROM group_member_points WHERE guild_id = ? AND group_id = ? AND user_id = ?', [String(guildId), Number(groupId), String(userId)]);
}
async function createGroup(guild, { name, description = '', ownerId, color = '#5865F2', emoji = null }, actorId) {
  const groupName = String(name || '').trim();
  if (!groupName || groupName.length > 100 || /[\u0000-\u001f]/.test(groupName)) throw new Error('NAME_REQUIRED');
  const settings = await getSettings(guild.id); const missing = validateConfig(guild, settings); if (!settings.enabled) throw new Error('GROUP_SYSTEM_DISABLED'); if (missing.length) throw new Error(`GROUP_SETUP_REQUIRED:${missing.join(',')}`); const owner = await guild.members.fetch(String(ownerId));
  if (owner.user?.bot) throw new Error('BOT_NOT_ALLOWED');
  return withLock(`members:${guild.id}`, async () => {
  const operationKey = `guild:${guild.id}:create:${owner.id}`;
  const operationToken = await acquireOperationLock(operationKey, 180000);
  if (!operationToken) throw new Error('GROUP_OPERATION_BUSY');
  try {
  return await withLock(`create:${guild.id}:${owner.id}`, async () => {
    const existingRows = await dbManager.all("SELECT * FROM managed_groups WHERE guild_id = ? AND status = 'active'", [guild.id]);
    const ownedGroup = existingRows.map(hydrate).find(group => String(group.owner_id) === String(owner.id));
    if (ownedGroup) throw new Error('OWNER_ALREADY_HAS_GROUP');
    const now = Date.now(); let role = null; let text = null; let thread = null; let voice = null; let leaderRole = null; let leaderRoleAdded = false; let createdGroupId = null; let reusedSharedText = false; const created = [];
    try {
      role = await guild.roles.create({ name: groupName.slice(0, 100), color: color || '#5865F2', reason: 'Create managed group' }); created.push(['role', role]);
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
      if (settings.leaderRoleId) {
        leaderRole = guild.roles.cache.get(settings.leaderRoleId) || await guild.roles.fetch(settings.leaderRoleId).catch(() => null);
        if (!leaderRole) throw new Error('LEADER_ROLE_INVALID');
        if (!owner.roles.cache.has(leaderRole.id)) { await owner.roles.add(leaderRole, 'Managed group leader role'); leaderRoleAdded = true; }
      }
      if (settings.chatMode === GROUP_CHAT_MODES.THREADS) {
        const shared = await getOrCreateSharedGroupChat(guild, settings);
        text = shared.text;
        reusedSharedText = shared.reused;
        if (!reusedSharedText) created.push(['channel', text]);
        thread = await text.threads.create({ name: groupName.slice(0, 100), type: ChannelType.PrivateThread, invitable: false, reason: 'Create managed group thread' });
        created.push(['thread', thread]); await thread.members.add(owner.id);
      }
      else { text = await guild.channels.create({ name: `📝・${groupName.slice(0, 90)}`, type: ChannelType.GuildText, parent: settings.textCategoryId, reason: 'Create managed group text channel' }); created.push(['channel', text]); }
      voice = await guild.channels.create({ name: groupName.slice(0, 100), type: ChannelType.GuildVoice, parent: settings.voiceCategoryId, reason: 'Create managed group voice channel' }); created.push(['voice', voice]);
      const textOverwrites = [{ id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }, { id: role.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.SendMessagesInThreads, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AddReactions, PermissionsBitField.Flags.AttachFiles, PermissionsBitField.Flags.EmbedLinks, PermissionsBitField.Flags.UseExternalEmojis, PermissionsBitField.Flags.UseExternalStickers] }];
      const voiceOverwrites = [{ id: guild.roles.everyone.id, allow: [PermissionsBitField.Flags.ViewChannel], deny: [PermissionsBitField.Flags.Connect] }, { id: role.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.Stream, PermissionsBitField.Flags.UseVAD] }];
      if (reusedSharedText) await text.permissionOverwrites.edit(role.id, Object.fromEntries(textOverwrites[1].allow.map(flag => [flag, true])), { reason: 'Add managed group role to shared group chat' }).catch(error => { throw Object.assign(new Error('GROUP_TEXT_PERMISSIONS_FAILED'), { cause: error }); });
      else await text.permissionOverwrites.set(textOverwrites, 'Secure managed group text space').catch(error => { throw Object.assign(new Error('GROUP_TEXT_PERMISSIONS_FAILED'), { cause: error }); });
      await voice.permissionOverwrites.set(voiceOverwrites, 'Secure managed group voice space').catch(error => { throw Object.assign(new Error('GROUP_VOICE_PERMISSIONS_FAILED'), { cause: error }); });
      const row = await dbManager.run(`INSERT INTO managed_groups(guild_id,name,description,owner_id,manager_ids_json,member_ids_json,blocked_ids_json,role_id,text_channel_id,thread_id,voice_channel_id,color,emoji,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [guild.id, groupName, String(description).slice(0, 1000), owner.id, '[]', JSON.stringify([owner.id]), '[]', role.id, text.id, thread?.id || null, voice.id, color || '#5865F2', emoji, now, now]);
      createdGroupId = row.id ?? row.lastID;
      const group = await getGroup(guild.id, createdGroupId);
      await audit(guild.id, actorId || owner.id, group.id, 'group_create', { roleId: role.id, textId: text.id, threadId: thread?.id, voiceId: voice.id }).catch(() => {});
      return group;
    } catch (error) {
      if (createdGroupId) await dbManager.run("UPDATE managed_groups SET status = 'deleted', archived_at = ?, updated_at = ? WHERE guild_id = ? AND id = ?", [Date.now(), Date.now(), guild.id, Number(createdGroupId)]).catch(() => {});
      if (leaderRoleAdded && leaderRole) await owner.roles.remove(leaderRole, 'Rollback incomplete group creation').catch(() => {});
      for (const [, resource] of created.reverse()) await resource?.delete?.('Rollback incomplete group creation').catch(() => {});
      throw error;
    }
  });
  } finally {
    await releaseOperationLock(operationKey, operationToken);
  }
  });
}
function serializeChannelOverwrites(channel) {
  return (channel?.permissionOverwrites?.cache ? [...channel.permissionOverwrites.cache.values()] : []).map(overwrite => ({
    id: String(overwrite.id), type: Number(overwrite.type),
    allow: String(overwrite.allow?.bitfield ?? 0), deny: String(overwrite.deny?.bitfield ?? 0)
  }));
}
async function captureGroupArchive(guild, group, settings) {
  const fetchChannel = async id => id && (guild.channels.cache.get(String(id)) || await guild.channels.fetch(String(id)).catch(() => null));
  const role = group.role_id && (guild.roles.cache.get(String(group.role_id)) || await guild.roles.fetch(String(group.role_id)).catch(() => null));
  const text = await fetchChannel(group.text_channel_id), voice = await fetchChannel(group.voice_channel_id), thread = await fetchChannel(group.thread_id);
  const sharedText = Boolean(text && text.type === ChannelType.GuildText && (String(text.name || '').toLowerCase() === 'groups-chat' || settings.chatMode === GROUP_CHAT_MODES.THREADS));
  return {
    version: 1, capturedAt: Date.now(), chatMode: sharedText ? GROUP_CHAT_MODES.THREADS : GROUP_CHAT_MODES.CHANNELS,
    role: role ? { name: role.name, color: role.hexColor, hoist: role.hoist, mentionable: role.mentionable, permissions: role.permissions.bitfield.toString() } : null,
    text: text ? { name: text.name, parentId: text.parentId || null, topic: text.topic || null, nsfw: Boolean(text.nsfw), rateLimitPerUser: Number(text.rateLimitPerUser || 0), overwrites: serializeChannelOverwrites(text) } : null,
    thread: thread ? { name: thread.name, autoArchiveDuration: thread.autoArchiveDuration || 1440 } : null,
    voice: voice ? { name: voice.name, parentId: voice.parentId || null, bitrate: voice.bitrate || null, userLimit: voice.userLimit || 0, rtcRegion: voice.rtcRegion || null, overwrites: serializeChannelOverwrites(voice) } : null,
    memberIds: [...new Set([String(group.owner_id), ...(group.memberIds || []), ...(group.managerIds || [])].filter(Boolean))],
    managerIds: [...(group.managerIds || [])], blockedIds: [...(group.blockedIds || [])]
  };
}
function restoredOverwrites(snapshot, roleId, everyoneId) {
  const source = Array.isArray(snapshot?.overwrites) ? snapshot.overwrites : [];
  const result = source.filter(item => String(item.id) === String(everyoneId)).map(item => ({ id: String(everyoneId), allow: BigInt(item.allow || 0), deny: BigInt(item.deny || 0) }));
  const roleSource = source.find(item => String(item.id) !== String(everyoneId) && Number(item.type) === 0);
  result.push(roleSource ? { id: String(roleId), allow: BigInt(roleSource.allow || 0), deny: BigInt(roleSource.deny || 0) } : { id: String(roleId), allow: BigInt(0), deny: BigInt(0) });
  return result;
}
async function restoreGroup(guild, groupId, actorId, newOwnerId = null) {
  return withLock(`restore:${guild.id}:${groupId}`, async () => {
    const operationKey = `guild:${guild.id}:group:${groupId}:restore`;
    const operationToken = await acquireOperationLock(operationKey, 240000);
    if (!operationToken) throw new Error('GROUP_OPERATION_BUSY');
    const created = []; let role = null;
    try {
      const group = await getGroup(guild.id, groupId);
      if (!group || group.status !== 'deleted') throw new Error('GROUP_NOT_RESTORABLE');
      const archive = safeJson(group.archive_json, null);
      if (!archive || Number(archive.version) !== 1) throw new Error('GROUP_ARCHIVE_MISSING');
      const settings = await getSettings(guild.id), ownerId = String(newOwnerId || group.owner_id);
      if (!isSnowflake(ownerId)) throw new Error('INVALID_OWNER');
      const owner = await guild.members.fetch(ownerId).catch(() => null);
      if (!owner || owner.user?.bot) throw new Error('RESTORE_OWNER_NOT_FOUND');
      if ((await listGroups(guild.id)).some(item => String(item.owner_id) === ownerId)) throw new Error('OWNER_ALREADY_HAS_GROUP');
      const previousMembers = [...new Set([...(archive.memberIds || []), ownerId])];
      role = await guild.roles.create({
        name: String(archive.role?.name || group.name).slice(0, 100), color: archive.role?.color || group.color || '#5865F2',
        hoist: Boolean(archive.role?.hoist), mentionable: Boolean(archive.role?.mentionable),
        permissions: archive.role?.permissions || '0', reason: `Restore managed group #${group.id}`
      });
      created.push(role);
      if (settings.mainRoleId) {
        const mainRole = guild.roles.cache.get(settings.mainRoleId) || await guild.roles.fetch(settings.mainRoleId).catch(() => null);
        if (mainRole && mainRole.id !== guild.id && mainRole.position > 1 && role.position >= mainRole.position) await role.setPosition(Math.max(1, mainRole.position - 1), 'Place restored group role under Main Role');
      }
      const textSnapshot = archive.text || {}, voiceSnapshot = archive.voice || {};
      const textCategory = textSnapshot.parentId && guild.channels.cache.has(String(textSnapshot.parentId)) ? String(textSnapshot.parentId) : settings.textCategoryId || undefined;
      const voiceCategory = voiceSnapshot.parentId && guild.channels.cache.has(String(voiceSnapshot.parentId)) ? String(voiceSnapshot.parentId) : settings.voiceCategoryId || undefined;
      let text = null, thread = null, voice = null;
      if (archive.chatMode === GROUP_CHAT_MODES.THREADS || archive.thread) {
        const shared = await getOrCreateSharedGroupChat(guild, { ...settings, chatMode: GROUP_CHAT_MODES.THREADS });
        text = shared.text;
        if (!shared.reused) created.push(text);
        await text.permissionOverwrites.edit(role.id, { ViewChannel: true, SendMessages: true, SendMessagesInThreads: true, ReadMessageHistory: true, AddReactions: true, AttachFiles: true, EmbedLinks: true }, { reason: 'Restore managed group thread permissions' });
        thread = await text.threads.create({ name: String(archive.thread?.name || group.name).slice(0, 100), type: ChannelType.PrivateThread, invitable: false, autoArchiveDuration: [60,1440,4320,10080].includes(Number(archive.thread?.autoArchiveDuration)) ? Number(archive.thread.autoArchiveDuration) : 1440, reason: `Restore managed group #${group.id}` });
        created.push(thread);
      } else {
        text = await guild.channels.create({
          name: String(textSnapshot.name || `📝・${group.name}`).slice(0, 100), type: ChannelType.GuildText,
          parent: textCategory, topic: textSnapshot.topic || undefined, nsfw: Boolean(textSnapshot.nsfw),
          rateLimitPerUser: Math.max(0, Math.min(21600, Number(textSnapshot.rateLimitPerUser) || 0)),
          permissionOverwrites: restoredOverwrites(textSnapshot, role.id, guild.roles.everyone.id),
          reason: `Restore managed group #${group.id}`
        });
        created.push(text);
      }
      voice = await guild.channels.create({
        name: String(voiceSnapshot.name || group.name).slice(0, 100), type: ChannelType.GuildVoice, parent: voiceCategory,
        bitrate: voiceSnapshot.bitrate || undefined, userLimit: Math.max(0, Math.min(99, Number(voiceSnapshot.userLimit) || 0)),
        rtcRegion: voiceSnapshot.rtcRegion || undefined,
        permissionOverwrites: archive.voice ? restoredOverwrites(voiceSnapshot, role.id, guild.roles.everyone.id) : [
          { id: guild.roles.everyone.id, allow: [PermissionsBitField.Flags.ViewChannel], deny: [PermissionsBitField.Flags.Connect] },
          { id: role.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.Stream, PermissionsBitField.Flags.UseVAD] }
        ], reason: `Restore managed group #${group.id}`
      });
      created.push(voice);
      const restoredMembers = [];
      for (const userId of previousMembers) {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member || member.user?.bot) continue;
        await member.roles.add(role, 'Restore managed group membership').catch(() => {});
        if (thread) await thread.members.add(member.id).catch(() => {});
        restoredMembers.push(member.id);
      }
      if (!restoredMembers.includes(owner.id)) throw new Error('RESTORE_OWNER_NOT_ADDED');
      if (settings.leaderRoleId) {
        const leaderRole = guild.roles.cache.get(settings.leaderRoleId) || await guild.roles.fetch(settings.leaderRoleId).catch(() => null);
        if (leaderRole && !owner.roles.cache.has(leaderRole.id)) await owner.roles.add(leaderRole, 'Restore managed group owner');
      }
      const now = Date.now();
      await dbManager.transaction(async tx => {
        await tx.run(`UPDATE managed_groups SET owner_id = ?, manager_ids_json = ?, member_ids_json = ?, role_id = ?, text_channel_id = ?, thread_id = ?, voice_channel_id = ?, status = 'active', sync_state = 'ready', archived_at = NULL, updated_at = ? WHERE guild_id = ? AND id = ? AND status = 'deleted'`,
          [owner.id, JSON.stringify((archive.managerIds || []).filter(id => restoredMembers.includes(String(id)) && String(id) !== owner.id)), JSON.stringify(restoredMembers), role.id, text.id, thread?.id || null, voice.id, now, String(guild.id), Number(groupId)]);
        await tx.run('INSERT INTO group_audit_log(guild_id,group_id,actor_id,action,details_json,created_at) VALUES(?,?,?,?,?,?)',
          [String(guild.id), Number(groupId), actorId ? String(actorId) : null, 'group_restore', JSON.stringify({ ownerId: owner.id, previousOwnerId: group.owner_id, memberIds: restoredMembers, roleId: role.id, textId: text.id, threadId: thread?.id || null, voiceId: voice.id }), now]);
      }, 'group-restore');
      return await getGroup(guild.id, groupId);
    } catch (error) {
      for (const resource of created.reverse()) await resource?.delete?.('Rollback failed group restore').catch(() => {});
      if (role) await role.delete('Rollback failed group restore').catch(() => {});
      throw error;
    } finally { await releaseOperationLock(operationKey, operationToken); }
  });
}
async function deleteGroup(guild, groupId, actorId) {
  return withLock(`delete:${guild.id}:${groupId}`, async () => {
    const operationKey = `guild:${guild.id}:group:${groupId}:delete`;
    const operationToken = await acquireOperationLock(operationKey, 180000);
    if (!operationToken) throw new Error('GROUP_OPERATION_BUSY');
    if (!global.groupResourceDeleteBypass) global.groupResourceDeleteBypass = new Set();
    const deleteBypassKey = `${guild.id}:${groupId}`;
    global.groupResourceDeleteBypass.add(deleteBypassKey);
    const releaseDeleteBypass = () => global.groupResourceDeleteBypass.delete(deleteBypassKey);
    const timeout = setTimeout(releaseDeleteBypass, 30_000);
    timeout.unref?.();
    try {
      const group = await getGroup(guild.id, groupId);
      if (!group) throw new Error('GROUP_NOT_FOUND');
      if (group.status === 'deleted') return true;
      const settings = await getSettings(guild.id);
      const textChannel = group.text_channel_id
        && (guild.channels.cache.get(String(group.text_channel_id)) || await guild.channels.fetch(String(group.text_channel_id)).catch(() => null));
      const sharedThreadParent = settings.chatMode === GROUP_CHAT_MODES.THREADS
        || String(textChannel?.name || '').toLowerCase() === 'groups-chat';
      const archive = await captureGroupArchive(guild, group, settings);
      await dbManager.run('UPDATE managed_groups SET archive_json = ?, updated_at = ? WHERE guild_id = ? AND id = ?', [JSON.stringify(archive), Date.now(), String(guild.id), Number(groupId)]);
      const resources = [
        ['thread', group.thread_id],
        ...(!sharedThreadParent ? [['text_channel', group.text_channel_id]] : []),
        ['voice_channel', group.voice_channel_id], ['role', group.role_id]
      ].filter(([, id]) => id);
      const resourceStatus = Object.fromEntries(resources.map(([type, id]) => [type, { id: String(id), state: 'pending' }]));
      if (sharedThreadParent && group.text_channel_id) resourceStatus.text_channel = { id: String(group.text_channel_id), state: 'preserved_shared_parent' };
      const failed = [];
      for (const [type, id] of resources) {
        const isRole = type === 'role';
        const collection = isRole ? guild.roles : guild.channels;
        const resource = collection.cache.get(String(id)) || await collection.fetch(String(id)).catch(error => {
          const missing = isRole ? error?.code === 10011 : error?.code === 10003;
          resourceStatus[type].state = missing ? 'missing' : 'fetch_failed';
          if (!missing) failed.push({ type: `${type}_fetch`, id: String(id), message: String(error?.message || error).slice(0, 200) });
          return null;
        });
        if (!resource) continue;
        try {
          await resource.delete('Delete managed group');
          resourceStatus[type].state = 'deleted';
        } catch (error) {
          resourceStatus[type].state = 'delete_failed';
          failed.push({ type, id: String(id), message: String(error?.message || error).slice(0, 200) });
        }
      }
      const now = Date.now();
      if (failed.length) {
        await dbManager.transaction(async tx => {
          await tx.run("UPDATE managed_groups SET status = 'orphaned', updated_at = ? WHERE guild_id = ? AND id = ?", [now, String(guild.id), Number(groupId)]);
          await tx.run('INSERT INTO group_audit_log(guild_id,group_id,actor_id,action,details_json,created_at) VALUES(?,?,?,?,?,?)', [String(guild.id), Number(groupId), actorId ? String(actorId) : null, 'group_delete_incomplete', JSON.stringify({ failed, resources: resourceStatus, retryable: true }), now]);
        }, 'group-delete-incomplete');
        throw new Error('GROUP_DELETE_PARTIAL');
      }
      await dbManager.transaction(async tx => {
        await tx.run("UPDATE managed_groups SET status = 'deleted', archived_at = ?, updated_at = ? WHERE guild_id = ? AND id = ?", [now, now, String(guild.id), Number(groupId)]);
        await tx.run('INSERT INTO group_audit_log(guild_id,group_id,actor_id,action,details_json,created_at) VALUES(?,?,?,?,?,?)', [String(guild.id), Number(groupId), actorId ? String(actorId) : null, 'group_delete', JSON.stringify({ resources: resourceStatus }), now]);
      }, 'group-delete');
      // Remove global leader/manager roles only when the deleted group was their last entitlement.
      try {
      const remaining = await listGroups(guild.id);
      const roleCleanup = new Map();
      if (settings.leaderRoleId && !remaining.some(item => String(item.owner_id) === String(group.owner_id))) roleCleanup.set(String(group.owner_id), settings.leaderRoleId);
      for (const managerId of group.managerIds) {
        if (settings.managerRoleId && !remaining.some(item => item.managerIds.includes(String(managerId)))) roleCleanup.set(String(managerId), settings.managerRoleId);
      }
      for (const [userId, roleId] of roleCleanup) {
        const member = await guild.members.fetch(userId).catch(() => null);
        const roleToRemove = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
        if (member && roleToRemove && member.roles.cache.has(roleToRemove.id)) await member.roles.remove(roleToRemove, 'Group deleted; no remaining role entitlement');
      }
    } catch (error) {
      await audit(guild.id, actorId, groupId, 'group_role_cleanup_incomplete', { message: String(error?.message || error).slice(0, 300) }).catch(() => null);
    }
      return true;
    } finally {
      clearTimeout(timeout);
      releaseDeleteBypass();
      await releaseOperationLock(operationKey, operationToken);
    }
  });
}
async function acquireOperationLock(lockKey, ttlMs = 120000) {
  await schema();
  const key = String(lockKey);
  const ownerToken = randomBytes(16).toString('hex');
  const now = Date.now();
  const lockedUntil = now + Math.max(1000, Number(ttlMs) || 120000);
  const acquired = await dbManager.transaction(async tx => {
    const current = await tx.get('SELECT owner_token, locked_until FROM group_operation_locks WHERE lock_key = ?', [key]);
    if (current && Number(current.locked_until) > now) return false;
    await tx.run('INSERT INTO group_operation_locks(lock_key, owner_token, locked_until, updated_at) VALUES(?,?,?,?) ON CONFLICT(lock_key) DO UPDATE SET owner_token=excluded.owner_token, locked_until=excluded.locked_until, updated_at=excluded.updated_at', [key, ownerToken, lockedUntil, now]);
    return true;
  }, 'group-operation-lock');
  return acquired ? ownerToken : null;
}
async function releaseOperationLock(lockKey, ownerToken) {
  if (!ownerToken) return;
  await schema();
  await dbManager.run('DELETE FROM group_operation_locks WHERE lock_key = ? AND owner_token = ?', [String(lockKey), String(ownerToken)]).catch(() => {});
}
module.exports = { GROUP_CHAT_MODES, GROUP_DEFAULTS, schema, getSettings, saveSettings, listGroups, getGroup, getGroupForChannel, audit, runtimeLog, logGroupEvent, isOwner, isBotOwner, isSystemManager, canManageGroupAdmin, canManageSystem, canManageGroup, channelBelongs, validateConfig, setSystemUser, setSystemRole, updateGroup, addMember, removeMember, setManagers, setBlocked, resetPoints, adjustGroupPoints, adjustAllGroupPoints, adjustMemberPoints, setRule, getRules, recordActivity, explainActivity, listMemberPoints, listPointsLedger, pruneGroupHistory, upsertVoiceSession, listVoiceSessions, deleteVoiceSession, getMemberPoints, getOrCreateSharedGroupChat, createGroup, deleteGroup, restoreGroup, acquireOperationLock, releaseOperationLock };
