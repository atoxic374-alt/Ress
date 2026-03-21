const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const interactionRouter = require('../utils/interactionRouter');
const colorManager = require('../utils/colorManager.js');

const name = 'temp';
const aliases = ['tempvoice', 'تمب'];
const DATA_PATH = path.join(__dirname, '..', 'data', 'tempVoiceSystem.json');
const DEFAULT_CREATOR_NAME = 'Create temp room ...';
const DEFAULT_DELETE_AFTER_LEAVE_MS = 5 * 60 * 1000;
const DEFAULT_AUTO_CLEAN_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 10 * 60 * 1000;
const MANAGEABLE_CONTROL_KEYS = [
  'open',
  'hide',
  'invite',
  'rename',
  'limit',
  'region',
  'allow',
  'reject',
  'music',
  'admin',
  'transfer',
  'actions'
];
const CONTROL_META = {
  open: { label: 'Open / Lock', description: 'فتح الروم أو قفله عن الدخول', buttonStyle: ButtonStyle.Secondary },
  hide: { label: 'Show / Hide', description: 'إظهار الروم أو إخفاؤه عن الأعضاء', buttonStyle: ButtonStyle.Secondary },
  invite: { label: 'Invite', description: 'إنشاء دعوة مباشرة للروم المؤقت', buttonStyle: ButtonStyle.Primary },
  rename: { label: 'Rename', description: 'تغيير اسم الروم الخاص بك', buttonStyle: ButtonStyle.Primary },
  limit: { label: 'Limit', description: 'تعديل حد الأعضاء داخل الروم', buttonStyle: ButtonStyle.Primary },
  region: { label: 'Region', description: 'تعيين ريجن الصوت أو إعادته تلقائياً', buttonStyle: ButtonStyle.Secondary },
  allow: { label: 'Allow', description: 'السماح لعضو بالدخول حتى لو كان الروم مخفي أو مقفل', buttonStyle: ButtonStyle.Success },
  reject: { label: 'Reject', description: 'إلغاء سماح/منع/فك حظر الأعضاء من الروم', buttonStyle: ButtonStyle.Danger },
  music: { label: 'Music', description: 'سحب بوت أغاني موجود في روم آخر إلى رومك إن أمكن', buttonStyle: ButtonStyle.Secondary },
  admin: { label: 'Admin', description: 'إدارة مسؤولي الروم الذين يملكون نفس تحكم المالك', buttonStyle: ButtonStyle.Secondary },
  transfer: { label: 'Transfer', description: 'نقل ملكية الروم المؤقت إلى عضو آخر', buttonStyle: ButtonStyle.Danger },
  actions: { label: 'Actions', description: 'العقوبات والتحكم المتقدم بالأعضاء من منيو واحد', buttonStyle: ButtonStyle.Secondary }
};
const ACTION_OPTIONS = [
  { label: 'Voice Mute', value: 'voice_mute', description: 'منع العضو من التحدث في الروم' },
  { label: 'Voice Unmute', value: 'voice_unmute', description: 'فك الميوت الصوتي عن العضو' },
  { label: 'Text Mute', value: 'text_mute', description: 'منع العضو من الكتابة في شات الروم' },
  { label: 'Text Unmute', value: 'text_unmute', description: 'فك الميوت الكتابي عن العضو' },
  { label: 'Kick', value: 'kick', description: 'طرد العضو من الروم الحالي' },
  { label: 'Ban', value: 'ban', description: 'حظر العضو من الروم' },
  { label: 'Unban', value: 'unban', description: 'فك الحظر عن عضو' }
];
const REGION_OPTIONS = [
  { label: 'Auto', value: 'auto', description: 'استخدام أفضل ريجن تلقائياً' },
  { label: 'Brazil', value: 'brazil', description: 'Brazil' },
  { label: 'Hong Kong', value: 'hongkong', description: 'Hong Kong' },
  { label: 'India', value: 'india', description: 'India' },
  { label: 'Japan', value: 'japan', description: 'Japan' },
  { label: 'Rotterdam', value: 'rotterdam', description: 'Rotterdam' },
  { label: 'Singapore', value: 'singapore', description: 'Singapore' },
  { label: 'South Africa', value: 'southafrica', description: 'South Africa' },
  { label: 'Sydney', value: 'sydney', description: 'Sydney' },
  { label: 'US Central', value: 'us-central', description: 'US Central' },
  { label: 'US East', value: 'us-east', description: 'US East' },
  { label: 'US South', value: 'us-south', description: 'US South' },
  { label: 'US West', value: 'us-west', description: 'US West' }
];

let dataCache = null;
let saveTimer = null;
let systemInitialized = false;
let runtimeClient = null;
let heartbeatInterval = null;
const settingsSessions = new Map();

function ensureDataFile() {
  if (fs.existsSync(DATA_PATH)) return;
  fs.writeFileSync(DATA_PATH, JSON.stringify({ guilds: {}, users: {}, rooms: {} }, null, 2));
}

function loadData() {
  if (dataCache) return dataCache;
  ensureDataFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    dataCache = {
      guilds: parsed.guilds && typeof parsed.guilds === 'object' ? parsed.guilds : {},
      users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
      rooms: parsed.rooms && typeof parsed.rooms === 'object' ? parsed.rooms : {}
    };
  } catch (error) {
    console.error('[temp] Failed to load data:', error);
    dataCache = { guilds: {}, users: {}, rooms: {} };
  }
  return dataCache;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DATA_PATH, JSON.stringify(loadData(), null, 2));
    } catch (error) {
      console.error('[temp] Failed to save data:', error);
    }
  }, 750);
}

function getGuildConfig(guildId) {
  const data = loadData();
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      categoryId: null,
      creatorChannelId: null,
      creatorChannelName: DEFAULT_CREATOR_NAME,
      controlChannelId: null,
      autoCleanEnabled: false,
      autoCleanIntervalMs: DEFAULT_AUTO_CLEAN_MS,
      maxRoomAgeMs: 0,
      deleteAfterLeaveMs: DEFAULT_DELETE_AFTER_LEAVE_MS,
      enabledControls: Object.fromEntries(MANAGEABLE_CONTROL_KEYS.map(key => [key, true]))
    };
    scheduleSave();
  } else if (!data.guilds[guildId].enabledControls) {
    data.guilds[guildId].enabledControls = Object.fromEntries(MANAGEABLE_CONTROL_KEYS.map(key => [key, true]));
    scheduleSave();
  }
  return data.guilds[guildId];
}

function getUserProfile(guildId, userId) {
  const data = loadData();
  const key = `${guildId}:${userId}`;
  if (!data.users[key]) {
    data.users[key] = {
      roomNameTemplate: null,
      allowedUsers: [],
      bannedUsers: [],
      managers: [],
      locked: false,
      hidden: false,
      userLimit: 0,
      rtcRegion: null,
      lastKnownRoomName: null,
      voiceMutedUsers: [],
      textMutedUsers: []
    };
    scheduleSave();
  }
  return data.users[key];
}

function getRoomStore(guildId) {
  const data = loadData();
  if (!data.rooms[guildId]) {
    data.rooms[guildId] = {};
    scheduleSave();
  }
  return data.rooms[guildId];
}

function getRoomRecord(guildId, ownerId) {
  return getRoomStore(guildId)[ownerId] || null;
}

function setRoomRecord(guildId, ownerId, record) {
  getRoomStore(guildId)[ownerId] = record;
  scheduleSave();
}

function deleteRoomRecord(guildId, ownerId) {
  const store = getRoomStore(guildId);
  delete store[ownerId];
  scheduleSave();
}

function sanitizeRoomName(value, fallback = 'Temp Room') {
  const cleaned = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 95);
  return cleaned || fallback;
}

function parseFlexibleDuration(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw || ['off', 'none', 'بدون', 'none.', '0'].includes(raw)) return 0;
  const compact = raw.replace(/\s+/g, '');
  const pattern = /(\d+)(ms|s|m|h|d|ث|ثا|ثانية|ثواني|د|دق|دقيقة|دقائق|س|ساعة|ساعات|ي|يوم|ايام)/g;
  let total = 0;
  let match;
  while ((match = pattern.exec(compact)) !== null) {
    const amount = Number(match[1]);
    const unit = match[2];
    if (!amount || amount < 0) continue;
    if (['ms'].includes(unit)) total += amount;
    else if (['s', 'ث', 'ثا', 'ثانية', 'ثواني'].includes(unit)) total += amount * 1000;
    else if (['m', 'د', 'دق', 'دقيقة', 'دقائق'].includes(unit)) total += amount * 60 * 1000;
    else if (['h', 'س', 'ساعة', 'ساعات'].includes(unit)) total += amount * 60 * 60 * 1000;
    else if (['d', 'ي', 'يوم', 'ايام'].includes(unit)) total += amount * 24 * 60 * 60 * 1000;
  }
  if (total > 0) return total;
  if (/^\d+$/.test(compact)) return Number(compact) * 60 * 1000;
  return null;
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '**بدون مدة**';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`**${days}** يوم`);
  if (hours) parts.push(`**${hours}** ساعة`);
  if (minutes) parts.push(`**${minutes}** دقيقة`);
  if (seconds && parts.length < 2) parts.push(`**${seconds}** ثانية`);
  return parts.join(' و ');
}

function boolText(value) {
  return value ? '✅ **مفعّل**' : '❌ **متوقف**';
}

function isGuildAdmin(member, BOT_OWNERS = []) {
  return Boolean(
    member && (
      member.id === member.guild.ownerId ||
      BOT_OWNERS.includes(member.id) ||
      member.permissions.has(PermissionsBitField.Flags.Administrator)
    )
  );
}

function canManageRoom(member, roomRecord, profile) {
  if (!member || !roomRecord || !profile) return false;
  return member.id === roomRecord.ownerId || profile.managers.includes(member.id) || member.guild.ownerId === member.id || member.permissions.has(PermissionsBitField.Flags.Administrator);
}

function canManageAdminPanel(member, roomRecord) {
  if (!member || !roomRecord) return false;
  return member.id === roomRecord.ownerId || member.guild.ownerId === member.id || member.permissions.has(PermissionsBitField.Flags.Administrator);
}

function getControlStateText(config) {
  return MANAGEABLE_CONTROL_KEYS.map(key => `${config.enabledControls[key] ? '✅' : '❌'} **${CONTROL_META[key].label}** — ${CONTROL_META[key].description}`).join('\n');
}

function createSettingsEmbed(guild, actorId) {
  const config = getGuildConfig(guild.id);
  const category = config.categoryId ? guild.channels.cache.get(config.categoryId) : null;
  const creatorChannel = config.creatorChannelId ? guild.channels.cache.get(config.creatorChannelId) : null;
  const controlChannel = config.controlChannelId ? guild.channels.cache.get(config.controlChannelId) : null;

  return colorManager.createEmbed()
    .setTitle('**Temp Voice Settings**')
    .setDescription([
      '**لوحة إعدادات الرومات الصوتية المؤقتة.**',
      '**كل تفاعل يحدث نفس الرسالة مباشرة وبشكل حي.**',
      '',
      `**Category:** ${category ? `<#${category.id}>` : '**غير محددة**'}`,
      `**Create Room Channel:** ${creatorChannel ? `<#${creatorChannel.id}>` : `**${sanitizeRoomName(config.creatorChannelName, DEFAULT_CREATOR_NAME)}**`}`,
      `**Creator Name:** **${sanitizeRoomName(config.creatorChannelName, DEFAULT_CREATOR_NAME)}**`,
      `**Control Room:** ${controlChannel ? `<#${controlChannel.id}>` : '**سيتم الإرسال داخل روم الصوت نفسه**'}`,
      `**Auto Clean:** ${boolText(config.autoCleanEnabled)} — ${formatDuration(config.autoCleanIntervalMs)}`,
      `**Room Lifetime:** ${formatDuration(config.maxRoomAgeMs)}`,
      `**Delete After Owner Leaves:** ${formatDuration(config.deleteAfterLeaveMs)}`,
      '',
      '**الأزرار والتحكمات الحالية:**',
      getControlStateText(config)
    ].join('\n'))
    .setFooter({ text: `Temp Settings • ${actorId}` })
    .setTimestamp();
}

function buildSettingsRows(userId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`temp_settings_category:${userId}`).setLabel('Category').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`temp_settings_name:${userId}`).setLabel('Creator Name').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`temp_settings_control:${userId}`).setLabel('Control Room').setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`temp_settings_autoclean:${userId}`).setLabel('Auto Clean').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`temp_settings_lifetime:${userId}`).setLabel('Lifetime').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`temp_settings_leave:${userId}`).setLabel('Leave Delete').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`temp_settings_controls:${userId}`).setLabel('Controls').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`temp_settings_refresh:${userId}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`temp_settings_close:${userId}`).setLabel('Close').setStyle(ButtonStyle.Danger)
    )
  ];
}

function getSettingsSession(userId) {
  const existing = settingsSessions.get(userId);
  if (existing && Date.now() - existing.createdAt <= SESSION_TTL_MS) {
    return existing;
  }
  const session = { createdAt: Date.now(), tempControls: null, panelChannelId: null, panelMessageId: null };
  settingsSessions.set(userId, session);
  return session;
}

async function ensureCreatorChannel(guild) {
  const config = getGuildConfig(guild.id);
  if (!config.categoryId) return null;
  const category = guild.channels.cache.get(config.categoryId) || await guild.channels.fetch(config.categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) return null;

  let creatorChannel = config.creatorChannelId ? guild.channels.cache.get(config.creatorChannelId) : null;
  if (!creatorChannel) {
    creatorChannel = await guild.channels.create({
      name: sanitizeRoomName(config.creatorChannelName, DEFAULT_CREATOR_NAME),
      type: ChannelType.GuildVoice,
      parent: category.id,
      reason: 'Temp voice creator channel'
    });
    config.creatorChannelId = creatorChannel.id;
    scheduleSave();
  }

  const desiredName = sanitizeRoomName(config.creatorChannelName, DEFAULT_CREATOR_NAME);
  if (creatorChannel.name !== desiredName) {
    await creatorChannel.setName(desiredName).catch(() => {});
  }
  if (creatorChannel.parentId !== category.id) {
    await creatorChannel.setParent(category.id).catch(() => {});
  }

  const siblings = guild.channels.cache
    .filter(ch => ch.parentId === category.id)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map(ch => ch.id);
  const creatorIndex = siblings.indexOf(creatorChannel.id);
  if (creatorIndex > 0) {
    await creatorChannel.setPosition(0).catch(() => {});
  }

  return creatorChannel;
}

async function updateSettingsMessage(message, actorId) {
  if (!message) return;
  await message.edit({
    embeds: [createSettingsEmbed(message.guild, actorId)],
    components: buildSettingsRows(actorId)
  }).catch(() => {});
}

async function buildPanelCard(guild, roomChannel, roomRecord, ownerProfile) {
  const width = 1600;
  const height = 920;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#0b1220');
  gradient.addColorStop(0.45, colorManager.getColor() || '#4f46e5');
  gradient.addColorStop(1, '#111827');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  roundRect(ctx, 45, 40, width - 90, height - 80, 36, true);

  const iconUrl = guild.iconURL({ extension: 'png', size: 256 });
  if (iconUrl) {
    try {
      const icon = await loadImage(iconUrl);
      ctx.save();
      ctx.beginPath();
      ctx.arc(140, 130, 60, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(icon, 80, 70, 120, 120);
      ctx.restore();
    } catch (error) {
      console.error('[temp] Failed to load guild icon for panel card:', error.message);
    }
  }

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 56px Sans';
  ctx.fillText('Temporary Voice Control', 240, 120);
  ctx.font = '32px Sans';
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  ctx.fillText('تحكم كامل بالروم المؤقت — سريع، واضح، ومحفوظ تلقائياً', 240, 175);

  const statusLines = [
    `Owner: ${roomRecord.ownerDisplayName || 'Unknown'}`,
    `Room: ${roomChannel.name}`,
    `Mode: ${ownerProfile.locked ? 'Locked' : 'Open'} / ${ownerProfile.hidden ? 'Hidden' : 'Visible'}`,
    `Limit: ${roomChannel.userLimit || 0}`,
    `Managers: ${ownerProfile.managers.length}`,
    `Allowed: ${ownerProfile.allowedUsers.length}`
  ];

  ctx.font = '28px Sans';
  statusLines.forEach((line, index) => {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(line, 88, 260 + index * 44);
  });

  const enabledControls = MANAGEABLE_CONTROL_KEYS.filter(key => getGuildConfig(guild.id).enabledControls[key]);
  const cellWidth = 470;
  const cellHeight = 95;
  const startX = 86;
  const startY = 520;
  const gapX = 30;
  const gapY = 24;

  enabledControls.forEach((key, index) => {
    const row = Math.floor(index / 3);
    const col = index % 3;
    const x = startX + col * (cellWidth + gapX);
    const y = startY + row * (cellHeight + gapY);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, x, y, cellWidth, cellHeight, 26, true);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    roundRect(ctx, x + 225, y + 10, 230, cellHeight - 20, 24, true);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 34px Sans';
    ctx.fillText(CONTROL_META[key].label, x + 255, y + 58);
    ctx.font = '28px Sans';
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    drawWrappedText(ctx, CONTROL_META[key].description, x + 24, y + 38, 190, 30);
  });

  return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: `temp-panel-${roomChannel.id}.png` });
}

function roundRect(ctx, x, y, width, height, radius, fill = false, stroke = false) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = String(text || '').split(' ');
  let line = '';
  let currentY = y;
  for (const word of words) {
    const test = `${line}${word} `;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line.trim(), x, currentY);
      line = `${word} `;
      currentY += lineHeight;
    } else {
      line = test;
    }
  }
  if (line.trim()) ctx.fillText(line.trim(), x, currentY);
}

function buildControlRows(guildId, ownerId) {
  const config = getGuildConfig(guildId);
  const enabled = key => config.enabledControls[key] !== false;
  const rows = [];

  const row1 = [];
  if (enabled('open')) row1.push(new ButtonBuilder().setCustomId(`temp_room_open:${ownerId}`).setLabel('Open / Lock').setStyle(CONTROL_META.open.buttonStyle));
  if (enabled('hide')) row1.push(new ButtonBuilder().setCustomId(`temp_room_hide:${ownerId}`).setLabel('Show / Hide').setStyle(CONTROL_META.hide.buttonStyle));
  if (enabled('invite')) row1.push(new ButtonBuilder().setCustomId(`temp_room_invite:${ownerId}`).setLabel('Invite').setStyle(CONTROL_META.invite.buttonStyle));
  if (enabled('rename')) row1.push(new ButtonBuilder().setCustomId(`temp_room_rename:${ownerId}`).setLabel('Rename').setStyle(CONTROL_META.rename.buttonStyle));
  if (enabled('limit')) row1.push(new ButtonBuilder().setCustomId(`temp_room_limit:${ownerId}`).setLabel('Limit').setStyle(CONTROL_META.limit.buttonStyle));
  if (row1.length) rows.push(new ActionRowBuilder().addComponents(row1.slice(0, 5)));

  const row2 = [];
  if (enabled('region')) row2.push(new ButtonBuilder().setCustomId(`temp_room_region:${ownerId}`).setLabel('Region').setStyle(CONTROL_META.region.buttonStyle));
  if (enabled('allow')) row2.push(new ButtonBuilder().setCustomId(`temp_room_allow:${ownerId}`).setLabel('Allow').setStyle(CONTROL_META.allow.buttonStyle));
  if (enabled('reject')) row2.push(new ButtonBuilder().setCustomId(`temp_room_reject:${ownerId}`).setLabel('Reject').setStyle(CONTROL_META.reject.buttonStyle));
  if (enabled('music')) row2.push(new ButtonBuilder().setCustomId(`temp_room_music:${ownerId}`).setLabel('Music').setStyle(CONTROL_META.music.buttonStyle));
  if (enabled('admin')) row2.push(new ButtonBuilder().setCustomId(`temp_room_admin:${ownerId}`).setLabel('Admin').setStyle(CONTROL_META.admin.buttonStyle));
  if (row2.length) rows.push(new ActionRowBuilder().addComponents(row2.slice(0, 5)));

  const row3 = [];
  if (enabled('transfer')) row3.push(new ButtonBuilder().setCustomId(`temp_room_transfer:${ownerId}`).setLabel('Transfer').setStyle(CONTROL_META.transfer.buttonStyle));
  if (row3.length) {
    rows.push(new ActionRowBuilder().addComponents(row3));
  }
  if (enabled('actions')) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`temp_room_actions:${ownerId}`)
        .setPlaceholder('اختر الإجراء السريع على الأعضاء')
        .addOptions(ACTION_OPTIONS)
        .setMinValues(1)
        .setMaxValues(1)
    ));
  }

  return rows;
}

async function sendOrUpdateControlPanel(guild, roomChannel, roomRecord) {
  const profile = getUserProfile(guild.id, roomRecord.ownerId);
  const attachment = await buildPanelCard(guild, roomChannel, roomRecord, profile);
  const targetChannel = getGuildConfig(guild.id).controlChannelId
    ? await guild.channels.fetch(getGuildConfig(guild.id).controlChannelId).catch(() => null)
    : roomChannel;
  const destination = targetChannel && targetChannel.isTextBased() ? targetChannel : roomChannel;
  if (!destination || !destination.isTextBased()) return;

  const embed = colorManager.createEmbed()
    .setTitle('**Private Temp Room Panel**')
    .setDescription([
      `**الروم:** <#${roomChannel.id}>`,
      `**المالك:** <@${roomRecord.ownerId}>`,
      `**المسؤولون:** ${profile.managers.length ? profile.managers.map(id => `<@${id}>`).join('، ') : '**لا يوجد**'}`,
      `**المسموحون:** ${profile.allowedUsers.length ? profile.allowedUsers.map(id => `<@${id}>`).join('، ') : '**لا يوجد**'}`,
      `**المحظورون:** ${profile.bannedUsers.length ? profile.bannedUsers.map(id => `<@${id}>`).join('، ') : '**لا يوجد**'}`
    ].join('\n'))
    .setImage(`attachment://${attachment.name}`)
    .setFooter({ text: `Owner ${roomRecord.ownerId}` });

  let panelMessage = null;
  if (roomRecord.panelMessageId) {
    panelMessage = await destination.messages.fetch(roomRecord.panelMessageId).catch(() => null);
  }

  if (panelMessage) {
    await panelMessage.edit({ embeds: [embed], files: [attachment], components: buildControlRows(guild.id, roomRecord.ownerId) }).catch(() => {});
  } else {
    const sent = await destination.send({ content: `<@${roomRecord.ownerId}>`, embeds: [embed], files: [attachment], components: buildControlRows(guild.id, roomRecord.ownerId) }).catch(() => null);
    if (sent) {
      roomRecord.panelChannelId = destination.id;
      roomRecord.panelMessageId = sent.id;
      setRoomRecord(guild.id, roomRecord.ownerId, roomRecord);
    }
  }
}

async function applyRoomState(roomChannel, ownerId) {
  const profile = getUserProfile(roomChannel.guild.id, ownerId);
  const baseOverwrites = [
    {
      id: roomChannel.guild.roles.everyone.id,
      allow: [
        profile.hidden ? null : PermissionsBitField.Flags.ViewChannel,
        profile.locked ? null : PermissionsBitField.Flags.Connect
      ].filter(Boolean),
      deny: [
        profile.hidden ? PermissionsBitField.Flags.ViewChannel : null,
        profile.locked ? PermissionsBitField.Flags.Connect : null
      ].filter(Boolean)
    },
    {
      id: ownerId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak,
        PermissionsBitField.Flags.Stream,
        PermissionsBitField.Flags.UseVAD,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
        PermissionsBitField.Flags.EmbedLinks,
        PermissionsBitField.Flags.UseApplicationCommands
      ]
    }
  ];

  for (const userId of profile.allowedUsers) {
    baseOverwrites.push({
      id: userId,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory]
    });
  }
  for (const userId of profile.managers) {
    baseOverwrites.push({
      id: userId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.MoveMembers,
        PermissionsBitField.Flags.MuteMembers,
        PermissionsBitField.Flags.DeafenMembers
      ]
    });
  }
  for (const userId of profile.bannedUsers) {
    baseOverwrites.push({
      id: userId,
      deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect]
    });
  }
  for (const userId of profile.voiceMutedUsers || []) {
    baseOverwrites.push({
      id: userId,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect],
      deny: [PermissionsBitField.Flags.Speak]
    });
  }
  for (const userId of profile.textMutedUsers || []) {
    baseOverwrites.push({
      id: userId,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect],
      deny: [PermissionsBitField.Flags.SendMessages]
    });
  }

  await roomChannel.permissionOverwrites.set(baseOverwrites, 'Sync temp voice room state').catch(() => {});
  await roomChannel.edit({ userLimit: profile.userLimit || 0, rtcRegion: profile.rtcRegion || null }).catch(() => {});
}

async function createOrMoveToTempRoom(member) {
  const guild = member.guild;
  const config = getGuildConfig(guild.id);
  if (!config.categoryId || !config.creatorChannelId) return null;

  const creatorChannel = guild.channels.cache.get(config.creatorChannelId) || await guild.channels.fetch(config.creatorChannelId).catch(() => null);
  if (!creatorChannel) return null;

  const profile = getUserProfile(guild.id, member.id);
  let roomRecord = getRoomRecord(guild.id, member.id);
  let roomChannel = roomRecord?.channelId ? guild.channels.cache.get(roomRecord.channelId) || await guild.channels.fetch(roomRecord.channelId).catch(() => null) : null;

  if (!roomChannel) {
    const desiredName = sanitizeRoomName(profile.roomNameTemplate || member.displayName || `${member.user.username} room`, `${member.displayName || member.user.username} room`);
    roomChannel = await guild.channels.create({
      name: desiredName,
      type: ChannelType.GuildVoice,
      parent: config.categoryId,
      userLimit: profile.userLimit || 0,
      rtcRegion: profile.rtcRegion || null,
      reason: `Temp voice room for ${member.user.tag}`
    });

    roomRecord = {
      ownerId: member.id,
      ownerDisplayName: member.displayName,
      channelId: roomChannel.id,
      createdAt: Date.now(),
      ownerLeftAt: null,
      panelChannelId: null,
      panelMessageId: null
    };
    setRoomRecord(guild.id, member.id, roomRecord);
  } else {
    roomRecord.ownerDisplayName = member.displayName;
    roomRecord.ownerLeftAt = null;
    setRoomRecord(guild.id, member.id, roomRecord);
  }

  profile.lastKnownRoomName = roomChannel.name;
  scheduleSave();
  await applyRoomState(roomChannel, member.id);
  await member.voice.setChannel(roomChannel).catch(() => null);
  await roomChannel.setPosition(1).catch(() => {});
  await sendOrUpdateControlPanel(guild, roomChannel, roomRecord);
  return roomChannel;
}

async function deleteTempRoom(guild, ownerId, reason = 'Temp room cleanup') {
  const roomRecord = getRoomRecord(guild.id, ownerId);
  if (!roomRecord) return false;
  const channel = roomRecord.channelId ? guild.channels.cache.get(roomRecord.channelId) || await guild.channels.fetch(roomRecord.channelId).catch(() => null) : null;
  if (channel) {
    await channel.delete(reason).catch(() => {});
  }
  deleteRoomRecord(guild.id, ownerId);
  return true;
}

async function refreshRoomPanelByOwner(guild, ownerId) {
  const roomRecord = getRoomRecord(guild.id, ownerId);
  if (!roomRecord) return;
  const roomChannel = guild.channels.cache.get(roomRecord.channelId) || await guild.channels.fetch(roomRecord.channelId).catch(() => null);
  if (!roomChannel) {
    deleteRoomRecord(guild.id, ownerId);
    return;
  }
  await sendOrUpdateControlPanel(guild, roomChannel, roomRecord);
}

async function heartbeat() {
  if (!runtimeClient) return;
  const data = loadData();
  for (const guildId of Object.keys(data.rooms)) {
    const guild = runtimeClient.guilds.cache.get(guildId) || await runtimeClient.guilds.fetch(guildId).catch(() => null);
    if (!guild) continue;
    const config = getGuildConfig(guildId);
    for (const [ownerId, roomRecord] of Object.entries(data.rooms[guildId])) {
      const channel = guild.channels.cache.get(roomRecord.channelId) || await guild.channels.fetch(roomRecord.channelId).catch(() => null);
      if (!channel) {
        deleteRoomRecord(guildId, ownerId);
        continue;
      }
      const profile = getUserProfile(guildId, ownerId);
      const ownerPresent = channel.members.has(ownerId);
      if (ownerPresent && roomRecord.ownerLeftAt) {
        roomRecord.ownerLeftAt = null;
        setRoomRecord(guildId, ownerId, roomRecord);
      }
      if (!ownerPresent && !roomRecord.ownerLeftAt) {
        roomRecord.ownerLeftAt = Date.now();
        setRoomRecord(guildId, ownerId, roomRecord);
      }
      if (config.maxRoomAgeMs > 0 && Date.now() - roomRecord.createdAt >= config.maxRoomAgeMs) {
        await deleteTempRoom(guild, ownerId, 'Temp room max lifetime reached');
        continue;
      }
      if (!ownerPresent && config.deleteAfterLeaveMs >= 0 && roomRecord.ownerLeftAt && Date.now() - roomRecord.ownerLeftAt >= config.deleteAfterLeaveMs) {
        await deleteTempRoom(guild, ownerId, 'Temp room owner left timeout');
        continue;
      }
      if (config.autoCleanEnabled && config.autoCleanIntervalMs > 0 && channel.isTextBased()) {
        const lastAutoCleanAt = roomRecord.lastAutoCleanAt || 0;
        if (Date.now() - lastAutoCleanAt >= config.autoCleanIntervalMs) {
          roomRecord.lastAutoCleanAt = Date.now();
          setRoomRecord(guildId, ownerId, roomRecord);
          const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
          if (messages && messages.size) {
            await Promise.all(messages.filter(msg => !msg.pinned).map(msg => msg.delete().catch(() => null)));
          }
        }
      }
    }
    await ensureCreatorChannel(guild).catch(() => null);
  }
}

async function handleVoiceStateUpdate(oldState, newState) {
  if (!newState.member || newState.member.user.bot) return;
  const guild = newState.guild;
  const config = getGuildConfig(guild.id);

  if (newState.channelId && newState.channelId === config.creatorChannelId) {
    await createOrMoveToTempRoom(newState.member);
  }

  const relevantOwners = new Set(Object.keys(getRoomStore(guild.id)));
  if (!relevantOwners.size) return;
  for (const ownerId of relevantOwners) {
    const roomRecord = getRoomRecord(guild.id, ownerId);
    if (!roomRecord) continue;
    if (oldState.channelId === roomRecord.channelId || newState.channelId === roomRecord.channelId) {
      const channel = guild.channels.cache.get(roomRecord.channelId) || await guild.channels.fetch(roomRecord.channelId).catch(() => null);
      if (!channel) {
        deleteRoomRecord(guild.id, ownerId);
        continue;
      }
      if (channel.members.has(ownerId)) {
        roomRecord.ownerLeftAt = null;
      } else if (!roomRecord.ownerLeftAt) {
        roomRecord.ownerLeftAt = Date.now();
      }
      roomRecord.ownerDisplayName = guild.members.cache.get(ownerId)?.displayName || roomRecord.ownerDisplayName;
      setRoomRecord(guild.id, ownerId, roomRecord);
      await refreshRoomPanelByOwner(guild, ownerId);
    }
  }
}

async function execute(message, args, { BOT_OWNERS = [] }) {
  if (!isGuildAdmin(message.member, BOT_OWNERS)) {
    await message.react('❌').catch(() => {});
    return;
  }

  await ensureCreatorChannel(message.guild).catch(() => null);
  const sent = await message.reply({
    embeds: [createSettingsEmbed(message.guild, message.author.id)],
    components: buildSettingsRows(message.author.id)
  });
  const session = getSettingsSession(message.author.id);
  session.panelChannelId = sent.channel.id;
  session.panelMessageId = sent.id;
  await updateSettingsMessage(sent, message.author.id);
}

function parseCustomId(customId) {
  const [action, value] = String(customId || '').split(':');
  return { action, value };
}


async function updateSettingsPanelForUser(guild, userId) {
  const session = getSettingsSession(userId);
  if (!session.panelChannelId || !session.panelMessageId) return;
  const channel = guild.channels.cache.get(session.panelChannelId) || await guild.channels.fetch(session.panelChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  const message = await channel.messages.fetch(session.panelMessageId).catch(() => null);
  if (!message) return;
  await updateSettingsMessage(message, userId);
}

async function ensureAuthorizedSettingsInteraction(interaction, userId) {
  if (interaction.user.id !== userId) {
    await interaction.reply({ content: '❌ هذه اللوحة ليست لك.', ephemeral: true }).catch(() => {});
    return false;
  }
  return true;
}

async function ensureRoomAccess(interaction, ownerId) {
  const roomRecord = getRoomRecord(interaction.guild.id, ownerId);
  if (!roomRecord) {
    await interaction.reply({ content: '❌ الروم المؤقت غير موجود حالياً.', ephemeral: true }).catch(() => {});
    return null;
  }
  const profile = getUserProfile(interaction.guild.id, ownerId);
  if (!canManageRoom(interaction.member, roomRecord, profile)) {
    await interaction.reply({ content: '❌ لا تملك صلاحية التحكم بهذا الروم.', ephemeral: true }).catch(() => {});
    return null;
  }
  const roomChannel = interaction.guild.channels.cache.get(roomRecord.channelId) || await interaction.guild.channels.fetch(roomRecord.channelId).catch(() => null);
  if (!roomChannel) {
    deleteRoomRecord(interaction.guild.id, ownerId);
    await interaction.reply({ content: '❌ الروم لم يعد موجوداً.', ephemeral: true }).catch(() => {});
    return null;
  }
  return { roomRecord, profile, roomChannel };
}

async function handleSettingsButton(interaction) {
  const { action, value } = parseCustomId(interaction.customId);
  const userId = value;
  if (!(await ensureAuthorizedSettingsInteraction(interaction, userId))) return true;

  if (action === 'temp_settings_refresh') {
    await interaction.update({ embeds: [createSettingsEmbed(interaction.guild, userId)], components: buildSettingsRows(userId) }).catch(() => {});
    return true;
  }

  if (action === 'temp_settings_close') {
    await interaction.update({ content: '✅ تم إغلاق لوحة temp.', embeds: [], components: [] }).catch(() => {});
    return true;
  }

  if (action === 'temp_settings_category') {
    await interaction.reply({
      content: '**اختر الكاتوقري التي سيتم داخلها إنشاء روم Create temp room ... كروم أول.**',
      components: [new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`temp_settings_category_select:${userId}`)
          .setPlaceholder('اختر كاتوقري')
          .setChannelTypes(ChannelType.GuildCategory)
          .setMinValues(1)
          .setMaxValues(1)
      )],
      ephemeral: true
    }).catch(() => {});
    return true;
  }

  if (action === 'temp_settings_control') {
    await interaction.reply({
      content: '**اختر روم التحكم النصي الذي ستُرسل له لوحة إدارة الرومات المؤقتة.**',
      components: [new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`temp_settings_control_select:${userId}`)
          .setPlaceholder('اختر روم تحكم نصي')
          .setChannelTypes(ChannelType.GuildText)
          .setMinValues(1)
          .setMaxValues(1)
      )],
      ephemeral: true
    }).catch(() => {});
    return true;
  }

  if (['temp_settings_name', 'temp_settings_autoclean', 'temp_settings_lifetime', 'temp_settings_leave'].includes(action)) {
    const modal = new ModalBuilder().setCustomId(`${action}_modal:${userId}`).setTitle('Temp Voice Settings');
    if (action === 'temp_settings_name') {
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel('Creator Channel Name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(90)
          .setValue(getGuildConfig(interaction.guild.id).creatorChannelName || DEFAULT_CREATOR_NAME)
      ));
    }
    if (action === 'temp_settings_autoclean') {
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('enabled')
            .setLabel('Enable? yes / no')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(getGuildConfig(interaction.guild.id).autoCleanEnabled ? 'yes' : 'no')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('duration')
            .setLabel('Interval مثال: 10m أو 30s')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue('10m')
        )
      );
    }
    if (action === 'temp_settings_lifetime') {
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('duration')
          .setLabel('Max room lifetime مثال: 12h أو off')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(getGuildConfig(interaction.guild.id).maxRoomAgeMs ? `${Math.round(getGuildConfig(interaction.guild.id).maxRoomAgeMs / 3600000)}h` : 'off')
      ));
    }
    if (action === 'temp_settings_leave') {
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('duration')
          .setLabel('Delete after owner leaves مثال: 5m')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(`${Math.round(getGuildConfig(interaction.guild.id).deleteAfterLeaveMs / 60000)}m`)
      ));
    }
    await interaction.showModal(modal).catch(() => {});
    return true;
  }

  if (action === 'temp_settings_controls') {
    const config = getGuildConfig(interaction.guild.id);
    const session = getSettingsSession(userId);
    session.tempControls = { ...config.enabledControls };
    const select = new StringSelectMenuBuilder()
      .setCustomId(`temp_settings_controls_select:${userId}`)
      .setPlaceholder('اختر الأزرار المفعلة')
      .addOptions(MANAGEABLE_CONTROL_KEYS.map(key => ({
        label: CONTROL_META[key].label,
        description: CONTROL_META[key].description.slice(0, 90),
        value: key,
        default: config.enabledControls[key] !== false
      })))
      .setMinValues(0)
      .setMaxValues(MANAGEABLE_CONTROL_KEYS.length);

    await interaction.reply({
      content: '**فعّل أو عطّل أزرار التحكم، ثم احفظ أو ألغِ.**',
      components: [
        new ActionRowBuilder().addComponents(select),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`temp_settings_controls_save:${userId}`).setLabel('Save').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`temp_settings_controls_reset:${userId}`).setLabel('Reset').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`temp_settings_controls_cancel:${userId}`).setLabel('Cancel').setStyle(ButtonStyle.Danger)
        )
      ],
      ephemeral: true
    }).catch(() => {});
    return true;
  }

  if (action === 'temp_settings_controls_save' || action === 'temp_settings_controls_reset' || action === 'temp_settings_controls_cancel') {
    const session = getSettingsSession(userId);
    if (action === 'temp_settings_controls_reset') {
      session.tempControls = Object.fromEntries(MANAGEABLE_CONTROL_KEYS.map(key => [key, true]));
      await interaction.update({ content: '✅ تم تجهيز كل الأزرار للتفعيل. اضغط Save للحفظ.', components: interaction.message.components }).catch(() => {});
      return true;
    }
    if (action === 'temp_settings_controls_cancel') {
      session.tempControls = null;
      await interaction.update({ content: '❌ تم إلغاء تعديل أزرار التحكم.', components: [] }).catch(() => {});
      return true;
    }
    if (session.tempControls) {
      getGuildConfig(interaction.guild.id).enabledControls = { ...session.tempControls };
      scheduleSave();
      session.tempControls = null;
      await interaction.update({ content: '✅ تم حفظ إعدادات الأزرار.', components: [] }).catch(() => {});
      await updateSettingsPanelForUser(interaction.guild, userId).catch(() => {});
      return true;
    }
  }

  return true;
}

async function handleSettingsSelect(interaction) {
  const { action, value } = parseCustomId(interaction.customId);
  const userId = value;
  if (!(await ensureAuthorizedSettingsInteraction(interaction, userId))) return true;
  const config = getGuildConfig(interaction.guild.id);

  if (action === 'temp_settings_category_select') {
    config.categoryId = interaction.values[0];
    scheduleSave();
    const creator = await ensureCreatorChannel(interaction.guild);
    await interaction.update({ content: `✅ تم تعيين الكاتوقري وإنشاء روم البداية ${creator ? `<#${creator.id}>` : ''}.`, components: [] }).catch(() => {});
    await updateSettingsPanelForUser(interaction.guild, userId).catch(() => {});
    return true;
  }

  if (action === 'temp_settings_control_select') {
    config.controlChannelId = interaction.values[0];
    scheduleSave();
    await interaction.update({ content: `✅ تم تعيين روم التحكم إلى <#${interaction.values[0]}>.`, components: [] }).catch(() => {});
    await updateSettingsPanelForUser(interaction.guild, userId).catch(() => {});
    return true;
  }

  if (action === 'temp_settings_controls_select') {
    const session = getSettingsSession(userId);
    session.tempControls = Object.fromEntries(MANAGEABLE_CONTROL_KEYS.map(key => [key, interaction.values.includes(key)]));
    await interaction.update({ content: `✅ تم تحديث المعاينة. الأزرار المختارة: **${interaction.values.length}**`, components: interaction.message.components }).catch(() => {});
    return true;
  }

  return true;
}

async function handleSettingsModal(interaction) {
  const { action, value } = parseCustomId(interaction.customId);
  const userId = value;
  const config = getGuildConfig(interaction.guild.id);
  if (!(await ensureAuthorizedSettingsInteraction(interaction, userId))) return true;

  if (action === 'temp_settings_name_modal') {
    config.creatorChannelName = sanitizeRoomName(interaction.fields.getTextInputValue('value'), DEFAULT_CREATOR_NAME);
    scheduleSave();
    await ensureCreatorChannel(interaction.guild);
    await interaction.reply({ content: `✅ تم تحديث اسم روم الإنشاء إلى **${config.creatorChannelName}**`, ephemeral: true }).catch(() => {});
    await updateSettingsPanelForUser(interaction.guild, userId).catch(() => {});
    return true;
  }

  if (action === 'temp_settings_autoclean_modal') {
    const enabledRaw = interaction.fields.getTextInputValue('enabled').trim().toLowerCase();
    const duration = parseFlexibleDuration(interaction.fields.getTextInputValue('duration'));
    if (duration === null) {
      await interaction.reply({ content: '❌ المدة غير صحيحة.', ephemeral: true }).catch(() => {});
      return true;
    }
    config.autoCleanEnabled = ['yes', 'on', 'true', '1', 'y', 'نعم'].includes(enabledRaw);
    config.autoCleanIntervalMs = Math.max(15000, duration || DEFAULT_AUTO_CLEAN_MS);
    scheduleSave();
    await interaction.reply({ content: `✅ تم ${config.autoCleanEnabled ? 'تفعيل' : 'تعطيل'} التنظيف التلقائي كل ${formatDuration(config.autoCleanIntervalMs)}.`, ephemeral: true }).catch(() => {});
    await updateSettingsPanelForUser(interaction.guild, userId).catch(() => {});
    return true;
  }

  if (action === 'temp_settings_lifetime_modal') {
    const duration = parseFlexibleDuration(interaction.fields.getTextInputValue('duration'));
    if (duration === null) {
      await interaction.reply({ content: '❌ مدة العمر غير صحيحة.', ephemeral: true }).catch(() => {});
      return true;
    }
    config.maxRoomAgeMs = duration;
    scheduleSave();
    await interaction.reply({ content: `✅ تم تحديث الحد الأقصى لعمر الروم إلى ${formatDuration(duration)}.`, ephemeral: true }).catch(() => {});
    await updateSettingsPanelForUser(interaction.guild, userId).catch(() => {});
    return true;
  }

  if (action === 'temp_settings_leave_modal') {
    const duration = parseFlexibleDuration(interaction.fields.getTextInputValue('duration'));
    if (duration === null) {
      await interaction.reply({ content: '❌ مدة الحذف بعد الخروج غير صحيحة.', ephemeral: true }).catch(() => {});
      return true;
    }
    config.deleteAfterLeaveMs = Math.max(0, duration);
    scheduleSave();
    await interaction.reply({ content: `✅ سيتم حذف الروم بعد خروج المالك بـ ${formatDuration(config.deleteAfterLeaveMs)}.`, ephemeral: true }).catch(() => {});
    await updateSettingsPanelForUser(interaction.guild, userId).catch(() => {});
    return true;
  }

  return true;
}

async function handleRoomButton(interaction) {
  const { action, value } = parseCustomId(interaction.customId);
  const ownerId = value;
  const access = await ensureRoomAccess(interaction, ownerId);
  if (!access) return true;
  const { roomRecord, profile, roomChannel } = access;

  if (action === 'temp_room_open') {
    profile.locked = !profile.locked;
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
    await refreshRoomPanelByOwner(interaction.guild, ownerId);
    await interaction.reply({ content: `✅ تم ${profile.locked ? 'قفل' : 'فتح'} الروم.`, ephemeral: true }).catch(() => {});
    return true;
  }

  if (action === 'temp_room_hide') {
    profile.hidden = !profile.hidden;
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
    await refreshRoomPanelByOwner(interaction.guild, ownerId);
    await interaction.reply({ content: `✅ تم ${profile.hidden ? 'إخفاء' : 'إظهار'} الروم.`, ephemeral: true }).catch(() => {});
    return true;
  }

  if (action === 'temp_room_invite') {
    const invite = await roomChannel.createInvite({ maxAge: 3600, maxUses: 0, unique: true, reason: 'Temp room private invite' }).catch(() => null);
    await interaction.reply({ content: invite ? `✅ رابط الدعوة: ${invite.url}` : '❌ تعذر إنشاء الدعوة.', ephemeral: true }).catch(() => {});
    return true;
  }

  if (action === 'temp_room_rename' || action === 'temp_room_limit') {
    const modal = new ModalBuilder().setCustomId(`${action}_modal:${ownerId}`).setTitle('Temp Room Control');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('value')
        .setLabel(action === 'temp_room_rename' ? 'New Room Name' : 'User Limit (0-99)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(action === 'temp_room_rename' ? roomChannel.name : String(roomChannel.userLimit || 0))
    ));
    await interaction.showModal(modal).catch(() => {});
    return true;
  }

  if (action === 'temp_room_region') {
    await interaction.reply({
      content: '**اختر الريجن المناسب للروم.**',
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`temp_room_region_select:${ownerId}`)
          .setPlaceholder('اختر الريجن')
          .addOptions(REGION_OPTIONS)
          .setMinValues(1)
          .setMaxValues(1)
      )],
      ephemeral: true
    }).catch(() => {});
    return true;
  }

  if (action === 'temp_room_allow') {
    await interaction.reply({
      content: '**اختر العضو الذي تريد السماح له بالدخول والرؤية.**',
      components: [new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`temp_room_allow_select:${ownerId}`)
          .setPlaceholder('اختر عضواً واحداً أو أكثر')
          .setMinValues(1)
          .setMaxValues(10)
      )],
      ephemeral: true
    }).catch(() => {});
    return true;
  }

  if (action === 'temp_room_reject') {
    const options = [];
    for (const id of profile.allowedUsers) options.push({ label: `Allow • ${id}`, value: `allow:${id}`, description: 'إزالة السماح من العضو' });
    for (const id of profile.bannedUsers) options.push({ label: `Ban • ${id}`, value: `ban:${id}`, description: 'فك الحظر عن العضو' });
    for (const id of profile.managers) options.push({ label: `Admin • ${id}`, value: `admin:${id}`, description: 'إزالة صلاحية المسؤول من العضو' });
    if (!options.length) {
      await interaction.reply({ content: 'ℹ️ لا توجد عناصر محفوظة لإزالتها حالياً.', ephemeral: true }).catch(() => {});
      return true;
    }
    await interaction.reply({
      content: '**اختر العناصر التي تريد حذفها من السماح أو الحظر أو المسؤولين.**',
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`temp_room_reject_select:${ownerId}`)
          .setPlaceholder('اختر العناصر المراد إزالتها')
          .addOptions(options.slice(0, 25))
          .setMinValues(1)
          .setMaxValues(Math.min(options.length, 25))
      )],
      ephemeral: true
    }).catch(() => {});
    return true;
  }

  if (action === 'temp_room_music') {
    const musicBot = interaction.guild.members.cache.find(member => member.user.bot && member.voice?.channelId && member.voice.channelId !== roomChannel.id && /music|song|player|luna|hydra|probot/i.test(member.user.username));
    if (!musicBot) {
      await interaction.reply({ content: 'ℹ️ لم يتم العثور على بوت أغاني جاهز للنقل حالياً.', ephemeral: true }).catch(() => {});
      return true;
    }
    await musicBot.voice.setChannel(roomChannel).catch(() => null);
    await interaction.reply({ content: `✅ تمت محاولة سحب بوت الأغاني **${musicBot.user.username}** إلى رومك.`, ephemeral: true }).catch(() => {});
    return true;
  }

  if (action === 'temp_room_admin') {
    const canManageAdmins = canManageAdminPanel(interaction.member, roomRecord);
    const managersText = profile.managers.length ? profile.managers.map(id => `<@${id}>`).join('، ') : '**لا يوجد مسؤولون**';
    await interaction.reply({
      embeds: [colorManager.createEmbed().setTitle('**Room Managers**').setDescription(`**المسؤولون الحاليون:**\n${managersText}`)],
      components: canManageAdmins ? [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`temp_room_admin_add:${ownerId}`).setLabel('Add').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`temp_room_admin_remove:${ownerId}`).setLabel('Remove').setStyle(ButtonStyle.Danger)
        )
      ] : [],
      ephemeral: true
    }).catch(() => {});
    return true;
  }

  if (action === 'temp_room_admin_add' || action === 'temp_room_admin_remove' || action === 'temp_room_transfer') {
    if (!canManageAdminPanel(interaction.member, roomRecord)) {
      await interaction.reply({ content: '❌ فقط مالك الروم أو إداري السيرفر يقدر يعدل قائمة المسؤولين أو ينقل الملكية.', ephemeral: true }).catch(() => {});
      return true;
    }
    await interaction.reply({
      content: action === 'temp_room_transfer' ? '**اختر العضو الذي تريد نقل الملكية إليه.**' : `**اختر العضو ${action === 'temp_room_admin_add' ? 'لإضافته' : 'لإزالته'} من قائمة المسؤولين.**`,
      components: [new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`${action}_select:${ownerId}`)
          .setPlaceholder('اختر الأعضاء')
          .setMinValues(1)
          .setMaxValues(action === 'temp_room_transfer' ? 1 : 10)
      )],
      ephemeral: true
    }).catch(() => {});
    return true;
  }

  return true;
}

async function handleRoomSelect(interaction) {
  const { action, value } = parseCustomId(interaction.customId);
  const ownerId = value;
  const access = await ensureRoomAccess(interaction, ownerId);
  if (!access) return true;
  const { roomRecord, profile, roomChannel } = access;

  if (action === 'temp_room_region_select') {
    const region = interaction.values[0];
    profile.rtcRegion = region === 'auto' ? null : region;
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
    await refreshRoomPanelByOwner(interaction.guild, ownerId);
    await interaction.update({ content: `✅ تم تحديث الريجن إلى **${region}**.`, components: [] }).catch(() => {});
    return true;
  }

  if (action === 'temp_room_allow_select') {
    for (const userId of interaction.values) {
      if (!profile.allowedUsers.includes(userId)) profile.allowedUsers.push(userId);
      profile.bannedUsers = profile.bannedUsers.filter(id => id !== userId);
    }
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
    await refreshRoomPanelByOwner(interaction.guild, ownerId);
    await interaction.update({ content: `✅ تم حفظ السماح لـ ${interaction.values.map(id => `<@${id}>`).join('، ')}.`, components: [] }).catch(() => {});
    return true;
  }

  if (action === 'temp_room_reject_select') {
    for (const entry of interaction.values) {
      const [type, userId] = entry.split(':');
      if (type === 'allow') profile.allowedUsers = profile.allowedUsers.filter(id => id !== userId);
      if (type === 'ban') profile.bannedUsers = profile.bannedUsers.filter(id => id !== userId);
      if (type === 'admin') profile.managers = profile.managers.filter(id => id !== userId);
    }
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
    await refreshRoomPanelByOwner(interaction.guild, ownerId);
    await interaction.update({ content: '✅ تم حذف العناصر المحددة.', components: [] }).catch(() => {});
    return true;
  }

  if (action === 'temp_room_actions') {
    const selected = interaction.values[0];
    await interaction.reply({
      content: `**اختر العضو لتنفيذ الإجراء: ${selected}.**`,
      components: [new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`temp_room_action_target:${ownerId}:${selected}`)
          .setPlaceholder('اختر العضو المستهدف')
          .setMinValues(1)
          .setMaxValues(1)
      )],
      ephemeral: true
    }).catch(() => {});
    return true;
  }

  if (action === 'temp_room_admin_add_select' || action === 'temp_room_admin_remove_select' || action === 'temp_room_transfer_select') {
    if (!canManageAdminPanel(interaction.member, roomRecord)) {
      await interaction.update({ content: '❌ غير مسموح.', components: [] }).catch(() => {});
      return true;
    }
    if (action === 'temp_room_transfer_select') {
      const newOwnerId = interaction.values[0];
      if (newOwnerId === ownerId) {
        await interaction.update({ content: 'ℹ️ هذا العضو هو المالك الحالي أصلاً.', components: [] }).catch(() => {});
        return true;
      }
      const targetMember = await interaction.guild.members.fetch(newOwnerId).catch(() => null);
      if (!targetMember) {
        await interaction.update({ content: '❌ العضو غير موجود.', components: [] }).catch(() => {});
        return true;
      }
      const oldProfile = getUserProfile(interaction.guild.id, ownerId);
      const targetProfile = getUserProfile(interaction.guild.id, newOwnerId);
      targetProfile.allowedUsers = Array.from(new Set([...(targetProfile.allowedUsers || []), ...(oldProfile.allowedUsers || [])]));
      targetProfile.bannedUsers = Array.from(new Set([...(targetProfile.bannedUsers || []), ...(oldProfile.bannedUsers || [])]));
      targetProfile.managers = Array.from(new Set([...(oldProfile.managers || [])].filter(id => id !== newOwnerId)));
      targetProfile.hidden = oldProfile.hidden;
      targetProfile.locked = oldProfile.locked;
      targetProfile.userLimit = oldProfile.userLimit;
      targetProfile.rtcRegion = oldProfile.rtcRegion;
      targetProfile.roomNameTemplate = oldProfile.roomNameTemplate || roomChannel.name;

      deleteRoomRecord(interaction.guild.id, ownerId);
      roomRecord.ownerId = newOwnerId;
      roomRecord.ownerDisplayName = targetMember.displayName;
      roomRecord.ownerLeftAt = null;
      setRoomRecord(interaction.guild.id, newOwnerId, roomRecord);
      await applyRoomState(roomChannel, newOwnerId);
      await refreshRoomPanelByOwner(interaction.guild, newOwnerId);
      await interaction.update({ content: `✅ تم نقل ملكية الروم إلى <@${newOwnerId}>.`, components: [] }).catch(() => {});
      return true;
    }

    const adding = action === 'temp_room_admin_add_select';
    for (const userId of interaction.values) {
      if (adding) {
        if (!profile.managers.includes(userId) && userId !== ownerId) profile.managers.push(userId);
      } else {
        profile.managers = profile.managers.filter(id => id !== userId);
      }
    }
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
    await refreshRoomPanelByOwner(interaction.guild, ownerId);
    await interaction.update({ content: `✅ تم ${adding ? 'إضافة' : 'إزالة'} المسؤولين المحددين.`, components: [] }).catch(() => {});
    return true;
  }

  return true;
}

async function handleActionTargetSelect(interaction) {
  const parts = String(interaction.customId).split(':');
  const ownerId = parts[1];
  const actionType = parts[2];
  const access = await ensureRoomAccess(interaction, ownerId);
  if (!access) return true;
  const { profile, roomChannel } = access;
  const targetId = interaction.values[0];
  const member = await interaction.guild.members.fetch(targetId).catch(() => null);
  if (!member) {
    await interaction.update({ content: '❌ العضو غير موجود.', components: [] }).catch(() => {});
    return true;
  }

  if (actionType === 'voice_mute') {
    if (!profile.voiceMutedUsers.includes(targetId)) profile.voiceMutedUsers.push(targetId);
  }
  if (actionType === 'voice_unmute') {
    profile.voiceMutedUsers = profile.voiceMutedUsers.filter(id => id !== targetId);
  }
  if (actionType === 'text_mute') {
    if (!profile.textMutedUsers.includes(targetId)) profile.textMutedUsers.push(targetId);
  }
  if (actionType === 'text_unmute') {
    profile.textMutedUsers = profile.textMutedUsers.filter(id => id !== targetId);
  }
  if (actionType === 'kick') {
    if (member.voice.channelId === roomChannel.id) {
      await member.voice.disconnect('Kicked from temp room').catch(() => member.voice.setChannel(null).catch(() => null));
    }
  }
  if (actionType === 'ban') {
    if (!profile.bannedUsers.includes(targetId)) profile.bannedUsers.push(targetId);
    profile.allowedUsers = profile.allowedUsers.filter(id => id !== targetId);
    profile.voiceMutedUsers = profile.voiceMutedUsers.filter(id => id !== targetId);
    profile.textMutedUsers = profile.textMutedUsers.filter(id => id !== targetId);
    if (member.voice.channelId === roomChannel.id) {
      await member.voice.disconnect('Banned from temp room').catch(() => member.voice.setChannel(null).catch(() => null));
    }
  }
  if (actionType === 'unban') {
    profile.bannedUsers = profile.bannedUsers.filter(id => id !== targetId);
  }

  scheduleSave();
  await applyRoomState(roomChannel, ownerId);
  await refreshRoomPanelByOwner(interaction.guild, ownerId);
  await interaction.update({ content: `✅ تم تنفيذ الإجراء **${actionType}** على <@${targetId}>.`, components: [] }).catch(() => {});
  return true;
}

async function handleRoomModal(interaction) {
  const { action, value } = parseCustomId(interaction.customId);
  const ownerId = value;
  const access = await ensureRoomAccess(interaction, ownerId);
  if (!access) return true;
  const { profile, roomChannel } = access;

  if (action === 'temp_room_rename_modal') {
    const roomName = sanitizeRoomName(interaction.fields.getTextInputValue('value'), roomChannel.name);
    profile.roomNameTemplate = roomName;
    scheduleSave();
    await roomChannel.setName(roomName).catch(() => null);
    await refreshRoomPanelByOwner(interaction.guild, ownerId);
    await interaction.reply({ content: `✅ تم تغيير اسم الروم إلى **${roomName}**.`, ephemeral: true }).catch(() => {});
    return true;
  }

  if (action === 'temp_room_limit_modal') {
    const limit = Number(interaction.fields.getTextInputValue('value'));
    if (!Number.isFinite(limit) || limit < 0 || limit > 99) {
      await interaction.reply({ content: '❌ الحد يجب أن يكون بين 0 و 99.', ephemeral: true }).catch(() => {});
      return true;
    }
    profile.userLimit = limit;
    scheduleSave();
    await roomChannel.setUserLimit(limit).catch(() => null);
    await refreshRoomPanelByOwner(interaction.guild, ownerId);
    await interaction.reply({ content: `✅ تم تحديث الحد إلى **${limit}**.`, ephemeral: true }).catch(() => {});
    return true;
  }

  return true;
}

function registerInteractionHandler(client) {
  if (systemInitialized) return;
  systemInitialized = true;
  runtimeClient = client;

  interactionRouter.register('temp_settings_', async interaction => {
    if (interaction.isButton()) return handleSettingsButton(interaction);
    if (interaction.isAnySelectMenu()) return handleSettingsSelect(interaction);
    if (interaction.isModalSubmit()) return handleSettingsModal(interaction);
    return false;
  }, { name: 'temp-settings', priority: 80, types: ['button', 'anySelect', 'modal'] });

  interactionRouter.register('temp_room_', async interaction => {
    if (interaction.isButton()) return handleRoomButton(interaction);
    if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) {
      if (interaction.customId.startsWith('temp_room_action_target:')) return handleActionTargetSelect(interaction);
      return handleRoomSelect(interaction);
    }
    if (interaction.isModalSubmit()) return handleRoomModal(interaction);
    return false;
  }, { name: 'temp-room', priority: 80, types: ['button', 'stringSelect', 'userSelect', 'modal'] });

  client.on('voiceStateUpdate', handleVoiceStateUpdate);
  if (!heartbeatInterval) {
    heartbeatInterval = setInterval(() => {
      heartbeat().catch(error => console.error('[temp] heartbeat error:', error));
    }, 15000);
  }

  setTimeout(() => heartbeat().catch(() => null), 7000);
}

module.exports = {
  name,
  aliases,
  execute,
  registerInteractionHandler,
  handleVoiceStateUpdate
};
