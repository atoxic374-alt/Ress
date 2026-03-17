const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const name = 'ticket';
const aliases = ['تكت'];
const dataPath = path.join(__dirname, '..', 'data', 'ticketConfig.json');
const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
const ticketImagesDir = path.join(__dirname, '..', 'data', 'ticket_images');

let handlersRegistered = false;

function loadStore() {
  try {
    if (!fs.existsSync(dataPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveStore(store) {
  fs.writeFileSync(dataPath, JSON.stringify(store, null, 2), 'utf8');
}

function loadResponsibilities() {
  try {
    if (!fs.existsSync(responsibilitiesPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(responsibilitiesPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function ensureTicketImagesDir() {
  if (!fs.existsSync(ticketImagesDir)) fs.mkdirSync(ticketImagesDir, { recursive: true });
}

function removeStoredImage(value) {
  if (!value || typeof value !== 'string' || !value.startsWith('local:')) return;
  const fileName = value.slice('local:'.length);
  const absolute = path.join(ticketImagesDir, fileName);
  if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
}

function resolveImageForSend(value) {
  if (!value || typeof value !== 'string') return null;
  if (!value.startsWith('local:')) return value;
  const fileName = value.slice('local:'.length);
  const absolute = path.join(ticketImagesDir, fileName);
  return fs.existsSync(absolute) ? absolute : null;
}

async function storeImageLocally(url, guildId, slotKey, previousValue = null) {
  const safe = String(url || '').trim();
  if (!/^https?:\/\//i.test(safe)) throw new Error('الرابط غير صالح');
  const parsed = new URL(safe);
  const response = await fetch(parsed.toString());
  if (!response.ok) throw new Error(`فشل تحميل الصورة (${response.status})`);

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error('الرابط لا يشير إلى صورة');

  ensureTicketImagesDir();
  const extFromType = contentType.includes('png') ? '.png'
    : contentType.includes('jpeg') || contentType.includes('jpg') ? '.jpg'
      : contentType.includes('webp') ? '.webp'
        : contentType.includes('gif') ? '.gif'
          : path.extname(parsed.pathname || '') || '.png';

  const fileName = `${guildId}_${slotKey}_${Date.now()}${extFromType}`;
  const absolute = path.join(ticketImagesDir, fileName);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(absolute, bytes);

  removeStoredImage(previousValue);
  return `local:${fileName}`;
}

function baseConfig() {
  return {
    ticketNameMode: 'counter',
    ticketNamePrefix: 'ticket',
    openCategoryId: null,
    closedCategoryId: null,
    responsibleRoleIds: [],
    adminRoleIds: [],
    useGlobalAdminRoles: true,
    adminClaimLimit: 1,
    memberOpenLimit: 1,
    autoCreateOnRequest: true,
    hideOnClaim: false,
    claimFromDedicatedChannel: false,
    claimChannelId: null,
    claimChannelSeparator: '────────────────',
    keepClosedTickets: false,
    messages: {
      acceptance: '',
      beforeImage: '',
      ticketImage: '',
      afterImage: ''
    },
    reasons: {},
    displayMode: 'buttons',
    buttonRows: 2,
    counter: 1
  };
}

function getGuildData(guildId) {
  const store = loadStore();
  const existing = store[guildId] || {};
  const config = { ...baseConfig(), ...(existing.config || {}) };
  config.messages = { ...baseConfig().messages, ...(existing.config?.messages || {}) };
  config.reasons = existing.config?.reasons || {};
  const tickets = existing.tickets || {};
  const pendingRequests = existing.pendingRequests || {};
  return { store, guild: { config, tickets, pendingRequests } };
}

function setGuildData(guildId, config, tickets, pendingRequests = {}) {
  const store = loadStore();
  store[guildId] = { config, tickets, pendingRequests };
  saveStore(store);
}

function normalizeId(input) {
  if (!input) return null;
  const match = String(input).trim().match(/^(?:<@&?|<#)?(\d{16,20})>?$/);
  return match ? match[1] : null;
}

function createMainEmbed(config, guildName) {
  return new EmbedBuilder()
    .setTitle(`**إعدادات التكت : ${guildName}**`)
    .setDescription([
      '**اكتب رقم الخيار من 1 الى 14 أو اكتب خروج.**',
      '**1** - **اسم شات التكت**',
      '**2** - **الكاتوقري عند فتح التكت**',
      '**3** - **تحديد المسؤولين**',
      '**4** - **تحديد رولات الادمن**',
      '**5** - **كولداون الاداري (حد الاستلام المفتوح)**',
      '**6** - **كولداون العضو (حد التكت المفتوح)**',
      '**7** - **انشاء التكت قبل الاستلام (toggle)**',
      '**8** - **اخفاء التكت عند الاستلام (toggle)**',
      '**9** - **الاستلام من شات مخصص (toggle + اعدادات)**',
      '**10** - **اقفال التكت والاحتفاظ به (toggle)**',
      '**11** - **اعدادات الرسائل**',
      '**12** - **تعيين الاسباب (1 - 25)**',
      '**13** - **طريقة العرض (buttons / menu)**',
      '**14** - **ارسال بانل التكت**'
    ].join('\n'))
    .addFields(
      { name: '**الاسم**', value: `**${config.ticketNamePrefix}** - **${config.ticketNameMode}**`, inline: true },
      { name: '**طريقة العرض**', value: `**${config.displayMode}**`, inline: true },
      { name: '**الاسباب**', value: `**${Object.keys(config.reasons || {}).length}**`, inline: true }
    );
}

function getAdminRoles(config) {
  if (!config.useGlobalAdminRoles) return config.adminRoleIds || [];
  try {
    const fromFile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'adminRoles.json'), 'utf8'));
    return Array.isArray(fromFile) ? fromFile : [];
  } catch {
    return [];
  }
}

function countOpenMemberTickets(tickets, userId) {
  return Object.values(tickets).filter((t) => t.status === 'open' && t.memberId === userId).length;
}

function countClaimedByAdmin(tickets, adminId) {
  return Object.values(tickets).filter((t) => t.status === 'open' && t.claimedBy === adminId).length;
}

function hasStaffAccess(member, config) {
  const adminRoles = getAdminRoles(config);
  const hasRole = member.roles.cache.some((r) => adminRoles.includes(r.id) || (config.responsibleRoleIds || []).includes(r.id));
  return hasRole || member.permissions.has(PermissionFlagsBits.Administrator);
}

function canManageTicket(interaction, ticket, config) {
  if (interaction.user.id === ticket.claimedBy) return true;
  return hasStaffAccess(interaction.member, config);
}

function sanitizeName(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\-\_\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 90);
}

async function buildTicketControls(guildId, channelId, config) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_claim_${guildId}_${channelId}`).setLabel('استلام').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ticket_close_${guildId}_${channelId}`).setLabel('اقفال').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket_rename_${guildId}_${channelId}`).setLabel('تغيير الاسم').setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_add_${guildId}_${channelId}`).setLabel('اضافة شخص').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ticket_remove_${guildId}_${channelId}`).setLabel('ازالة شخص').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_ping_${guildId}_${channelId}`).setLabel('استدعاء العضو').setStyle(ButtonStyle.Primary)
  );

  const responsibilities = loadResponsibilities();
  const options = Object.keys(responsibilities)
    .slice(0, 25)
    .map((respName) => ({ label: respName.slice(0, 100), value: `resp_${respName}` }));

  const row3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ticket_transfer_${guildId}_${channelId}`)
      .setPlaceholder('اختر مسؤولية لتحويل التكت')
      .addOptions(options.length ? options : [{ label: 'لا توجد مسؤوليات', value: 'resp_none' }])
      .setDisabled(options.length === 0)
  );

  return [row1, row2, row3];
}

async function createTicketChannel({ guild, member, config, reasonKey, tickets, pendingRequests }) {
  const reason = config.reasons?.[reasonKey] || {};
  const prefix = sanitizeName(reason.ticketName || config.ticketNamePrefix || 'ticket') || 'ticket';
  const suffix = config.ticketNameMode === 'user' ? sanitizeName(member.user.username) : String(config.counter || 1);
  const channelName = `${prefix}-${suffix}`.slice(0, 90);
  const categoryId = reason.categoryId || config.openCategoryId || null;

  const adminRoles = getAdminRoles(config);
  const allowedStaffRoles = [...new Set([...(config.responsibleRoleIds || []), ...adminRoles])];

  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
  ];

  for (const roleId of allowedStaffRoles) {
    permissionOverwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: categoryId || undefined,
    permissionOverwrites
  });

  const controls = await buildTicketControls(guild.id, channel.id, config);

  if (reason.beforeImage || config.messages.beforeImage) {
    await channel.send({ content: reason.beforeImage || config.messages.beforeImage });
  }
  const openImage = resolveImageForSend(reason.openImage || config.messages.ticketImage);
  if (openImage) {
    await channel.send({ files: [openImage] }).catch(() => {});
  }
  if (reason.afterImage || config.messages.afterImage) {
    await channel.send({ content: reason.afterImage || config.messages.afterImage });
  }

  await channel.send({
    content: `**التكت : تم الانشاء**\n**العضو :** <@${member.id}>`,
    components: controls
  });

  if (config.ticketNameMode !== 'user') config.counter = (config.counter || 1) + 1;

  tickets[channel.id] = {
    channelId: channel.id,
    memberId: member.id,
    reasonKey,
    claimedBy: null,
    status: 'open',
    extraMembers: [],
    createdAt: Date.now()
  };

  setGuildData(guild.id, config, tickets, pendingRequests);
  return channel;
}

async function applyHideOnClaim(channel, guild, config, claimerId, memberId, extraMembers = []) {
  const adminRoles = getAdminRoles(config);
  const visibleStaffRoles = [...new Set([...adminRoles, ...(config.responsibleRoleIds || [])])];

  for (const roleId of visibleStaffRoles) {
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    }).catch(() => {});
  }

  await channel.permissionOverwrites.edit(claimerId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true
  }).catch(() => {});

  await channel.permissionOverwrites.edit(memberId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true
  }).catch(() => {});

  for (const userId of extraMembers) {
    await channel.permissionOverwrites.edit(userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    }).catch(() => {});
  }
}

async function handleOpenRequest(interaction, guildId, reasonKey) {
  const guild = interaction.guild;
  const { guild: g } = getGuildData(guildId);
  const { config, tickets, pendingRequests } = g;

  const openCount = countOpenMemberTickets(tickets, interaction.user.id);
  if (openCount >= (config.memberOpenLimit || 1)) {
    await interaction.reply({ content: `**الحد : وصلت لاقصى تكت مفتوح (${config.memberOpenLimit}).**`, ephemeral: true });
    return;
  }

  if (config.autoCreateOnRequest) {
    const channel = await createTicketChannel({ guild, member: interaction.member, config, reasonKey, tickets, pendingRequests });
    await interaction.reply({ content: `**تم انشاء التكت :** <#${channel.id}>`, ephemeral: true });
    return;
  }

  const reqId = `${guildId}_${interaction.user.id}_${Date.now()}`;
  pendingRequests[reqId] = { guildId, userId: interaction.user.id, reasonKey, sourceChannelId: interaction.channelId, createdAt: Date.now() };

  const targetChannelId = config.claimFromDedicatedChannel ? config.claimChannelId : interaction.channelId;
  const targetChannel = await guild.channels.fetch(targetChannelId).catch(() => null);
  if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
    delete pendingRequests[reqId];
    setGuildData(guildId, config, tickets, pendingRequests);
    await interaction.reply({ content: '**فشل : شات الاستلام غير صالح.**', ephemeral: true });
    return;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_claimreq_${reqId}`).setStyle(ButtonStyle.Primary).setLabel('استلام التكت')
  );

  if (config.messages.acceptance) await targetChannel.send({ content: config.messages.acceptance });
  if (config.claimFromDedicatedChannel && config.claimChannelSeparator) await targetChannel.send({ content: config.claimChannelSeparator });

  await targetChannel.send({
    content: `**طلب تكت :** <@${interaction.user.id}>\n**السبب :** ${config.reasons?.[reasonKey]?.name || `سبب ${reasonKey}`}`,
    components: [row]
  });

  setGuildData(guildId, config, tickets, pendingRequests);
  await interaction.reply({ content: '**تم ارسال طلبك لشات الاستلام.**', ephemeral: true });
}

async function handleClaimInTicket(interaction, guildId, channelId) {
  const { guild: g } = getGuildData(guildId);
  const { config, tickets, pendingRequests } = g;
  const ticket = tickets[channelId];
  if (!ticket || ticket.status !== 'open' || interaction.channelId !== channelId) {
    await interaction.reply({ content: '**هذا التكت غير متاح.**', ephemeral: true });
    return;
  }

  if (!hasStaffAccess(interaction.member, config)) {
    await interaction.reply({ content: '**ليس لديك صلاحية الاستلام.**', ephemeral: true });
    return;
  }

  const claimedCount = countClaimedByAdmin(tickets, interaction.user.id);
  if (claimedCount >= (config.adminClaimLimit || 1)) {
    await interaction.reply({ content: `**الحد :** لا يمكنك استلام أكثر من ${config.adminClaimLimit} تكت مفتوح.`, ephemeral: true });
    return;
  }

  ticket.claimedBy = interaction.user.id;
  if (config.hideOnClaim) {
    await applyHideOnClaim(interaction.channel, interaction.guild, config, interaction.user.id, ticket.memberId, ticket.extraMembers || []);
  }

  const reason = config.reasons?.[ticket.reasonKey] || {};
  const claimImage = resolveImageForSend(reason.claimImage);
  if (claimImage) await interaction.channel.send({ files: [claimImage] }).catch(() => {});

  setGuildData(guildId, config, tickets, pendingRequests);
  await interaction.reply({ content: `**تم الاستلام :** <@${interaction.user.id}>` });
}

async function handleClaimFromRequest(interaction, reqId) {
  const guildId = reqId.split('_')[0];
  const { guild: g } = getGuildData(guildId);
  const { config, tickets, pendingRequests } = g;
  const req = pendingRequests[reqId];

  if (!req) {
    await interaction.reply({ content: '**انتهى الطلب.**', ephemeral: true });
    return;
  }

  if (!hasStaffAccess(interaction.member, config)) {
    await interaction.reply({ content: '**ليس لديك صلاحية الاستلام.**', ephemeral: true });
    return;
  }

  const claimedCount = countClaimedByAdmin(tickets, interaction.user.id);
  if (claimedCount >= (config.adminClaimLimit || 1)) {
    await interaction.reply({ content: `**الحد :** لا يمكنك استلام أكثر من ${config.adminClaimLimit} تكت مفتوح.`, ephemeral: true });
    return;
  }

  const member = await interaction.guild.members.fetch(req.userId).catch(() => null);
  if (!member) {
    delete pendingRequests[reqId];
    setGuildData(guildId, config, tickets, pendingRequests);
    await interaction.reply({ content: '**لا يمكن العثور على العضو.**', ephemeral: true });
    return;
  }

  const channel = await createTicketChannel({ guild: interaction.guild, member, config, reasonKey: req.reasonKey, tickets, pendingRequests });
  tickets[channel.id].claimedBy = interaction.user.id;

  if (config.hideOnClaim) {
    await applyHideOnClaim(channel, interaction.guild, config, interaction.user.id, member.id, tickets[channel.id].extraMembers || []);
  }

  const reason = config.reasons?.[req.reasonKey] || {};
  const claimImage = resolveImageForSend(reason.claimImage);
  if (claimImage) await channel.send({ files: [claimImage] }).catch(() => {});

  delete pendingRequests[reqId];
  setGuildData(guildId, config, tickets, pendingRequests);
  await interaction.reply({ content: `**تم الاستلام والانشاء :** <#${channel.id}>` });
}

async function handleClose(interaction, guildId, channelId) {
  const { guild: g } = getGuildData(guildId);
  const { config, tickets, pendingRequests } = g;
  const ticket = tickets[channelId];
  if (!ticket || interaction.channelId !== channelId) {
    await interaction.reply({ content: '**لا توجد بيانات لهذا التكت.**', ephemeral: true });
    return;
  }

  if (!canManageTicket(interaction, ticket, config)) {
    await interaction.reply({ content: '**ليس لديك صلاحية الاقفال.**', ephemeral: true });
    return;
  }

  ticket.status = 'closed';

  if (!config.keepClosedTickets) {
    delete tickets[channelId];
    setGuildData(guildId, config, tickets, pendingRequests);
    await interaction.reply({ content: '**سيتم حذف التكت خلال 3 ثواني.**' });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
    return;
  }

  const closePrefix = `closed-${sanitizeName(config.ticketNamePrefix || 'ticket')}`;
  await interaction.channel.setName(`${closePrefix}-${channelId.slice(-4)}`).catch(() => {});
  if (config.closedCategoryId) await interaction.channel.setParent(config.closedCategoryId).catch(() => {});

  setGuildData(guildId, config, tickets, pendingRequests);
  await interaction.reply({ content: '**تم اقفال التكت والاحتفاظ به.**' });
}

function createReasonComponents(config, guildId) {
  const reasons = Object.entries(config.reasons || {}).sort((a, b) => Number(a[0]) - Number(b[0])).slice(0, 25);
  if (config.displayMode === 'menu') {
    const options = reasons.length
      ? reasons.map(([k, v]) => ({ label: (v.name || `سبب ${k}`).slice(0, 100), value: `reason_${k}`, emoji: v.emoji || undefined }))
      : [{ label: 'فتح تكت عام', value: 'reason_0', emoji: '🎫' }];
    return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`ticket_open_menu_${guildId}`).setPlaceholder('اختر السبب').addOptions(options))];
  }

  const maxButtons = Math.max(1, Math.min(25, (config.buttonRows || 2) * 5));
  const entries = (reasons.length ? reasons : [['0', { name: 'فتح تكت', emoji: '🎫' }]]).slice(0, maxButtons);
  const buttons = entries.map(([k, v]) => new ButtonBuilder()
    .setCustomId(`ticket_open_btn_${guildId}_${k}`)
    .setLabel((v.name || `سبب ${k}`).slice(0, 80))
    .setStyle(ButtonStyle.Primary)
    .setEmoji(v.emoji || '🎫'));

  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  return rows;
}

async function execute(message, args, { BOT_OWNERS = [], ADMIN_ROLES = [] }) {
  const member = await message.guild.members.fetch(message.author.id);
  const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
  const hasAdminRole = member.roles.cache.some((r) => ADMIN_ROLES.includes(r.id));
  if (!isOwner && !hasAdminRole && !member.permissions.has(PermissionFlagsBits.Administrator)) {
    await message.react('❌');
    return;
  }

  const { guild: g } = getGuildData(message.guild.id);
  const { config, tickets, pendingRequests } = g;

  const controlChannel = message.channel;

  const ask = async (prompt, timeout = 180000) => {
    const promptMessage = await controlChannel.send({ content: prompt });
    const collected = await controlChannel.awaitMessages({
      filter: (m) => m.author.id === message.author.id,
      max: 1,
      time: timeout
    });
    const first = collected.first();
    await promptMessage.delete().catch(() => {});
    if (first) await first.delete().catch(() => {});
    return first ? first.content.trim() : null;
  };

  const buildSetupEmbed = () => {
    const reasonsCount = Object.keys(config.reasons || {}).length;
    return new EmbedBuilder()
      .setTitle(`**اعدادات التكت : ${message.guild.name}**`)
      .setDescription([
        '**اختر من المنيو للتعديل الفوري.**',
        `**اسم التكت :** ${config.ticketNamePrefix} - ${config.ticketNameMode}`,
        `**كاتوقري الفتح :** ${config.openCategoryId ? `<#${config.openCategoryId}>` : 'غير معين'}`,
        `**المسؤولين :** ${config.responsibleRoleIds.length}`,
        `**رولات الادمن :** ${config.useGlobalAdminRoles ? 'adminRoles العامة' : config.adminRoleIds.length}`,
        `**حد استلام الاداري :** ${config.adminClaimLimit}`,
        `**حد فتح العضو :** ${config.memberOpenLimit}`,
        `**انشاء قبل الاستلام :** ${config.autoCreateOnRequest ? 'مفعل' : 'مقفل'}`,
        `**اخفاء عند الاستلام :** ${config.hideOnClaim ? 'مفعل' : 'مقفل'}`,
        `**استلام من شات مخصص :** ${config.claimFromDedicatedChannel ? 'مفعل' : 'مقفل'}`,
        `**الاحتفاظ بعد الاغلاق :** ${config.keepClosedTickets ? 'مفعل' : 'مقفل'}`,
        `**طريقة العرض :** ${config.displayMode}`,
        `**عدد الاسباب :** ${reasonsCount}`,
        `**جاهزية النظام :** ${getSetupIssues().length === 0 ? 'مكتمل' : 'ناقص'}${getSetupIssues().length ? `\n${getSetupIssues().map((i) => `- ${i.replace(/\*\*/g, '')}`).join('\n')}` : ''}`
      ].join('\n'));
  };


  const getSetupIssues = () => {
    const issues = [];
    const adminRolesResolved = getAdminRoles(config);

    if (!config.openCategoryId) issues.push('**يلزم تعيين كاتوقري فتح التكت**');
    if ((config.responsibleRoleIds || []).length === 0) issues.push('**يلزم تعيين رولات المسؤولين**');
    if (adminRolesResolved.length === 0) issues.push('**يلزم تعيين رولات الادمن**');
    if (Object.keys(config.reasons || {}).length === 0) issues.push('**يلزم تعيين سبب واحد على الاقل**');

    if (config.claimFromDedicatedChannel && !config.claimChannelId) {
      issues.push('**تفعيل شات الاستلام يحتاج تعيين شات الاستلام**');
    }

    if (config.displayMode === 'buttons') {
      if (!Number.isFinite(config.buttonRows) || config.buttonRows < 1 || config.buttonRows > 5) {
        issues.push('**عدد صفوف الازرار يجب ان يكون بين 1 و 5**');
      }
    }

    return issues;
  };

  const assertSetupReady = async (interaction, actionLabel = 'تنفيذ العملية') => {
    const issues = getSetupIssues();
    if (issues.length === 0) return true;
    await refresh(interaction, `**لا يمكن ${actionLabel} قبل اكمال المتطلبات :**\n${issues.join('\n')}`);
    return false;
  };

  const buildMenuComponents = () => {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`ticket_setup_menu_${message.author.id}_${Date.now()}`)
      .setPlaceholder('اختر اعداد التكت')
      .addOptions([
        { label: '1) اسم شات التكت', value: 'set_name' },
        { label: '2) كاتوقري الفتح', value: 'set_open_category' },
        { label: '3) تحديد المسؤولين', value: 'set_responsibles' },
        { label: '4) تحديد رولات الادمن', value: 'set_admin_roles' },
        { label: '5) حد استلام الاداري', value: 'set_admin_limit' },
        { label: '6) حد فتح العضو', value: 'set_member_limit' },
        { label: '7) انشاء قبل الاستلام (toggle)', value: 'toggle_auto_create' },
        { label: '8) اخفاء عند الاستلام (toggle)', value: 'toggle_hide_on_claim' },
        { label: '9) الاستلام من شات مخصص', value: 'toggle_claim_channel' },
        { label: '10) الاحتفاظ بعد الاغلاق', value: 'toggle_keep_closed' },
        { label: '11) اعدادات الرسائل', value: 'set_messages' },
        { label: '12) تعيين الاسباب', value: 'set_reasons' },
        { label: '13) طريقة العرض', value: 'set_display_mode' },
        { label: '14) ارسال بانل التكت', value: 'send_panel_now' },
        { label: 'انهاء الاعداد', value: 'finish' }
      ]);

    return [new ActionRowBuilder().addComponents(menu)];
  };

  await message.channel.send('**سيتم ضبط الاعدادات هنا، ومدخلاتك النصية ستحذف تلقائياً للحفاظ على الخصوصية.**').catch(() => {});

  const setupMessage = await controlChannel.send({ embeds: [buildSetupEmbed()], components: buildMenuComponents() });

  const collector = setupMessage.createMessageComponentCollector({
    filter: (i) => i.user.id === message.author.id,
    time: 30 * 60 * 1000
  });

  const refresh = async (interaction, note = null) => {
    setGuildData(message.guild.id, config, tickets, pendingRequests);
    await interaction.update({
      content: note || null,
      embeds: [buildSetupEmbed()],
      components: buildMenuComponents()
    });
  };

  collector.on('collect', async (interaction) => {
    try {
      const choice = interaction.values?.[0];
      if (!choice) return;

      if (choice === 'finish') {
        collector.stop('finished');
        await interaction.update({ embeds: [buildSetupEmbed()], components: [] });
        return;
      }

      if (choice === 'set_name') {
        const mode = await ask('**اكتب : counter او user (او 0 لاعادة التعيين)**');
        if (mode === '0') {
          config.ticketNameMode = 'counter';
          config.ticketNamePrefix = 'ticket';
        } else if (['counter', 'user'].includes((mode || '').toLowerCase())) {
          config.ticketNameMode = mode.toLowerCase();
          const prefix = await ask('**اكتب : بادئة اسم التكت**');
          if (prefix && prefix !== '0') config.ticketNamePrefix = sanitizeName(prefix);
        }
        await refresh(interaction, '**تم تحديث الاسم.**');
        return;
      }

      if (choice === 'set_open_category') {
        const v = await ask('**ارسل : منشن/ايدي الكاتوقري (0 لاعادة التعيين)**');
        config.openCategoryId = v === '0' ? null : normalizeId(v);
        await refresh(interaction, '**تم تحديث كاتوقري الفتح.**');
        return;
      }

      if (choice === 'set_responsibles') {
        const v = await ask('**ارسل : رولات المسؤولين (منشن/ايدي) او file او 0**');
        if (v === '0') config.responsibleRoleIds = [];
        else if ((v || '').toLowerCase() === 'file') {
          const resp = loadResponsibilities();
          const set = new Set();
          for (const item of Object.values(resp || {})) {
            for (const role of (item.roles || [])) set.add(role);
          }
          config.responsibleRoleIds = [...set];
        } else {
          config.responsibleRoleIds = (v || '').split(/\s+/).map(normalizeId).filter(Boolean);
        }
        if (config.responsibleRoleIds.length === 0) {
          await refresh(interaction, '**تنبيه : لم يتم حفظ اي رول مسؤول صالح.**');
          return;
        }
        await refresh(interaction, '**تم تحديث المسؤولين.**');
        return;
      }

      if (choice === 'set_admin_roles') {
        const v = await ask('**ارسل : رولات الادمن (منشن/ايدي) او 0 لاستخدام الادمن رولز العامة**');
        if (v === '0') {
          config.useGlobalAdminRoles = true;
          config.adminRoleIds = [];
        } else {
          config.useGlobalAdminRoles = false;
          config.adminRoleIds = (v || '').split(/\s+/).map(normalizeId).filter(Boolean);
        }
        if (getAdminRoles(config).length === 0) {
          await refresh(interaction, '**تنبيه : لا توجد رولات ادمن فعالة بعد التحديث.**');
          return;
        }
        await refresh(interaction, '**تم تحديث رولات الادمن.**');
        return;
      }

      if (choice === 'set_admin_limit') {
        const n = Number(await ask('**اكتب : حد استلام الاداري المفتوح**'));
        if (Number.isFinite(n) && n > 0) config.adminClaimLimit = n;
        await refresh(interaction, '**تم تحديث حد استلام الاداري.**');
        return;
      }

      if (choice === 'set_member_limit') {
        const n = Number(await ask('**اكتب : حد فتح العضو المفتوح**'));
        if (Number.isFinite(n) && n > 0) config.memberOpenLimit = n;
        await refresh(interaction, '**تم تحديث حد فتح العضو.**');
        return;
      }

      if (choice === 'toggle_auto_create') {
        config.autoCreateOnRequest = !config.autoCreateOnRequest;
        await refresh(interaction, `**تم التحديث : ${config.autoCreateOnRequest ? 'مفعل' : 'مقفل'}**`);
        return;
      }

      if (choice === 'toggle_hide_on_claim') {
        config.hideOnClaim = !config.hideOnClaim;
        await refresh(interaction, `**تم التحديث : ${config.hideOnClaim ? 'مفعل' : 'مقفل'}**`);
        return;
      }

      if (choice === 'toggle_claim_channel') {
        config.claimFromDedicatedChannel = !config.claimFromDedicatedChannel;
        if (config.claimFromDedicatedChannel) {
          const askedChannel = normalizeId(await ask('**ارسل : منشن/ايدي شات الاستلام**'));
          const channelObj = askedChannel ? await message.guild.channels.fetch(askedChannel).catch(() => null) : null;
          if (!channelObj || channelObj.type !== ChannelType.GuildText) {
            config.claimFromDedicatedChannel = false;
            config.claimChannelId = null;
            await refresh(interaction, '**فشل : شات الاستلام غير صالح وتم الغاء التفعيل.**');
            return;
          }
          config.claimChannelId = askedChannel;
          const sep = await ask('**ارسل : فاصلة شات الاستلام (0 للتفريغ)**');
          config.claimChannelSeparator = sep === '0' ? '' : (sep || config.claimChannelSeparator);
        }
        await refresh(interaction, `**تم التحديث : ${config.claimFromDedicatedChannel ? 'مفعل' : 'مقفل'}**`);
        return;
      }

      if (choice === 'toggle_keep_closed') {
        config.keepClosedTickets = !config.keepClosedTickets;
        if (config.keepClosedTickets) {
          const v = await ask('**ارسل : كاتوقري المقفلة (0 للبقاء بنفس المكان)**');
          config.closedCategoryId = v === '0' ? null : normalizeId(v);
        }
        await refresh(interaction, `**تم التحديث : ${config.keepClosedTickets ? 'مفعل' : 'مقفل'}**`);
        return;
      }

      if (choice === 'set_messages') {
        const c = await ask('**الرسائل : 1 قبول - 2 قبل الصورة - 3 صورة - 4 بعد الصورة**');
        if (c === '1') { const v = await ask('**رسالة القبول : (0 لاعادة التعيين)**'); config.messages.acceptance = v === '0' ? '' : (v || ''); }
        if (c === '2') { const v = await ask('**قبل الصورة : (0 لاعادة التعيين)**'); config.messages.beforeImage = v === '0' ? '' : (v || ''); }
        if (c === '3') {
          const v = await ask('**رابط الصورة : (0 لاعادة التعيين)**');
          if (v === '0') {
            removeStoredImage(config.messages.ticketImage);
            config.messages.ticketImage = '';
          } else if (v) {
            try {
              config.messages.ticketImage = await storeImageLocally(v, message.guild.id, 'global_ticket_image', config.messages.ticketImage);
            } catch {
              await refresh(interaction, '**فشل تحميل الصورة، تأكد أن الرابط مباشر لصورة.**');
              return;
            }
          }
        }
        if (c === '4') { const v = await ask('**بعد الصورة : (0 لاعادة التعيين)**'); config.messages.afterImage = v === '0' ? '' : (v || ''); }
        await refresh(interaction, '**تم تحديث الرسائل.**');
        return;
      }

      if (choice === 'set_reasons') {
        if (!config.openCategoryId) {
          await refresh(interaction, '**يلزم تعيين كاتوقري الفتح قبل تعديل الاسباب.**');
          return;
        }
        const idx = Number(await ask('**اختر : رقم السبب من 1 الى 25**'));
        if (Number.isFinite(idx) && idx >= 1 && idx <= 25) {
          const key = String(idx);
          const reason = {
            name: `سبب ${idx}`,
            ticketName: '',
            openImage: '',
            emoji: '🎫',
            categoryId: null,
            claimImage: '',
            beforeImage: '',
            afterImage: '',
            ...(config.reasons[key] || {})
          };

          const c = await ask('**السبب : 1 الاسم - 2 اسم التكت - 3 صورة فتح - 4 ايموجي - 5 كاتوقري - 6 صورة استلام - 7 قبل/بعد**');
          if (c === '1') { const v = await ask('**اسم السبب : (0 لاعادة التعيين)**'); reason.name = v === '0' ? `سبب ${idx}` : (v || reason.name); }
          if (c === '2') { const v = await ask('**اسم التكت : (0 لاعادة التعيين)**'); reason.ticketName = v === '0' ? '' : (v || reason.ticketName); }
          if (c === '3') {
            const v = await ask('**صورة الفتح : (0 لاعادة التعيين)**');
            if (v === '0') {
              removeStoredImage(reason.openImage);
              reason.openImage = '';
            } else if (v) {
              try {
                reason.openImage = await storeImageLocally(v, message.guild.id, `reason_${key}_open`, reason.openImage);
              } catch {
                await refresh(interaction, '**فشل تحميل صورة الفتح، تأكد أن الرابط مباشر لصورة.**');
                return;
              }
            }
          }
          if (c === '4') { const v = await ask('**ايموجي : (0 لاعادة التعيين)**'); reason.emoji = v === '0' ? '🎫' : (v || reason.emoji); }
          if (c === '5') { const v = await ask('**كاتوقري : (0 لاعادة التعيين)**'); reason.categoryId = v === '0' ? null : normalizeId(v); }
          if (c === '6') {
            const v = await ask('**صورة الاستلام : (0 لاعادة التعيين)**');
            if (v === '0') {
              removeStoredImage(reason.claimImage);
              reason.claimImage = '';
            } else if (v) {
              try {
                reason.claimImage = await storeImageLocally(v, message.guild.id, `reason_${key}_claim`, reason.claimImage);
              } catch {
                await refresh(interaction, '**فشل تحميل صورة الاستلام، تأكد أن الرابط مباشر لصورة.**');
                return;
              }
            }
          }
          if (c === '7') {
            const b = await ask('**قبل الصورة : (0 لاعادة التعيين)**');
            const a = await ask('**بعد الصورة : (0 لاعادة التعيين)**');
            reason.beforeImage = b === '0' ? '' : (b || reason.beforeImage);
            reason.afterImage = a === '0' ? '' : (a || reason.afterImage);
          }
          config.reasons[key] = reason;
        }
        await refresh(interaction, '**تم تحديث السبب.**');
        return;
      }

      if (choice === 'set_display_mode') {
        const mode = await ask('**اكتب : buttons او menu**');
        if (['buttons', 'menu'].includes((mode || '').toLowerCase())) {
          config.displayMode = mode.toLowerCase();
          if (config.displayMode === 'buttons') {
            const rows = Number(await ask('**عدد الصفوف : من 1 الى 5**'));
            if (Number.isFinite(rows) && rows >= 1 && rows <= 5) config.buttonRows = rows;
          }
        }
        await refresh(interaction, '**تم تحديث طريقة العرض.**');
        return;
      }

      if (choice === 'send_panel_now') {
        if (!(await assertSetupReady(interaction, 'ارسال البانل'))) return;
        const panelChannel = await message.guild.channels.fetch(normalizeId(await ask('**ارسل : الشات (منشن/ايدي)**'))).catch(() => null);
        if (!panelChannel || panelChannel.type !== ChannelType.GuildText) {
          await refresh(interaction, '**فشل : شات غير صالح.**');
          return;
        }

        const mode = (await ask('**طريقة الارسال : text / image / both**')) || 'both';
        const text = mode === 'image' ? '' : await ask('**النص : (0 لتخطي)**');
        const image = mode === 'text' ? '' : await ask('**الصورة : رابط مباشر (0 لتخطي)**');

        await panelChannel.send({
          content: text && text !== '0' ? text : null,
          files: image && image !== '0' ? [image] : [],
          components: createReasonComponents(config, message.guild.id)
        });

        await refresh(interaction, '**تم ارسال البانل بنجاح.**');
        return;
      }

      await interaction.deferUpdate().catch(() => {});
    } catch {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '**حدث خطأ اثناء تحديث الاعدادات.**', ephemeral: true }).catch(() => {});
      }
    }
  });

  collector.on('end', async () => {
    setGuildData(message.guild.id, config, tickets, pendingRequests);
    await setupMessage.edit({ embeds: [buildSetupEmbed()], components: [] }).catch(() => {});
    await controlChannel.send('**تم حفظ اعدادات التكت.**').catch(() => {});
  });
}

async function handleTransferResponsibility(interaction, guildId, channelId, value) {
  const respName = value.replace('resp_', '');
  if (!respName || respName === 'none') {
    await interaction.reply({ content: '**لا توجد مسؤولية صالحة.**', ephemeral: true });
    return;
  }

  const { guild: g } = getGuildData(guildId);
  const { config, tickets, pendingRequests } = g;
  const ticket = tickets[channelId];
  if (!ticket || interaction.channelId !== channelId) {
    await interaction.reply({ content: '**لا توجد بيانات لهذا التكت.**', ephemeral: true });
    return;
  }

  if (!canManageTicket(interaction, ticket, config)) {
    await interaction.reply({ content: '**ليس لديك صلاحية التحويل.**', ephemeral: true });
    return;
  }

  const responsibilities = loadResponsibilities();
  const selected = responsibilities[respName];
  if (!selected) {
    await interaction.reply({ content: '**المسؤولية غير موجودة.**', ephemeral: true });
    return;
  }

  ticket.claimedBy = null;

  const targetRoles = selected.roles || [];
  const adminRoles = getAdminRoles(config);
  const allKnownRoles = [...new Set([...(config.responsibleRoleIds || []), ...targetRoles])];

  for (const roleId of allKnownRoles) {
    const shouldSee = targetRoles.includes(roleId) || adminRoles.includes(roleId);
    await interaction.channel.permissionOverwrites.edit(roleId, {
      ViewChannel: shouldSee,
      SendMessages: shouldSee,
      ReadMessageHistory: shouldSee
    }).catch(() => {});
  }

  config.responsibleRoleIds = [...targetRoles];
  setGuildData(guildId, config, tickets, pendingRequests);

  const mentions = [
    ...(selected.roles || []).map((id) => `<@&${id}>`),
    ...(selected.responsibles || []).map((id) => `<@${id}>`)
  ];

  await interaction.reply({
    content: `**تم تحويل التكت لمسؤوليين : ${respName}**\n${mentions.join(' ') || '**لا يوجد منشن محدد**'}`
  });
}

async function showInputModal(interaction, customId, title, label, placeholder = '') {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder(placeholder)
    .setMaxLength(100);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

function registerHandlers(client) {
  if (handlersRegistered) return;
  handlersRegistered = true;

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const id = interaction.customId || '';

        if (id.startsWith('ticket_open_btn_')) {
          const [, , , guildId, reasonKey] = id.split('_');
          await handleOpenRequest(interaction, guildId, reasonKey);
          return;
        }

        if (interaction.isStringSelectMenu() && id.startsWith('ticket_open_menu_')) {
          const guildId = id.replace('ticket_open_menu_', '');
          const value = interaction.values?.[0] || 'reason_0';
          const reasonKey = value.replace('reason_', '');
          await handleOpenRequest(interaction, guildId, reasonKey);
          return;
        }

        if (id.startsWith('ticket_claimreq_')) {
          const reqId = id.replace('ticket_claimreq_', '');
          await handleClaimFromRequest(interaction, reqId);
          return;
        }

        if (id.startsWith('ticket_claim_')) {
          const [, , guildId, channelId] = id.split('_');
          await handleClaimInTicket(interaction, guildId, channelId);
          return;
        }

        if (id.startsWith('ticket_close_')) {
          const [, , guildId, channelId] = id.split('_');
          await handleClose(interaction, guildId, channelId);
          return;
        }

        if (id.startsWith('ticket_rename_')) {
          const [, , guildId, channelId] = id.split('_');
          const { guild: g } = getGuildData(guildId);
          const { config, tickets } = g;
          const ticket = tickets[channelId];
          if (!ticket || !canManageTicket(interaction, ticket, config)) {
            await interaction.reply({ content: '**ليس لديك صلاحية تغيير الاسم.**', ephemeral: true });
            return;
          }
          await showInputModal(interaction, `ticket_rename_modal_${guildId}_${channelId}`, 'تغيير اسم التكت', 'الاسم الجديد', 'مثال : support-user');
          return;
        }

        if (id.startsWith('ticket_add_')) {
          const [, , guildId, channelId] = id.split('_');
          const { guild: g } = getGuildData(guildId);
          const { config, tickets } = g;
          const ticket = tickets[channelId];
          if (!ticket || !canManageTicket(interaction, ticket, config)) {
            await interaction.reply({ content: '**ليس لديك صلاحية الاضافة.**', ephemeral: true });
            return;
          }
          await showInputModal(interaction, `ticket_add_modal_${guildId}_${channelId}`, 'اضافة شخص للتكت', 'ايدي او منشن الشخص');
          return;
        }

        if (id.startsWith('ticket_remove_')) {
          const [, , guildId, channelId] = id.split('_');
          const { guild: g } = getGuildData(guildId);
          const { config, tickets } = g;
          const ticket = tickets[channelId];
          if (!ticket || !canManageTicket(interaction, ticket, config)) {
            await interaction.reply({ content: '**ليس لديك صلاحية الازالة.**', ephemeral: true });
            return;
          }
          await showInputModal(interaction, `ticket_remove_modal_${guildId}_${channelId}`, 'ازالة شخص من التكت', 'ايدي او منشن الشخص');
          return;
        }

        if (id.startsWith('ticket_ping_')) {
          const [, , guildId, channelId] = id.split('_');
          const { guild: g } = getGuildData(guildId);
          const { tickets, config, pendingRequests } = g;
          const ticket = tickets[channelId];
          if (!ticket || interaction.channelId !== channelId) {
            await interaction.reply({ content: '**لا توجد بيانات لهذا التكت.**', ephemeral: true });
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply({ content: '**ليس لديك صلاحية الاستدعاء.**', ephemeral: true });
            return;
          }
          const user = await client.users.fetch(ticket.memberId).catch(() => null);
          const link = `https://discord.com/channels/${interaction.guild.id}/${interaction.channel.id}`;
          if (user) {
            await user.send(`**تنبيه :** تم استدعاؤك للتكت\n**الرابط :** ${link}`).catch(() => {});
          }
          setGuildData(guildId, config, tickets, pendingRequests);
          await interaction.reply({ content: `**تم استدعاء العضو :** <@${ticket.memberId}>` });
          return;
        }

        if (interaction.isStringSelectMenu() && id.startsWith('ticket_transfer_')) {
          const [, , guildId, channelId] = id.split('_');
          const selected = interaction.values?.[0] || 'resp_none';
          await handleTransferResponsibility(interaction, guildId, channelId, selected);
          return;
        }
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket_')) {
        const modalId = interaction.customId;

        if (modalId.startsWith('ticket_rename_modal_')) {
          const [, , , guildId, channelId] = modalId.split('_');
          const newName = sanitizeName(interaction.fields.getTextInputValue('value'));
          if (!newName) {
            await interaction.reply({ content: '**الاسم غير صالح.**', ephemeral: true });
            return;
          }
          const { guild: g } = getGuildData(guildId);
          const { config, tickets } = g;
          const ticket = tickets[channelId];
          if (!ticket || interaction.channelId !== channelId) {
            await interaction.reply({ content: '**لا توجد بيانات لهذا التكت.**', ephemeral: true });
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply({ content: '**ليس لديك صلاحية تغيير الاسم.**', ephemeral: true });
            return;
          }
          await interaction.channel.setName(newName).catch(() => {});
          await interaction.reply({ content: `**تم تغيير الاسم :** ${newName}` });
          return;
        }

        if (modalId.startsWith('ticket_add_modal_')) {
          const [, , , guildId, channelId] = modalId.split('_');
          const userId = normalizeId(interaction.fields.getTextInputValue('value'));
          if (!userId) {
            await interaction.reply({ content: '**المدخل غير صالح.**', ephemeral: true });
            return;
          }
          const { guild: g } = getGuildData(guildId);
          const { config, tickets, pendingRequests } = g;
          const ticket = tickets[channelId];
          if (!ticket || interaction.channelId !== channelId) {
            await interaction.reply({ content: '**لا توجد بيانات لهذا التكت.**', ephemeral: true });
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply({ content: '**ليس لديك صلاحية الاضافة.**', ephemeral: true });
            return;
          }
          if (ticket.memberId === userId) {
            await interaction.reply({ content: '**الشخص هو صاحب التكت بالفعل.**', ephemeral: true });
            return;
          }
          const targetMember = await interaction.guild.members.fetch(userId).catch(() => null);
          if (!targetMember) {
            await interaction.reply({ content: '**لا يمكن العثور على العضو.**', ephemeral: true });
            return;
          }
          await interaction.channel.permissionOverwrites.edit(userId, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true
          }).catch(() => {});
          if (!ticket.extraMembers.includes(userId)) ticket.extraMembers.push(userId);
          setGuildData(guildId, config, tickets, pendingRequests);
          await interaction.reply({ content: `**تم اضافة الشخص :** <@${userId}>` });
          return;
        }

        if (modalId.startsWith('ticket_remove_modal_')) {
          const [, , , guildId, channelId] = modalId.split('_');
          const userId = normalizeId(interaction.fields.getTextInputValue('value'));
          if (!userId) {
            await interaction.reply({ content: '**المدخل غير صالح.**', ephemeral: true });
            return;
          }
          const { guild: g } = getGuildData(guildId);
          const { config, tickets, pendingRequests } = g;
          const ticket = tickets[channelId];
          if (!ticket || interaction.channelId !== channelId) {
            await interaction.reply({ content: '**لا توجد بيانات لهذا التكت.**', ephemeral: true });
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply({ content: '**ليس لديك صلاحية الازالة.**', ephemeral: true });
            return;
          }
          if (ticket.memberId === userId) {
            await interaction.reply({ content: '**لا يمكن إزالة صاحب التكت.**', ephemeral: true });
            return;
          }
          await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: false }).catch(() => {});
          ticket.extraMembers = (ticket.extraMembers || []).filter((id) => id !== userId);
          setGuildData(guildId, config, tickets, pendingRequests);
          await interaction.reply({ content: `**تم ازالة الشخص :** <@${userId}>` });
          return;
        }
      }
    } catch {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '**حدث خطأ أثناء معالجة التكت.**', ephemeral: true }).catch(() => {});
      }
    }
  });
}

module.exports = { name, aliases, execute, registerHandlers };
