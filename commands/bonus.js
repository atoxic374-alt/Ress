const {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder,
  AuditLogEvent, ChannelType, EmbedBuilder, ModalBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle, UserSelectMenuBuilder, PermissionsBitField
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { getDatabase } = require('../utils/database');
const { createBonusManager, BONUS_METRICS } = require('../utils/bonusManager');
const { buildBonusTopImage, normalizeHex, FALLBACK_COLOR } = require('../utils/bonusTopRenderer');
const interactionRouter = require('../utils/interactionRouter');

const name = 'bonus';
const aliases = ['بونس'];
const roleHistoryPath = path.join(__dirname, '..', 'data', 'roleGrantHistory.json');
const activeAddFlows = new Map();
const pendingRuleChanges = new Map();
const voiceSessions = new Map();
const renderTimers = new Map();
const lastRenderAt = new Map();
const roleAuditCache = new Map();
const guildRoleAuditCache = new Map();
let manager;
let boundClient = null;
let voiceInterval = null;
let lastEventPruneAt = 0;
let roleHistoryCache = { mtime: 0, value: {} };

function getManager() {
  if (!manager) {
    const database = getDatabase();
    if (!database.isInitialized || database.isDegraded) throw new Error('BONUS_DATABASE_NOT_PERSISTENT');
    manager = createBonusManager(database);
  }
  return manager;
}

function idKey(guildId, userId) { return `${guildId}:${userId}`; }
function getRoleIds(member) { return member?.roles?.cache ? Array.from(member.roles.cache.keys(), String) : []; }
function isGuildText(channel) {
  return Boolean(channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement));
}
function safeName(value, max = 80) { return String(value || '').replace(/[\u0000-\u001f]/g, '').slice(0, max); }

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
  const history = { ...readRoleHistory(guild.id, member.id) };
  const groups = await getManager().listGroups(guild.id).catch(() => []);
  const heldGroupRoles = groups.map(group => String(group.role_id)).filter(roleId => member.roles?.cache?.has(roleId));
  const missing = heldGroupRoles.filter(roleId => !Number(history[roleId] || 0));
  if (!missing.length) {
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
      // Missing audit-log permission falls back to stable group creation order.
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
  const payload = { content: `❌ ${text}`, ephemeral: true };
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
    `**حالة النظام:** ${complete ? 'جاهز' : 'قيد الإعداد'}`,
    `**روم التوب:** ${config.channelId ? `<#${config.channelId}>` : 'غير محدد'}`,
    `**لون الصورة:** ${config.autoColor === false ? normalizeHex(config.color) : 'تلقائي من أيقونة السيرفر'}`,
    `**القروبات النشطة:** ${groups.length}`,
    `**قاعدة الرسائل:** ${rules.messages ? `كل ${Number(rules.messages.threshold).toLocaleString()} رسالة = ${rules.messages.points} نقطة` : 'غير محددة'}`,
    `**قاعدة الصوت:** ${rules.voice_ms ? `كل ${Number(rules.voice_ms.threshold) / 3600000} ساعة = ${rules.voice_ms.points} نقطة` : 'غير محددة'}`
  ];
  return new EmbedBuilder()
    .setTitle(`إعدادات البونس • ${safeName(guild.name)}`)
    .setDescription(lines.join('\n'))
    .setColor(config.autoColor === false ? normalizeHex(config.color) : FALLBACK_COLOR)
    .setFooter({ text: 'التغييرات محفوظة في SQLite • إعدادات مستقلة لكل سيرفر' });
}

function button(customId, label, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
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
      button('bonus:managers', 'المسؤولون'),
      button('bonus:channel', 'روم التوب'),
      button('bonus:color', 'لون الصورة'),
      button('bonus:rules', 'نقاط التوب'),
      button('bonus:publish', 'نشر / تحديث', ButtonStyle.Success)
    ),
    new ActionRowBuilder().addComponents(
      button('bonus:add-group', 'إضافة قروب'),
      button('bonus:manage-groups', 'إدارة القروبات'),
      button('bonus:reset', 'تصفير'),
      button('bonus:double', 'دبل بونس'),
      button('bonus:refresh-home', 'تحديث اللوحة')
    )
  ];
}

async function buildHome(guild) {
  const db = getManager();
  const [config, groups, rules, ready] = await Promise.all([
    db.readConfig(guild.id), db.listGroups(guild.id), db.getRules(guild.id), db.isReady(guild.id)
  ]);
  return { embeds: [buildHomeEmbed(guild, config, groups, rules, ready)], components: buildHomeRows() };
}

function isEphemeralMessage(interaction) {
  try { return Boolean(interaction.message?.flags?.has(64)); }
  catch { return false; }
}

async function showPrivatePanel(interaction, payload, update = false) {
  if (update && isEphemeralMessage(interaction)) {
    await interaction.update({ ...payload, ephemeral: undefined });
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
  const embed = new EmbedBuilder().setTitle('المسؤولون عن نظام البونس')
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
  nav.push(button('bonus:home', 'إلغاء / رجوع'));
  rows.push(new ActionRowBuilder().addComponents(nav));
  return { content: `اختر القروب المطلوب (صفحة ${safePage + 1}/${pageCount}):`, components: rows };
}

async function getGroupsForDisplay(guild) {
  const groups = await getManager().listGroups(guild.id, false);
  return groups.map(group => ({
    ...group,
    role_name: guild.roles.cache.get(String(group.role_id))?.name || 'رول محذوف',
    owner_name: guild.members.cache.get(String(group.owner_id))?.displayName || guild.members.cache.get(String(group.owner_id))?.user?.username || 'مالك غير موجود'
  }));
}

async function maybeRefreshBoard(guild, force = false) {
  if (!guild || !boundClient) return;
  const db = getManager();
  const config = await db.readConfig(guild.id);
  if (!config.topMessageId || !config.channelId) return;
  const now = Date.now();
  const last = lastRenderAt.get(guild.id) || 0;
  if (!force && now - last < 60000) {
    if (!renderTimers.has(guild.id)) {
      renderTimers.set(guild.id, setTimeout(() => {
        renderTimers.delete(guild.id);
        maybeRefreshBoard(guild, true).catch(error => console.error('[bonus] render refresh failed:', error));
      }, Math.max(1000, 60000 - (now - last))));
    }
    return;
  }
  lastRenderAt.set(guild.id, now);
  const channel = await guild.channels.fetch(String(config.channelId)).catch(() => null);
  if (!isGuildText(channel)) return;
  const boardMessage = await channel.messages.fetch(String(config.topMessageId)).catch(() => null);
  if (!boardMessage) return;
  const [groups, rawGroups] = await Promise.all([db.getLeaderboard(guild.id, 10), db.listGroups(guild.id)]);
  const enriched = groups.map((group, index) => ({
    ...group,
    role_name: guild.roles.cache.get(String(group.role_id))?.name || `قروب ${index + 1}`,
    owner_name: guild.members.cache.get(String(group.owner_id))?.displayName || guild.members.cache.get(String(group.owner_id))?.user?.username || 'مالك غير محدد'
  }));
  const attachment = await buildBonusTopImage({ guild, groups: enriched, config, updatedAt: now });
  await boardMessage.edit({ files: [attachment], attachments: [], components: buildPublicRows() });
}

function buildPublicRows() {
  return [new ActionRowBuilder().addComponents(
    button('bonus:public-settings', 'إعدادات القروبات'),
    button('bonus:public-refresh', 'تحديث التوب')
  )];
}

async function publishBoard(guild, actorId) {
  const db = getManager();
  const config = await db.readConfig(guild.id);
  const groups = await db.listGroups(guild.id);
  const rules = await db.getRules(guild.id);
  if (!config.channelId) throw new Error('CHANNEL_REQUIRED');
  if (!groups.length) throw new Error('GROUP_REQUIRED');
  if (!rules[ BONUS_METRICS.messages ] || !rules[ BONUS_METRICS.voice ]) throw new Error('RULE_REQUIRED');
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
  const leaderboard = await db.getLeaderboard(guild.id, 10);
  const enriched = leaderboard.map((group, index) => ({
    ...group,
    role_name: guild.roles.cache.get(String(group.role_id))?.name || `قروب ${index + 1}`,
    owner_name: guild.members.cache.get(String(group.owner_id))?.displayName || guild.members.cache.get(String(group.owner_id))?.user?.username || 'مالك غير محدد'
  }));
  const attachment = await buildBonusTopImage({ guild, groups: enriched, config });
  let message = config.topMessageId ? await channel.messages.fetch(String(config.topMessageId)).catch(() => null) : null;
  if (message) {
    await message.edit({ files: [attachment], attachments: [], components: buildPublicRows() });
  } else {
    message = await channel.send({ files: [attachment], components: buildPublicRows() });
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
  if (isEphemeralMessage(interaction)) await interaction.update(await buildHome(interaction.guild));
  else await interaction.reply({ ...(await buildHome(interaction.guild)), ephemeral: true });
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
    const [prefix, action, ...parts] = interaction.customId.split(':');
    if (prefix !== 'bonus') return false;
    if (!interaction.guild) {
      await deny(interaction, 'هذه التفاعلات تعمل داخل السيرفر فقط.');
      return true;
    }

    if (action === 'public-settings' || action === 'public-refresh' || action === 'open' || action === 'refresh-home' || action === 'home') {
      if (action === 'public-settings' || action === 'open') {
        if (!await requireManager(interaction, context)) return true;
        await showPrivatePanel(interaction, await buildHome(interaction.guild), false);
      } else if (action === 'public-refresh') {
        await maybeRefreshBoard(interaction.guild, true).catch(() => {});
        await interaction.reply({ content: 'تم طلب تحديث التوب.', ephemeral: true }).catch(() => {});
      } else {
        if (!await requireManager(interaction, context)) return true;
        await refreshEphemeralHome(interaction);
      }
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

    if (!await requireManager(interaction, context)) return true;
    const db = getManager();

    if (action === 'page') {
      const selectAction = parts[0];
      const page = Number(parts[1]);
      const groups = await getGroupsForDisplay(interaction.guild);
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
      const row = new ActionRowBuilder().addComponents(
        button('bonus:rule:messages', 'قاعدة الرسائل'),
        button('bonus:rule:voice', 'قاعدة الساعات الصوتية')
      );
      await showPrivatePanel(interaction, { content: 'اختر نوع القاعدة. الصوت يُدخل بالساعات ثم يُحوّل داخليًا إلى ميلي ثانية.', components: [row, new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
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

    if (action === 'select:add-role') {
      const roleId = interaction.values[0];
      if (!interaction.guild.roles.cache.has(roleId)) {
        await showPrivatePanel(interaction, { content: 'الرول غير موجود في هذا السيرفر.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
        return true;
      }
      activeAddFlows.set(idKey(interaction.guild.id, interaction.user.id), { roleId, createdAt: Date.now() });
      const menu = new UserSelectMenuBuilder().setCustomId('bonus:select:add-owner').setPlaceholder('ابحث واختر Owner القروب').setMinValues(1).setMaxValues(1);
      await showPrivatePanel(interaction, { content: `الرول: <@&${roleId}>\nاختر Owner القروب:`, components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(button('bonus:home', 'إلغاء'))] }, true);
      return true;
    }

    if (action === 'select:add-owner') {
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
        await showPrivatePanel(interaction, { content: `تمت إضافة <@&${flow.roleId}> وربطه بالـOwner <@${ownerId}>.`, components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع للإعدادات'))] }, true);
      } catch (error) {
        const text = error.message === 'ROLE_ALREADY_REGISTERED' ? 'هذا الرول مسجل كقروب بالفعل.' : 'تعذرت إضافة القروب.';
        await showPrivatePanel(interaction, { content: text, components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
      }
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
      await db.updateGroup(interaction.guild.id, groupId, { owner_id: newOwnerId }, interaction.user.id);
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
      const active = await getDatabase().get(`SELECT COUNT(*) AS count FROM bonus_multipliers WHERE guild_id = ? AND group_id = ? AND active = 1 AND (ends_at IS NULL OR ends_at > ?)`, [interaction.guild.id, groupId, Date.now()]);
      const buttons = [button(`bonus:double-scope:group:${groupId}`, 'دبل للرول كاملًا', ButtonStyle.Primary), button(`bonus:double-scope:user:${groupId}`, 'دبل لشخص')];
      if (Number(active?.count) > 0) buttons.push(button(`bonus:double-off:group:${groupId}`, 'إيقاف دبل الرول', ButtonStyle.Danger));
      await showPrivatePanel(interaction, { content: `اختر نطاق الدبل لقروب <@&${group.role_id}>. الدبل ×2 فقط ولا يتراكم إلى ×4.`, components: [new ActionRowBuilder().addComponents(buttons), new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
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
        const menu = new UserSelectMenuBuilder().setCustomId(`bonus:select:double-user:${groupId}`).setPlaceholder('اختر عضوًا من الرول').setMinValues(1).setMaxValues(1);
        await showPrivatePanel(interaction, { content: `اختر العضو لتفعيل دبل ×2 داخل <@&${(await getDatabase().get('SELECT role_id FROM bonus_groups WHERE guild_id = ? AND id = ?', [interaction.guild.id, groupId]))?.role_id}>.`, components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
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
      if (scope === 'user') {
        const group = (await db.listGroups(interaction.guild.id)).find(item => Number(item.id) === groupId);
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
      await showPrivatePanel(interaction, { content: 'تم إيقاف دبل القروب.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع للإعدادات'))] }, true);
      return true;
    }

    if (action === 'confirm') {
      const [confirmAction, rawGroupId, rawUserId] = parts;
      const groupId = Number(rawGroupId);
      if (confirmAction === 'group-reset') {
        await settleVoiceBeforeReset(interaction.guild, groupId);
        const totals = await db.resetGroup(interaction.guild.id, groupId, interaction.user.id);
        await showPrivatePanel(interaction, { content: `تم تصفير القروب. خُصمت ${totals.points.toLocaleString()} نقطة وأُعيد تقدم ${totals.members} عضوًا إلى الصفر.`, components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع للإعدادات'))] }, true);
      } else if (confirmAction === 'user-reset') {
        await settleVoiceBeforeReset(interaction.guild, groupId, rawUserId === '0' ? null : rawUserId);
        const result = await db.resetUser(interaction.guild.id, groupId, rawUserId === '0' ? '' : rawUserId, interaction.user.id);
        await showPrivatePanel(interaction, { content: result ? `تم تصفير نقاط <@${rawUserId}> داخل القروب فقط (${result.points.toLocaleString()} نقطة).` : 'لم يوجد رصيد لهذا العضو داخل القروب.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع للإعدادات'))] }, true);
      } else if (confirmAction === 'archive') {
        const archived = await db.archiveGroup(interaction.guild.id, groupId, interaction.user.id);
        await showPrivatePanel(interaction, { content: archived ? 'تمت أرشفة القروب.' : 'القروب غير موجود أو مؤرشف.', components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع للإعدادات'))] }, true);
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
      await db.setRule(interaction.guild.id, pending.metric, pending.threshold, pending.points, interaction.user.id);
      await interaction.update({ content: 'تم اعتماد القاعدة. لن تُعاد كتابة النقاط السابقة، لكن التقدم الموجود قد يُحوّل عند النشاط القادم.', components: [] });
      scheduleRefresh(interaction.guild, true);
      return true;
    }

    if (action === 'publish') {
      try {
        const published = await publishBoard(interaction.guild, interaction.user.id);
        await showPrivatePanel(interaction, { content: `تم نشر/تحديث لوحة التوب في <#${published.channelId}>.`, components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع للإعدادات'))] }, true);
      } catch (error) {
        const messages = {
          CHANNEL_REQUIRED: 'حدد روم التوب أولًا.',
          GROUP_REQUIRED: 'أضف قروبًا واحدًا على الأقل قبل نشر التوب.',
          RULE_REQUIRED: 'حدد قاعدة الرسائل وقاعدة الساعات الصوتية قبل نشر التوب.',
          CHANNEL_NOT_FOUND: 'روم العرض لم يعد موجودًا أو البوت لا يستطيع الوصول إليه.',
          MISSING_CHANNEL_PERMISSIONS: 'البوت يحتاج صلاحيات عرض الروم وإرسال الرسائل ورفع الملفات وقراءة سجل الرسائل.'
        };
        await showPrivatePanel(interaction, { content: `لم يُنشر التوب: ${messages[error.message] || 'حدث خطأ أثناء الإنشاء.'}`, components: [new ActionRowBuilder().addComponents(button('bonus:home', 'رجوع'))] }, true);
      }
      return true;
    }

    if (action === 'modal') {
      const modalAction = parts[0];
      if (modalAction === 'color') {
        const color = collectModalValue(interaction, 'hex');
        if (!/^#?[0-9a-f]{6}$/i.test(color)) {
          await interaction.reply({ content: 'صيغة اللون غير صحيحة. اكتب مثل #D9A441.', ephemeral: true });
          return true;
        }
        await db.saveConfig(interaction.guild.id, { autoColor: false, color: normalizeHex(color) }, interaction.user.id);
        await interaction.reply({ content: `تم اعتماد اللون ${normalizeHex(color)}.`, ephemeral: true });
        scheduleRefresh(interaction.guild, true);
        return true;
      }
      if (modalAction === 'rule') {
        const metricName = parts[1];
        const metric = metricName === 'messages' ? BONUS_METRICS.messages : metricName === 'voice' ? BONUS_METRICS.voice : null;
        const thresholdRaw = Number(collectModalValue(interaction, 'threshold').replace(/[,،]/g, '').replace(/\s/g, ''));
        const points = Number(collectModalValue(interaction, 'points').replace(/[,،]/g, '').replace(/\s/g, ''));
        const threshold = metricName === 'voice' ? Math.round(thresholdRaw * 3600000) : thresholdRaw;
        if (!metric || !Number.isSafeInteger(threshold) || threshold <= 0 || !Number.isSafeInteger(points) || points <= 0) {
          await interaction.reply({ content: 'القيم غير صحيحة. استخدم أرقامًا صحيحة أكبر من صفر.', ephemeral: true });
          return true;
        }
        const progressColumn = metric === BONUS_METRICS.messages ? 'message_progress' : 'voice_progress_ms';
        const currentProgress = await getDatabase().get(`SELECT MAX(${progressColumn}) AS maximum FROM bonus_balances WHERE guild_id = ?`, [interaction.guild.id]);
        if (Number(currentProgress?.maximum || 0) >= threshold) {
          pendingRuleChanges.set(idKey(interaction.guild.id, interaction.user.id), {
            metric, threshold, points, metricName, thresholdRaw, createdAt: Date.now()
          });
          await interaction.reply({
            content: '⚠️ يوجد تقدم جزئي أعلى من الحد الجديد. عند أول نشاط لاحق قد تُمنح نقاط فورًا وفق القاعدة الجديدة. هل تريد اعتماد هذا التغيير؟',
            components: [new ActionRowBuilder().addComponents(
              button(`bonus:confirm-rule:${metricName}:${threshold}:${points}`, 'اعتماد القاعدة', ButtonStyle.Danger),
              button('bonus:home', 'إلغاء')
            )],
            ephemeral: true
          });
        } else {
          await db.setRule(interaction.guild.id, metric, threshold, points, interaction.user.id);
          await interaction.reply({ content: `تم حفظ القاعدة: كل ${metricName === 'voice' ? thresholdRaw + ' ساعة صوتية' : thresholdRaw + ' رسالة'} = ${points} نقطة. التقدم الجزئي يُحفظ، والتعديل لا يعيد احتساب النقاط القديمة.`, ephemeral: true });
          scheduleRefresh(interaction.guild, true);
        }
        return true;
      }
      if (modalAction === 'avatar') {
        const groupId = Number(parts[1]);
        const url = collectModalValue(interaction, 'url');
        if (url && (!/^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//i.test(url) || !/\.(png|jpe?g|webp|gif)(\?|$)/i.test(url))) {
          await interaction.reply({ content: 'استخدم رابط صورة مباشرًا من Discord CDN بصيغة PNG/JPG/WEBP/GIF، أو اتركه فارغًا للصورة الافتراضية.', ephemeral: true });
          return true;
        }
        await db.updateGroup(interaction.guild.id, groupId, { avatar_url: url || null }, interaction.user.id);
        await interaction.reply({ content: url ? 'تم تحديث صورة القروب.' : 'عاد القروب لاستخدام أيقونة السيرفر.', ephemeral: true });
        scheduleRefresh(interaction.guild, true);
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error('[bonus] interaction failed:', error);
    if (interaction.deferred || interaction.replied) await interaction.followUp({ content: 'حدث خطأ أثناء تنفيذ إعداد البونس. راجع السجل وحاول مجددًا.', ephemeral: true }).catch(() => {});
    else await interaction.reply({ content: 'حدث خطأ أثناء تنفيذ إعداد البونس.', ephemeral: true }).catch(() => {});
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

async function recordActivity(guild, member, metric, amount, eventId, voiceSession = null) {
  if (!guild || !member || member.user?.bot) return { ignored: true };
  let db;
  try { db = getDatabase(); } catch { return { ignored: true }; }
  if (!db?.isInitialized || db.isDegraded) return { ignored: true, degraded: true };
  try {
    const roleGrantHistory = await readRoleHistoryForMember(guild, member);
    const result = await getManager().addActivity({
      guildId: guild.id,
      userId: member.id,
      metric,
      amount,
      eventId,
      roleIds: getRoleIds(member),
      roleGrantHistory,
      voiceSession
    });
    if (result.awardedPoints > 0) scheduleRefresh(guild, false);
    return result;
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
function isEligibleVoiceState(state) {
  if (!state?.guild || !state.member || state.member.user?.bot || !state.channelId) return false;
  if (state.channel?.type === ChannelType.GuildStageVoice) return false;
  if (state.guild.afkChannelId && state.channelId === state.guild.afkChannelId) return false;
  return true;
}

async function checkpointVoice(session, toTime = Date.now(), member = null) {
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
    });
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
    for (const state of guild.voiceStates.cache.values()) {
      if (!isEligibleVoiceState(state)) continue;
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

async function handleMemberRoleUpdate(oldMember, newMember) {
  if (!newMember?.guild || newMember.user?.bot) return;
  const key = voiceKey(newMember.guild.id, newMember.id);
  roleAuditCache.delete(idKey(newMember.guild.id, newMember.id));
  guildRoleAuditCache.delete(String(newMember.guild.id));
  try {
    const history = await readRoleHistoryForMember(newMember.guild, newMember);
    const targetGroupId = await getManager().resolveTargetGroup(newMember.guild.id, newMember.id, getRoleIds(newMember), history);
    await getManager().syncAssignment(newMember.guild.id, newMember.id, targetGroupId, null, 'guild_member_update');
  } catch (error) {
    console.error('[bonus] role assignment sync failed:', error);
  }
  scheduleRefresh(newMember.guild, false);
}

async function handleMemberLeave(member) {
  if (!member?.guild || member.user?.bot) return;
  try {
    await getManager().syncAssignment(member.guild.id, member.id, null, null, 'guild_member_leave');
    scheduleRefresh(member.guild, false);
  } catch (error) {
    console.error('[bonus] member leave assignment sync failed:', error);
  }
}

async function handleRoleDelete(role) {
  if (!role?.guild) return;
  try {
    const group = (await getManager().listGroups(role.guild.id)).find(item => String(item.role_id) === String(role.id));
    if (group) await getManager().archiveGroup(role.guild.id, Number(group.id), null);
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
    for (const guild of client.guilds.cache.values()) scheduleRefresh(guild, true);
    if (!voiceInterval) {
      voiceInterval = setInterval(async () => {
        const now = Date.now();
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
      }, 5 * 60 * 1000);
      voiceInterval.unref?.();
    }
  });
}

module.exports = { name, aliases, execute, registerInteractionHandler, recordMessage, handleMemberRoleUpdate, handleMemberLeave, checkpointMemberVoice, maybeRefreshBoard, scheduleRefresh };
