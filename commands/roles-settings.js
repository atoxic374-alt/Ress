const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, PermissionsBitField } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const { getGuildConfig, getConfigData, updateGuildConfig, isManager, isCustomRolesChannelAllowed, getRoleEntry, addRoleEntry, deleteRoleEntry, restoreRoleEntry, getGuildRoles, getDeletedRoles, getDeletedRoleEntry, removeDeletedRoleEntry, findRoleByOwner, formatDuration, getRoleResetDate } = require('../utils/customRolesSystem.js');
const { getDatabase } = require('../utils/database.js');
const fs = require('fs');
const path = require('path');
const myRoleCommand = require('./myrole.js');
const sroleCommand = require('./srole.js');
const listCommand = require('./list.js');
const interactionRouter = require('../utils/interactionRouter');
const { resolveIconBuffer, applyRoleIcon } = require('../utils/roleIconUtils.js');

const activeTopSchedules = new Map();
const activePanelCleanups = new Map();
const panelCleanupKeepIds = new Map();
const pendingPanelSetup = new Map();
const pendingPanelTimeouts = new Map();
const pendingBulkDeletes = new Map();
const pendingRoleApprovals = new Set();
const restoreSessions = new Map();
const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
const REQUEST_REAPPLY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RESTORE_PAGE_SIZE = 25;

function scheduleDelete(message, delay = 180000) {
  if (!message) return;
  setTimeout(() => {
    message.delete().catch(() => {});
  }, delay);
}

async function sendTemp(channel, payload, delay = 1000) {
  if (!channel) return null;
  const message = typeof payload === 'string'
    ? await channel.send(payload)
    : await channel.send(payload);
  scheduleDelete(message, delay);
  return message;
}

async function respondEphemeral(interaction, payload) {
  if (!interaction) return;
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ ...payload, ephemeral: true }).catch(() => {});
  } else {
    await interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
  }
}

async function respondEphemeralWithMessage(interaction, payload) {
  if (!interaction) return null;
  const replyPayload = { ...payload, ephemeral: true, withResponse: true };
  if (interaction.deferred || interaction.replied) {
    const response = await interaction.followUp(replyPayload).catch(() => null);
    return response?.resource?.message || response || null;
  }
  const response = await interaction.reply(replyPayload).catch(() => null);
  return response?.resource?.message || response || null;
}

async function ensureEphemeralAck(interaction) {
  if (!interaction) return false;
  if (interaction.deferred || interaction.replied) return true;
  const deferred = await interaction.deferReply({ ephemeral: true }).catch(() => null);
  return Boolean(deferred);
}

function getRequestCooldownRemaining(guildConfig, userId) {
  const cooldowns = guildConfig.requestCooldowns || {};
  const lastRejectedAt = cooldowns[userId];
  if (!lastRejectedAt) return 0;
  const elapsed = Date.now() - lastRejectedAt;
  const remaining = REQUEST_REAPPLY_COOLDOWN_MS - elapsed;
  return remaining > 0 ? remaining : 0;
}

function getValidOwnerRoleEntry(guild, ownerId, deletedBy = 'system_cleanup') {
  const roleEntry = findRoleByOwner(guild.id, ownerId);
  if (!roleEntry) return null;

  const roleExists = guild.roles.cache.has(roleEntry.roleId);
  if (roleExists) return roleEntry;

  deleteRoleEntry(roleEntry.roleId, deletedBy);
  return null;
}

function buildSettingsMenu(userId, client) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`customroles_settings_menu_${userId}`)
    .setPlaceholder('اختر إعداداً...')
    .addOptions([
      { label: 'Mangers', value: 'managers', emoji: '<:emoji_29:1465373807471759523>', description: 'تعيين مسؤوليين للنظام'}, 
      { label: 'Channels', value: 'channels', emoji: '<:emoji_28:1465373772109447380>', description: 'تعيين الرومات المحظوره والمسموحه'},
      { label: 'Panels', value: 'send_panels', emoji: '<:emoji_27:1465373748227215451>', description: 'ارسال بانل التوب ، وازرار الادارة والاعضاء والطلبات'}, 
      { label: 'Category', value: 'role_category', emoji: '<:emoji_24:1465373678064898070>', description: 'الرول اللي تحته ينشأ الرولات الخاصة'}, 
      { label: 'Status', value: 'system_summary', emoji: '<:emoji_23:1465373644241895681>', description: 'حالة النظام وملخصها'}, 
      { label: 'Reset active', value: 'reset_activity', emoji: '<:emoji_26:1465373714060415180>', description: 'تصفير تفاعل الرولات الخاصة'}, 
      { label: 'Active top', value: 'top_roles', emoji: '<:emoji_23:1465373597844373797>', description: 'تفعيل تحديث بانل التوب' }
    ]);

  const embed = new EmbedBuilder()
    .setTitle('Roles SYS;')
    .setDescription('**إعدادات الرولات الخاصة.**')
    .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
    .setThumbnail('https://cdn.discordapp.com/attachments/1465209977378439266/1465374810186973447/status-update.png?ex=6978e024&is=69778ea4&hm=ec7f201d4977f1bb05cd2e0cbf58fdfb2fa2cc0352cb8d03a349d6f0025079b1&' )
.setFooter({ text: 'By Ahmed;' });


  return { embed, row: new ActionRowBuilder().addComponents(menu) };
}

function buildPanelEmbed(type, guild) {
  const color = colorManager.getColor ? colorManager.getColor() : '#2f3136';
  const thumbnail = guild?.client?.user?.displayAvatarURL({ size: 128 });
  switch (type) {
    case 'member':
      return new EmbedBuilder()
        .setTitle('Manage Your Role')
        .setDescription('اختر العملية المناسبة لإدارة رولك بسرعة وسهولة.')
        .setColor(color)
        .setThumbnail(thumbnail);
    case 'admin':
      return new EmbedBuilder()
        .setTitle('Manage Roles')
        .setDescription('تحكم سريع بالرولات الخاصة (إدارة، حذف، استرجاع، تصفير).')
        .setColor(color)
        .setThumbnail(thumbnail);
    case 'request':
      return new EmbedBuilder()
        .setTitle('Request Roles')
        .setDescription('قدّم طلبك وسيتم مراجعته من الإدارة.')
        .setColor(color)
        .setThumbnail(thumbnail);
    default:
      return new EmbedBuilder()
        .setTitle('Top roles')
        .setDescription('أعلى الرولات بحسب التفاعل.')
        .setColor(color)
        .setThumbnail(thumbnail);
  }
}

function getPanelImageUrl(type, guildConfig) {
  if (type === 'member') return guildConfig.memberImage;
  if (type === 'admin') return guildConfig.adminImage;
  if (type === 'request') return guildConfig.requestImage;
  if (type === 'top') return guildConfig.topImage;
  return null;
}

function buildAdminSummaryEmbed(title, fields = [], description = null) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
    .setTimestamp();
  if (description) embed.setDescription(description);
  if (fields.length) embed.addFields(fields);
  return embed;
}

function normalizeSearchText(text = '') {
  return text
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/\s+/g, '');
}

function getLevenshteinDistance(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[a.length][b.length];
}

function isApproximateMatch(query, target) {
  if (!query || !target) return false;
  if (target.includes(query)) return true;
  if (target.startsWith(query)) return true;
  if (query.length < 2) return false;
  const distance = getLevenshteinDistance(query, target);
  const threshold = Math.max(2, Math.floor(query.length / 3));
  return distance <= threshold;
}

function buildRoleOptions(guild, query = '') {
  const normalizedQuery = normalizeSearchText(query || '');
  const entries = getGuildRoles(guild.id);
  const needsSearchOption = !normalizedQuery && entries.length > 25;
  const options = entries
    .map(entry => {
      const role = guild.roles.cache.get(entry.roleId);
      if (!role) return null;
      return { entry, role };
    })
    .filter(Boolean)
    .filter(({ entry, role }) => {
      if (!normalizedQuery) return true;
      const roleName = normalizeSearchText(role.name || '');
      const roleId = role.id;
      const ownerId = entry.ownerId || '';
      if (roleId === normalizedQuery || ownerId === normalizedQuery) return true;
      if (/^\d+$/.test(normalizedQuery)) {
        if (roleId.includes(normalizedQuery) || ownerId.includes(normalizedQuery)) return true;
      }
      return isApproximateMatch(normalizedQuery, roleName);
    })
    .map(({ role }) => ({
      label: (role.name && role.name.trim() ? role.name : `Role ${role.id}`).slice(0, 100),
      value: role.id
    }))
    .filter(option => option.label && option.value);

  if (needsSearchOption) {
    const trimmedOptions = options.slice(0, 24);
    trimmedOptions.push({ label: '🔎 بحث', value: 'search' });
    return trimmedOptions;
  }

  return options.slice(0, 25);
}

function buildAdminRoleMenu(action, userId, guild, query = '') {
  const roleOptions = buildRoleOptions(guild, query);
  if (roleOptions.length === 0) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`customroles_admin_panel_select_${action}_${userId}`)
    .setPlaceholder('اختر رولاً خاصاً...')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(roleOptions);

  return new ActionRowBuilder().addComponents(menu);
}

function getRestorableDeletedRoles(guildId) {
  const deletedRoles = getDeletedRoles(guildId)
    .sort((a, b) => (b.deletedAt || b.updatedAt || 0) - (a.deletedAt || a.updatedAt || 0));

  const dedupedByOwner = new Map();
  for (const entry of deletedRoles) {
    if (!entry?.roleId) continue;
    const ownerKey = entry.ownerId ? `owner:${entry.ownerId}` : `role:${entry.roleId}`;
    if (!dedupedByOwner.has(ownerKey)) {
      dedupedByOwner.set(ownerKey, entry);
    }
  }

  return [...dedupedByOwner.values()]
    .filter(entry => !(entry.ownerId && findRoleByOwner(guildId, entry.ownerId)))
    .sort((a, b) => (b.deletedAt || b.updatedAt || 0) - (a.deletedAt || a.updatedAt || 0));
}

function buildRestoreComponents(sessionId, userId, deletedRoles, page = 0) {
  if (!deletedRoles.length) return { content: '❌ لا توجد رولات محذوفة.', components: [] };

  const totalPages = Math.max(1, Math.ceil(deletedRoles.length / RESTORE_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * RESTORE_PAGE_SIZE;
  const currentPageRoles = deletedRoles.slice(start, start + RESTORE_PAGE_SIZE);
  const options = currentPageRoles.map(entry => ({
    label: (entry.name || entry.roleId).slice(0, 100),
    value: entry.roleId,
    description: `مالك: ${entry.ownerId || 'غير معروف'}`.slice(0, 100)
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`customroles_restore_select_${userId}_${sessionId}`)
    .setPlaceholder('اختر رولاً للاسترجاع...')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`customroles_restore_prev_${sessionId}`)
      .setLabel('السابق')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage === 0),
    new ButtonBuilder()
      .setCustomId(`customroles_restore_next_${sessionId}`)
      .setLabel('التالي')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1)
  );

  return {
    content: `اختر الرول المطلوب لاسترجاعه:\nالصفحة **${safePage + 1}/${totalPages}** • العدد **${deletedRoles.length}**`,
    components: [new ActionRowBuilder().addComponents(menu), navRow],
    page: safePage
  };
}

async function showCustomRoleSearchModal(interaction, action) {
  const modal = new ModalBuilder()
    .setCustomId(`customroles_search_modal_${action}_${interaction.user.id}`)
    .setTitle('بحث عن رول خاص');

  const queryInput = new TextInputBuilder()
    .setCustomId('customroles_search_query')
    .setLabel('ابحث بالاسم أو ID أو Owner ID')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder('مثال: اسم الرول أو 123456...');

  modal.addComponents(new ActionRowBuilder().addComponents(queryInput));
  await interaction.showModal(modal);
}

function buildAdminBulkDeleteMenu(userId, guild, query = '') {
  const roleOptions = buildRoleOptions(guild, query);
  if (roleOptions.length === 0) return null;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`customroles_admin_bulkdelete_${userId}`)
    .setPlaceholder('اختر الرولات المطلوب حذفها...')
    .setMinValues(1)
    .setMaxValues(Math.min(25, roleOptions.length))
    .addOptions(roleOptions);
  return new ActionRowBuilder().addComponents(menu);
}

async function logRoleAction(guild, guildConfig, description, fields = []) {
  if (!guildConfig?.logChannelId) return;
  const channel = await guild.channels.fetch(guildConfig.logChannelId).catch(() => null);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setTitle('📝 سجل الرولات الخاصة')
    .setDescription(description)
.setThumbnail('https://cdn.discordapp.com/attachments/1373463003311243364/1465205359885946900/data.png?ex=69784253&is=6976f0d3&hm=e029b7dda1110a8bbe7b47adc2b238d6e19ae5d2c340abd5ca9b09df0d3efc27&')
    .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
    .setTimestamp();
  if (fields.length) embed.addFields(fields);
  await channel.send({ embeds: [embed] }).catch(() => {});
}

function buildInteractionMessage(interaction) {
  return {
    author: interaction.user,
    member: interaction.member,
    guild: interaction.guild,
    channel: interaction.channel,
    client: interaction.client,
    interaction
  };
}

function formatChannelList(channels = []) {
  if (!channels || channels.length === 0) return 'لا يوجد';
  return channels.map(id => `<#${id}>`).join('\n');
}

function normalizeUniqueIds(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function loadAdminRoles() {
  try {
    if (!fs.existsSync(adminRolesPath)) return [];
    const data = fs.readFileSync(adminRolesPath, 'utf8');
    const roles = JSON.parse(data);
    return Array.isArray(roles) ? roles : [];
  } catch (error) {
    console.error('خطأ في قراءة adminRoles:', error);
    return [];
  }
}

async function buildPanelPayload(type, guild, guildConfig) {
  const imageUrl = getPanelImageUrl(type, guildConfig);
  const payload = {};

  if (type === 'top') {
    const embed = await buildTopRolesEmbed(guild, guildConfig);
    if (imageUrl) embed.setImage(imageUrl);
    payload.embeds = [embed];
    return payload;
  }

  if (imageUrl) {
    payload.content = imageUrl;
  } else {
    const embed = buildPanelEmbed(type, guild);
    payload.embeds = [embed];
  }
  if (type === 'member') {
    payload.components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('customroles_member_action_name').setLabel('تغيير الاسم').setEmoji('<:emoji_14:1465332216375808187>').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('customroles_member_action_manage').setLabel('إضافة/إزالة').setEmoji('<:emoji_14:1465332188953186453>').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('customroles_member_action_color').setLabel('تغيير اللون').setEmoji('<:emoji_10:1465332068128002291>').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('customroles_member_action_icon').setLabel('تغيير الايكون').setEmoji('<:emoji_3:1465210427494502400>').setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('customroles_member_action_members').setLabel('الأعضاء').setEmoji('<:emoji_12:1465332124784656446>').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('customroles_member_action_transfer').setLabel('نقل الملكية').setEmoji('<:emoji_10:1465332029473161350>').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('customroles_member_action_delete').setLabel('حذف الرول').setEmoji('<:emoji_21:1465336647477493894>').setStyle(ButtonStyle.Danger)
      )
    ];
  }
  if (type === 'admin') {
    payload.components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('customroles_admin_panel_create').setLabel('إنشاء رول').setEmoji('<:emoji_33:1465383525644501238>').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('customroles_admin_panel_add').setLabel('إضافة رول').setEmoji('<:emoji_30:1465383419641856233>').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('customroles_admin_panel_delete').setLabel('حذف رول').setEmoji('<:emoji_21:1465336647477493894>').setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('customroles_admin_panel_info').setLabel('معلومات رول').setEmoji('<:emoji_33:1465383582292771025>').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('customroles_admin_panel_reset_role').setLabel('تصفير رول').setEmoji('<:emoji_34:1465383644339241073>').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('customroles_admin_panel_reset_all').setLabel('تصفير الكل').setEmoji('<:emoji_26:1465373714060415180>').setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('customroles_admin_manage').setLabel('إدارة رول').setEmoji('<:emoji_35:1465383704993202452>').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('customroles_admin_restore').setLabel('استرجاع رول').setEmoji('<:emoji_35:1465383667412107475>').setStyle(ButtonStyle.Secondary)
      )
    ];
  }
  if (type === 'request') {
    payload.components = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('customroles_request_button').setLabel('طلب رول خاص').setEmoji('<:emoji_20:1465336566384951387>').setStyle(ButtonStyle.Secondary)
      )
    ];
  }

  return payload;
}

async function refreshPanelMessage(guild, guildConfig, type) {
  const channelIdMap = {
    member: guildConfig.memberControlChannelId,
    admin: guildConfig.adminControlChannelId,
    request: guildConfig.requestsChannelId,
    top: guildConfig.topChannelId
  };
  const messageIdMap = {
    member: guildConfig.memberPanelMessageId,
    admin: guildConfig.adminPanelMessageId,
    request: guildConfig.requestPanelMessageId,
    top: guildConfig.topMessageId
  };

  const channelId = channelIdMap[type];
  const messageId = messageIdMap[type];
  if (!channelId || !messageId) return false;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return false;
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) return false;

  const payload = await buildPanelPayload(type, guild, guildConfig);
  await message.edit({ ...payload, attachments: [] }).catch(() => {});
  return true;
}

async function promptForMessage(channel, userId, promptText, interaction) {
  const prompt = interaction
    ? await respondEphemeralWithMessage(interaction, { content: promptText })
    : await channel.send(promptText);
  const collected = await channel.awaitMessages({
    filter: msg => msg.author.id === userId,
    max: 1,
    time: 60000
  });

  const response = collected.first();
  if (prompt && !interaction) scheduleDelete(prompt, 1000);
  if (response) scheduleDelete(response, 1000);

  return response;
}


function normalizeImageUrl(value) {
  if (!value) return null;
  const urlMatch = value.trim().match(/https?:\/\/\S+/i);
  if (!urlMatch) return null;
  const url = urlMatch[0];
  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(url) || url.includes('cdn.discordapp.com');
  return isImage ? url : null;
}

function buildManagersPayload(message, guildConfig, embed, row) {
  const currentRoles = guildConfig?.managerRoleIds || [];
  const currentUsers = guildConfig?.managerUserIds || [];
  const managersEmbed = new EmbedBuilder()
    .setTitle('إدارة المسؤولين')
    .setDescription('تحكم بالرولات والأعضاء المسؤولين مع عرض القائمة الحالية.')
    .addFields(
      { name: 'الرولات', value: currentRoles.length ? currentRoles.map(id => `<@&${id}>`).join('\n') : 'لا يوجد', inline: false },
      { name: 'الأعضاء', value: currentUsers.length ? currentUsers.map(id => `<@${id}>`).join('\n') : 'لا يوجد', inline: false }
    )
    .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
    .setThumbnail(message.client.user.displayAvatarURL({ size: 128 }));

  const roleMenu = new RoleSelectMenuBuilder()
    .setCustomId(`customroles_manager_roles_${message.author.id}`)
    .setPlaceholder('اختر رولات المسؤولين...')
    .setMinValues(0)
    .setMaxValues(10);
  if (currentRoles.length) {
    roleMenu.setDefaultRoles(currentRoles.slice(0, 10));
  }
  const userMenu = new UserSelectMenuBuilder()
    .setCustomId(`customroles_manager_users_${message.author.id}`)
    .setPlaceholder('اختر المسؤولين بالأعضاء...')
    .setMinValues(0)
    .setMaxValues(10);
  if (currentUsers.length) {
    userMenu.setDefaultUsers(currentUsers.slice(0, 10));
  }

  return {
    content: 'اختر رولات/أعضاء المسؤولين (اختر للإضافة وأزل للإزالة):',
    embeds: [managersEmbed],
    components: [
      new ActionRowBuilder().addComponents(roleMenu),
      new ActionRowBuilder().addComponents(userMenu),
      row
    ]
  };
}

function buildChannelsPayload(message, guildConfig, embed, row) {
  const allowed = guildConfig?.allowedChannels || [];
  const blocked = guildConfig?.blockedChannels || [];
  const channelsEmbed = new EmbedBuilder()
    .setTitle(' إدارة الشاتات')
    .setDescription('حدّث الشاتات المسموحة والمحظورة مع عرض الملخص الحالي.')
    .addFields(
      { name: 'روم السجلات', value: guildConfig.logChannelId ? `<#${guildConfig.logChannelId}>` : 'غير محدد', inline: true },
      { name: 'بانل الطلبات', value: guildConfig.requestsChannelId ? `<#${guildConfig.requestsChannelId}>` : 'غير محدد', inline: true },
      { name: 'استقبال الطلبات', value: guildConfig.requestInboxChannelId ? `<#${guildConfig.requestInboxChannelId}>` : 'غير محدد', inline: true },
      { name: 'لوحة الإدارة', value: guildConfig.adminControlChannelId ? `<#${guildConfig.adminControlChannelId}>` : 'غير محدد', inline: true },
      { name: 'لوحة الأعضاء', value: guildConfig.memberControlChannelId ? `<#${guildConfig.memberControlChannelId}>` : 'غير محدد', inline: true },
      { name: 'روم التوب', value: guildConfig.topChannelId ? `<#${guildConfig.topChannelId}>` : 'غير محدد', inline: true },
      { name: 'شاتات مسموح بها', value: formatChannelList(allowed), inline: false },
      { name: 'شاتات محظورة', value: formatChannelList(blocked), inline: false }
    )
    .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
    .setThumbnail(message.client.user.displayAvatarURL({ size: 128 }));

  const allowMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`customroles_manage_allowed_${message.author.id}`)
    .setPlaceholder('الشاتات المسموحة')
    .setMinValues(0)
    .setMaxValues(25)
    .addChannelTypes(ChannelType.GuildText);
  if (allowed.length) {
    allowMenu.setDefaultChannels(allowed.slice(0, 25));
  }
  const logMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`customroles_manage_logs_${message.author.id}`)
    .setPlaceholder('روم السجلات')
    .setMinValues(0)
    .setMaxValues(1)
    .addChannelTypes(ChannelType.GuildText);
  if (guildConfig.logChannelId) {
    logMenu.setDefaultChannels([guildConfig.logChannelId]);
  }
  const clearLogsRow = new ActionRowBuilder().addComponents(

    new ButtonBuilder()

      .setCustomId(`customroles_manage_logs_clear_${message.author.id}`)

      .setLabel('إلغاء السجلات')

      .setStyle(ButtonStyle.Secondary)
      );
  const blockMenu = new ChannelSelectMenuBuilder()
    .setCustomId(`customroles_manage_blocked_${message.author.id}`)
    .setPlaceholder('الشاتات المحظورة')
    .setMinValues(0)
    .setMaxValues(25)
    .addChannelTypes(ChannelType.GuildText);
  if (blocked.length) {
    blockMenu.setDefaultChannels(blocked.slice(0, 25));
  }

  return {
    content: 'حدّد الشاتات المسموحة والمحظورة :',
    embeds: [channelsEmbed],
    components: [
      new ActionRowBuilder().addComponents(logMenu),
      clearLogsRow,
      new ActionRowBuilder().addComponents(allowMenu),
      new ActionRowBuilder().addComponents(blockMenu),
      row
    ]
  };
}

function isDangerousRole(role) {
  if (!role) return true;
  const dangerousPerms = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers'];
  return role.permissions.toArray().some(perm => dangerousPerms.includes(perm));
}

async function sumActivity(userIds, resetDate) {
  if (!userIds || userIds.length === 0) return { voice: 0, messages: 0 };
  const dbManager = getDatabase();
  if (!dbManager || !dbManager.isInitialized) return { voice: 0, messages: 0 };

  const chunkSize = 800;
  let totalVoice = 0;
  let totalMessages = 0;

  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const params = [...chunk];
    let query = `SELECT SUM(voice_time) as voiceTime, SUM(messages) as messages FROM daily_activity WHERE user_id IN (${placeholders})`;
    if (resetDate) {
      query += ' AND date >= ?';
      params.push(resetDate);
    }
    const result = await dbManager.all(query, params);
    totalVoice += result[0]?.voiceTime || 0;
    totalMessages += result[0]?.messages || 0;
  }

  return { voice: totalVoice, messages: totalMessages };
}

async function sendMemberPanel(guild, channel, guildConfig) {
  const permissions = channel.permissionsFor(guild.members.me);
  if (!permissions || !permissions.has(['ViewChannel', 'SendMessages'])) {
    throw new Error('MISSING_CHANNEL_PERMISSION');
  }
  const payload = await buildPanelPayload('member', guild, guildConfig);
  const message = await channel.send(payload);
  updateGuildConfig(guild.id, { memberControlChannelId: channel.id, memberPanelMessageId: message.id });
  startPanelCleanup(guild, channel.id, message.id);
  return message;
}

async function sendAdminPanel(guild, channel, guildConfig) {
  const permissions = channel.permissionsFor(guild.members.me);
  if (!permissions || !permissions.has(['ViewChannel', 'SendMessages'])) {
    throw new Error('MISSING_CHANNEL_PERMISSION');
  }
  const payload = await buildPanelPayload('admin', guild, guildConfig);
  const message = await channel.send(payload);
  updateGuildConfig(guild.id, { adminControlChannelId: channel.id, adminPanelMessageId: message.id });
  startPanelCleanup(guild, channel.id, message.id);
  return message;
}

async function sendRequestPanel(guild, channel, guildConfig) {
  const permissions = channel.permissionsFor(guild.members.me);
  if (!permissions || !permissions.has(['ViewChannel', 'SendMessages'])) {
    throw new Error('MISSING_CHANNEL_PERMISSION');
  }
  const payload = await buildPanelPayload('request', guild, guildConfig);
  const message = await channel.send(payload);
  updateGuildConfig(guild.id, { requestsChannelId: channel.id, requestPanelMessageId: message.id });
  return message;
}

async function sendTopRolesPanel(guild, channel, guildConfig) {
  const permissions = channel.permissionsFor(guild.members.me);
  if (!permissions || !permissions.has(['ViewChannel', 'SendMessages'])) {
    throw new Error('MISSING_CHANNEL_PERMISSION');
  }
  const payload = await buildPanelPayload('top', guild, guildConfig);
  const message = await channel.send(payload);

  updateGuildConfig(guild.id, { topChannelId: channel.id, topMessageId: message.id, topEnabled: true });

  startTopSchedule(guild, channel, message.id);
  startPanelCleanup(guild, channel.id, message.id);
}

async function applyRoleCategoryPosition(role, guildConfig) {
  if (!role || !guildConfig?.roleCategoryId) return;
  const referenceRole = role.guild.roles.cache.get(guildConfig.roleCategoryId);
  if (!referenceRole) return;
  if (!referenceRole.editable) return;
  const desiredPosition = Math.max(1, referenceRole.position - 1);
  if (role.position === desiredPosition) return;
  await role.setPosition(desiredPosition).catch(() => {});
}

async function buildTopRolesEmbed(guild, guildConfig) {
  const roles = getGuildRoles(guild.id);
  const thumbnail = guild?.client?.user?.displayAvatarURL({ size: 128 });

  const ranked = [];
  for (const roleEntry of roles) {
    const role = guild.roles.cache.get(roleEntry.roleId);
    if (!role) continue;
    const members = [...role.members.values()];
    const roleResetDate = getRoleResetDate(guildConfig, roleEntry.roleId);
    const activity = await sumActivity(members.map(member => member.id), roleResetDate);
    ranked.push({
      roleId: roleEntry.roleId,
      name: role.name,
      ownerId: roleEntry.ownerId,
      total: activity.voice + activity.messages,
      voice: activity.voice,
      messages: activity.messages
    });
  }

  ranked.sort((a, b) => b.total - a.total);

  const embed = new EmbedBuilder()
    .setTitle('Top roles')
    .setDescription(ranked.slice(0, 10).map((role, index) => (
      `**#${index + 1} Role : <@&${role.roleId}>\n` +
      ` <:emoji_87:1442988617294413864> <@${role.ownerId}> | <:emoji_85:1442986444712054954> ${role.messages} رسالة | <:emoji_85:1442986413510627530> ${formatDuration(role.voice)}**`
    )).join('\n\n') || '**لا توجد بيانات بعد.**')
    .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
    .setTimestamp()
    .setThumbnail('https://cdn.discordapp.com/attachments/1438625858037350520/1465388834463420550/podium.png?ex=6978ed33&is=69779bb3&hm=b0664dab07584fc960996ee57f2e62285099a951d4c36c4e2f92b0511908b598&');

  return embed;
}

function startTopSchedule(guild, channel, messageId) {
  if (activeTopSchedules.has(guild.id)) {
    clearInterval(activeTopSchedules.get(guild.id));
  }

  const interval = setInterval(async () => {
    const guildConfig = getGuildConfig(guild.id);
    if (!guildConfig.topEnabled) return;
    const payload = await buildPanelPayload('top', guild, guildConfig);

    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) return;
    await message.edit({ ...payload, attachments: [] }).catch(() => {});
  }, 180000);

  activeTopSchedules.set(guild.id, interval);
}

function startPanelCleanup(guild, channelId, keepMessageId) {
  if (!guild || !channelId || !keepMessageId) return;
  const cleanupKey = `${guild.id}:${channelId}`;
  const keepIds = panelCleanupKeepIds.get(cleanupKey) || new Set();
  keepIds.add(keepMessageId);
  panelCleanupKeepIds.set(cleanupKey, keepIds);

  if (activePanelCleanups.has(cleanupKey)) {
    return;
  }

  const interval = setInterval(async () => {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages) return;
    const protectedIds = panelCleanupKeepIds.get(cleanupKey) || new Set();
    const deletable = messages.filter(message => !protectedIds.has(message.id));
    if (deletable.size === 0) return;
    await channel.bulkDelete(deletable, true).catch(() => {});
  }, 180000);

  activePanelCleanups.set(cleanupKey, interval);
}

async function handleAdminRoleControl(message, targetRoleEntry) {
  const role = message.guild.roles.cache.get(targetRoleEntry.roleId);
  const interaction = message.interaction;
  if (!role) {
    deleteRoleEntry(targetRoleEntry.roleId, message.author.id);
    if (interaction) {
      await respondEphemeral(interaction, { content: '**❌ الرول غير موجود. تم إزالة بياناته من القاعدة.**' });
    } else {
      await message.reply('**❌ الرول غير موجود. تم إزالة بياناته من القاعدة.**');
    }
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(' إدارة رول خاص')
    .setDescription(`الاسم : **${role.name}**\nالرول : <@&${role.id}>\nالمالك : <@${targetRoleEntry.ownerId}>`)
    .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
    .setThumbnail(message.client.user.displayAvatarURL({ size: 128 }));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`customroles_admin_delete_${role.id}_${message.author.id}`).setLabel('حذف الرول').setEmoji('<:emoji_21:1465336647477493894>').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`customroles_admin_transfer_${role.id}_${message.author.id}`).setLabel('نقل الملكية').setEmoji('<:emoji_10:1465332029473161350>').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`customroles_admin_remove_${role.id}_${message.author.id}`).setLabel('إزالة من القاعدة').setEmoji('<:emoji_35:1465383704993202452>').setStyle(ButtonStyle.Secondary)
  );

  const controlRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`customroles_admin_action_name_${role.id}_${message.author.id}`).setLabel('تغيير الاسم').setEmoji('<:emoji_14:1465332216375808187>').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`customroles_admin_action_manage_${role.id}_${message.author.id}`).setLabel('إضافة/إزالة').setEmoji('<:emoji_14:1465332188953186453>').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`customroles_admin_action_color_${role.id}_${message.author.id}`).setLabel('تغيير اللون').setEmoji('<:emoji_10:1465332068128002291>').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`customroles_admin_action_icon_${role.id}_${message.author.id}`).setLabel('تغيير الايكون').setEmoji('<:emoji_13:1465332152643092733>').setStyle(ButtonStyle.Secondary)
  );

  const controlRow2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`customroles_admin_action_members_${role.id}_${message.author.id}`).setLabel('الأعضاء').setEmoji('<:emoji_12:1465332124784656446>').setStyle(ButtonStyle.Secondary)
  );

  if (interaction) {
    await respondEphemeralWithMessage(interaction, { embeds: [embed], components: [row, controlRow, controlRow2] });
  } else {
    const sent = await message.channel.send({ embeds: [embed], components: [row, controlRow, controlRow2] });
    scheduleDelete(sent);
  }
}

async function executeRolesSettings(message, args, { client, BOT_OWNERS }) {
  if (isUserBlocked(message.author.id)) return;

  const guildConfig = getGuildConfig(message.guild.id);
  if (!isCustomRolesChannelAllowed(guildConfig, message.channel.id)) {
    await message.reply('**❌ لا يمكن استخدام أوامر الرولات الخاصة في هذا الشات.**').catch(() => {});
    return;
  }
  const hasPermission = isManager(message.member, guildConfig, BOT_OWNERS);
  if (!hasPermission) {
    await message.react('❌').catch(() => {});
    return;
  }

  const roleMention = message.mentions.roles.first();
  const userMention = message.mentions.users.first();
  const idArg = args.find(arg => /^\d{17,19}$/.test(arg));

  if (roleMention || userMention || idArg) {
    let roleId = roleMention?.id || null;
    if (!roleId && idArg) {
      if (getRoleEntry(idArg) || message.guild.roles.cache.has(idArg)) {
        roleId = idArg;
      }
    }
    const targetOwnerId = userMention?.id || (!roleId && idArg ? idArg : null);

    let roleEntry = roleId ? getRoleEntry(roleId) : null;
    if (!roleEntry && targetOwnerId) {
      roleEntry = getGuildRoles(message.guild.id).find(entry => entry.ownerId === targetOwnerId) || null;
    }

    if (!roleEntry && roleId) {
      const role = message.guild.roles.cache.get(roleId);
      if (!role || isDangerousRole(role)) {
        await message.reply('**❌ لا يمكن إضافة هذا الرول ضمن الرولات الخاصة.**');
        return;
      }

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`customroles_add_${roleId}_${message.author.id}`).setLabel('إضافة للقاعدة').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`customroles_add_cancel_${roleId}_${message.author.id}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
      );

      await message.channel.send({ content: '**هذا الرول غير موجود في القاعدة، هل تريد إضافته؟**', components: [confirmRow] });
      return;
    }

    if (!roleEntry) {
      await message.reply('**❌ لم يتم العثور على رول خاص مطابق.**');
      return;
    }

    await handleAdminRoleControl(message, roleEntry);
    return;
  }

  const { embed, row } = buildSettingsMenu(message.author.id, message.client);
  const sentMessage = await message.channel.send({ embeds: [embed], components: [row] });

  const collector = sentMessage.createMessageComponentCollector({
    filter: interaction => interaction.user.id === message.author.id,
    time: 120000
  });

  collector.on('collect', async interaction => {
    if (interaction.isRoleSelectMenu() && interaction.customId === `customroles_manager_roles_${message.author.id}`) {
      updateGuildConfig(message.guild.id, { managerRoleIds: interaction.values });
      const updatedConfig = getGuildConfig(message.guild.id);
      await interaction.update(buildManagersPayload(message, updatedConfig, embed, row));
      return;
    }

    if (interaction.isUserSelectMenu() && interaction.customId === `customroles_manager_users_${message.author.id}`) {
      updateGuildConfig(message.guild.id, { managerUserIds: interaction.values });
      const updatedConfig = getGuildConfig(message.guild.id);
      await interaction.update(buildManagersPayload(message, updatedConfig, embed, row));
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('customroles_send_panel_')) {
      const parts = interaction.customId.split('_');
      const panelType = parts[3];
      const targetUserId = parts[4];
      if (targetUserId !== message.author.id) {
        await interaction.reply({ content: '❌ هذا الزر ليس لك.', ephemeral: true });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`customroles_panel_image_modal_${panelType}_${message.author.id}`)
        .setTitle('إعدادات صورة البانل');
      const imageInput = new TextInputBuilder()
        .setCustomId('panel_image_url')
        .setLabel('رابط صورة البانل (اختياري)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(imageInput));

      if (panelType === 'request') {
        const inboxInput = new TextInputBuilder()
          .setCustomId('panel_inbox_channel')
          .setLabel('ID أو منشن روم الاستقبال')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(inboxInput));
      }

      await interaction.showModal(modal);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('customroles_settings_back_')) {
      const targetUserId = interaction.customId.split('_').pop();
      if (targetUserId !== message.author.id) {
        await interaction.reply({ content: '❌ هذا الزر ليس لك.', ephemeral: true });
        return;
      }
      await interaction.update({ content: null, embeds: [embed], components: [row] });
      return;
    }


    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('customroles_send_panel_channel_')) {
      return;
    }

    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('customroles_manage_allowed_')) {
      const targetUserId = interaction.customId.split('_').pop();
      if (targetUserId !== message.author.id) {
        await interaction.reply({ content: '❌ هذا الخيار ليس لك.', ephemeral: true });
        return;
      }
      updateGuildConfig(message.guild.id, { allowedChannels: normalizeUniqueIds(interaction.values) });
      const updatedConfig = getGuildConfig(message.guild.id);
      await interaction.update(buildChannelsPayload(message, updatedConfig, embed, row));
      return;
    }

    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('customroles_manage_logs_')) {
      const targetUserId = interaction.customId.split('_').pop();
      if (targetUserId !== message.author.id) {
        await interaction.reply({ content: '❌ هذا الخيار ليس لك.', ephemeral: true });
        return;
      }
      const logChannelId = interaction.values[0] || null;
      updateGuildConfig(message.guild.id, { logChannelId });
      const updatedConfig = getGuildConfig(message.guild.id);
      await interaction.update(buildChannelsPayload(message, updatedConfig, embed, row));
      return;
    }

    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('customroles_manage_blocked_')) {
      const targetUserId = interaction.customId.split('_').pop();
      if (targetUserId !== message.author.id) {
        await interaction.reply({ content: '❌ هذا الخيار ليس لك.', ephemeral: true });
        return;
      }
      updateGuildConfig(message.guild.id, { blockedChannels: normalizeUniqueIds(interaction.values) });
      const updatedConfig = getGuildConfig(message.guild.id);
      await interaction.update(buildChannelsPayload(message, updatedConfig, embed, row));
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('customroles_manage_logs_clear_')) {
      const targetUserId = interaction.customId.split('_').pop();
      if (targetUserId !== message.author.id) {
        await interaction.reply({ content: '❌ هذا الزر ليس لك.', ephemeral: true });
        return;
      }
      updateGuildConfig(message.guild.id, { logChannelId: null });
      const updatedConfig = getGuildConfig(message.guild.id);
      await interaction.update(buildChannelsPayload(message, updatedConfig, embed, row));
      return;
    }


    if (!interaction.isStringSelectMenu()) return;

    const selection = interaction.values[0];
    if (selection === 'managers') {
      await interaction.update(buildManagersPayload(message, guildConfig, embed, row));
      return;
    }

    if (selection === 'channels') {
      await interaction.update(buildChannelsPayload(message, guildConfig, embed, row));
      return;
    }

    if (selection === 'send_panels') {
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`customroles_send_panel_member_${message.author.id}`).setLabel('لوحة الأعضاء').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`customroles_send_panel_admin_${message.author.id}`).setLabel('لوحة الإدارة').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`customroles_send_panel_request_${message.author.id}`).setLabel('لوحة الطلبات').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`customroles_send_panel_top_${message.author.id}`).setLabel('لوحة التوب').setStyle(ButtonStyle.Secondary)
      );
      const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`customroles_settings_back_${message.author.id}`).setLabel('رجوع').setStyle(ButtonStyle.Secondary)
      );
      await interaction.update({
        content: 'اختر البانل التي تريد إرسالها :',
        embeds: [],
        components: [buttons, backRow]
      });
      return;
    }

    if (selection === 'reset_activity') {
      updateGuildConfig(message.guild.id, { activityResetAt: Date.now() });
      await interaction.update({ content: '✅ تم تصفير تفاعل الرولات الخاصة.', embeds: [embed], components: [row] });
      return;
    }

    if (selection === 'system_summary') {
      const rolesCount = getGuildRoles(message.guild.id).length;
      const summaryEmbed = new EmbedBuilder()
        .setTitle('🧾 ملخص حالة النظام')
        .setDescription('ملخص سريع لحالة الرولات الخاصة والإعدادات.')
        .addFields(
          { name: 'عدد الرولات الخاصة', value: `${rolesCount}`, inline: true },
          { name: 'عدد المسؤولين', value: `${(guildConfig.managerRoleIds || []).length + (guildConfig.managerUserIds || []).length}`, inline: true },
          { name: 'التوب', value: guildConfig.topEnabled ? 'مفعل' : 'غير مفعل', inline: true },
          { name: 'ترتيب الرولات الجديدة', value: guildConfig.roleCategoryId ? `<@&${guildConfig.roleCategoryId}>` : 'غير محدد', inline: true },
          { name: 'لوحة الطلبات', value: guildConfig.requestsChannelId ? `<#${guildConfig.requestsChannelId}>` : 'غير محدد', inline: true },
          { name: 'لوحة الإدارة', value: guildConfig.adminControlChannelId ? `<#${guildConfig.adminControlChannelId}>` : 'غير محدد', inline: true },
          { name: 'لوحة الأعضاء', value: guildConfig.memberControlChannelId ? `<#${guildConfig.memberControlChannelId}>` : 'غير محدد', inline: true }
        )
        .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
        .setThumbnail(message.client.user.displayAvatarURL({ size: 128 }));
      await interaction.update({ embeds: [summaryEmbed], components: [row] });
      return;
    }

    if (selection === 'role_category') {
      const roleMenu = new RoleSelectMenuBuilder()
        .setCustomId(`customroles_role_category_${message.author.id}`)
        .setPlaceholder('اختر رول الترتيب...')
        .setMinValues(1)
        .setMaxValues(1);
      if (guildConfig.roleCategoryId) {
        roleMenu.setDefaultRoles([guildConfig.roleCategoryId]);
      }
      const clearRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`customroles_role_category_clear_${message.author.id}`)
          .setLabel('إلغاء الترتيب')
          .setStyle(ButtonStyle.Secondary)
      );
      await interaction.update({
        content: 'اختر رولًا يكون كل رول جديد تحته:',
        embeds: [],
        components: [new ActionRowBuilder().addComponents(roleMenu), clearRow]
      });
      return;
    }

    if (selection === 'top_roles') {
      updateGuildConfig(message.guild.id, { topEnabled: true });
      await interaction.update({ content: '✅ تم تفعيل التوب.', embeds: [embed], components: [row] });
      return;
    }
  });
}

async function handleCustomRolesInteraction(interaction, client, BOT_OWNERS) {
  if (interaction.replied || interaction.deferred) return;

  const guildConfig = interaction.guild ? getGuildConfig(interaction.guild.id) : null;
  const isAdminUser = guildConfig ? isManager(interaction.member, guildConfig, BOT_OWNERS) : false;
  if (interaction.channelId && !isCustomRolesChannelAllowed(guildConfig, interaction.channelId)) {
    await interaction.reply({ content: '❌ لا يمكن استخدام أوامر الرولات الخاصة في هذا الشات.', ephemeral: true }).catch(() => {});
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('customroles_panel_image_modal_')) {
    const parts = interaction.customId.split('_');
    const panelType = parts[4];
    const targetUserId = parts[5];
    if (targetUserId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا النموذج ليس لك.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const rawImageUrl = interaction.fields.getTextInputValue('panel_image_url');
    const imageUrl = normalizeImageUrl(rawImageUrl);
    if (rawImageUrl && !imageUrl) {
      await interaction.editReply({ content: '❌ رابط الصورة غير صالح.' });
      return;
    }
    let inboxChannelId = null;
    if (panelType === 'request') {
      const inboxRaw = interaction.fields.getTextInputValue('panel_inbox_channel');
      const channelId = inboxRaw.match(/\d{17,19}/)?.[0];
      const inboxChannel = channelId ? await interaction.guild.channels.fetch(channelId).catch(() => null) : null;
      if (!inboxChannel || inboxChannel.type !== ChannelType.GuildText) {
        await interaction.editReply({ content: '❌ الشات المحدد غير صالح. اختر روم كتابي.' });
        return;
      }
      inboxChannelId = inboxChannel.id;
    }

    const pendingKey = `${interaction.guild.id}:${interaction.user.id}`;
    pendingPanelSetup.set(pendingKey, {
      panelType,
      imageUrl,
      inboxChannelId
    });
    if (pendingPanelTimeouts.has(pendingKey)) {
      clearTimeout(pendingPanelTimeouts.get(pendingKey));
    }
    pendingPanelTimeouts.set(pendingKey, setTimeout(() => {
      pendingPanelSetup.delete(pendingKey);
      pendingPanelTimeouts.delete(pendingKey);
    }, 120000));

    const channelMenu = new ChannelSelectMenuBuilder()
      .setCustomId(`customroles_send_panel_channel_${panelType}_${interaction.user.id}`)
      .setPlaceholder('اختر الروم...')
      .setMinValues(1)
      .setMaxValues(1)
      .addChannelTypes(ChannelType.GuildText);
    await interaction.editReply({
      content: 'اختر الروم المطلوب لإرسال اللوحة:',
      components: [new ActionRowBuilder().addComponents(channelMenu)]
    });
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('customroles_search_modal_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    const parts = interaction.customId.split('_');
    const action = parts[3];
    const requesterId = parts[4];
    if (requesterId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا النموذج ليس لك.', ephemeral: true });
      return;
    }
    const query = interaction.fields.getTextInputValue('customroles_search_query')?.trim() || '';
    if (!query) {
      await interaction.reply({ content: '❌ أدخل قيمة بحث صالحة.', ephemeral: true });
      return;
    }
    if (action === 'bulkdelete') {
      const roleMenu = buildAdminBulkDeleteMenu(interaction.user.id, interaction.guild, query);
      if (!roleMenu) {
        await interaction.reply({ content: '❌ لا توجد رولات مطابقة للبحث.', ephemeral: true });
        return;
      }
      await interaction.reply({
        content: 'اختر الرولات المطلوب حذفها:',
        components: [roleMenu],
        ephemeral: true
      });
      return;
    }

    const roleMenu = buildAdminRoleMenu(action, interaction.user.id, interaction.guild, query);
    if (!roleMenu) {
      await interaction.reply({ content: '❌ لا توجد رولات مطابقة للبحث.', ephemeral: true });
      return;
    }
    await interaction.reply({
      content: 'اختر رولاً خاصاً:',
      components: [roleMenu],
      ephemeral: true
    });
    return;
  }

  if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('customroles_send_panel_channel_')) {
    const payload = interaction.customId.replace('customroles_send_panel_channel_', '');
    const parts = payload.split('_');
    const panelType = parts[0];
    const targetUserId = parts[1];
    if (targetUserId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا الخيار ليس لك.', ephemeral: true });
      return;
    }
    await interaction.deferUpdate().catch(() => {});
    const pendingKey = `${interaction.guild.id}:${interaction.user.id}`;
    const pendingData = pendingPanelSetup.get(pendingKey);
    if (!pendingData || pendingData.panelType !== panelType) {
      await interaction.editReply({ content: '❌ لم يتم العثور على بيانات اللوحة. أعد المحاولة.', components: [] }).catch(() => {});
      return;
    }
    const channelId = interaction.values[0];
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      await interaction.editReply({ content: '❌ لم يتم العثور على الروم.', components: [] }).catch(() => {});
      return;
    }

    const guildConfig = getGuildConfig(interaction.guild.id);
    if (pendingData.imageUrl) {
      if (panelType === 'member') updateGuildConfig(interaction.guild.id, { memberImage: pendingData.imageUrl });
      if (panelType === 'admin') updateGuildConfig(interaction.guild.id, { adminImage: pendingData.imageUrl });
      if (panelType === 'request') updateGuildConfig(interaction.guild.id, { requestImage: pendingData.imageUrl });
      if (panelType === 'top') updateGuildConfig(interaction.guild.id, { topImage: pendingData.imageUrl });
    }
    if (panelType === 'request' && pendingData.inboxChannelId) {
      updateGuildConfig(interaction.guild.id, { requestInboxChannelId: pendingData.inboxChannelId });
    }
    try {
      if (panelType === 'member') {
        await sendMemberPanel(interaction.guild, channel, guildConfig);
      }
      if (panelType === 'admin') {
        await sendAdminPanel(interaction.guild, channel, guildConfig);
      }
      if (panelType === 'request') {
        await sendRequestPanel(interaction.guild, channel, guildConfig);
      }
      if (panelType === 'top') {
        await sendTopRolesPanel(interaction.guild, channel, guildConfig);
      }
    } catch (error) {
      const message = error.message === 'MISSING_CHANNEL_PERMISSION'
        ? '❌ البوت لا يملك صلاحية عرض/إرسال رسائل في هذا الروم.'
        : '❌ حدث خطأ أثناء إرسال اللوحة.';
      await interaction.editReply({ content: message, components: [] }).catch(() => {});
      return;
    }

    pendingPanelSetup.delete(pendingKey);
    if (pendingPanelTimeouts.has(pendingKey)) {
      clearTimeout(pendingPanelTimeouts.get(pendingKey));
      pendingPanelTimeouts.delete(pendingKey);
    }
    await interaction.editReply({ content: '✅ تم إرسال اللوحة بنجاح.', components: [] }).catch(() => {});
    await logRoleAction(interaction.guild, guildConfig, 'تم إرسال لوحة رولات خاصة.', [
      { name: 'اللوحة', value: panelType, inline: true },
      { name: 'الروم', value: `<#${channelId}>`, inline: true },
      { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
    ]);
    return;
  }

  if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('customroles_role_category_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    const targetUserId = interaction.customId.split('_').pop();
    if (targetUserId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا الاختيار ليس لك.', ephemeral: true });
      return;
    }
    const roleId = interaction.values[0];
    updateGuildConfig(interaction.guild.id, { roleCategoryId: roleId });
    await interaction.update({
      content: `✅ تم ضبط ترتيب الرولات الجديدة تحت <@&${roleId}>.`,
      components: []
    });
    return;
  }

  if (interaction.customId.startsWith('customroles_role_category_clear_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    const targetUserId = interaction.customId.split('_').pop();
    if (targetUserId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا الزر ليس لك.', ephemeral: true });
      return;
    }
    updateGuildConfig(interaction.guild.id, { roleCategoryId: null });
    await interaction.update({ content: '✅ تم إلغاء ترتيب الرولات الجديدة.', components: [] });
    return;
  }

  if (interaction.customId.startsWith('customroles_member_action_')) {
    const action = interaction.customId.replace('customroles_member_action_', '');
    await myRoleCommand.handleMemberAction(interaction, action, client);
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('customroles_admin_panel_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    const action = interaction.customId.replace('customroles_admin_panel_', '');

    if (action === 'create') {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
      }
      const fakeMessage = {
        author: interaction.user,
        member: interaction.member,
        guild: interaction.guild,
        channel: interaction.channel,
        client: interaction.client
      };
      await sroleCommand.startCreateFlow({ message: fakeMessage, args: [], client, BOT_OWNERS, interaction });
      return;
    }

    if (action === 'reset_all') {
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`customroles_reset_all_confirm_${interaction.user.id}`).setLabel('تأكيد التصفير').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`customroles_reset_all_cancel_${interaction.user.id}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
      );
      await interaction.reply({
        content: 'هل أنت متأكد من تصفير تفاعل جميع الرولات؟',
        components: [confirmRow],
        ephemeral: true
      });
      return;
    }

    if (action === 'delete') {
      const roleMenu = buildAdminBulkDeleteMenu(interaction.user.id, interaction.guild);
      if (!roleMenu) {
        await interaction.reply({ content: '❌ لا توجد رولات خاصة مسجلة حالياً.', ephemeral: true });
        return;
      }
      await interaction.reply({
        content: 'اختر الرولات المطلوب حذفها:',
        components: [roleMenu],
        ephemeral: true
      });
      return;
    }

    if (action === 'add') {
      const roleMenu = new RoleSelectMenuBuilder()
        .setCustomId(`customroles_admin_rolepicker_add_${interaction.user.id}`)
        .setPlaceholder('اختر رولاً لإضافته...')
        .setMinValues(1)
        .setMaxValues(5);
      await interaction.reply({
        content: 'اختر الرول المطلوب إضافته:',
        components: [new ActionRowBuilder().addComponents(roleMenu)],
        ephemeral: true
      });
      return;
    }

    await showCustomRoleSearchModal(interaction, action);
    return;
  }

  if (interaction.customId.startsWith('customroles_owner_left_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    const parts = interaction.customId.split('_');
    const action = parts[3];
    const roleId = parts[4];
    const ownerId = parts[5];
    const roleEntry = getRoleEntry(roleId);
    if (!roleEntry) {
      await interaction.message.edit({
        embeds: [buildAdminSummaryEmbed('❌ لم يتم العثور على الرول.', [
          { name: 'الرول', value: `<@&${roleId}>`, inline: true }
        ])],
        components: []
      }).catch(() => {});
      return;
    }

    if (action === 'keep') {
      await interaction.message.edit({
        embeds: [buildAdminSummaryEmbed('✅ تم إلغاء الإجراء.', [
          { name: 'الرول', value: `<@&${roleId}>`, inline: true },
          { name: 'المالك', value: `<@${ownerId}>`, inline: true }
        ])],
        components: []
      }).catch(() => {});
      return;
    }

    if (action === 'delete') {
      const role = interaction.guild.roles.cache.get(roleId);
      if (role && !role.editable) {
        await interaction.message.edit({
          embeds: [buildAdminSummaryEmbed('❌ لا يمكن حذف الرول بسبب صلاحيات البوت.', [
            { name: 'الرول', value: `<@&${roleId}>`, inline: true }
          ])],
          components: []
        }).catch(() => {});
        return;
      }
      if (role) {
        await role.delete(`حذف رول خاص بعد مغادرة المالك ${ownerId}`).catch(() => {});
      }
      deleteRoleEntry(roleId, interaction.user.id);
      await interaction.client.users.fetch(ownerId)
        .then(user => user.send('🗑️ تم حذف رولك الخاص بعد مغادرتك السيرفر.').catch(() => {}))
        .catch(() => {});
      await interaction.message.edit({
        embeds: [buildAdminSummaryEmbed('✅ تم حذف الرول.', [
          { name: 'الرول', value: `<@&${roleId}>`, inline: true },
          { name: 'المالك', value: `<@${ownerId}>`, inline: true },
          { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
        ])],
        components: []
      }).catch(() => {});
      await logRoleAction(interaction.guild, getGuildConfig(interaction.guild.id), 'تم حذف رول خاص بعد مغادرة المالك.', [
        { name: 'الرول', value: `<@&${roleId}>`, inline: true },
        { name: 'المالك', value: `<@${ownerId}>`, inline: true },
        { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
      ]);
      return;
    }
  }


  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('customroles_admin_panel_select_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    const payload = interaction.customId.replace('customroles_admin_panel_select_', '');
    const lastUnderscore = payload.lastIndexOf('_');
    const action = payload.slice(0, lastUnderscore);
    const requesterId = payload.slice(lastUnderscore + 1);
    if (requesterId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا الاختيار ليس لك.', ephemeral: true });
      return;
    }
    const roleId = interaction.values[0];
    if (roleId === 'search') {
      await showCustomRoleSearchModal(interaction, action);
      return;
    }
    await interaction.deferReply({ ephemeral: true });

    if (action === 'add') {
      const roleEntry = getRoleEntry(roleId);
      if (roleEntry) {
        await handleAdminRoleControl(buildInteractionMessage(interaction), roleEntry);
        await interaction.editReply({
          embeds: [buildAdminSummaryEmbed('✅ تم عرض لوحة التحكم.', [
            { name: 'الرول', value: `<@&${roleId}>`, inline: true },
            { name: 'المالك', value: `<@${roleEntry.ownerId}>`, inline: true }
          ])]
        });
        return;
      }

      const role = interaction.guild.roles.cache.get(roleId);
      if (!role || isDangerousRole(role)) {
        await interaction.editReply({ content: '❌ لا يمكن إضافة هذا الرول ضمن الرولات الخاصة.' });
        return;
      }

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`customroles_add_${roleId}_${interaction.user.id}`).setLabel('إضافة للقاعدة').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`customroles_add_cancel_${roleId}_${interaction.user.id}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
      );
      await interaction.editReply({ content: 'هذا الرول غير موجود في القاعدة، هل تريد إضافته؟', components: [confirmRow] });
      return;
    }

    if (action === 'delete') {
      const roleEntry = getRoleEntry(roleId);
      if (!roleEntry) {
        await interaction.editReply({ content: '❌ هذا الرول غير مسجل كرول خاص.' });
        return;
      }
      await handleAdminRoleControl(buildInteractionMessage(interaction), roleEntry);
      await interaction.editReply({
        embeds: [buildAdminSummaryEmbed('✅ تم عرض لوحة التحكم.', [
          { name: 'الرول', value: `<@&${roleId}>`, inline: true },
          { name: 'المالك', value: `<@${roleEntry.ownerId}>`, inline: true }
        ])]
      });
      return;
    }

    if (action === 'info') {
      const roleEntry = getRoleEntry(roleId);
      if (!roleEntry) {
        await interaction.editReply({ content: '❌ هذا الرول غير مسجل كرول خاص.' });
        return;
      }
      const infoMessage = await listCommand.renderRoleDetails({ guild: interaction.guild, channel: interaction.channel, client: interaction.client }, roleEntry);
      scheduleDelete(infoMessage);
      await interaction.editReply({
        embeds: [buildAdminSummaryEmbed('✅ تم إرسال المعلومات.', [
          { name: 'الرول', value: `<@&${roleId}>`, inline: true },
          { name: 'المالك', value: `<@${roleEntry.ownerId}>`, inline: true }
        ])]
      });
      await logRoleAction(interaction.guild, getGuildConfig(interaction.guild.id), 'تم طلب معلومات رول خاص.', [
        { name: 'الرول', value: `<@&${roleId}>`, inline: true },
        { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
      ]);
      return;
    }

    if (action === 'reset_role') {
      const roleEntry = getRoleEntry(roleId);
      if (!roleEntry) {
        await interaction.editReply({ content: '❌ هذا الرول غير مسجل كرول خاص.' });
        return;
      }
      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`customroles_reset_role_confirm_${roleId}_${interaction.user.id}`).setLabel('تأكيد التصفير').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`customroles_reset_role_cancel_${roleId}_${interaction.user.id}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
      );
      await interaction.editReply({
        content: 'هل أنت متأكد من تصفير تفاعل هذا الرول؟',
        components: [confirmRow]
      });
      return;
    }

    if (action === 'manage') {
      const roleEntry = getRoleEntry(roleId);
      if (!roleEntry) {
        await interaction.editReply({ content: '❌ هذا الرول غير مسجل كرول خاص.' });
        return;
      }
      await handleAdminRoleControl(buildInteractionMessage(interaction), roleEntry);
      await interaction.editReply({
        embeds: [buildAdminSummaryEmbed('✅ تم إرسال لوحة التحكم.', [
          { name: 'الرول', value: `<@&${roleId}>`, inline: true },
          { name: 'المالك', value: `<@${roleEntry.ownerId}>`, inline: true }
        ])]
      });
      return;
    }

    await interaction.editReply({ content: '❌ خيار غير معروف.' });
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('customroles_admin_bulkdelete_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    const targetUserId = interaction.customId.split('_').pop();
    if (targetUserId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا الاختيار ليس لك.', ephemeral: true });
      return;
    }
    if (interaction.values.includes('search')) {
      if (interaction.values.length > 1) {
        await interaction.reply({ content: '⚠️ اختر زر البحث وحده بدون تحديد رولات أخرى.', ephemeral: true });
        return;
      }
      await showCustomRoleSearchModal(interaction, 'bulkdelete');
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const roleIds = interaction.values;
    const summaryLines = [];
    const embed = new EmbedBuilder()
      .setTitle('🗑️ تأكيد حذف الرولات')
      .setDescription('اسم الرول - منشن المالك\n**عدد الأعضاء:**')
      .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136');

    for (const roleId of roleIds) {
      const roleEntry = getRoleEntry(roleId);
      const role = interaction.guild.roles.cache.get(roleId);
      if (!roleEntry || !role) continue;
      const ownerLine = `<@${roleEntry.ownerId}>`;
      const membersCount = role.members.size;
      embed.addFields({
        name: `${role.name} - ${ownerLine}`,
        value: `عدد الأعضاء: ${membersCount}`,
        inline: false
      });
      summaryLines.push(roleId);
    }

    if (!summaryLines.length) {
      await interaction.editReply({ content: '❌ لم يتم العثور على رولات صالحة للحذف.' });
      return;
    }

    const sessionId = `${interaction.user.id}_${Date.now()}`;
    pendingBulkDeletes.set(sessionId, {
      roleIds: summaryLines,
      requestedBy: interaction.user.id,
      guildId: interaction.guild.id
    });
    setTimeout(() => pendingBulkDeletes.delete(sessionId), 120000);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`customroles_bulkdelete_confirm_${sessionId}`).setLabel('تأكيد الحذف').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`customroles_bulkdelete_cancel_${sessionId}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary)
    );
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  if (interaction.customId.startsWith('customroles_bulkdelete_confirm_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    const sessionId = interaction.customId.replace('customroles_bulkdelete_confirm_', '');
    const pending = pendingBulkDeletes.get(sessionId);
    if (!pending || pending.requestedBy !== interaction.user.id) {
      await interaction.editReply({ content: '❌ انتهت صلاحية العملية أو ليست لك.', components: [] }).catch(() => {});
      return;
    }

    let deletedCount = 0;
    for (const roleId of pending.roleIds) {
      const roleEntry = getRoleEntry(roleId);
      const role = interaction.guild.roles.cache.get(roleId);
      if (role) {
        if (!role.editable) continue;
        await role.delete(`حذف عدة رولات بواسطة ${interaction.user.tag}`).catch(() => {});
      }
      if (roleEntry) {
        deleteRoleEntry(roleId, interaction.user.id);
        deletedCount += 1;
      }
    }
    pendingBulkDeletes.delete(sessionId);
    await interaction.editReply({
      embeds: [buildAdminSummaryEmbed('✅ تم حذف الرولات المحددة.', [
        { name: 'عدد الرولات', value: `${deletedCount}`, inline: true },
        { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
      ])],
      components: []
    }).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('customroles_reset_all_confirm_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    const requesterId = interaction.customId.split('_').pop();
    if (requesterId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا الزر ليس لك.', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    updateGuildConfig(interaction.guild.id, { activityResetAt: Date.now() });
    await interaction.editReply({
      embeds: [buildAdminSummaryEmbed('✅ تم تصفير التفاعل بالكامل.', [
        { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
      ])],
      components: []
    });
    await logRoleAction(interaction.guild, guildConfig, 'تم تصفير تفاعل جميع الرولات الخاصة.', [
      { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
    ]);
    return;
  }

  if (interaction.customId.startsWith('customroles_reset_all_cancel_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    const requesterId = interaction.customId.split('_').pop();
    if (requesterId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا الزر ليس لك.', ephemeral: true });
      return;
    }
    await interaction.update({ content: 'تم إلغاء التصفير.', components: [] }).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('customroles_reset_role_confirm_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    const parts = interaction.customId.split('_');
    const roleId = parts[4];
    const requesterId = parts[5];
    if (requesterId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا الزر ليس لك.', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    const roleEntry = getRoleEntry(roleId);
    if (!roleEntry) {
      await interaction.editReply({ content: '❌ هذا الرول غير مسجل كرول خاص.', components: [] }).catch(() => {});
      return;
    }
    const currentConfig = getGuildConfig(interaction.guild.id);
    currentConfig.roleActivityResetAt = currentConfig.roleActivityResetAt || {};
    currentConfig.roleActivityResetAt[roleId] = Date.now();
    updateGuildConfig(interaction.guild.id, { roleActivityResetAt: currentConfig.roleActivityResetAt });
    await interaction.editReply({
      embeds: [buildAdminSummaryEmbed('✅ تم تصفير تفاعل الرول.', [
        { name: 'الرول', value: `<@&${roleId}>`, inline: true },
        { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
      ])],
      components: []
    }).catch(() => {});
    await logRoleAction(interaction.guild, currentConfig, 'تم تصفير تفاعل رول خاص.', [
      { name: 'الرول', value: `<@&${roleId}>`, inline: true },
      { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
    ]);
    return;
  }

  if (interaction.customId.startsWith('customroles_reset_role_cancel_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    const requesterId = interaction.customId.split('_').pop();
    if (requesterId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا الزر ليس لك.', ephemeral: true });
      return;
    }
    await interaction.update({ content: 'تم إلغاء التصفير.', components: [] }).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('customroles_bulkdelete_cancel_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    const sessionId = interaction.customId.replace('customroles_bulkdelete_cancel_', '');
    pendingBulkDeletes.delete(sessionId);
    await interaction.editReply({ content: 'تم إلغاء الحذف.', components: [] }).catch(() => {});
    return;
  }
  if (interaction.customId.startsWith('customroles_admin_action_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    const parts = interaction.customId.split('_');
    const action = parts[3];
    const roleId = parts[4];
    const requesterId = parts[5];
    if (requesterId && requesterId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا الزر ليس لك.', ephemeral: true });
      return;
    }
    const roleEntry = getRoleEntry(roleId);
    if (!roleEntry) {
      await interaction.reply({ content: '❌ هذا الرول غير مسجل كرول خاص.', ephemeral: true });
      return;
    }
    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) {
      await interaction.reply({ content: '❌ لم يتم العثور على الرول في السيرفر.', ephemeral: true });
      return;
    }
    await myRoleCommand.runRoleAction({ interaction, action, roleEntry, role, panelMessage: interaction.message });
    return;
  }

  if (interaction.customId === 'customroles_admin_manage') {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    const roleMenu = buildAdminRoleMenu('manage', interaction.user.id, interaction.guild);
    if (!roleMenu) {
      await interaction.reply({ content: '❌ لا توجد رولات خاصة مسجلة حالياً.', ephemeral: true });
      return;
    }
    await interaction.reply({
      content: 'اختر الرول المطلوب لإدارته:',
      components: [roleMenu],
      ephemeral: true
    });
    return;
  }

  if (interaction.customId === 'customroles_admin_restore') {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const deleted = getRestorableDeletedRoles(interaction.guild.id);
    if (deleted.length === 0) {
      await interaction.editReply({ content: '❌ لا توجد رولات محذوفة.' });
      return;
    }
    const sessionId = `${interaction.user.id}-${Date.now().toString(36)}`;
    restoreSessions.set(sessionId, {
      guildId: interaction.guild.id,
      userId: interaction.user.id,
      page: 0,
      updatedAt: Date.now()
    });
    const render = buildRestoreComponents(sessionId, interaction.user.id, deleted, 0);
    await interaction.editReply({ content: render.content, components: render.components });
    return;
  }

  if (interaction.customId.startsWith('customroles_restore_prev_') || interaction.customId.startsWith('customroles_restore_next_')) {
    const isNext = interaction.customId.startsWith('customroles_restore_next_');
    const sessionId = interaction.customId.replace(isNext ? 'customroles_restore_next_' : 'customroles_restore_prev_', '');
    const session = restoreSessions.get(sessionId);
    if (!session) {
      await interaction.reply({ content: '❌ انتهت الجلسة، أعد فتح قائمة الاسترجاع.', ephemeral: true });
      return;
    }
    if (session.userId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا الزر ليس لك.', ephemeral: true });
      return;
    }

    await interaction.deferUpdate();
    const deleted = getRestorableDeletedRoles(session.guildId);
    if (!deleted.length) {
      restoreSessions.delete(sessionId);
      await interaction.editReply({ content: '❌ لا توجد رولات محذوفة حالياً.', components: [] });
      return;
    }

    const nextPage = isNext ? session.page + 1 : session.page - 1;
    const render = buildRestoreComponents(sessionId, session.userId, deleted, nextPage);
    session.page = render.page;
    session.updatedAt = Date.now();
    restoreSessions.set(sessionId, session);
    await interaction.editReply({ content: render.content, components: render.components });
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('customroles_restore_select_')) {
    const match = interaction.customId.match(/^customroles_restore_select_(\d+)_(.+)$/);
    if (!match) {
      await interaction.reply({ content: '❌ معرف الاسترجاع غير صالح.', ephemeral: true });
      return;
    }
    const targetUserId = match[1];
    const sessionId = match[2];
    const session = restoreSessions.get(sessionId);
    if (!session) {
      await interaction.reply({ content: '❌ انتهت الجلسة، أعد فتح قائمة الاسترجاع.', ephemeral: true });
      return;
    }
    if (targetUserId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا الاختيار ليس لك.', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    const roleId = interaction.values[0];
    const validDeletedRoles = getRestorableDeletedRoles(session.guildId);
    const stillValid = validDeletedRoles.some(entry => entry.roleId === roleId);
    if (!stillValid) {
      if (!validDeletedRoles.length) {
        restoreSessions.delete(sessionId);
        await interaction.editReply({ content: '❌ لا توجد رولات محذوفة حالياً.', components: [] });
        return;
      }
      const render = buildRestoreComponents(sessionId, session.userId, validDeletedRoles, session.page);
      session.page = render.page || 0;
      restoreSessions.set(sessionId, session);
      await interaction.editReply({ content: '⚠️ تم تحديث القائمة، اختر أحدث رول مفقود للمالك.', components: render.components });
      return;
    }

    const existingRole = interaction.guild.roles.cache.get(roleId);
    if (existingRole) {
      const existingEntry = getDeletedRoleEntry(roleId);
      const ownerHasRole = existingEntry?.ownerId
        ? findRoleByOwner(interaction.guild.id, existingEntry.ownerId)
        : null;
      if (ownerHasRole) {
        await interaction.editReply({ content: '❌ مالك الرول لديه رول خاص بالفعل.', components: [] });
        return;
      }
      const restored = restoreRoleEntry(roleId);
      if (restored) {
        restored.updatedAt = Date.now();
        addRoleEntry(roleId, restored);
        restoreSessions.delete(sessionId);
        await interaction.editReply({
          embeds: [buildAdminSummaryEmbed('✅ تم استرجاع الرول.', [
            { name: 'الرول', value: `<@&${roleId}>`, inline: true },
            { name: 'المالك', value: `<@${restored.ownerId}>`, inline: true }
          ])],
          components: []
        });
        await logRoleAction(interaction.guild, getGuildConfig(interaction.guild.id), 'تم استرجاع رول خاص من المحذوفات.', [
          { name: 'الرول', value: `<@&${roleId}>`, inline: true },
          { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
        ]);
      } else {
        await interaction.editReply({ content: '❌ تعذر استرجاع الرول.', components: [] });
      }
      return;
    }

    const deletedEntry = getDeletedRoleEntry(roleId);
    if (!deletedEntry) {
      await interaction.editReply({ content: '❌ تعذر استرجاع الرول.', components: [] });
      return;
    }
    const ownerHasRole = deletedEntry.ownerId
      ? findRoleByOwner(interaction.guild.id, deletedEntry.ownerId)
      : null;
    if (ownerHasRole) {
      await interaction.editReply({ content: '❌ مالك الرول لديه رول خاص بالفعل.', components: [] });
      return;
    }

    const createdRole = await interaction.guild.roles.create({
      name: deletedEntry.name || `role-${interaction.user.username}`,
      color: deletedEntry.color || undefined,
      permissions: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
      reason: `استرجاع رول خاص محذوف بواسطة ${interaction.user.tag}`
    }).catch(() => null);

    if (!createdRole) {
      await interaction.editReply({ content: '❌ فشل إنشاء الرول. تحقق من الصلاحيات.', components: [] });
      return;
    }
    await applyRoleCategoryPosition(createdRole, getGuildConfig(interaction.guild.id));

    let finalRole = createdRole;
    if (deletedEntry.icon) {
      try {
        const buffer = await resolveIconBuffer(deletedEntry.icon);
        if (buffer) {
          finalRole = await applyRoleIcon(createdRole, buffer);
        }
      } catch (error) {
        console.error('❌ فشل استرجاع أيقونة الرول:', error);
      }
    }

    const memberIds = deletedEntry.memberMeta ? Object.keys(deletedEntry.memberMeta) : [];
    const restoredMemberMeta = { ...(deletedEntry.memberMeta || {}) };
    for (const memberId of memberIds) {
      const member = await interaction.guild.members.fetch(memberId).catch(() => null);
      if (!member) continue;
      await member.roles.add(finalRole, 'استرجاع رول خاص محذوف').catch(() => {});
      restoredMemberMeta[memberId] = {
        ...(restoredMemberMeta[memberId] || {}),
        assignedAt: Date.now(),
        assignedBy: interaction.user.id,
        assignedByIsBot: interaction.user.bot
      };
    }

    addRoleEntry(finalRole.id, {
      ...deletedEntry,
      roleId: finalRole.id,
      guildId: interaction.guild.id,
      name: finalRole.name,
      color: finalRole.hexColor,
      icon: finalRole.iconURL(),
      updatedAt: Date.now(),
      memberMeta: restoredMemberMeta
    });
    removeDeletedRoleEntry(roleId);
    restoreSessions.delete(sessionId);

    await interaction.editReply({
      embeds: [buildAdminSummaryEmbed('✅ تم إنشاء الرول واسترجاعه.', [
        { name: 'الرول', value: `<@&${finalRole.id}>`, inline: true },
        { name: 'الأعضاء', value: `${memberIds.length}`, inline: true }
      ])],
      components: []
    });
    await logRoleAction(interaction.guild, getGuildConfig(interaction.guild.id), 'تم إنشاء رول خاص من المحذوفات وإعادته للأعضاء.', [
      { name: 'الرول', value: `<@&${finalRole.id}>`, inline: true },
      { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
    ]);
    return;
  }

  if (interaction.customId === 'customroles_request_button') {
    if (isUserBlocked(interaction.user.id)) {
      await interaction.reply({ content: '❌ أنت محظور من استخدام البوت.', ephemeral: true });
      return;
    }
    const adminRoles = loadAdminRoles();
    if (!adminRoles.length) {
      await interaction.reply({ content: '❌ لم يتم تحديد رولات الإدارة بعد.', ephemeral: true });
      return;
    }
    const guildConfig = getGuildConfig(interaction.guild.id);
    const remainingCooldown = getRequestCooldownRemaining(guildConfig, interaction.user.id);
    if (remainingCooldown > 0) {
      await interaction.reply({
        content: `❌ لا يمكنك تقديم طلب جديد الآن. يمكنك المحاولة بعد **${formatDuration(remainingCooldown)}**.`,
        ephemeral: true
      });
      return;
    }
    const pendingRequest = guildConfig.pendingRoleRequests?.[interaction.user.id];
    if (pendingRequest) {
      await interaction.reply({ content: '⚠️ لديك طلب رول خاص قيد المراجعة بالفعل.', ephemeral: true });
      return;
    }
    const existingRole = getValidOwnerRoleEntry(interaction.guild, interaction.user.id, interaction.user.id);
    if (existingRole) {
      await interaction.reply({ content: '⚠️ لديك رول خاص بالفعل ولا يمكنك طلب رول جديد.', ephemeral: true });
      return;
    }
    const memberRolesCache = interaction.member?.roles?.cache;
    const hasAdminRole = memberRolesCache
      ? memberRolesCache.some(role => adminRoles.includes(role.id))
      : true;
    if (!hasAdminRole) {
      await interaction.reply({ content: '❌ هذا الزر مخصص لرولات الإدارة فقط.', ephemeral: true });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId('customroles_request_modal')
      .setTitle('طلب رول خاص');

    const nameInput = new TextInputBuilder()
      .setCustomId('role_name')
      .setLabel('اسم الرول المطلوب')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const reasonInput = new TextInputBuilder()
      .setCustomId('role_reason')
      .setLabel('رولك؟ (اختياري)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(nameInput),
      new ActionRowBuilder().addComponents(reasonInput)
    );

    try {
      await interaction.showModal(modal);
    } catch (error) {
      if (error?.code !== 10062) {
        throw error;
      }
      console.warn('[customroles_request_button] interaction expired before showModal.');
    }
    return;
  }

  if (interaction.customId === 'customroles_request_modal') {
    await interaction.deferReply({ ephemeral: true });
    const adminRoles = loadAdminRoles();
    if (!adminRoles.length) {
      await interaction.editReply({ content: '❌ لم يتم تحديد رولات الإدارة بعد.' });
      return;
    }
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const hasAdminRole = member ? member.roles.cache.some(role => adminRoles.includes(role.id)) : false;
    if (!hasAdminRole) {
      await interaction.editReply({ content: '❌ هذا النموذج مخصص لرولات الإدارة فقط.' });
      return;
    }
    const guildConfig = getGuildConfig(interaction.guild.id);
    const remainingCooldown = getRequestCooldownRemaining(guildConfig, interaction.user.id);
    if (remainingCooldown > 0) {
      await interaction.editReply({
        content: `❌ لا يمكنك تقديم طلب جديد الآن. يمكنك المحاولة بعد **${formatDuration(remainingCooldown)}**.`
      });
      return;
    }
    if (guildConfig.pendingRoleRequests?.[interaction.user.id]) {
      await interaction.editReply({ content: '⚠️ لديك طلب رول خاص قيد المراجعة بالفعل.' });
      return;
    }
    const existingRole = getValidOwnerRoleEntry(interaction.guild, interaction.user.id, interaction.user.id);
    if (existingRole) {
      await interaction.editReply({ content: '⚠️ لديك رول خاص بالفعل ولا يمكنك طلب رول جديد.' });
      return;
    }
    if (!guildConfig.requestInboxChannelId) {
      await interaction.editReply({ content: '❌ لم يتم تحديد روم استقبال الطلبات.' });
      return;
    }

    const roleName = interaction.fields.getTextInputValue('role_name');
    const reason = interaction.fields.getTextInputValue('role_reason');
    const requestChannel = await interaction.guild.channels.fetch(guildConfig.requestInboxChannelId).catch(() => null);
    if (!requestChannel) {
      await interaction.editReply({ content: '❌ روم استقبال الطلبات غير موجود.' });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(' طلب رول خاص')
      .setDescription(`العضو: <@${interaction.user.id}>`)
      .addFields(
        { name: 'الرول المطلوب', value: roleName },
        { name: 'السبب', value: reason || 'بدون سبب' }
      )
      .setColor(colorManager.getColor ? colorManager.getColor() : '#2f3136')
      .setThumbnail(interaction.client.user.displayAvatarURL({ size: 128 }));

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`customroles_request_approve_${interaction.user.id}`).setLabel('موافقة').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`customroles_request_reject_${interaction.user.id}`).setLabel('رفض').setStyle(ButtonStyle.Danger)
    );

    const requestMessage = await requestChannel.send({ embeds: [embed], components: [row] });
    const pendingRequests = { ...(guildConfig.pendingRoleRequests || {}) };
    pendingRequests[interaction.user.id] = {
      createdAt: Date.now(),
      messageId: requestMessage.id,
      channelId: requestChannel.id,
      roleName
    };
    updateGuildConfig(interaction.guild.id, { pendingRoleRequests: pendingRequests });
    await interaction.editReply({ content: '✅ تم إرسال طلبك للمراجعة.' });
    return;
  }

  if (interaction.customId.startsWith('customroles_request_approve_')) {
    const acknowledged = await ensureEphemeralAck(interaction);
    if (!isAdminUser) {
      if (acknowledged) {
        await interaction.editReply({ content: '❌ لا تملك صلاحية.' }).catch(() => {});
      } else {
        await respondEphemeral(interaction, { content: '❌ لا تملك صلاحية.' });
      }
      return;
    }
    const userId = interaction.customId.split('_')[3];
    const approvalKey = `${interaction.guild.id}:${userId}`;

    if (pendingRoleApprovals.has(approvalKey)) {
      if (acknowledged) {
        await interaction.editReply({ content: '⚠️ يتم الآن معالجة هذا الطلب بالفعل.' }).catch(() => {});
      } else {
        await respondEphemeral(interaction, { content: '⚠️ يتم الآن معالجة هذا الطلب بالفعل.' });
      }
      return;
    }

    pendingRoleApprovals.add(approvalKey);

    try {
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) {
      if (acknowledged) {
        await interaction.editReply({ content: '❌ لم يتم العثور على العضو المطلوب.' }).catch(() => {});
      } else {
        await respondEphemeral(interaction, { content: '❌ لم يتم العثور على العضو المطلوب.' });
      }
      return;
    }

    const latestConfig = getGuildConfig(interaction.guild.id);
    const pendingRequest = latestConfig.pendingRoleRequests?.[userId];
    if (!pendingRequest) {
      await interaction.message.edit({ components: [] }).catch(() => {});
      if (acknowledged) {
        await interaction.editReply({ content: '⚠️ هذا الطلب تمت معالجته مسبقاً.' }).catch(() => {});
      } else {
        await respondEphemeral(interaction, { content: '⚠️ هذا الطلب تمت معالجته مسبقاً.' });
      }
      return;
    }

    const existingRole = getValidOwnerRoleEntry(interaction.guild, member.id, interaction.user.id);
    if (existingRole) {
      const guildConfig = getGuildConfig(interaction.guild.id);
      if (guildConfig.pendingRoleRequests?.[member.id]) {
        const pendingRequests = { ...(guildConfig.pendingRoleRequests || {}) };
        delete pendingRequests[member.id];
        updateGuildConfig(interaction.guild.id, { pendingRoleRequests: pendingRequests });
      }
      await interaction.message.edit({ components: [] }).catch(() => {});
      if (acknowledged) {
        await interaction.editReply({ content: '⚠️ العضو لديه رول خاص بالفعل.' }).catch(() => {});
      } else {
        await respondEphemeral(interaction, { content: '⚠️ العضو لديه رول خاص بالفعل.' });
      }
      return;
    }

    const roleNameField = interaction.message.embeds[0]?.fields?.find(field => field.name === 'الرول المطلوب');
    const roleName = pendingRequest?.roleName || roleNameField?.value || `رول-${member.user.username}`;

    const pendingRequests = { ...(latestConfig.pendingRoleRequests || {}) };
    delete pendingRequests[userId];
    updateGuildConfig(interaction.guild.id, { pendingRoleRequests: pendingRequests });

    const role = await interaction.guild.roles.create({
      name: roleName,
      permissions: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
      reason: `موافقة على طلب رول خاص ${member.user.tag}`
    }).catch(() => null);

    if (!role) {
      const restoredPendingRequests = { ...(getGuildConfig(interaction.guild.id).pendingRoleRequests || {}) };
      restoredPendingRequests[userId] = pendingRequest;
      updateGuildConfig(interaction.guild.id, { pendingRoleRequests: restoredPendingRequests });
      await interaction.message.edit({ content: '❌ فشل إنشاء الرول. تحقق من الصلاحيات.', components: [] }).catch(() => {});
      if (acknowledged) {
        await interaction.editReply({ content: '❌ فشل إنشاء الرول. تحقق من الصلاحيات.' }).catch(() => {});
      } else {
        await respondEphemeral(interaction, { content: '❌ فشل إنشاء الرول. تحقق من الصلاحيات.' });
      }
      return;
    }
    await applyRoleCategoryPosition(role, getGuildConfig(interaction.guild.id));

    const roleAddResult = await member.roles.add(role, 'منح رول خاص عبر الطلب').catch(() => null);
    if (!roleAddResult) {
      await interaction.message.edit({ content: '⚠️ تم إنشاء الرول لكن تعذر منحه للعضو.', components: [] }).catch(() => {});
    }

    addRoleEntry(role.id, {
      roleId: role.id,
      guildId: interaction.guild.id,
      ownerId: member.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: interaction.user.id,
      name: role.name,
      color: role.hexColor,
      icon: role.iconURL(),
      maxMembers: null,
      memberMeta: {
        [member.id]: {
          assignedAt: Date.now(),
          assignedBy: interaction.user.id,
          assignedByIsBot: interaction.user.bot
        }
      }
    });

    const guildConfig = getGuildConfig(interaction.guild.id);
    const cooldowns = { ...(guildConfig.requestCooldowns || {}) };
    delete cooldowns[member.id];
    updateGuildConfig(interaction.guild.id, { requestCooldowns: cooldowns });

    await member.send(`✅ تمت الموافقة على طلبك وتم إنشاء الرول الخاص بك: **${role.name}**`).catch(() => {});
    const updatedEmbed = interaction.message.embeds[0]
      ? EmbedBuilder.from(interaction.message.embeds[0])
      : colorManager.createEmbed().setTitle('طلب رول خاص');
    updatedEmbed
      .setFields(
        { name: 'العضو', value: `<@${member.id}>`, inline: true },
        { name: 'المسؤول الموافق', value: `<@${interaction.user.id}>`, inline: true }
      )
      .setFooter({ text: 'تمت الموافقة على الطلب' });
    await interaction.message.edit({ embeds: [updatedEmbed], components: [] }).catch(() => {});
    if (acknowledged) {
      await interaction.editReply({ content: `✅ المسؤول الموافق : <@${interaction.user.id}>` }).catch(() => {});
    } else {
      await respondEphemeral(interaction, { content: `✅ المسؤول الموافق : <@${interaction.user.id}>` });
    }
    } finally {
      pendingRoleApprovals.delete(approvalKey);
    }
    return;
  }

  if (interaction.customId.startsWith('customroles_request_reject_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`customroles_reject_modal_${interaction.customId.split('_')[3]}`)
      .setTitle('سبب الرفض');

    const reasonInput = new TextInputBuilder()
      .setCustomId('reject_reason')
      .setLabel('اذكر سبب الرفض')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
    await interaction.showModal(modal);
    return;
  }

  if (interaction.customId.startsWith('customroles_reject_modal_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const userId = interaction.customId.split('_')[3];
    const reason = interaction.fields.getTextInputValue('reject_reason');
    const guildConfig = getGuildConfig(interaction.guild.id);
    const pendingRequests = { ...(guildConfig.pendingRoleRequests || {}) };
    delete pendingRequests[userId];
    const cooldowns = { ...(guildConfig.requestCooldowns || {}) };
    cooldowns[userId] = Date.now();
    updateGuildConfig(interaction.guild.id, { pendingRoleRequests: pendingRequests, requestCooldowns: cooldowns });
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (member) {
      await member.send(`❌ تم رفض طلب الرول الخاص. السبب: ${reason}`).catch(() => {});
    }

    const updatedEmbed = interaction.message?.embeds?.[0]
      ? EmbedBuilder.from(interaction.message.embeds[0])
      : colorManager.createEmbed().setTitle('طلب رول خاص');
    updatedEmbed
      .setFields(
        { name: 'العضو', value: member ? `<@${member.id}>` : `<@${userId}>`, inline: true },
        { name: 'المسؤول الرافض', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'سبب الرفض', value: reason || 'بدون سبب', inline: false }
      )
      .setFooter({ text: 'تم رفض الطلب' });
    await interaction.message?.edit({ embeds: [updatedEmbed], components: [] }).catch(() => {});

    await interaction.editReply({ content: '✅ تم إرسال سبب الرفض.' });
    return;
  }

  if (interaction.customId.startsWith('customroles_add_cancel_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    const parts = interaction.customId.split('_');
    const requesterId = parts[4];
    if (requesterId && requesterId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا الزر ليس لك.', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    await interaction.message.edit({ content: 'تم إلغاء الإضافة.', components: [] }).catch(() => {});
    return;
  }

  if (interaction.customId.startsWith('customroles_add_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    const parts = interaction.customId.split('_');
    if (parts[2] === 'cancel') return;
    const requesterId = parts[3];
    if (requesterId && requesterId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا الزر ليس لك.', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    const roleId = parts[2];
    const guildConfig = getGuildConfig(interaction.guild.id);
    const hasPermission = isManager(interaction.member, guildConfig, BOT_OWNERS);
    if (!hasPermission) return;

    const response = await promptForMessage(interaction.channel, interaction.user.id, '**منشن مالك الرول الجديد أو اكتب ID:**', interaction);
    if (!response) return;
    const ownerId = response.mentions.users.first()?.id || response.content.match(/\d{17,19}/)?.[0];
    if (!ownerId) return;

    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) {
      await interaction.followUp({ content: '**❌ الرول غير موجود في السيرفر.**', ephemeral: true });
      return;
    }
    const existingOwnerRole = findRoleByOwner(interaction.guild.id, ownerId);
    if (existingOwnerRole) {
      await interaction.followUp({ content: '**❌ هذا العضو يملك رول خاص بالفعل.**', ephemeral: true });
      return;
    }

    addRoleEntry(role.id, {
      roleId: role.id,
      guildId: interaction.guild.id,
      ownerId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: interaction.user.id,
      name: role.name,
      color: role.hexColor,
      icon: role.iconURL(),
      maxMembers: null,
      memberMeta: {
        [ownerId]: {
          assignedAt: Date.now(),
          assignedBy: interaction.user.id,
          assignedByIsBot: interaction.user.bot
        }
      }
    });

    await interaction.followUp({
      embeds: [buildAdminSummaryEmbed('✅ تم إضافة الرول للقاعدة.', [
        { name: 'الرول', value: `<@&${role.id}>`, inline: true },
        { name: 'المالك', value: `<@${ownerId}>`, inline: true }
      ])],
      ephemeral: true
    });
    await interaction.message.edit({ content: '✅ تم إضافة الرول للقاعدة.', components: [] }).catch(() => {});
    await logRoleAction(interaction.guild, getGuildConfig(interaction.guild.id), 'تم إضافة رول خاص للقاعدة.', [
      { name: 'الرول', value: `<@&${role.id}>`, inline: true },
      { name: 'المالك', value: `<@${ownerId}>`, inline: true },
      { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
    ]);
    return;
  }

  if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('customroles_admin_rolepicker_add_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    const targetUserId = interaction.customId.split('_').pop();
    if (targetUserId !== interaction.user.id) {
      await interaction.reply({ content: '❌ هذا الاختيار ليس لك.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const roleIds = interaction.values;
    const results = [];
    for (const roleId of roleIds) {
      const role = interaction.guild.roles.cache.get(roleId);
      if (!role) {
        results.push(`❌ لم يتم العثور على الرول ${roleId}.`);
        continue;
      }
      if (getRoleEntry(roleId)) {
        results.push(`⚠️ الرول ${role.name} موجود بالفعل في القاعدة.`);
        continue;
      }
      if (isDangerousRole(role)) {
        results.push(`❌ الرول ${role.name} يحتوي صلاحيات خطيرة.`);
        continue;
      }
      const response = await promptForMessage(interaction.channel, interaction.user.id, `**منشن مالك الرول "${role.name}" أو اكتب ID:**`, interaction);
      if (!response) {
        results.push(`❌ لم يتم تحديد مالك للرول ${role.name}.`);
        continue;
      }
      const ownerId = response.mentions.users.first()?.id || response.content.match(/\d{17,19}/)?.[0];
      if (!ownerId) {
        results.push(`❌ لم يتم تحديد مالك صالح للرول ${role.name}.`);
        continue;
      }
      const existingOwnerRole = findRoleByOwner(interaction.guild.id, ownerId);
      if (existingOwnerRole) {
        results.push(`❌ المالك <@${ownerId}> لديه رول خاص بالفعل.`);
        continue;
      }
      const memberMeta = {
        [ownerId]: {
          assignedAt: Date.now(),
          assignedBy: interaction.user.id,
          assignedByIsBot: interaction.user.bot
        }
      };
      for (const member of role.members.values()) {
        if (memberMeta[member.id]) continue;
        memberMeta[member.id] = {
          assignedAt: Date.now(),
          assignedBy: interaction.user.id,
          assignedByIsBot: interaction.user.bot
        };
      }
      addRoleEntry(role.id, {
        roleId: role.id,
        guildId: interaction.guild.id,
        ownerId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: interaction.user.id,
        name: role.name,
        color: role.hexColor,
        icon: role.iconURL(),
        maxMembers: null,
        memberMeta
      });
      results.push(`✅ تمت إضافة الرول ${role.name} للقاعدة.`);
    }
    await interaction.editReply({
      embeds: [buildAdminSummaryEmbed('نتائج إضافة الرولات', [
        { name: 'النتائج', value: results.join('\n').slice(0, 1024) || 'لا توجد نتائج.' }
      ])]
    });
    return;
  }

  if (interaction.customId.startsWith('customroles_admin_delete_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    const roleId = interaction.customId.split('_')[3];
    const roleEntry = getRoleEntry(roleId);
    const role = interaction.guild.roles.cache.get(roleId);
    const ownerMember = roleEntry?.ownerId
      ? await interaction.guild.members.fetch(roleEntry.ownerId).catch(() => null)
      : null;
    const ownerName = ownerMember?.displayName || roleEntry?.ownerId || 'غير معروف';
    if (role) {
      if (!role.editable) {
        await interaction.message.edit({ content: '❌ لا يمكن حذف هذا الرول بسبب صلاحيات البوت.', components: [] });
        return;
      }
      await role.delete(`حذف رول خاص بواسطة ${interaction.user.tag}`).catch(() => {});
    }
    deleteRoleEntry(roleId, interaction.user.id);
    if (roleEntry?.ownerId) {
      await interaction.client.users.fetch(roleEntry.ownerId)
        .then(user => user.send('🗑️ تم حذف رولك الخاص بواسطة الإدارة.').catch(() => {}))
        .catch(() => {});
    }
    await interaction.message.edit({
      embeds: [buildAdminSummaryEmbed('✅ تم حذف الرول.', [
        { name: 'الرول', value: `<@&${roleId}>`, inline: true },
        { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
      ], `المالك: **${ownerName}**`)],
      components: []
    });
    await logRoleAction(interaction.guild, getGuildConfig(interaction.guild.id), 'تم حذف رول خاص.', [
      { name: 'الرول', value: `<@&${roleId}>`, inline: true },
      { name: 'المالك', value: ownerName, inline: true },
      { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
    ]);
    return;
  }

  if (interaction.customId.startsWith('customroles_admin_transfer_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '❌ لا تملك صلاحية.', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    const roleId = interaction.customId.split('_')[3];
    const response = await promptForMessage(interaction.channel, interaction.user.id, '**منشن المالك الجديد أو اكتب ID:**', interaction);
    if (!response) return;
    const ownerId = response.mentions.users.first()?.id || response.content.match(/\d{17,19}/)?.[0];
    if (!ownerId) return;

    const roleEntry = getRoleEntry(roleId);
    if (!roleEntry) {
      await interaction.followUp({ content: '❌ هذا الرول غير مسجل في القاعدة.', ephemeral: true });
      return;
    }
    roleEntry.ownerId = ownerId;
    addRoleEntry(roleId, roleEntry);

    const member = await interaction.guild.members.fetch(ownerId).catch(() => null);
    if (member) {
      await member.roles.add(roleId, 'نقل ملكية رول خاص').catch(() => {});
    }
    await interaction.followUp({
      embeds: [buildAdminSummaryEmbed('✅ تم نقل الملكية بنجاح.', [
        { name: 'الرول', value: `<@&${roleId}>`, inline: true },
        { name: 'المالك الجديد', value: `<@${ownerId}>`, inline: true }
      ])],
      ephemeral: true
    });
    await logRoleAction(interaction.guild, getGuildConfig(interaction.guild.id), 'تم نقل ملكية رول خاص.', [
      { name: 'الرول', value: `<@&${roleId}>`, inline: true },
      { name: 'المالك الجديد', value: `<@${ownerId}>`, inline: true },
      { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
    ]);
    return;
  }

  if (interaction.customId.startsWith('customroles_admin_remove_')) {
    if (!isAdminUser) {
      await interaction.reply({ content: '**❌ لا تملك صلاحية.**', ephemeral: true });
      return;
    }
    await interaction.deferUpdate();
    const roleId = interaction.customId.split('_')[3];
    deleteRoleEntry(roleId, interaction.user.id);
    await interaction.followUp({
      embeds: [buildAdminSummaryEmbed('✅ تم إزالة الرول من قاعدة البيانات.', [
        { name: 'الرول', value: `<@&${roleId}>`, inline: true },
        { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
      ])],
      ephemeral: true
    });
    await logRoleAction(interaction.guild, getGuildConfig(interaction.guild.id), 'تمت إزالة رول خاص من القاعدة.', [
      { name: 'الرول', value: `<@&${roleId}>`, inline: true },
      { name: 'بواسطة', value: `<@${interaction.user.id}>`, inline: true }
    ]);
    return;
  }

}

function restoreTopSchedules(client) {
  const configData = getConfigData();
  for (const [guildId, config] of Object.entries(configData)) {
    if (!config.topEnabled || !config.topChannelId || !config.topMessageId) continue;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    const channel = guild.channels.cache.get(config.topChannelId);
    if (!channel) continue;
    startTopSchedule(guild, channel, config.topMessageId);
  }
}

async function restorePanelCleanups(client) {
  const configData = getConfigData();
  for (const [guildId, config] of Object.entries(configData)) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    const panelConfigs = [
      { type: 'member', channelId: config.memberControlChannelId, messageId: config.memberPanelMessageId },
      { type: 'admin', channelId: config.adminControlChannelId, messageId: config.adminPanelMessageId },
      { type: 'request', channelId: config.requestsChannelId, messageId: config.requestPanelMessageId },
      { type: 'top', channelId: config.topChannelId, messageId: config.topMessageId }
    ];

    for (const { type, channelId, messageId } of panelConfigs) {
      if (!channelId) continue;
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) continue;

      if (messageId) {
        const existingMessage = await channel.messages.fetch(messageId).catch(() => null);
        if (existingMessage) {
          startPanelCleanup(guild, channelId, messageId);
          continue;
        }
      }

      if (type === 'top' && !config.topEnabled) continue;

      try {
        if (type === 'member') {
          await sendMemberPanel(guild, channel, config);
        } else if (type === 'admin') {
          await sendAdminPanel(guild, channel, config);
        } else if (type === 'request') {
          await sendRequestPanel(guild, channel, config);
        } else if (type === 'top') {
          await sendTopRolesPanel(guild, channel, config);
        }
      } catch (error) {
        console.error('❌ فشل استعادة لوحة الرولات الخاصة:', error);
      }
    }
  }
}

async function handlePanelMessageDelete(message, client) {
  const guildId = message.guildId;
  if (!guildId) return;
  const guildConfig = getGuildConfig(guildId);
  if (!guildConfig) return;
  const panelMap = [
    {
      type: 'member',
      messageId: guildConfig.memberPanelMessageId,
      channelId: guildConfig.memberControlChannelId
    },
    {
      type: 'admin',
      messageId: guildConfig.adminPanelMessageId,
      channelId: guildConfig.adminControlChannelId
    },
    {
      type: 'request',
      messageId: guildConfig.requestPanelMessageId,
      channelId: guildConfig.requestsChannelId
    },
    {
      type: 'top',
      messageId: guildConfig.topMessageId,
      channelId: guildConfig.topChannelId
    }
  ];

  const matched = panelMap.find(panel => panel.messageId && panel.messageId === message.id);
  if (!matched) return;
  if (matched.type === 'top' && !guildConfig.topEnabled) return;
  if (matched.channelId && matched.channelId !== message.channelId) return;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;
  const channel = await guild.channels.fetch(matched.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  try {
    if (matched.type === 'member') {
      await sendMemberPanel(guild, channel, guildConfig);
    } else if (matched.type === 'admin') {
      await sendAdminPanel(guild, channel, guildConfig);
    } else if (matched.type === 'request') {
      await sendRequestPanel(guild, channel, guildConfig);
    } else if (matched.type === 'top') {
      await sendTopRolesPanel(guild, channel, guildConfig);
    }
  } catch (error) {
    console.error('❌ فشل إعادة إرسال لوحة الرولات الخاصة:', error);
  }
}

module.exports = {
  executeRolesSettings,
  handleCustomRolesInteraction,
  restoreTopSchedules,
  restorePanelCleanups,
  handlePanelMessageDelete
};

interactionRouter.register('customroles_', async (interaction, context = {}) => {
  const { client, BOT_OWNERS } = context;
  await handleCustomRolesInteraction(interaction, client, BOT_OWNERS || []);
});
