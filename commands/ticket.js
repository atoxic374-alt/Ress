const {
  EmbedBuilder,
  AttachmentBuilder,
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
const colorManager = require('../utils/colorManager');

const name = 'ticket';
const aliases = ['تكت'];
const dataPath = path.join(__dirname, '..', 'data', 'ticketConfig.json');
const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
const ticketImagesDir = path.join(__dirname, '..', 'data', 'ticket_images');
const pointsPath = path.join(__dirname, '..', 'data', 'points.json');

let handlersRegistered = false;
const pingCooldowns = new Map();
const ticketClaimLocks = new Set();
const activeTicketSetupSessions = new Map();
const recentTicketCommandMessages = new Set();

function makeTicketEmbed(title, description, options = {}) {
  const embed = colorManager.createEmbed().setTitle(title).setDescription(description || null);
  if (options?.user) {
    embed.setAuthor({ name: options.user.username || options.user.tag || 'User', iconURL: options.user.displayAvatarURL?.() || undefined });
  }
  return embed;
}

function renderTicketText(template, memberId) {
  if (!template) return '';
  return String(template).replace(/\buser\b/gi, `<@${memberId}>`);
}

function buildMentionChunks(roleIds = [], maxLen = 1800) {
  const mentions = [...new Set(roleIds)].map((id) => `<@&${id}>`);
  const chunks = [];
  let current = '';
  for (const mention of mentions) {
    const next = current ? `${current} ${mention}` : mention;
    if (next.length > maxLen) {
      if (current) chunks.push(current);
      current = mention;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function resolveButtonStyle(styleValue) {
  const safe = String(styleValue || 'primary').toLowerCase();
  if (safe === 'success') return ButtonStyle.Success;
  if (safe === 'danger') return ButtonStyle.Danger;
  if (safe === 'secondary') return ButtonStyle.Secondary;
  return ButtonStyle.Primary;
}

function loadPoints() {
  try {
    if (!fs.existsSync(pointsPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(pointsPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function savePoints(points) {
  fs.writeFileSync(pointsPath, JSON.stringify(points, null, 2), 'utf8');
}

async function buildTicketTranscript(channel, maxMessages = 200) {
  try {
    const lines = [];
    let lastId = null;
    let fetchedTotal = 0;

    while (fetchedTotal < maxMessages) {
      const remaining = Math.min(100, maxMessages - fetchedTotal);
      const batch = await channel.messages.fetch({ limit: remaining, before: lastId }).catch(() => null);
      if (!batch || batch.size === 0) break;

      const ordered = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const msg of ordered) {
        const ts = new Date(msg.createdTimestamp).toISOString();
        const author = msg.author?.tag || msg.author?.username || msg.author?.id || 'unknown';
        const content = (msg.content || '').replace(/\n/g, ' ').trim();
        const atts = msg.attachments?.size
          ? ` [attachments:${[...msg.attachments.values()].map((a) => a.url).join(' , ')}]`
          : '';
        const embedText = msg.embeds?.length
          ? ` [embeds:${msg.embeds.map((e) => `${e.title || ''} ${e.description || ''}`.trim()).join(' | ')}]`
          : '';
        lines.push(`[${ts}] ${author}: ${content || '(empty)'}${atts}${embedText}`);
      }

      fetchedTotal += batch.size;
      lastId = ordered[0]?.id;
      if (!lastId) break;
    }

    if (lines.length === 0) return null;
    const fileName = `transcript-${channel.id}.txt`;
    return new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), { name: fileName });
  } catch {
    return null;
  }
}

async function sendTranscriptOutsideTicket(interaction, transcriptFile, label = 'Transcript') {
  if (!transcriptFile) return false;

  try {
    await interaction.user?.send?.({ content: label, files: [transcriptFile] });
    return true;
  } catch {}

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: label, files: [transcriptFile], ephemeral: true });
    } else {
      await interaction.reply({ content: label, files: [transcriptFile], ephemeral: true });
    }
    return true;
  } catch {
    return false;
  }
}

async function sendClaimAnnounce({ channel, config, ticket, claimerId, claimImage }) {
  const adminRoleIds = getAdminRoles(config, ticket?.reasonKey)
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id));

  const reasonName = config.reasons?.[ticket.reasonKey]?.name || `سبب ${ticket.reasonKey}`;
  const mentionChunks = buildMentionChunks(adminRoleIds);
  for (const chunk of mentionChunks) {
    await channel.send({ content: chunk }).catch(() => {});
  }

  const claimEmbed = makeTicketEmbed(
    'Ticket claimed',
    `**Ticket claimed by :** <@${claimerId}>\n**Reason :** ${reasonName}${ticket.memberId ? `\n**Member :** <@${ticket.memberId}>` : ''}`
  );

  const modalAnswers = ticket.openModalAnswers && typeof ticket.openModalAnswers === 'object' ? ticket.openModalAnswers : {};
  const modalFields = Object.entries(modalAnswers).slice(0, 10);
  for (const [label, value] of modalFields) {
    claimEmbed.addFields({ name: label.slice(0, 256), value: String(value || '-').slice(0, 1024), inline: false });
  }

  if (claimImage) {
    await channel.send({ files: [claimImage], embeds: [claimEmbed] }).catch(() => {});
  } else {
    await channel.send({ embeds: [claimEmbed] }).catch(() => {});
  }
}

function buildPostCloseControls(guildId, panelId, channelId, ticket = {}) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_down2_${guildId}_${panelId}_${channelId}`).setLabel('-2').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_down_${guildId}_${panelId}_${channelId}`).setLabel('-1').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_delete_${guildId}_${panelId}_${channelId}`).setLabel('حذف').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket_up1_${guildId}_${panelId}_${channelId}`).setLabel('1').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ticket_up2_${guildId}_${panelId}_${channelId}`).setLabel('2').setStyle(ButtonStyle.Success)
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
    deleteClaimMessageOnClaim: false,
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
  const panels = existing.panels && typeof existing.panels === 'object' ? existing.panels : {};

  if (!panels.default) {
    const legacyConfig = { ...baseConfig(), ...(existing.config || {}) };
    legacyConfig.messages = { ...baseConfig().messages, ...(existing.config?.messages || {}) };
    legacyConfig.reasons = existing.config?.reasons || {};
    panels.default = {
      config: legacyConfig,
      tickets: existing.tickets || {},
      pendingRequests: existing.pendingRequests || {}
    };
  }

  const defaultPanel = panels.default || { config: baseConfig(), tickets: {}, pendingRequests: {} };
  return {
    store,
    guild: {
      panels,
      config: defaultPanel.config,
      tickets: defaultPanel.tickets || {},
      pendingRequests: defaultPanel.pendingRequests || {}
    }
  };
}

function setGuildData(guildId, config, tickets, pendingRequests = {}, panelId = 'default') {
  const store = loadStore();
  const existing = store[guildId] || {};
  const panels = existing.panels && typeof existing.panels === 'object' ? existing.panels : {};
  panels[panelId] = { config, tickets, pendingRequests };
  store[guildId] = { panels };
  saveStore(store);
}

function getPanelData(guildId, panelId = 'default') {
  const { guild } = getGuildData(guildId);
  const panel = guild.panels[panelId] || { config: baseConfig(), tickets: {}, pendingRequests: {} };
  const config = { ...baseConfig(), ...(panel?.config || {}) };
  config.messages = { ...baseConfig().messages, ...(panel?.config?.messages || {}) };
  config.reasons = panel?.config?.reasons || {};
  const tickets = panel?.tickets || {};
  const pendingRequests = panel?.pendingRequests || {};
  return { config, tickets, pendingRequests };
}

function findTicketPanel(guildId, channelId, preferredPanelId = 'default') {
  const { guild } = getGuildData(guildId);
  if (guild.panels?.[preferredPanelId]?.tickets?.[channelId]) return preferredPanelId;
  const entries = Object.entries(guild.panels || {});
  for (const [pid, panel] of entries) {
    if (panel?.tickets?.[channelId]) return pid;
  }
  return preferredPanelId;
}

function normalizeId(input) {
  if (!input) return null;
  const match = String(input).trim().match(/^(?:<@&?|<#)?(\d{16,20})>?$/);
  return match ? match[1] : null;
}

function extractChannelId(input) {
  if (!input) return null;
  const normalized = normalizeId(input);
  if (normalized) return normalized;
  const any = String(input).match(/(\d{16,20})/);
  return any ? any[1] : null;
}

function normalizeResponsibilityInput(input) {
  return String(input || '')
    .replace(/[\u0640]/g, '')
    .replace(/[\u061F\?\!\,\.\:\;\-\_\=]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractResponsibilityNameFromInput(input) {
  const normalized = normalizeResponsibilityInput(input);
  if (!normalized) return null;

  const patterns = [
    /^مسؤول(?:ية|يه)?\s+(.*)$/i,
    /^المسؤول(?:ية|يه)?\s+(.*)$/i,
    /^responsibility\s+(.*)$/i,
    /^resp\s+(.*)$/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  return normalized;
}

function findResponsibilityByName(rawName, responsibilities = {}) {
  const candidate = extractResponsibilityNameFromInput(rawName);
  if (!candidate) return null;
  const entries = Object.entries(responsibilities || {});
  if (!entries.length) return null;

  const exact = entries.find(([name]) => normalizeResponsibilityInput(name) === candidate);
  if (exact) return exact[0];

  const contains = entries.find(([name]) => normalizeResponsibilityInput(name).includes(candidate));
  if (contains) return contains[0];

  return null;
}

function createMainEmbed(config, guildName) {
  return colorManager.createEmbed()
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

function getAdminRoles(config, reasonKey = null) {
  const reason = reasonKey !== null && reasonKey !== undefined ? config?.reasons?.[String(reasonKey)] : null;
  if (reason?.useCustomAdminRoles) {
    return (reason.adminRoleIds || []).map((id) => String(id));
  }
  if (!config.useGlobalAdminRoles) return (config.adminRoleIds || []).map((id) => String(id));
  try {
    const fromFile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'adminRoles.json'), 'utf8'));
    return Array.isArray(fromFile) ? fromFile.map((id) => String(id)) : [];
  } catch {
    return [];
  }
}

function countOpenMemberTickets(tickets, userId) {
  return Object.values(tickets).filter((t) => t.status === 'open' && t.memberId === userId).length;
}

function countPendingMemberRequests(pendingRequests, userId) {
  return Object.values(pendingRequests || {}).filter((req) => req?.userId === userId).length;
}

function countClaimedByAdmin(tickets, adminId) {
  return Object.values(tickets).filter((t) => t.status === 'open' && t.claimedBy === adminId).length;
}

function prunePendingRequests(pendingRequests, maxAgeMs = 2 * 60 * 60 * 1000) {
  const now = Date.now();
  let changed = false;
  for (const [reqId, req] of Object.entries(pendingRequests || {})) {
    const createdAt = Number(req?.createdAt || 0);
    if (!createdAt || now - createdAt > maxAgeMs) {
      delete pendingRequests[reqId];
      changed = true;
    }
  }
  return changed;
}

function hasStaffAccess(member, config, reasonKey = null) {
  const adminRoles = getAdminRoles(config, reasonKey);
  const responsibleRoles = (config.responsibleRoleIds || []).map((id) => String(id));
  let roleIds = [];

  if (member?.roles?.cache) roleIds = [...member.roles.cache.keys()];
  else if (Array.isArray(member?.roles)) roleIds = member.roles;
  else if (Array.isArray(member?.roles?.value)) roleIds = member.roles.value;
  else if (Array.isArray(member?.roles?.ids)) roleIds = member.roles.ids;

  roleIds = roleIds.map((id) => String(id));
  const hasRole = roleIds.some((id) => adminRoles.includes(id) || responsibleRoles.includes(id));
  return hasRole;
}

function canManageTicket(interaction, ticket, config) {
  if (interaction.user.id === ticket.claimedBy) return true;
  return isAdminOnly(interaction, config, ticket?.reasonKey);
}

function isAdminOnly(interaction, config, reasonKey = null) {
  const adminRoles = getAdminRoles(config, reasonKey);
  const roleIds = interaction.member?.roles?.cache ? [...interaction.member.roles.cache.keys()] : [];
  const hasAdminRole = roleIds.some((id) => adminRoles.includes(id));
  return hasAdminRole;
}

function sanitizeName(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\-\_\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 90);
}

async function buildTicketControls(guildId, panelId, channelId, config, options = {}) {
  const includeClaimButton = options.includeClaimButton !== false;
  const row1Buttons = [];
  if (includeClaimButton) row1Buttons.push(new ButtonBuilder().setCustomId(`ticket_claim_${guildId}_${panelId}_${channelId}`).setLabel('استلام').setStyle(ButtonStyle.Success));
  row1Buttons.push(
    new ButtonBuilder().setCustomId(`ticket_close_${guildId}_${panelId}_${channelId}`).setLabel('اقفال').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket_rename_${guildId}_${panelId}_${channelId}`).setLabel('تغيير الاسم').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_reassign_${guildId}_${panelId}_${channelId}`).setLabel('تغيير المستلم').setStyle(ButtonStyle.Success)
  );
  const row1 = new ActionRowBuilder().addComponents(row1Buttons);

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_add_${guildId}_${panelId}_${channelId}`).setLabel('اضافة شخص').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ticket_remove_${guildId}_${panelId}_${channelId}`).setLabel('ازالة شخص').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_ping_${guildId}_${panelId}_${channelId}`).setLabel('استدعاء العضو').setStyle(ButtonStyle.Primary)
  );

  const responsibilities = loadResponsibilities();
  const responsibilityNames = Object.keys(responsibilities).slice(0, 25);
  const responsibilityOptions = responsibilityNames
    .map((respName, index) => {
      const count = Array.isArray(responsibilities?.[respName]?.responsibles)
        ? responsibilities[respName].responsibles.length
        : 0;
      return {
        label: respName.slice(0, 100),
        value: `respidx_${index}`,
        description: `عدد المسؤولين: ${count}`
      };
    });

  const row3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ticket_transfer_${guildId}_${panelId}_${channelId}`)
      .setPlaceholder('اختر مسؤولية لتحويل التكت')
      .addOptions(responsibilityOptions.length ? responsibilityOptions : [{ label: 'لا توجد مسؤوليات', value: 'resp_none' }])
      .setDisabled(responsibilityOptions.length === 0)
  );

  return [row1, row2, row3];
}

async function createTicketChannel({ guild, member, config, reasonKey, tickets, pendingRequests, includeClaimButton = true, panelId = 'default', openModalAnswers = null }) {
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

  const adminRoles = getAdminRoles(config, reasonKey);
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

  const controls = await buildTicketControls(guild.id, panelId, channel.id, config, { includeClaimButton });

  const introText = renderTicketText(reason.beforeImage || config.messages.beforeImage, memberId);
  if (introText) await channel.send({ content: introText });
  const openImage = resolveImageForSend(reason.openImage || config.messages.ticketImage);
  if (openImage) {
    await channel.send({ files: [openImage] }).catch(() => {});
  }
  const outroText = renderTicketText(reason.afterImage || config.messages.afterImage, memberId);
  if (outroText) await channel.send({ content: outroText }).catch(() => {});

  await channel.send({ components: controls });

  if (config.ticketNameMode !== 'user') config.counter = (config.counter || 1) + 1;

  tickets[channel.id] = {
    channelId: channel.id,
    panelId,
    memberId,
    reasonKey,
    claimedBy: null,
    status: 'open',
    extraMembers: [],
    openModalAnswers: openModalAnswers && typeof openModalAnswers === 'object' ? openModalAnswers : undefined,
    createdAt: Date.now()
  };

  setGuildData(guild.id, config, tickets, pendingRequests, panelId);
  return channel;
}

async function applyHideOnClaim(channel, guild, config, claimerId, memberId, extraMembers = [], reasonKey = null) {
  const adminRoles = getAdminRoles(config, reasonKey)
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id) && guild.roles.cache.has(id));
  const visibleStaffRoles = [...new Set([...(config.responsibleRoleIds || [])])]
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id) && guild.roles.cache.has(id));
  const allStaffRoles = [...new Set([...adminRoles, ...visibleStaffRoles])];

  await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
    ViewChannel: false,
    SendMessages: false,
    ReadMessageHistory: false
  }).catch(() => {});

  for (const roleId of allStaffRoles) {
    const shouldSee = visibleStaffRoles.includes(roleId);
    await channel.permissionOverwrites.edit(roleId, {
      ViewChannel: shouldSee,
      SendMessages: shouldSee,
      ReadMessageHistory: shouldSee
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

async function handleOpenRequest(interaction, guildId, panelId, reasonKey) {
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const guild = interaction.guild;
  const { config, tickets, pendingRequests } = getPanelData(guildId, panelId || 'default');
  const pruned = prunePendingRequests(pendingRequests);
  if (pruned) setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default');

  if (!config.autoCreateOnRequest && !config.claimFromDedicatedChannel && !interaction.channelId) {
    await interaction.editReply({ embeds: [makeTicketEmbed('خطأ', '**لا يمكن إنشاء طلب الاستلام بدون شات صالح.**', 0xED4245)] });
    return;
  }

  if (!config.autoCreateOnRequest && config.claimFromDedicatedChannel && !config.claimChannelId) {
    await interaction.editReply({ embeds: [makeTicketEmbed('خطأ', '**لا يمكن فتح الطلب الآن: شات الاستلام المخصص غير محدد.**', 0xED4245)] });
    return;
  }

  const openCount = countOpenMemberTickets(tickets, interaction.user.id);
  const pendingCount = countPendingMemberRequests(pendingRequests, interaction.user.id);
  if ((openCount + pendingCount) >= (config.memberOpenLimit || 1)) {
    await interaction.editReply({ embeds: [makeTicketEmbed('تنبيه', `**الحد : وصلت لاقصى تكت مفتوح (${config.memberOpenLimit}).**`, 0xED4245)] });
    return;
  }

  if (config.autoCreateOnRequest) {
    try {
      const channel = await createTicketChannel({ guild, member: interaction.member, config, reasonKey, tickets, pendingRequests, panelId: panelId || 'default', openModalAnswers: interaction.ticketModalAnswers || null });
      await interaction.editReply({ embeds: [makeTicketEmbed('تم', `**تم انشاء التكت :** <#${channel.id}>`, 0x57F287)] });
    } catch (error) {
      console.error('ticket open create channel error:', error?.message || error);
      await interaction.editReply({ embeds: [makeTicketEmbed('خطأ', '**فشل فتح التكت، تأكد من صلاحيات البوت والكاتوقري.**', 0xED4245)] });
    }
    return;
  }

  const reqId = `${guildId}_${panelId || 'default'}_${interaction.user.id}_${Date.now()}`;
  const duplicateRequest = Object.values(pendingRequests)
    .find((req) => req.userId === interaction.user.id && req.panelId === (panelId || 'default'));
  if (duplicateRequest) {
    await interaction.editReply({ embeds: [makeTicketEmbed('تنبيه', '**لديك طلب استلام معلّق بالفعل، انتظر حتى تتم معالجته.**', 0xED4245)] });
    return;
  }
  pendingRequests[reqId] = {
    guildId,
    panelId: panelId || 'default',
    userId: interaction.user.id,
    reasonKey,
    sourceChannelId: interaction.channelId,
    openModalAnswers: interaction.ticketModalAnswers || null,
    createdAt: Date.now()
  };

  const targetChannelId = config.claimFromDedicatedChannel ? config.claimChannelId : interaction.channelId;
  const targetChannel = await guild.channels.fetch(targetChannelId).catch(() => null);
  if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
    delete pendingRequests[reqId];
    setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default');
    await interaction.editReply({ embeds: [makeTicketEmbed('خطأ', '**فشل : شات الاستلام غير صالح.**', 0xED4245)] });
    return;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_claimreq_${reqId}`).setStyle(ButtonStyle.Primary).setLabel('استلام التكت')
  );

  const reasonImage = resolveImageForSend(config.reasons?.[reasonKey]?.openImage || config.messages.ticketImage);

  const mentionChunks = buildMentionChunks(getAdminRoles(config, reasonKey));
  const acceptanceText = config.reasons?.[reasonKey]?.acceptanceMessage || config.messages.acceptance;

  if (acceptanceText) {
    await targetChannel.send({ embeds: [makeTicketEmbed('قبول التكت', acceptanceText)] }).catch(() => {});
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

  for (const chunk of mentionChunks) {
    await targetChannel.send({ content: chunk }).catch(() => {});
  }

  const requestSummary = `**العضو :** <@${interaction.user.id}>\n**السبب :** ${config.reasons?.[reasonKey]?.name || `سبب ${reasonKey}`}`;

  if (reasonImage) {
    await targetChannel.send({ content: requestSummary, files: [reasonImage], components: [row] });
  } else {
    await targetChannel.send({
      embeds: [makeTicketEmbed('طلب تكت', requestSummary)],
      components: [row]
    });
  }

  setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default');
  await interaction.editReply({ embeds: [makeTicketEmbed('تم', '**تم ارسال طلبك لشات الاستلام.**', 0x57F287)] });
}

async function handleClaimInTicket(interaction, guildId, panelId, channelId) {
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const lockKey = `claim:${guildId}:${panelId || 'default'}:${channelId}`;
  if (ticketClaimLocks.has(lockKey)) {
    await interaction.editReply({ embeds: [makeTicketEmbed('تنبيه', '**جاري معالجة الاستلام، حاول بعد لحظات.**', { user: interaction.user })] });
    return;
  }
  ticketClaimLocks.add(lockKey);
  try {
  const { config, tickets, pendingRequests } = getPanelData(guildId, panelId || 'default');
  const ticket = tickets[channelId];
  if (!ticket || ticket.status !== 'open' || interaction.channelId !== channelId) {
    await interaction.editReply({ embeds: [makeTicketEmbed('تنبيه', '**هذا التكت غير متاح.**', { user: interaction.user })] });
    return;
  }

  if (!hasStaffAccess(interaction.member, config, ticket?.reasonKey)) {
    await interaction.editReply({ embeds: [makeTicketEmbed('تنبيه', '**ليس لديك صلاحية الاستلام.**', { user: interaction.user })] });
    return;
  }

  if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) {
    await interaction.editReply({ embeds: [makeTicketEmbed('تنبيه', `**التكت مستلم مسبقاً بواسطة :** <@${ticket.claimedBy}>`, { user: interaction.user })] });
    return;
  }

  if (ticket.claimedBy === interaction.user.id) {
    await interaction.editReply({ embeds: [makeTicketEmbed('تنبيه', '**أنت مستلم هذا التكت بالفعل.**', { user: interaction.user })] });
    return;
  }

  const claimedCount = countClaimedByAdmin(tickets, interaction.user.id);
  if (claimedCount >= (config.adminClaimLimit || 1)) {
    await interaction.editReply({ embeds: [makeTicketEmbed('تنبيه', `**الحد :** لا يمكنك استلام أكثر من ${config.adminClaimLimit} تكت مفتوح.`, { user: interaction.user })] });
    return;
  }

  ticket.claimedBy = interaction.user.id;
  if (config.hideOnClaim) {
    await applyHideOnClaim(interaction.channel, interaction.guild, config, interaction.user.id, ticket.memberId, ticket.extraMembers || [], ticket.reasonKey);
  }

  setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default');
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
    const reason = config.reasons?.[ticket.reasonKey] || {};
    const claimImage = resolveImageForSend(reason.claimImage);
    const claimEmbed = makeTicketEmbed(
      'Ticket claimed',
      `**Ticket claimed by :** <@${interaction.user.id}>\n**Reason :** ${reason.name || `سبب ${ticket.reasonKey}`}\n**Member :** <@${ticket.memberId}>`
    );
    const mentionChunks = buildMentionChunks(getAdminRoles(config, ticket?.reasonKey));
    const firstChunk = mentionChunks.shift() || null;

    if (config.deleteClaimMessageOnClaim) {
      await interaction.message.delete().catch(() => {});
    } else {
      await interaction.message.edit({
        content: firstChunk,
        embeds: [claimEmbed],
        files: claimImage ? [claimImage] : [],
        components: updatedRows
      }).catch(() => {});
    }

    for (const chunk of mentionChunks) {
      await interaction.channel.send({ content: chunk }).catch(() => {});
    }
  }

  await interaction.editReply({ embeds: [makeTicketEmbed('تم', '**تم استلام التكت بنجاح.**', { user: interaction.user })] });
  } finally {
    ticketClaimLocks.delete(lockKey);
  }
}

async function handleClaimFromRequest(interaction, reqId) {
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const lockKey = `claimreq:${reqId}`;
  if (ticketClaimLocks.has(lockKey)) {
    await interaction.editReply({ embeds: [makeTicketEmbed('تنبيه', '**جاري معالجة هذا الطلب، حاول بعد لحظات.**', { user: interaction.user })] });
    return;
  }
  ticketClaimLocks.add(lockKey);
  try {
  const [guildId, panelId = 'default'] = reqId.split('_');
  const { config, tickets, pendingRequests } = getPanelData(guildId, panelId);
  const pruned = prunePendingRequests(pendingRequests);
  if (pruned) setGuildData(guildId, config, tickets, pendingRequests, panelId);
  const req = pendingRequests[reqId];

  if (!req) {
    await interaction.editReply({ embeds: [makeTicketEmbed('تنبيه', '**انتهى الطلب.**', { user: interaction.user })], ephemeral: true });
    return;
  }

  if (!hasStaffAccess(interaction.member, config, req?.reasonKey)) {
    await interaction.editReply({ embeds: [makeTicketEmbed('تنبيه', '**ليس لديك صلاحية الاستلام.**', { user: interaction.user })] });
    return;
  }

  const claimedCount = countClaimedByAdmin(tickets, interaction.user.id);
  if (claimedCount >= (config.adminClaimLimit || 1)) {
    await interaction.editReply({ embeds: [makeTicketEmbed('تنبيه', `**الحد :** لا يمكنك استلام أكثر من ${config.adminClaimLimit} تكت مفتوح.`, { user: interaction.user })] });
    return;
  }

  const member = await interaction.guild.members.fetch(req.userId).catch(() => null);
  if (!member) {
    delete pendingRequests[reqId];
    setGuildData(guildId, config, tickets, pendingRequests, panelId);
    await interaction.editReply({ embeds: [makeTicketEmbed('خطأ', '**لا يمكن العثور على العضو.**', { user: interaction.user })] });
    return;
  }

  let channel;
  try {
    channel = await createTicketChannel({
      guild: interaction.guild,
      member,
      config,
      reasonKey: req.reasonKey,
      tickets,
      pendingRequests,
      includeClaimButton: false,
      panelId: req.panelId || panelId,
      openModalAnswers: req.openModalAnswers || null
    });
  } catch (error) {
    console.error('ticket claimreq create channel error:', error?.message || error);
    await interaction.editReply({ embeds: [makeTicketEmbed('خطأ', '**فشل انشاء التكت من طلب الاستلام، تأكد من صلاحيات البوت والكاتوقري.**', { user: interaction.user })] });
    return;
  }
  tickets[channel.id].claimedBy = interaction.user.id;

  if (config.hideOnClaim) {
    await applyHideOnClaim(channel, interaction.guild, config, interaction.user.id, member.id, tickets[channel.id].extraMembers || [], tickets[channel.id].reasonKey);
  }

  const createdTicket = tickets[channel.id];
  const claimImage = resolveImageForSend(config.reasons?.[createdTicket.reasonKey]?.claimImage);
  await sendClaimAnnounce({ channel, config, ticket: createdTicket, claimerId: interaction.user.id, claimImage });

  if (interaction.message?.editable) {
    const reason = config.reasons?.[createdTicket.reasonKey] || {};
    const claimEmbed = makeTicketEmbed(
      'Ticket claimed',
      `**Ticket claimed by :** <@${interaction.user.id}>\n**Reason :** ${reason.name || `سبب ${createdTicket.reasonKey}`}\n**Member :** <@${createdTicket.memberId}>`
    );
    const updatedRows = interaction.message.components.map((row) => {
      const components = row.components.map((component) => {
        if (component.customId?.startsWith('ticket_claimreq_')) {
          return ButtonBuilder.from(component).setDisabled(true).setLabel('تم الاستلام');
        }
        return component;
      });
      return new ActionRowBuilder().addComponents(components);
    });
    if (config.deleteClaimMessageOnClaim) {
      await interaction.message.delete().catch(() => {});
    } else {
      await interaction.message.edit({ embeds: [claimEmbed], components: updatedRows }).catch(() => {});
    }
  }

  delete pendingRequests[reqId];
  setGuildData(guildId, config, tickets, pendingRequests, panelId);
  await interaction.editReply({ embeds: [makeTicketEmbed('تم استلام التكت', `**تم الاستلام والانشاء :** <#${channel.id}>`)] });
  } finally {
    ticketClaimLocks.delete(lockKey);
  }
}

async function handleClose(interaction, guildId, panelId, channelId) {
  const { config, tickets, pendingRequests } = getPanelData(guildId, panelId || 'default');
  const ticket = tickets[channelId];
  if (!ticket || interaction.channelId !== channelId) {
    await interaction.reply({ content: '**لا توجد بيانات لهذا التكت.**', ephemeral: true });
    return;
  }

  if (!canManageTicket(interaction, ticket, config)) {
    await interaction.reply({ content: '**ليس لديك صلاحية الاقفال.**', ephemeral: true });
    return;
  }

  if (ticket.closedAt) {
    await interaction.reply({ embeds: [makeTicketEmbed('تنبيه', '**التكت مقفل مسبقاً.**', 0xED4245)], ephemeral: true });
    return;
  }

  ticket.status = 'closed';
  ticket.closedAt = Date.now();
  ticket.memberHidden = true;
  ticket.claimerHidden = true;

  const transcriptFile = await buildTicketTranscript(interaction.channel).catch(() => null);

  if (!config.keepClosedTickets) {
    delete tickets[channelId];
    setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default');
    const transcriptDelivered = await sendTranscriptOutsideTicket(interaction, transcriptFile, 'Transcript before delete');
    await interaction.reply({
      embeds: [makeTicketEmbed('اقفال', `**سيتم حذف التكت خلال 3 ثواني.**${transcriptFile ? `
**حالة الترانسكربت:** ${transcriptDelivered ? 'تم إرساله خارج التكت.' : 'تعذر إرساله خارج التكت.'}` : ''}`, 0xED4245)],
      ephemeral: true
    });
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
    components: buildPostCloseControls(guildId, panelId || 'default', channelId, ticket)
  }).catch(() => {});

  if (transcriptFile) {
    await interaction.channel.send({ files: [transcriptFile], content: 'Transcript on close' }).catch(() => {});
  }

  setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default');
  await interaction.reply({ embeds: [makeTicketEmbed('اقفال', '**تم اقفال التكت والاحتفاظ به.**', 0xED4245)], ephemeral: true });
}

async function handleReassignRequest(interaction, guildId, panelId, channelId) {
  const { config, tickets, pendingRequests } = getPanelData(guildId, panelId || 'default');
  const ticket = tickets[channelId];
  if (!ticket || interaction.channelId !== channelId) {
    await interaction.reply({ content: '**لا توجد بيانات لهذا التكت.**', ephemeral: true });
    return;
  }
  if (!isAdminOnly(interaction, config, ticket?.reasonKey)) {
    await interaction.reply({ content: '**ليس لديك صلاحية تغيير المستلم.**', ephemeral: true });
    return;
  }
  if (ticket.status !== 'open') {
    await interaction.reply({ content: '**تغيير المستلم متاح فقط قبل إغلاق التكت.**', ephemeral: true });
    return;
  }

  const previousClaimer = ticket.claimedBy || null;
  if (ticket.reassignPendingAt) {
    await interaction.reply({ content: '**يوجد طلب تغيير مستلم معلّق بالفعل.**', ephemeral: true });
    return;
  }

  const targetChannelId = config.claimFromDedicatedChannel ? config.claimChannelId : interaction.channelId;
  const targetChannel = await interaction.guild.channels.fetch(targetChannelId).catch(() => null);
  if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
    await interaction.reply({ content: '**شات القبول غير صالح أو غير متاح.**', ephemeral: true });
    return;
  }

  const mentionChunks = buildMentionChunks(getAdminRoles(config, ticket?.reasonKey));
  const requestRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_reassign_claim_${guildId}_${panelId || 'default'}_${channelId}`)
      .setLabel('استلام المستلم الجديد')
      .setStyle(ButtonStyle.Primary)
  );

  const reason = config.reasons?.[ticket.reasonKey] || {};
  const reasonImage = resolveImageForSend(reason.openImage || config.messages.ticketImage);
  const requestText = `**العضو :** <@${ticket.memberId}>
**السبب :** ${reason.name || `سبب ${ticket.reasonKey}`}
**التكت :** <#${channelId}>`;

  try {
    for (const chunk of mentionChunks) {
      await targetChannel.send({ content: chunk });
    }

    if (reasonImage) {
      await targetChannel.send({ content: requestText, files: [reasonImage], components: [requestRow] });
    } else {
      await targetChannel.send({ embeds: [makeTicketEmbed('طلب استلام جديد', requestText)], components: [requestRow] });
    }
  } catch {
    await interaction.reply({ content: '**فشل إرسال طلب تغيير المستلم في شات القبول، تم إلغاء العملية.**', ephemeral: true });
    return;
  }

  ticket.claimedBy = null;
  ticket.reassignPendingAt = Date.now();

  if (interaction.user.id) {
    await interaction.channel.permissionOverwrites.edit(interaction.user.id, {
      ViewChannel: false,
      SendMessages: false
    }).catch(() => {});
  }
  if (previousClaimer && previousClaimer !== interaction.user.id) {
    await interaction.channel.permissionOverwrites.edit(previousClaimer, {
      ViewChannel: false,
      SendMessages: false
    }).catch(() => {});
  }

  setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default');
  await interaction.reply({ embeds: [makeTicketEmbed('تم', '**تم إخراجك من التكت وإرسال طلب استلام جديد.**', 0x57F287)], ephemeral: true });
}


async function handleReassignClaim(interaction, guildId, panelId, channelId) {
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const lockKey = `reassign_claim:${guildId}:${panelId || 'default'}:${channelId}`;
  if (ticketClaimLocks.has(lockKey)) {
    await interaction.editReply({ content: '**جاري معالجة الطلب، حاول بعد لحظات.**' }).catch(() => {});
    return;
  }
  ticketClaimLocks.add(lockKey);
  try {
  const { config, tickets, pendingRequests } = getPanelData(guildId, panelId || 'default');
  const ticket = tickets[channelId];
  if (!ticket) {
    await interaction.editReply({ content: '**لا توجد بيانات لهذا التكت.**' });
    return;
  }
  if (!hasStaffAccess(interaction.member, config, ticket?.reasonKey)) {
    await interaction.editReply({ content: '**ليس لديك صلاحية الاستلام.**' });
    return;
  }
  const claimedCount = countClaimedByAdmin(tickets, interaction.user.id);
  if (claimedCount >= (config.adminClaimLimit || 1)) {
    await interaction.editReply({ content: `**الحد :** لا يمكنك استلام أكثر من ${config.adminClaimLimit} تكت مفتوح.` });
    return;
  }
  if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) {
    await interaction.editReply({ content: `**تم الاستلام بالفعل بواسطة :** <@${ticket.claimedBy}>` });
    return;
  }
  if (!ticket.reassignPendingAt) {
    await interaction.editReply({ content: '**لا يوجد طلب تغيير مستلم نشط لهذا التكت.**' }).catch(() => {});
    return;
  }

  const ticketChannel = interaction.guild.channels.cache.get(channelId)
    || await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!ticketChannel || ticketChannel.type !== ChannelType.GuildText) {
    await interaction.editReply({ content: '**تعذر العثور على روم التكت.**' }).catch(() => {});
    return;
  }

  ticket.claimedBy = interaction.user.id;
  delete ticket.reassignPendingAt;
  await ticketChannel.permissionOverwrites.edit(interaction.user.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true
  }).catch(() => {});

  const reason = config.reasons?.[ticket.reasonKey] || {};
  const claimImage = resolveImageForSend(reason.claimImage);
  const claimEmbed = makeTicketEmbed(
    'Ticket claimed',
    `**Ticket claimed by :** <@${interaction.user.id}>\n**Reason :** ${reason.name || `سبب ${ticket.reasonKey}`}\n**Member :** <@${ticket.memberId}>`
  );

  if (interaction.message?.editable) {
    const rows = interaction.message.components.map((row) => {
      const comps = row.components.map((component) => {
        if (component.customId?.startsWith('ticket_reassign_claim_')) {
          return ButtonBuilder.from(component).setDisabled(true).setLabel('تم الاستلام');
        }
        return component;
      });
      return new ActionRowBuilder().addComponents(comps);
    });
    if (config.deleteClaimMessageOnClaim) {
      await interaction.message.delete().catch(() => {});
    } else {
      await interaction.message.edit({ components: rows }).catch(() => {});
    }
  }

  if (claimImage) await ticketChannel.send({ files: [claimImage], embeds: [claimEmbed] }).catch(() => {});
  else await ticketChannel.send({ embeds: [claimEmbed] }).catch(() => {});

  setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default');
  await interaction.editReply({ embeds: [makeTicketEmbed('تم', '**تم استلام التكت بالمستلم الجديد.**', 0x57F287)] });
  } finally {
    ticketClaimLocks.delete(lockKey);
  }
}

function createReasonComponents(config, guildId, panelId = 'default') {
  const reasons = Object.entries(config.reasons || {}).sort((a, b) => Number(a[0]) - Number(b[0])).slice(0, 25);
  if (config.displayMode === 'menu') {
    const options = reasons.length
      ? reasons.map(([k, v]) => ({ label: (v.name || `سبب ${k}`).slice(0, 100), description: (v.description || '').slice(0, 100) || undefined, value: `reason_${k}`, emoji: v.emoji || undefined }))
      : [{ label: 'فتح تكت عام', value: 'reason_0', emoji: '🎫' }];
    return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`ticket_open_menu_${guildId}_${panelId}`).setPlaceholder('اختر السبب').addOptions(options))];
  }

  const maxButtons = Math.max(1, Math.min(25, (config.buttonRows || 2) * 5));
  const entries = (reasons.length ? reasons : [['0', { name: 'فتح تكت', emoji: '🎫' }]])
    .sort((a, b) => Number(a[1]?.buttonOrder || a[0]) - Number(b[1]?.buttonOrder || b[0]))
    .slice(0, maxButtons);
  const buttons = entries.map(([k, v]) => new ButtonBuilder()
    .setCustomId(`ticket_open_btn_${guildId}_${panelId}_${k}`)
    .setLabel((v.name || `سبب ${k}`).slice(0, 80))
    .setStyle(resolveButtonStyle(v.buttonStyle))
    .setEmoji(v.emoji || '🎫'));

  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  return rows;
}

async function execute(message, args, { BOT_OWNERS = [], ADMIN_ROLES = [] }) {
  const dedupeKey = `${message.guild?.id || 'dm'}:${message.id}`;
  if (recentTicketCommandMessages.has(dedupeKey)) return;
  recentTicketCommandMessages.add(dedupeKey);
  setTimeout(() => recentTicketCommandMessages.delete(dedupeKey), 60 * 1000);

  const setupSessionKey = `${message.guild.id}:${message.author.id}`;
  const existingSession = activeTicketSetupSessions.get(setupSessionKey);
  if (existingSession && (Date.now() - existingSession.startedAt) < (30 * 60 * 1000)) {
    await message.reply('**لديك جلسة إعداد تكت قيد العمل بالفعل.**').catch(() => {});
    return;
  }

  const member = await message.guild.members.fetch(message.author.id);
  const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
  const hasAdminRole = member.roles.cache.some((r) => ADMIN_ROLES.includes(r.id));
  if (!isOwner && !hasAdminRole) {
    await message.react('❌');
    return;
  }

  const controlChannel = message.channel;
  let setupMessage = null;
  let activePromptInteraction = null;

  let panelId = extractChannelId((args || []).join(' '));
  if (!panelId) {
    await controlChannel.send('**ارسل اي دي او منشن الروم المراد ربط إعدادات التكت به.**').catch(() => {});
    const collected = await controlChannel.awaitMessages({
      filter: (m) => m.author.id === message.author.id,
      max: 1,
      time: 180000
    });
    const first = collected.first();
    if (first) {
      panelId = extractChannelId(first.content || '');
      await first.delete().catch(() => {});
    }
  }

  const panelChannel = panelId ? await message.guild.channels.fetch(panelId).catch(() => null) : null;
  if (!panelChannel || !panelChannel.isTextBased?.()) {
    await controlChannel.send('**❌ الروم غير صالح، استخدم منشن أو اي دي روم نصي صحيح.**').catch(() => {});
    return;
  }

  const { config, tickets, pendingRequests } = getPanelData(message.guild.id, panelId);

  const ask = async (prompt, timeout = 180000, options = {}) => {
    const opts = options && typeof options === 'object' ? options : {};
    const imageOnly = Boolean(opts.imageOnly);
    const preferAttachment = Boolean(opts.preferAttachment);

    if (activePromptInteraction) {
      await activePromptInteraction.followUp({ content: `🔒 ${prompt}`, ephemeral: true }).catch(() => {});
    }

    const maxAttempts = imageOnly ? 3 : 1;
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt += 1;

      const collected = await controlChannel.awaitMessages({
        filter: (m) => m.author.id === message.author.id,
        max: 1,
        time: timeout
      });
      const first = collected.first();
      if (!first) return null;

      const attachment = first.attachments?.first?.();
      const attachmentUrl = attachment?.url || null;
      const text = (first.content || '').trim();

      if (first) await first.delete().catch(() => {});

      if (imageOnly) {
        if (text === '0') return '0';
        if (attachmentUrl) return attachmentUrl;
        if (/^https?:\/\//i.test(text)) return text;

        const remaining = maxAttempts - attempt;
        if (remaining > 0) {
          await controlChannel.send(`**❌ ادخال الصورة غير صالح. المتبقي ${remaining} محاولة.**
**ارسل الصورة كمرفق بدون نص، او رابط مباشر للصورة، او 0 للإلغاء.**`).catch(() => {});
          continue;
        }

        await controlChannel.send('**❌ تم إلغاء العملية: لم يتم استلام صورة صالحة.**').catch(() => {});
        return null;
      }

      if (preferAttachment && attachmentUrl) return attachmentUrl;
      if (text) return text;
      return attachmentUrl;
    }

    return null;
  };

  const askNumberInRange = async (prompt, min, max) => {
    const raw = await ask(prompt);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
      await controlChannel.send(`**❌ ادخال غير صالح. اكتب رقمًا بين ${min} و ${max}.**`).catch(() => {});
      return null;
    }
    return value;
  };

  const promptAndStoreImage = async ({
    prompt,
    currentValue,
    slotKey,
    failureText
  }) => {
    const v = await ask(prompt, 180000, { imageOnly: true, preferAttachment: true });
    if (!v) {
      await activePromptInteraction?.followUp({ content: '**⚠️ لم يتم تغيير الصورة.**', ephemeral: true }).catch(() => {});
      return currentValue;
    }
    if (v === '0') {
      removeStoredImage(currentValue);
      await activePromptInteraction?.followUp({ content: '**✅ تم حذف الصورة بنجاح.**', ephemeral: true }).catch(() => {});
      return '';
    }
    try {
      const stored = await storeImageLocally(v, message.guild.id, slotKey, currentValue);
      await activePromptInteraction?.followUp({ content: '**✅ تم حفظ الصورة بنجاح.**', ephemeral: true }).catch(() => {});
      return stored;
    } catch {
      await activePromptInteraction?.followUp({ content: failureText || '**❌ فشل حفظ الصورة. تأكد ان الرابط مباشر او ارسل الصورة كمرفق.**', ephemeral: true }).catch(() => {});
      return currentValue;
    }
  };

  const notifySetupResult = async (text) => {
    await activePromptInteraction?.followUp({ content: text, ephemeral: true }).catch(() => {});
  };


  const buildSetupEmbed = () => {
    const reasonsCount = Object.keys(config.reasons || {}).length;
    const responsiblesMentions = (config.responsibleRoleIds || []).length
      ? (config.responsibleRoleIds || []).map((id) => `<@&${id}>`).join(' ')
      : 'غير معين';
    const adminRolesResolved = getAdminRoles(config);
    const adminRolesMentions = adminRolesResolved.length
      ? adminRolesResolved.map((id) => `<@&${id}>`).join(' ')
      : 'غير معين';
    const reasonsNamesRaw = Object.entries(config.reasons || {})
      .sort((a, b) => Number(a[1]?.buttonOrder || a[0]) - Number(b[1]?.buttonOrder || b[0]))
      .map(([k, v]) => `**${k})** ${v.name || `سبب ${k}`}`)
      .join('\n') || 'لا يوجد';
    const reasonsNames = reasonsNamesRaw.length > 1000 ? `${reasonsNamesRaw.slice(0, 1000)}\n...` : reasonsNamesRaw;
    const setupIssues = getSetupIssues();
    const setupStatus = setupIssues.length === 0
      ? 'مكتمل ✅'
      : `ناقص ⚠️\n${setupIssues.map((i) => `• ${i.replace(/\*\*/g, '')}`).join('\n')}`;

    return colorManager.createEmbed()
      .setColor(colorManager.getColor())
      .setTitle(`**اعدادات التكت : ${message.guild.name}**`)
      .setThumbnail(message.guild.iconURL({ dynamic: true, size: 256 }))
      .setDescription('**اختر من المنيو بالأسفل التعديل المطلوب.**')
      .addFields(
        { name: 'الروم الحالي', value: `<#${panelId}>`, inline: true },
        { name: 'اسم التكت', value: `${config.ticketNamePrefix} - ${config.ticketNameMode}`, inline: true },
        { name: 'كاتوقري الفتح', value: config.openCategoryId ? `<#${config.openCategoryId}>` : 'غير معين', inline: true },
        { name: 'المسؤولين', value: responsiblesMentions.slice(0, 1024), inline: false },
        { name: 'رولات الادمن', value: adminRolesMentions.slice(0, 1024), inline: false },
        { name: 'طريقة العرض', value: config.displayMode, inline: true },
        { name: 'حدود النظام', value: `حد الاستلام: ${config.adminClaimLimit}\nحد الفتح: ${config.memberOpenLimit}`, inline: true },
        { name: 'حالة التبديلات', value: `انشاء قبل الاستلام: ${config.autoCreateOnRequest ? 'مفعل' : 'مقفل'}\nاخفاء عند الاستلام: ${config.hideOnClaim ? 'مفعل' : 'مقفل'}\nشات استلام مخصص: ${config.claimFromDedicatedChannel ? 'مفعل' : 'مقفل'}\nالاحتفاظ بعد الاغلاق: ${config.keepClosedTickets ? 'مفعل' : 'مقفل'}\nحذف رسالة الاستلام بعد التنفيذ: ${config.deleteClaimMessageOnClaim ? 'مفعل' : 'مقفل'}`, inline: false },
        { name: `الاسباب (${reasonsCount})`, value: reasonsNames, inline: false },
        { name: 'جاهزية النظام', value: setupStatus.slice(0, 1024), inline: false }
      )
      .setFooter({ text: 'Ticket Settings • لوحة منظمة وسهلة القراءة' });
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

    if (!config.autoCreateOnRequest && !config.claimChannelId) {
      issues.push('**عند تعطيل الانشاء المباشر يجب تعيين شات الاستلام**');
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
        { label: '1) اسم شات التكت', value: 'set_name', description: 'تحديد بادئة الاسم وطريقة التسمية' },
        { label: '2) كاتوقري الفتح', value: 'set_open_category', description: 'تحديد كاتوقري استقبال التكتات' },
        { label: '3) تحديد المسؤولين', value: 'set_responsibles', description: 'الرولات التي تدير التكتات' },
        { label: '4) تحديد رولات الادمن', value: 'set_admin_roles', description: 'الرولات التي لها صلاحيات إدارية' },
        { label: '5) حد استلام الاداري', value: 'set_admin_limit', description: 'عدد التكتات المفتوحة لكل إداري' },
        { label: '6) حد فتح العضو', value: 'set_member_limit', description: 'عدد التكتات المفتوحة لكل عضو' },
        { label: '7) انشاء قبل الاستلام (toggle)', value: 'toggle_auto_create', description: 'فتح مباشر أو انتظار الاستلام' },
        { label: '8) اخفاء عند الاستلام (toggle)', value: 'toggle_hide_on_claim', description: 'إخفاء/إظهار بحسب المستلم' },
        { label: '9) الاستلام من شات مخصص', value: 'toggle_claim_channel', description: 'تفعيل شات منفصل لطلبات الاستلام' },
        { label: '10) الاحتفاظ بعد الاغلاق', value: 'toggle_keep_closed', description: 'حذف التكت أو إبقاؤه بعد الإغلاق' },
        { label: '11) اعدادات الرسائل (نصوص فقط)', value: 'set_messages', description: 'تخصيص النصوص قبل/بعد/قبول' },
        { label: '12) اعدادات الصور', value: 'set_images', description: 'تخصيص صور الفتح/الاستلام/الفاصل' },
        { label: '13) تعيين الاسباب', value: 'set_reasons', description: 'تعديل أسماء/وصف/كاتوقري الأسباب' },
        { label: '14) طريقة العرض', value: 'set_display_mode', description: 'الاختيار بين buttons أو menu' },
        { label: '15) ارسال بانل التكت', value: 'send_panel_now', description: 'إرسال بانل الفتح للروم المحدد' },
        { label: '16) حذف رسالة الاستلام بعد التنفيذ', value: 'toggle_delete_claim_msg', description: 'حذف رسالة القبول بعد الاستلام' },
        { label: 'انهاء الاعداد', value: 'finish', description: 'حفظ الإعدادات وإغلاق الجلسة' }
      ]);

    return [new ActionRowBuilder().addComponents(menu)];
  };

  await message.channel.send('**سيتم ضبط الاعدادات هنا، ومدخلاتك النصية ستحذف تلقائياً للحفاظ على الخصوصية.**').catch(() => {});

  setupMessage = await controlChannel.send({ embeds: [buildSetupEmbed()], components: buildMenuComponents() });
  activeTicketSetupSessions.set(setupSessionKey, { startedAt: Date.now(), messageId: setupMessage.id });

  const collector = setupMessage.createMessageComponentCollector({
    filter: (i) => i.user.id === message.author.id && i.customId.startsWith('ticket_setup_menu_'),
    time: 30 * 60 * 1000
  });

  const refresh = async (note = null, components = buildMenuComponents()) => {
    setGuildData(message.guild.id, config, tickets, pendingRequests, panelId);
    await setupMessage.edit({
      content: note || null,
      embeds: [buildSetupEmbed()],
      components
    }).catch(() => {});
  };

  const buildReasonsIndexText = () => {
    const lines = [];
    for (let i = 1; i <= 25; i += 1) {
      const key = String(i);
      const reason = config.reasons?.[key] || {};
      const label = reason.name || `سبب ${i}`;
      lines.push(`**${i})** ${label}`);
    }
    return lines.join('\n');
  };

  const buildReasonSelectOptions = () => {
    const options = [];
    for (let i = 1; i <= 25; i += 1) {
      const key = String(i);
      const reason = config.reasons?.[key] || {};
      options.push({
        label: `${i}) ${(reason.name || `سبب ${i}`).slice(0, 80)}`,
        description: (reason.description || `تعديل إعدادات السبب ${i}`).slice(0, 90),
        value: `reason_${i}`,
        emoji: reason.emoji || '🎫'
      });
    }
    return options;
  };

  const pickReasonFromMenu = async () => {
    await setupMessage.edit({
      content: '**اختر السبب من القائمة مباشرة.**',
      embeds: [
        colorManager.createEmbed()
          .setTitle('**اختيار السبب**')
          .setDescription('**اختر السبب من المنيو ثم عدّل كل تفاصيله (الاسم / الكاتوقري / الرسائل / الصور / المودال).**')
      ],
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`ticket_reason_pick_${message.author.id}_${Date.now()}`)
          .setPlaceholder('اختر السبب المراد تعديله')
          .addOptions(buildReasonSelectOptions())
      )]
    }).catch(() => {});

    const pick = await setupMessage.awaitMessageComponent({
      filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_reason_pick_'),
      time: 240000
    }).catch(() => null);

    if (!pick) return null;
    activePromptInteraction = pick;
    await pick.deferUpdate().catch(() => {});
    const raw = pick.values?.[0] || '';
    const idx = Number(String(raw).replace('reason_', ''));
    if (!Number.isFinite(idx) || idx < 1 || idx > 25) return null;
    return idx;
  };

  const openReasonSubmenu = async (key, reason, idx) => {
    let done = false;
    while (!done) {
      const modalFields = Array.isArray(reason.openModal?.fields) ? reason.openModal.fields : [];
      const modalOrderText = modalFields.length
        ? modalFields.map((f, i) => `**${i + 1})** ${String(f?.label || 'حقل').slice(0, 45)}`).join('\n')
        : 'لا يوجد';

      const state = colorManager.createEmbed()
        .setTitle(`**إعدادات السبب ${idx}**`)
        .setDescription('**التعديل من الأعلى للأقل أهمية: الاسم ← الكاتوقري ← الرسائل ← الصور ← العرض (عند الأزرار فقط) ← المودال.**')
        .addFields(
          {
            name: 'الهوية الأساسية',
            value: [
              `**الاسم:** ${reason.name || `سبب ${idx}`}`,
              `**اسم التكت:** ${reason.ticketName || 'افتراضي'}`,
              `**الايموجي:** ${formatSettingValue(reason.emoji || '🎫')}`,
              `**الكاتوقري:** ${reason.categoryId ? `<#${reason.categoryId}>` : 'افتراضي'}`
            ].join('\n'),
            inline: false
          },
          {
            name: 'رسائل السبب',
            value: [
              `**رسالة القبول:** ${formatSettingValue(reason.acceptanceMessage)}`,
              `**رسالة قبل الصورة:** ${formatSettingValue(reason.beforeImage)}`,
              `**رسالة بعد الصورة:** ${formatSettingValue(reason.afterImage)}`
            ].join('\n'),
            inline: false
          },
          {
            name: 'صور السبب',
            value: [
              `**صورة الفتح:** ${formatSettingValue(reason.openImage)}`,
              `**صورة الاستلام:** ${formatSettingValue(reason.claimImage)}`
            ].join('\n'),
            inline: false
          },
          {
            name: 'العرض الخاص بالسبب',
            value: [
              `**لون الزر:** ${formatSettingValue(reason.buttonStyle || 'primary')}`,
              `**ترتيب الزر:** ${formatSettingValue(reason.buttonOrder || idx)}`,
              `**الحالة:** ${config.displayMode === 'buttons' ? 'يعمل الآن' : 'غير مستخدم لأن طريقة العرض الحالية ليست أزرار'}`
            ].join('\n'),
            inline: false
          },
          {
            name: 'إدارة السبب',
            value: [
              `**الحالة:** ${reason.useCustomAdminRoles ? 'رولات خاصة بهذا السبب' : 'الرولات الإدارية العامة'}`,
              `**الرولات:** ${reason.useCustomAdminRoles ? ((reason.adminRoleIds || []).map((id) => `<@&${id}>`).join(' ') || 'لا يوجد') : 'يستخدم العام'}`
            ].join('\n').slice(0, 1024),
            inline: false
          },
          {
            name: 'مودال السبب',
            value: [
              `**الحالة:** ${reason.openModal?.enabled ? 'مفعل' : 'غير مفعل'}`,
              `**العنوان:** ${formatSettingValue(reason.openModal?.title)}`,
              `**الوصف:** ${formatSettingValue(reason.openModal?.description)}`,
              `**ترتيب الحقول:** ${modalOrderText}`
            ].join('\n').slice(0, 1024),
            inline: false
          }
        );

      await setupMessage.edit({
        content: '**اختر العنصر المطلوب تعديله لهذا السبب، أو انهاء للرجوع.**',
        embeds: [state],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_reason_menu_${message.author.id}_${Date.now()}`)
            .setPlaceholder('اختر إعداد السبب')
            .addOptions([
              { label: '1) اسم السبب', value: 'r1', description: 'الاسم الذي يظهر للعضو' },
              { label: '2) كاتوقري السبب', value: 'r2', description: 'كاتوقري مخصص لهذا السبب' },
              { label: '3) اسم التكت لهذا السبب', value: 'r3', description: 'اسم مخصص بدل الافتراضي' },
              { label: '4) رسالة القبول لهذا السبب', value: 'r4', description: 'تظهر في شات الاستلام' },
              { label: '5) رسالة قبل صورة التكت', value: 'r5', description: 'داخل التكت قبل الصورة' },
              { label: '6) رسالة بعد صورة التكت', value: 'r6', description: 'داخل التكت بعد الصورة' },
              { label: '7) صورة الفتح لهذا السبب', value: 'r7', description: 'ترسل عند فتح التكت' },
              { label: '8) صورة الاستلام لهذا السبب', value: 'r8', description: 'ترسل عند استلام التكت' },
              { label: '9) ايموجي السبب', value: 'r9', description: 'ايموجي يظهر مع السبب' },
              { label: '10) لون وترتيب زر السبب', value: 'r10', description: 'يعمل فقط إذا كانت طريقة العرض أزرار' },
              { label: '11) رولات الإدارة الخاصة بهذا السبب', value: 'r11', description: 'تستبدل الرولات الإدارية العامة لهذا السبب فقط' },
              { label: '12) مودال السبب وترتيب حقوله', value: 'r12', description: 'حقول من الأهم للأقل' },
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

      if (c === 'r1') {
        const v = await ask('**اسم السبب : (0 لاعادة التعيين)**');
        reason.name = v === '0' ? `سبب ${idx}` : (v || reason.name);
        await notifySetupResult('**✅ تم تحديث اسم السبب.**');
      }
      if (c === 'r2') {
        const v = await ask('**كاتوقري السبب : منشن/ايدي (0 لاعادة التعيين)**');
        reason.categoryId = v === '0' ? null : normalizeId(v);
        await notifySetupResult('**✅ تم تحديث كاتوقري السبب.**');
      }
      if (c === 'r3') {
        const v = await ask('**اسم التكت لهذا السبب : (0 لاعادة التعيين)**');
        reason.ticketName = v === '0' ? '' : (v || reason.ticketName);
        await notifySetupResult('**✅ تم تحديث اسم التكت للسبب.**');
      }
      if (c === 'r4') {
        const v = await ask('**رسالة القبول لهذا السبب : (0 لاعادة التعيين)**');
        reason.acceptanceMessage = v === '0' ? '' : (v || reason.acceptanceMessage || '');
        await notifySetupResult('**✅ تم تحديث رسالة القبول الخاصة بالسبب.**');
      }
      if (c === 'r5') {
        const v = await ask('**رسالة قبل الصورة : (0 لاعادة التعيين)**');
        reason.beforeImage = v === '0' ? '' : (v || reason.beforeImage);
        await notifySetupResult('**✅ تم تحديث رسالة ما قبل الصورة.**');
      }
      if (c === 'r6') {
        const v = await ask('**رسالة بعد الصورة : (0 لاعادة التعيين)**');
        reason.afterImage = v === '0' ? '' : (v || reason.afterImage);
        await notifySetupResult('**✅ تم تحديث رسالة ما بعد الصورة.**');
      }
      if (c === 'r7') {
        reason.openImage = await promptAndStoreImage({
          prompt: '**صورة فتح السبب: ارسل رابط صورة او ارفق صورة (0 للحذف)**',
          currentValue: reason.openImage,
          slotKey: `reason_${key}_open`,
          failureText: '**❌ فشل حفظ صورة فتح السبب.**'
        });
      }
      if (c === 'r8') {
        reason.claimImage = await promptAndStoreImage({
          prompt: '**صورة استلام السبب: ارسل رابط صورة او ارفق صورة (0 للحذف)**',
          currentValue: reason.claimImage,
          slotKey: `reason_${key}_claim`,
          failureText: '**❌ فشل حفظ صورة استلام السبب.**'
        });
      }
      if (c === 'r9') {
        const emo = await ask('**ايموجي السبب : (0 لاعادة التعيين)**');
        reason.emoji = emo === '0' ? '🎫' : (emo || reason.emoji);
        await notifySetupResult('**✅ تم تحديث ايموجي السبب.**');
      }
      if (c === 'r10') {
        if (config.displayMode !== 'buttons') {
          await notifySetupResult('**❌ لا يمكن تعديل لون أو ترتيب السبب إلا عندما تكون طريقة العرض الأساسية أزرار (buttons).**');
        } else {
          const v = ((await ask('**لون الزر: primary / secondary / success / danger (0 لاعادة التعيين)**')) || '').toLowerCase();
          if (v === '0') reason.buttonStyle = 'primary';
          else if (['primary', 'secondary', 'success', 'danger'].includes(v)) reason.buttonStyle = v;

          const order = Number(await ask('**ترتيب الزر (رقم من 1 الى 999 - 0 لاعادة التعيين)**'));
          if (order === 0) reason.buttonOrder = idx;
          else if (Number.isFinite(order) && order >= 1 && order <= 999) reason.buttonOrder = order;
          await notifySetupResult('**✅ تم تحديث لون وترتيب زر السبب.**');
        }
      }
      if (c === 'r11') {
        const raw = await ask('**رولات الإدارة الخاصة بهذا السبب: منشن/آيدي الرولات أو 0 للرجوع للرولات العامة**');
        if (raw === '0') {
          reason.useCustomAdminRoles = false;
          reason.adminRoleIds = [];
          await notifySetupResult('**✅ تم إرجاع هذا السبب إلى الرولات الإدارية العامة.**');
        } else {
          const parsed = (raw || '').split(/\s+/).map(normalizeId).filter(Boolean);
          if (parsed.length === 0) {
            await notifySetupResult('**❌ فشل حفظ رولات الإدارة الخاصة بالسبب: أرسل منشنات أو آيديات رولات صالحة.**');
          } else {
            reason.useCustomAdminRoles = true;
            reason.adminRoleIds = [...new Set(parsed)];
            await notifySetupResult('**✅ تم تحديث رولات الإدارة الخاصة بهذا السبب.**');
          }
        }
      }
      if (c === 'r12') {
        const enabled = ((await ask('**تفعيل مودال السبب؟ yes/no**')) || '').toLowerCase();
        if (!reason.openModal || typeof reason.openModal !== 'object') {
          reason.openModal = { enabled: false, title: '', description: '', fields: [] };
        }

        if (enabled === 'yes' || enabled === 'y' || enabled === 'نعم') {
          reason.openModal.enabled = true;

          const title = await ask('**عنوان المودال (0 لاعادة التعيين)**');
          if (title === '0') reason.openModal.title = '';
          else if (title) reason.openModal.title = title.slice(0, 45);

          const desc = await ask('**شرح المودال (0 لاعادة التعيين)**');
          if (desc === '0') reason.openModal.description = '';
          else if (desc) reason.openModal.description = desc.slice(0, 200);

          const labelsRaw = await ask('**حقول المودال بالترتيب من الأهم للأقل (افصل بينهم |) مثال: الاسم|الايدي|الوصف**');
          if (labelsRaw === '0') {
            reason.openModal.fields = [];
          } else {
            const labels = String(labelsRaw || '')
              .split('|')
              .map((x) => x.trim())
              .filter(Boolean)
              .slice(0, 5)
              .map((label) => ({ label: label.slice(0, 45), placeholder: '', style: 'short', required: true }));
            reason.openModal.fields = labels;
          }
          await notifySetupResult('**✅ تم تحديث المودال وترتيب حقوله.**');
        } else {
          reason.openModal = { enabled: false, title: '', description: '', fields: [] };
          await notifySetupResult('**✅ تم تعطيل مودال السبب.**');
        }
      }

      config.reasons[key] = reason;
    }
  };


  const openMessagesSubmenu = async () => {
    let done = false;
    while (!done) {
      const state = colorManager.createEmbed()
        .setTitle('**اعدادات الرسائل**')
        .setDescription('**كل خيار يوضح مكان ظهور الرسالة داخل نظام التكت.**')
        .addFields(
          {
            name: '1) رسالة القبول',
            value: `**المكان:** شات الاستلام\n**القيمة الحالية:** ${formatSettingValue(config.messages.acceptance)}`,
            inline: false
          },
          {
            name: '2) رسالة قبل صورة التكت',
            value: `**المكان:** داخل شات التكت قبل الصورة\n**القيمة الحالية:** ${formatSettingValue(config.messages.beforeImage)}`,
            inline: false
          },
          {
            name: '3) رسالة بعد صورة التكت',
            value: `**المكان:** داخل شات التكت بعد الصورة\n**القيمة الحالية:** ${formatSettingValue(config.messages.afterImage)}`,
            inline: false
          }
        );

      await setupMessage.edit({
        content: '**اختر من قائمة اعدادات الرسائل، او انهاء للرجوع.**',
        embeds: [state],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_msg_menu_${message.author.id}_${Date.now()}`)
            .setPlaceholder('اختر اعداد الرسائل')
            .addOptions([
              { label: '1) رسالة القبول - شات الاستلام', description: 'تظهر في روم طلبات الاستلام', value: 'm1' },
              { label: '2) رسالة قبل الصورة - شات التكت', description: 'تظهر قبل صورة فتح التكت', value: 'm2' },
              { label: '3) رسالة بعد الصورة - شات التكت', description: 'تظهر بعد صورة فتح التكت', value: 'm3' },
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

      if (c === 'm1') {
        const v = await ask('**رسالة القبول (تظهر في شات الاستلام) : (0 لاعادة التعيين)**');
        config.messages.acceptance = v === '0' ? '' : (v || '');
        await activePromptInteraction?.followUp({ content: '**✅ تم تحديث رسالة القبول.**', ephemeral: true }).catch(() => {});
      }
      if (c === 'm2') {
        const v = await ask('**رسالة قبل صورة التكت (داخل شات التكت) : (0 لاعادة التعيين)**');
        config.messages.beforeImage = v === '0' ? '' : (v || '');
        await activePromptInteraction?.followUp({ content: '**✅ تم تحديث رسالة ما قبل الصورة.**', ephemeral: true }).catch(() => {});
      }
      if (c === 'm3') {
        const v = await ask('**رسالة بعد صورة التكت (داخل شات التكت) : (0 لاعادة التعيين)**');
        config.messages.afterImage = v === '0' ? '' : (v || '');
        await activePromptInteraction?.followUp({ content: '**✅ تم تحديث رسالة ما بعد الصورة.**', ephemeral: true }).catch(() => {});
      }
    }
  };


  const openImagesSubmenu = async () => {
    let done = false;
    while (!done) {
      const state = colorManager.createEmbed()
        .setTitle('**اعدادات الصور**')
        .setDescription('**رفع الصورة يتم بطريقتين:** ارسال رابط مباشر للصورة أو ارفاق الصورة بدون نص.')
        .addFields(
          {
            name: '1) صورة التكت العامة',
            value: `**المكان:** داخل شات التكت عند الفتح\n**القيمة الحالية:** ${formatSettingValue(config.messages.ticketImage)}`,
            inline: false
          },
          {
            name: '2) صورة/نص فاصل شات الاستلام',
            value: `**المكان:** داخل شات الاستلام بين الطلبات\n**القيمة الحالية:** ${formatSettingValue(config.claimChannelSeparator)}`,
            inline: false
          },
          {
            name: '3) صور السبب',
            value: '**المكان:** لكل سبب على حدة (صورة فتح + صورة استلام).',
            inline: false
          }
        );

      await setupMessage.edit({
        content: '**اختر اعداد الصور، او انهاء للرجوع.**',
        embeds: [state],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_img_menu_${message.author.id}_${Date.now()}`)
            .setPlaceholder('اختر اعداد الصور')
            .addOptions([
              { label: '1) صورة التكت العامة', description: 'تظهر داخل شات التكت', value: 'i1' },
              { label: '2) صورة/نص فاصل شات الاستلام', description: 'يظهر بين طلبات الاستلام', value: 'i2' },
              { label: '3) صور السبب', description: 'لكل سبب: فتح + استلام', value: 'i3' },
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
        config.messages.ticketImage = await promptAndStoreImage({
          prompt: '**صورة التكت العامة: ارسل رابط صورة او ارفق صورة (0 للحذف)**',
          currentValue: config.messages.ticketImage,
          slotKey: 'global_ticket_image',
          failureText: '**❌ فشل حفظ الصورة العامة.**'
        });
      }

      if (c === 'i2') {
        config.claimChannelSeparator = await promptAndStoreImage({
          prompt: '**صورة فاصل شات الاستلام: ارسل رابط صورة او ارفق صورة (0 للحذف)**',
          currentValue: config.claimChannelSeparator,
          slotKey: 'claim_separator',
          failureText: '**❌ فشل حفظ صورة الفاصل.**'
        });
      }

      if (c === 'i3') {
        await setupMessage.edit({
          content: '**اختر رقم السبب من القائمة التالية ثم اكتب الرقم في الشات.**',
          embeds: [colorManager.createEmbed().setTitle('**فهرس الأسباب (1 - 25)**').setDescription(buildReasonsIndexText())],
          components: []
        }).catch(() => {});

        const idx = await askNumberInRange('**اختر رقم السبب من 1 الى 25**', 1, 25);
        if (!idx) continue;
        const key = String(idx);
        const reason = {
          name: `سبب ${idx}`,
          openImage: '',
          claimImage: '',
          ...(config.reasons[key] || {})
        };

        await setupMessage.edit({
          content: '**اختر نوع الصورة لهذا السبب.**',
          embeds: [colorManager.createEmbed().setTitle(`**صور السبب ${idx}**`).setDescription([
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

        if (rc === 'open') {
          reason.openImage = await promptAndStoreImage({
            prompt: '**صورة فتح السبب: ارسل رابط صورة او ارفق صورة (0 للحذف)**',
            currentValue: reason.openImage,
            slotKey: `reason_${key}_open`,
            failureText: '**❌ فشل حفظ صورة السبب.**'
          });
        }
        if (rc === 'claim') {
          reason.claimImage = await promptAndStoreImage({
            prompt: '**صورة استلام السبب: ارسل رابط صورة او ارفق صورة (0 للحذف)**',
            currentValue: reason.claimImage,
            slotKey: `reason_${key}_claim`,
            failureText: '**❌ فشل حفظ صورة السبب.**'
          });
        }

        config.reasons[key] = { ...(config.reasons[key] || {}), ...reason };
      }
    }
  };


  const openDisplayModeSubmenu = async () => {
    let done = false;
    while (!done) {
      const state = colorManager.createEmbed()
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
          await refresh('**✅ تم إعادة تعيين اسم التكت للوضع الافتراضي.**');
          await notifySetupResult('**✅ تم إعادة تعيين اسم التكت للوضع الافتراضي.**');
          return;
        }

        if (!['counter', 'user'].includes((mode || '').toLowerCase())) {
          await refresh('**❌ فشل تحديث الاسم: اكتب فقط counter أو user أو 0.**');
          await notifySetupResult('**❌ فشل تحديث الاسم: اكتب فقط counter أو user أو 0.**');
          return;
        }

        config.ticketNameMode = mode.toLowerCase();
        const prefix = await ask('**اكتب : بادئة اسم التكت**');
        if (prefix && prefix !== '0') config.ticketNamePrefix = sanitizeName(prefix);

        await refresh('**✅ تم تحديث الاسم.**');
        await notifySetupResult('**✅ تم تحديث إعداد الاسم بنجاح.**');
        return;
      }

      if (choice === 'set_open_category') {
        const v = await ask('**ارسل : منشن/ايدي الكاتوقري (0 لاعادة التعيين)**');
        if (v === '0') {
          config.openCategoryId = null;
          await refresh('**✅ تم إعادة تعيين كاتوقري الفتح.**');
          await notifySetupResult('**✅ تم إعادة تعيين كاتوقري الفتح.**');
          return;
        }

        const catId = normalizeId(v);
        if (!catId) {
          await refresh('**❌ فشل تحديث كاتوقري الفتح: أرسل منشن أو آيدي كاتوقري صحيح.**');
          await notifySetupResult('**❌ فشل تحديث كاتوقري الفتح: أرسل منشن أو آيدي كاتوقري صحيح.**');
          return;
        }

        config.openCategoryId = catId;
        await refresh('**✅ تم تحديث كاتوقري الفتح.**');
        await notifySetupResult('**✅ تم تحديث كاتوقري الفتح بنجاح.**');
        return;
      }

      if (choice === 'set_responsibles') {
        const v = await ask([
          '**تحديد المسؤولين - اختر طريقة واحدة:**',
          '**0 = رولات الادمن العامة**',
          '**اسم مسؤولية = مسؤولية معينة** (مثال: مسؤولية الدعم / المسؤولية الدعم)',
          '**منشن رولات = رولات محددة**'
        ].join('\n'));
        if (v === '0') config.responsibleRoleIds = [];
        else if (findResponsibilityByName(v, loadResponsibilities())) {
          const resp = loadResponsibilities();
          const foundName = findResponsibilityByName(v, resp);
          const selected = foundName ? resp[foundName] : null;
          const set = new Set((selected?.roles || []).map((id) => String(id || '').trim()).filter((id) => /^\d{16,20}$/.test(id)));
          config.responsibleRoleIds = [...set];
          if (config.responsibleRoleIds.length === 0) {
            await refresh(`**تنبيه : المسؤولية \"${foundName}\" لا تحتوي رولات صالحة.**`);
            return;
          }
          await refresh(`**تم تعيين المسؤولين من المسؤولية : ${foundName}**`);
          return;
        } else {
          config.responsibleRoleIds = (v || '').split(/\s+/).map(normalizeId).filter(Boolean);
        }
        if (config.responsibleRoleIds.length === 0) {
          await refresh( '**تنبيه : لم يتم حفظ اي رول مسؤول صالح.**');
          return;
        }
        await refresh('**✅ تم تحديث المسؤولين.**');
        await notifySetupResult('**✅ تم تحديث المسؤولين بنجاح.**');
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
        await refresh('**✅ تم تحديث رولات الادمن.**');
        await notifySetupResult('**✅ تم تحديث رولات الادمن بنجاح.**');
        return;
      }

      if (choice === 'set_admin_limit') {
        const n = Number(await ask('**اكتب : حد استلام الاداري المفتوح**'));
        if (!Number.isFinite(n) || n <= 0) {
          await refresh('**❌ فشل تحديث حد استلام الاداري: أدخل رقمًا أكبر من 0.**');
          await notifySetupResult('**❌ فشل تحديث حد استلام الاداري: أدخل رقمًا أكبر من 0.**');
          return;
        }
        config.adminClaimLimit = n;
        await refresh('**✅ تم تحديث حد استلام الاداري.**');
        await notifySetupResult('**✅ تم تحديث حد استلام الاداري بنجاح.**');
        return;
      }

      if (choice === 'set_member_limit') {
        const n = Number(await ask('**اكتب : حد فتح العضو المفتوح**'));
        if (!Number.isFinite(n) || n <= 0) {
          await refresh('**❌ فشل تحديث حد فتح العضو: أدخل رقمًا أكبر من 0.**');
          await notifySetupResult('**❌ فشل تحديث حد فتح العضو: أدخل رقمًا أكبر من 0.**');
          return;
        }
        config.memberOpenLimit = n;
        await refresh('**✅ تم تحديث حد فتح العضو.**');
        await notifySetupResult('**✅ تم تحديث حد فتح العضو بنجاح.**');
        return;
      }

      if (choice === 'toggle_auto_create') {
        config.autoCreateOnRequest = !config.autoCreateOnRequest;
        await refresh(`**✅ تم التحديث : ${config.autoCreateOnRequest ? 'مفعل' : 'مقفل'}**`);
        await notifySetupResult(`**✅ حالة إنشاء التكت قبل الاستلام: ${config.autoCreateOnRequest ? 'مفعل' : 'مقفل'}.**`);
        return;
      }

      if (choice === 'toggle_hide_on_claim') {
        config.hideOnClaim = !config.hideOnClaim;
        await refresh(`**✅ تم التحديث : ${config.hideOnClaim ? 'مفعل' : 'مقفل'}**`);
        await notifySetupResult(`**✅ حالة إخفاء التكت عند الاستلام: ${config.hideOnClaim ? 'مفعل' : 'مقفل'}.**`);
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
        await refresh(`**✅ تم التحديث : ${config.claimFromDedicatedChannel ? 'مفعل' : 'مقفل'}**`);
        await notifySetupResult(`**✅ حالة شات الاستلام المخصص: ${config.claimFromDedicatedChannel ? 'مفعل' : 'مقفل'}.**`);
        return;
      }

      if (choice === 'toggle_keep_closed') {
        config.keepClosedTickets = !config.keepClosedTickets;
        if (config.keepClosedTickets) {
          const v = await ask('**ارسل : كاتوقري المقفلة (0 للبقاء بنفس المكان)**');
          config.closedCategoryId = v === '0' ? null : normalizeId(v);
        }
        await refresh(`**✅ تم التحديث : ${config.keepClosedTickets ? 'مفعل' : 'مقفل'}**`);
        await notifySetupResult(`**✅ حالة الاحتفاظ بالتكت بعد الإغلاق: ${config.keepClosedTickets ? 'مفعل' : 'مقفل'}.**`);
        return;
      }

      if (choice === 'set_messages') {
        await openMessagesSubmenu();
        await refresh('**✅ تم تحديث اعدادات الرسائل.**');
        await notifySetupResult('**✅ تم حفظ إعدادات الرسائل بنجاح.**');
        return;
      }

      if (choice === 'set_images') {
        await openImagesSubmenu();
        await refresh('**✅ تم تحديث اعدادات الصور.**');
        await notifySetupResult('**✅ تم حفظ إعدادات الصور بنجاح.**');
        return;
      }

      if (choice === 'set_reasons') {
        if (!config.openCategoryId) {
          await refresh('**يلزم تعيين كاتوقري الفتح قبل تعديل الاسباب.**');
          return;
        }

        const idx = await pickReasonFromMenu();
        if (!Number.isFinite(idx) || idx < 1 || idx > 25) {
          await refresh('**❌ لم يتم اختيار سبب صالح.**');
          await notifySetupResult('**❌ لم يتم اختيار سبب صالح.**');
          return;
        }

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
          acceptanceMessage: '',
          useCustomAdminRoles: false,
          adminRoleIds: [],
          ...(config.reasons[key] || {})
        };

        await openReasonSubmenu(key, reason, idx);
        config.reasons[key] = reason;

        await refresh('**✅ تم تحديث السبب.**');
        await notifySetupResult('**✅ تم حفظ إعدادات السبب بنجاح.**');
        return;
      }

      if (choice === 'set_display_mode') {
        await openDisplayModeSubmenu();
        await refresh('**✅ تم تحديث طريقة العرض.**');
        await notifySetupResult('**✅ تم حفظ إعدادات طريقة العرض بنجاح.**');
        return;
      }

      if (choice === 'send_panel_now') {
        if (!(await assertSetupReady('ارسال البانل'))) return;

        const mode = ((await ask('**طريقة الارسال : text / image / both**')) || 'both').toLowerCase();
        if (!['text', 'image', 'both'].includes(mode)) {
          await refresh('**❌ طريقة ارسال غير صالحة. استخدم text أو image أو both.**');
          return;
        }

        const text = mode === 'image' ? '' : await ask('**النص : (0 لتخطي)**');
        const imageInput = mode === 'text' ? '' : await ask('**الصورة : رابط مباشر او ارفق صورة فقط (0 لالغاء العملية)**', 180000, { imageOnly: true, preferAttachment: true });

        const payload = {
          content: text && text !== '0' ? text : null,
          components: createReasonComponents(config, message.guild.id, panelId)
        };

        if (mode === 'image' || mode === 'both') {
          if (!imageInput || imageInput === '0') {
            await refresh('**❌ تم إلغاء ارسال البانل: وضع الصورة يتطلب صورة صالحة.**');
            return;
          }

          let storedPanelImage = '';
          try {
            storedPanelImage = await storeImageLocally(imageInput, message.guild.id, `panel_send_${Date.now()}`);
          } catch {
            await refresh('**❌ فشل رفع صورة البانل. تأكد ان الرابط مباشر أو ارسل الصورة كمرفق بدون نص.**');
            return;
          }

          const panelImage = resolveImageForSend(storedPanelImage);
          if (!panelImage) {
            await refresh('**❌ فشل تجهيز صورة البانل بعد الحفظ.**');
            return;
          }

          await panelChannel.send({ ...payload, files: [panelImage] }).catch(() => {});
          removeStoredImage(storedPanelImage);
        } else {
          await panelChannel.send(payload);
        }

        await refresh(`**✅ تم ارسال بانل التكت بنجاح في <#${panelId}>.**`);
        return;
      }

      if (choice === 'toggle_delete_claim_msg') {
        config.deleteClaimMessageOnClaim = !config.deleteClaimMessageOnClaim;
        await refresh(`**✅ تم التحديث : ${config.deleteClaimMessageOnClaim ? 'مفعل' : 'مقفل'}**`);
        await notifySetupResult(`**✅ حالة حذف رسالة الاستلام بعد التنفيذ: ${config.deleteClaimMessageOnClaim ? 'مفعل' : 'مقفل'}.**`);
        return;
      }

    } catch {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '**حدث خطأ اثناء تحديث الاعدادات.**', ephemeral: true }).catch(() => {});
      }
    }
  });

  collector.on('end', async () => {
    setGuildData(message.guild.id, config, tickets, pendingRequests, panelId);
    await setupMessage.edit({ embeds: [buildSetupEmbed()], components: [] }).catch(() => {});
    await controlChannel.send('**تم حفظ اعدادات التكت.**').catch(() => {});
    activeTicketSetupSessions.delete(setupSessionKey);
  });
}

async function handleTransferResponsibility(interaction, guildId, panelId, channelId, value) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
  }

  if (!value || value === 'resp_none') {
    await interaction.editReply({ content: '**لا توجد مسؤولية صالحة.**' }).catch(() => {});
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
    await interaction.editReply({ content: '**لا توجد مسؤولية صالحة.**' }).catch(() => {});
    return;
  }

  const { config, tickets, pendingRequests } = getPanelData(guildId, panelId || 'default');
  const ticket = tickets[channelId];
  if (!ticket || interaction.channelId !== channelId) {
    await interaction.editReply({ content: '**لا توجد بيانات لهذا التكت.**' }).catch(() => {});
    return;
  }

  if (!canManageTicket(interaction, ticket, config)) {
    await interaction.editReply({ content: '**ليس لديك صلاحية التحويل.**' }).catch(() => {});
    return;
  }

  const selected = responsibilities[respName];
  if (!selected) {
    await interaction.editReply({ content: '**المسؤولية غير موجودة.**' }).catch(() => {});
    return;
  }

  const previousClaimer = ticket.claimedBy;
  ticket.claimedBy = null;
  ticket.transferredTo = respName;

  const targetRoles = (selected.roles || [])
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id) && interaction.guild.roles.cache.has(id));
  const adminRoles = getAdminRoles(config, ticket?.reasonKey);
  const allKnownRoles = [...new Set([...(config.responsibleRoleIds || []).map((id) => String(id)), ...targetRoles])];

  for (const roleId of allKnownRoles) {
    const shouldSee = targetRoles.includes(roleId) || adminRoles.includes(roleId);
    await interaction.channel.permissionOverwrites.edit(roleId, {
      ViewChannel: shouldSee,
      SendMessages: shouldSee,
      ReadMessageHistory: shouldSee
    }).catch(() => {});
  }

  config.responsibleRoleIds = [...targetRoles];
  setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default');

  const responsibleUsers = (selected.responsibles || [])
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id));

  const mentions = [
    ...targetRoles.map((id) => `<@&${id}>`),
    ...responsibleUsers.map((id) => `<@${id}>`)
  ];

  const onlineResponsibleMentions = responsibleUsers
    .filter((uid) => {
      const member = interaction.guild.members.cache.get(uid);
      const status = member?.presence?.status;
      return status && status !== 'offline';
    })
    .map((uid) => `<@${uid}>`);

  if (previousClaimer) {
    await interaction.channel.permissionOverwrites.edit(previousClaimer, { ViewChannel: false, SendMessages: false }).catch(() => {});
  }
  const dmEmbed = makeTicketEmbed('تحويل تكت', `يوجد تكت تم تحويله لمسؤوليتكم في <#${channelId}>`, 0x5865F2);
  for (const uid of responsibleUsers) {
    const user = await interaction.client.users.fetch(uid).catch(() => null);
    if (user) await user.send({ embeds: [dmEmbed] }).catch(() => {});
  }

  const mentionChunks = buildMentionChunks(targetRoles);
  for (const chunk of mentionChunks) {
    await interaction.channel.send({ content: chunk }).catch(() => {});
  }

  const renamed = `مسؤولين-${sanitizeName(respName)}`.slice(0, 90);
  await interaction.channel.setName(renamed).catch(() => {});

  await interaction.editReply({
    content: mentions.join(' ') || null,
    embeds: [makeTicketEmbed('تحويل', `**تم تحويل التكت لمسؤولين : ${respName}**\n**المتصلون الآن:** ${onlineResponsibleMentions.join(' ') || 'لا يوجد'}\n**الرولات:** ${targetRoles.map((id) => `<@&${id}>`).join(' ') || 'لا يوجد'}`)]
  }).catch(() => {});
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

async function handleOpenWithReasonModal(interaction, guildId, panelId, reasonKey, client) {
  const { config } = getPanelData(guildId, panelId || 'default');
  const reason = config.reasons?.[reasonKey] || {};
  const modalCfg = reason.openModal && typeof reason.openModal === 'object' ? reason.openModal : null;
  if (!modalCfg?.enabled) {
    await handleOpenRequest(interaction, guildId, panelId, reasonKey);
    return;
  }

  const fields = Array.isArray(modalCfg.fields) ? modalCfg.fields.filter((f) => f?.label).slice(0, 5) : [];
  if (fields.length === 0) {
    await handleOpenRequest(interaction, guildId, panelId, reasonKey);
    return;
  }

  const nonce = `${interaction.user.id}_${Date.now()}`;
  const customId = `ticket_open_reason_modal_${guildId}_${panelId}_${reasonKey}_${nonce}`;
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle((modalCfg.title || `نموذج ${reason.name || `سبب ${reasonKey}`}`).slice(0, 45));

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    const input = new TextInputBuilder()
      .setCustomId(`f_${i}`)
      .setLabel(String(field.label).slice(0, 45))
      .setStyle((field.style || 'short') === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field.required !== false)
      .setMaxLength(400)
      .setPlaceholder(String(field.placeholder || modalCfg.description || '').slice(0, 100));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }

  if (!client.ticketOpenModalData) client.ticketOpenModalData = new Map();
  client.ticketOpenModalData.set(customId, { guildId, panelId, reasonKey, fields, createdAt: Date.now() });
  await interaction.showModal(modal);
}

function registerHandlers(client) {
  if (handlersRegistered) return;
  handlersRegistered = true;

  registerTicketInteractionRouter(async (interaction) => {
    try {
      if (client.ticketOpenModalData && client.ticketOpenModalData.size > 0) {
        const now = Date.now();
        for (const [key, value] of client.ticketOpenModalData.entries()) {
          if (!value?.createdAt || now - value.createdAt > 15 * 60 * 1000) {
            client.ticketOpenModalData.delete(key);
          }
        }
      }

      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const id = interaction.customId || '';

        if (id.startsWith('ticket_open_btn_')) {
          const parts = id.split('_');
          const guildId = parts[3];
          const panelId = parts.length >= 6 ? parts[4] : 'default';
          const reasonKey = parts.length >= 6 ? parts[5] : parts[4];
          await handleOpenWithReasonModal(interaction, guildId, panelId, reasonKey, client);
          return;
        }

        if (interaction.isStringSelectMenu() && id.startsWith('ticket_open_menu_')) {
          const raw = id.replace('ticket_open_menu_', '');
          const [guildId, panelId = 'default'] = raw.split('_');
          const value = interaction.values?.[0] || 'reason_0';
          const reasonKey = value.replace('reason_', '');
          await handleOpenWithReasonModal(interaction, guildId, panelId, reasonKey, client);
          return;
        }

        if (id.startsWith('ticket_claimreq_')) {
          const reqId = id.replace('ticket_claimreq_', '');
          await handleClaimFromRequest(interaction, reqId);
          return;
        }

        if (id.startsWith('ticket_claim_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : 'default';
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          await handleClaimInTicket(interaction, guildId, panelId, channelId);
          return;
        }

        if (id.startsWith('ticket_close_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : 'default';
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          await handleClose(interaction, guildId, panelId, channelId);
          return;
        }

        if (id.startsWith('ticket_reassign_claim_')) {
          const parts = id.split('_');
          const guildId = parts[3];
          const panelId = parts.length >= 6 ? parts[4] : 'default';
          const channelId = parts.length >= 6 ? parts[5] : parts[4];
          await handleReassignClaim(interaction, guildId, panelId, channelId);
          return;
        }

        if (id.startsWith('ticket_reassign_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : 'default';
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          await handleReassignRequest(interaction, guildId, panelId, channelId);
          return;
        }

        if (id.startsWith('ticket_delete_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : findTicketPanel(guildId, parts[3], 'default');
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          const { config, tickets, pendingRequests } = getPanelData(guildId, panelId);
          const ticket = tickets[channelId];
          if (!ticket || interaction.channelId !== channelId) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**لا توجد بيانات لهذا التكت.**', 0xED4245)], ephemeral: true });
            return;
          }
          if (ticket.status !== 'closed') {
            await interaction.reply({ embeds: [makeTicketEmbed('تنبيه', '**هذا الزر متاح بعد الإغلاق فقط.**', 0xED4245)], ephemeral: true });
            return;
          }
          if (!isAdminOnly(interaction, config, ticket?.reasonKey)) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**ليس لديك صلاحية الحذف.**', 0xED4245)], ephemeral: true });
            return;
          }
          const transcriptFile = await buildTicketTranscript(interaction.channel).catch(() => null);
          const transcriptDelivered = await sendTranscriptOutsideTicket(interaction, transcriptFile, 'Transcript before manual delete');
          delete tickets[channelId];
          setGuildData(guildId, config, tickets, pendingRequests || {}, panelId);
          await interaction.reply({
            embeds: [makeTicketEmbed('حذف', `**سيتم حذف التكت خلال 3 ثواني.**${transcriptFile ? `
**حالة الترانسكربت:** ${transcriptDelivered ? 'تم إرساله خارج التكت.' : 'تعذر إرساله خارج التكت.'}` : ''}`, 0xED4245)],
            ephemeral: true
          });
          setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
          return;
        }

        if (id.startsWith('ticket_down2_') || id.startsWith('ticket_down_') || id.startsWith('ticket_up1_') || id.startsWith('ticket_up2_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : findTicketPanel(guildId, parts[3], 'default');
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          const { config, tickets, pendingRequests } = getPanelData(guildId, panelId);
          const ticket = tickets[channelId];
          if (!ticket || interaction.channelId !== channelId) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**لا توجد بيانات لهذا التكت.**', 0xED4245)], ephemeral: true });
            return;
          }
          if (ticket.status !== 'closed') {
            await interaction.reply({ embeds: [makeTicketEmbed('تنبيه', '**أزرار النقاط متاحة بعد إغلاق التكت فقط.**', 0xED4245)], ephemeral: true });
            return;
          }
          if (!isAdminOnly(interaction, config, ticket?.reasonKey)) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**ليس لديك صلاحية النقاط.**', 0xED4245)], ephemeral: true });
            return;
          }

          const delta = id.startsWith('ticket_down2_') ? -2
            : id.startsWith('ticket_down_') ? -1
              : id.startsWith('ticket_up1_') ? 1 : 2;
          const reasonName = config.reasons?.[ticket.reasonKey]?.name;
          const respName = ticket.transferredTo || reasonName || 'ticket';
          const targetId = ticket.claimedBy;
          if (!targetId) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**لا يوجد مستلم مرتبط بهذا التكت للنقاط.**', 0xED4245)], ephemeral: true });
            return;
          }

          const points = loadPoints();
          const now = Date.now().toString();
          if (!points[respName] || typeof points[respName] !== 'object') points[respName] = {};
          const existing = points[respName][targetId];
          const total = typeof existing === 'object'
            ? Object.values(existing).reduce((s, v) => s + Number(v || 0), 0)
            : Number(existing || 0);
          const next = Math.max(0, total + delta);
          const actualDelta = next - total;
          if (typeof existing === 'object' && existing !== null) {
            points[respName][targetId][now] = actualDelta;
          } else if (existing !== undefined) {
            points[respName][targetId] = { [now]: actualDelta };
          } else {
            points[respName][targetId] = { [now]: actualDelta };
          }
          savePoints(points);

          setGuildData(guildId, config, tickets, pendingRequests || {}, panelId);
          await interaction.reply({ embeds: [makeTicketEmbed('تم', `**تم تعديل النقاط (${delta > 0 ? '+' : ''}${delta}) للمستلم.**`, 0x57F287)], ephemeral: true });
          return;
        }

        if (id.startsWith('ticket_toggle_member_') || id.startsWith('ticket_toggle_claimer_')) {
          const parts = id.split('_');
          const guildId = parts[3];
          const channelId = parts[4];
          const panelId = findTicketPanel(guildId, channelId, 'default');
          const { config, tickets, pendingRequests } = getPanelData(guildId, panelId);
          const ticket = tickets[channelId];
          if (!ticket || interaction.channelId !== channelId) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**لا توجد بيانات لهذا التكت.**', 0xED4245)], ephemeral: true });
            return;
          }
          if (ticket.status !== 'closed') {
            await interaction.reply({ embeds: [makeTicketEmbed('تنبيه', '**هذه الأزرار متاحة بعد إغلاق التكت فقط.**', 0xED4245)], ephemeral: true });
            return;
          }
          if (!isAdminOnly(interaction, config, ticket?.reasonKey)) {
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

          setGuildData(guildId, config, tickets, pendingRequests || {}, panelId);
          await interaction.update({ components: buildPostCloseControls(guildId, panelId, channelId, ticket) });
          return;
        }

        if (id.startsWith('ticket_rename_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : 'default';
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          const { config, tickets } = getPanelData(guildId, panelId);
          const ticket = tickets[channelId];
          if (!ticket || !canManageTicket(interaction, ticket, config)) {
            await interaction.reply({ content: '**ليس لديك صلاحية تغيير الاسم.**', ephemeral: true });
            return;
          }
          await showInputModal(interaction, `ticket_rename_modal_${guildId}_${panelId}_${channelId}`, 'تغيير اسم التكت', 'الاسم الجديد', 'مثال : support-user');
          return;
        }

        if (id.startsWith('ticket_add_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : 'default';
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          const { config, tickets } = getPanelData(guildId, panelId);
          const ticket = tickets[channelId];
          if (!ticket || !canManageTicket(interaction, ticket, config)) {
            await interaction.reply({ content: '**ليس لديك صلاحية الاضافة.**', ephemeral: true });
            return;
          }
          await showInputModal(interaction, `ticket_add_modal_${guildId}_${panelId}_${channelId}`, 'اضافة شخص للتكت', 'ايدي او منشن الشخص');
          return;
        }

        if (id.startsWith('ticket_remove_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : 'default';
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          const { config, tickets } = getPanelData(guildId, panelId);
          const ticket = tickets[channelId];
          if (!ticket || !canManageTicket(interaction, ticket, config)) {
            await interaction.reply({ content: '**ليس لديك صلاحية الازالة.**', ephemeral: true });
            return;
          }
          await showInputModal(interaction, `ticket_remove_modal_${guildId}_${panelId}_${channelId}`, 'ازالة شخص من التكت', 'ايدي او منشن الشخص');
          return;
        }

        if (id.startsWith('ticket_ping_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : 'default';
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          const { tickets, config, pendingRequests } = getPanelData(guildId, panelId);
          const ticket = tickets[channelId];
          if (!ticket || interaction.channelId !== channelId) {
            await interaction.reply({ content: '**لا توجد بيانات لهذا التكت.**', ephemeral: true });
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply({ content: '**ليس لديك صلاحية الاستدعاء.**', ephemeral: true });
            return;
          }
          if (ticket.status !== 'open') {
            await interaction.reply({ content: '**لا يمكن الاستدعاء بعد إقفال التكت.**', ephemeral: true });
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
          setGuildData(guildId, config, tickets, pendingRequests, panelId);
          await interaction.reply({ embeds: [makeTicketEmbed('تم', `**تم استدعاء العضو :** <@${ticket.memberId}>`, 0x57F287)], ephemeral: true });
          return;
        }

        if (interaction.isStringSelectMenu() && id.startsWith('ticket_transfer_')) {
          const parts = id.split('_');
          const guildId = parts[2];
          const panelId = parts.length >= 5 ? parts[3] : 'default';
          const channelId = parts.length >= 5 ? parts[4] : parts[3];
          const selected = interaction.values?.[0] || 'resp_none';
          await handleTransferResponsibility(interaction, guildId, panelId, channelId, selected);
          return;
        }
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket_')) {
        const modalId = interaction.customId;

        if (modalId.startsWith('ticket_open_reason_modal_')) {
          const data = client.ticketOpenModalData?.get(modalId);
          if (!data) {
            await interaction.reply({ content: '**انتهت صلاحية نموذج فتح التكت، حاول مرة أخرى.**', ephemeral: true });
            return;
          }

          const answers = {};
          for (let i = 0; i < data.fields.length; i += 1) {
            const label = data.fields[i].label || `حقل ${i + 1}`;
            answers[label] = interaction.fields.getTextInputValue(`f_${i}`);
          }
          client.ticketOpenModalData.delete(modalId);
          interaction.ticketModalAnswers = answers;
          await handleOpenRequest(interaction, data.guildId, data.panelId, data.reasonKey);
          return;
        }

        if (modalId.startsWith('ticket_rename_modal_')) {
          const [, , , guildId, panelId = 'default', channelId] = modalId.split('_');
          const newName = sanitizeName(interaction.fields.getTextInputValue('value'));
          if (!newName) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**الاسم غير صالح.**', 0xED4245)], ephemeral: true });
            return;
          }
          const { config, tickets } = getPanelData(guildId, panelId);
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
          const [, , , guildId, panelId = 'default', channelId] = modalId.split('_');
          const userId = normalizeId(interaction.fields.getTextInputValue('value'));
          if (!userId) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**المدخل غير صالح.**', 0xED4245)], ephemeral: true });
            return;
          }
          const { config, tickets, pendingRequests } = getPanelData(guildId, panelId);
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
          setGuildData(guildId, config, tickets, pendingRequests, panelId);
          await interaction.reply({ embeds: [makeTicketEmbed('تم', `**تم اضافة الشخص :** <@${userId}>`, 0x57F287)], ephemeral: true });
          return;
        }

        if (modalId.startsWith('ticket_remove_modal_')) {
          const [, , , guildId, panelId = 'default', channelId] = modalId.split('_');
          const userId = normalizeId(interaction.fields.getTextInputValue('value'));
          if (!userId) {
            await interaction.reply({ embeds: [makeTicketEmbed('خطأ', '**المدخل غير صالح.**', 0xED4245)], ephemeral: true });
            return;
          }
          const { config, tickets, pendingRequests } = getPanelData(guildId, panelId);
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
          setGuildData(guildId, config, tickets, pendingRequests, panelId);
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
