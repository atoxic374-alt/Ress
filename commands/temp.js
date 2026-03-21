const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
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
const SESSION_TTL_MS = 12 * 60 * 1000;
const HEARTBEAT_MS = 45000;
const DATA_VERSION = 2;

const SETTING_CONTROL_KEYS = [
  'open', 'lock', 'show', 'hide', 'invite',
  'rename', 'limit', 'region', 'allow', 'reject',
  'music', 'admin', 'transfer', 'actions'
];

const CONTROL_META = {
  open: { label: 'Open', description: 'فتح الروم والسماح بالدخول' },
  lock: { label: 'Lock', description: 'قفل الروم ومنع الدخول العام' },
  show: { label: 'Show', description: 'إظهار الروم للجميع' },
  hide: { label: 'Hide', description: 'إخفاء الروم عن الجميع' },
  invite: { label: 'Invite', description: 'إنشاء دعوة مباشرة للروم' },
  rename: { label: 'Rename', description: 'تغيير اسم الروم' },
  limit: { label: 'Limit', description: 'تعديل حد أعضاء الروم' },
  region: { label: 'Region', description: 'تغيير ريجن الصوت' },
  allow: { label: 'Allow', description: 'السماح لعضو بالدخول والرؤية' },
  reject: { label: 'Reject', description: 'إزالة سماح أو حظر أو مسؤول' },
  music: { label: 'Music', description: 'سحب بوت أغاني إلى الروم إن أمكن' },
  admin: { label: 'Admin', description: 'إدارة مسؤولي الروم' },
  transfer: { label: 'Transfer', description: 'نقل ملكية الروم' },
  actions: { label: 'Actions', description: 'عقوبات وتحكم سريع بالأعضاء' }
};

const ACTION_OPTIONS = [
  { label: 'Voice Mute', value: 'voice_mute', description: 'منع العضو من التحدث' },
  { label: 'Voice Unmute', value: 'voice_unmute', description: 'فك الميوت الصوتي' },
  { label: 'Text Mute', value: 'text_mute', description: 'منع العضو من الكتابة' },
  { label: 'Text Unmute', value: 'text_unmute', description: 'فك الميوت الكتابي' },
  { label: 'Kick', value: 'kick', description: 'طرد العضو من الروم' },
  { label: 'Ban', value: 'ban', description: 'حظر العضو من الروم' },
  { label: 'Unban', value: 'unban', description: 'فك الحظر من الروم' }
];

const REGION_OPTIONS = [
  { label: 'Auto', value: 'auto', description: 'أفضل ريجن تلقائياً' },
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
let runtimeClient = null;
let heartbeatHandle = null;
let registered = false;
const sessions = new Map();
const roomLifecycleJobs = new Map();
const operationLocks = new Map();
const guildAccentCache = new Map();

function ensureDataFile() {
  if (fs.existsSync(DATA_PATH)) return;
  fs.writeFileSync(DATA_PATH, JSON.stringify({ version: DATA_VERSION, guilds: {}, users: {}, rooms: {} }, null, 2));
}

function migrateDataStructure(raw) {
  const safe = raw && typeof raw === 'object' ? raw : {};
  const migrated = {
    version: Number.isFinite(safe.version) ? safe.version : 1,
    guilds: safe.guilds && typeof safe.guilds === 'object' ? safe.guilds : {},
    users: safe.users && typeof safe.users === 'object' ? safe.users : {},
    rooms: safe.rooms && typeof safe.rooms === 'object' ? safe.rooms : {}
  };

  for (const guildConfig of Object.values(migrated.guilds)) {
    if (!guildConfig || typeof guildConfig !== 'object') continue;
    if (!guildConfig.enabledControls) guildConfig.enabledControls = defaultEnabledControls();
    if (!guildConfig.controlStatus) guildConfig.controlStatus = 'جاهز للاستخدام — ادخل رومك المؤقت ثم استخدم الأزرار هنا.';
    if (!('controlMessageId' in guildConfig)) guildConfig.controlMessageId = null;
    if (!('logChannelId' in guildConfig)) guildConfig.logChannelId = null;
  }

  for (const profile of Object.values(migrated.users)) {
    if (!profile || typeof profile !== 'object') continue;
    if (!Array.isArray(profile.allowedUsers)) profile.allowedUsers = [];
    if (!Array.isArray(profile.bannedUsers)) profile.bannedUsers = [];
    if (!Array.isArray(profile.managers)) profile.managers = [];
    if (!Array.isArray(profile.voiceMutedUsers)) profile.voiceMutedUsers = [];
    if (!Array.isArray(profile.textMutedUsers)) profile.textMutedUsers = [];
    if (!Array.isArray(profile.managerHistory)) profile.managerHistory = [];
    if (!Array.isArray(profile.allowHistory)) profile.allowHistory = [];
    if (!Array.isArray(profile.moderationHistory)) profile.moderationHistory = [];
    if (!Array.isArray(profile.ownershipHistory)) profile.ownershipHistory = [];
    if (!('lastKnownDisplayName' in profile)) profile.lastKnownDisplayName = null;
    if (!('lastUsedAt' in profile)) profile.lastUsedAt = 0;
  }

  migrated.version = DATA_VERSION;
  return migrated;
}

function loadData() {
  if (dataCache) return dataCache;
  ensureDataFile();
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    dataCache = migrateDataStructure(raw);
  } catch (error) {
    console.error('[temp] Failed to load data:', error);
    dataCache = { version: DATA_VERSION, guilds: {}, users: {}, rooms: {} };
  }
  return dataCache;
}

function writeFileAtomic(targetPath, content) {
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, targetPath);
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeFileAtomic(DATA_PATH, JSON.stringify(loadData(), null, 2));
    } catch (error) {
      console.error('[temp] Failed to save data:', error);
    }
  }, 500);
}

async function runSerialized(key, fn) {
  const previous = operationLocks.get(key) || Promise.resolve();
  const current = previous.then(fn, fn);
  const tracked = current.catch(() => null);
  operationLocks.set(key, tracked);
  try {
    return await current;
  } finally {
    if (operationLocks.get(key) === tracked) operationLocks.delete(key);
  }
}

function defaultEnabledControls() {
  return Object.fromEntries(SETTING_CONTROL_KEYS.map(key => [key, true]));
}

function getGuildConfig(guildId) {
  const data = loadData();
  if (!data.guilds[guildId]) {
    data.guilds[guildId] = {
      categoryId: null,
      creatorChannelId: null,
      creatorChannelName: DEFAULT_CREATOR_NAME,
      controlChannelId: null,
      controlMessageId: null,
      logChannelId: null,
      controlStatus: 'جاهز للاستخدام — ادخل رومك المؤقت ثم استخدم الأزرار هنا.',
      autoCleanEnabled: false,
      autoCleanIntervalMs: DEFAULT_AUTO_CLEAN_MS,
      maxRoomAgeMs: 0,
      deleteAfterLeaveMs: DEFAULT_DELETE_AFTER_LEAVE_MS,
      enabledControls: defaultEnabledControls()
    };
    scheduleSave();
  }

  if (!data.guilds[guildId].enabledControls) {
    data.guilds[guildId].enabledControls = defaultEnabledControls();
    scheduleSave();
  }

  if (typeof data.guilds[guildId].controlStatus !== 'string') {
    data.guilds[guildId].controlStatus = 'جاهز للاستخدام — ادخل رومك المؤقت ثم استخدم الأزرار هنا.';
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
      lastKnownDisplayName: null,
      lastUsedAt: 0,
      voiceMutedUsers: [],
      textMutedUsers: [],
      managerHistory: [],
      allowHistory: [],
      moderationHistory: [],
      ownershipHistory: []
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

function setRoomRecord(guildId, ownerId, value) {
  getRoomStore(guildId)[ownerId] = value;
  scheduleSave();
}

function deleteRoomRecord(guildId, ownerId) {
  delete getRoomStore(guildId)[ownerId];
  scheduleSave();
}

function getSession(userId) {
  const existing = sessions.get(userId);
  if (existing && Date.now() - existing.createdAt < SESSION_TTL_MS) return existing;
  const session = {
    createdAt: Date.now(),
    settingsMessageId: null,
    settingsChannelId: null,
    tempControls: null,
    lastResolvedOwnerId: null
  };
  sessions.set(userId, session);
  return session;
}

function sanitizeRoomName(value, fallback = 'Temp Room') {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 96);
  return cleaned || fallback;
}

function parseFlexibleDuration(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw || ['off', 'none', 'بدون', '0'].includes(raw)) return 0;
  const compact = raw.replace(/\s+/g, '');
  const pattern = /(\d+)(ms|s|m|h|d|ث|ثا|ثانية|ثواني|د|دق|دقيقة|دقائق|س|ساعة|ساعات|ي|يوم|ايام)/g;
  let total = 0;
  let match;
  while ((match = pattern.exec(compact)) !== null) {
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount) || amount < 0) continue;
    if (unit === 'ms') total += amount;
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
  if (seconds && parts.length < 3) parts.push(`**${seconds}** ثانية`);
  return parts.join(' و ');
}

function boolText(value) {
  return value ? '✅ **مفعّل**' : '❌ **متوقف**';
}

function parseCustomId(customId) {
  const [action, ...rest] = String(customId || '').split(':');
  return { action, args: rest };
}

function getDisplayNameFromGuild(guild, userId) {
  const member = guild?.members?.cache?.get?.(userId) || null;
  return member?.displayName || member?.user?.globalName || member?.user?.username || `User ${userId}`;
}

function pushLimitedHistory(list, entry, limit = 12) {
  const finalList = Array.isArray(list) ? list : [];
  finalList.unshift(entry);
  if (finalList.length > limit) finalList.length = limit;
  return finalList;
}


function formatDiscordTimestamp(value) {
  if (!value) return '**غير متوفر**';
  const unix = Math.floor(Number(value) / 1000);
  return Number.isFinite(unix) ? `<t:${unix}:F>
<t:${unix}:R>` : '**غير متوفر**';
}

function formatRoomLogValue(value, fallback = '**غير متوفر**') {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value);
  return text.length > 1024 ? `${text.slice(0, 1021)}...` : text;
}

async function resolveLogChannel(guild) {
  const config = getGuildConfig(guild.id);
  if (!config.logChannelId) return null;
  const channel = guild.channels.cache.get(config.logChannelId) || await guild.channels.fetch(config.logChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) return null;
  return channel;
}

async function sendTempLog(guild, payload) {
  const channel = await resolveLogChannel(guild);
  if (!channel) return false;

  const iconUrl = guild.iconURL({ extension: 'png', size: 256 }) || undefined;
  const embed = colorManager.createEmbed()
    .setTitle(payload.title || '**Temp Voice Log**')
    .setDescription(payload.description || '**تم تسجيل حدث جديد في نظام الرومات المؤقتة.**')
    .setAuthor({ name: `${guild.name} • Temp Voice Logs`, iconURL: iconUrl })
    .setThumbnail(iconUrl)
    .setFooter({ text: `Guild ID: ${guild.id}` })
    .setTimestamp(payload.timestamp ? new Date(payload.timestamp) : new Date());

  const fields = Array.isArray(payload.fields) ? payload.fields.filter(Boolean).slice(0, 25) : [];
  if (fields.length) {
    embed.addFields(fields.map(field => ({
      name: formatRoomLogValue(field.name, '**بدون عنوان**').slice(0, 256),
      value: formatRoomLogValue(field.value),
      inline: Boolean(field.inline)
    })));
  }

  await channel.send({ embeds: [embed] }).catch(() => null);
  return true;
}

async function logTempRoomState(guild, details) {
  const roomRecord = details.roomRecord || null;
  const ownerId = details.ownerId || roomRecord?.ownerId || null;
  const ownerName = ownerId ? getDisplayNameFromGuild(guild, ownerId) : '**غير معروف**';
  const roomId = details.roomId || roomRecord?.channelId || null;
  const roomMention = roomId ? `<#${roomId}>` : '**غير متوفر**';

  return sendTempLog(guild, {
    title: details.title,
    description: details.description,
    timestamp: details.timestamp,
    fields: [
      { name: '**المنفذ**', value: details.actorId ? `<@${details.actorId}>` : '**النظام**', inline: true },
      { name: '**المالك**', value: ownerId ? `<@${ownerId}>
${ownerName}` : '**غير متوفر**', inline: true },
      { name: '**الروم**', value: roomMention, inline: true },
      details.roomName ? { name: '**اسم الروم**', value: formatRoomLogValue(details.roomName), inline: true } : null,
      details.reason ? { name: '**السبب**', value: formatRoomLogValue(details.reason), inline: true } : null,
      details.extra ? { name: '**تفاصيل إضافية**', value: formatRoomLogValue(details.extra), inline: false } : null,
      roomRecord?.createdAt ? { name: '**وقت الإنشاء**', value: formatDiscordTimestamp(roomRecord.createdAt), inline: false } : null,
      details.ownerLeftAt ? { name: '**وقت خروج المالك**', value: formatDiscordTimestamp(details.ownerLeftAt), inline: false } : null
    ]
  });
}

async function getGuildAccent(guild) {
  if (!guild) return colorManager.getColor() || '#5865F2';
  const cached = guildAccentCache.get(guild.id);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.color;
  const fallback = colorManager.getColor() || '#5865F2';
  const iconUrl = guild.iconURL({ extension: 'png', size: 128 });
  if (!iconUrl) return fallback;
  try {
    const image = await loadImage(iconUrl);
    const sample = createCanvas(32, 32);
    const sampleCtx = sample.getContext('2d');
    sampleCtx.drawImage(image, 0, 0, 32, 32);
    const pixels = sampleCtx.getImageData(0, 0, 32, 32).data;
    let r = 0, g = 0, b = 0, count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3];
      if (alpha < 120) continue;
      r += pixels[i];
      g += pixels[i + 1];
      b += pixels[i + 2];
      count++;
    }
    const color = count
      ? `#${[r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v / count))).toString(16).padStart(2, '0')).join('')}`
      : fallback;
    guildAccentCache.set(guild.id, { color, at: Date.now() });
    return color;
  } catch {
    return fallback;
  }
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

function canManageAdminPanel(member, roomRecord) {
  return Boolean(
    member && roomRecord && (
      member.id === roomRecord.ownerId ||
      member.id === member.guild.ownerId ||
      member.permissions.has(PermissionsBitField.Flags.Administrator)
    )
  );
}

function canManageRoom(member, roomRecord, profile) {
  return Boolean(
    member && roomRecord && profile && (
      member.id === roomRecord.ownerId ||
      profile.managers.includes(member.id) ||
      member.id === member.guild.ownerId ||
      member.permissions.has(PermissionsBitField.Flags.Administrator)
    )
  );
}

function settingStateText(config) {
  return SETTING_CONTROL_KEYS
    .map(key => `${config.enabledControls[key] ? '✅' : '❌'} **${CONTROL_META[key].label}** — ${CONTROL_META[key].description}`)
    .join('\n');
}

function createSettingsEmbed(guild, actorId) {
  const config = getGuildConfig(guild.id);
  const category = config.categoryId ? guild.channels.cache.get(config.categoryId) : null;
  const creator = config.creatorChannelId ? guild.channels.cache.get(config.creatorChannelId) : null;
  const controlRoom = config.controlChannelId ? guild.channels.cache.get(config.controlChannelId) : null;
  const logRoom = config.logChannelId ? guild.channels.cache.get(config.logChannelId) : null;

  return colorManager.createEmbed()
    .setTitle('**Temp Voice Settings**')
    .setDescription([
      '**إعدادات نظام الرومات الصوتية المؤقتة.**',
      '**لوحة واحدة تتحدث بعد كل تعديل.**',
      '',
      `**Category:** ${category ? `<#${category.id}>` : '**غير محددة**'}`,
      `**Creator Room:** ${creator ? `<#${creator.id}>` : '**سيتم إنشاؤه عند اختيار الكاتوقري**'}`,
      `**Creator Name:** **${sanitizeRoomName(config.creatorChannelName, DEFAULT_CREATOR_NAME)}**`,
      `**Control Room:** ${controlRoom ? `<#${controlRoom.id}>` : '**غير محدد**'}`,
      `**General Control Message:** ${config.controlMessageId ? `**جاهزة**` : '**غير منشأة**'}`,
      `**Log Room:** ${logRoom ? `<#${logRoom.id}>` : '**غير محدد**'}`,
      `**Auto Clean:** ${boolText(config.autoCleanEnabled)} — ${formatDuration(config.autoCleanIntervalMs)}`,
      `**Room Lifetime:** ${formatDuration(config.maxRoomAgeMs)}`,
      `**Delete After Owner Leaves:** ${formatDuration(config.deleteAfterLeaveMs)}`,
      '',
      '**الأزرار المفعلة في لوحة التحكم العامة:**',
      settingStateText(config)
    ].join('\n'))
    .setFooter({ text: `Temp Settings • ${actorId}` })
    .setTimestamp();
}

function buildSettingsRows(userId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`temp_settings_category:${userId}`).setLabel('Category').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`temp_settings_name:${userId}`).setLabel('Creator Name').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`temp_settings_control:${userId}`).setLabel('Control Room').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`temp_settings_log:${userId}`).setLabel('Log Room').setStyle(ButtonStyle.Primary)
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

async function updateSettingsPanelMessage(guild, userId) {
  const session = getSession(userId);
  if (!session.settingsChannelId || !session.settingsMessageId) return;
  const channel = guild.channels.cache.get(session.settingsChannelId) || await guild.channels.fetch(session.settingsChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  const message = await channel.messages.fetch(session.settingsMessageId).catch(() => null);
  if (!message) return;
  await message.edit({ embeds: [createSettingsEmbed(guild, userId)], components: buildSettingsRows(userId) }).catch(() => {});
}

async function ensureCreatorChannel(guild) {
  const config = getGuildConfig(guild.id);
  if (!config.categoryId) return null;
  const category = guild.channels.cache.get(config.categoryId) || await guild.channels.fetch(config.categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) return null;

  let creator = config.creatorChannelId ? guild.channels.cache.get(config.creatorChannelId) || await guild.channels.fetch(config.creatorChannelId).catch(() => null) : null;

  if (!creator) {
    creator = await guild.channels.create({
      name: sanitizeRoomName(config.creatorChannelName, DEFAULT_CREATOR_NAME),
      type: ChannelType.GuildVoice,
      parent: category.id,
      reason: 'Temp voice creator channel'
    });
    config.creatorChannelId = creator.id;
    scheduleSave();
  }

  const desiredName = sanitizeRoomName(config.creatorChannelName, DEFAULT_CREATOR_NAME);
  if (creator.name !== desiredName) await creator.setName(desiredName).catch(() => {});
  if (creator.parentId !== category.id) await creator.setParent(category.id).catch(() => {});

  const siblings = guild.channels.cache
    .filter(channel => channel.parentId === category.id)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map(channel => channel.id);
  if (siblings.indexOf(creator.id) > 0) {
    await creator.setPosition(0).catch(() => {});
  }

  return creator;
}

function clampText(ctx, text, maxWidth) {
  let value = String(text || '');
  if (ctx.measureText(value).width <= maxWidth) return value;
  while (value.length > 1 && ctx.measureText(`${value}...`).width > maxWidth) {
    value = value.slice(0, -1);
  }
  return `${value}...`;
}

function drawRoundedRect(ctx, x, y, w, h, r, fillStyle, shadow = null, strokeStyle = null) {
  ctx.save();
  if (shadow) {
    ctx.shadowColor = shadow.color;
    ctx.shadowBlur = shadow.blur;
    ctx.shadowOffsetX = shadow.x;
    ctx.shadowOffsetY = shadow.y;
  }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
  if (strokeStyle) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = strokeStyle;
    ctx.stroke();
  }
  ctx.restore();
}

function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 2) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines - 1) break;
    } else {
      line = next;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (words.length && lines.length === maxLines) {
    lines[maxLines - 1] = clampText(ctx, lines[maxLines - 1], maxWidth);
  }
  lines.forEach((entry, index) => ctx.fillText(entry, x, y + index * lineHeight));
}


async function buildGeneralControlCard(guild, statusText) {
  const width = 1600;
  const height = 980;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const accent = await getGuildAccent(guild);

  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, '#050814');
  background.addColorStop(0.35, '#0d172a');
  background.addColorStop(0.72, accent);
  background.addColorStop(1, '#070b14');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  drawRoundedRect(ctx, 36, 36, width - 72, height - 72, 42, 'rgba(7,12,24,0.58)', { color: 'rgba(0,0,0,0.50)', blur: 48, x: 0, y: 18 }, 'rgba(255,255,255,0.08)');
  drawRoundedRect(ctx, 58, 58, width - 116, 236, 34, 'rgba(255,255,255,0.06)', { color: 'rgba(255,255,255,0.08)', blur: 14, x: 0, y: -6 }, 'rgba(255,255,255,0.12)');
  drawRoundedRect(ctx, 76, 310, width - 152, height - 410, 30, 'rgba(255,255,255,0.035)', { color: 'rgba(0,0,0,0.25)', blur: 22, x: 0, y: 12 }, 'rgba(255,255,255,0.08)');

  const iconUrl = guild.iconURL({ extension: 'png', size: 256 });
  if (iconUrl) {
    try {
      const icon = await loadImage(iconUrl);
      ctx.save();
      ctx.beginPath();
      ctx.arc(160, 175, 74, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(icon, 86, 101, 148, 148);
      ctx.restore();
      ctx.beginPath();
      ctx.arc(160, 175, 74, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 4;
      ctx.stroke();
    } catch (error) {
      console.error('[temp] canvas icon load failed:', error.message);
    }
  }

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 62px Sans';
  ctx.textAlign = 'left';
  ctx.fillText('General Temp Voice Control', 270, 145);

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = 'bold 30px Sans';
  ctx.fillText('لوحة تحكم عامة وثابتة للرومات المؤقتة', 1430, 150);
  ctx.font = '26px Sans';
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  ctx.fillText('استخدم الأزرار من هذه الرسالة فقط — بلا رسائل كنترول إضافية', 1430, 195);
  ctx.fillText('ادخل رومك المؤقت أولاً أو كن مسؤولاً فيه لتظهر العمليات بشكل صحيح', 1430, 232);

  drawRoundedRect(ctx, 270, 220, 1110, 48, 18, 'rgba(255,255,255,0.09)');
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.font = 'bold 23px Sans';
  ctx.fillText(clampText(ctx, `آخر حالة: ${statusText}`, 1040), 1340, 251);

  const enabledKeys = SETTING_CONTROL_KEYS.filter(key => getGuildConfig(guild.id).enabledControls[key]);
  const cols = 3;
  const boxWidth = 418;
  const boxHeight = 116;
  const gapX = 32;
  const gapY = 28;
  const totalWidth = cols * boxWidth + (cols - 1) * gapX;
  const startX = Math.round((width - totalWidth) / 2);
  const startY = 350;

  enabledKeys.forEach((key, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const x = startX + col * (boxWidth + gapX);
    const y = startY + row * (boxHeight + gapY);

    drawRoundedRect(ctx, x, y, boxWidth, boxHeight, 28, 'rgba(255,255,255,0.085)', { color: 'rgba(0,0,0,0.38)', blur: 26, x: 0, y: 16 }, 'rgba(255,255,255,0.1)');
    drawRoundedRect(ctx, x + 212, y + 12, 188, boxHeight - 24, 22, 'rgba(255,255,255,0.13)', { color: 'rgba(255,255,255,0.10)', blur: 10, x: 0, y: -2 }, 'rgba(255,255,255,0.14)');

    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px Sans';
    ctx.fillText(clampText(ctx, CONTROL_META[key].label, 155), x + 306, y + 68);

    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.93)';
    ctx.font = '27px Sans';
    drawWrappedText(ctx, CONTROL_META[key].description, x + 180, y + 48, 160, 31, 2);
  });

  drawRoundedRect(ctx, 110, height - 106, width - 220, 54, 22, 'rgba(255,255,255,0.065)', { color: 'rgba(0,0,0,0.18)', blur: 12, x: 0, y: 6 });
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '24px Sans';
  ctx.fillText('ألوان ديناميكية من أيقونة السيرفر • ظلال أقوى • RTL مضبوط • نفس الرسالة تتحدث مع كل تفاعل', width / 2, height - 72);

  return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: `temp-general-control-${guild.id}.png` });
}

function buildGeneralControlRows(guildId) {
  const config = getGuildConfig(guildId);
  const enabled = key => config.enabledControls[key] !== false;
  const rows = [];

  const row1 = [];
  if (enabled('open')) row1.push(new ButtonBuilder().setCustomId('temp_room_open').setLabel('Open').setStyle(ButtonStyle.Success));
  if (enabled('lock')) row1.push(new ButtonBuilder().setCustomId('temp_room_lock').setLabel('Lock').setStyle(ButtonStyle.Danger));
  if (enabled('show')) row1.push(new ButtonBuilder().setCustomId('temp_room_show').setLabel('Show').setStyle(ButtonStyle.Primary));
  if (enabled('hide')) row1.push(new ButtonBuilder().setCustomId('temp_room_hide').setLabel('Hide').setStyle(ButtonStyle.Secondary));
  if (enabled('invite')) row1.push(new ButtonBuilder().setCustomId('temp_room_invite').setLabel('Invite').setStyle(ButtonStyle.Primary));
  if (row1.length) rows.push(new ActionRowBuilder().addComponents(row1));

  const row2 = [];
  if (enabled('rename')) row2.push(new ButtonBuilder().setCustomId('temp_room_rename').setLabel('Rename').setStyle(ButtonStyle.Primary));
  if (enabled('limit')) row2.push(new ButtonBuilder().setCustomId('temp_room_limit').setLabel('Limit').setStyle(ButtonStyle.Primary));
  if (enabled('region')) row2.push(new ButtonBuilder().setCustomId('temp_room_region').setLabel('Region').setStyle(ButtonStyle.Secondary));
  if (enabled('allow')) row2.push(new ButtonBuilder().setCustomId('temp_room_allow').setLabel('Allow').setStyle(ButtonStyle.Success));
  if (enabled('reject')) row2.push(new ButtonBuilder().setCustomId('temp_room_reject').setLabel('Reject').setStyle(ButtonStyle.Danger));
  if (row2.length) rows.push(new ActionRowBuilder().addComponents(row2));

  const row3 = [];
  if (enabled('music')) row3.push(new ButtonBuilder().setCustomId('temp_room_music').setLabel('Music').setStyle(ButtonStyle.Secondary));
  if (enabled('admin')) row3.push(new ButtonBuilder().setCustomId('temp_room_admin').setLabel('Admin').setStyle(ButtonStyle.Secondary));
  if (enabled('transfer')) row3.push(new ButtonBuilder().setCustomId('temp_room_transfer').setLabel('Transfer').setStyle(ButtonStyle.Danger));
  if (row3.length) rows.push(new ActionRowBuilder().addComponents(row3));

  if (enabled('actions')) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('temp_room_actions')
        .setPlaceholder('اختر الإجراء السريع على الأعضاء')
        .addOptions(ACTION_OPTIONS)
        .setMinValues(1)
        .setMaxValues(1)
    ));
  }

  return rows;
}

function createGeneralControlMessageContent(guild) {
  const config = getGuildConfig(guild.id);
  return [
    '**Temp Voice General Control**',
    '**لوحة عامة وثابتة لكل الرومات المؤقتة.**',
    '**لا يوجد هنا عرض لروم معيّن أو تفاصيل مالك معيّن.**',
    '**ادخل رومك المؤقت أو كن مسؤولًا فيه ثم استخدم الأزرار.**',
    '',
    `**الحالة الأخيرة:** ${config.controlStatus || 'جاهز للاستخدام'}`
  ].join('\n');
}

async function ensureGuildControlPanel(guild, statusText = null) {
  const config = getGuildConfig(guild.id);
  if (statusText) config.controlStatus = statusText;
  if (!config.controlChannelId) {
    scheduleSave();
    return null;
  }

  const channel = guild.channels.cache.get(config.controlChannelId) || await guild.channels.fetch(config.controlChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    config.controlMessageId = null;
    scheduleSave();
    return null;
  }

  const attachment = await buildGeneralControlCard(guild, config.controlStatus || 'جاهز للاستخدام');
  const content = createGeneralControlMessageContent(guild);
  const components = buildGeneralControlRows(guild.id);

  let message = null;
  if (config.controlMessageId) {
    message = await channel.messages.fetch(config.controlMessageId).catch(() => null);
  }

  if (message) {
    await message.edit({ content, embeds: [], files: [attachment], components }).catch(() => {});
  } else {
    const sent = await channel.send({ content, files: [attachment], components }).catch(() => null);
    if (sent) {
      config.controlMessageId = sent.id;
      message = sent;
    }
  }

  scheduleSave();
  return message;
}

async function applyRoomState(roomChannel, ownerId) {
  const profile = getUserProfile(roomChannel.guild.id, ownerId);
  const overwrites = [
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
    overwrites.push({
      id: userId,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory
      ]
    });
  }

  for (const userId of profile.managers) {
    overwrites.push({
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
    overwrites.push({
      id: userId,
      deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect]
    });
  }

  for (const userId of profile.voiceMutedUsers) {
    overwrites.push({
      id: userId,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect],
      deny: [PermissionsBitField.Flags.Speak]
    });
  }

  for (const userId of profile.textMutedUsers) {
    overwrites.push({
      id: userId,
      allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect],
      deny: [PermissionsBitField.Flags.SendMessages]
    });
  }

  await Promise.all([
    roomChannel.permissionOverwrites.set(overwrites, 'Sync temp voice room state').catch(() => null),
    roomChannel.edit({ userLimit: profile.userLimit || 0, rtcRegion: profile.rtcRegion || null }).catch(() => null)
  ]);
}

async function createOrMoveToTempRoom(member) {
  return runSerialized(`temp:create:${member.guild.id}:${member.id}`, async () => {

  const guild = member.guild;
  const config = getGuildConfig(guild.id);
  if (!config.categoryId || !config.creatorChannelId) return null;

  const creator = guild.channels.cache.get(config.creatorChannelId) || await guild.channels.fetch(config.creatorChannelId).catch(() => null);
  if (!creator) return null;

  const profile = getUserProfile(guild.id, member.id);
  profile.lastKnownDisplayName = member.displayName;
  profile.lastUsedAt = Date.now();
  let roomRecord = getRoomRecord(guild.id, member.id);
  let roomChannel = roomRecord?.channelId ? guild.channels.cache.get(roomRecord.channelId) || await guild.channels.fetch(roomRecord.channelId).catch(() => null) : null;
  const hadExistingRoom = Boolean(roomChannel);

  if (!roomChannel) {
    const desiredName = sanitizeRoomName(profile.roomNameTemplate || member.displayName || member.user.username, `${member.displayName || member.user.username} room`);
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
      ownerLeftAt: null
    };
    setRoomRecord(guild.id, member.id, roomRecord);
  } else {
    roomRecord.ownerDisplayName = member.displayName;
    roomRecord.ownerLeftAt = null;
    setRoomRecord(guild.id, member.id, roomRecord);
  }

  profile.lastKnownRoomName = roomChannel.name;
  scheduleSave();

  await Promise.all([
    applyRoomState(roomChannel, member.id),
    member.voice.setChannel(roomChannel).catch(() => null)
  ]);
  await roomChannel.setPosition(1).catch(() => {});
  await scheduleRoomLifecycleJob(guild.id, member.id);
  await ensureGuildControlPanel(guild, `جاهز — آخر تحديث: تم تجهيز روم مؤقت جديد للاستخدام.`);
  await logTempRoomState(guild, {
    title: hadExistingRoom ? '🔁 **استخدام روم مؤقت قائم**' : '🎙️ **إنشاء روم مؤقت جديد**',
    description: hadExistingRoom ? '**تم استخدام الروم المؤقت الحالي ونقل المالك إليه.**' : '**تم إنشاء روم مؤقت جديد ونقل المالك إليه.**',
    actorId: member.id,
    ownerId: member.id,
    roomId: roomChannel.id,
    roomName: roomChannel.name,
    roomRecord,
    extra: `**نوع العملية:** ${hadExistingRoom ? '**استرجاع روم موجود**' : '**إنشاء روم جديد**'}
**الحد الحالي:** **${roomChannel.userLimit || 0}**
**الريجن:** **${profile.rtcRegion || 'auto'}**
**عدد الأعضاء بعد النقل:** **${roomChannel.members.size}**`
  });
  return roomChannel;

  });
}

function getRoomJobKey(guildId, ownerId) {
  return `${guildId}:${ownerId}`;
}

function clearRoomLifecycleJob(guildId, ownerId) {
  const key = getRoomJobKey(guildId, ownerId);
  const existing = roomLifecycleJobs.get(key);
  if (existing) clearTimeout(existing);
  roomLifecycleJobs.delete(key);
}

async function scheduleRoomLifecycleJob(guildId, ownerId) {
  clearRoomLifecycleJob(guildId, ownerId);
  const guild = runtimeClient?.guilds?.cache?.get(guildId) || await runtimeClient?.guilds?.fetch?.(guildId).catch(() => null);
  if (!guild) return;
  const roomRecord = getRoomRecord(guildId, ownerId);
  if (!roomRecord) return;
  const config = getGuildConfig(guildId);
  const deadlines = [];
  if (config.maxRoomAgeMs > 0) deadlines.push(roomRecord.createdAt + config.maxRoomAgeMs);
  if (roomRecord.ownerLeftAt) deadlines.push(roomRecord.ownerLeftAt + config.deleteAfterLeaveMs);
  if (!deadlines.length) return;
  const nextDeadline = Math.min(...deadlines.filter(Boolean));
  const delay = Math.max(1000, nextDeadline - Date.now());
  const key = getRoomJobKey(guildId, ownerId);
  const timer = setTimeout(async () => {
    roomLifecycleJobs.delete(key);
    const liveGuild = runtimeClient?.guilds?.cache?.get(guildId) || await runtimeClient?.guilds?.fetch?.(guildId).catch(() => null);
    if (!liveGuild) return;
    const currentRecord = getRoomRecord(guildId, ownerId);
    if (!currentRecord) return;
    const channel = liveGuild.channels.cache.get(currentRecord.channelId) || await liveGuild.channels.fetch(currentRecord.channelId).catch(() => null);
    if (!channel) {
      deleteRoomRecord(guildId, ownerId);
      return;
    }
    const liveConfig = getGuildConfig(guildId);
    if (liveConfig.maxRoomAgeMs > 0 && Date.now() - currentRecord.createdAt >= liveConfig.maxRoomAgeMs) {
      await deleteTempRoom(liveGuild, ownerId, 'Temp room lifetime reached');
      await updateGeneralPanelStatus(liveGuild, 'ℹ️ تم حذف روم مؤقت لانتهاء مدته المحددة.');
      return;
    }
    if (currentRecord.ownerLeftAt && Date.now() - currentRecord.ownerLeftAt >= liveConfig.deleteAfterLeaveMs) {
      await deleteTempRoom(liveGuild, ownerId, 'Owner left timeout reached');
      await updateGeneralPanelStatus(liveGuild, 'ℹ️ تم حذف روم مؤقت بعد انتهاء مهلة خروج المالك.');
      return;
    }
    await scheduleRoomLifecycleJob(guildId, ownerId);
  }, delay);
  roomLifecycleJobs.set(key, timer);
}

async function deleteTempRoom(guild, ownerId, reason = 'Temp room cleanup') {
  return runSerialized(`temp:delete:${guild.id}:${ownerId}`, async () => {

  const roomRecord = getRoomRecord(guild.id, ownerId);
  if (!roomRecord) return false;
  const channel = roomRecord.channelId ? guild.channels.cache.get(roomRecord.channelId) || await guild.channels.fetch(roomRecord.channelId).catch(() => null) : null;
  if (channel) {
    await logTempRoomState(guild, {
      title: '🗑️ **حذف روم مؤقت**',
      description: '**تم حذف روم مؤقت من النظام.**',
      ownerId,
      roomId: channel.id,
      roomName: channel.name,
      roomRecord,
      reason,
      extra: `**عدد الأعضاء وقت الحذف:** **${channel.members?.size || 0}**`
    });
    await channel.delete(reason).catch(() => {});
  }
  clearRoomLifecycleJob(guild.id, ownerId);
  deleteRoomRecord(guild.id, ownerId);
  return true;

  });
}

async function resolveManagedRoom(interaction, encodedOwnerId = null, { silent = false } = {}) {
  const guild = interaction.guild;
  const member = interaction.member;

  let ownerId = encodedOwnerId;
  let roomRecord = ownerId ? getRoomRecord(guild.id, ownerId) : null;

  if (!roomRecord) {
    const owned = getRoomRecord(guild.id, member.id);
    if (owned) {
      ownerId = member.id;
      roomRecord = owned;
    }
  }

  if (!roomRecord && member.voice?.channelId) {
    for (const [candidateOwnerId, candidateRecord] of Object.entries(getRoomStore(guild.id))) {
      if (candidateRecord.channelId !== member.voice.channelId) continue;
      const profile = getUserProfile(guild.id, candidateOwnerId);
      if (canManageRoom(member, candidateRecord, profile)) {
        ownerId = candidateOwnerId;
        roomRecord = candidateRecord;
        break;
      }
    }
  }

  if (!roomRecord) {
    for (const [candidateOwnerId, candidateRecord] of Object.entries(getRoomStore(guild.id))) {
      const profile = getUserProfile(guild.id, candidateOwnerId);
      if (canManageRoom(member, candidateRecord, profile)) {
        ownerId = candidateOwnerId;
        roomRecord = candidateRecord;
        break;
      }
    }
  }

  if (!roomRecord || !ownerId) {
    if (!silent) {
      await replyEphemeral(interaction, '❌ لم يتم العثور على روم مؤقت تملكه أو تملك صلاحية التحكم به. ادخل رومك المؤقت أولاً.');
    }
    return null;
  }

  const profile = getUserProfile(guild.id, ownerId);
  if (!canManageRoom(member, roomRecord, profile)) {
    if (!silent) {
      await replyEphemeral(interaction, '❌ لا تملك صلاحية التحكم بهذا الروم.');
    }
    return null;
  }

  const roomChannel = guild.channels.cache.get(roomRecord.channelId) || await guild.channels.fetch(roomRecord.channelId).catch(() => null);
  if (!roomChannel) {
    deleteRoomRecord(guild.id, ownerId);
    if (!silent) {
      await replyEphemeral(interaction, '❌ الروم المؤقت غير موجود حالياً.');
    }
    return null;
  }

  getSession(member.id).lastResolvedOwnerId = ownerId;
  return { ownerId, roomRecord, profile, roomChannel };
}

function emphasize(text) {
  const value = String(text ?? '').trim();
  if (!value) return '** **';
  if (value.startsWith('**') && value.endsWith('**')) return value;
  return `**${value}**`;
}

async function replyEphemeral(interaction, content, extra = {}) {
  const payload = { ...extra, content: emphasize(content), ephemeral: true };
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp(payload).catch(() => {});
  }
  return interaction.reply(payload).catch(() => {});
}

async function editEphemeral(interaction, content, extra = {}) {
  const payload = { ...extra, content: emphasize(content) };
  if (interaction.deferred) {
    return interaction.editReply(payload).catch(() => {});
  }
  return replyEphemeral(interaction, content, extra);
}

async function updateGeneralPanelStatus(guild, statusText) {
  await ensureGuildControlPanel(guild, statusText);
}

async function heartbeat() {
  if (!runtimeClient) return;
  const data = loadData();
  for (const guildId of Object.keys(data.rooms)) {
    const guild = runtimeClient.guilds.cache.get(guildId) || await runtimeClient.guilds.fetch(guildId).catch(() => null);
    if (!guild) continue;
    const config = getGuildConfig(guildId);

    for (const [ownerId, roomRecord] of Object.entries(getRoomStore(guildId))) {
      const channel = guild.channels.cache.get(roomRecord.channelId) || await guild.channels.fetch(roomRecord.channelId).catch(() => null);
      if (!channel) {
        deleteRoomRecord(guildId, ownerId);
        continue;
      }

      const ownerPresent = channel.members.has(ownerId);
      if (ownerPresent && roomRecord.ownerLeftAt) {
        roomRecord.ownerLeftAt = null;
        setRoomRecord(guildId, ownerId, roomRecord);
      } else if (!ownerPresent && !roomRecord.ownerLeftAt) {
        roomRecord.ownerLeftAt = Date.now();
        setRoomRecord(guildId, ownerId, roomRecord);
      }

      if (config.maxRoomAgeMs > 0 && Date.now() - roomRecord.createdAt >= config.maxRoomAgeMs) {
        await deleteTempRoom(guild, ownerId, 'Temp room lifetime reached');
        continue;
      }

      if (!ownerPresent && roomRecord.ownerLeftAt && Date.now() - roomRecord.ownerLeftAt >= config.deleteAfterLeaveMs) {
        await deleteTempRoom(guild, ownerId, 'Owner left timeout reached');
        continue;
      }

      if (config.autoCleanEnabled && config.autoCleanIntervalMs > 0 && channel.isTextBased()) {
        const lastClean = roomRecord.lastAutoCleanAt || 0;
        if (Date.now() - lastClean >= config.autoCleanIntervalMs) {
          roomRecord.lastAutoCleanAt = Date.now();
          setRoomRecord(guildId, ownerId, roomRecord);
          const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
          if (messages?.size) {
            await Promise.all(messages.filter(msg => !msg.pinned).map(msg => msg.delete().catch(() => null)));
          }
        }
      }
    }

    await ensureCreatorChannel(guild).catch(() => null);
    if (config.controlChannelId) await ensureGuildControlPanel(guild).catch(() => null);
  }
}

async function handleVoiceStateUpdate(oldState, newState) {
  if (!newState.member || newState.member.user.bot) return;
  const guild = newState.guild;
  const config = getGuildConfig(guild.id);

  if (newState.channelId && newState.channelId === config.creatorChannelId) {
    await createOrMoveToTempRoom(newState.member);
  }

  for (const [ownerId, roomRecord] of Object.entries(getRoomStore(guild.id))) {
    if (oldState.channelId !== roomRecord.channelId && newState.channelId !== roomRecord.channelId) continue;
    const channel = guild.channels.cache.get(roomRecord.channelId) || await guild.channels.fetch(roomRecord.channelId).catch(() => null);
    if (!channel) {
      deleteRoomRecord(guild.id, ownerId);
      continue;
    }
    const ownerPresent = channel.members.has(ownerId);
    const previousOwnerLeftAt = roomRecord.ownerLeftAt;
    if (ownerPresent) {
      roomRecord.ownerLeftAt = null;
    } else if (!roomRecord.ownerLeftAt) {
      roomRecord.ownerLeftAt = Date.now();
    }
    roomRecord.ownerDisplayName = guild.members.cache.get(ownerId)?.displayName || roomRecord.ownerDisplayName;
    setRoomRecord(guild.id, ownerId, roomRecord);
    await scheduleRoomLifecycleJob(guild.id, ownerId);

    if (!previousOwnerLeftAt && roomRecord.ownerLeftAt) {
      await logTempRoomState(guild, {
        title: '🚶 **خروج مالك الروم**',
        description: '**خرج مالك الروم المؤقت من رومه وبدأ عداد الحذف التلقائي.**',
        ownerId,
        roomId: channel.id,
        roomName: channel.name,
        roomRecord,
        ownerLeftAt: roomRecord.ownerLeftAt,
        extra: `**مهلة الحذف الحالية:** ${formatDuration(config.deleteAfterLeaveMs)}
**عدد الأعضاء المتبقين:** **${channel.members.size}**`
      });
    } else if (previousOwnerLeftAt && ownerPresent) {
      await logTempRoomState(guild, {
        title: '↩️ **عودة مالك الروم**',
        description: '**عاد مالك الروم المؤقت إلى رومه وتم إلغاء عداد الحذف.**',
        ownerId,
        roomId: channel.id,
        roomName: channel.name,
        roomRecord,
        extra: `**عدد الأعضاء الحالي:** **${channel.members.size}**`
      });
    }

    const joinedTemp = newState.channelId === roomRecord.channelId && oldState.channelId !== roomRecord.channelId;
    const leftTemp = oldState.channelId === roomRecord.channelId && newState.channelId !== roomRecord.channelId;
    if (joinedTemp || leftTemp) {
      const movedMember = newState.member || oldState.member;
      await sendTempLog(guild, {
        title: joinedTemp ? '➕ **دخول عضو إلى روم مؤقت**' : '➖ **خروج عضو من روم مؤقت**',
        description: joinedTemp ? '**تم تسجيل دخول عضو إلى أحد الرومات المؤقتة.**' : '**تم تسجيل خروج عضو من أحد الرومات المؤقتة.**',
        fields: [
          { name: '**العضو**', value: `<@${movedMember.id}>
**${movedMember.displayName}**`, inline: true },
          { name: '**مالك الروم**', value: `<@${ownerId}>
**${getDisplayNameFromGuild(guild, ownerId)}**`, inline: true },
          { name: '**الروم**', value: `<#${roomRecord.channelId}>`, inline: true },
          { name: '**عدد الأعضاء الحالي**', value: `**${channel.members.size}**`, inline: true },
          { name: '**القناة السابقة**', value: oldState.channelId ? `<#${oldState.channelId}>` : '**لا يوجد**', inline: true },
          { name: '**القناة الحالية**', value: newState.channelId ? `<#${newState.channelId}>` : '**لا يوجد**', inline: true }
        ]
      });
    }
  }
}

async function execute(message, args, { BOT_OWNERS = [] }) {
  if (!isGuildAdmin(message.member, BOT_OWNERS)) {
    await message.react('❌').catch(() => {});
    return;
  }

  await ensureCreatorChannel(message.guild).catch(() => null);
  if (getGuildConfig(message.guild.id).controlChannelId) {
    await ensureGuildControlPanel(message.guild).catch(() => null);
  }

  const sent = await message.reply({
    embeds: [createSettingsEmbed(message.guild, message.author.id)],
    components: buildSettingsRows(message.author.id)
  });

  const session = getSession(message.author.id);
  session.settingsChannelId = sent.channel.id;
  session.settingsMessageId = sent.id;
  await updateSettingsPanelMessage(message.guild, message.author.id);
}

async function ensureSettingsOwner(interaction, targetUserId) {
  if (interaction.user.id !== targetUserId) {
    await replyEphemeral(interaction, '❌ هذه اللوحة ليست لك.');
    return false;
  }
  return true;
}

async function handleSettingsButton(interaction) {
  const { action, args } = parseCustomId(interaction.customId);
  const userId = args[0];
  if (!(await ensureSettingsOwner(interaction, userId))) return true;

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
      content: '**اختر الكاتوقري التي ستحتوي روم الإنشاء والرومات المؤقتة.**',
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
      content: '**اختر روم التحكم النصي العام. سيتم فيه تثبيت رسالة تحكم واحدة فقط للجميع.**',
      components: [new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`temp_settings_control_select:${userId}`)
          .setPlaceholder('اختر روم التحكم')
          .setChannelTypes(ChannelType.GuildText)
          .setMinValues(1)
          .setMaxValues(1)
      )],
      ephemeral: true
    }).catch(() => {});
    return true;
  }

  if (action === 'temp_settings_log') {
    await interaction.reply({
      content: '**اختر روم اللوق النصي الذي سيستقبل السجلات التفصيلية لنظام الرومات المؤقتة.**',
      components: [new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`temp_settings_log_select:${userId}`)
          .setPlaceholder('اختر روم اللوق')
          .setChannelTypes(ChannelType.GuildText)
          .setMinValues(1)
          .setMaxValues(1)
      )],
      ephemeral: true
    }).catch(() => {});
    return true;
  }

  if (['temp_settings_name', 'temp_settings_autoclean', 'temp_settings_lifetime', 'temp_settings_leave'].includes(action)) {
    const config = getGuildConfig(interaction.guild.id);
    const modal = new ModalBuilder().setCustomId(`${action}_modal:${userId}`).setTitle('Temp Voice Settings');

    if (action === 'temp_settings_name') {
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel('Creator Channel Name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(config.creatorChannelName || DEFAULT_CREATOR_NAME)
          .setMaxLength(90)
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
            .setValue(config.autoCleanEnabled ? 'yes' : 'no')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('duration')
            .setLabel('Interval مثال: 10m أو 30s')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(`${Math.max(1, Math.round((config.autoCleanIntervalMs || DEFAULT_AUTO_CLEAN_MS) / 60000))}m`)
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
          .setValue(config.maxRoomAgeMs ? `${Math.max(1, Math.round(config.maxRoomAgeMs / 3600000))}h` : 'off')
      ));
    }

    if (action === 'temp_settings_leave') {
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('duration')
          .setLabel('Delete after owner leaves مثال: 5m')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(`${Math.max(1, Math.round(config.deleteAfterLeaveMs / 60000))}m`)
      ));
    }

    await interaction.showModal(modal).catch(() => {});
    return true;
  }

  if (action === 'temp_settings_controls') {
    const session = getSession(userId);
    const config = getGuildConfig(interaction.guild.id);
    session.tempControls = { ...config.enabledControls };

    await interaction.reply({
      content: '**اختر الأزرار التي تريد إبقاءها داخل لوحة التحكم العامة.**',
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`temp_settings_controls_select:${userId}`)
            .setPlaceholder('اختر الأزرار المفعّلة')
            .addOptions(SETTING_CONTROL_KEYS.map(key => ({
              label: CONTROL_META[key].label,
              description: CONTROL_META[key].description.slice(0, 90),
              value: key,
              default: config.enabledControls[key] !== false
            })))
            .setMinValues(0)
            .setMaxValues(SETTING_CONTROL_KEYS.length)
        ),
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

  if (['temp_settings_controls_save', 'temp_settings_controls_reset', 'temp_settings_controls_cancel'].includes(action)) {
    const session = getSession(userId);
    if (action === 'temp_settings_controls_reset') {
      session.tempControls = defaultEnabledControls();
      await interaction.update({ content: '✅ تمت إعادة تفعيل كل الأزرار. اضغط Save للحفظ.', components: interaction.message.components }).catch(() => {});
      return true;
    }
    if (action === 'temp_settings_controls_cancel') {
      session.tempControls = null;
      await interaction.update({ content: '❌ تم إلغاء تعديل الأزرار.', components: [] }).catch(() => {});
      return true;
    }
    if (session.tempControls) {
      getGuildConfig(interaction.guild.id).enabledControls = { ...session.tempControls };
      scheduleSave();
      session.tempControls = null;
      await interaction.update({ content: '✅ تم حفظ الأزرار.', components: [] }).catch(() => {});
      await Promise.all([
        updateSettingsPanelMessage(interaction.guild, userId),
        ensureGuildControlPanel(interaction.guild)
      ]);
      await sendTempLog(interaction.guild, {
        title: '🎛️ **تحديث أزرار التحكم**',
        description: '**تم حفظ قائمة الأزرار الظاهرة داخل لوحة التحكم العامة.**',
        fields: [
          { name: '**المنفذ**', value: `<@${interaction.user.id}>`, inline: true },
          { name: '**عدد الأزرار المفعلة**', value: `**${Object.values(getGuildConfig(interaction.guild.id).enabledControls).filter(Boolean).length}**`, inline: true }
        ]
      });
      return true;
    }
  }

  return true;
}

async function handleSettingsSelect(interaction) {
  const { action, args } = parseCustomId(interaction.customId);
  const userId = args[0];
  if (!(await ensureSettingsOwner(interaction, userId))) return true;
  const config = getGuildConfig(interaction.guild.id);

  if (action === 'temp_settings_category_select') {
    config.categoryId = interaction.values[0];
    scheduleSave();
    const creator = await ensureCreatorChannel(interaction.guild);
    await interaction.update({ content: `✅ تم تحديد الكاتوقري، وروم الإنشاء الحالي: ${creator ? `<#${creator.id}>` : '**تعذر إنشاؤه حالياً**'}.`, components: [] }).catch(() => {});
    await updateSettingsPanelMessage(interaction.guild, userId);
    await sendTempLog(interaction.guild, {
      title: '🗂️ **تحديث الكاتيجوري**',
      description: '**تم تحديث الكاتيجوري المعتمدة للرومات المؤقتة.**',
      fields: [
        { name: '**المنفذ**', value: `<@${interaction.user.id}>`, inline: true },
        { name: '**الكاتيجوري**', value: `<#${interaction.values[0]}>`, inline: true },
        { name: '**روم الإنشاء الحالي**', value: creator ? `<#${creator.id}>` : '**تعذر إنشاؤه حالياً**', inline: true }
      ]
    });
    return true;
  }

  if (action === 'temp_settings_control_select') {
    config.controlChannelId = interaction.values[0];
    config.controlMessageId = null;
    scheduleSave();
    await interaction.update({ content: `✅ تم تحديد روم التحكم إلى <#${interaction.values[0]}>.`, components: [] }).catch(() => {});
    await Promise.all([
      updateSettingsPanelMessage(interaction.guild, userId),
      ensureGuildControlPanel(interaction.guild, 'جاهز للاستخدام — لوحة عامة ثابتة للجميع.')
    ]);
    await sendTempLog(interaction.guild, {
      title: '📌 **تحديث روم التحكم**',
      description: '**تم تعيين روم التحكم العام للنظام.**',
      fields: [
        { name: '**المنفذ**', value: `<@${interaction.user.id}>`, inline: true },
        { name: '**الروم الجديد**', value: `<#${interaction.values[0]}>`, inline: true }
      ]
    });
    return true;
  }

  if (action === 'temp_settings_log_select') {
    config.logChannelId = interaction.values[0];
    scheduleSave();
    await interaction.update({ content: `✅ تم تحديد روم اللوق إلى <#${interaction.values[0]}>.`, components: [] }).catch(() => {});
    await updateSettingsPanelMessage(interaction.guild, userId);
    await sendTempLog(interaction.guild, {
      title: '🧾 **تفعيل روم اللوق**',
      description: '**تم تعيين روم اللوق الخاص بنظام الرومات المؤقتة.**',
      fields: [
        { name: '**المنفذ**', value: `<@${interaction.user.id}>`, inline: true },
        { name: '**روم اللوق**', value: `<#${interaction.values[0]}>`, inline: true }
      ]
    });
    return true;
  }

  if (action === 'temp_settings_controls_select') {
    const session = getSession(userId);
    session.tempControls = Object.fromEntries(SETTING_CONTROL_KEYS.map(key => [key, interaction.values.includes(key)]));
    await interaction.update({ content: `✅ تم تحديث المعاينة. العناصر المختارة: **${interaction.values.length}**`, components: interaction.message.components }).catch(() => {});
    return true;
  }

  return true;
}

async function handleSettingsModal(interaction) {
  const { action, args } = parseCustomId(interaction.customId);
  const userId = args[0];
  if (!(await ensureSettingsOwner(interaction, userId))) return true;
  const config = getGuildConfig(interaction.guild.id);

  if (action === 'temp_settings_name_modal') {
    config.creatorChannelName = sanitizeRoomName(interaction.fields.getTextInputValue('value'), DEFAULT_CREATOR_NAME);
    scheduleSave();
    await ensureCreatorChannel(interaction.guild);
    await replyEphemeral(interaction, `✅ تم تحديث اسم روم الإنشاء إلى ${config.creatorChannelName}.`);
    await updateSettingsPanelMessage(interaction.guild, userId);
    await sendTempLog(interaction.guild, {
      title: '✏️ **تحديث اسم روم الإنشاء**',
      description: '**تم تعديل اسم روم الإنشاء الافتراضي.**',
      fields: [
        { name: '**المنفذ**', value: `<@${interaction.user.id}>`, inline: true },
        { name: '**الاسم الجديد**', value: `**${config.creatorChannelName}**`, inline: true }
      ]
    });
    return true;
  }

  if (action === 'temp_settings_autoclean_modal') {
    const enabledRaw = interaction.fields.getTextInputValue('enabled').trim().toLowerCase();
    const duration = parseFlexibleDuration(interaction.fields.getTextInputValue('duration'));
    if (duration === null) {
      await replyEphemeral(interaction, '❌ مدة التنظيف غير صحيحة.');
      return true;
    }
    config.autoCleanEnabled = ['yes', 'true', 'on', '1', 'y', 'نعم'].includes(enabledRaw);
    config.autoCleanIntervalMs = Math.max(15000, duration || DEFAULT_AUTO_CLEAN_MS);
    scheduleSave();
    await replyEphemeral(interaction, `✅ تم ${config.autoCleanEnabled ? 'تفعيل' : 'تعطيل'} التنظيف التلقائي كل ${formatDuration(config.autoCleanIntervalMs)}.`);
    await updateSettingsPanelMessage(interaction.guild, userId);
    await sendTempLog(interaction.guild, {
      title: '🧹 **تحديث التنظيف التلقائي**',
      description: '**تم تعديل إعدادات التنظيف التلقائي للرومات المؤقتة.**',
      fields: [
        { name: '**المنفذ**', value: `<@${interaction.user.id}>`, inline: true },
        { name: '**الحالة**', value: boolText(config.autoCleanEnabled), inline: true },
        { name: '**الفاصل**', value: formatDuration(config.autoCleanIntervalMs), inline: true }
      ]
    });
    return true;
  }

  if (action === 'temp_settings_lifetime_modal') {
    const duration = parseFlexibleDuration(interaction.fields.getTextInputValue('duration'));
    if (duration === null) {
      await replyEphemeral(interaction, '❌ مدة العمر غير صحيحة.');
      return true;
    }
    config.maxRoomAgeMs = duration;
    scheduleSave();
    await replyEphemeral(interaction, `✅ تم تحديث الحد الأقصى لعمر الروم إلى ${formatDuration(duration)}.`);
    await updateSettingsPanelMessage(interaction.guild, userId);
    await sendTempLog(interaction.guild, {
      title: '⏳ **تحديث عمر الروم**',
      description: '**تم تعديل الحد الأقصى لعمر الرومات المؤقتة.**',
      fields: [
        { name: '**المنفذ**', value: `<@${interaction.user.id}>`, inline: true },
        { name: '**القيمة الجديدة**', value: formatDuration(duration), inline: true }
      ]
    });
    return true;
  }

  if (action === 'temp_settings_leave_modal') {
    const duration = parseFlexibleDuration(interaction.fields.getTextInputValue('duration'));
    if (duration === null) {
      await replyEphemeral(interaction, '❌ مدة الحذف بعد الخروج غير صحيحة.');
      return true;
    }
    config.deleteAfterLeaveMs = Math.max(0, duration);
    scheduleSave();
    await replyEphemeral(interaction, `✅ سيتم حذف الروم بعد خروج المالك بـ ${formatDuration(config.deleteAfterLeaveMs)}.`);
    await updateSettingsPanelMessage(interaction.guild, userId);
    await sendTempLog(interaction.guild, {
      title: '🚪 **تحديث مهلة حذف الروم**',
      description: '**تم تعديل مهلة حذف الروم بعد خروج المالك.**',
      fields: [
        { name: '**المنفذ**', value: `<@${interaction.user.id}>`, inline: true },
        { name: '**المهلة الجديدة**', value: formatDuration(config.deleteAfterLeaveMs), inline: true }
      ]
    });
    return true;
  }

  return true;
}

async function performGeneralAction(interaction, action, resolverResult = null) {
  const access = resolverResult || await resolveManagedRoom(interaction);
  if (!access) return true;
  const { ownerId, roomRecord, profile, roomChannel } = access;
  const guild = interaction.guild;
  const useEphemeralReply = ['temp_room_open', 'temp_room_lock', 'temp_room_show', 'temp_room_hide', 'temp_room_invite', 'temp_room_music', 'temp_room_admin', 'temp_room_transfer', 'temp_room_allow', 'temp_room_reject', 'temp_room_region'].includes(action) && interaction.isButton();

  if (useEphemeralReply) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
  }

  if (action === 'temp_room_open') {
    if (!profile.locked) {
      await editEphemeral(interaction, 'ℹ️ الروم مفتوح بالفعل — لم يتم تغيير شيء.');
      return true;
    }
    profile.locked = false;
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
    await editEphemeral(interaction, '✅ تم فتح الروم العام بنجاح.');
    await logTempRoomState(guild, {
      title: '🔓 **فتح روم مؤقت**',
      description: '**تم فتح الروم المؤقت والسماح بالدخول العام إليه.**',
      actorId: interaction.user.id,
      ownerId,
      roomId: roomChannel.id,
      roomName: roomChannel.name,
      roomRecord
    });
    return true;
  }

  if (action === 'temp_room_lock') {
    if (profile.locked) {
      await editEphemeral(interaction, 'ℹ️ الروم مقفل بالفعل — لم يتم تغيير شيء.');
      return true;
    }
    profile.locked = true;
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
    await editEphemeral(interaction, '✅ تم قفل الروم بنجاح.');
    await logTempRoomState(guild, {
      title: '🔒 **قفل روم مؤقت**',
      description: '**تم قفل الروم المؤقت ومنع الدخول العام إليه.**',
      actorId: interaction.user.id,
      ownerId,
      roomId: roomChannel.id,
      roomName: roomChannel.name,
      roomRecord
    });
    return true;
  }

  if (action === 'temp_room_show') {
    if (!profile.hidden) {
      await editEphemeral(interaction, 'ℹ️ الروم ظاهر بالفعل — لم يتم تغيير شيء.');
      return true;
    }
    profile.hidden = false;
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
    await editEphemeral(interaction, '✅ تم إظهار الروم بنجاح.');
    await logTempRoomState(guild, {
      title: '👁️ **إظهار روم مؤقت**',
      description: '**تم جعل الروم المؤقت مرئياً للأعضاء.**',
      actorId: interaction.user.id,
      ownerId,
      roomId: roomChannel.id,
      roomName: roomChannel.name,
      roomRecord
    });
    return true;
  }

  if (action === 'temp_room_hide') {
    if (profile.hidden) {
      await editEphemeral(interaction, 'ℹ️ الروم مخفي بالفعل — لم يتم تغيير شيء.');
      return true;
    }
    profile.hidden = true;
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
    await editEphemeral(interaction, '✅ تم إخفاء الروم بنجاح.');
    await logTempRoomState(guild, {
      title: '🙈 **إخفاء روم مؤقت**',
      description: '**تم إخفاء الروم المؤقت عن الأعضاء غير المصرح لهم.**',
      actorId: interaction.user.id,
      ownerId,
      roomId: roomChannel.id,
      roomName: roomChannel.name,
      roomRecord
    });
    return true;
  }

  if (action === 'temp_room_invite') {
    const invite = await roomChannel.createInvite({ maxAge: 3600, maxUses: 0, unique: true, reason: 'Temp room invite' }).catch(() => null);
    if (!invite) {
      await editEphemeral(interaction, '❌ تعذر إنشاء الدعوة حالياً.');
      return true;
    }
    await editEphemeral(interaction, `✅ رابط الدعوة الخاص برومك: ${invite.url}`);
    await logTempRoomState(guild, {
      title: '🔗 **إنشاء دعوة لروم مؤقت**',
      description: '**تم إنشاء دعوة مباشرة للروم المؤقت.**',
      actorId: interaction.user.id,
      ownerId,
      roomId: roomChannel.id,
      roomName: roomChannel.name,
      roomRecord,
      extra: `**رابط الدعوة:** ${invite.url}`
    });
    return true;
  }

  if (action === 'temp_room_rename') {
    const modal = new ModalBuilder().setCustomId(`temp_room_rename_modal:${ownerId}`).setTitle('Rename Temp Room');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('value')
        .setLabel('New room name')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(96)
        .setValue(roomChannel.name)
    ));
    await interaction.showModal(modal).catch(() => {});
    return true;
  }

  if (action === 'temp_room_limit') {
    const modal = new ModalBuilder().setCustomId(`temp_room_limit_modal:${ownerId}`).setTitle('Room Limit');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('value')
        .setLabel('User limit from 0 to 99')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(roomChannel.userLimit || 0))
    ));
    await interaction.showModal(modal).catch(() => {});
    return true;
  }

  if (action === 'temp_room_region') {
    await editEphemeral(interaction, 'اختر ريجن الصوت للروم الحالي.', {
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`temp_room_region_select:${ownerId}`)
          .setPlaceholder('اختر الريجن')
          .addOptions(REGION_OPTIONS)
          .setMinValues(1)
          .setMaxValues(1)
      )]
    });
    return true;
  }

  if (action === 'temp_room_allow') {
    await editEphemeral(interaction, 'اختر العضو أو الأعضاء الذين تريد السماح لهم بالدخول والرؤية.', {
      components: [new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`temp_room_allow_select:${ownerId}`)
          .setPlaceholder('اختر الأعضاء')
          .setMinValues(1)
          .setMaxValues(10)
      )]
    });
    return true;
  }

  if (action === 'temp_room_reject') {
    const options = [];
    for (const userId of profile.allowedUsers) options.push({ label: `Allow • ${getDisplayNameFromGuild(guild, userId)}`.slice(0, 100), value: `allow:${userId}`, description: 'إزالة السماح' });
    for (const userId of profile.bannedUsers) options.push({ label: `Ban • ${getDisplayNameFromGuild(guild, userId)}`.slice(0, 100), value: `ban:${userId}`, description: 'فك الحظر' });
    for (const userId of profile.managers) options.push({ label: `Admin • ${getDisplayNameFromGuild(guild, userId)}`.slice(0, 100), value: `admin:${userId}`, description: 'إزالة المسؤول' });

    if (!options.length) {
      await editEphemeral(interaction, 'ℹ️ لا توجد عناصر محفوظة لإزالتها حالياً.');
      return true;
    }

    await editEphemeral(interaction, 'اختر العناصر التي تريد حذفها من السماح أو الحظر أو المسؤولين.', {
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`temp_room_reject_select:${ownerId}`)
          .setPlaceholder('اختر العناصر المراد حذفها')
          .addOptions(options.slice(0, 25))
          .setMinValues(1)
          .setMaxValues(Math.min(options.length, 25))
      )]
    });
    return true;
  }

  if (action === 'temp_room_music') {
    const musicBot = guild.members.cache.find(member =>
      member.user.bot &&
      member.voice?.channelId &&
      member.voice.channelId !== roomChannel.id &&
      /music|song|player|luna|hydra|probot/i.test(member.user.username)
    );
    if (!musicBot) {
      await editEphemeral(interaction, 'ℹ️ لم يتم العثور على بوت أغاني مناسب للنقل حالياً.');
      return true;
    }
    await musicBot.voice.setChannel(roomChannel).catch(() => null);
    await editEphemeral(interaction, `✅ تمت محاولة سحب بوت الأغاني ${musicBot.user.username} إلى الروم.`);
    await logTempRoomState(guild, {
      title: '🎵 **سحب بوت أغاني**',
      description: '**تم تنفيذ محاولة سحب بوت أغاني إلى الروم المؤقت.**',
      actorId: interaction.user.id,
      ownerId,
      roomId: roomChannel.id,
      roomName: roomChannel.name,
      roomRecord,
      extra: `**البوت:** **${musicBot.user.username}**`
    });
    return true;
  }

  if (action === 'temp_room_admin') {
    const managersText = profile.managers.length ? profile.managers.map(id => `• ${getDisplayNameFromGuild(guild, id)} (<@${id}>)`).join('\n') : '**لا يوجد مسؤولون**';
    const recentManagerLog = (profile.managerHistory || []).slice(0, 4).map(entry => `• ${entry.action === 'add' ? 'إضافة' : 'إزالة'}: ${getDisplayNameFromGuild(guild, entry.userId)} — <@${entry.by}>`).join('\n') || '**لا توجد عمليات حديثة**';
    const allowedAdminActions = canManageAdminPanel(interaction.member, roomRecord);
    await editEphemeral(interaction, 'تم فتح لوحة مسؤولي الروم لك بشكل خاص.', {
      embeds: [colorManager.createEmbed().setTitle('**Room Managers**').setDescription(`**المسؤولون الحاليون (${profile.managers.length}):**
${managersText}

**آخر التغييرات:**
${recentManagerLog}`)],
      components: allowedAdminActions ? [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`temp_room_admin_add:${ownerId}`).setLabel('Add').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`temp_room_admin_remove:${ownerId}`).setLabel('Remove').setStyle(ButtonStyle.Danger)
        )
      ] : []
    });
    return true;
  }

  if (action === 'temp_room_transfer') {
    if (!canManageAdminPanel(interaction.member, roomRecord)) {
      await editEphemeral(interaction, '❌ فقط مالك الروم أو إداري السيرفر يقدر ينقل الملكية.');
      return true;
    }
    await editEphemeral(interaction, 'اختر العضو الذي تريد نقل ملكية الروم إليه.', {
      components: [new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`temp_room_transfer_select:${ownerId}`)
          .setPlaceholder('اختر العضو')
          .setMinValues(1)
          .setMaxValues(1)
      )]
    });
    return true;
  }

  return true;
}

async function handleRoomButton(interaction) {
  const { action, args } = parseCustomId(interaction.customId);
  const ownerId = args[0] || null;

  if (action === 'temp_room_admin_add' || action === 'temp_room_admin_remove') {
    const access = await resolveManagedRoom(interaction, ownerId);
    if (!access) return true;
    if (!canManageAdminPanel(interaction.member, access.roomRecord)) {
      await replyEphemeral(interaction, '❌ فقط مالك الروم أو إداري السيرفر يمكنه تعديل قائمة المسؤولين.');
      return true;
    }
    await replyEphemeral(interaction, `اختر العضو ${action === 'temp_room_admin_add' ? 'لإضافته' : 'لإزالته'} من قائمة المسؤولين.`, {
      components: [new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`${action}_select:${access.ownerId}`)
          .setPlaceholder('اختر الأعضاء')
          .setMinValues(1)
          .setMaxValues(10)
      )]
    });
    return true;
  }

  return performGeneralAction(interaction, action, ownerId ? await resolveManagedRoom(interaction, ownerId) : null);
}

async function handleRoomSelect(interaction) {
  const { action, args } = parseCustomId(interaction.customId);
  const ownerId = args[0] || null;
  const access = action === 'temp_room_actions'
    ? await resolveManagedRoom(interaction)
    : await resolveManagedRoom(interaction, ownerId);
  if (!access) return true;
  const { ownerId: resolvedOwnerId, profile, roomRecord, roomChannel } = access;

  if (action === 'temp_room_region_select') {
    const region = interaction.values[0];
    profile.rtcRegion = region === 'auto' ? null : region;
    scheduleSave();
    await applyRoomState(roomChannel, resolvedOwnerId);
    await replyEphemeral(interaction, `✅ تم تحديث الريجن إلى ${region}.`);
    await logTempRoomState(interaction.guild, {
      title: '🌍 **تحديث ريجن الروم**',
      description: '**تم تغيير ريجن الروم المؤقت.**',
      actorId: interaction.user.id,
      ownerId: resolvedOwnerId,
      roomId: roomChannel.id,
      roomName: roomChannel.name,
      roomRecord,
      extra: `**الريجن الجديد:** **${region}**`
    });
    return true;
  }

  if (action === 'temp_room_allow_select') {
    for (const userId of interaction.values) {
      if (!profile.allowedUsers.includes(userId)) profile.allowedUsers.push(userId);
      profile.bannedUsers = profile.bannedUsers.filter(id => id !== userId);
      profile.allowHistory = pushLimitedHistory(profile.allowHistory, { action: 'allow', userId, by: interaction.user.id, at: Date.now() });
    }
    scheduleSave();
    await applyRoomState(roomChannel, resolvedOwnerId);
    await replyEphemeral(interaction, `✅ تم حفظ السماح لـ ${interaction.values.map(id => `<@${id}>`).join('، ')}.`);
    await logTempRoomState(interaction.guild, {
      title: '✅ **تحديث قائمة السماح**',
      description: '**تمت إضافة أعضاء إلى قائمة السماح الخاصة بالروم المؤقت.**',
      actorId: interaction.user.id,
      ownerId: resolvedOwnerId,
      roomId: roomChannel.id,
      roomName: roomChannel.name,
      roomRecord,
      extra: interaction.values.map(id => `<@${id}>`).join('، ')
    });
    return true;
  }

  if (action === 'temp_room_reject_select') {
    for (const entry of interaction.values) {
      const [type, userId] = entry.split(':');
      if (type === 'allow') profile.allowedUsers = profile.allowedUsers.filter(id => id !== userId);
      if (type === 'ban') profile.bannedUsers = profile.bannedUsers.filter(id => id !== userId);
      if (type === 'admin') profile.managers = profile.managers.filter(id => id !== userId);
      profile.allowHistory = pushLimitedHistory(profile.allowHistory, { action: `remove_${type}`, userId, by: interaction.user.id, at: Date.now() });
    }
    scheduleSave();
    await applyRoomState(roomChannel, resolvedOwnerId);
    await replyEphemeral(interaction, '✅ تم حذف العناصر المحددة.');
    await logTempRoomState(interaction.guild, {
      title: '🧹 **تنظيف قوائم الروم**',
      description: '**تم حذف عناصر من قوائم السماح أو الحظر أو المسؤولين.**',
      actorId: interaction.user.id,
      ownerId: resolvedOwnerId,
      roomId: roomChannel.id,
      roomName: roomChannel.name,
      roomRecord,
      extra: interaction.values.map(value => `**${value}**`).join('\n')
    });
    return true;
  }

  if (action === 'temp_room_actions') {
    const selectedAction = interaction.values[0];
    await replyEphemeral(interaction, `اختر العضو لتنفيذ الإجراء: ${selectedAction}.`, {
      components: [new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`temp_room_action_target:${resolvedOwnerId}:${selectedAction}`)
          .setPlaceholder('اختر العضو المستهدف')
          .setMinValues(1)
          .setMaxValues(1)
      )]
    });
    return true;
  }

  if (['temp_room_admin_add_select', 'temp_room_admin_remove_select', 'temp_room_transfer_select'].includes(action)) {
    if (!canManageAdminPanel(interaction.member, roomRecord)) {
      await replyEphemeral(interaction, '❌ غير مسموح.');
      return true;
    }

    if (action === 'temp_room_transfer_select') {
      const newOwnerId = interaction.values[0];
      if (newOwnerId === resolvedOwnerId) {
        await replyEphemeral(interaction, 'ℹ️ هذا العضو هو المالك الحالي بالفعل.');
        return true;
      }
      const targetMember = await interaction.guild.members.fetch(newOwnerId).catch(() => null);
      if (!targetMember) {
        await replyEphemeral(interaction, '❌ العضو غير موجود.');
        return true;
      }
      if (targetMember.user.bot) {
        await replyEphemeral(interaction, '❌ لا يمكن نقل الملكية إلى بوت.');
        return true;
      }
      if (getRoomRecord(interaction.guild.id, newOwnerId)) {
        await replyEphemeral(interaction, '❌ هذا العضو لديه روم مؤقت بالفعل، ولا يمكنه امتلاك رومين.');
        return true;
      }

      const oldProfile = getUserProfile(interaction.guild.id, resolvedOwnerId);
      const targetProfile = getUserProfile(interaction.guild.id, newOwnerId);
      targetProfile.allowedUsers = Array.from(new Set([...(targetProfile.allowedUsers || []), ...(oldProfile.allowedUsers || [])]));
      targetProfile.bannedUsers = Array.from(new Set([...(targetProfile.bannedUsers || []), ...(oldProfile.bannedUsers || [])]));
      targetProfile.voiceMutedUsers = Array.from(new Set([...(targetProfile.voiceMutedUsers || []), ...(oldProfile.voiceMutedUsers || [])]));
      targetProfile.textMutedUsers = Array.from(new Set([...(targetProfile.textMutedUsers || []), ...(oldProfile.textMutedUsers || [])]));
      targetProfile.managers = Array.from(new Set((oldProfile.managers || []).filter(id => id !== newOwnerId)));
      targetProfile.hidden = oldProfile.hidden;
      targetProfile.locked = oldProfile.locked;
      targetProfile.userLimit = oldProfile.userLimit;
      targetProfile.rtcRegion = oldProfile.rtcRegion;
      targetProfile.roomNameTemplate = oldProfile.roomNameTemplate || roomChannel.name;
      targetProfile.ownershipHistory = pushLimitedHistory(targetProfile.ownershipHistory, { action: 'received', from: resolvedOwnerId, by: interaction.user.id, at: Date.now() });
      oldProfile.ownershipHistory = pushLimitedHistory(oldProfile.ownershipHistory, { action: 'transferred', to: newOwnerId, by: interaction.user.id, at: Date.now() });

      deleteRoomRecord(interaction.guild.id, resolvedOwnerId);
      roomRecord.ownerId = newOwnerId;
      roomRecord.ownerDisplayName = targetMember.displayName;
      roomRecord.ownerLeftAt = null;
      setRoomRecord(interaction.guild.id, newOwnerId, roomRecord);
      await applyRoomState(roomChannel, newOwnerId);
      await scheduleRoomLifecycleJob(interaction.guild.id, newOwnerId);
      await replyEphemeral(interaction, `✅ تم نقل ملكية الروم إلى <@${newOwnerId}>.`);
      await logTempRoomState(interaction.guild, {
        title: '👑 **نقل ملكية روم مؤقت**',
        description: '**تم نقل ملكية الروم المؤقت إلى عضو آخر.**',
        actorId: interaction.user.id,
        ownerId: newOwnerId,
        roomId: roomChannel.id,
        roomName: roomChannel.name,
        roomRecord,
        extra: `**المالك السابق:** <@${resolvedOwnerId}>
**المالك الجديد:** <@${newOwnerId}>`
      });
      return true;
    }

    const adding = action === 'temp_room_admin_add_select';
    for (const userId of interaction.values) {
      if (adding) {
        if (userId !== resolvedOwnerId && !profile.managers.includes(userId)) profile.managers.push(userId);
      } else {
        profile.managers = profile.managers.filter(id => id !== userId);
      }
      profile.managerHistory = pushLimitedHistory(profile.managerHistory, { action: adding ? 'add' : 'remove', userId, by: interaction.user.id, at: Date.now() });
    }

    scheduleSave();
    await applyRoomState(roomChannel, resolvedOwnerId);
    await replyEphemeral(interaction, `✅ تم ${adding ? 'إضافة' : 'إزالة'} المسؤولين المحددين.`);
    await logTempRoomState(interaction.guild, {
      title: adding ? '🛡️ **إضافة مسؤولين للروم**' : '🧩 **إزالة مسؤولين من الروم**',
      description: adding ? '**تمت إضافة مسؤولين جدد للروم المؤقت.**' : '**تمت إزالة مسؤولين من الروم المؤقت.**',
      actorId: interaction.user.id,
      ownerId: resolvedOwnerId,
      roomId: roomChannel.id,
      roomName: roomChannel.name,
      roomRecord,
      extra: interaction.values.map(id => `<@${id}>`).join('، ')
    });
    return true;
  }

  return true;
}

async function handleActionTargetSelect(interaction) {
  const parts = String(interaction.customId).split(':');
  const ownerId = parts[1];
  const actionType = parts[2];
  const access = await resolveManagedRoom(interaction, ownerId);
  if (!access) return true;
  const { ownerId: resolvedOwnerId, profile, roomChannel } = access;
  const targetId = interaction.values[0];
  const member = await interaction.guild.members.fetch(targetId).catch(() => null);
  if (!member) {
    await replyEphemeral(interaction, '❌ العضو غير موجود.');
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
  if (actionType === 'kick' && member.voice.channelId === roomChannel.id) {
    await member.voice.disconnect('Kicked from temp room').catch(() => member.voice.setChannel(null).catch(() => null));
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

  profile.moderationHistory = pushLimitedHistory(profile.moderationHistory, { action: actionType, userId: targetId, by: interaction.user.id, at: Date.now() });
  scheduleSave();
  await applyRoomState(roomChannel, resolvedOwnerId);
  await replyEphemeral(interaction, `✅ تم تنفيذ الإجراء ${actionType} على <@${targetId}>.`);
  await logTempRoomState(interaction.guild, {
    title: '⚖️ **إجراء إداري داخل الروم**',
    description: '**تم تنفيذ إجراء إداري على أحد أعضاء الروم المؤقت.**',
    actorId: interaction.user.id,
    ownerId: resolvedOwnerId,
    roomId: roomChannel.id,
    roomName: roomChannel.name,
    roomRecord: access.roomRecord,
    extra: `**الإجراء:** **${actionType}**
**الهدف:** <@${targetId}>`
  });
  return true;
}

async function handleRoomModal(interaction) {
  const { action, args } = parseCustomId(interaction.customId);
  const ownerId = args[0] || null;
  const access = await resolveManagedRoom(interaction, ownerId);
  if (!access) return true;
  const { profile, roomChannel } = access;

  if (action === 'temp_room_rename_modal') {
    const value = sanitizeRoomName(interaction.fields.getTextInputValue('value'), roomChannel.name);
    if (value === roomChannel.name) {
      await replyEphemeral(interaction, 'ℹ️ الاسم الجديد مطابق للاسم الحالي.');
      return true;
    }
    profile.roomNameTemplate = value;
    scheduleSave();
    await roomChannel.setName(value).catch(() => null);
    await replyEphemeral(interaction, `✅ تم تغيير اسم الروم إلى ${value}.`);
    await logTempRoomState(interaction.guild, {
      title: '✏️ **تغيير اسم روم مؤقت**',
      description: '**تم تعديل اسم الروم المؤقت.**',
      actorId: interaction.user.id,
      ownerId,
      roomId: roomChannel.id,
      roomName: value,
      roomRecord: access.roomRecord,
      extra: `**الاسم الجديد:** **${value}**`
    });
    return true;
  }

  if (action === 'temp_room_limit_modal') {
    const limit = Number(interaction.fields.getTextInputValue('value'));
    if (!Number.isFinite(limit) || limit < 0 || limit > 99) {
      await replyEphemeral(interaction, '❌ الحد يجب أن يكون بين 0 و 99.');
      return true;
    }
    if ((roomChannel.userLimit || 0) === limit) {
      await replyEphemeral(interaction, 'ℹ️ الحد الحالي مطابق للقيمة المدخلة.');
      return true;
    }
    profile.userLimit = limit;
    scheduleSave();
    await roomChannel.setUserLimit(limit).catch(() => null);
    await replyEphemeral(interaction, `✅ تم تحديث الحد إلى ${limit}.`);
    await logTempRoomState(interaction.guild, {
      title: '👥 **تحديث حد الروم**',
      description: '**تم تعديل الحد الأقصى لأعضاء الروم المؤقت.**',
      actorId: interaction.user.id,
      ownerId,
      roomId: roomChannel.id,
      roomName: roomChannel.name,
      roomRecord: access.roomRecord,
      extra: `**الحد الجديد:** **${limit}**`
    });
    return true;
  }

  return true;
}

function registerInteractionHandler(client) {
  if (registered) return;
  registered = true;
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

  if (!heartbeatHandle) {
    heartbeatHandle = setInterval(() => {
      heartbeat().catch(error => console.error('[temp] heartbeat error:', error));
    }, HEARTBEAT_MS);
  }

  setTimeout(async () => {
    await heartbeat().catch(() => null);
    for (const [guildId, rooms] of Object.entries(getRoomStore ? loadData().rooms : {})) {
      for (const ownerId of Object.keys(rooms || {})) {
        await scheduleRoomLifecycleJob(guildId, ownerId).catch(() => null);
      }
    }
  }, 7000);
}

module.exports = {
  name,
  aliases,
  execute,
  registerInteractionHandler,
  handleVoiceStateUpdate
};
