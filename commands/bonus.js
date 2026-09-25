const {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder,
  AuditLogEvent, ChannelType, ModalBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle, UserSelectMenuBuilder, PermissionsBitField
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { getDatabase, dbManager } = require('../utils/database');
const { createBonusManager, BONUS_METRICS } = require('../utils/bonusManager');
const { buildBonusTopImage, normalizeHex } = require('../utils/bonusTopRenderer');
const colorManager = require('../utils/colorManager');
const interactionRouter = require('../utils/interactionRouter');
const name = 'bonus';
const aliases = [];
const roleHistoryPath = path.join(__dirname, '..', 'data', 'roleGrantHistory.json');
const activeAddFlows = new Map();
const pendingRuleChanges = new Map();
const voiceSessions = new Map();
const renderTimers = new Map();
const lastRenderAt = new Map();
const activeBoardPanels = new Map();
const roleAuditCache = new Map();
const guildRoleAuditCache = new Map();
const groupSearchCache = new Map();
const voiceTrackingCache = new Map();
const displayEntityCache = new Map();
const boardRefreshLocks = new Map();
const boardRefreshQueued = new Map();
const boardPermissionBackoff = new Map();
const ownerAvatarCooldowns = new Map();
const boardPageState = new Map();
const auditFilterState = new Map();
const auditPublishCursor = new Map();
const memberOperationLocks = new Map();
const DISPLAY_CACHE_TTL_MS = 60 * 1000;
const DISPLAY_MEMBER_BATCH_SIZE = 100;
const OWNER_AVATAR_COOLDOWN_MS = 10 * 60 * 1000;
const BOARD_PERMISSION_BACKOFF_MS = 60 * 1000;
const VOICE_SESSION_MAX_STALE_MS = 24 * 60 * 60 * 1000;
let lastCacheCleanupAt = 0;
let manager;
let boundClient = null;
let voiceInterval = null;
let boardRefreshInterval = null;
let lastEventPruneAt = 0;
let roleHistoryCache = { mtime: 0, value: {} };
let lastVoiceCleanupAt = 0;

async function withMemberLock(guildId, userId, operation) {
  const key = `${String(guildId)}:${String(userId)}`;
  const previous = memberOperationLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  memberOperationLocks.set(key, current);
  await previous.catch(() => {});
  try { return await operation(); }
  finally {
    release();
    if (memberOperationLocks.get(key) === current) memberOperationLocks.delete(key);
  }
}

function getManager() {
  if (!manager) {
    const database = getDatabase();
    if (!database.isInitialized || database.isDegraded) throw new Error('BONUS_DATABASE_NOT_PERSISTENT');
    manager = createBonusManager(database);
  }
  return manager;
}

async function ensureBonusDatabase() {
  if (dbManager.isDegraded && typeof dbManager.recoverPersistent === 'function') await dbManager.recoverPersistent();
  if (!dbManager.isInitialized) await dbManager.initialize();
  if (!dbManager.isInitialized || dbManager.isDegraded) throw new Error('BONUS_DATABASE_NOT_PERSISTENT');
  return dbManager;
}

function idKey(guildId, userId) { return `${guildId}:${userId}`; }
function parseBonusCustomId(customId) {
  const [prefix, action, ...parts] = String(customId || '').split(':');
  return { prefix, action, parts };
}
function getRoleIds(member) { return member?.roles?.cache ? Array.from(member.roles.cache.keys(), String) : []; }
function isGuildText(channel) {
  return Boolean(channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement));
}
function safeName(value, max = 80) { return String(value || '').replace(/[\u0000-\u001f]/g, '').slice(0, max); }

function validateAvatarUrl(value) {
  const url = String(value || '').trim();
  if (!url) return { valid: true, url: null };
  if (url.length > 500) return { valid: false, reason: 'length' };
  let parsed;
  try { parsed = new URL(url); } catch { return { valid: false, reason: 'format' }; }
  if (parsed.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(parsed.hostname.toLowerCase())) {
    return { valid: false, reason: 'host' };
  }
  if (!/\.(png|jpe?g|webp|gif)$/i.test(parsed.pathname)) return { valid: false, reason: 'extension' };
  return { valid: true, url };
}

async function verifyAvatarUrl(value) {
  const checked = validateAvatarUrl(value);
  if (!checked.valid || !checked.url) return checked;
  if (typeof fetch !== 'function') return checked;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(checked.url, { method: 'HEAD', redirect: 'manual', signal: controller.signal });
    if (!response.ok && !(response.status >= 300 && response.status < 400)) return { valid: false, reason: 'unreachable' };
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    const length = Number(response.headers.get('content-length') || 0);
    if (type && !type.startsWith('image/')) return { valid: false, reason: 'content-type' };
    if (length > 5 * 1024 * 1024) return { valid: false, reason: 'size' };
    return checked;
  } catch {
    return { valid: false, reason: 'unreachable' };
  } finally { clearTimeout(timer); }
}

function cleanupBonusCaches(now = Date.now()) {
  for (const [key, value] of roleAuditCache) if (!value || now - Number(value.checkedAt || 0) > 5 * 60 * 1000) roleAuditCache.delete(key);
  for (const [key, value] of guildRoleAuditCache) if (!value || now - Number(value.checkedAt || 0) > 5 * 60 * 1000) guildRoleAuditCache.delete(key);
  for (const [key, value] of groupSearchCache) if (!value || now - Number(value.createdAt || 0) > 5 * 60 * 1000) groupSearchCache.delete(key);
  for (const [key, value] of displayEntityCache) if (!value || Number(value.expiresAt || 0) <= now) displayEntityCache.delete(key);
  for (const [key, value] of voiceTrackingCache) if (!value || Number(value.expiresAt || 0) <= now) voiceTrackingCache.delete(key);
  for (const [key, value] of ownerAvatarCooldowns) if (now - Number(value || 0) > OWNER_AVATAR_COOLDOWN_MS) ownerAvatarCooldowns.delete(key);
  for (const [key, value] of boardPermissionBackoff) if (Number(value || 0) <= now) boardPermissionBackoff.delete(key);
  for (const [key, value] of lastRenderAt) if (now - Number(value || 0) > 15 * 60 * 1000) lastRenderAt.delete(key);
  for (const [key, value] of activeBoardPanels) if (Number(value || 0) <= now) activeBoardPanels.delete(key);
  if (auditFilterState.size > 500) auditFilterState.clear();
}

function readRoleHistory(guildId, userId) {
  try {
    const stat = fs.statSync(roleHistoryPath);
    if (roleHistoryCache.mtime !== stat.mtimeMs) {
      roleHistoryCache = { mtime: stat.mtimeMs, value: JSON.parse(fs.readFileSync(roleHistoryPath, 'utf8')) };
    }
    const record = roleHistoryCache.value?.[String(guildId)]?.[String(userId)];
    return record && typeof record === 'object' ? record : {};
  } catch {
    return {};
  }
}

async function readRoleHistoryForMember(guild, member) {
  const cacheKey = idKey(guild.id, member.id);
  const cached = roleAuditCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < 60000) return { ...cached.values };
  const manager = getManager();
  const history = { ...readRoleHistory(guild.id, member.id) };
  const groups = await manager.listGroups(guild.id, true).catch(() => []);
  const heldGroupRoles = groups.map(group => String(group.role_id)).filter(roleId => member.roles?.cache?.has(roleId));
  const persistedHistory = await manager.getRoleGrantHistory(guild.id, member.id, heldGroupRoles).catch(() => ({}));
  Object.assign(history, persistedHistory);
  const missing = heldGroupRoles.filter(roleId => !Number(history[roleId] || 0));
  if (!missing.length) {
    await manager.seedRoleGrantHistory(guild.id, member.id, history).catch(() => {});
    roleAuditCache.set(cacheKey, { checkedAt: Date.now(), values: history });
    return history;
  }
  let auditSnapshot = guildRoleAuditCache.get(String(guild.id));
  if (!auditSnapshot || Date.now() - auditSnapshot.checkedAt >= 60000) {
    const grants = new Map();
    try {
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 100 });
      const entries = Array.from(logs.entries.values()).sort((a, b) => Number(a.createdTimestamp || 0) - Number(b.createdTimestamp || 0));
      for (const entry of entries) {
        const targetId = String(entry.target?.id || '');
        if (!targetId) continue;
        for (const change of entry.changes || []) {
          if (change.key === '$add' && Array.isArray(change.new)) {
            for (const role of change.new) grants.set(`${targetId}:${String(role?.id || '')}`, Number(entry.createdTimestamp) || 0);
          } else if (change.key === '$remove' && Array.isArray(change.new || change.old)) {
            for (const role of (change.new || change.old)) grants.delete(`${targetId}:${String(role?.id || '')}`);
          }
        }
      }
    } catch {
      // عند غياب صلاحية السجل لا نخمن القروب؛ يبقى العضو بلا استهداف مؤقتاً.
    }
    auditSnapshot = { checkedAt: Date.now(), grants };
    guildRoleAuditCache.set(String(guild.id), auditSnapshot);
  }
  const values = {};
  for (const roleId of missing) {
    const timestamp = Number(auditSnapshot.grants.get(`${member.id}:${roleId}`) || 0);
    if (timestamp > 0) values[roleId] = timestamp;
  }
  const mergedHistory = { ...history, ...values };
  await manager.seedRoleGrantHistory(guild.id, member.id, mergedHistory).catch(() => {});
  roleAuditCache.set(cacheKey, { checkedAt: Date.now(), values: mergedHistory });
  return mergedHistory;
}

function getBotOwners(context = {}) {
  const current = global.BOT_OWNERS;
  const owners = Array.isArray(current) ? current : (Array.isArray(context.BOT_OWNERS) ? context.BOT_OWNERS : []);
  return owners.map(String);
}

async function isManager(guild, member, userId, context = {}) {
  if (!guild || !member || !userId) return false;
  if (guild.ownerId === String(userId) || getBotOwners(context).includes(String(userId))) return true;
  const db = getManager();
  const config = await db.readConfig(guild.id);
  const managers = config.managers || { userIds: [], roleIds: [], responsibilities: [] };
  if ((managers.userIds || []).map(String).includes(String(userId))) return true;
  if ((managers.roleIds || []).some(roleId => member.roles?.cache?.has(String(roleId)))) return true;
  const allResponsibilities = global.responsibilities && typeof global.responsibilities === 'object' ? global.responsibilities : {};
  for (const responsibilityName of managers.responsibilities || []) {
    const responsibility = allResponsibilities[responsibilityName];
    if (!responsibility) continue;
    if ((responsibility.responsibles || []).map(String).includes(String(userId))) return true;
    if ((responsibility.roles || []).some(roleId => member.roles?.cache?.has(String(roleId)))) return true;
  }
  return false;
}

async function deny(interaction, text = 'هذه اللوحة للمسؤولين المحددين فقط.') {
  const payload = { embeds: [colorManager.createEmbed().setTitle('Access Denied').setDescription(`❌ ${text}`)], ephemeral: true };
  if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
  else await interaction.reply(payload).catch(() => {});
}

async function requireManager(interaction, context = {}) {
  if (!interaction.guild || !await isManager(interaction.guild, interaction.member, interaction.user.id, context)) {
    await deny(interaction);
    return false;
  }
  return true;
}

function buildHomeEmbed(guild, config, groups, rules, complete) {
  const lines = [
    `**Status :** ${complete ? 'Ready' : 'Setup Required'}`,
    `**Board Channel :** ${config.channelId ? `<#${config.channelId}>` : 'Not set'}`,
    `**Audit Channel :** ${config.auditChannelId ? `<#${config.auditChannelId}>` : 'Not set'}`,
    `**Board Color :** ${config.autoColor === false ? normalizeHex(config.color) : 'Auto server icon'}`,
    `**Active Groups :** ${groups.length}`,
    `**Message Rule :** ${rules.messages ? `${Number(rules.messages.threshold).toLocaleString()} messages = ${rules.messages.points} points` : 'Not set'}`,
    `**Voice Rule :** ${rules.voice_ms ? `${Number(rules.voice_ms.threshold) / 3600000} hours = ${rules.voice_ms.points} points` : 'Not set'}`
  ];
  return colorManager.createEmbed()
    .setTitle(`Bonus Settings • ${safeName(guild.name)}`)
    .setDescription(lines.join('\n'))
    .setColor(colorManager.getColor())
    .setFooter({ text: 'by Ahmed' });
}

function button(customId, label, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(ButtonStyle.Secondary);
}

function durationButtons(scope, groupId, userId = null) {
  const choices = [
    { token: '3600000', label: 'ساعة' },
    { token: '86400000', label: '24 ساعة' },
    { token: '604800000', label: '7 أيام' },
    { token: 'forever', label: 'حتى الإيقاف اليدوي' }
  ];
  return new ActionRowBuilder().addComponents(choices.map(choice => button(
    `bonus:double-on:${scope}:${groupId}:${userId || '0'}:${choice.token}`, choice.label, choice.token === 'forever' ? ButtonStyle.Primary : ButtonStyle.Secondary
  )));
}

function buildHomeRows() {
  return [
    new ActionRowBuilder().addComponents(
      button('bonus:managers', 'Managers'),
      button('bonus:rules', 'Rules'),
      button('bonus:channel', 'Board Channel'),
      button('bonus:audit-channel', 'Audit Channel'),
      button('bonus:color', 'Board Color')
    ),
    new ActionRowBuilder().addComponents(
      button('bonus:add-group', 'Add Group'),
      button('bonus:manage-groups', 'Manage Groups'),
      button('bonus:reset', 'Reset'),
      button('bonus:double', 'Double Bonus'),
      button('bonus:publish', 'Publish / Update', ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(button('bonus:audit', 'Audit Log'))
  ];
}

async function buildHome(guild) {
  const db = getManager();
  const [config, groups, rules, ready] = await Promise.all([
    db.readConfig(guild.id), db.listGroups(guild.id), db.getRules(guild.id), db.isReady(guild.id)
  ]);
  return { embeds: [buildHomeEmbed(guild, config, groups, rules, ready)], components: buildHomeRows() };
}

function structurePrivateResponse(payload) {
  if (!payload?.content || payload.embeds?.length || payload.files?.length || payload.attachments?.length) return payload;
  const raw = String(payload.content).trim();
  if (!raw) return payload;
  const lines = raw.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const first = lines.shift() || raw;
  const lower = raw.toLowerCase();
  const title = /تأكيد|confirm|هل تريد|سيتم/.test(lower) ? 'Confirmation Required'
    : /تم |تمت|نجاح|updated|saved|activated|disabled/.test(lower) ? 'Action Completed'
      : /اختر|select|حدد|choose/.test(lower) ? 'Select Option' : 'Bonus Settings';
  const fields = [];
  const fieldNames = {
    'الإجمالي الحالي': 'Current Total', 'بعد الإزالة': 'After Removal', 'رصيده الحالي': 'Current Balance',
    'رصيده بعد الإزالة': 'Balance After Removal', 'المنفذ': 'Actor', 'العضو': 'Target User',
    'القروب': 'Group', 'الرول': 'Role', 'المالك': 'Owner', 'المدة': 'Duration', 'الحالة': 'Status'
  };
  for (const [index, line] of lines.entries()) {
    const separator = line.match(/^([^:：]{1,80})[:：]\s*(.+)$/);
    const rawName = separator ? separator[1].trim() : `Details ${index + 1}`;
    fields.push({ name: fieldNames[rawName] || rawName, value: (separator ? separator[2] : line).slice(0, 1024), inline: false });
  }
  const mentions = [...raw.matchAll(/<@!?\d+>|<@&\d+>|<#\d+>/g)].map(match => match[0]);
  if (title === 'Action Completed') {
    if (mentions.length) fields.unshift({ name: 'Target', value: [...new Set(mentions)].join(' • '), inline: true });
    if (/إيقاف|disabled|deactivated/i.test(raw)) fields.push({ name: 'Status', value: 'Disabled', inline: true });
    else if (/تفعيل|activated|enabled/i.test(raw)) fields.push({ name: 'Status', value: 'Enabled', inline: true });
    else if (/تحديث|updated|saved|اعتماد|نشر|published/i.test(raw)) fields.push({ name: 'Status', value: 'Updated', inline: true });
    if (/دبل|double/i.test(raw)) fields.push({ name: 'Feature', value: 'Double Bonus ×2', inline: true });
  }
  const description = title === 'Action Completed'
    ? 'The requested action was completed successfully.'
    : first.slice(0, 4000);
  const embed = colorManager.createEmbed().setTitle(title).setDescription(description);
  if (fields.length) embed.addFields(fields.slice(0, 25));
  const normalized = { ...payload, embeds: [embed] };
  delete normalized.content;
  return normalized;
}

async function buildAuditPayload(guild, page = 0) {
  const filter = auditFilterState.get(String(guild.id)) || {};
  const result = await getManager().listAuditLog(guild.id, { page, limit: 10, ...filter });
  const fields = result.rows.map((row, index) => {
    let details = {};
    try { details = JSON.parse(row.details_json || '{}'); } catch { details = {}; }
    const before = details.before ? `\nBefore : ${JSON.stringify(details.before).slice(0, 180)}` : '';
    const after = details.after ? `\nAfter : ${JSON.stringify(details.after).slice(0, 180)}` : '';
    return {
      name: `${result.page * result.limit + index + 1}. ${safeName(row.action, 60)}`,
      value: `Actor : ${row.actor_id ? `<@${row.actor_id}>` : 'System'}\nTarget : ${row.target_user_id ? `<@${row.target_user_id}>` : '—'}${before}${after}`.slice(0, 1024),
      inline: false
    };
  });
  const pageCount = Math.max(1, Math.ceil(result.total / result.limit));
  const nav = [];
  if (result.page > 0) nav.push(button(`bonus:audit-page:${result.page - 1}`, 'السابق'));
  if (result.page + 1 < pageCount) nav.push(button(`bonus:audit-page:${result.page + 1}`, 'التالي'));
  const rows = [];
  if (nav.length) rows.push(new ActionRowBuilder().addComponents(nav));
  rows.push(new ActionRowBuilder().addComponents(button('bonus:audit-filter', 'فلترة'), button('bonus:home', 'رجوع')));
  const embed = colorManager.createEmbed().setTitle('Bonus Audit Log')
    .setDescription(`Page : ${result.page + 1} / ${pageCount}\nTotal Records : ${result.total}\nFilters : ${Object.keys(filter).length ? 'Applied' : 'None'}`)
    .addFields(fields.length ? fields : [{ name: 'No Records', value: 'No audit records found.', inline: false }]);
  return { embeds: [embed], components: rows };
}

async function showPrivatePanel(interaction, payload, update = false) {
  const boardMessage = isBonusBoardMessage(interaction.message);
  const shouldUpdateBoard = boardMessage && Array.isArray(payload.files) && payload.files.length > 0;
  payload = (!boardMessage || !shouldUpdateBoard) ? structurePrivateResponse(payload) : payload;
  const completedResult = payload?.embeds?.[0]?.data?.title === 'Action Completed';
  if (update && completedResult && !boardMessage) {
    const resultPayload = { ...payload, ephemeral: true };
    delete resultPayload.components;
    const originalPayload = await buildHome(interaction.guild);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(resultPayload).catch(() => {});
      await interaction.editReply(originalPayload).catch(() => {});
    } else {
      await interaction.update(originalPayload).catch(() => {});
      await interaction.followUp(resultPayload).catch(() => {});
    }
    return;
  }
  if (update && (interaction.message || interaction.deferred || interaction.replied) && (!boardMessage || shouldUpdateBoard)) {
    const cleanPayload = { ...payload };
    delete cleanPayload.ephemeral;
    const currentContent = String(interaction.message?.content || '');
    const currentCounter = currentContent.match(/^\*\*[^\n]*Groups\s+•\s+[^\n]*Points\*\*/)?.[0];
    if (currentCounter) {
      const content = String(cleanPayload.content || '');
      const newCounter = content.match(/^\*\*[^\n]*Groups\s+•\s+[^\n]*Points\*\*/)?.[0];
      const nextContent = content.replace(/^\*\*[^\n]*Groups\s+•\s+[^\n]*Points\*\*\n?/, '');
      cleanPayload.content = [newCounter || currentCounter, nextContent].filter(Boolean).join('\n');
    }
    if (!('files' in cleanPayload) && !('attachments' in cleanPayload) && interaction.message?.attachments?.size) {
      cleanPayload.attachments = Array.from(interaction.message.attachments.values(), attachment => ({
        id: attachment.id, filename: attachment.name, description: attachment.description || undefined
      }));
    }
    if (isBonusBoardMessage(interaction.message)) {
      if (Array.isArray(cleanPayload.files) && cleanPayload.files.length) activeBoardPanels.delete(String(interaction.guild?.id));
      else activeBoardPanels.set(String(interaction.guild?.id), Date.now() + 10 * 60 * 1000);
    }
    if (interaction.deferred || interaction.replied) await interaction.editReply(cleanPayload);
    else await interaction.update(cleanPayload);
    return;
  }
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ ...payload, ephemeral: true });
    return;
  }
  await interaction.reply({ ...payload, ephemeral: true });
}

function buildManagerPayload(guild, config, actorId, responsibilityPage = 0) {
  const managers = config.managers || { userIds: [], roleIds: [], responsibilities: [] };
  const embed = colorManager.createEmbed().setTitle('المسؤولون عن نظام البونس')
    .setDescription('اختر المستخدمين والرولات والمسؤوليات المسموح لها بإدارة نظام البونس. مالك السيرفر ومالكو البوت لهم صلاحية دائمة.')
    .addFields(
      { name: 'الأعضاء', value: managers.userIds?.length ? managers.userIds.map(id => `<@${id}>`).join('\n').slice(0, 1000) : 'لا يوجد', inline: true },
      { name: 'الرولات', value: managers.roleIds?.length ? managers.roleIds.map(id => `<@&${id}>`).join('\n').slice(0, 1000) : 'لا يوجد', inline: true },
      { name: 'المسؤوليات', value: managers.responsibilities?.length ? managers.responsibilities.map(safeName).join('\n').slice(0, 1000) : 'لا يوجد', inline: true }
    );
  const roleMenu = new RoleSelectMenuBuilder().setCustomId(`bonus:manager-roles:${actorId}`).setPlaceholder('اختر رولات المسؤولين').setMinValues(0).setMaxValues(25);
  if (managers.roleIds?.length) roleMenu.setDefaultRoles(managers.roleIds.slice(0, 25));
  const userMenu = new UserSelectMenuBuilder().setCustomId(`bonus:manager-users:${actorId}`).setPlaceholder('اختر المسؤولين من الأعضاء').setMinValues(0).setMaxValues(25);
  if (managers.userIds?.length) userMenu.setDefaultUsers(managers.userIds.slice(0, 25));
  const allResponsibilityNames = Object.keys(global.responsibilities || {});
  const responsibilityPages = Math.max(1, Math.ceil(allResponsibilityNames.length / 25));
  const safeResponsibilityPage = Math.max(0, Math.min(responsibilityPages - 1, Number(responsibilityPage) || 0));
  const responsibilityOptions = allResponsibilityNames.slice(safeResponsibilityPage * 25, (safeResponsibilityPage + 1) * 25).map(name => ({
    label: safeName(name, 100), value: name,
    default: (managers.responsibilities || []).includes(name)
  }));
  const rows = [new ActionRowBuilder().addComponents(roleMenu), new ActionRowBuilder().addComponents(userMenu)];
  if (responsibilityOptions.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`bonus:manager-responsibilities:${actorId}:${safeResponsibilityPage}`).setPlaceholder(`اختر المسؤوليات (${safeResponsibilityPage + 1}/${responsibilityPages})`)
      .setMinValues(0).setMaxValues(responsibilityOptions.length).addOptions(responsibilityOptions)));
  }
  if (responsibilityPages > 1) {
    const pageButtons = [];
    if (safeResponsibilityPage > 0) pageButtons.push(button(`bonus:manager-resp-page:${actorId}:${safeResponsibilityPage - 1}`, 'المسؤوليات السابقة'));
    if (safeResponsibilityPage + 1 < responsibilityPages) pageButtons.push(button(`bonus:manager-resp-page:${actorId}:${safeResponsibilityPage + 1}`, 'المسؤوليات التالية'));
    rows.push(new ActionRowBuilder().addComponents(pageButtons));
  }
  rows.push(new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع')));
  return { embeds: [embed], components: rows };
}

function buildGroupSelect(action, groups, page = 0) {
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(groups.length / pageSize));
  const safePage = Math.max(0, Math.min(pageCount - 1, Number(page) || 0));
  const options = groups.slice(safePage * pageSize, (safePage + 1) * pageSize).map(group => ({
    label: safeName(group.role_name || `قروب ${group.role_id}`, 100),
    value: String(group.id),
    description: `المالك: ${safeName(group.owner_name || 'غير محدد', 80)}`
  }));
  if (!options.length) return { content: 'لا توجد قروبات نشطة.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] };
  const menu = new StringSelectMenuBuilder().setCustomId(`bonus:select:${action}:${safePage}`).setPlaceholder('اختر القروب').setMinValues(1).setMaxValues(1).addOptions(options);
  const rows = [new ActionRowBuilder().addComponents(menu)];
  const nav = [];
  if (safePage > 0) nav.push(button(`bonus:page:${action}:${safePage - 1}`, 'السابق'));
  if (safePage + 1 < pageCount) nav.push(button(`bonus:page:${action}:${safePage + 1}`, 'التالي'));
  nav.push(button(`bonus:group-search:${action}`, 'بحث'));
  nav.push(button('bonus:home', 'إلغاء / رجوع'));
  rows.push(new ActionRowBuilder().addComponents(nav));
  return { content: `اختر القروب المطلوب (صفحة ${safePage + 1}/${pageCount}):`, components: rows };
}

async function getGroupsForDisplay(guild, sourceGroups = null) {
  const groups = sourceGroups || await getManager().listGroups(guild.id, false);
  const roleIds = [...new Set(groups.map(group => String(group.role_id)).filter(Boolean))];
  const ownerIds = [...new Set(groups.map(group => String(group.owner_id)).filter(Boolean))];
  const cacheKey = String(guild.id);
  let cached = displayEntityCache.get(cacheKey);
  if (!cached || cached.expiresAt <= Date.now()) {
    cached = { roles: new Map(), members: new Map(), expiresAt: Date.now() + DISPLAY_CACHE_TTL_MS };
    displayEntityCache.set(cacheKey, cached);
  }

  // الرولات يمكن جلبها دفعة واحدة، بدلاً من طلب مستقل لكل رول.
  const missingRoleIds = roleIds.filter(roleId => !guild.roles.cache.has(roleId) && !cached.roles.has(roleId));
  if (missingRoleIds.length && typeof guild.roles.fetch === 'function') {
    const fetchedRoles = await guild.roles.fetch().catch(error => {
      console.error('[bonus] batch role fetch failed:', error);
      return null;
    });
    if (fetchedRoles) for (const role of fetchedRoles.values()) cached.roles.set(String(role.id), role);
  }

  // جلب المالكين على دفعات Discord، مع عدم تكرار المعرفات والكاش لمدة قصيرة.
  const missingOwnerIds = ownerIds.filter(ownerId => !guild.members.cache.has(ownerId) && !cached.members.has(ownerId));
  if (typeof guild.members.fetch === 'function') {
    for (let index = 0; index < missingOwnerIds.length; index += DISPLAY_MEMBER_BATCH_SIZE) {
      const batch = missingOwnerIds.slice(index, index + DISPLAY_MEMBER_BATCH_SIZE);
      if (!batch.length) continue;
      const fetchedMembers = await guild.members.fetch({ user: batch }).catch(error => {
        console.error('[bonus] batch member fetch failed:', error);
        return null;
      });
      if (fetchedMembers) for (const member of fetchedMembers.values()) cached.members.set(String(member.id), member);
    }
  }

  cached.expiresAt = Date.now() + DISPLAY_CACHE_TTL_MS;
  return groups.map(group => ({
    ...group,
    role_name: guild.roles.cache.get(String(group.role_id))?.name || cached.roles.get(String(group.role_id))?.name || 'رول محذوف',
    owner_name: guild.members.cache.get(String(group.owner_id))?.displayName
      || guild.members.cache.get(String(group.owner_id))?.user?.username
      || cached.members.get(String(group.owner_id))?.displayName
      || cached.members.get(String(group.owner_id))?.user?.username
      || 'مالك غير موجود'
  }));
}

async function resolveCurrentGroupForMember(guild, member) {
  if (!guild || !member) return { groups: [], targetGroupId: null, roleHistory: {} };
  const db = getManager();
  const groups = await db.listGroups(guild.id, false);
  const roleHistory = await readRoleHistoryForMember(guild, member);
  const targetGroupId = await db.resolveTargetGroup(guild.id, member.id, getRoleIds(member), roleHistory);
  return { groups, targetGroupId: targetGroupId == null ? null : Number(targetGroupId), roleHistory };
}

async function refreshBoardNow(guild, force = false) {
  if (!guild || !boundClient) return;
  const blockedUntil = boardPermissionBackoff.get(String(guild.id)) || 0;
  if (!force && blockedUntil > Date.now()) return;
  const db = getManager();
  const config = await db.readConfig(guild.id);
  if (!config.topMessageId || !config.channelId) return;
  const now = Date.now();
  const panelExpiry = activeBoardPanels.get(String(guild.id)) || 0;
  const preservePanel = panelExpiry > now;
  if (panelExpiry && panelExpiry <= now) activeBoardPanels.delete(String(guild.id));
  const last = lastRenderAt.get(guild.id) || 0;
  if (!force && now - last < 30000) {
    if (!renderTimers.has(guild.id)) {
      renderTimers.set(guild.id, setTimeout(() => {
        renderTimers.delete(guild.id);
        maybeRefreshBoard(guild, false).catch(error => console.error('[bonus] render refresh failed:', error));
      }, Math.max(1000, 30000 - (now - last))));
    }
    return;
  }
  lastRenderAt.set(guild.id, now);
  const channel = await guild.channels.fetch(String(config.channelId)).catch(error => {
    if (error?.code === 50001 || error?.code === 50013) boardPermissionBackoff.set(String(guild.id), Date.now() + BOARD_PERMISSION_BACKOFF_MS);
    return null;
  });
  if (!isGuildText(channel)) return;
  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  const permissions = botMember ? channel.permissionsFor(botMember) : null;
  if (!permissions || !permissions.has([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.AttachFiles,
    PermissionsBitField.Flags.ReadMessageHistory
  ])) {
    boardPermissionBackoff.set(String(guild.id), Date.now() + BOARD_PERMISSION_BACKOFF_MS);
    return;
  }
  const boardMessage = await channel.messages.fetch(String(config.topMessageId)).catch(error => {
    if (error?.code === 50001 || error?.code === 50013) boardPermissionBackoff.set(String(guild.id), Date.now() + BOARD_PERMISSION_BACKOFF_MS);
    return null;
  });
  if (!boardMessage) return;
  const payload = await buildBoardPayload(guild, '', boardPageState.get(String(guild.id)) || 0);
  if (preservePanel) {
    const currentCounter = String(boardMessage.content || '').match(/^\*\*[^\n]*Groups\s+•\s+[^\n]*Points\*\*/)?.[0];
    const newCounter = String(payload.content || '').match(/^\*\*[^\n]*Groups\s+•\s+[^\n]*Points\*\*/)?.[0];
    const prompt = String(boardMessage.content || '').replace(/^\*\*[^\n]*Groups\s+•\s+[^\n]*Points\*\*\n?/, '').trim();
    payload.content = [newCounter || currentCounter, prompt].filter(Boolean).join('\n');
    payload.components = boardMessage.components;
    if (boardMessage.embeds?.length) payload.embeds = boardMessage.embeds;
  }
  try {
    await boardMessage.edit(payload);
    boardPermissionBackoff.delete(String(guild.id));
  } catch (error) {
    if (error?.code === 50001 || error?.code === 50013) boardPermissionBackoff.set(String(guild.id), Date.now() + BOARD_PERMISSION_BACKOFF_MS);
    throw error;
  }
}

async function maybeRefreshBoard(guild, force = false) {
  if (!guild) return;
  const key = String(guild.id);
  const running = boardRefreshLocks.get(key);
  if (running) {
    boardRefreshQueued.set(key, Boolean(force) || Boolean(boardRefreshQueued.get(key)));
    return running;
  }
  const task = refreshBoardNow(guild, force);
  boardRefreshLocks.set(key, task);
  try {
    await task;
  } finally {
    if (boardRefreshLocks.get(key) === task) boardRefreshLocks.delete(key);
    if (boardRefreshQueued.has(key)) {
      const queuedForce = boardRefreshQueued.get(key);
      boardRefreshQueued.delete(key);
      setImmediate(() => maybeRefreshBoard(guild, queuedForce).catch(error => console.error('[bonus] queued board refresh failed:', error)));
    }
  }
}

function buildMemberSelect(action, group, members, page = 0) {
  const pageSize = 25;
  const sorted = Array.from(members || []).sort((a, b) =>
    String(a.displayName || a.user?.username || a.id).localeCompare(String(b.displayName || b.user?.username || b.id))
  );
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.max(0, Math.min(pageCount - 1, Number(page) || 0));
  const options = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize).map(member => ({
    label: safeName(member.displayName || member.user?.username || member.id, 100),
    value: String(member.id),
    description: `@${safeName(member.user?.username || member.id, 80)}`
  }));
  if (!options.length) return { content: 'لا يوجد أعضاء حاليًا داخل رول هذا القروب.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] };
  const menu = new StringSelectMenuBuilder().setCustomId(`bonus:select:${action}:${group.id}:${safePage}`)
    .setPlaceholder(`اختر عضوًا من الرول (${safePage + 1}/${pageCount})`).setMinValues(1).setMaxValues(1).addOptions(options);
  const nav = [];
  if (safePage > 0) nav.push(button(`bonus:page:${action}:${group.id}:${safePage - 1}`, 'السابق'));
  if (safePage + 1 < pageCount) nav.push(button(`bonus:page:${action}:${group.id}:${safePage + 1}`, 'التالي'));
  nav.push(button('bonus:home', 'رجوع'));
  return {
    embeds: [colorManager.createEmbed().setTitle('Double Bonus • Select Member')
      .setDescription(`القروب: <@&${group.role_id}>\nالاختيار محصور بأعضاء رول القروب فقط.`)],
    components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(nav)]
  };
}

function buildPublicRows() {
  const rows = [new ActionRowBuilder().addComponents(
    button('bonus:public-settings', 'Settings', ButtonStyle.Secondary),
    button('bonus:double', 'Double Bonus', ButtonStyle.Secondary),
    button('bonus:owner-avatar', 'Group Avatar', ButtonStyle.Secondary),
    button('bonus:private-top', 'View Rankings', ButtonStyle.Secondary),
    button('bonus:my-group', 'My Group', ButtonStyle.Secondary)
  )];
  return rows;
}

function boardCounter(summary) {
  const groups = Number(summary?.groups) || 0;
  const points = Number(summary?.points) || 0;
  return `**${groups.toLocaleString('en-US')} Groups  •  ${points.toLocaleString('en-US')} Points**`;
}

async function buildBoardPayload(guild, prompt = '', requestedPage = 0) {
  const db = getManager();
  const config = await db.readConfig(guild.id);
  const [summary, totalGroups] = await Promise.all([
    db.getLeaderboardSummary(guild.id), db.listGroups(guild.id, false)
  ]);
  const leaderboard = await db.getLeaderboard(guild.id, 10, 0);
  const groups = await getGroupsForDisplay(guild, leaderboard);
  groups.forEach((group, index) => {
    if (!group.role_name || group.role_name === 'رول محذوف') group.role_name = `قروب ${index + 1}`;
    if (!group.owner_name || group.owner_name === 'مالك غير موجود') group.owner_name = 'مالك غير محدد';
  });
  const attachment = await buildBonusTopImage({ guild, groups, config, updatedAt: Date.now() });
  return { content: [boardCounter(summary), prompt].filter(Boolean).join('\n'), files: [attachment], attachments: [], components: buildPublicRows() };
}

async function buildPrivateTopPayload(guild, requestedPage = 0) {
  const db = getManager();
  const totalGroups = await db.listGroups(guild.id, false);
  const pageCount = Math.max(1, Math.ceil(totalGroups.length / 10));
  const page = Math.max(0, Math.min(pageCount - 1, Number(requestedPage) || 0));
  const [summary, leaderboard] = await Promise.all([
    db.getLeaderboardSummary(guild.id), db.getLeaderboard(guild.id, 10, page * 10)
  ]);
  const config = await db.readConfig(guild.id);
  const groups = await getGroupsForDisplay(guild, leaderboard);
  groups.forEach((group, index) => {
    if (!group.role_name || group.role_name === 'رول محذوف') group.role_name = `Group ${page * 10 + index + 1}`;
    if (!group.owner_name || group.owner_name === 'مالك غير موجود') group.owner_name = 'Unknown owner';
  });
  const attachment = await buildBonusTopImage({ guild, groups, config, updatedAt: Date.now() });
  const nav = [];
  if (page > 0) nav.push(button(`bonus:private-top-page:${page - 1}`, 'Previous'));
  if (page + 1 < pageCount) nav.push(button(`bonus:private-top-page:${page + 1}`, 'Next'));
  return {
    content: `${boardCounter(summary)}\nPage : ${page + 1} / ${pageCount}`,
    files: [attachment], attachments: [],
    components: nav.length ? [new ActionRowBuilder().addComponents(nav)] : []
  };
}

async function buildMyGroupPayload(guild, member) {
  const db = getManager();
  const resolved = await resolveCurrentGroupForMember(guild, member);
  const groupId = resolved.targetGroupId;
  const embed = colorManager.createEmbed().setTitle('My Bonus Group')
    .setDescription(`Member : <@${member.id}>\nStatus : ${groupId == null ? 'Unassigned' : 'Assigned'}`);
  if (groupId == null) {
    embed.addFields({ name: 'Group', value: 'You are not assigned to an active bonus group.', inline: false });
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button('bonus:home', 'Close'))] };
  }
  const [group, balance, allGroups, groupPoints, userDoubles, groupDouble] = await Promise.all([
    Promise.resolve(resolved.groups.find(item => Number(item.id) === Number(groupId))),
    db.getBalance(guild.id, member.id),
    db.listGroups(guild.id, false),
    db.getGroupPoints(guild.id, groupId),
    db.listActiveUserMultipliers(guild.id, groupId),
    db.getActiveGroupMultiplier(guild.id, groupId)
  ]);
  let rank = 0;
  for (let offset = 0; offset < allGroups.length; offset += 25) {
    const page = await db.getLeaderboard(guild.id, 25, offset);
    const index = page.findIndex(row => Number(row.id) === Number(groupId));
    if (index >= 0) { rank = offset + index + 1; break; }
  }
  const role = group ? guild.roles.cache.get(String(group.role_id)) : null;
  const userDouble = userDoubles.some(row => String(row.user_id) === String(member.id));
  embed.setThumbnail(group?.avatar_url || guild.iconURL?.({ extension: 'png', size: 256 }) || undefined)
    .addFields(
      { name: 'Group', value: group ? `<@&${group.role_id}>\n${safeName(role?.name || 'Unknown role')}` : 'Unknown group', inline: true },
      { name: 'Rank', value: rank > 0 ? `#${rank} / ${allGroups.length}` : '—', inline: true },
      { name: 'My Points', value: (Number(balance?.points) || 0).toLocaleString('en-US'), inline: true },
      { name: 'Group Points', value: (Number(groupPoints) || 0).toLocaleString('en-US'), inline: true },
      { name: 'Message Progress', value: Number(balance?.message_progress || 0).toLocaleString('en-US'), inline: true },
      { name: 'Voice Progress', value: `${(Number(balance?.voice_progress_ms || 0) / 3600000).toFixed(2)} hours`, inline: true },
      { name: 'Double Bonus', value: userDouble || groupDouble ? 'Active ×2' : 'Inactive', inline: true },
      { name: 'Owner', value: group?.owner_id ? `<@${group.owner_id}>` : 'Unknown', inline: true }
    );
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button('bonus:home', 'Close'))] };
}

function isBonusBoardMessage(message) {
  return Boolean(message?.attachments?.some(attachment => attachment.name === 'bonus-top.png'));
}

async function buildReturnPayload(interaction, prompt = '') {
  if (isBonusBoardMessage(interaction.message)) return { ...(await buildHome(interaction.guild)), content: prompt };
  return { ...(await buildHome(interaction.guild)), content: prompt };
}

async function publishBoard(guild, actorId) {
  const db = getManager();
  const config = await db.readConfig(guild.id);
  const groups = await db.listGroups(guild.id);
  const rules = await db.getRules(guild.id);
  if (!config.channelId) throw new Error('CHANNEL_REQUIRED');
  if (!groups.length) throw new Error('GROUP_REQUIRED');
  if (!Object.keys(rules).length) throw new Error('RULE_REQUIRED');
  const channel = await guild.channels.fetch(String(config.channelId)).catch(() => null);
  if (!isGuildText(channel)) throw new Error('CHANNEL_NOT_FOUND');
  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  const channelPermissions = botMember ? channel.permissionsFor(botMember) : null;
  if (!channelPermissions || !channelPermissions.has([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.AttachFiles,
    PermissionsBitField.Flags.ReadMessageHistory
  ])) throw new Error('MISSING_CHANNEL_PERMISSIONS');
  const payload = await buildBoardPayload(guild);
  let message = config.topMessageId ? await channel.messages.fetch(String(config.topMessageId)).catch(() => null) : null;
  if (message) {
    await message.edit(payload);
  } else {
    message = await channel.send(payload);
  }
  await db.saveConfig(guild.id, { topMessageId: message.id, channelId: channel.id, setupCompletedAt: Date.now() }, actorId);
  lastRenderAt.set(guild.id, Date.now());
  return message;
}

async function checkSetupInitPermissions(message, context) {
  const db = getManager();
  const config = await db.readConfig(message.guild.id);
  const initialized = Boolean(config.managers && ((config.managers.userIds || []).length || (config.managers.roleIds || []).length || (config.managers.responsibilities || []).length));
  if (!initialized) {
    return message.guild.ownerId === message.author.id || getBotOwners(context).includes(message.author.id);
  }
  return isManager(message.guild, message.member, message.author.id, context);
}

async function execute(message, args = [], context = {}) {
  if (!message.guild) return message.reply('استخدم هذا الأمر داخل السيرفر.').catch(() => {});
  try {
    await ensureBonusDatabase();
    const allowed = await checkSetupInitPermissions(message, context);
    if (!allowed) return message.react('❌').catch(() => {});
    const payload = await buildHome(message.guild);
    await message.channel.send({ ...payload });
  } catch (error) {
    console.error('[bonus] setup error:', error);
    await message.reply('تعذر فتح إعدادات البونس. تأكد من جاهزية قاعدة البيانات وحاول مجددًا.').catch(() => {});
  }
}

function collectModalValue(interaction, id) {
  return interaction.fields.getTextInputValue(id).trim();
}

function modal(customId, title, fields) {
  const builder = new ModalBuilder().setCustomId(customId).setTitle(title);
  for (const item of fields) {
    const input = new TextInputBuilder().setCustomId(item.id).setLabel(item.label).setStyle(item.style || TextInputStyle.Short)
      .setRequired(item.required !== false).setMaxLength(item.maxLength || 100);
    if (item.placeholder) input.setPlaceholder(item.placeholder);
    if (item.value) input.setValue(item.value);
    if (item.minLength) input.setMinLength(item.minLength);
    builder.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return builder;
}

async function refreshEphemeralHome(interaction) {
  if (interaction.message?.attachments?.some(attachment => attachment.name === 'bonus-top.png')) {
    await showPrivatePanel(interaction, await buildBoardPayload(interaction.guild), true);
  } else {
    await showPrivatePanel(interaction, await buildHome(interaction.guild), true);
  }
}

async function confirmComponent(interaction, action, groupId, userId = null) {
  const message = action === 'group-reset'
    ? 'سيتم تصفير جميع نقاط وتقدم أعضاء هذا القروب فقط.'
    : action === 'user-reset'
      ? `سيتم تصفير نقاط العضو <@${userId}> وتقدمه داخل هذا القروب فقط.`
      : action === 'archive'
        ? 'سيتم أرشفة القروب وإخفاؤه من التوب. لا تُحذف سجلاته.'
        : 'تأكيد هذا الإجراء؟';
  const suffix = `${groupId}:${userId || '0'}`;
  return {
    content: `⚠️ ${message}\nهل تريد المتابعة؟`,
    components: [new ActionRowBuilder().addComponents(
      button(`bonus:confirm:${action}:${suffix}`, 'تأكيد', ButtonStyle.Danger),
      button('bonus:home', 'إلغاء')
    )]
  };
}

async function handleManagerMenu(interaction, action) {
  if (!await requireManager(interaction)) return true;
  const db = getManager();
  const config = await db.readConfig(interaction.guild.id);
  const managers = config.managers || { userIds: [], roleIds: [], responsibilities: [] };
  const [menuAction, actorId, rawPage] = action.split(':');
  const page = Number(rawPage) || 0;
  if (menuAction === 'manager-resp-page') {
    await showPrivatePanel(interaction, buildManagerPayload(interaction.guild, config, interaction.user.id, page), true);
    return true;
  }
  if (action.startsWith('manager-roles:')) {
    config.managers = { ...managers, roleIds: interaction.values.map(String) };
  } else if (action.startsWith('manager-users:')) {
    config.managers = { ...managers, userIds: interaction.values.map(String) };
  } else if (action.startsWith('manager-responsibilities:')) {
    const names = Object.keys(global.responsibilities || {});
    const pageNames = new Set(names.slice(page * 25, (page + 1) * 25));
    const retained = (managers.responsibilities || []).filter(name => !pageNames.has(name));
    config.managers = { ...managers, responsibilities: Array.from(new Set([...retained, ...interaction.values])) };
  } else {
    await showPrivatePanel(interaction, buildManagerPayload(interaction.guild, config, interaction.user.id), true);
    return true;
  }
  await db.saveConfig(interaction.guild.id, { managers: config.managers }, interaction.user.id);
  const updated = await db.readConfig(interaction.guild.id);
  await showPrivatePanel(interaction, buildManagerPayload(interaction.guild, updated, interaction.user.id, page), true);
  return true;
}

async function handleInteraction(interaction, context = {}) {
  if (!interaction.customId?.startsWith('bonus:')) return false;
  try {
    const { prefix, action, parts } = parseBonusCustomId(interaction.customId);
    if (prefix !== 'bonus') return false;
    if (!interaction.guild) {
      await deny(interaction, 'هذه التفاعلات تعمل داخل السيرفر فقط.');
      return true;
    }
    await ensureBonusDatabase();
    if (isBonusBoardMessage(interaction.message)) activeBoardPanels.set(String(interaction.guild.id), Date.now() + 10 * 60 * 1000);
    const manualPointsSelection = action === 'select' && ['add-points', 'remove-points'].includes(parts[0]);
    const fromBoard = isBonusBoardMessage(interaction.message);
    const opensModal = action === 'color-manual' || action === 'rule' || action === 'audit-filter'
      || action === 'owner-avatar' || (action === 'select' && parts[0] === 'owner-avatar')
      || (action === 'group-action' && parts[0] === 'avatar');
    if (interaction.isAnySelectMenu?.() && !manualPointsSelection && !opensModal && !fromBoard && !interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
    if (interaction.isButton?.() && !opensModal && !fromBoard && !interaction.deferred && !interaction.replied) await interaction.deferUpdate();
    if (interaction.isModalSubmit?.() && action === 'modal' && !interaction.deferred && !interaction.replied) await interaction.deferUpdate();

    if (action === 'private-top' || action === 'private-top-page') {
      const page = action === 'private-top-page' ? Number(parts[0]) || 0 : 0;
      await showPrivatePanel(interaction, await buildPrivateTopPayload(interaction.guild, page), action === 'private-top-page');
      return true;
    }
    if (action === 'my-group') {
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => interaction.member);
      await showPrivatePanel(interaction, await buildMyGroupPayload(interaction.guild, member), false);
      return true;
    }

    if (action === 'public-settings' || action === 'public-refresh' || action === 'open' || action === 'refresh-home' || action === 'home') {
      if (action === 'public-settings' || action === 'open') {
        if (!await requireManager(interaction, context)) return true;
        await showPrivatePanel(interaction, await buildHome(interaction.guild), true);
      } else if (action === 'public-refresh') {
        await showPrivatePanel(interaction, await buildBoardPayload(interaction.guild), true);
      } else {
        if (!await requireManager(interaction, context)) return true;
        await refreshEphemeralHome(interaction);
      }
      return true;
    }

    if (action === 'top-page') {
      const page = Math.max(0, Number(parts[0]) || 0);
      const payload = await buildBoardPayload(interaction.guild, '', page);
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
      else await interaction.update(payload);
      return true;
    }

    if (action === 'audit-filter') {
      await interaction.showModal(modal('bonus:modal:audit-filter', 'فلترة سجل التدقيق', [
        { id: 'action', label: 'نوع العملية (اختياري)', required: false, maxLength: 50, placeholder: 'member_transfer' },
        { id: 'user', label: 'معرف العضو (اختياري)', required: false, maxLength: 30 },
        { id: 'group', label: 'معرف القروب (اختياري)', required: false, maxLength: 20 }
      ]));
      return true;
    }

    if (action === 'audit' || action === 'audit-page') {
      if (!await requireManager(interaction, context)) return true;
      const page = action === 'audit-page' ? Number(parts[0]) || 0 : 0;
      await showPrivatePanel(interaction, await buildAuditPayload(interaction.guild, page), true);
      return true;
    }

    if (action.startsWith('manager-')) {
      const actorInId = parts[0];
      if (actorInId && actorInId !== interaction.user.id) {
        await deny(interaction, 'هذه القائمة ليست مخصصة لك. افتح لوحة إعداداتك من جديد.');
        return true;
      }
      return handleManagerMenu(interaction, `${action}:${parts.join(':')}`);
    }

    if (action === 'owner-avatar') {
      const ownGroups = await getGroupsForDisplay(interaction.guild);
      const ownedGroups = ownGroups.filter(group => String(group.owner_id) === String(interaction.user.id));
      if (!ownedGroups.length) {
        await showPrivatePanel(interaction, { content: 'لا يوجد قروب مملوك لك.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
      } else if (ownedGroups.length === 1) {
        await interaction.showModal(modal(`bonus:modal:owner-avatar:${ownedGroups[0].id}`, 'صورة القروب', [
          { id: 'url', label: 'رابط صورة من Discord CDN (اختياري)', required: false, maxLength: 300,
            placeholder: 'https://cdn.discordapp.com/attachments/…' }
        ]));
      } else {
        await showPrivatePanel(interaction, buildGroupSelect('owner-avatar', ownedGroups), true);
      }
      return true;
    }

    if (action === 'page' && parts[0] === 'owner-avatar') {
      const ownedGroups = (await getGroupsForDisplay(interaction.guild))
        .filter(group => String(group.owner_id) === String(interaction.user.id));
      await showPrivatePanel(interaction, buildGroupSelect('owner-avatar', ownedGroups, Number(parts[1])), true);
      return true;
    }

    if (action === 'select' && parts[0] === 'owner-avatar') {
      const groupId = Number(interaction.values[0]);
      const group = (await getManager().listGroups(interaction.guild.id)).find(item =>
        Number(item.id) === groupId && String(item.owner_id) === String(interaction.user.id));
      if (!group) {
        await deny(interaction, 'هذا القروب غير مملوك لك أو لم يعد نشطاً.');
        return true;
      }
      await interaction.showModal(modal(`bonus:modal:owner-avatar:${groupId}`, 'صورة القروب', [
        { id: 'url', label: 'رابط صورة من Discord CDN (اختياري)', required: false, maxLength: 300,
          placeholder: 'https://cdn.discordapp.com/attachments/…' }
      ]));
      return true;
    }

    if (action === 'group-search' && parts[0] === 'owner-avatar') {
      await interaction.showModal(modal('bonus:modal:group-search:owner-avatar', 'بحث في قروباتي', [
        { id: 'query', label: 'اسم الرول أو رقم القروب', placeholder: 'اكتب كلمة البحث', maxLength: 80 }
      ]));
      return true;
    }

    if (action === 'modal' && parts[0] === 'group-search' && parts[1] === 'owner-avatar') {
      const query = String(collectModalValue(interaction, 'query') || '').trim().toLowerCase();
      const ownedGroups = (await getGroupsForDisplay(interaction.guild))
        .filter(group => String(group.owner_id) === String(interaction.user.id));
      const filtered = query ? ownedGroups.filter(group => [group.role_name, group.role_id, group.id]
        .some(value => String(value || '').toLowerCase().includes(query))) : ownedGroups;
      groupSearchCache.set(`${interaction.guild.id}:${interaction.user.id}:owner-avatar`, { createdAt: Date.now(), groups: filtered });
      await showPrivatePanel(interaction, filtered.length ? buildGroupSelect('owner-avatar', filtered, 0)
        : { content: 'لا يوجد قروب مطابق تملكه.', components: [new ActionRowBuilder().addComponents(button('bonus:owner-avatar', 'بحث جديد'), button('bonus:home', 'رجوع'))] }, true);
      return true;
    }

    if (action === 'modal' && parts[0] === 'owner-avatar') {
      const groupId = Number(parts[1]);
      const group = (await getManager().listGroups(interaction.guild.id)).find(item =>
        Number(item.id) === groupId && String(item.owner_id) === String(interaction.user.id));
      if (!group) {
        await deny(interaction, 'لا تملك صلاحية تعديل هذا القروب.');
        return true;
      }
      const url = collectModalValue(interaction, 'url');
      const avatarKey = `${interaction.guild.id}:${groupId}`;
      const lastAvatarChange = ownerAvatarCooldowns.get(avatarKey) || 0;
      if (Date.now() - lastAvatarChange < OWNER_AVATAR_COOLDOWN_MS) {
        const remaining = Math.ceil((OWNER_AVATAR_COOLDOWN_MS - (Date.now() - lastAvatarChange)) / 60000);
        await showPrivatePanel(interaction, await buildReturnPayload(interaction, `يمكن تغيير أفتار القروب مرة أخرى بعد ${remaining} دقيقة.`), true);
        return true;
      }
      const avatarCheck = await verifyAvatarUrl(url);
      if (!avatarCheck.valid) {
        await showPrivatePanel(interaction, await buildReturnPayload(interaction, 'استخدم رابط صورة مباشر من Discord CDN بصيغة PNG/JPG/WEBP/GIF، أو اتركه فارغاً.'), true);
        return true;
      }
      await getManager().updateGroup(interaction.guild.id, groupId, { avatar_url: avatarCheck.url }, interaction.user.id);
      ownerAvatarCooldowns.set(avatarKey, Date.now());
      await showPrivatePanel(interaction, await buildReturnPayload(interaction, avatarCheck.url ? 'تم تحديث أفتار قروبك.' : 'عاد القروب لاستخدام أيقونة السيرفر.'), true);
      scheduleRefresh(interaction.guild, true);
      return true;
    }

    if (!await requireManager(interaction, context)) return true;
    const db = getManager();

    if (action === 'page' && parts[0] === 'double-user-member') {
      const groupId = Number(parts[1]);
      const page = Number(parts[2]) || 0;
      const group = (await db.listGroups(interaction.guild.id)).find(item => Number(item.id) === groupId);
      const role = group ? await interaction.guild.roles.fetch(String(group.role_id)).catch(() => null) : null;
      if (!group || !role) return true;
      await showPrivatePanel(interaction, buildMemberSelect('double-user-member', group, role.members.values(), page), true);
      return true;
    }
    if (action === 'page') {
      const selectAction = parts[0];
      const page = Number(parts[1]);
      const cacheKey = `${interaction.guild.id}:${interaction.user.id}:${selectAction}`;
      const cachedSearch = groupSearchCache.get(cacheKey);
      const groups = cachedSearch && Date.now() - cachedSearch.createdAt < 5 * 60 * 1000
        ? cachedSearch.groups : await getGroupsForDisplay(interaction.guild);
      await showPrivatePanel(interaction, buildGroupSelect(selectAction, groups, page), true);
      return true;
    }

    if (action === 'managers') {
      const config = await db.readConfig(interaction.guild.id);
      await showPrivatePanel(interaction, buildManagerPayload(interaction.guild, config, interaction.user.id), true);
      return true;
    }

    if (action === 'channel') {
      const menu = new ChannelSelectMenuBuilder().setCustomId('bonus:select-channel').setPlaceholder('اختر روم عرض التوب')
        .setMinValues(1).setMaxValues(1).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
      await showPrivatePanel(interaction, { content: 'حدد رومًا نصيًا لرسالة توب البونس:', components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
      return true;
    }

    if (action === 'audit-channel') {
      const menu = new ChannelSelectMenuBuilder().setCustomId('bonus:select-audit-channel').setPlaceholder('Select audit log channel')
        .setMinValues(1).setMaxValues(1).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
      await showPrivatePanel(interaction, {
        embeds: [colorManager.createEmbed().setTitle('Audit Channel').setDescription('اختر رومًا مستقلًا لاستقبال سجلات إعدادات وعمليات البونس.')],
        components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(button('bonus:home', 'Back'))]
      }, true);
      return true;
    }

    if (action === 'select-channel') {
      const channel = interaction.guild.channels.cache.get(interaction.values[0]);
      if (!isGuildText(channel)) {
        await showPrivatePanel(interaction, { content: 'الروم غير صالح. اختر رومًا نصيًا من السيرفر.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
        return true;
      }
      const currentConfig = await db.readConfig(interaction.guild.id);
      if (currentConfig.topMessageId && currentConfig.channelId && String(currentConfig.channelId) !== String(channel.id)) {
        const oldChannel = await interaction.guild.channels.fetch(String(currentConfig.channelId)).catch(() => null);
        const oldMessage = oldChannel ? await oldChannel.messages.fetch(String(currentConfig.topMessageId)).catch(() => null) : null;
        if (oldMessage) await oldMessage.edit({ components: [] }).catch(() => {});
        await db.saveConfig(interaction.guild.id, { channelId: channel.id, topMessageId: null }, interaction.user.id);
      } else {
        await db.saveConfig(interaction.guild.id, { channelId: channel.id }, interaction.user.id);
      }
      await showPrivatePanel(interaction, { content: `تم تحديد روم التوب: <#${channel.id}>`, components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع للإعدادات'))] }, true);
      return true;
    }

    if (action === 'select-audit-channel') {
      const channel = interaction.guild.channels.cache.get(interaction.values[0]);
      if (!isGuildText(channel)) {
        await showPrivatePanel(interaction, { content: 'The audit channel must be a text channel.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'Back'))] }, true);
        return true;
      }
      await db.saveConfig(interaction.guild.id, { auditChannelId: channel.id }, interaction.user.id);
      await showPrivatePanel(interaction, { embeds: [colorManager.createEmbed().setTitle('Audit Channel Updated').setDescription(`Logs will be organized in <#${channel.id}>.`)], components: [new ActionRowBuilder().addComponents(button('bonus:home', 'Back'))] }, true);
      return true;
    }

    if (action === 'color') {
      const row = new ActionRowBuilder().addComponents(
        button('bonus:color-auto', 'تلقائي من أيقونة السيرفر', ButtonStyle.Primary),
        button('bonus:color-manual', 'تحديد لون يدوي')
      );
      await showPrivatePanel(interaction, { content: 'اختر مصدر لون صورة التوب:', components: [row, new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
      return true;
    }

    if (action === 'color-auto') {
      await db.saveConfig(interaction.guild.id, { autoColor: true }, interaction.user.id);
      await showPrivatePanel(interaction, { content: 'سيُستخرج اللون تلقائيًا من أيقونة السيرفر، مع لون احتياطي عند تعذر ذلك.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع للإعدادات'))] }, true);
      return true;
    }

    if (action === 'color-manual') {
      await interaction.showModal(modal('bonus:modal:color', 'لون صورة التوب', [
        { id: 'hex', label: 'لون HEX مثل #D9A441', placeholder: '#D9A441', maxLength: 7 }
      ]));
      return true;
    }

    if (action === 'rules') {
      const currentRules = await db.getRules(interaction.guild.id);
      const row = new ActionRowBuilder().addComponents(
        button('bonus:rule:messages', currentRules.messages ? 'تعديل قاعدة الرسائل' : 'تفعيل قاعدة الرسائل', ButtonStyle.Primary),
        button('bonus:rule:voice', currentRules.voice_ms ? 'تعديل قاعدة الصوت' : 'تفعيل قاعدة الصوت', ButtonStyle.Primary)
      );
      const disableButtons = [];
      if (currentRules.messages) disableButtons.push(button('bonus:rule-off:messages', 'إيقاف الرسائل', ButtonStyle.Danger));
      if (currentRules.voice_ms) disableButtons.push(button('bonus:rule-off:voice', 'إيقاف الصوت', ButtonStyle.Danger));
      const rows = [row];
      if (disableButtons.length) rows.push(new ActionRowBuilder().addComponents(disableButtons));
      rows.push(new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع')));
      const status = [
        `الرسائل: ${currentRules.messages ? `مفعّلة (${Number(currentRules.messages.threshold).toLocaleString()} رسالة = ${currentRules.messages.points} نقطة)` : 'متوقفة'}`,
        `الصوت: ${currentRules.voice_ms ? `مفعّلة (${Number(currentRules.voice_ms.threshold) / 3600000} ساعة = ${currentRules.voice_ms.points} نقطة)` : 'متوقف'}`
      ];
      await showPrivatePanel(interaction, { content: `${status.join('\n')}\nيمكن تشغيل أي قاعدة وحدها. إيقاف قاعدة يمسح تقدمها الجزئي فقط ولا يمسح النقاط المكتسبة أو إحصاءات البوت.`, components: rows }, true);
      return true;
    }

    if (action === 'rule-off') {
      const metricName = parts[0];
      const metric = metricName === 'messages' ? BONUS_METRICS.messages : metricName === 'voice' ? BONUS_METRICS.voice : null;
      if (!metric) return true;
      if (metric === BONUS_METRICS.voice) {
        for (const session of voiceSessions.values()) {
          if (String(session.guildId) === String(interaction.guild.id)) await checkpointVoice(session, Date.now()).catch(() => {});
        }
      }
      const result = await db.disableRule(interaction.guild.id, metric, interaction.user.id);
      if (metric === BONUS_METRICS.voice) {
        const now = Date.now();
        for (const session of voiceSessions.values()) {
          if (String(session.guildId) !== String(interaction.guild.id)) continue;
          session.lastTrackedAt = now;
          await saveVoiceSession(session).catch(() => {});
        }
      }
      scheduleRefresh(interaction.guild, true);
      const label = metric === BONUS_METRICS.messages ? 'الرسائل' : 'الصوت';
      await showPrivatePanel(interaction, { content: result.disabled ? `تم إيقاف قاعدة ${label}. حُذف التقدم الجزئي (${Number(result.clearedProgress).toLocaleString()} من وحدتها)، وبقيت النقاط المكتسبة والإحصاءات الأصلية كما هي.` : `قاعدة ${label} متوقفة بالفعل.`, components: [new ActionRowBuilder().addComponents(button('bonus:rules', 'العودة لقواعد النقاط'))] }, true);
      return true;
    }

    if (action === 'rule') {
      const metricName = parts[0];
      const metric = metricName === 'messages' ? BONUS_METRICS.messages : metricName === 'voice' ? BONUS_METRICS.voice : null;
      if (!metric) return true;
      const currentRules = await db.getRules(interaction.guild.id);
      const existing = currentRules[metric];
      await interaction.showModal(modal(`bonus:modal:rule:${metricName}`, metricName === 'messages' ? 'قاعدة الرسائل' : 'قاعدة الصوت', [
        { id: 'threshold', label: metricName === 'messages' ? 'عدد الرسائل لكل خطوة' : 'عدد الساعات الصوتية لكل خطوة', placeholder: metricName === 'messages' ? '300' : '100', value: existing ? String(metricName === 'messages' ? existing.threshold : existing.threshold / 3600000) : undefined },
        { id: 'points', label: 'النقاط عند اكتمال الخطوة', placeholder: '1', value: existing ? String(existing.points) : undefined }
      ]));
      return true;
    }

    if (action === 'add-group') {
      const menu = new RoleSelectMenuBuilder().setCustomId('bonus:select:add-role').setPlaceholder('ابحث واختر رول القروب').setMinValues(1).setMaxValues(1);
      await showPrivatePanel(interaction, { content: 'اختر رول القروب. بعده اختر الـOwner من قائمة الأعضاء.', components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(button('bonus:home', 'إلغاء'))] }, true);
      return true;
    }

    if (action === 'remove-group') {
      await showPrivatePanel(interaction, buildGroupSelect('remove-group', await getGroupsForDisplay(interaction.guild)), true);
      return true;
    }

    if (action === 'add-points' || action === 'remove-points') {
      await showPrivatePanel(interaction, buildGroupSelect(action, await getGroupsForDisplay(interaction.guild)), true);
      return true;
    }

    if (action === 'select' && parts[0] === 'add-role') {
      const roleId = interaction.values[0];
      if (!interaction.guild.roles.cache.has(roleId)) {
        await showPrivatePanel(interaction, { content: 'الرول غير موجود في هذا السيرفر.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
        return true;
      }
      activeAddFlows.set(idKey(interaction.guild.id, interaction.user.id), {
        roleId, createdAt: Date.now(), fromBoard: interaction.message?.attachments?.some(attachment => attachment.name === 'bonus-top.png') || false
      });
      const menu = new UserSelectMenuBuilder().setCustomId('bonus:select:add-owner').setPlaceholder('ابحث واختر Owner القروب').setMinValues(1).setMaxValues(1);
      await showPrivatePanel(interaction, { content: `الرول: <@&${roleId}>\nاختر Owner القروب:`, components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(button('bonus:home', 'إلغاء'))] }, true);
      return true;
    }

    if (action === 'select' && parts[0] === 'add-owner') {
      const key = idKey(interaction.guild.id, interaction.user.id);
      const flow = activeAddFlows.get(key);
      activeAddFlows.delete(key);
      if (!flow || Date.now() - flow.createdAt > 5 * 60 * 1000) {
        await showPrivatePanel(interaction, { content: 'انتهت جلسة الإضافة. ابدأ من جديد.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
        return true;
      }
      const ownerId = interaction.values[0];
      const member = await interaction.guild.members.fetch(ownerId).catch(() => null);
      if (!member || member.user.bot) {
        await showPrivatePanel(interaction, { content: 'اختر عضوًا حقيقيًا من هذا السيرفر ليكون Owner للقروب.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
        return true;
      }
      try {
        await db.addGroup(interaction.guild.id, flow.roleId, ownerId, interaction.user.id);
        roleAuditCache.clear();
        guildRoleAuditCache.delete(String(interaction.guild.id));
        scheduleRefresh(interaction.guild, true);
        const confirmation = `تمت إضافة <@&${flow.roleId}> وربطه بالـOwner <@${ownerId}>.`;
        const payload = flow.fromBoard ? await buildBoardPayload(interaction.guild, confirmation) : { ...(await buildHome(interaction.guild)), content: confirmation };
        await showPrivatePanel(interaction, payload, true);
      } catch (error) {
        const text = error.message === 'ROLE_ALREADY_REGISTERED' ? 'هذا الرول مسجل كقروب بالفعل.'
          : error.message === 'OWNER_ALREADY_ASSIGNED' ? 'هذا العضو مرتبط بمالك قروب نشط آخر. يجب اختيار عضو مختلف.'
            : 'تعذرت إضافة القروب.';
        await showPrivatePanel(interaction, { content: text, components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
      }
      return true;
    }

    if (action === 'select' && parts[0] === 'remove-group') {
      await showPrivatePanel(interaction, await confirmComponent(interaction, 'archive', Number(interaction.values[0])), true);
      return true;
    }

    if (action === 'group-search') {
      const searchAction = parts[0];
      if (!['add-points', 'remove-points', 'double', 'reset-group', 'remove-group'].includes(searchAction)) return true;
      await interaction.showModal(modal(`bonus:modal:group-search:${searchAction}`, 'بحث في القروبات', [
        { id: 'query', label: 'اسم الرول أو رقم القروب أو المالك', placeholder: 'اكتب كلمة البحث', maxLength: 80 }
      ]));
      return true;
    }

    if (action === 'remove-mode') {
      const [mode, rawGroupId] = parts;
      const groupId = Number(rawGroupId);
      const group = (await db.listGroups(interaction.guild.id)).find(item => Number(item.id) === groupId);
      if (!group) {
        await deny(interaction, 'القروب غير موجود أو مؤرشف.');
        return true;
      }
      if (mode === 'group') {
        await interaction.showModal(modal(`bonus:modal:manual-points:remove-group:${groupId}`, 'إزالة نقاط من إجمالي القروب', [
          { id: 'amount', label: 'عدد النقاط المراد إزالتها', placeholder: '100', maxLength: 8 }
        ]));
      } else if (mode === 'member') {
        const menu = new UserSelectMenuBuilder().setCustomId(`bonus:select:remove-member:${groupId}`)
          .setPlaceholder('ابحث عن عضو يحمل رول القروب').setMinValues(1).setMaxValues(1);
        await showPrivatePanel(interaction, {
          content: `اختر عضواً من رول القروب <@&${group.role_id}>. البحث في Discord متاح، وسيُعاد التحقق من الرول والرصيد عند التأكيد.`,
          components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(button('bonus:home', 'إلغاء / رجوع'))]
        }, true);
      }
      return true;
    }

    if (action === 'select' && parts[0] === 'remove-member') {
      const groupId = Number(parts[1]);
      const userId = interaction.values[0];
      const group = (await db.listGroups(interaction.guild.id)).find(item => Number(item.id) === groupId);
      const member = await interaction.guild.members.fetch(userId).catch(() => null);
      const balance = await db.getBalance(interaction.guild.id, userId);
      if (!group || !member || !member.roles.cache.has(String(group.role_id)) || Number(balance?.group_id) !== groupId) {
        await deny(interaction, 'العضو لا يحمل رول القروب أو لا يملك رصيداً داخله.');
        return true;
      }
      await interaction.showModal(modal(`bonus:modal:manual-points:remove-member:${groupId}:${userId}`, 'إزالة نقاط من عضو', [
        { id: 'amount', label: `رصيد العضو الحالي: ${Number(balance.points || 0)}`, placeholder: '10', maxLength: 8 }
      ]));
      return true;
    }

    if (action === 'select' && ['add-points', 'remove-points'].includes(parts[0])) {
      const groupId = Number(interaction.values[0]);
      const group = (await db.listGroups(interaction.guild.id)).find(item => Number(item.id) === groupId);
      if (!group) return true;
      if (parts[0] === 'remove-points') {
        await showPrivatePanel(interaction, {
          content: `اختر نوع الإزالة للقروب <@&${group.role_id}>:`,
          components: [new ActionRowBuilder().addComponents(
            button(`bonus:remove-mode:group:${groupId}`, 'إزالة من إجمالي القروب', ButtonStyle.Danger),
            button(`bonus:remove-mode:member:${groupId}`, 'إزالة من عضو محدد', ButtonStyle.Secondary)
          ), new ActionRowBuilder().addComponents(button('bonus:home', 'إلغاء / رجوع'))]
        }, true);
        return true;
      }
      const verb = parts[0] === 'add-points' ? 'إعطاء' : 'إزالة';
      await interaction.showModal(modal(`bonus:modal:manual-points:${parts[0]}:${groupId}`, `${verb} نقاط للقروب`, [
        { id: 'amount', label: `عدد النقاط (${verb})`, placeholder: '100', maxLength: 8 }
      ]));
      return true;
    }

    if (action === 'manage-groups') {
      const groups = await getGroupsForDisplay(interaction.guild);
      if (!groups.length) {
        await showPrivatePanel(interaction, { content: 'لا توجد قروبات نشطة.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
        return true;
      }
      await showPrivatePanel(interaction, buildGroupSelect('manage-group', groups), true);
      return true;
    }

    if (action === 'select' && parts[0] === 'manage-group') {
      const groupId = Number(interaction.values[0]);
      const group = (await db.listGroups(interaction.guild.id)).find(item => Number(item.id) === groupId);
      if (!group) return true;
      const row1 = new ActionRowBuilder().addComponents(
        button(`bonus:group-action:owner:${groupId}`, 'تغيير Owner'),
        button(`bonus:group-action:avatar:${groupId}`, 'تغيير الصورة'),
        button(`bonus:group-action:archive:${groupId}`, 'إزالة القروب', ButtonStyle.Danger)
      );
      const role = interaction.guild.roles.cache.get(String(group.role_id));
      await showPrivatePanel(interaction, { content: `القروب: **${safeName(role?.name || 'رول محذوف')}**\nالـOwner الحالي: <@${group.owner_id}>`, components: [row1, new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
      return true;
    }

    if (action === 'group-action') {
      const [operation, rawGroupId] = parts;
      const groupId = Number(rawGroupId);
      const groups = await db.listGroups(interaction.guild.id);
      const group = groups.find(item => Number(item.id) === groupId);
      if (!group) {
        await showPrivatePanel(interaction, { content: 'القروب لم يعد موجودًا.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
        return true;
      }
      if (operation === 'owner') {
        const menu = new UserSelectMenuBuilder().setCustomId(`bonus:select-owner:${groupId}`).setPlaceholder('اختر الـOwner الجديد').setMinValues(1).setMaxValues(1);
        await showPrivatePanel(interaction, { content: 'اختر الـOwner الجديد للقروب:', components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(button('bonus:home', 'إلغاء'))] }, true);
        return true;
      }
      if (operation === 'avatar') {
        await interaction.showModal(modal(`bonus:modal:avatar:${groupId}`, 'صورة القروب', [
          { id: 'url', label: 'رابط صورة من Discord CDN (اتركه فارغًا لافتراضي السيرفر)', required: false, maxLength: 300,
            placeholder: 'https://cdn.discordapp.com/attachments/…' }
        ]));
        return true;
      }
      if (operation === 'archive') {
        await showPrivatePanel(interaction, await confirmComponent(interaction, 'archive', groupId), true);
        return true;
      }
    }

    if (action === 'select-owner') {
      const groupId = Number(parts[0]);
      const newOwnerId = interaction.values[0];
      const newOwner = await interaction.guild.members.fetch(newOwnerId).catch(() => null);
      if (!newOwner || newOwner.user.bot) {
        await showPrivatePanel(interaction, { content: 'اختر عضوًا حقيقيًا من هذا السيرفر.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
        return true;
      }
      try {
        await db.updateGroup(interaction.guild.id, groupId, { owner_id: newOwnerId }, interaction.user.id);
      } catch (error) {
        if (error.message === 'OWNER_ALREADY_ASSIGNED') {
          await showPrivatePanel(interaction, { content: 'هذا العضو مرتبط بمالك قروب نشط آخر. يجب اختيار عضو مختلف.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
          return true;
        }
        throw error;
      }
      scheduleRefresh(interaction.guild, true);
      await showPrivatePanel(interaction, { content: `تم تغيير Owner القروب إلى <@${newOwnerId}> دون تغيير نقاطه.`, components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع للإعدادات'))] }, true);
      return true;
    }

    if (action === 'reset') {
      const row = new ActionRowBuilder().addComponents(
        button('bonus:reset-group', 'تصفير قروب كامل', ButtonStyle.Danger),
        button('bonus:reset-user', 'تصفير شخص داخل قروب', ButtonStyle.Danger)
      );
      await showPrivatePanel(interaction, { content: 'اختر نوع التصفير:', components: [row, new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
      return true;
    }

    if (action === 'reset-group') {
      const groups = await getGroupsForDisplay(interaction.guild);
      await showPrivatePanel(interaction, buildGroupSelect('reset-group', groups), true);
      return true;
    }

    if (action === 'reset-user') {
      const groups = await getGroupsForDisplay(interaction.guild);
      await showPrivatePanel(interaction, buildGroupSelect('reset-user-group', groups), true);
      return true;
    }

    if (action === 'select' && parts[0] === 'reset-group') {
      await showPrivatePanel(interaction, await confirmComponent(interaction, 'group-reset', Number(interaction.values[0])), true);
      return true;
    }

    if (action === 'select' && parts[0] === 'reset-user-group') {
      const groupId = Number(interaction.values[0]);
      const group = (await db.listGroups(interaction.guild.id)).find(item => Number(item.id) === groupId);
      if (!group) return true;
      const role = interaction.guild.roles.cache.get(String(group.role_id));
      const menu = new UserSelectMenuBuilder().setCustomId(`bonus:select:reset-user:${groupId}`).setPlaceholder('اختر عضوًا لتصفير نقاطه').setMinValues(1).setMaxValues(1);
      await showPrivatePanel(interaction, { content: `اختر شخصًا من قروب <@&${group.role_id}>.`, components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
      return true;
    }

    if (action === 'select' && parts[0] === 'reset-user') {
      const groupId = Number(parts[1]);
      const userId = interaction.values[0];
      const group = (await db.listGroups(interaction.guild.id)).find(item => Number(item.id) === groupId);
      const member = await interaction.guild.members.fetch(userId).catch(() => null);
      const balance = await db.getBalance(interaction.guild.id, userId);
      if (!group || !member || !member.roles.cache.has(String(group.role_id)) || Number(balance?.group_id) !== groupId) {
        await showPrivatePanel(interaction, { content: 'هذا العضو ليس مسندًا حاليًا لهذا القروب.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
        return true;
      }
      await showPrivatePanel(interaction, await confirmComponent(interaction, 'user-reset', groupId, userId), true);
      return true;
    }

    if (action === 'double') {
      const groups = await getGroupsForDisplay(interaction.guild);
      await showPrivatePanel(interaction, buildGroupSelect('double', groups), true);
      return true;
    }

    if (action === 'select' && parts[0] === 'double') {
      const groupId = Number(interaction.values[0]);
      const group = (await db.listGroups(interaction.guild.id)).find(item => Number(item.id) === groupId);
      if (!group) return true;
      const [groupDouble, userDoubles] = await Promise.all([
        db.getActiveGroupMultiplier(interaction.guild.id, groupId),
        db.listActiveUserMultipliers(interaction.guild.id, groupId)
      ]);
      const buttons = [
        groupDouble
          ? button(`bonus:double-off:group:${groupId}`, 'إيقاف دبل الرول', ButtonStyle.Danger)
          : button(`bonus:double-scope:group:${groupId}`, 'دبل للرول كاملًا', ButtonStyle.Primary),
        button(`bonus:double-scope:user:${groupId}`, 'إضافة / إزالة دبل شخص')
      ];
      const activePeople = userDoubles.slice(0, 12).map(item => {
        const end = item.ends_at ? ` — ينتهي <t:${Math.floor(Number(item.ends_at) / 1000)}:R>` : ' — إيقاف يدوي';
        return `<@${item.user_id}>${end}`;
      });
      const status = [
        `دبل الرول: ${groupDouble ? (groupDouble.ends_at ? `مفعّل حتى <t:${Math.floor(Number(groupDouble.ends_at) / 1000)}:R>` : 'مفعّل حتى الإيقاف اليدوي') : 'متوقف'}`,
        `الدبل الفردي المحفوظ: ${userDoubles.length ? userDoubles.length.toLocaleString() : 'لا يوجد'}`,
        ...(activePeople.length ? activePeople : [])
      ];
      await showPrivatePanel(interaction, { content: `قروب <@&${group.role_id}>\n${status.join('\n')}\nالدبل ×2 فقط ولا يتراكم إلى ×4. اختيار عضو سبق تفعيل دبل له يوقف دبل ذلك العضو فورًا.`, components: [new ActionRowBuilder().addComponents(buttons), new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
      return true;
    }

    if (action === 'double-scope') {
      const [scope, rawGroupId] = parts;
      const groupId = Number(rawGroupId);
      if (scope === 'group') {
        const group = await getDatabase().get('SELECT role_id FROM bonus_groups WHERE guild_id = ? AND id = ?', [interaction.guild.id, groupId]);
        if (!group) return true;
        await showPrivatePanel(interaction, { content: `اختر مدة دبل ×2 للرول <@&${group.role_id}>:`, components: [durationButtons('group', groupId), new ActionRowBuilder().addComponents(button('bonus:home', 'إلغاء'))] }, true);
      } else {
        const group = (await db.listGroups(interaction.guild.id)).find(item => Number(item.id) === groupId);
        const role = group ? await interaction.guild.roles.fetch(String(group.role_id)).catch(() => null) : null;
        if (!group || !role) return true;
        await showPrivatePanel(interaction, buildMemberSelect('double-user-member', group, role.members.values()), true);
      }
      return true;
    }

    if (action === 'select' && parts[0] === 'double-user-member') {
      const groupId = Number(parts[1]);
      const userId = interaction.values[0];
      const group = (await db.listGroups(interaction.guild.id)).find(item => Number(item.id) === groupId);
      const member = await interaction.guild.members.fetch(userId).catch(() => null);
      const role = group ? await interaction.guild.roles.fetch(String(group.role_id)).catch(() => null) : null;
      if (!group || !role || !member || !member.roles.cache.has(String(group.role_id))) {
        await deny(interaction, 'العضو المختار لا يحمل رول القروب الحالي.');
        return true;
      }
      const existing = await getDatabase().get(`SELECT id FROM bonus_multipliers WHERE guild_id = ? AND scope = 'user' AND group_id = ? AND user_id = ? AND active = 1 AND (ends_at IS NULL OR ends_at > ?)`, [interaction.guild.id, groupId, userId, Date.now()]);
      if (existing) {
        await db.clearMultiplier(interaction.guild.id, { scope: 'user', groupId, userId }, interaction.user.id);
        await showPrivatePanel(interaction, await buildReturnPayload(interaction, `تم إيقاف الدبل عن <@${userId}>.`), true);
      } else {
        await showPrivatePanel(interaction, { content: `اختر مدة دبل ×2 للعضو <@${userId}> داخل <@&${group.role_id}>:`, components: [durationButtons('user', groupId, userId), new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
      }
      return true;
    }

    if (action === 'select' && parts[0] === 'double-user') {
      const groupId = Number(parts[1]);
      const userId = interaction.values[0];
      const group = (await db.listGroups(interaction.guild.id)).find(item => Number(item.id) === groupId);
      const member = await interaction.guild.members.fetch(userId).catch(() => null);
      if (!group || !member || !member.roles.cache.has(String(group.role_id))) {
        await showPrivatePanel(interaction, { content: 'اختر عضوًا يحمل رول القروب الحالي.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
        return true;
      }
      const existing = await getDatabase().get(`SELECT id FROM bonus_multipliers WHERE guild_id = ? AND scope = 'user' AND group_id = ? AND user_id = ? AND active = 1 AND (ends_at IS NULL OR ends_at > ?)`, [interaction.guild.id, groupId, userId, Date.now()]);
      if (existing) {
        await db.clearMultiplier(interaction.guild.id, { scope: 'user', groupId, userId }, interaction.user.id);
        scheduleRefresh(interaction.guild, true);
        await showPrivatePanel(interaction, { content: `تم إيقاف الدبل عن <@${userId}>.`, components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع للإعدادات'))] }, true);
      } else {
        await showPrivatePanel(interaction, { content: `اختر مدة دبل ×2 للعضو <@${userId}>:`, components: [durationButtons('user', groupId, userId), new ActionRowBuilder().addComponents(button('bonus:home', 'إلغاء'))] }, true);
      }
      return true;
    }

    if (action === 'double-on') {
      const [scope, rawGroupId, rawUserId, durationToken] = parts;
      const groupId = Number(rawGroupId);
      if (!['group', 'user'].includes(scope)) return true;
      const userId = scope === 'user' ? rawUserId : null;
      const durationMs = durationToken === 'forever' ? null : Number(durationToken);
      const group = (await db.listGroups(interaction.guild.id)).find(item => Number(item.id) === groupId);
      if (!group) {
        await deny(interaction, 'القروب غير موجود أو مؤرشف.');
        return true;
      }
      const role = await interaction.guild.roles.fetch(String(group.role_id)).catch(() => null);
      if (!role) {
        await deny(interaction, 'رول القروب غير موجود في السيرفر حالياً.');
        return true;
      }
      if (scope === 'user') {
        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (!group || !member || !member.roles.cache.has(String(group.role_id))) {
          await deny(interaction, 'العضو لم يعد يحمل رول هذا القروب.');
          return true;
        }
      }
      const result = await db.setMultiplier(interaction.guild.id, { scope, groupId, userId, durationMs }, interaction.user.id);
      scheduleRefresh(interaction.guild, true);
      const target = scope === 'group'
        ? `القروب المرتبط بالرول <@&${(await getDatabase().get('SELECT role_id FROM bonus_groups WHERE guild_id = ? AND id = ?', [interaction.guild.id, groupId]))?.role_id}>`
        : `<@${userId}>`;
      const expiry = result.endsAt ? ` حتى <t:${Math.floor(result.endsAt / 1000)}:R>` : ' حتى إيقافه يدويًا';
      await showPrivatePanel(interaction, { content: `تم تفعيل دبل ×2 على ${target}${expiry}.`, components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع للإعدادات'))] }, true);
      return true;
    }

    if (action === 'double-off') {
      const [scope, rawGroupId] = parts;
      const groupId = Number(rawGroupId);
      if (scope === 'group') await db.clearMultiplier(interaction.guild.id, { scope: 'group', groupId }, interaction.user.id);
      scheduleRefresh(interaction.guild, true);
      await showPrivatePanel(interaction, await buildReturnPayload(interaction, 'تم إيقاف دبل القروب. سجل الدبل الفردي محفوظ ويمكنك اختيار العضو نفسه لإيقافه يدويًا.'), true);
      return true;
    }

    if (action === 'restore-reset') {
      const [rawGroupId, rawSnapshotId] = parts;
      try {
        await db.restoreGroupReset(interaction.guild.id, Number(rawGroupId), Number(rawSnapshotId), interaction.user.id);
        await showPrivatePanel(interaction, await buildReturnPayload(interaction, 'تمت استعادة آخر لقطة محفوظة للتصفير.'), true);
        scheduleRefresh(interaction.guild, true);
      } catch (error) {
        await showPrivatePanel(interaction, await buildReturnPayload(interaction, error.message === 'RESET_SNAPSHOT_NOT_FOUND'
          ? 'لقطة التصفير غير موجودة.' : 'تعذرت استعادة اللقطة.'), true);
      }
      return true;
    }

    if (action === 'confirm') {
      const [confirmAction, rawGroupId, rawUserId, rawAmount] = parts;
      const groupId = Number(rawGroupId);
      if (confirmAction === 'group-reset') {
        await settleVoiceBeforeReset(interaction.guild, groupId);
        const totals = await db.resetGroup(interaction.guild.id, groupId, interaction.user.id);
        await showPrivatePanel(interaction, { content: `تم تصفير القروب وبدأ من 0. تم حفظ نسخة سابقة قابلة للاستعادة. كانت النقاط ${totals.points.toLocaleString()} لعدد ${totals.members} عضوًا.`, components: [new ActionRowBuilder().addComponents(
          button(`bonus:restore-reset:${groupId}:${totals.snapshotId}`, 'استعادة ما قبل التصفير', ButtonStyle.Secondary), button('bonus:home', 'رجوع للإعدادات')
        )] }, true);
      } else if (confirmAction === 'user-reset') {
        await settleVoiceBeforeReset(interaction.guild, groupId, rawUserId === '0' ? null : rawUserId);
        const result = await db.resetUser(interaction.guild.id, groupId, rawUserId === '0' ? '' : rawUserId, interaction.user.id);
        await showPrivatePanel(interaction, { content: result ? `تم تصفير نقاط <@${rawUserId}> داخل القروب فقط (${result.points.toLocaleString()} نقطة).` : 'لم يوجد رصيد لهذا العضو داخل القروب.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع للإعدادات'))] }, true);
      } else if (confirmAction === 'archive') {
        const archived = await db.archiveGroup(interaction.guild.id, groupId, interaction.user.id);
        await showPrivatePanel(interaction, await buildReturnPayload(interaction, archived
          ? 'أزيل القروب من التوب وأُرشف دون حذف الرصيد؛ إعادة إضافة الرول تعيد القروب وتاريخه.'
          : 'القروب غير موجود أو مؤرشف.'), true);
      } else if (confirmAction === 'remove-group' || confirmAction === 'remove-member') {
        const userId = confirmAction === 'remove-member' ? rawUserId : null;
        const amount = Number(confirmAction === 'remove-member' ? rawAmount : rawUserId);
        try {
          const result = confirmAction === 'remove-member'
            ? await db.adjustUserPoints(interaction.guild.id, groupId, userId, amount, interaction.user.id)
            : await db.adjustGroupPoints(interaction.guild.id, groupId, -amount, interaction.user.id);
          const prompt = confirmAction === 'remove-member'
            ? `تمت إزالة ${Math.abs(result.delta).toLocaleString()} نقطة من <@${userId}> فقط.`
            : `تمت إزالة ${Math.abs(result.delta).toLocaleString()} نقطة من إجمالي القروب وحفظ الخصم؛ لم تتغير نقاط الأعضاء.`;
          await showPrivatePanel(interaction, await buildReturnPayload(interaction, prompt), true);
        } catch (error) {
          const prompt = error.message === 'NO_POINTS_TO_REMOVE' ? 'لا توجد نقاط متاحة للخصم.'
            : error.message === 'INSUFFICIENT_MEMBER_POINTS' ? 'رصيد العضو أقل من المبلغ المطلوب.'
              : error.message === 'MEMBER_NOT_IN_GROUP' ? 'العضو لم يعد تابعاً لهذا القروب.' : 'تعذر تنفيذ الإزالة.';
          await showPrivatePanel(interaction, await buildReturnPayload(interaction, prompt), true);
        }
      }
      scheduleRefresh(interaction.guild, true);
      return true;
    }

    if (action === 'confirm-rule') {
      const [metricName, rawThreshold, rawPoints] = parts;
      const key = idKey(interaction.guild.id, interaction.user.id);
      const pending = pendingRuleChanges.get(key);
      pendingRuleChanges.delete(key);
      if (!pending || Date.now() - pending.createdAt > 5 * 60 * 1000 ||
          pending.metricName !== metricName || pending.threshold !== Number(rawThreshold) || pending.points !== Number(rawPoints)) {
        await deny(interaction, 'انتهت معاينة القاعدة؛ افتح تعديل القاعدة من جديد.');
        return true;
      }
      const result = await db.setRule(interaction.guild.id, pending.metric, pending.threshold, pending.points, interaction.user.id);
      if (result.newlyActivated && pending.metric === BONUS_METRICS.voice) {
        const now = Date.now();
        for (const session of voiceSessions.values()) {
          if (String(session.guildId) !== String(interaction.guild.id)) continue;
          session.lastTrackedAt = now;
          await saveVoiceSession(session).catch(() => {});
        }
      }
      await showPrivatePanel(interaction, await buildReturnPayload(interaction, 'تم اعتماد القاعدة. يبدأ هذا المقياس من الآن فقط، ولا يُعاد احتساب النشاط السابق.'), true);
      scheduleRefresh(interaction.guild, true);
      return true;
    }

    if (action === 'publish') {
      try {
        const published = await publishBoard(interaction.guild, interaction.user.id);
        await showPrivatePanel(interaction, { content: `تم نشر/تحديث لوحة التوب في <#${published.channelId}>.`, components: buildHomeRows() }, true);
      } catch (error) {
        const messages = {
          CHANNEL_REQUIRED: 'حدد روم التوب أولًا.',
          GROUP_REQUIRED: 'أضف قروبًا واحدًا على الأقل قبل نشر التوب.',
          RULE_REQUIRED: 'فعّل قاعدة رسائل أو قاعدة ساعات صوتية واحدة على الأقل قبل نشر التوب.',
          CHANNEL_NOT_FOUND: 'روم العرض لم يعد موجودًا أو البوت لا يستطيع الوصول إليه.',
          MISSING_CHANNEL_PERMISSIONS: 'البوت يحتاج صلاحيات عرض الروم وإرسال الرسائل ورفع الملفات وقراءة سجل الرسائل.'
        };
        await showPrivatePanel(interaction, { content: `لم يُنشر التوب: ${messages[error.message] || 'حدث خطأ أثناء الإنشاء.'}`, components: buildHomeRows() }, true);
      }
      return true;
    }

    if (action === 'modal') {
      const modalAction = parts[0];
      if (modalAction === 'color') {
        const color = collectModalValue(interaction, 'hex');
        if (!/^#?[0-9a-f]{6}$/i.test(color)) {
          await showPrivatePanel(interaction, await buildReturnPayload(interaction, 'صيغة اللون غير صحيحة. اكتب مثل #D9A441.'), true);
          return true;
        }
        await db.saveConfig(interaction.guild.id, { autoColor: false, color: normalizeHex(color) }, interaction.user.id);
        await showPrivatePanel(interaction, await buildReturnPayload(interaction, `تم اعتماد اللون ${normalizeHex(color)}.`), true);
        scheduleRefresh(interaction.guild, true);
        return true;
      }
      if (modalAction === 'audit-filter') {
        if (!await requireManager(interaction, context)) return true;
        const actionFilter = collectModalValue(interaction, 'action');
        const userFilter = collectModalValue(interaction, 'user');
        const groupValue = collectModalValue(interaction, 'group');
        if (groupValue && !/^\d+$/.test(groupValue)) {
          await showPrivatePanel(interaction, await buildReturnPayload(interaction, 'معرف القروب يجب أن يكون رقماً.'), true);
          return true;
        }
        auditFilterState.set(String(interaction.guild.id), {
          ...(actionFilter ? { action: actionFilter } : {}),
          ...(userFilter ? { userId: userFilter } : {}),
          ...(groupValue ? { groupId: Number(groupValue) } : {})
        });
        await showPrivatePanel(interaction, await buildAuditPayload(interaction.guild, 0), true);
        return true;
      }
      if (modalAction === 'group-search') {
        const searchAction = parts[1];
        const query = collectModalValue(interaction, 'query').trim().toLowerCase();
        const groups = await getGroupsForDisplay(interaction.guild);
        const filtered = query ? groups.filter(group => [group.role_name, group.role_id, group.owner_name, group.owner_id, group.id]
          .some(value => String(value || '').toLowerCase().includes(query))) : groups;
        groupSearchCache.set(`${interaction.guild.id}:${interaction.user.id}:${searchAction}`, { createdAt: Date.now(), groups: filtered });
        await showPrivatePanel(interaction, filtered.length
          ? buildGroupSelect(searchAction, filtered, 0)
          : { content: 'لم توجد قروبات مطابقة للبحث.', components: [new ActionRowBuilder().addComponents(button(`bonus:group-search:${searchAction}`, 'بحث جديد'), button('bonus:home', 'رجوع'))] }, true);
        return true;
      }
      if (modalAction === 'rule') {
        const metricName = parts[1];
        const metric = metricName === 'messages' ? BONUS_METRICS.messages : metricName === 'voice' ? BONUS_METRICS.voice : null;
        const thresholdRaw = Number(collectModalValue(interaction, 'threshold').replace(/[,،]/g, '').replace(/\s/g, ''));
        const points = Number(collectModalValue(interaction, 'points').replace(/[,،]/g, '').replace(/\s/g, ''));
        const threshold = metricName === 'voice' ? Math.round(thresholdRaw * 3600000) : thresholdRaw;
        if (!metric || !Number.isSafeInteger(threshold) || threshold <= 0 || !Number.isSafeInteger(points) || points <= 0) {
          await showPrivatePanel(interaction, await buildReturnPayload(interaction, 'القيم غير صحيحة. استخدم أرقامًا صحيحة أكبر من صفر.'), true);
          return true;
        }
        const progressColumn = metric === BONUS_METRICS.messages ? 'message_progress' : 'voice_progress_ms';
        const [activeRules, currentProgress] = await Promise.all([
          db.getRules(interaction.guild.id),
          getDatabase().get(`SELECT MAX(${progressColumn}) AS maximum FROM bonus_balances WHERE guild_id = ?`, [interaction.guild.id])
        ]);
        if (activeRules[metric] && Number(currentProgress?.maximum || 0) >= threshold) {
          pendingRuleChanges.set(idKey(interaction.guild.id, interaction.user.id), {
            metric, threshold, points, metricName, thresholdRaw, createdAt: Date.now()
          });
          await showPrivatePanel(interaction, {
            content: '⚠️ يوجد تقدم جزئي أعلى من الحد الجديد. عند أول نشاط لاحق قد تُمنح نقاط فورًا وفق القاعدة الجديدة. هل تريد اعتماد هذا التغيير؟',
            components: [new ActionRowBuilder().addComponents(
              button(`bonus:confirm-rule:${metricName}:${threshold}:${points}`, 'اعتماد القاعدة', ButtonStyle.Danger),
              button('bonus:home', 'إلغاء')
            )]
          }, true);
        } else {
          const result = await db.setRule(interaction.guild.id, metric, threshold, points, interaction.user.id);
          if (result.newlyActivated && metric === BONUS_METRICS.voice) {
            const now = Date.now();
            for (const session of voiceSessions.values()) {
              if (String(session.guildId) !== String(interaction.guild.id)) continue;
              session.lastTrackedAt = now;
              await saveVoiceSession(session).catch(() => {});
            }
          }
          await showPrivatePanel(interaction, await buildReturnPayload(interaction,
            `تم حفظ قاعدة ${metricName === 'voice' ? 'الصوت' : 'الرسائل'}: كل ${metricName === 'voice' ? thresholdRaw + ' ساعة صوتية' : thresholdRaw + ' رسالة'} = ${points} نقطة. يبدأ التفعيل الجديد الآن؛ وتعديل قاعدة مفعّلة لا يعيد احتساب التاريخ.`), true);
          scheduleRefresh(interaction.guild, true);
        }
        return true;
      }
      if (modalAction === 'avatar') {
        const groupId = Number(parts[1]);
        const url = collectModalValue(interaction, 'url');
        if (url && (!/^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//i.test(url) || !/\.(png|jpe?g|webp|gif)(\?|$)/i.test(url))) {
          await showPrivatePanel(interaction, await buildReturnPayload(interaction, 'استخدم رابط صورة مباشرًا من Discord CDN بصيغة PNG/JPG/WEBP/GIF، أو اتركه فارغًا للصورة الافتراضية.'), true);
          return true;
        }
        await db.updateGroup(interaction.guild.id, groupId, { avatar_url: url || null }, interaction.user.id);
        await showPrivatePanel(interaction, await buildReturnPayload(interaction, url ? 'تم تحديث صورة القروب.' : 'عاد القروب لاستخدام أيقونة السيرفر.'), true);
        scheduleRefresh(interaction.guild, true);
        return true;
      }
      if (modalAction === 'manual-points') {
        const [, operation, rawGroupId, rawUserId] = parts;
        const groupId = Number(rawGroupId);
        const amount = Number(collectModalValue(interaction, 'amount').replace(/[,،\s]/g, ''));
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000) {
          await showPrivatePanel(interaction, await buildReturnPayload(interaction, 'اكتب عددًا صحيحًا بين 1 و1,000,000.'), true);
          return true;
        }
        try {
          if (operation === 'remove-group') {
            const group = (await db.listGroups(interaction.guild.id)).find(item => Number(item.id) === groupId);
            const current = await db.getGroupPoints(interaction.guild.id, groupId);
            if (!group || current == null) throw new Error('GROUP_NOT_FOUND');
            if (amount > Math.max(0, current)) throw new Error('INSUFFICIENT_GROUP_POINTS');
            await showPrivatePanel(interaction, {
              content: `تأكيد إزالة ${amount.toLocaleString()} نقطة من إجمالي القروب؟\nالإجمالي الحالي: ${current.toLocaleString()}\nالإجمالي بعد الإزالة: ${(current - amount).toLocaleString()}\nلن تتغير نقاط أي عضو، وسيبقى الخصم محفوظاً.`,
              components: [new ActionRowBuilder().addComponents(
                button(`bonus:confirm:remove-group:${groupId}:${amount}`, 'تأكيد الإزالة', ButtonStyle.Danger),
                button('bonus:home', 'إلغاء')
              )]
            }, true);
          } else if (operation === 'remove-member') {
            const group = (await db.listGroups(interaction.guild.id)).find(item => Number(item.id) === groupId);
            const member = await interaction.guild.members.fetch(String(rawUserId)).catch(() => null);
            const balance = await db.getBalance(interaction.guild.id, String(rawUserId));
            if (!group || !member || !member.roles.cache.has(String(group.role_id)) || Number(balance?.group_id) !== groupId) {
              throw new Error('MEMBER_NOT_IN_GROUP');
            }
            const current = Number(balance.points) || 0;
            if (amount > current) throw new Error('INSUFFICIENT_MEMBER_POINTS');
            await showPrivatePanel(interaction, {
              content: `تأكيد إزالة ${amount.toLocaleString()} نقطة من <@${rawUserId}>؟\nرصيده الحالي: ${current.toLocaleString()}\nرصيده بعد الإزالة: ${(current - amount).toLocaleString()}`,
              components: [new ActionRowBuilder().addComponents(
                button(`bonus:confirm:remove-member:${groupId}:${rawUserId}:${amount}`, 'تأكيد الإزالة', ButtonStyle.Danger),
                button('bonus:home', 'إلغاء')
              )]
            }, true);
          } else {
            const result = await db.adjustGroupPoints(interaction.guild.id, groupId, amount, interaction.user.id);
            const changed = Math.abs(result.delta).toLocaleString();
            await showPrivatePanel(interaction, await buildReturnPayload(interaction,
              `تمت إضافة ${changed} نقطة إلى إجمالي القروب؛ لم تتغير أرصدة الأعضاء الفردية.`), true);
            scheduleRefresh(interaction.guild, true);
          }
        } catch (error) {
          const note = error.message === 'INSUFFICIENT_GROUP_POINTS' ? 'عدد النقاط أكبر من إجمالي القروب.'
            : error.message === 'INSUFFICIENT_MEMBER_POINTS' ? 'عدد النقاط أكبر من رصيد العضو.'
              : error.message === 'MEMBER_NOT_IN_GROUP' ? 'العضو لم يعد تابعاً لهذا القروب.' : 'تعذر تعديل النقاط.';
          await showPrivatePanel(interaction, await buildReturnPayload(interaction, note), true);
        }
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error('[bonus] interaction failed:', error);
    if (interaction.message) {
      await showPrivatePanel(interaction, {
        content: 'حدث خطأ أثناء تنفيذ الإجراء. لم يُحذف أي رصيد؛ استخدم زر الرجوع ثم أعد المحاولة.',
        components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))]
      }, true).catch(() => {});
    } else if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ embeds: [colorManager.createEmbed().setTitle('Bonus Settings Error').setDescription('تعذر تنفيذ إعداد البونس. لم يتم حفظ تغيير غير مكتمل.')], ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ embeds: [colorManager.createEmbed().setTitle('Bonus Settings Error').setDescription('تعذر تنفيذ إعداد البونس. لم يتم حفظ تغيير غير مكتمل.')], ephemeral: true }).catch(() => {});
    }
    return true;
  }
}

function scheduleRefresh(guild, force = false) {
  if (!guild || !boundClient) return;
  if (force) {
    if (renderTimers.has(guild.id)) clearTimeout(renderTimers.get(guild.id));
    renderTimers.delete(guild.id);
    maybeRefreshBoard(guild, true).catch(error => console.error('[bonus] board refresh failed:', error));
  } else {
    maybeRefreshBoard(guild, false).catch(error => console.error('[bonus] board refresh failed:', error));
  }
}

async function recordActivity(guild, member, metric, amount, eventId, voiceSession = null, roleIdsOverride = null) {
  if (!guild || !member || member.user?.bot) return { ignored: true };
  let db;
  try { db = getDatabase(); } catch { return { ignored: true }; }
  if (!db?.isInitialized || db.isDegraded) return { ignored: true, degraded: true };
  try {
    return await withMemberLock(guild.id, member.id, async () => {
      const roleGrantHistory = await readRoleHistoryForMember(guild, member);
      const result = await getManager().addActivity({
        guildId: guild.id,
        userId: member.id,
        metric,
        amount,
        eventId,
        roleIds: roleIdsOverride || getRoleIds(member),
        roleGrantHistory,
        voiceSession
      });
      if (result.awardedPoints > 0) scheduleRefresh(guild, false);
      return result;
    });
  } catch (error) {
    console.error('[bonus] activity recording failed:', error);
    return { error: true };
  }
}

async function recordMessage(message, prefix = null) {
  if (!message?.guild || message.author?.bot || message.system || (!String(message.content || '').trim() && !message.attachments?.size)) return;
  if (prefix && message.content?.startsWith(prefix)) return;
  await recordActivity(message.guild, message.member, BONUS_METRICS.messages, 1, `message:${message.guild.id}:${message.id}`);
}
function voiceKey(guildId, userId) { return `${guildId}:${userId}`; }
async function saveVoiceSession(session) {
  if (!session) return;
  await getDatabase().run(`
    INSERT INTO bonus_voice_sessions (guild_id, user_id, channel_id, last_checkpoint_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET channel_id = excluded.channel_id,
      last_checkpoint_at = excluded.last_checkpoint_at, updated_at = excluded.updated_at
  `, [String(session.guildId), String(session.userId), String(session.channelId), Number(session.lastTrackedAt), Date.now()]);
}
async function removeSavedVoiceSession(guildId, userId) {
  await getDatabase().run('DELETE FROM bonus_voice_sessions WHERE guild_id = ? AND user_id = ?', [String(guildId), String(userId)]);
}

async function cleanupStaleVoiceSessions(client, now = Date.now()) {
  for (const session of Array.from(voiceSessions.values())) {
    const guild = client?.guilds?.cache?.get(String(session.guildId));
    const member = guild?.members?.cache?.get(String(session.userId));
    if (member && isEligibleVoiceState(member.voice)) continue;
    if (now - Number(session.lastTrackedAt || 0) <= VOICE_SESSION_MAX_STALE_MS && !member) continue;
    voiceSessions.delete(voiceKey(session.guildId, session.userId));
    await removeSavedVoiceSession(session.guildId, session.userId).catch(() => {});
  }
  const cutoff = now - VOICE_SESSION_MAX_STALE_MS;
  const rows = await getDatabase().all('SELECT guild_id, user_id FROM bonus_voice_sessions WHERE last_checkpoint_at < ?', [cutoff]).catch(() => []);
  for (const row of rows) {
    if (voiceSessions.has(voiceKey(row.guild_id, row.user_id))) continue;
    await removeSavedVoiceSession(row.guild_id, row.user_id).catch(() => {});
  }
}
function isEligibleVoiceState(state) {
  if (!state?.guild || !state.member || state.member.user?.bot || !state.channelId) return false;
  if (state.channel?.type === ChannelType.GuildStageVoice) return false;
  if (state.guild.afkChannelId && state.channelId === state.guild.afkChannelId) return false;
  // سياسة البونس: المشاركة الفعلية، وليس مجرد الوجود في القناة.
  if (state.serverMute || state.selfMute || state.serverDeaf || state.selfDeaf) return false;
  return true;
}

async function isBonusVoiceTrackingEnabled(guildId) {
  const key = String(guildId);
  const cached = voiceTrackingCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.enabled;
  let enabled = false;
  try {
    const database = getDatabase();
    if (!database?.isInitialized || database.isDegraded) return false;
    const [rules, groups] = await Promise.all([getManager().getRules(key), getManager().listGroups(key)]);
    enabled = Boolean(rules?.[BONUS_METRICS.voice] && groups.length > 0);
  } catch (error) {
    console.error('[bonus] voice readiness check failed:', error);
  }
  voiceTrackingCache.set(key, { enabled, expiresAt: Date.now() + 2000 });
  return enabled;
}

async function checkpointVoice(session, toTime = Date.now(), member = null, roleIdsOverride = null) {
  if (!session) return;
  if (session.pendingCheckpoint) {
    await session.pendingCheckpoint;
    if (Number(toTime) > Number(session.lastTrackedAt || 0) + 1000) return checkpointVoice(session, toTime, member);
    return;
  }
  const pending = (async () => {
    const end = Math.max(Number(session.lastTrackedAt) || 0, Number(toTime) || Date.now());
    const start = Number(session.lastTrackedAt) || end;
    const duration = end - start;
    if (duration < 1000) return;
    if (!await isBonusVoiceTrackingEnabled(session.guildId)) {
      session.lastTrackedAt = end;
      voiceSessions.delete(voiceKey(session.guildId, session.userId));
      await removeSavedVoiceSession(session.guildId, session.userId).catch(() => {});
      return;
    }
    const sessionGuild = boundClient?.guilds?.cache?.get(String(session.guildId));
    const liveMember = member || sessionGuild?.members?.cache?.get(String(session.userId)) ||
      (sessionGuild ? await sessionGuild.members.fetch(String(session.userId)).catch(() => null) : null);
    if (!liveMember || liveMember.user?.bot) {
      session.lastTrackedAt = end;
      return;
    }
    const eventId = `voice:${session.guildId}:${session.userId}:${start}:${end}`;
    const result = await recordActivity(liveMember.guild, liveMember, BONUS_METRICS.voice, duration, eventId, {
      channelId: session.channelId,
      lastCheckpointAt: end
    }, roleIdsOverride);
    if (result.error || result.degraded) return;
    session.lastTrackedAt = end;
  })();
  session.pendingCheckpoint = pending;
  try { await pending; }
  finally { if (session.pendingCheckpoint === pending) session.pendingCheckpoint = null; }
}

async function handleVoiceState(oldState, newState) {
  const guild = newState?.guild || oldState?.guild;
  const member = newState?.member || oldState?.member;
  if (!guild || !member || member.user?.bot) return;
  const key = voiceKey(guild.id, member.id);
  const session = voiceSessions.get(key);
  if (!await isBonusVoiceTrackingEnabled(guild.id)) {
    if (session) {
      voiceSessions.delete(key);
      await removeSavedVoiceSession(guild.id, member.id).catch(() => {});
    }
    return;
  }
  const oldEligible = isEligibleVoiceState(oldState);
  const newEligible = isEligibleVoiceState(newState);
  const sameEligibleChannel = oldEligible && newEligible && oldState.channelId === newState.channelId;
  if (sameEligibleChannel) return;

  if (session) {
    await checkpointVoice(session, Date.now(), oldState.member || newState.member).catch(() => {});
    voiceSessions.delete(key);
    await removeSavedVoiceSession(guild.id, member.id).catch(() => {});
  }
  if (newEligible) {
    const nextSession = {
      guildId: String(guild.id),
      userId: String(member.id),
      channelId: String(newState.channelId),
      lastTrackedAt: Date.now()
    };
    voiceSessions.set(key, nextSession);
    await saveVoiceSession(nextSession).catch(error => console.error('[bonus] voice session save failed:', error));
  }
}
async function restoreVoiceSessions(client) {
  const database = getDatabase();
  const savedRows = await database.all('SELECT guild_id, user_id, channel_id, last_checkpoint_at FROM bonus_voice_sessions');
  const saved = new Map(savedRows.map(row => [voiceKey(row.guild_id, row.user_id), row]));
  const activeKeys = new Set();
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    if (!await isBonusVoiceTrackingEnabled(guild.id)) continue;
    for (const state of guild.voiceStates.cache.values()) {
      if (!isEligibleVoiceState(state)) continue;
      const roleHistory = await readRoleHistoryForMember(guild, state.member);
      const targetGroup = await getManager().resolveTargetGroup(guild.id, state.member.id, getRoleIds(state.member), roleHistory);
      if (targetGroup == null) continue;
      const key = voiceKey(guild.id, state.member.id);
      activeKeys.add(key);
      if (!voiceSessions.has(key)) {
        const prior = saved.get(key);
        const earliestRecovery = now - 5 * 60 * 1000;
        const lastTrackedAt = prior
          ? Math.max(earliestRecovery, Math.min(now, Number(prior.last_checkpoint_at) || now))
          : now;
        const session = { guildId: String(guild.id), userId: String(state.member.id), channelId: String(state.channelId), lastTrackedAt };
        voiceSessions.set(key, session);
        await saveVoiceSession(session).catch(error => console.error('[bonus] restored voice session save failed:', error));
      }
    }
  }
  for (const row of savedRows) {
    const key = voiceKey(row.guild_id, row.user_id);
    if (!activeKeys.has(key)) await removeSavedVoiceSession(row.guild_id, row.user_id).catch(() => {});
  }
}

async function handleMemberRoleUpdateUnsafe(oldMember, newMember) {
  if (!newMember?.guild || newMember.user?.bot) return;
  const key = voiceKey(newMember.guild.id, newMember.id);
  roleAuditCache.delete(idKey(newMember.guild.id, newMember.id));
  guildRoleAuditCache.delete(String(newMember.guild.id));
  const activeVoiceSession = voiceSessions.get(key);
  if (activeVoiceSession) {
    // اقفل مدة القروب القديم قبل تغيير الإسناد، حتى لا تنتقل الجلسة كاملة للقروب الجديد.
    await checkpointVoice(activeVoiceSession, Date.now(), oldMember || newMember).catch(error => {
      console.error('[bonus] role-change voice settlement failed:', error);
    });
    voiceSessions.delete(key);
    await removeSavedVoiceSession(newMember.guild.id, newMember.id).catch(() => {});
  }
  try {
    const manager = getManager();
    const groups = await manager.listGroups(newMember.guild.id, true);
    const groupRoleIds = new Set(groups.map(group => String(group.role_id)));
    const oldRoleIds = new Set(getRoleIds(oldMember));
    const newRoleIds = new Set(getRoleIds(newMember));
    const addedRoleIds = Array.from(newRoleIds).filter(roleId => groupRoleIds.has(roleId) && !oldRoleIds.has(roleId));
    const removedRoleIds = Array.from(oldRoleIds).filter(roleId => groupRoleIds.has(roleId) && !newRoleIds.has(roleId));
    await manager.recordRoleChanges(newMember.guild.id, newMember.id, { addedRoleIds, removedRoleIds });
    const history = await readRoleHistoryForMember(newMember.guild, newMember);
    const targetGroupId = await manager.resolveTargetGroup(newMember.guild.id, newMember.id, getRoleIds(newMember), history);
    await manager.syncAssignment(newMember.guild.id, newMember.id, targetGroupId, null, 'guild_member_update');

    // إذا بقي العضو مشاركاً في الصوت، تبدأ جلسة جديدة من لحظة تغيير الرول.
    const voiceState = newMember.voice;
    if (voiceState && isEligibleVoiceState(voiceState) && await isBonusVoiceTrackingEnabled(newMember.guild.id)) {
      const nextSession = {
        guildId: String(newMember.guild.id),
        userId: String(newMember.id),
        channelId: String(voiceState.channelId),
        lastTrackedAt: Date.now()
      };
      voiceSessions.set(key, nextSession);
      await saveVoiceSession(nextSession).catch(error => console.error('[bonus] role-change voice session save failed:', error));
    }
  } catch (error) {
    console.error('[bonus] role assignment sync failed:', error);
  }
  scheduleRefresh(newMember.guild, false);
}

async function handleMemberRoleUpdate(oldMember, newMember) {
  if (!newMember?.guild || !newMember.id) return;
  return withMemberLock(newMember.guild.id, newMember.id, () => handleMemberRoleUpdateUnsafe(oldMember, newMember));
}

async function handleMemberLeaveUnsafe(member) {
  if (!member?.guild || member.user?.bot) return;
  const key = voiceKey(member.guild.id, member.id);
  const session = voiceSessions.get(key);
  try {
    // مثل نظام الصوت العادي: تسوية المدة المتبقية مرة واحدة قبل إنهاء الجلسة.
    if (session) await checkpointVoice(session, Date.now(), member).catch(() => {});
    voiceSessions.delete(key);
    await removeSavedVoiceSession(member.guild.id, member.id).catch(() => {});
    await getManager().syncAssignment(member.guild.id, member.id, null, null, 'guild_member_leave');
    scheduleRefresh(member.guild, false);
  } catch (error) {
    console.error('[bonus] member leave assignment sync failed:', error);
    // لا نترك جلسة يتيمة حتى لو فشل حفظ الإسناد أو سجل التدقيق.
    voiceSessions.delete(key);
    await removeSavedVoiceSession(member.guild.id, member.id).catch(() => {});
  }
}

async function handleMemberLeave(member) {
  if (!member?.guild || !member.id) return;
  return withMemberLock(member.guild.id, member.id, () => handleMemberLeaveUnsafe(member));
}

async function handleRoleDelete(role) {
  if (!role?.guild) return;
  try {
    const group = (await getManager().listGroups(role.guild.id)).find(item => String(item.role_id) === String(role.id));
    if (group) {
      const rows = await getDatabase().all(
        'SELECT user_id FROM bonus_balances WHERE guild_id = ? AND group_id = ?',
        [String(role.guild.id), Number(group.id)]
      );
      const affectedUsers = new Set(rows.map(row => String(row.user_id)));
      const now = Date.now();
      for (const session of Array.from(voiceSessions.values())) {
        if (String(session.guildId) !== String(role.guild.id) || !affectedUsers.has(String(session.userId))) continue;
        const member = role.guild.members.cache.get(String(session.userId))
          || await role.guild.members.fetch(String(session.userId)).catch(() => null);
        if (member) await checkpointVoice(session, now, member, [String(role.id)]).catch(error => {
          console.error('[bonus] deleted-role voice settlement failed:', error);
        });
        voiceSessions.delete(voiceKey(session.guildId, session.userId));
        await removeSavedVoiceSession(session.guildId, session.userId).catch(() => {});
      }
      await getManager().archiveGroup(role.guild.id, Number(group.id), null);
    }
  } catch (error) {
    console.error('[bonus] deleted group role handling failed:', error);
  }
  scheduleRefresh(role.guild, true);
}

async function checkpointMemberVoice(member) {
  if (!member?.guild) return;
  const session = voiceSessions.get(voiceKey(member.guild.id, member.id));
  if (session) await checkpointVoice(session, Date.now(), member).catch(() => {});
}

async function settleVoiceBeforeReset(guild, groupId, userId = null) {
  const now = Date.now();
  for (const session of voiceSessions.values()) {
    if (String(session.guildId) !== String(guild.id) || (userId && String(session.userId) !== String(userId))) continue;
    const member = guild.members.cache.get(String(session.userId));
    if (!member || member.user?.bot) continue;
    const history = await readRoleHistoryForMember(guild, member);
    const target = await getManager().resolveTargetGroup(guild.id, member.id, getRoleIds(member), history);
    if (Number(target) !== Number(groupId)) continue;
    await checkpointVoice(session, now, member).catch(() => {});
  }
}

async function publishAuditLogs(guild, initialize = false) {
  if (!guild) return;
  const database = getDatabase();
  const config = await getManager().readConfig(guild.id).catch(() => ({}));
  if (!config.auditChannelId) return;
  const channel = await guild.channels.fetch(String(config.auditChannelId)).catch(() => null);
  if (!isGuildText(channel)) return;
  const cursorKey = String(guild.id);
  if (initialize && !auditPublishCursor.has(cursorKey)) {
    const latest = await database.get('SELECT COALESCE(MAX(id), 0) AS id FROM bonus_audit_log WHERE guild_id = ?', [cursorKey]).catch(() => null);
    auditPublishCursor.set(cursorKey, Number(latest?.id) || 0);
    return;
  }
  if (!auditPublishCursor.has(cursorKey)) return;
  const cursor = Number(auditPublishCursor.get(cursorKey) || 0);
  const rows = await database.all('SELECT * FROM bonus_audit_log WHERE guild_id = ? AND id > ? ORDER BY id ASC LIMIT 50', [cursorKey, cursor]).catch(() => []);
  let lastId = cursor;
  for (const row of rows) {
    const details = safeJsonParse(row.details_json, {});
    const embed = colorManager.createEmbed().setTitle(`Bonus Audit • ${safeName(row.action, 80)}`)
      .addFields(
        { name: 'Actor', value: row.actor_id ? `<@${row.actor_id}>` : 'System', inline: true },
        { name: 'Target User', value: row.target_user_id ? `<@${row.target_user_id}>` : '—', inline: true },
        { name: 'Groups', value: `Source : ${row.source_group_id ?? '—'}\nTarget : ${row.target_group_id ?? '—'}`, inline: true },
        { name: 'Details', value: `\`\`\`${JSON.stringify(details).slice(0, 900)}\`\`\`` }
      ).setTimestamp(Number(row.created_at) || Date.now());
    await channel.send({ embeds: [embed] }).catch(() => {});
    lastId = Number(row.id) || lastId;
  }
  if (rows.length) auditPublishCursor.set(cursorKey, lastId);
}

function registerInteractionHandler(client) {
  if (boundClient === client) return;
  boundClient = client;
  interactionRouter.register('bonus:', handleInteraction, {
    name: 'bonus-system', priority: 120,
    types: ['button', 'modal', 'roleSelect', 'userSelect', 'stringSelect', 'channelSelect']
  });
  client.on('voiceStateUpdate', (oldState, newState) => {
    handleVoiceState(oldState, newState).catch(error => console.error('[bonus] voice state failed:', error));
  });
  client.on('roleUpdate', (oldRole, newRole) => {
    if (oldRole.name !== newRole.name || oldRole.icon !== newRole.icon) scheduleRefresh(newRole.guild, false);
  });
  client.on('roleDelete', role => handleRoleDelete(role).catch(error => console.error('[bonus] role delete failed:', error)));
  client.on('guildUpdate', (_oldGuild, newGuild) => scheduleRefresh(newGuild, false));
  client.once('ready', () => {
    restoreVoiceSessions(client).catch(error => console.error('[bonus] voice restore failed:', error));
    for (const guild of client.guilds.cache.values()) {
      scheduleRefresh(guild, true);
      publishAuditLogs(guild, true).catch(error => console.error('[bonus] audit cursor init failed:', error));
    }
    if (!boardRefreshInterval) {
      boardRefreshInterval = setInterval(() => {
        for (const guild of client.guilds.cache.values()) {
          maybeRefreshBoard(guild, false).catch(error => console.error('[bonus] periodic board refresh failed:', error));
          publishAuditLogs(guild).catch(error => console.error('[bonus] audit publish failed:', error));
        }
      }, 30000);
      boardRefreshInterval.unref?.();
    }
    if (!voiceInterval) {
      voiceInterval = setInterval(async () => {
        const now = Date.now();
        if (now - lastCacheCleanupAt >= 5 * 60 * 1000) {
          lastCacheCleanupAt = now;
          cleanupBonusCaches(now);
        }
        for (const session of voiceSessions.values()) {
          try {
            if (now - session.lastTrackedAt >= 240000) await checkpointVoice(session, now);
          } catch (error) {
            console.error('[bonus] voice checkpoint failed:', error);
          }
        }
        if (now - lastEventPruneAt > 24 * 60 * 60 * 1000) {
          lastEventPruneAt = now;
          getDatabase().run('DELETE FROM bonus_activity_events WHERE created_at < ?', [now - 7 * 24 * 60 * 60 * 1000])
            .catch(error => console.error('[bonus] event cleanup failed:', error));
        }
        if (now - lastVoiceCleanupAt >= 10 * 60 * 1000) {
          lastVoiceCleanupAt = now;
          cleanupStaleVoiceSessions(client, now).catch(error => console.error('[bonus] stale voice cleanup failed:', error));
        }
      }, 5 * 60 * 1000);
      voiceInterval.unref?.();
    }
  });
}

module.exports = { name, aliases, execute, registerInteractionHandler, recordMessage, handleMemberRoleUpdate, handleMemberLeave, checkpointMemberVoice, maybeRefreshBoard, scheduleRefresh, parseBonusCustomId, buildHomeRows, buildPublicRows, boardCounter, buildHomeEmbed, buildGroupSelect, isEligibleVoiceState, resolveCurrentGroupForMember, validateAvatarUrl, structurePrivateResponse };
