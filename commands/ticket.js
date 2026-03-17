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
const { registerTicketInteractionRouter } = require('../utils/ticketInteractionRouter');

const name = 'ticket';
const aliases = ['تكت'];
const dataPath = path.join(__dirname, '..', 'data', 'ticketConfig.json');
const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
const ticketImagesDir = path.join(__dirname, '..', 'data', 'ticket_images');

let handlersRegistered = false;
const pingCooldowns = new Map();

function makeTicketEmbed(title, description, color = 0x5865F2) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description || null);
}

function buildPostCloseControls(guildId, channelId, ticket = {}) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_down_${guildId}_${channelId}`).setLabel('-1').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_delete_${guildId}_${channelId}`).setLabel('حذف').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket_up1_${guildId}_${channelId}`).setLabel('1').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ticket_up2_${guildId}_${channelId}`).setLabel('2').setStyle(ButtonStyle.Success)
  );

  const memberHidden = ticket.memberHidden !== false;
  const claimerHidden = ticket.claimerHidden !== false;
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_toggle_member_${guildId}_${channelId}`)
      .setLabel(memberHidden ? 'ارجاع العضو' : 'اخفاء العضو')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ticket_toggle_claimer_${guildId}_${channelId}`)
      .setLabel(claimerHidden ? 'ارجاع المسؤول' : 'اخفاء المسؤول')
      .setStyle(ButtonStyle.Primary)
  );

  return [row1, row2];
}

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


function formatSettingValue(value, fallback = 'غير مضبوط') {
  if (value === null || value === undefined || value === '') return fallback;
  const text = String(value);
  if (text.startsWith('local:')) return `محلي (${text.slice(6)})`;
  if (/^https?:\/\//i.test(text)) return text.length > 90 ? `${text.slice(0, 90)}...` : text;
  return text.length > 90 ? `${text.slice(0, 90)}...` : text;
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
  let roleIds = [];

  if (member?.roles?.cache) roleIds = [...member.roles.cache.keys()];
  else if (Array.isArray(member?.roles)) roleIds = member.roles;
  else if (Array.isArray(member?.roles?.value)) roleIds = member.roles.value;
  else if (Array.isArray(member?.roles?.ids)) roleIds = member.roles.ids;

  const hasRole = roleIds.some((id) => adminRoles.includes(id) || (config.responsibleRoleIds || []).includes(id));
  const isAdmin = member?.permissions?.has?.(PermissionFlagsBits.Administrator) || false;
  return hasRole || isAdmin;
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
  const responsibilityNames = Object.keys(responsibilities).slice(0, 25);
  const options = responsibilityNames
    .map((respName, index) => ({ label: respName.slice(0, 100), value: `respidx_${index}` }));

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
  const memberId = member?.id || member?.user?.id || null;
  if (!memberId) {
    throw new Error('MEMBER_ID_MISSING');
  }

  const memberUsername = member?.user?.username || member?.displayName || 'user';
  const suffix = config.ticketNameMode === 'user' ? sanitizeName(memberUsername) : String(config.counter || 1);
  const channelName = `${prefix}-${suffix}`.slice(0, 90);
  const categoryId = reason.categoryId || config.openCategoryId || null;

  const adminRoles = getAdminRoles(config);
  const allowedStaffRoles = [...new Set([...(config.responsibleRoleIds || []), ...adminRoles])]
    .map((roleId) => String(roleId || '').trim())
    .filter((roleId) => /^\d{16,20}$/.test(roleId) && guild.roles.cache.has(roleId));

  const permissionOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: memberId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
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
    embeds: [
      makeTicketEmbed(
        'التكت : تم الانشاء',
        `**التكت :** ${reason.name || `سبب ${reasonKey}`}\n**العضو :** <@${memberId}>`
      )
    ],
    components: controls
  });

  if (config.ticketNameMode !== 'user') config.counter = (config.counter || 1) + 1;

  tickets[channel.id] = {
    channelId: channel.id,
    memberId,
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
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const guild = interaction.guild;
  const { guild: g } = getGuildData(guildId);
  const { config, tickets, pendingRequests } = g;

  const openCount = countOpenMemberTickets(tickets, interaction.user.id);
  if (openCount >= (config.memberOpenLimit || 1)) {
    await interaction.editReply({ embeds: [makeTicketEmbed('تنبيه', `**الحد : وصلت لاقصى تكت مفتوح (${config.memberOpenLimit}).**`, 0xED4245)] });
    return;
  }

  if (config.autoCreateOnRequest) {
    try {
      const channel = await createTicketChannel({ guild, member: interaction.member, config, reasonKey, tickets, pendingRequests });
      await interaction.editReply({ embeds: [makeTicketEmbed('تم', `**تم انشاء التكت :** <#${channel.id}>`, 0x57F287)] });
    } catch (error) {
      console.error('ticket open create channel error:', error?.message || error);
      await interaction.editReply({ embeds: [makeTicketEmbed('خطأ', '**فشل فتح التكت، تأكد من صلاحيات البوت والكاتوقري.**', 0xED4245)] });
    }
    return;
  }

  const reqId = `${guildId}_${interaction.user.id}_${Date.now()}`;
  pendingRequests[reqId] = { guildId, userId: interaction.user.id, reasonKey, sourceChannelId: interaction.channelId, createdAt: Date.now() };

  const targetChannelId = config.claimFromDedicatedChannel ? config.claimChannelId : interaction.channelId;
  const targetChannel = await guild.channels.fetch(targetChannelId).catch(() => null);
  if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
    delete pendingRequests[reqId];
    setGuildData(guildId, config, tickets, pendingRequests);
    await interaction.editReply({ embeds: [makeTicketEmbed('خطأ', '**فشل : شات الاستلام غير صالح.**', 0xED4245)] });
    return;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_claimreq_${reqId}`).setStyle(ButtonStyle.Primary).setLabel('استلام التكت')
  );

  if (config.messages.acceptance) {
    await targetChannel.send({ embeds: [makeTicketEmbed('قبول التكت', config.messages.acceptance)] });
  }
  if (config.claimFromDedicatedChannel && config.claimChannelSeparator) {
    const separatorValue = config.claimChannelSeparator;
    const separatorImage = resolveImageForSend(separatorValue);
    if (separatorImage && (String(separatorValue).startsWith('local:') || /^https?:\/\//i.test(String(separatorValue)))) {
      await targetChannel.send({ files: [separatorImage] }).catch(() => {});
    } else {
      await targetChannel.send({ content: separatorValue }).catch(() => {});
    }
  }

  await targetChannel.send({
    embeds: [makeTicketEmbed('طلب تكت', `**العضو :** <@${interaction.user.id}>\n**السبب :** ${config.reasons?.[reasonKey]?.name || `سبب ${reasonKey}`}`)],
    components: [row]
  });

  setGuildData(guildId, config, tickets, pendingRequests);
  await interaction.editReply({ embeds: [makeTicketEmbed('تم', '**تم ارسال طلبك لشات الاستلام.**', 0x57F287)] });
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

  if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) {
    await interaction.reply({ embeds: [makeTicketEmbed('تنبيه', `**التكت مستلم مسبقاً بواسطة :** <@${ticket.claimedBy}>`, 0xED4245)], ephemeral: true });
    return;
  }

  if (ticket.claimedBy === interaction.user.id) {
    await interaction.reply({ embeds: [makeTicketEmbed('تنبيه', '**أنت مستلم هذا التكت بالفعل.**', 0xED4245)], ephemeral: true });
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

  setGuildData(guildId, config, tickets, pendingRequests);
  if (interaction.message?.components?.length) {
    const updatedRows = interaction.message.components.map((row) => {
      const updatedComponents = row.components.map((component) => {
        if (component.customId?.startsWith('ticket_claim_')) {
          return ButtonBuilder.from(component).setDisabled(true).setLabel('تم الاستلام');
        }
        return component;
      });
      return new ActionRowBuilder().addComponents(updatedComponents);
    });
    await interaction.message.edit({ components: updatedRows }).catch(() => {});
  }
  await interaction.reply({ embeds: [makeTicketEmbed('تم استلام التكت', `**المستلم :** <@${interaction.user.id}>`, 0x57F287)] });
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

  let channel;
  try {
    channel = await createTicketChannel({ guild: interaction.guild, member, config, reasonKey: req.reasonKey, tickets, pendingRequests });
  } catch (error) {
    console.error('ticket claimreq create channel error:', error?.message || error);
    await interaction.reply({ content: '**فشل انشاء التكت من طلب الاستلام، تأكد من صلاحيات البوت والكاتوقري.**', ephemeral: true });
    return;
  }
  tickets[channel.id].claimedBy = interaction.user.id;

  if (config.hideOnClaim) {
    await applyHideOnClaim(channel, interaction.guild, config, interaction.user.id, member.id, tickets[channel.id].extraMembers || []);
  }

  delete pendingRequests[reqId];
  setGuildData(guildId, config, tickets, pendingRequests);
  await interaction.reply({ embeds: [makeTicketEmbed('تم استلام التكت', `**تم الاستلام والانشاء :** <#${channel.id}>`, 0x57F287)] });
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
  if (ticket.closedAt) {
    await interaction.reply({ embeds: [makeTicketEmbed('تنبيه', '**التكت مقفل مسبقاً.**', 0xED4245)], ephemeral: true });
    return;
  }
  ticket.closedAt = Date.now();
  ticket.memberHidden = true;
  ticket.claimerHidden = true;

  if (!config.keepClosedTickets) {
    delete tickets[channelId];
    setGuildData(guildId, config, tickets, pendingRequests);
    await interaction.reply({ embeds: [makeTicketEmbed('اقفال', '**سيتم حذف التكت خلال 3 ثواني.**', 0xED4245)], ephemeral: true });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
    return;
  }

  if (ticket.memberId) {
    await interaction.channel.permissionOverwrites.edit(ticket.memberId, {
      ViewChannel: false,
      SendMessages: false
    }).catch(() => {});
  }
  if (ticket.claimedBy) {
    await interaction.channel.permissionOverwrites.edit(ticket.claimedBy, {
      ViewChannel: false,
      SendMessages: false
    }).catch(() => {});
  }

  if (interaction.message?.editable) {
    await interaction.message.edit({ components: [] }).catch(() => {});
  }

  const closePrefix = `closed-${sanitizeName(config.ticketNamePrefix || 'ticket')}`;
  await interaction.channel.setName(`${closePrefix}-${channelId.slice(-4)}`).catch(() => {});
  if (config.closedCategoryId) await interaction.channel.setParent(config.closedCategoryId).catch(() => {});

  await interaction.channel.send({
    embeds: [makeTicketEmbed('التكت مقفل', '**تم إقفال التكت، يمكنك استخدام أزرار الإدارة بالأسفل.**', 0xED4245)],
    components: buildPostCloseControls(guildId, channelId, ticket)
  }).catch(() => {});

  setGuildData(guildId, config, tickets, pendingRequests);
  await interaction.reply({ embeds: [makeTicketEmbed('اقفال', '**تم اقفال التكت والاحتفاظ به.**', 0xED4245)], ephemeral: true });
}

function createReasonComponents(config, guildId) {
  const reasons = Object.entries(config.reasons || {}).sort((a, b) => Number(a[0]) - Number(b[0])).slice(0, 25);
  if (config.displayMode === 'menu') {
    const options = reasons.length
      ? reasons.map(([k, v]) => ({ label: (v.name || `سبب ${k}`).slice(0, 100), description: (v.description || '').slice(0, 100) || undefined, value: `reason_${k}`, emoji: v.emoji || undefined }))
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
  let setupMessage = null;
  let activePromptInteraction = null;

  const ask = async (prompt, timeout = 180000) => {
    if (activePromptInteraction) {
      await activePromptInteraction.followUp({ content: `🔒 ${prompt}`, ephemeral: true }).catch(() => {});
    }

    const collected = await controlChannel.awaitMessages({
      filter: (m) => m.author.id === message.author.id,
      max: 1,
      time: timeout
    });
    const first = collected.first();
    if (first) await first.delete().catch(() => {});
    if (!first) return null;

    const text = (first.content || '').trim();
    if (text) return text;

    const attachment = first.attachments?.first?.();
    return attachment?.url || null;
  };

  const buildSetupEmbed = () => {
    const reasonsCount = Object.keys(config.reasons || {}).length;
    return new EmbedBuilder()
      .setTitle(`**اعدادات التكت : ${message.guild.name}**`)
      .setDescription([
        '**اختر من المنيو للتعديل الفوري.**',
        '**ملاحظة:** مدخلاتك للحقول تُحذف تلقائياً بعد حفظها.',
        '**شرح الخيارات:**',
        '- **اعدادات الرسائل:** رسائل نصية فقط مع مكان ظهور كل رسالة.',
        '- **اعدادات الصور:** كل صور النظام (فتح/استلام/فاصل/صورة بانل ثابتة).',
        '- **تعيين الاسباب:** الاسم/الايموجي/الوصف/الكاتوقري ورسائل السبب.',
        '- **طريقة العرض:** ازرار أو منيو مع وصف لكل سبب في وضع المنيو.',
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

  const assertSetupReady = async (actionLabel = 'تنفيذ العملية') => {
    const issues = getSetupIssues();
    if (issues.length === 0) return true;
    await refresh(`**لا يمكن ${actionLabel} قبل اكمال المتطلبات :**\n${issues.join('\n')}`);
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
        { label: '11) اعدادات الرسائل (نصوص فقط)', value: 'set_messages' },
        { label: '12) اعدادات الصور', value: 'set_images' },
        { label: '13) تعيين الاسباب', value: 'set_reasons' },
        { label: '14) طريقة العرض', value: 'set_display_mode' },
        { label: '15) ارسال بانل التكت', value: 'send_panel_now' },
        { label: 'انهاء الاعداد', value: 'finish' }
      ]);

    return [new ActionRowBuilder().addComponents(menu)];
  };

  await message.channel.send('**سيتم ضبط الاعدادات هنا، ومدخلاتك النصية ستحذف تلقائياً للحفاظ على الخصوصية.**').catch(() => {});

  setupMessage = await controlChannel.send({ embeds: [buildSetupEmbed()], components: buildMenuComponents() });

  const collector = setupMessage.createMessageComponentCollector({
    filter: (i) => i.user.id === message.author.id && i.customId.startsWith('ticket_setup_menu_'),
    time: 30 * 60 * 1000
  });

  const refresh = async (note = null, components = buildMenuComponents()) => {
    setGuildData(message.guild.id, config, tickets, pendingRequests);
    await setupMessage.edit({
      content: note || null,
      embeds: [buildSetupEmbed()],
      components
    }).catch(() => {});
  };

  const openReasonSubmenu = async (key, reason, idx) => {
    let done = false;
    while (!done) {
      const state = new EmbedBuilder()
        .setTitle(`**اعداد السبب ${idx}**`)
        .setDescription([
          `**الاسم:** ${reason.name || `سبب ${idx}`}`,
          `**اسم التكت:** ${reason.ticketName || 'افتراضي'}`,
          `**الايموجي:** ${formatSettingValue(reason.emoji || '🎫')}`,
          `**الكاتوقري:** ${reason.categoryId ? `<#${reason.categoryId}>` : 'افتراضي'}`,
          `**رسالة قبل الصورة:** ${formatSettingValue(reason.beforeImage)}`,
          `**رسالة بعد الصورة:** ${formatSettingValue(reason.afterImage)}`,
          `**وصف المنيو:** ${formatSettingValue(reason.description)}`
        ].join('\n'));

      await setupMessage.edit({
        content: '**اختر اعداد السبب المطلوب تعديله، او انهاء للرجوع.**',
        embeds: [state],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_reason_menu_${message.author.id}_${Date.now()}`)
            .setPlaceholder('اختر اعداد السبب')
            .addOptions([
              { label: '1) الاسم', value: 'r1' },
              { label: '2) اسم التكت', value: 'r2' },
              { label: '3) الايموجي', value: 'r3' },
              { label: '4) الكاتوقري', value: 'r4' },
              { label: '5) رسالة قبل الصورة', value: 'r5' },
              { label: '6) رسالة بعد الصورة', value: 'r6' },
              { label: '7) وصف السبب (للمنيو)', value: 'r7' },
              { label: 'انهاء', value: 'finish' }
            ])
        )]
      }).catch(() => {});

      const pick = await setupMessage.awaitMessageComponent({
        filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_reason_menu_'),
        time: 240000
      }).catch(() => null);

      if (!pick) break;
      activePromptInteraction = pick;
      await pick.deferUpdate().catch(() => {});
      const c = pick.values?.[0];
      if (c === 'finish') { done = true; break; }

      if (c === 'r1') { const v = await ask('**اسم السبب : (0 لاعادة التعيين)**'); reason.name = v === '0' ? `سبب ${idx}` : (v || reason.name); }
      if (c === 'r2') { const v = await ask('**اسم التكت : (0 لاعادة التعيين)**'); reason.ticketName = v === '0' ? '' : (v || reason.ticketName); }
      if (c === 'r3') { const v = await ask('**ايموجي : (0 لاعادة التعيين)**'); reason.emoji = v === '0' ? '🎫' : (v || reason.emoji); }
      if (c === 'r4') { const v = await ask('**كاتوقري : (0 لاعادة التعيين)**'); reason.categoryId = v === '0' ? null : normalizeId(v); }
      if (c === 'r5') { const v = await ask('**رسالة قبل الصورة : (0 لاعادة التعيين)**'); reason.beforeImage = v === '0' ? '' : (v || reason.beforeImage); }
      if (c === 'r6') { const v = await ask('**رسالة بعد الصورة : (0 لاعادة التعيين)**'); reason.afterImage = v === '0' ? '' : (v || reason.afterImage); }
      if (c === 'r7') { const v = await ask('**وصف السبب (يظهر في منيو الفتح) : (0 لاعادة التعيين)**'); reason.description = v === '0' ? '' : (v || reason.description || ''); }

      config.reasons[key] = reason;
    }
  };

  const openMessagesSubmenu = async () => {
    let done = false;
    while (!done) {
      const state = new EmbedBuilder()
        .setTitle('**اعدادات الرسائل**')
        .setDescription([
          `**1) رسالة القبول (تظهر في شات الاستلام):** ${formatSettingValue(config.messages.acceptance)}`,
          `**2) رسالة قبل صورة التكت (داخل شات التكت):** ${formatSettingValue(config.messages.beforeImage)}`,
          `**3) رسالة بعد صورة التكت (داخل شات التكت):** ${formatSettingValue(config.messages.afterImage)}`
        ].join('\n'));

      await setupMessage.edit({
        content: '**اختر من قائمة اعدادات الرسائل، او انهاء للرجوع.**',
        embeds: [state],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_msg_menu_${message.author.id}_${Date.now()}`)
            .setPlaceholder('اختر اعداد الرسائل')
            .addOptions([
              { label: '1) رسالة القبول - شات الاستلام', value: 'm1' },
              { label: '2) رسالة قبل الصورة - شات التكت', value: 'm2' },
              { label: '3) رسالة بعد الصورة - شات التكت', value: 'm3' },
              { label: 'انهاء', value: 'finish' }
            ])
        )]
      }).catch(() => {});

      const pick = await setupMessage.awaitMessageComponent({
        filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_msg_menu_'),
        time: 180000
      }).catch(() => null);

      if (!pick) break;
      activePromptInteraction = pick;
      await pick.deferUpdate().catch(() => {});
      const c = pick.values?.[0];
      if (c === 'finish') { done = true; break; }

      if (c === 'm1') { const v = await ask('**رسالة القبول (تظهر في شات الاستلام) : (0 لاعادة التعيين)**'); config.messages.acceptance = v === '0' ? '' : (v || ''); }
      if (c === 'm2') { const v = await ask('**رسالة قبل صورة التكت (داخل شات التكت) : (0 لاعادة التعيين)**'); config.messages.beforeImage = v === '0' ? '' : (v || ''); }
      if (c === 'm3') { const v = await ask('**رسالة بعد صورة التكت (داخل شات التكت) : (0 لاعادة التعيين)**'); config.messages.afterImage = v === '0' ? '' : (v || ''); }
    }
  };


  const openImagesSubmenu = async () => {
    let done = false;
    while (!done) {
      const state = new EmbedBuilder()
        .setTitle('**اعدادات الصور**')
        .setDescription([
          `**1) صورة التكت العامة (داخل شات التكت):** ${formatSettingValue(config.messages.ticketImage)}`,
          `**2) صورة فاصل شات الاستلام (بين الطلبات):** ${formatSettingValue(config.claimChannelSeparator)}`,
          '**3) صور السبب (فتح/استلام): تختار السبب ثم تعدل صورة الفتح أو الاستلام.**'
        ].join('\n'));

      await setupMessage.edit({
        content: '**اختر اعداد الصور، او انهاء للرجوع.**',
        embeds: [state],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_img_menu_${message.author.id}_${Date.now()}`)
            .setPlaceholder('اختر اعداد الصور')
            .addOptions([
              { label: '1) صورة التكت العامة', value: 'i1' },
              { label: '2) صورة فاصل شات الاستلام', value: 'i2' },
              { label: '3) صور السبب', value: 'i3' },
              { label: 'انهاء', value: 'finish' }
            ])
        )]
      }).catch(() => {});

      const pick = await setupMessage.awaitMessageComponent({
        filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_img_menu_'),
        time: 240000
      }).catch(() => null);

      if (!pick) break;
      activePromptInteraction = pick;
      await pick.deferUpdate().catch(() => {});
      const c = pick.values?.[0];
      if (c === 'finish') { done = true; break; }

      if (c === 'i1') {
        const v = await ask('**صورة التكت العامة: ارسل رابط صورة او ارفق صورة (0 للحذف)**');
        if (v === '0') {
          removeStoredImage(config.messages.ticketImage);
          config.messages.ticketImage = '';
        } else if (v) {
          try {
            config.messages.ticketImage = await storeImageLocally(v, message.guild.id, 'global_ticket_image', config.messages.ticketImage);
          } catch {
            await activePromptInteraction?.followUp({ content: '❌ فشل حفظ الصورة العامة.', ephemeral: true }).catch(() => {});
          }
        }
      }

      if (c === 'i2') {
        const v = await ask('**صورة فاصل شات الاستلام: ارسل رابط صورة او ارفق صورة (0 للحذف)**');
        if (v === '0') {
          removeStoredImage(config.claimChannelSeparator);
          config.claimChannelSeparator = '';
        } else if (v) {
          try {
            config.claimChannelSeparator = await storeImageLocally(v, message.guild.id, 'claim_separator', config.claimChannelSeparator);
          } catch {
            await activePromptInteraction?.followUp({ content: '❌ فشل حفظ صورة الفاصل.', ephemeral: true }).catch(() => {});
          }
        }
      }

      if (c === 'i3') {
        const idx = Number(await ask('**اختر رقم السبب من 1 الى 25**'));
        if (!Number.isFinite(idx) || idx < 1 || idx > 25) continue;
        const key = String(idx);
        const reason = {
          name: `سبب ${idx}`,
          openImage: '',
          claimImage: '',
          ...(config.reasons[key] || {})
        };

        await setupMessage.edit({
          content: '**اختر نوع الصورة لهذا السبب.**',
          embeds: [new EmbedBuilder().setTitle(`**صور السبب ${idx}**`).setDescription([
            `**صورة الفتح (داخل شات التكت عند الانشاء):** ${formatSettingValue(reason.openImage)}`,
            `**صورة الاستلام (عند استلام التكت):** ${formatSettingValue(reason.claimImage)}`
          ].join('\n'))],
          components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`ticket_img_reason_menu_${message.author.id}_${Date.now()}`)
              .setPlaceholder('اختر الصورة')
              .addOptions([
                { label: 'صورة الفتح', value: 'open' },
                { label: 'صورة الاستلام', value: 'claim' },
                { label: 'انهاء', value: 'finish' }
              ])
          )]
        }).catch(() => {});

        const reasonPick = await setupMessage.awaitMessageComponent({
          filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_img_reason_menu_'),
          time: 180000
        }).catch(() => null);
        if (!reasonPick) continue;
        activePromptInteraction = reasonPick;
        await reasonPick.deferUpdate().catch(() => {});
        const rc = reasonPick.values?.[0];
        if (rc === 'finish') continue;

        const v = await ask(`**${rc === 'open' ? 'صورة فتح السبب' : 'صورة استلام السبب'}: ارسل رابط صورة او ارفق صورة (0 للحذف)**`);
        if (v === '0') {
          if (rc === 'open') { removeStoredImage(reason.openImage); reason.openImage = ''; }
          if (rc === 'claim') { removeStoredImage(reason.claimImage); reason.claimImage = ''; }
        } else if (v) {
          try {
            if (rc === 'open') reason.openImage = await storeImageLocally(v, message.guild.id, `reason_${key}_open`, reason.openImage);
            if (rc === 'claim') reason.claimImage = await storeImageLocally(v, message.guild.id, `reason_${key}_claim`, reason.claimImage);
          } catch {
            await activePromptInteraction?.followUp({ content: '❌ فشل حفظ صورة السبب.', ephemeral: true }).catch(() => {});
          }
        }

        config.reasons[key] = { ...(config.reasons[key] || {}), ...reason };
      }
    }
  };


  const openDisplayModeSubmenu = async () => {
    let done = false;
    while (!done) {
      const state = new EmbedBuilder()
        .setTitle('**اعدادات طريقة العرض**')
        .setDescription([
          `**الوضع الحالي:** ${config.displayMode}`,
          `**عدد صفوف الازرار:** ${config.buttonRows || 2}`,
          '**في وضع المنيو يمكنك استخدام وصف السبب لكل سبب ليظهر تحت الاسم.**'
        ].join('\n'));

      await setupMessage.edit({
        content: '**اختر طريقة العرض او انهاء للرجوع.**',
        embeds: [state],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_display_menu_${message.author.id}_${Date.now()}`)
            .setPlaceholder('اختر طريقة العرض')
            .addOptions([
              { label: 'استخدام الازرار', value: 'buttons' },
              { label: 'استخدام المنيو', value: 'menu' },
              { label: 'تعديل صفوف الازرار', value: 'rows' },
              { label: 'انهاء', value: 'finish' }
            ])
        )]
      }).catch(() => {});

      const pick = await setupMessage.awaitMessageComponent({
        filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_display_menu_'),
        time: 180000
      }).catch(() => null);

      if (!pick) break;
      activePromptInteraction = pick;
      await pick.deferUpdate().catch(() => {});
      const c = pick.values?.[0];
      if (c === 'finish') { done = true; break; }
      if (c === 'buttons') config.displayMode = 'buttons';
      if (c === 'menu') config.displayMode = 'menu';
      if (c === 'rows') {
        const rows = Number(await ask('**عدد الصفوف : من 1 الى 5**'));
        if (Number.isFinite(rows) && rows >= 1 && rows <= 5) config.buttonRows = rows;
      }
    }
  };

  collector.on('collect', async (interaction) => {
    try {
      const choice = interaction.values?.[0];
      if (!choice) return;

      activePromptInteraction = interaction;
      await interaction.deferUpdate().catch(() => {});

      if (choice === 'finish') {
        collector.stop('finished');
        await refresh('**تم إنهاء الاعداد.**', []);
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
        await refresh( '**تم تحديث الاسم.**');
        return;
      }

      if (choice === 'set_open_category') {
        const v = await ask('**ارسل : منشن/ايدي الكاتوقري (0 لاعادة التعيين)**');
        config.openCategoryId = v === '0' ? null : normalizeId(v);
        await refresh( '**تم تحديث كاتوقري الفتح.**');
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
          await refresh( '**تنبيه : لم يتم حفظ اي رول مسؤول صالح.**');
          return;
        }
        await refresh( '**تم تحديث المسؤولين.**');
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
          await refresh( '**تنبيه : لا توجد رولات ادمن فعالة بعد التحديث.**');
          return;
        }
        await refresh( '**تم تحديث رولات الادمن.**');
        return;
      }

      if (choice === 'set_admin_limit') {
        const n = Number(await ask('**اكتب : حد استلام الاداري المفتوح**'));
        if (Number.isFinite(n) && n > 0) config.adminClaimLimit = n;
        await refresh( '**تم تحديث حد استلام الاداري.**');
        return;
      }

      if (choice === 'set_member_limit') {
        const n = Number(await ask('**اكتب : حد فتح العضو المفتوح**'));
        if (Number.isFinite(n) && n > 0) config.memberOpenLimit = n;
        await refresh( '**تم تحديث حد فتح العضو.**');
        return;
      }

      if (choice === 'toggle_auto_create') {
        config.autoCreateOnRequest = !config.autoCreateOnRequest;
        await refresh( `**تم التحديث : ${config.autoCreateOnRequest ? 'مفعل' : 'مقفل'}**`);
        return;
      }

      if (choice === 'toggle_hide_on_claim') {
        config.hideOnClaim = !config.hideOnClaim;
        await refresh( `**تم التحديث : ${config.hideOnClaim ? 'مفعل' : 'مقفل'}**`);
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
            await refresh( '**فشل : شات الاستلام غير صالح وتم الغاء التفعيل.**');
            return;
          }
          config.claimChannelId = askedChannel;
          const sep = await ask('**ارسل : فاصل شات الاستلام كنص فقط (0 للتفريغ) - الصور من خيار اعدادات الصور**');
          if (sep === '0') config.claimChannelSeparator = '';
          else if (sep) config.claimChannelSeparator = sep;
        }
        await refresh( `**تم التحديث : ${config.claimFromDedicatedChannel ? 'مفعل' : 'مقفل'}**`);
        return;
      }

      if (choice === 'toggle_keep_closed') {
        config.keepClosedTickets = !config.keepClosedTickets;
        if (config.keepClosedTickets) {
          const v = await ask('**ارسل : كاتوقري المقفلة (0 للبقاء بنفس المكان)**');
          config.closedCategoryId = v === '0' ? null : normalizeId(v);
        }
        await refresh( `**تم التحديث : ${config.keepClosedTickets ? 'مفعل' : 'مقفل'}**`);
        return;
      }

      if (choice === 'set_messages') {
        await openMessagesSubmenu();
        await refresh('**تم تحديث اعدادات الرسائل.**');
        return;
      }

      if (choice === 'set_images') {
        await openImagesSubmenu();
        await refresh('**تم تحديث اعدادات الصور.**');
        return;
      }

      if (choice === 'set_reasons') {
        if (!config.openCategoryId) {
          await refresh( '**يلزم تعيين كاتوقري الفتح قبل تعديل الاسباب.**');
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
            description: '',
            ...(config.reasons[key] || {})
          };

          await openReasonSubmenu(key, reason, idx);
          config.reasons[key] = reason;
        }
        await refresh( '**تم تحديث السبب.**');
        return;
      }

      if (choice === 'set_display_mode') {
        await openDisplayModeSubmenu();
        await refresh( '**تم تحديث طريقة العرض.**');
        return;
      }

      if (choice === 'send_panel_now') {
        if (!(await assertSetupReady('ارسال البانل'))) return;
        const panelChannel = await message.guild.channels.fetch(normalizeId(await ask('**ارسل : الشات (منشن/ايدي)**'))).catch(() => null);
        if (!panelChannel || panelChannel.type !== ChannelType.GuildText) {
          await refresh( '**فشل : شات غير صالح.**');
          return;
        }

        const mode = (await ask('**طريقة الارسال : text / image / both**')) || 'both';
        const text = mode === 'image' ? '' : await ask('**النص : (0 لتخطي)**');
        const image = mode === 'text' ? '' : await ask('**الصورة : رابط مباشر او ارفاق صورة (0 لتخطي)**');

        await panelChannel.send({
          content: text && text !== '0' ? text : null,
          files: image && image !== '0' ? [image] : [],
          components: createReasonComponents(config, message.guild.id)
        });

        await refresh( '**تم ارسال البانل بنجاح.**');
        return;
      }

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
  if (!value || value === 'resp_none') {
    await interaction.reply({ content: '**لا توجد مسؤولية صالحة.**', ephemeral: true });
    return;
  }

  const responsibilities = loadResponsibilities();
  const responsibilityNames = Object.keys(responsibilities).slice(0, 25);

  let respName = null;
  if (value.startsWith('respidx_')) {
    const index = Number(value.replace('respidx_', ''));
    if (Number.isInteger(index) && index >= 0 && index < responsibilityNames.length) {
      respName = responsibilityNames[index];
    }
  } else if (value.startsWith('resp_')) {
    respName = value.replace('resp_', '');
  }

  if (!respName) {
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

  if (ticket.claimedBy) {
    await interaction.channel.permissionOverwrites.edit(ticket.claimedBy, { ViewChannel: false, SendMessages: false }).catch(() => {});
  }
  const dmEmbed = makeTicketEmbed('تحويل تكت', `يوجد تكت تم تحويله لمسؤوليتكم في <#${channelId}>`, 0x5865F2);
  for (const uid of (selected.responsibles || [])) {
    const user = await interaction.client.users.fetch(uid).catch(() => null);
    if (user) await user.send({ embeds: [dmEmbed] }).catch(() => {});
  }

  await interaction.reply({
    embeds: [makeTicketEmbed('تحويل', `**تم تحويل التكت لمسؤولين : ${respName}**\n${mentions.join(' ') || '**لا يوجد منشن محدد**'}`, 0x5865F2)]
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

  registerTicketInteractionRouter(async (interaction) => {
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

        if (id.startsWith('ticket_delete_')) {
          const [, , guildId, channelId] = id.split('_');
          const { guild: g } = getGuildData(guildId);
          const ticket = g.tickets[channelId];
          if (!ticket || interaction.channelId !== channelId) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**لا توجد بيانات لهذا التكت.**', 0xED4245)], ephemeral: true });
            return;
          }
          if (!hasStaffAccess(interaction.member, g.config)) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**ليس لديك صلاحية الحذف.**', 0xED4245)], ephemeral: true });
            return;
          }
          delete g.tickets[channelId];
          setGuildData(guildId, g.config, g.tickets, g.pendingRequests || {});
          await interaction.reply({ embeds: [makeTicketEmbed('حذف', '**سيتم حذف التكت خلال 3 ثواني.**', 0xED4245)], ephemeral: true });
          setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
          return;
        }

        if (id.startsWith('ticket_down_') || id.startsWith('ticket_up1_') || id.startsWith('ticket_up2_')) {
          const [, , guildId, channelId] = id.split('_');
          const { guild: g } = getGuildData(guildId);
          const ticket = g.tickets[channelId];
          if (!ticket || interaction.channelId !== channelId) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**لا توجد بيانات لهذا التكت.**', 0xED4245)], ephemeral: true });
            return;
          }
          if (!hasStaffAccess(interaction.member, g.config)) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**ليس لديك صلاحية النقاط.**', 0xED4245)], ephemeral: true });
            return;
          }
          await interaction.reply({ embeds: [makeTicketEmbed('تم', '**تم تنفيذ الإجراء.**', 0x57F287)], ephemeral: true });
          return;
        }

        if (id.startsWith('ticket_toggle_member_') || id.startsWith('ticket_toggle_claimer_')) {
          const parts = id.split('_');
          const guildId = parts[3];
          const channelId = parts[4];
          const { guild: g } = getGuildData(guildId);
          const ticket = g.tickets[channelId];
          if (!ticket || interaction.channelId !== channelId) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**لا توجد بيانات لهذا التكت.**', 0xED4245)], ephemeral: true });
            return;
          }
          if (!hasStaffAccess(interaction.member, g.config)) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**ليس لديك صلاحية هذا الإجراء.**', 0xED4245)], ephemeral: true });
            return;
          }

          const isMember = id.startsWith('ticket_toggle_member_');
          const targetId = isMember ? ticket.memberId : ticket.claimedBy;
          if (!targetId) {
            await interaction.reply({ embeds: [makeTicketEmbed('تنبيه', '**لا يوجد مستخدم مرتبط بهذا الزر.**', 0xED4245)], ephemeral: true });
            return;
          }

          const key = isMember ? 'memberHidden' : 'claimerHidden';
          ticket[key] = !(ticket[key] !== false);
          await interaction.channel.permissionOverwrites.edit(targetId, {
            ViewChannel: !ticket[key],
            SendMessages: !ticket[key],
            ReadMessageHistory: true
          }).catch(() => {});

          setGuildData(guildId, g.config, g.tickets, g.pendingRequests || {});
          await interaction.update({ components: buildPostCloseControls(guildId, channelId, ticket) });
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
          const cooldownKey = `${interaction.guild.id}:${channelId}:${interaction.user.id}`;
          const last = pingCooldowns.get(cooldownKey) || 0;
          const now = Date.now();
          const cooldownMs = 10 * 60 * 1000;
          if (now - last < cooldownMs) {
            const left = Math.ceil((cooldownMs - (now - last)) / 1000);
            await interaction.reply({ embeds: [makeTicketEmbed('كولداون', `**انتظر ${left} ثانية قبل استخدام الاستدعاء مرة أخرى.**`, 0xED4245)], ephemeral: true });
            return;
          }

          const user = await client.users.fetch(ticket.memberId).catch(() => null);
          const link = `https://discord.com/channels/${interaction.guild.id}/${interaction.channel.id}`;
          if (user) {
            await user.send({ embeds: [makeTicketEmbed('استدعاء للتكت', `**تم استدعاؤك للتكت**\n**الرابط :** ${link}`, 0x5865F2)] }).catch(() => {});
          }
          pingCooldowns.set(cooldownKey, now);
          setGuildData(guildId, config, tickets, pendingRequests);
          await interaction.reply({ embeds: [makeTicketEmbed('تم', `**تم استدعاء العضو :** <@${ticket.memberId}>`, 0x57F287)], ephemeral: true });
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
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**الاسم غير صالح.**', 0xED4245)], ephemeral: true });
            return;
          }
          const { guild: g } = getGuildData(guildId);
          const { config, tickets } = g;
          const ticket = tickets[channelId];
          if (!ticket || interaction.channelId !== channelId) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**لا توجد بيانات لهذا التكت.**', 0xED4245)], ephemeral: true });
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**ليس لديك صلاحية تغيير الاسم.**', 0xED4245)], ephemeral: true });
            return;
          }
          await interaction.channel.setName(newName).catch(() => {});
          await interaction.reply({ embeds: [makeTicketEmbed('تم', `**تم تغيير الاسم :** ${newName}`, 0x57F287)], ephemeral: true });
          return;
        }

        if (modalId.startsWith('ticket_add_modal_')) {
          const [, , , guildId, channelId] = modalId.split('_');
          const userId = normalizeId(interaction.fields.getTextInputValue('value'));
          if (!userId) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**المدخل غير صالح.**', 0xED4245)], ephemeral: true });
            return;
          }
          const { guild: g } = getGuildData(guildId);
          const { config, tickets, pendingRequests } = g;
          const ticket = tickets[channelId];
          if (!ticket || interaction.channelId !== channelId) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**لا توجد بيانات لهذا التكت.**', 0xED4245)], ephemeral: true });
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**ليس لديك صلاحية الاضافة.**', 0xED4245)], ephemeral: true });
            return;
          }
          if (ticket.memberId === userId) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**الشخص هو صاحب التكت بالفعل.**', 0xED4245)], ephemeral: true });
            return;
          }
          const targetMember = await interaction.guild.members.fetch(userId).catch(() => null);
          if (!targetMember) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**لا يمكن العثور على العضو.**', 0xED4245)], ephemeral: true });
            return;
          }
          await interaction.channel.permissionOverwrites.edit(userId, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true
          }).catch(() => {});
          if (!ticket.extraMembers.includes(userId)) ticket.extraMembers.push(userId);
          setGuildData(guildId, config, tickets, pendingRequests);
          await interaction.reply({ embeds: [makeTicketEmbed('تم', `**تم اضافة الشخص :** <@${userId}>`, 0x57F287)], ephemeral: true });
          return;
        }

        if (modalId.startsWith('ticket_remove_modal_')) {
          const [, , , guildId, channelId] = modalId.split('_');
          const userId = normalizeId(interaction.fields.getTextInputValue('value'));
          if (!userId) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**المدخل غير صالح.**', 0xED4245)], ephemeral: true });
            return;
          }
          const { guild: g } = getGuildData(guildId);
          const { config, tickets, pendingRequests } = g;
          const ticket = tickets[channelId];
          if (!ticket || interaction.channelId !== channelId) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**لا توجد بيانات لهذا التكت.**', 0xED4245)], ephemeral: true });
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**ليس لديك صلاحية الازالة.**', 0xED4245)], ephemeral: true });
            return;
          }
          if (ticket.memberId === userId) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**لا يمكن إزالة صاحب التكت.**', 0xED4245)], ephemeral: true });
            return;
          }
          await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: false }).catch(() => {});
          ticket.extraMembers = (ticket.extraMembers || []).filter((id) => id !== userId);
          setGuildData(guildId, config, tickets, pendingRequests);
          await interaction.reply({ embeds: [makeTicketEmbed('تم', `**تم ازالة الشخص :** <@${userId}>`, 0x57F287)], ephemeral: true });
          return;
        }
      }

      return false;
    } catch {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '**حدث خطأ أثناء معالجة التكت.**', ephemeral: true }).catch(() => {});
      }
      return true;
    }
  });
}

module.exports = { name, aliases, execute, registerHandlers };
