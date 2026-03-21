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
const CONTROL_CARD_SIGNATURE = 'By Ahmed';
const SESSION_TTL_MS = 12 * 60 * 1000;
const HEARTBEAT_MS = 45000;
const INVITE_TTL_MS = 60 * 60 * 1000;
const DATA_VERSION = 3;

const SETTING_CONTROL_KEYS = [
  'open', 'lock', 'show', 'hide', 'invite',
  'rename', 'limit', 'region', 'allow', 'reject',
  'music', 'admin', 'transfer', 'actions'
];

const CONTROL_LAYOUT_ORDER = [
  'open', 'lock', 'show', 'hide',
  'rename', 'limit', 'allow', 'reject',
  'region', 'invite', 'admin', 'music',
  'transfer'
];

const LATIN_FONT_FAMILY = '"Segoe UI", "Arial", sans-serif';
const ARABIC_FONT_FAMILY = '"Cairo", "Tajawal", "Noto Sans Arabic", "Segoe UI", "Arial", sans-serif';

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
  { label: 'Mute Member', value: 'mute_member', description: 'إعطاء ميوت صوتي أو كتابي أو الاثنين' },
  { label: 'Unmute', value: 'unmute_member', description: 'إزالة الميوت عن عضو محدد' },
  { label: 'Mute All', value: 'mute_all', description: 'إعطاء ميوت لكل الموجودين حالياً في الروم' },
  { label: 'Unmute All', value: 'unmute_all', description: 'إزالة الميوت من كل الأعضاء' },
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
    if (!guildConfig.controlStatus) guildConfig.controlStatus = CONTROL_CARD_SIGNATURE;
    if (!('controlMessageId' in guildConfig)) guildConfig.controlMessageId = null;
    if (!('logChannelId' in guildConfig)) guildConfig.logChannelId = null;
    if (!('musicChannelId' in guildConfig)) guildConfig.musicChannelId = null;
    if (!('controlCardColorMode' in guildConfig)) guildConfig.controlCardColorMode = 'avatar';
    if (!('controlCardCustomColor' in guildConfig)) guildConfig.controlCardCustomColor = null;
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
    if (!profile.allowedEntries || typeof profile.allowedEntries !== 'object') profile.allowedEntries = {};
    if (!profile.managerEntries || typeof profile.managerEntries !== 'object') profile.managerEntries = {};
    if (!profile.voiceMutedEntries || typeof profile.voiceMutedEntries !== 'object') profile.voiceMutedEntries = {};
    if (!profile.textMutedEntries || typeof profile.textMutedEntries !== 'object') profile.textMutedEntries = {};
    if (!profile.bannedEntries || typeof profile.bannedEntries !== 'object') profile.bannedEntries = {};
    if (!profile.pendingInvites || typeof profile.pendingInvites !== 'object') profile.pendingInvites = {};
    if (!Array.isArray(profile.roomNameRotationNames)) profile.roomNameRotationNames = [];
    if (!Number.isFinite(profile.roomNameRotationIntervalMs)) profile.roomNameRotationIntervalMs = 0;
    if (!Number.isFinite(profile.roomNameRotationIndex)) profile.roomNameRotationIndex = 0;
    if (!Number.isFinite(profile.roomNameRotationNextAt)) profile.roomNameRotationNextAt = 0;
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
      musicChannelId: null,
      controlCardColorMode: 'avatar',
      controlCardCustomColor: null,
      controlStatus: CONTROL_CARD_SIGNATURE,
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
    data.guilds[guildId].controlStatus = CONTROL_CARD_SIGNATURE;
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
      ownershipHistory: [],
      allowedEntries: {},
      managerEntries: {},
      voiceMutedEntries: {},
      textMutedEntries: {},
      bannedEntries: {},
      pendingInvites: {},
      roomNameRotationNames: [],
      roomNameRotationIntervalMs: 0,
      roomNameRotationIndex: 0,
      roomNameRotationNextAt: 0
    };
    scheduleSave();
  }
  if (!data.users[key].allowedEntries || typeof data.users[key].allowedEntries !== 'object') data.users[key].allowedEntries = {};
  if (!data.users[key].managerEntries || typeof data.users[key].managerEntries !== 'object') data.users[key].managerEntries = {};
  if (!data.users[key].voiceMutedEntries || typeof data.users[key].voiceMutedEntries !== 'object') data.users[key].voiceMutedEntries = {};
  if (!data.users[key].textMutedEntries || typeof data.users[key].textMutedEntries !== 'object') data.users[key].textMutedEntries = {};
  if (!data.users[key].bannedEntries || typeof data.users[key].bannedEntries !== 'object') data.users[key].bannedEntries = {};
  if (!data.users[key].pendingInvites || typeof data.users[key].pendingInvites !== 'object') data.users[key].pendingInvites = {};
  if (!Array.isArray(data.users[key].roomNameRotationNames)) data.users[key].roomNameRotationNames = [];
  if (!Number.isFinite(data.users[key].roomNameRotationIntervalMs)) data.users[key].roomNameRotationIntervalMs = 0;
  if (!Number.isFinite(data.users[key].roomNameRotationIndex)) data.users[key].roomNameRotationIndex = 0;
  if (!Number.isFinite(data.users[key].roomNameRotationNextAt)) data.users[key].roomNameRotationNextAt = 0;
  return data.users[key];
}

function resetUserProfileState(profile) {
  profile.roomNameTemplate = null;
  profile.allowedUsers = [];
  profile.allowedEntries = {};
  profile.pendingInvites = {};
  profile.bannedUsers = [];
  profile.bannedEntries = {};
  profile.managers = [];
  profile.managerEntries = {};
  profile.locked = false;
  profile.hidden = false;
  profile.userLimit = 0;
  profile.rtcRegion = null;
  profile.voiceMutedUsers = [];
  profile.textMutedUsers = [];
  profile.voiceMutedEntries = {};
  profile.textMutedEntries = {};
  profile.roomNameRotationNames = [];
  profile.roomNameRotationIntervalMs = 0;
  profile.roomNameRotationIndex = 0;
  profile.roomNameRotationNextAt = 0;
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

function parseCommaSeparatedNames(input) {
  return String(input || '')
    .split(',')
    .map(entry => sanitizeRoomName(entry, ''))
    .filter(Boolean)
    .slice(0, 10);
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

function setTimedAccessEntry(collection, userId, value = {}) {
  collection[userId] = {
    grantedAt: value.grantedAt || Date.now(),
    grantedBy: value.grantedBy || null,
    expiresAt: value.expiresAt || null,
    source: value.source || 'manual'
  };
}

function setTimedModerationEntry(collection, userId, value = {}) {
  collection[userId] = {
    at: value.at || Date.now(),
    by: value.by || null,
    expiresAt: value.expiresAt || null
  };
}

function setTimedBanEntry(profile, userId, value = {}) {
  if (!profile.bannedUsers.includes(userId)) profile.bannedUsers.push(userId);
  setTimedModerationEntry(profile.bannedEntries, userId, value);
}

function removeTimedAccessEntry(profile, type, userId) {
  if (type === 'allow') {
    profile.allowedUsers = profile.allowedUsers.filter(id => id !== userId);
    if (profile.allowedEntries) delete profile.allowedEntries[userId];
  }
  if (type === 'admin') {
    profile.managers = profile.managers.filter(id => id !== userId);
    if (profile.managerEntries) delete profile.managerEntries[userId];
  }
}

function applyMuteScopeToProfile(profile, userId, scope, expiresAt = null, actorId = null) {
  if (scope === 'voice' || scope === 'all') {
    if (!profile.voiceMutedUsers.includes(userId)) profile.voiceMutedUsers.push(userId);
    setTimedModerationEntry(profile.voiceMutedEntries, userId, { by: actorId, expiresAt });
  }
  if (scope === 'text' || scope === 'all') {
    if (!profile.textMutedUsers.includes(userId)) profile.textMutedUsers.push(userId);
    setTimedModerationEntry(profile.textMutedEntries, userId, { by: actorId, expiresAt });
  }
}

function removeMuteScopeFromProfile(profile, userId, scope) {
  if (scope === 'voice' || scope === 'all') {
    profile.voiceMutedUsers = profile.voiceMutedUsers.filter(id => id !== userId);
    if (profile.voiceMutedEntries) delete profile.voiceMutedEntries[userId];
  }
  if (scope === 'text' || scope === 'all') {
    profile.textMutedUsers = profile.textMutedUsers.filter(id => id !== userId);
    if (profile.textMutedEntries) delete profile.textMutedEntries[userId];
  }
}

function removeBanFromProfile(profile, userId) {
  profile.bannedUsers = profile.bannedUsers.filter(id => id !== userId);
  if (profile.bannedEntries) delete profile.bannedEntries[userId];
}

function listMutedTargets(profile, scope) {
  const voice = new Set(profile.voiceMutedUsers || []);
  const text = new Set(profile.textMutedUsers || []);
  if (scope === 'voice') return [...voice];
  if (scope === 'text') return [...text];
  return [...new Set([...voice, ...text])];
}

function getBanSummary(profile, userId) {
  const hasBan = (profile.bannedUsers || []).includes(userId);
  if (!hasBan) return { active: false, remaining: null, expiresAt: null };
  const entry = profile.bannedEntries?.[userId] || null;
  return {
    active: true,
    remaining: describePenaltyRemaining(entry?.expiresAt),
    expiresAt: entry?.expiresAt || null
  };
}

function isProtectedModerationTarget(member, ownerId, profile) {
  if (!member) return false;
  return Boolean(
    member.id === ownerId ||
    member.user?.bot ||
    member.permissions?.has?.(PermissionsBitField.Flags.Administrator) ||
    profile.managers.includes(member.id)
  );
}

function validateModerationTarget({ member, user, ownerId, profile, actionType, actorId }) {
  const targetId = member?.id || user?.id || null;
  if (!targetId) return { ok: false, message: '❌ تعذر تحديد العضو المطلوب.' };
  if (targetId === ownerId) return { ok: false, message: '❌ لا يمكن استهداف مالك الروم من هذا المسار.' };
  if (member?.user?.bot || user?.bot) return { ok: false, message: `❌ لا يمكن ${actionType} بوت من هذا المسار.` };
  if (member?.permissions?.has?.(PermissionsBitField.Flags.Administrator)) {
    return { ok: false, message: `❌ لا يمكن ${actionType} إداري السيرفر من هذا المسار.` };
  }
  if (profile.managers.includes(targetId) && actorId !== ownerId) {
    return { ok: false, message: `❌ لا يمكن ${actionType} مسؤول الروم إلا بواسطة المالك مباشرة.` };
  }
  return { ok: true };
}

async function disconnectMemberFromVoice(member, reason) {
  if (!member?.voice?.channelId) return true;
  const guild = member.guild;
  const memberId = member.id;
  await member.voice.disconnect(reason).catch(() => member.voice.setChannel(null).catch(() => null));
  const refreshed = await guild.members.fetch(memberId).catch(() => member);
  return !refreshed?.voice?.channelId;
}

async function moveMemberToRoom(member, roomChannel) {
  if (!member?.voice?.channelId || !roomChannel) return false;
  const guild = member.guild;
  const memberId = member.id;
  await member.voice.setChannel(roomChannel).catch(() => null);
  const refreshed = await guild.members.fetch(memberId).catch(() => member);
  return refreshed?.voice?.channelId === roomChannel.id;
}

function isRoomAccessRestricted(profile) {
  return Boolean(profile.locked || profile.hidden);
}

function canMemberBypassTempRestrictions(member, ownerId, profile) {
  return Boolean(
    member && (
      member.id === ownerId ||
      profile.allowedUsers.includes(member.id) ||
      profile.managers.includes(member.id) ||
      member.permissions.has(PermissionsBitField.Flags.Administrator)
    )
  );
}

function getScopeLabel(scope) {
  return scope === 'voice' ? 'صوتي' : scope === 'text' ? 'كتابي' : 'الكل';
}

function getRoomMemberPriority(member, ownerId, profile) {
  if (!member) return 99;
  if (member.id === ownerId) return 0;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return 1;
  if (profile.managers.includes(member.id)) return 2;
  if (profile.allowedUsers.includes(member.id)) return 3;
  return 4;
}

function getModeratableRoomMembers(roomChannel, ownerId, profile) {
  return roomChannel.members
    .filter(member => !isProtectedModerationTarget(member, ownerId, profile))
    .sort((a, b) => getRoomMemberPriority(a, ownerId, profile) - getRoomMemberPriority(b, ownerId, profile));
}

function normalizeStatusText(text) {
  const normalized = String(text || CONTROL_CARD_SIGNATURE).trim().replace(/\s+/g, ' ');
  return normalized.slice(0, 140) || CONTROL_CARD_SIGNATURE;
}

function getTempButtonStyle(key = null) {
  return key === 'transfer' ? ButtonStyle.Danger : ButtonStyle.Secondary;
}

function buildScopeButtons(baseAction, ownerId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${baseAction}:${ownerId}:voice`).setLabel('صوتي').setStyle(getTempButtonStyle()),
      new ButtonBuilder().setCustomId(`${baseAction}:${ownerId}:text`).setLabel('كتابي').setStyle(getTempButtonStyle()),
      new ButtonBuilder().setCustomId(`${baseAction}:${ownerId}:all`).setLabel('الكل').setStyle(getTempButtonStyle())
    )
  ];
}

function describePenaltyRemaining(expiresAt) {
  if (!expiresAt) return 'دائمة';
  const remaining = expiresAt - Date.now();
  return remaining > 0 ? formatDuration(remaining) : 'منتهية';
}

function getMutePenaltySummary(profile, userId, scope) {
  const voiceEntry = profile.voiceMutedEntries?.[userId] || null;
  const textEntry = profile.textMutedEntries?.[userId] || null;
  const hasVoice = (profile.voiceMutedUsers || []).includes(userId);
  const hasText = (profile.textMutedUsers || []).includes(userId);

  if (scope === 'voice' && hasVoice) {
    return { active: true, label: 'ميوت صوتي', remaining: describePenaltyRemaining(voiceEntry?.expiresAt), parts: [`صوتي: ${describePenaltyRemaining(voiceEntry?.expiresAt)}`] };
  }
  if (scope === 'text' && hasText) {
    return { active: true, label: 'ميوت كتابي', remaining: describePenaltyRemaining(textEntry?.expiresAt), parts: [`كتابي: ${describePenaltyRemaining(textEntry?.expiresAt)}`] };
  }

  const parts = [];
  if (hasVoice) parts.push(`صوتي: ${describePenaltyRemaining(voiceEntry?.expiresAt)}`);
  if (hasText) parts.push(`كتابي: ${describePenaltyRemaining(textEntry?.expiresAt)}`);
  if (!parts.length) return { active: false, label: null, remaining: null, parts: [] };
  return {
    active: true,
    label: scope === 'all' && hasVoice && hasText ? 'ميوت كامل' : 'ميوت قائم',
    remaining: parts.join(' • '),
    parts
  };
}

function buildPenaltyStatusLines(guild, profile, userIds, scope) {
  return (userIds || []).map(userId => {
    const summary = getMutePenaltySummary(profile, userId, scope);
    if (!summary.active) return null;
    const details = summary.parts.map(part => `- ${part}`).join('\n  ');
    return `• <@${userId}> — **${getDisplayNameFromGuild(guild, userId)}**\n  ${details}`;
  }).filter(Boolean);
}

function buildMuteMemberDurationModal(ownerId, scope) {
  const modal = new ModalBuilder().setCustomId(`temp_room_action_mute_member_modal:${ownerId}:${scope}`).setTitle('Mute Member');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('duration')
      .setLabel('Duration: off or 30m / 2h / 7d')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setValue('off')
  ));
  return modal;
}

function buildMuteAllDurationModal(ownerId, scope) {
  const modal = new ModalBuilder().setCustomId(`temp_room_action_mute_all_modal:${ownerId}:${scope}`).setTitle('Mute All');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('duration')
      .setLabel('Duration: off or 30m / 2h / 7d')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setValue('off')
  ));
  return modal;
}

function buildBanDurationModal(ownerId) {
  const modal = new ModalBuilder().setCustomId(`temp_room_action_ban_modal:${ownerId}`).setTitle('Ban Member');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('duration')
      .setLabel('Duration: off or 30m / 2h / 7d')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setValue('off')
  ));
  return modal;
}

function getOrCreateOverwrite(map, userId) {
  const key = String(userId);
  if (!map.has(key)) map.set(key, { id: userId, allow: new Set(), deny: new Set() });
  return map.get(key);
}

function addOverwriteAllows(map, userId, permissions = []) {
  const overwrite = getOrCreateOverwrite(map, userId);
  permissions.filter(Boolean).forEach(permission => {
    overwrite.deny.delete(permission);
    overwrite.allow.add(permission);
  });
}

function addOverwriteDenies(map, userId, permissions = []) {
  const overwrite = getOrCreateOverwrite(map, userId);
  permissions.filter(Boolean).forEach(permission => {
    overwrite.allow.delete(permission);
    overwrite.deny.add(permission);
  });
}

function finalizeOverwrites(map) {
  return [...map.values()].map(entry => ({
    id: entry.id,
    allow: [...entry.allow],
    deny: [...entry.deny]
  }));
}

async function cleanupInviteRecord(guild, ownerId, profile, userId, { removeAccess = true, deleteMessage = true } = {}) {
  const inviteRecord = getActiveInvite(profile, userId);
  if (!inviteRecord) return false;
  const user = await guild.client.users.fetch(userId).catch(() => null);
  if (deleteMessage) await deleteTrackedDmMessage(user, inviteRecord);
  if (removeAccess && inviteRecord.temporaryAccessGranted) {
    if (inviteRecord.hadAllowAlready && inviteRecord.previousAllowEntry) {
      setTimedAccessEntry(profile.allowedEntries, userId, inviteRecord.previousAllowEntry);
      if (!profile.allowedUsers.includes(userId)) profile.allowedUsers.push(userId);
    } else {
      removeTimedAccessEntry(profile, 'allow', userId);
    }
  }
  delete profile.pendingInvites[userId];
  return true;
}

function getActiveInvite(profile, userId) {
  if (!profile.pendingInvites || !profile.pendingInvites[userId]) return null;
  return profile.pendingInvites[userId];
}

function getRoomDisplayBaseName(profile, member) {
  if (Array.isArray(profile.roomNameRotationNames) && profile.roomNameRotationNames.length) {
    const index = Math.max(0, Math.min(profile.roomNameRotationNames.length - 1, profile.roomNameRotationIndex || 0));
    return sanitizeRoomName(profile.roomNameRotationNames[index], member?.displayName || member?.user?.username || 'Temp Room');
  }
  return sanitizeRoomName(profile.roomNameTemplate || member?.displayName || member?.user?.username, `${member?.displayName || member?.user?.username || 'Temp'} room`);
}

function getRoomOccupancyCount(roomChannel) {
  if (!roomChannel?.members) return 0;
  return roomChannel.members.filter(member => !member.user.bot).size;
}

async function deleteTrackedDmMessage(user, record) {
  if (!user || !record?.dmMessageId) return;
  const channel = record.dmChannelId
    ? user.client.channels?.cache?.get(record.dmChannelId) || await user.client.channels?.fetch?.(record.dmChannelId).catch(() => null)
    : await user.createDM().catch(() => null);
  if (!channel?.messages?.fetch) return;
  const message = await channel.messages.fetch(record.dmMessageId).catch(() => null);
  if (message) await message.delete().catch(() => null);
}

async function notifyUser(user, payload) {
  if (!user) return null;
  const dm = await user.createDM().catch(() => null);
  if (!dm) return null;
  return dm.send(payload).catch(() => null);
}

function describeTimedAccess(expiresAt) {
  return expiresAt ? `حتى ${formatDiscordTimestamp(expiresAt)}` : '**بشكل دائم**';
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

function clampColorChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map(channel => clampColorChannel(channel).toString(16).padStart(2, '0')).join('')}`;
}

function parseCssColor(color) {
  if (!color) return null;
  const sample = createCanvas(1, 1);
  const ctx = sample.getContext('2d');
  try {
    ctx.fillStyle = '#000000';
    ctx.fillStyle = String(color).trim();
    const normalized = ctx.fillStyle;
    if (typeof normalized !== 'string') return null;
    if (normalized.startsWith('#')) {
      const hex = normalized.length === 4
        ? `#${normalized.slice(1).split('').map(ch => ch + ch).join('')}`
        : normalized;
      if (hex.length === 7) {
        return {
          r: parseInt(hex.slice(1, 3), 16),
          g: parseInt(hex.slice(3, 5), 16),
          b: parseInt(hex.slice(5, 7), 16)
        };
      }
    }
    const match = normalized.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (match) {
      return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeControlCardColorInput(color) {
  const parsed = parseCssColor(color);
  return parsed ? rgbToHex(parsed) : null;
}

function mixHexColors(primary, secondary, ratio = 0.5) {
  const first = parseCssColor(primary);
  const second = parseCssColor(secondary);
  if (!first && !second) return '#5865F2';
  if (!first) return rgbToHex(second);
  if (!second) return rgbToHex(first);
  const weight = Math.max(0, Math.min(1, ratio));
  return rgbToHex({
    r: first.r + ((second.r - first.r) * weight),
    g: first.g + ((second.g - first.g) * weight),
    b: first.b + ((second.b - first.b) * weight)
  });
}

function toRgba(color, alpha = 1) {
  const parsed = parseCssColor(color) || { r: 88, g: 101, b: 242 };
  const opacity = Math.max(0, Math.min(1, alpha));
  return `rgba(${clampColorChannel(parsed.r)}, ${clampColorChannel(parsed.g)}, ${clampColorChannel(parsed.b)}, ${opacity})`;
}

async function resolveControlCardAccent(guild) {
  const config = guild ? getGuildConfig(guild.id) : null;
  if (config?.controlCardColorMode === 'custom') {
    const custom = normalizeControlCardColorInput(config.controlCardCustomColor);
    if (custom) return custom;
  }
  return getGuildAccent(guild);
}

function getControlCardColorSummary(config) {
  if (!config) return '**Avatar**';
  if (config.controlCardColorMode === 'custom' && config.controlCardCustomColor) {
    return `**Custom** — \`${config.controlCardCustomColor}\``;
  }
  return '**Avatar** — **يتم استخراج اللون من صورة السيرفر**';
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
  const musicRoom = config.musicChannelId ? guild.channels.cache.get(config.musicChannelId) : null;

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
      `**Music Bot Room:** ${musicRoom ? `<#${musicRoom.id}>` : '**غير محدد**'}`,
      `**Controller Card Color:** ${getControlCardColorSummary(config)}`,
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
      new ButtonBuilder().setCustomId(`temp_settings_category:${userId}`).setLabel('Category').setStyle(getTempButtonStyle()),
      new ButtonBuilder().setCustomId(`temp_settings_name:${userId}`).setLabel('Creator Name').setStyle(getTempButtonStyle()),
      new ButtonBuilder().setCustomId(`temp_settings_control:${userId}`).setLabel('Control Room').setStyle(getTempButtonStyle()),
      new ButtonBuilder().setCustomId(`temp_settings_log:${userId}`).setLabel('Log Room').setStyle(getTempButtonStyle()),
      new ButtonBuilder().setCustomId(`temp_settings_music:${userId}`).setLabel('Music Room').setStyle(getTempButtonStyle())
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`temp_settings_card_color:${userId}`).setLabel('Card Color').setStyle(getTempButtonStyle()),
      new ButtonBuilder().setCustomId(`temp_settings_autoclean:${userId}`).setLabel('Auto Clean').setStyle(getTempButtonStyle()),
      new ButtonBuilder().setCustomId(`temp_settings_lifetime:${userId}`).setLabel('Lifetime').setStyle(getTempButtonStyle()),
      new ButtonBuilder().setCustomId(`temp_settings_leave:${userId}`).setLabel('Leave Delete').setStyle(getTempButtonStyle())
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`temp_settings_controls:${userId}`).setLabel('Controls').setStyle(getTempButtonStyle()),
      new ButtonBuilder().setCustomId(`temp_settings_refresh:${userId}`).setLabel('Refresh').setStyle(getTempButtonStyle()),
      new ButtonBuilder().setCustomId(`temp_settings_close:${userId}`).setLabel('Close').setStyle(getTempButtonStyle())
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

function wrapText(ctx, text, maxWidth, maxLines = 2) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
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

  return lines;
}

function fitWrappedTextSize(ctx, text, maxWidth, maxHeight, startSize, minSize, fontFamily, weight = '600', lineHeightRatio = 1.3, maxLines = 3) {
  let size = startSize;
  while (size > minSize) {
    ctx.font = `${weight} ${size}px ${fontFamily}`;
    const lines = wrapText(ctx, text, maxWidth, maxLines);
    const lineHeight = Math.round(size * lineHeightRatio);
    if (lines.length && (lines.length * lineHeight) <= maxHeight) {
      return { size, lines, lineHeight };
    }
    size -= 1;
  }

  ctx.font = `${weight} ${minSize}px ${fontFamily}`;
  return {
    size: minSize,
    lines: wrapText(ctx, text, maxWidth, maxLines),
    lineHeight: Math.round(minSize * lineHeightRatio)
  };
}

function drawCenteredTextBlock(ctx, lines, centerX, centerY, lineHeight) {
  const totalHeight = Math.max(lineHeight, lines.length * lineHeight);
  const startY = centerY - (totalHeight / 2) + (lineHeight / 2);
  lines.forEach((line, index) => ctx.fillText(line, centerX, startY + index * lineHeight));
}

function fitTextSize(ctx, text, maxWidth, startSize, minSize, fontFamily, weight = 'bold') {
  let size = startSize;
  while (size > minSize) {
    ctx.font = `${weight} ${size}px ${fontFamily}`;
    if (ctx.measureText(String(text || '')).width <= maxWidth) return size;
    size -= 1;
  }
  return minSize;
}


async function buildGeneralControlCard(guild) {
  const config = getGuildConfig(guild.id);
  const width = 1600;
  const height = 1040;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const accent = await resolveControlCardAccent(guild);
  const accentSoft = mixHexColors(accent, '#ffffff', 0.24);
  const accentDeep = mixHexColors(accent, '#08101f', 0.7);
  const accentGlow = mixHexColors(accent, '#dfe8ff', 0.32);
  const accentPanel = mixHexColors(accent, '#111a2d', 0.48);
  const accentGlass = mixHexColors(accent, '#f7fbff', 0.42);

  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, '#060918');
  background.addColorStop(0.36, '#0c1628');
  background.addColorStop(0.78, accentDeep);
  background.addColorStop(1, '#080c17');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(width * 0.76, height * 0.16, 80, width * 0.76, height * 0.16, 520);
  glow.addColorStop(0, toRgba(accentGlow, 0.24));
  glow.addColorStop(0.32, toRgba(accent, 0.1));
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  const edgeGlowLeft = ctx.createRadialGradient(120, height - 120, 40, 120, height - 120, 260);
  edgeGlowLeft.addColorStop(0, toRgba(accentSoft, 0.18));
  edgeGlowLeft.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = edgeGlowLeft;
  ctx.fillRect(0, 0, width, height);

  const edgeGlowRight = ctx.createRadialGradient(width - 140, 120, 30, width - 140, 120, 240);
  edgeGlowRight.addColorStop(0, toRgba(accentSoft, 0.16));
  edgeGlowRight.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = edgeGlowRight;
  ctx.fillRect(0, 0, width, height);

  const panelAccentGlow = ctx.createLinearGradient(74, 308, width - 74, height - 84);
  panelAccentGlow.addColorStop(0, toRgba(accentPanel, 0.06));
  panelAccentGlow.addColorStop(0.5, toRgba(accentGlow, 0.1));
  panelAccentGlow.addColorStop(1, toRgba(accentPanel, 0.05));
  ctx.fillStyle = panelAccentGlow;
  ctx.fillRect(80, 312, width - 160, height - 400);

  const glassSheen = ctx.createLinearGradient(120, 80, width - 120, height - 120);
  glassSheen.addColorStop(0, 'rgba(255,255,255,0.075)');
  glassSheen.addColorStop(0.22, toRgba(accentGlass, 0.03));
  glassSheen.addColorStop(0.58, 'rgba(255,255,255,0.012)');
  glassSheen.addColorStop(1, 'rgba(255,255,255,0)');

  drawRoundedRect(ctx, 34, 34, width - 68, height - 68, 40, 'rgba(7,11,24,0.5)', { color: toRgba(accent, 0.12), blur: 54, x: 0, y: 18 }, 'rgba(255,255,255,0.07)');
  drawRoundedRect(ctx, 40, 40, width - 80, height - 80, 36, glassSheen, null, null);
  drawRoundedRect(ctx, 58, 58, width - 116, 220, 34, 'rgba(255,255,255,0.062)', { color: toRgba(accentSoft, 0.12), blur: 18, x: 0, y: -4 }, 'rgba(255,255,255,0.11)');
  drawRoundedRect(ctx, 74, 308, width - 148, height - 392, 32, 'rgba(255,255,255,0.03)', { color: toRgba(accent, 0.1), blur: 28, x: 0, y: 12 }, 'rgba(255,255,255,0.078)');

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0,0,0,0.26)';
  ctx.shadowBlur = 12;
  ctx.font = `bold 72px ${LATIN_FONT_FAMILY}`;
  ctx.fillText('Temp Voice Control', width / 2, 168);
  ctx.shadowBlur = 0;

  const layoutRows = [
    ['open', 'lock', 'show', 'hide'],
    ['rename', 'limit', 'allow', 'reject'],
    ['region', 'invite', 'admin', 'music', 'transfer']
  ];
  const visibleKeys = layoutRows.flat();
  const panelX = 74;
  const panelY = 308;
  const panelWidth = width - 148;
  const panelHeight = height - 392;
  const contentPaddingX = 34;
  const contentTop = 360;
  const gapX = 22;
  const gapY = 24;
  const boxHeight = 126;
  const maxColumns = 5;
  const availableWidth = panelWidth - (contentPaddingX * 2);
  const boxWidth = Math.floor((availableWidth - ((maxColumns - 1) * gapX)) / maxColumns);
  const englishInset = 14;
  const englishPanelWidth = 96;
  const englishPanelX = boxWidth - englishPanelWidth - englishInset;
  const textStartX = 18;
  const textMaxWidth = englishPanelX - textStartX - 14;

  let uniformEnglishSize = 34;
  while (uniformEnglishSize > 16) {
    ctx.font = `bold ${uniformEnglishSize}px ${LATIN_FONT_FAMILY}`;
    const widestWidth = Math.max(...visibleKeys.map(key => ctx.measureText(CONTROL_META[key].label).width), 0);
    if (widestWidth <= (englishPanelWidth - 18)) break;
    uniformEnglishSize -= 1;
  }
  if (uniformEnglishSize <= 16) uniformEnglishSize = 16;

  layoutRows.forEach((rowKeys, rowIndex) => {
    const totalWidth = rowKeys.length * boxWidth + (rowKeys.length - 1) * gapX;
    const startX = Math.round((width - totalWidth) / 2);

    rowKeys.forEach((key, colIndex) => {
      const x = startX + colIndex * (boxWidth + gapX);
      const y = contentTop + rowIndex * (boxHeight + gapY);

      drawRoundedRect(ctx, x, y, boxWidth, boxHeight, 28, 'rgba(255,255,255,0.065)', { color: 'rgba(0,0,0,0.18)', blur: 18, x: 0, y: 12 }, 'rgba(255,255,255,0.1)');
      drawRoundedRect(ctx, x + englishPanelX, y + 14, englishPanelWidth, boxHeight - 28, 22, 'rgba(255,255,255,0.13)', { color: toRgba(accentSoft, 0.08), blur: 9, x: 0, y: -2 }, 'rgba(255,255,255,0.15)');

      const buttonGlow = ctx.createLinearGradient(x + englishPanelX, y + 14, x + englishPanelX + englishPanelWidth, y + boxHeight - 14);
      buttonGlow.addColorStop(0, toRgba(accentGlow, 0.18));
      buttonGlow.addColorStop(1, 'rgba(255,255,255,0.045)');
      drawRoundedRect(ctx, x + englishPanelX + 6, y + 20, englishPanelWidth - 12, boxHeight - 40, 18, buttonGlow, null, 'rgba(255,255,255,0.08)');

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0,0,0,0.26)';
      ctx.shadowBlur = 10;
      ctx.font = `bold ${uniformEnglishSize}px ${LATIN_FONT_FAMILY}`;
      ctx.fillText(CONTROL_META[key].label, x + englishPanelX + (englishPanelWidth / 2), y + (boxHeight / 2) + 1);

      ctx.shadowColor = 'rgba(0,0,0,0.16)';
      ctx.shadowBlur = 5;
      ctx.fillStyle = 'rgba(243,246,251,0.88)';
      const arabicText = fitWrappedTextSize(ctx, CONTROL_META[key].description, textMaxWidth, boxHeight - 34, 24, 16, ARABIC_FONT_FAMILY, '600', 1.16, 3);
      ctx.font = `600 ${arabicText.size}px ${ARABIC_FONT_FAMILY}`;
      drawCenteredTextBlock(ctx, arabicText.lines, x + textStartX + (textMaxWidth / 2), y + (boxHeight / 2), arabicText.lineHeight);
      ctx.shadowBlur = 0;
    });
  });

  const roomCount = Object.keys(getRoomStore(guild.id)).length;
  const statusText = normalizeStatusText(config.controlStatus);
  const footerLineY = panelY + panelHeight - 78;
  const footerPadding = 66;
  const footerBlockWidth = 420;
  const leftFooterX = panelX + footerPadding;
  const rightFooterRightX = panelX + panelWidth - footerPadding;
  const footerLabelFont = `600 27px ${LATIN_FONT_FAMILY}`;
  const footerValueFont = `700 30px ${LATIN_FONT_FAMILY}`;

  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.18)';
  ctx.shadowBlur = 6;

  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.font = footerLabelFont;
  ctx.fillText('All rooms :', leftFooterX, footerLineY);
  const allRoomsLabelWidth = ctx.measureText('All rooms :').width;
  ctx.fillStyle = '#ffffff';
  ctx.font = footerValueFont;
  ctx.fillText(String(roomCount), leftFooterX + allRoomsLabelWidth + 16, footerLineY);

  const serverName = guild.name || 'Unknown Server';
  const serverNameSize = fitTextSize(ctx, serverName, footerBlockWidth, 30, 18, LATIN_FONT_FAMILY, '700');
  ctx.font = `700 ${serverNameSize}px ${LATIN_FONT_FAMILY}`;
  const serverNameWidth = ctx.measureText(serverName).width;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  const serverNameX = rightFooterRightX - serverNameWidth;
  ctx.fillText(serverName, serverNameX, footerLineY);
  ctx.font = footerLabelFont;
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  const serverLabelWidth = ctx.measureText('Server :').width;
  ctx.fillText('Server :', serverNameX - serverLabelWidth - 16, footerLineY);

  drawRoundedRect(ctx, Math.round(width / 2) - 260, panelY + panelHeight - 126, 520, 56, 18, 'rgba(255,255,255,0.05)', null, 'rgba(255,255,255,0.07)');
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.86)';
  ctx.font = `600 24px ${ARABIC_FONT_FAMILY}`;
  ctx.fillText(statusText, width / 2, panelY + panelHeight - 98);

  ctx.fillStyle = 'rgba(255,255,255,0.52)';
  ctx.font = `600 19px ${LATIN_FONT_FAMILY}`;
  ctx.fillText(`Quick Actions Menu • ${CONTROL_CARD_SIGNATURE}`, width / 2, panelY + panelHeight - 30);

  ctx.shadowBlur = 0;
  return new AttachmentBuilder(canvas.toBuffer('image/png'), { name: `temp-general-control-${guild.id}.png` });
}

function buildGeneralControlRows(guildId) {
  const config = getGuildConfig(guildId);
  const enabled = key => config.enabledControls[key] !== false;
  const rows = [];

  const createButton = key => new ButtonBuilder()
    .setCustomId(`temp_room_${key}`)
    .setLabel(CONTROL_META[key].label)
    .setStyle(getTempButtonStyle(key));

  const rowDefinitions = [
    ['open', 'lock', 'show', 'hide'],
    ['rename', 'limit', 'allow', 'reject'],
    ['region', 'invite', 'admin', 'music', 'transfer']
  ];

  for (const keys of rowDefinitions) {
    const buttons = keys.filter(enabled).map(createButton);
    if (buttons.length) rows.push(new ActionRowBuilder().addComponents(buttons));
  }

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

function createGeneralControlMessageContent() {
  return '**Temp Voice Control**';
}

async function ensureGuildControlPanel(guild, statusText = null) {
  const config = getGuildConfig(guild.id);
  if (statusText) config.controlStatus = normalizeStatusText(statusText);
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

  const attachment = await buildGeneralControlCard(guild);
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
  const roomIsFull = profile.userLimit > 0 && getRoomOccupancyCount(roomChannel) >= profile.userLimit;
  const overwriteMap = new Map();

  addOverwriteAllows(overwriteMap, roomChannel.guild.roles.everyone.id, [
    profile.hidden ? null : PermissionsBitField.Flags.ViewChannel,
    profile.locked || roomIsFull ? null : PermissionsBitField.Flags.Connect
  ]);
  addOverwriteDenies(overwriteMap, roomChannel.guild.roles.everyone.id, [
    profile.hidden ? PermissionsBitField.Flags.ViewChannel : null,
    profile.locked || roomIsFull ? PermissionsBitField.Flags.Connect : null
  ]);

  addOverwriteAllows(overwriteMap, ownerId, [
    PermissionsBitField.Flags.CreateInstantInvite,
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.Connect,
    PermissionsBitField.Flags.Speak,
    PermissionsBitField.Flags.Stream,
    PermissionsBitField.Flags.UseSoundboard,
    PermissionsBitField.Flags.UseExternalSounds,
    PermissionsBitField.Flags.UseVAD,
    PermissionsBitField.Flags.UseEmbeddedActivities,
    PermissionsBitField.Flags.PrioritySpeaker,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
    PermissionsBitField.Flags.AttachFiles,
    PermissionsBitField.Flags.AddReactions,
    PermissionsBitField.Flags.UseExternalEmojis,
    PermissionsBitField.Flags.UseExternalStickers,
    PermissionsBitField.Flags.ManageMessages,
    PermissionsBitField.Flags.ManageWebhooks,
    PermissionsBitField.Flags.BypassSlowmode,
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.SendTTSMessages,
    PermissionsBitField.Flags.SendVoiceMessages,
    PermissionsBitField.Flags.SendPolls,
    PermissionsBitField.Flags.UseApplicationCommands
  ]);

  for (const userId of profile.allowedUsers) {
    addOverwriteAllows(overwriteMap, userId, [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.Connect,
      PermissionsBitField.Flags.Speak,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.ReadMessageHistory
    ]);
  }

  for (const userId of profile.managers) {
    addOverwriteAllows(overwriteMap, userId, [
      PermissionsBitField.Flags.ViewChannel,
      PermissionsBitField.Flags.Connect,
      PermissionsBitField.Flags.Speak,
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.ReadMessageHistory,
      PermissionsBitField.Flags.MoveMembers,
      PermissionsBitField.Flags.MuteMembers,
      PermissionsBitField.Flags.DeafenMembers
    ]);
  }

  for (const userId of profile.bannedUsers) {
    addOverwriteDenies(overwriteMap, userId, [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect]);
  }

  for (const userId of profile.voiceMutedUsers) {
    addOverwriteAllows(overwriteMap, userId, [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect]);
    addOverwriteDenies(overwriteMap, userId, [PermissionsBitField.Flags.Speak]);
  }

  for (const userId of profile.textMutedUsers) {
    addOverwriteAllows(overwriteMap, userId, [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect]);
    addOverwriteDenies(overwriteMap, userId, [
      PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.SendVoiceMessages,
      PermissionsBitField.Flags.SendPolls,
      PermissionsBitField.Flags.AddReactions
    ]);
  }

  await Promise.all([
    roomChannel.permissionOverwrites.set(finalizeOverwrites(overwriteMap), 'Sync temp voice room state').catch(() => null),
    roomChannel.edit({ userLimit: profile.userLimit || 0, rtcRegion: profile.rtcRegion || null }).catch(() => null)
  ]);

  await enforceRoomOccupancyRules(roomChannel, ownerId, profile);
}

async function enforceRoomOccupancyRules(roomChannel, ownerId, profile = null) {
  const effectiveProfile = profile || getUserProfile(roomChannel.guild.id, ownerId);
  const members = [...(roomChannel.members?.values?.() || [])].filter(member => !member.user.bot);
  const sortedMembers = [...members].sort((a, b) => getRoomMemberPriority(a, ownerId, effectiveProfile) - getRoomMemberPriority(b, ownerId, effectiveProfile));
  const overLimitMembers = effectiveProfile.userLimit > 0 && sortedMembers.length > effectiveProfile.userLimit
    ? sortedMembers.slice(effectiveProfile.userLimit)
    : [];

  for (const member of members) {
    if (effectiveProfile.bannedUsers.includes(member.id)) {
      await member.voice.disconnect('Banned from temp room').catch(() => member.voice.setChannel(null).catch(() => null));
      continue;
    }
    if (isRoomAccessRestricted(effectiveProfile) && !canMemberBypassTempRestrictions(member, ownerId, effectiveProfile)) {
      await member.voice.disconnect('Unauthorized temp room entry').catch(() => member.voice.setChannel(null).catch(() => null));
      continue;
    }
    if (overLimitMembers.some(target => target.id === member.id)) {
      await member.voice.disconnect('Temp room limit reached').catch(() => member.voice.setChannel(null).catch(() => null));
    }
  }
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
    profile.locked = true;
    profile.hidden = false;
    const desiredName = getRoomDisplayBaseName(profile, member);
    roomChannel = await guild.channels.create({
      name: desiredName,
      type: ChannelType.GuildVoice,
      parent: config.categoryId,
      userLimit: 0,
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
  await ensureGuildControlPanel(guild, CONTROL_CARD_SIGNATURE);
  await logTempRoomState(guild, {
    title: hadExistingRoom ? '🔁 **استخدام روم مؤقت قائم**' : '🎙️ **إنشاء روم مؤقت جديد**',
    description: hadExistingRoom ? '**تم استخدام الروم المؤقت الحالي ونقل المالك إليه.**' : '**تم إنشاء روم مؤقت جديد ونقل المالك إليه.**',
    actorId: member.id,
    ownerId: member.id,
    roomId: roomChannel.id,
    roomName: roomChannel.name,
    roomRecord,
    extra: `**نوع العملية:** ${hadExistingRoom ? '**استرجاع روم موجود**' : '**إنشاء روم جديد**'}
**الحد الحالي:** **${profile.userLimit || 0}**
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

async function expireAccessGrant(guild, ownerId, profile, roomChannel, type, userId, reason = 'Expired') {
  removeTimedAccessEntry(profile, type, userId);
  if (type === 'allow' && profile.pendingInvites?.[userId]) {
    const record = profile.pendingInvites[userId];
    const user = await guild.client.users.fetch(userId).catch(() => null);
    await deleteTrackedDmMessage(user, record);
    delete profile.pendingInvites[userId];
  }
  scheduleSave();
  await applyRoomState(roomChannel, ownerId);
  const user = await guild.client.users.fetch(userId).catch(() => null);
  await notifyUser(user, {
    content: `انتهت صلاحية ${type === 'allow' ? 'السماح' : 'الإدارة'} الخاصة بك في روم <#${roomChannel.id}>. السبب: ${reason}`
  });
}

async function cleanupExpiredAccess(guild, ownerId, profile, roomChannel) {
  let changed = false;
  const now = Date.now();

  for (const [userId, entry] of Object.entries(profile.allowedEntries || {})) {
    if (entry?.expiresAt && entry.expiresAt <= now) {
      await expireAccessGrant(guild, ownerId, profile, roomChannel, 'allow', userId, 'انتهاء المدة');
      changed = true;
    }
  }

  for (const [userId, entry] of Object.entries(profile.managerEntries || {})) {
    if (entry?.expiresAt && entry.expiresAt <= now) {
      await expireAccessGrant(guild, ownerId, profile, roomChannel, 'admin', userId, 'انتهاء المدة');
      changed = true;
    }
  }

  return changed;
}

async function cleanupExpiredMutes(guild, ownerId, profile, roomChannel) {
  let changed = false;
  const now = Date.now();

  for (const [userId, entry] of Object.entries(profile.voiceMutedEntries || {})) {
    if (entry?.expiresAt && entry.expiresAt <= now) {
      removeMuteScopeFromProfile(profile, userId, 'voice');
      changed = true;
      const user = await guild.client.users.fetch(userId).catch(() => null);
      await notifyUser(user, { content: `انتهى الميوت الصوتي الخاص بك في روم <#${roomChannel.id}>.` });
    }
  }

  for (const [userId, entry] of Object.entries(profile.textMutedEntries || {})) {
    if (entry?.expiresAt && entry.expiresAt <= now) {
      removeMuteScopeFromProfile(profile, userId, 'text');
      changed = true;
      const user = await guild.client.users.fetch(userId).catch(() => null);
      await notifyUser(user, { content: `انتهى الميوت الكتابي الخاص بك في روم <#${roomChannel.id}>.` });
    }
  }

  if (changed) {
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
  }

  return changed;
}

async function cleanupExpiredBans(guild, ownerId, profile, roomChannel) {
  let changed = false;
  const now = Date.now();

  for (const [userId, entry] of Object.entries(profile.bannedEntries || {})) {
    if (entry?.expiresAt && entry.expiresAt <= now) {
      removeBanFromProfile(profile, userId);
      changed = true;
      const user = await guild.client.users.fetch(userId).catch(() => null);
      await notifyUser(user, { content: `انتهى الحظر الخاص بك في روم <#${roomChannel.id}>.` });
    }
  }

  if (changed) {
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
  }

  return changed;
}

async function cleanupExpiredInvites(guild, ownerId, profile, roomChannel) {
  let changed = false;
  const now = Date.now();
  for (const [userId, inviteRecord] of Object.entries(profile.pendingInvites || {})) {
    if (!inviteRecord) continue;
    const expired = (inviteRecord.expiresAt && inviteRecord.expiresAt <= now) || (!inviteRecord.joinedAt && inviteRecord.createdAt && (now - inviteRecord.createdAt) >= INVITE_TTL_MS);
    if (!expired) continue;
    await cleanupInviteRecord(guild, ownerId, profile, userId, { removeAccess: true, deleteMessage: true });
    changed = true;
  }
  if (changed) {
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
  }
  return changed;
}

async function processRotatingRoomName(guild, ownerId, profile, roomChannel) {
  const names = Array.isArray(profile.roomNameRotationNames) ? profile.roomNameRotationNames.filter(Boolean) : [];
  if (names.length < 2 || !profile.roomNameRotationIntervalMs || !profile.roomNameRotationNextAt) return false;
  if (Date.now() < profile.roomNameRotationNextAt) return false;
  const nextIndex = (profile.roomNameRotationIndex + 1) % names.length;
  const nextName = sanitizeRoomName(names[nextIndex], roomChannel.name);
  if (roomChannel.name !== nextName) {
    const renamed = await roomChannel.setName(nextName).then(() => true).catch(() => false);
    if (!renamed) return false;
  }
  profile.roomNameRotationIndex = nextIndex;
  profile.roomNameRotationNextAt = Date.now() + profile.roomNameRotationIntervalMs;
  profile.roomNameTemplate = nextName;
  scheduleSave();
  await logTempRoomState(guild, {
    title: '🔁 **تحديث اسم الروم تلقائياً**',
    description: '**تم تدوير اسم الروم المؤقت تلقائياً حسب الجدول المحدد.**',
    ownerId,
    roomId: roomChannel.id,
    roomName: nextName,
    roomRecord: getRoomRecord(guild.id, ownerId),
    extra: `**الاسم الجديد:** **${nextName}**`
  });
  return true;
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

      await cleanupExpiredAccess(guild, ownerId, getUserProfile(guildId, ownerId), channel);
      await cleanupExpiredMutes(guild, ownerId, getUserProfile(guildId, ownerId), channel);
      await cleanupExpiredBans(guild, ownerId, getUserProfile(guildId, ownerId), channel);
      await cleanupExpiredInvites(guild, ownerId, getUserProfile(guildId, ownerId), channel);
      await processRotatingRoomName(guild, ownerId, getUserProfile(guildId, ownerId), channel);
      await applyRoomState(channel, ownerId);

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
    await applyRoomState(channel, ownerId);

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
    const ownerProfile = getUserProfile(guild.id, ownerId);
    if (joinedTemp && ownerProfile.bannedUsers.includes(newState.member.id)) {
      const user = await guild.client.users.fetch(newState.member.id).catch(() => null);
      await notifyUser(user, { content: `أنت محظور من روم <#${channel.id}> ولا يمكنك الدخول إليه.` });
      await newState.member.voice.disconnect('Banned from temp room').catch(() => newState.member.voice.setChannel(null).catch(() => null));
      continue;
    }
    if (
      joinedTemp &&
      isRoomAccessRestricted(ownerProfile) &&
      !canMemberBypassTempRestrictions(newState.member, ownerId, ownerProfile)
    ) {
      await newState.member.voice.disconnect('Unauthorized temp room entry').catch(() => newState.member.voice.setChannel(null).catch(() => null));
      continue;
    }
    const joinedInvite = joinedTemp ? getActiveInvite(ownerProfile, newState.member.id) : null;
    if (joinedInvite && !joinedInvite.joinedAt) {
      joinedInvite.joinedAt = Date.now();
      scheduleSave();
    }
    if (leftTemp) {
      const leavingId = oldState.member?.id;
      const activeInvite = getActiveInvite(ownerProfile, leavingId);
      if (activeInvite?.joinedAt && activeInvite.temporaryAccessGranted) {
        await cleanupInviteRecord(guild, ownerId, ownerProfile, leavingId, { removeAccess: true, deleteMessage: true });
        ownerProfile.allowHistory = pushLimitedHistory(ownerProfile.allowHistory, { action: 'invite_cleanup', userId: leavingId, by: ownerId, at: Date.now() });
        scheduleSave();
        await applyRoomState(channel, ownerId);
      } else if (activeInvite?.joinedAt && !activeInvite.temporaryAccessGranted) {
        delete ownerProfile.pendingInvites[leavingId];
        scheduleSave();
      }
    }
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
  const config = getGuildConfig(interaction.guild.id);

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

  if (action === 'temp_settings_music') {
    await interaction.reply({
      content: '**اختر روم الفويس الذي تنتظر فيه بوتات الميوزك ليتم سحبها عند الضغط على زر Music.**',
      components: [new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`temp_settings_music_select:${userId}`)
          .setPlaceholder('اختر روم الموسيقى')
          .setChannelTypes(ChannelType.GuildVoice)
          .setMinValues(1)
          .setMaxValues(1)
      )],
      ephemeral: true
    }).catch(() => {});
    return true;
  }

  if (action === 'temp_settings_card_color') {
    await interaction.reply({
      content: '**اختر مصدر لون صورة الكنترول: لون صورة السيرفر أو لون مخصص من اختيارك.**',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`temp_settings_card_color_avatar:${userId}`).setLabel('Avatar Color').setStyle(getTempButtonStyle()),
        new ButtonBuilder().setCustomId(`temp_settings_card_color_custom:${userId}`).setLabel('Other Color').setStyle(getTempButtonStyle())
      )],
      ephemeral: true
    }).catch(() => {});
    return true;
  }

  if (action === 'temp_settings_card_color_avatar') {
    config.controlCardColorMode = 'avatar';
    config.controlCardCustomColor = null;
    scheduleSave();
    await interaction.update({ content: '✅ تم تفعيل لون صورة السيرفر لصورة الكنترول.', components: [] }).catch(() => {});
    await Promise.all([
      updateSettingsPanelMessage(interaction.guild, userId),
      ensureGuildControlPanel(interaction.guild)
    ]);
    await sendTempLog(interaction.guild, {
      title: '🎨 **تحديث لون صورة الكنترول**',
      description: '**تم ضبط لون صورة الكنترول على لون صورة السيرفر.**',
      fields: [
        { name: '**المنفذ**', value: `<@${interaction.user.id}>`, inline: true },
        { name: '**الوضع**', value: '**Avatar Color**', inline: true }
      ]
    });
    return true;
  }

  if (action === 'temp_settings_card_color_custom') {
    const modal = new ModalBuilder().setCustomId(`temp_settings_card_color_custom_modal:${userId}`).setTitle('Controller Card Color');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('value')
.setLabel('Color value (#5865F2 / rgb / gold)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(config.controlCardCustomColor || '#5865F2')
        .setMaxLength(60)
    ));
    await interaction.showModal(modal).catch(() => {});
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
          new ButtonBuilder().setCustomId(`temp_settings_controls_save:${userId}`).setLabel('Save').setStyle(getTempButtonStyle()),
          new ButtonBuilder().setCustomId(`temp_settings_controls_reset:${userId}`).setLabel('Reset').setStyle(getTempButtonStyle()),
          new ButtonBuilder().setCustomId(`temp_settings_controls_cancel:${userId}`).setLabel('Cancel').setStyle(getTempButtonStyle())
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
      ensureGuildControlPanel(interaction.guild, CONTROL_CARD_SIGNATURE)
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

  if (action === 'temp_settings_music_select') {
    config.musicChannelId = interaction.values[0];
    scheduleSave();
    await interaction.update({ content: `✅ تم تحديد روم بوتات الميوزك إلى <#${interaction.values[0]}>.`, components: [] }).catch(() => {});
    await updateSettingsPanelMessage(interaction.guild, userId);
    await sendTempLog(interaction.guild, {
      title: '🎵 **تحديث روم بوتات الميوزك**',
      description: '**تم تحديد روم الفويس الخاص بانتظار بوتات الميوزك.**',
      fields: [
        { name: '**المنفذ**', value: `<@${interaction.user.id}>`, inline: true },
        { name: '**الروم المحدد**', value: `<#${interaction.values[0]}>`, inline: true }
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

  if (action === 'temp_settings_card_color_custom_modal') {
    const rawColor = interaction.fields.getTextInputValue('value').trim();
    const normalizedColor = normalizeControlCardColorInput(rawColor);
    if (!normalizedColor) {
      await replyEphemeral(interaction, '❌ اللون غير صالح. استخدم مثلاً #5865F2 أو rgb(88,101,242) أو اسم لون معروف مثل gold.');
      return true;
    }
    config.controlCardColorMode = 'custom';
    config.controlCardCustomColor = normalizedColor;
    scheduleSave();
    await replyEphemeral(interaction, `✅ تم تحديث لون صورة الكنترول إلى ${normalizedColor}.`);
    await Promise.all([
      updateSettingsPanelMessage(interaction.guild, userId),
      ensureGuildControlPanel(interaction.guild)
    ]);
    await sendTempLog(interaction.guild, {
      title: '🎨 **تحديث لون صورة الكنترول**',
      description: '**تم ضبط لون مخصص لصورة الكنترول.**',
      fields: [
        { name: '**المنفذ**', value: `<@${interaction.user.id}>`, inline: true },
        { name: '**اللون**', value: `**${normalizedColor}**`, inline: true }
      ]
    });
    return true;
  }

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
    await editEphemeral(interaction, 'اختر العضو الذي تريد إرسال دعوة خاصة له.', {
      components: [new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`temp_room_invite_select:${ownerId}`)
          .setPlaceholder('اختر العضو')
          .setMinValues(1)
          .setMaxValues(1)
      )]
    });
    return true;
  }

  if (action === 'temp_room_rename') {
    const modal = new ModalBuilder().setCustomId(`temp_room_rename_modal:${ownerId}`).setTitle('Rename Temp Room');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('value')
          .setLabel('Name or comma-separated names')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200)
          .setValue((profile.roomNameRotationNames || []).length ? profile.roomNameRotationNames.join(', ') : roomChannel.name)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('interval')
          .setLabel('Rotation interval, off or 1h+')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(20)
          .setValue(profile.roomNameRotationIntervalMs ? `${Math.max(1, Math.round(profile.roomNameRotationIntervalMs / 3600000))}h` : 'off')
      )
    );
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
        .setValue(String(profile.userLimit || 0))
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
    for (const userId of profile.managers) options.push({ label: `Admin • ${getDisplayNameFromGuild(guild, userId)}`.slice(0, 100), value: `admin:${userId}`, description: 'إزالة المسؤول' });

    if (!options.length) {
      await editEphemeral(interaction, 'ℹ️ لا توجد عناصر محفوظة لإزالتها حالياً.');
      return true;
    }

    await editEphemeral(interaction, 'اختر العناصر التي تريد حذفها من السماح أو المسؤولين.', {
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
    const config = getGuildConfig(guild.id);
    if (!config.musicChannelId) {
      await editEphemeral(interaction, '❌ لم يتم تحديد روم بوتات الميوزك من إعدادات temp بعد.');
      return true;
    }
    const sourceChannel = guild.channels.cache.get(config.musicChannelId) || await guild.channels.fetch(config.musicChannelId).catch(() => null);
    if (!sourceChannel?.isVoiceBased?.()) {
      await editEphemeral(interaction, '❌ روم بوتات الميوزك المحدد غير صالح حالياً.');
      return true;
    }
    const existingBot = roomChannel.members.find(member => member.user.bot);
    if (existingBot) {
      await editEphemeral(interaction, `ℹ️ يوجد بالفعل بوت داخل الروم: ${existingBot.user.username}.`);
      return true;
    }
    const musicBot = sourceChannel.members.find(member =>
      member.user.bot &&
      /music|song|player|luna|hydra|probot/i.test(member.user.username)
    );
    if (!musicBot) {
      await editEphemeral(interaction, 'ℹ️ لم يتم العثور على بوت أغاني داخل روم الميوزك المحدد.');
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
      extra: `**البوت:** **${musicBot.user.username}**
**روم المصدر:** <#${sourceChannel.id}>`
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
          new ButtonBuilder().setCustomId(`temp_room_admin_add:${ownerId}`).setLabel('Add').setStyle(getTempButtonStyle()),
          new ButtonBuilder().setCustomId(`temp_room_admin_remove:${ownerId}`).setLabel('Remove').setStyle(getTempButtonStyle())
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

  if (action.startsWith('temp_room_action_scope_')) {
    const scope = args[1];
    const access = await resolveManagedRoom(interaction, ownerId);
    if (!access) return true;
    const { ownerId: resolvedOwnerId, profile, roomChannel } = access;

    if (action === 'temp_room_action_scope_mute_member') {
      const roomMembers = getModeratableRoomMembers(roomChannel, resolvedOwnerId, profile);
      if (!roomMembers.size) {
        await replyEphemeral(interaction, 'ℹ️ لا يوجد أعضاء داخل الروم لاختيارهم حالياً.');
        return true;
      }
      const session = getSession(interaction.user.id);
      session.pendingModerationScope = { ownerId: resolvedOwnerId, action: 'mute_member', scope };
      await replyEphemeral(interaction, `اختر العضو الذي تريد إعطاءه ميوت ${getScopeLabel(scope)}.`, {
        components: [new ActionRowBuilder().addComponents(
          new UserSelectMenuBuilder()
            .setCustomId(`temp_room_action_pick_mute_member:${resolvedOwnerId}`)
            .setPlaceholder('اختر العضو')
            .setMinValues(1)
            .setMaxValues(1)
        )]
      });
      return true;
    }

    if (action === 'temp_room_action_scope_unmute_member') {
      const mutedTargets = listMutedTargets(profile, scope);
      if (!mutedTargets.length) {
        await replyEphemeral(interaction, `ℹ️ لا يوجد أعضاء لديهم ميوت ${getScopeLabel(scope)} حالياً.`);
        return true;
      }
      const session = getSession(interaction.user.id);
      session.pendingModerationScope = { ownerId: resolvedOwnerId, action: 'unmute_member', scope };
      await replyEphemeral(interaction, `اختر العضو الذي تريد إزالة ميوت ${getScopeLabel(scope)} عنه.`, {
        components: [new ActionRowBuilder().addComponents(
          new UserSelectMenuBuilder()
            .setCustomId(`temp_room_action_pick_unmute_member:${resolvedOwnerId}`)
            .setPlaceholder('اختر العضو')
            .setMinValues(1)
            .setMaxValues(1)
        )]
      });
      return true;
    }

    if (action === 'temp_room_action_scope_mute_all') {
      const targets = [...getModeratableRoomMembers(roomChannel, resolvedOwnerId, profile).values()].map(member => member.id);
      if (!targets.length) {
        await replyEphemeral(interaction, 'ℹ️ لا يوجد أعضاء حالياً داخل الروم لتطبيق الميوت عليهم.');
        return true;
      }
      const session = getSession(interaction.user.id);
      session.pendingMuteAll = { ownerId: resolvedOwnerId, scope, targetIds: targets };
      const penaltyLines = buildPenaltyStatusLines(interaction.guild, profile, targets, scope);
      if (penaltyLines.length) {
        await replyEphemeral(interaction, `**الأعضاء الذين لديهم عقوبة ${getScopeLabel(scope)} قائمة حالياً:**\n\n${penaltyLines.join('\n\n')}`, {
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`temp_room_action_renew_mute_all:${resolvedOwnerId}:${scope}`).setLabel('تجديد العقوبة').setStyle(getTempButtonStyle())
          )]
        });
        return true;
      }
      await interaction.showModal(buildMuteAllDurationModal(resolvedOwnerId, scope)).catch(() => {});
      return true;
    }

    if (action === 'temp_room_action_scope_unmute_all') {
      const targets = listMutedTargets(profile, scope);
      if (!targets.length) {
        await replyEphemeral(interaction, `ℹ️ لا يوجد ميوت ${getScopeLabel(scope)} مفعل حالياً.`);
        return true;
      }
      for (const userId of targets) {
        removeMuteScopeFromProfile(profile, userId, scope);
      }
      profile.moderationHistory = pushLimitedHistory(profile.moderationHistory, { action: `unmute_all_${scope}`, userId: 'all', by: interaction.user.id, at: Date.now() });
      scheduleSave();
      await applyRoomState(roomChannel, resolvedOwnerId);
      await replyEphemeral(interaction, `✅ تم فك الميوت ${getScopeLabel(scope)} عن الجميع.`);
      return true;
    }
  }

  if (action === 'temp_room_action_renew_mute') {
    const scope = args[1];
    const access = await resolveManagedRoom(interaction, ownerId);
    if (!access) return true;
    const session = getSession(interaction.user.id);
    if (!session.pendingModerationTarget || session.pendingModerationTarget.ownerId !== access.ownerId || session.pendingModerationTarget.scope !== scope) {
      await replyEphemeral(interaction, '❌ انتهت جلسة تجديد العقوبة. اختر العضو من جديد.');
      return true;
    }
    await interaction.showModal(buildMuteMemberDurationModal(access.ownerId, scope)).catch(() => {});
    return true;
  }

  if (action === 'temp_room_action_renew_mute_all') {
    const scope = args[1];
    const access = await resolveManagedRoom(interaction, ownerId);
    if (!access) return true;
    const session = getSession(interaction.user.id);
    if (!session.pendingMuteAll || session.pendingMuteAll.ownerId !== access.ownerId || session.pendingMuteAll.scope !== scope) {
      await replyEphemeral(interaction, '❌ انتهت جلسة تجديد العقوبة الجماعية. حاول من جديد.');
      return true;
    }
    await interaction.showModal(buildMuteAllDurationModal(access.ownerId, scope)).catch(() => {});
    return true;
  }

  if (action === 'temp_room_action_renew_ban') {
    const access = await resolveManagedRoom(interaction, ownerId);
    if (!access) return true;
    const session = getSession(interaction.user.id);
    if (!session.pendingBanTarget || session.pendingBanTarget.ownerId !== access.ownerId) {
      await replyEphemeral(interaction, '❌ انتهت جلسة تجديد الحظر. اختر العضو من جديد.');
      return true;
    }
    await interaction.showModal(buildBanDurationModal(access.ownerId)).catch(() => {});
    return true;
  }

  if (action === 'temp_room_action_kick_all') {
    const access = await resolveManagedRoom(interaction, ownerId);
    if (!access) return true;
    const { ownerId: resolvedOwnerId, profile, roomChannel } = access;
    const targets = [...getModeratableRoomMembers(roomChannel, resolvedOwnerId, profile).values()].map(member => member.id);
    const kickedIds = [];
    for (const targetId of targets) {
      const member = await interaction.guild.members.fetch(targetId).catch(() => null);
      if (!member || member.voice.channelId !== roomChannel.id) continue;
      const moved = await disconnectMemberFromVoice(member, 'Kicked from temp room');
      if (!moved) continue;
      profile.moderationHistory = pushLimitedHistory(profile.moderationHistory, { action: 'kick', userId: targetId, by: interaction.user.id, at: Date.now() });
      kickedIds.push(targetId);
    }
    if (!kickedIds.length) {
      await replyEphemeral(interaction, '❌ تعذر طرد أي عضو فعلياً من الروم.');
      return true;
    }
    scheduleSave();
    await replyEphemeral(interaction, `✅ تم طرد ${kickedIds.length} عضو من الروم.`);
    return true;
  }

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
    const session = getSession(interaction.user.id);
    session.pendingAllowSelection = { ownerId: resolvedOwnerId, userIds: interaction.values };
    const modal = new ModalBuilder().setCustomId(`temp_room_allow_duration_modal:${resolvedOwnerId}`).setTitle('Allow Access');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('duration')
        .setLabel('Duration: off or 30m / 2h / 7d')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue('off')
    ));
    await interaction.showModal(modal).catch(() => {});
    return true;
  }

  if (action === 'temp_room_reject_select') {
    for (const entry of interaction.values) {
      const [type, userId] = entry.split(':');
      if (type === 'allow') removeTimedAccessEntry(profile, 'allow', userId);
      if (type === 'admin') removeTimedAccessEntry(profile, 'admin', userId);
      profile.allowHistory = pushLimitedHistory(profile.allowHistory, { action: `remove_${type}`, userId, by: interaction.user.id, at: Date.now() });
      const user = await interaction.guild.client.users.fetch(userId).catch(() => null);
      if (type === 'allow' && profile.pendingInvites?.[userId]) {
        await deleteTrackedDmMessage(user, profile.pendingInvites[userId]);
        delete profile.pendingInvites[userId];
      }
      await notifyUser(user, {
        content: `تمت إزالة ${type === 'allow' ? 'السماح' : 'الإدارة'} الخاصة بك من روم <#${roomChannel.id}> بواسطة <@${interaction.user.id}>.`
      });
    }
    scheduleSave();
    await applyRoomState(roomChannel, resolvedOwnerId);
    await replyEphemeral(interaction, '✅ تم حذف العناصر المحددة.');
    await logTempRoomState(interaction.guild, {
      title: '🧹 **تنظيف قوائم الروم**',
      description: '**تم حذف عناصر من قوائم السماح أو المسؤولين.**',
      actorId: interaction.user.id,
      ownerId: resolvedOwnerId,
      roomId: roomChannel.id,
      roomName: roomChannel.name,
      roomRecord,
      extra: interaction.values.map(value => `**${value}**`).join('\n')
    });
    return true;
  }

  if (action === 'temp_room_invite_select') {
    const targetId = interaction.values[0];
    if (targetId === resolvedOwnerId) {
      await replyEphemeral(interaction, 'ℹ️ لا تحتاج إلى دعوة نفسك.');
      return true;
    }
    const targetUser = await interaction.guild.client.users.fetch(targetId).catch(() => null);
    const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!targetUser || !targetMember || targetUser.bot) {
      await replyEphemeral(interaction, '❌ لا يمكن دعوة هذا العضو.');
      return true;
    }
    if (targetMember.voice?.channelId === roomChannel.id) {
      await replyEphemeral(interaction, 'ℹ️ العضو موجود بالفعل داخل الروم.');
      return true;
    }

    if (profile.pendingInvites?.[targetId]) {
      await cleanupInviteRecord(interaction.guild, resolvedOwnerId, profile, targetId, { removeAccess: true, deleteMessage: true });
    }

    const needsTemporaryAccess = isRoomAccessRestricted(profile);
    const previousAllowEntry = profile.allowedEntries?.[targetId] ? { ...profile.allowedEntries[targetId] } : null;
    const hadAllowAlready = profile.allowedUsers.includes(targetId);
    if (needsTemporaryAccess) {
      if (!hadAllowAlready) profile.allowedUsers.push(targetId);
      setTimedAccessEntry(profile.allowedEntries, targetId, { grantedBy: interaction.user.id, source: 'invite' });
    }
    const inviteRecord = {
      userId: targetId,
      invitedBy: interaction.user.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + INVITE_TTL_MS,
      roomId: roomChannel.id,
      joinedAt: null,
      previousAllowEntry,
      hadAllowAlready,
      temporaryAccessGranted: needsTemporaryAccess
    };
    profile.pendingInvites[targetId] = inviteRecord;
    scheduleSave();
    await applyRoomState(roomChannel, resolvedOwnerId);

    const inviteMessage = await notifyUser(targetUser, {
      content: [
        `مالك الروم <@${interaction.user.id}> يريد سحبك إلى الروم <#${roomChannel.id}>.`,
        profile.locked ? 'تم فتح السماح لك للدخول إلى الروم.' : null,
        profile.hidden ? 'تم إظهار الروم لك حتى تتمكن من الدخول.' : null
      ].filter(Boolean).join('\n'),
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`temp_invite_go:${interaction.guild.id}:${roomChannel.id}:${targetId}`)
            .setLabel('ودني')
            .setStyle(getTempButtonStyle())
        )
      ]
    });

    if (!inviteMessage) {
      if (needsTemporaryAccess) {
        if (hadAllowAlready && previousAllowEntry) setTimedAccessEntry(profile.allowedEntries, targetId, previousAllowEntry);
        else removeTimedAccessEntry(profile, 'allow', targetId);
      }
      delete profile.pendingInvites[targetId];
      scheduleSave();
      await applyRoomState(roomChannel, resolvedOwnerId);
      await replyEphemeral(interaction, '❌ تعذر إرسال الدعوة في الخاص. تأكد أن العضو يسمح بالرسائل الخاصة.');
      return true;
    }

    inviteRecord.dmChannelId = inviteMessage.channel.id;
    inviteRecord.dmMessageId = inviteMessage.id;
    scheduleSave();
    await replyEphemeral(interaction, `✅ تم إرسال الدعوة الخاصة إلى <@${targetId}>.`);
    await logTempRoomState(interaction.guild, {
      title: '📨 **دعوة عضو إلى الروم**',
      description: '**تم إرسال دعوة خاصة لعضو مع زر سحب مباشر إلى الروم المؤقت.**',
      actorId: interaction.user.id,
      ownerId: resolvedOwnerId,
      roomId: roomChannel.id,
      roomName: roomChannel.name,
      roomRecord,
      extra: `**المدعو:** <@${targetId}>`
    });
    return true;
  }

  if (action === 'temp_room_actions') {
    const selectedAction = interaction.values[0];
    if (selectedAction === 'mute_member') {
      await replyEphemeral(interaction, 'اختر نوع الميوت أولاً.', { components: buildScopeButtons('temp_room_action_scope_mute_member', resolvedOwnerId) });
      return true;
    }
    if (selectedAction === 'unmute_member') {
      await replyEphemeral(interaction, 'اختر نوع فك الميوت أولاً.', { components: buildScopeButtons('temp_room_action_scope_unmute_member', resolvedOwnerId) });
      return true;
    }
    if (selectedAction === 'mute_all') {
      await replyEphemeral(interaction, 'اختر نوع الميوت الذي تريد تطبيقه على كل الموجودين حالياً بالروم.', { components: buildScopeButtons('temp_room_action_scope_mute_all', resolvedOwnerId) });
      return true;
    }
    if (selectedAction === 'unmute_all') {
      await replyEphemeral(interaction, 'اختر نوع فك الميوت الذي تريد تطبيقه على الجميع.', { components: buildScopeButtons('temp_room_action_scope_unmute_all', resolvedOwnerId) });
      return true;
    }
    if (selectedAction === 'kick') {
      const roomMembers = getModeratableRoomMembers(roomChannel, resolvedOwnerId, profile);
      if (!roomMembers.size) {
        await replyEphemeral(interaction, 'ℹ️ لا يوجد أعضاء داخل الروم لطردهم حالياً.');
        return true;
      }
      await replyEphemeral(interaction, 'اختر الكل أو الأعضاء الذين تريد طردهم من الفويس.', {
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`temp_room_action_kick_all:${resolvedOwnerId}`)
              .setLabel('Kick All')
              .setStyle(getTempButtonStyle())
          ),
          new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
              .setCustomId(`temp_room_action_pick_kick:${resolvedOwnerId}`)
              .setPlaceholder('اختر الأعضاء')
              .setMinValues(1)
              .setMaxValues(Math.min(25, roomMembers.size))
          )
        ]
      });
      return true;
    }
    if (selectedAction === 'ban') {
      await replyEphemeral(interaction, 'اختر العضو الذي تريد حظره من الروم.', {
        components: [new ActionRowBuilder().addComponents(
          new UserSelectMenuBuilder()
            .setCustomId(`temp_room_action_pick_ban:${resolvedOwnerId}`)
            .setPlaceholder('اختر العضو')
            .setMinValues(1)
            .setMaxValues(1)
        )]
      });
      return true;
    }
    if (selectedAction === 'unban') {
      const bannedTargets = profile.bannedUsers || [];
      if (!bannedTargets.length) {
        await replyEphemeral(interaction, 'ℹ️ لا يوجد أعضاء محظورون حالياً.');
        return true;
      }
      await replyEphemeral(interaction, 'اختر المحظورين الذين تريد فك حظرهم.', {
        components: [new ActionRowBuilder().addComponents(
          new UserSelectMenuBuilder()
            .setCustomId(`temp_room_action_pick_unban:${resolvedOwnerId}`)
            .setPlaceholder('اختر المحظورين')
            .setMinValues(1)
            .setMaxValues(Math.min(25, bannedTargets.length))
        )]
      });
      return true;
    }
    return true;
  }

  if (action === 'temp_room_action_pick_mute_member') {
    const session = getSession(interaction.user.id);
    if (!session.pendingModerationScope || session.pendingModerationScope.ownerId !== resolvedOwnerId || session.pendingModerationScope.action !== 'mute_member') {
      await replyEphemeral(interaction, '❌ انتهت جلسة اختيار الميوت. حاول من جديد.');
      return true;
    }
    const targetId = interaction.values[0];
    const member = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!member || member.voice.channelId !== roomChannel.id) {
      await replyEphemeral(interaction, '❌ العضو المحدد ليس داخل الروم حالياً.');
      return true;
    }
    const validation = validateModerationTarget({ member, ownerId: resolvedOwnerId, profile, actionType: 'إعطاء ميوت', actorId: interaction.user.id });
    if (!validation.ok) {
      await replyEphemeral(interaction, validation.message);
      return true;
    }
    session.pendingModerationTarget = { ...session.pendingModerationScope, targetId };
    const summary = getMutePenaltySummary(profile, targetId, session.pendingModerationScope.scope);
    if (summary.active) {
      await replyEphemeral(interaction, `**العقوبة الحالية على <@${targetId}>:**\n\n${summary.parts.map(part => `• ${part}`).join('\n')}\n\nاضغط **تجديد العقوبة** إذا كنت تريد تمديدها أو استبدال مدتها.`, {
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`temp_room_action_renew_mute:${resolvedOwnerId}:${session.pendingModerationScope.scope}`).setLabel('تجديد العقوبة').setStyle(getTempButtonStyle())
        )]
      });
      return true;
    }
    await interaction.showModal(buildMuteMemberDurationModal(resolvedOwnerId, session.pendingModerationScope.scope)).catch(() => {});
    return true;
  }

  if (action === 'temp_room_action_pick_unmute_member') {
    const session = getSession(interaction.user.id);
    if (!session.pendingModerationScope || session.pendingModerationScope.ownerId !== resolvedOwnerId || session.pendingModerationScope.action !== 'unmute_member') {
      await replyEphemeral(interaction, '❌ انتهت جلسة اختيار فك الميوت. حاول من جديد.');
      return true;
    }
    const targetId = interaction.values[0];
    const scope = session.pendingModerationScope.scope;
    if (!listMutedTargets(profile, scope).includes(targetId)) {
      await replyEphemeral(interaction, `❌ العضو المحدد لا يملك ميوت ${getScopeLabel(scope)} حالياً.`);
      return true;
    }
    removeMuteScopeFromProfile(profile, targetId, scope);
    profile.moderationHistory = pushLimitedHistory(profile.moderationHistory, { action: `unmute_${scope}`, userId: targetId, by: interaction.user.id, at: Date.now() });
    session.pendingModerationScope = null;
    scheduleSave();
    await applyRoomState(roomChannel, resolvedOwnerId);
    await replyEphemeral(interaction, `✅ تم فك الميوت ${getScopeLabel(scope)} عن <@${targetId}>.`);
    return true;
  }

  if (action === 'temp_room_action_pick_kick') {
    const selectedIds = interaction.values;
    const kickedIds = [];
    for (const targetId of selectedIds) {
      const member = await interaction.guild.members.fetch(targetId).catch(() => null);
      if (!member || member.voice.channelId !== roomChannel.id) continue;
      const validation = validateModerationTarget({ member, ownerId: resolvedOwnerId, profile, actionType: 'طرد', actorId: interaction.user.id });
      if (!validation.ok) continue;
      const moved = await disconnectMemberFromVoice(member, 'Kicked from temp room');
      if (!moved) continue;
      profile.moderationHistory = pushLimitedHistory(profile.moderationHistory, { action: 'kick', userId: targetId, by: interaction.user.id, at: Date.now() });
      kickedIds.push(targetId);
    }
    if (!kickedIds.length) {
      await replyEphemeral(interaction, '❌ لا يوجد أعضاء مطابقون داخل الروم حالياً للطرد.');
      return true;
    }
    scheduleSave();
    await replyEphemeral(interaction, `✅ تم طرد ${kickedIds.map(id => `<@${id}>`).join('، ')} من الروم.`);
    return true;
  }

  if (action === 'temp_room_action_pick_ban') {
    const targetId = interaction.values[0];
    const user = await interaction.guild.client.users.fetch(targetId).catch(() => null);
    const member = await interaction.guild.members.fetch(targetId).catch(() => null);
    const validation = validateModerationTarget({ member, user, ownerId: resolvedOwnerId, profile, actionType: 'حظر', actorId: interaction.user.id });
    if (!validation.ok) {
      await replyEphemeral(interaction, validation.message);
      return true;
    }
    const summary = getBanSummary(profile, targetId);
    const session = getSession(interaction.user.id);
    session.pendingBanTarget = { ownerId: resolvedOwnerId, targetId };
    if (summary.active) {
      await replyEphemeral(interaction, `**الحظر الحالي على <@${targetId}>:** ${summary.remaining}\n\nاضغط **تجديد الحظر** إذا كنت تريد تمديده أو استبدال مدته.`, {
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`temp_room_action_renew_ban:${resolvedOwnerId}`).setLabel('تجديد الحظر').setStyle(getTempButtonStyle())
        )]
      });
      return true;
    }
    await interaction.showModal(buildBanDurationModal(resolvedOwnerId)).catch(() => {});
    return true;
  }

  if (action === 'temp_room_action_pick_unban') {
    let changed = 0;
    for (const targetId of interaction.values) {
      if (!profile.bannedUsers.includes(targetId)) continue;
      removeBanFromProfile(profile, targetId);
      profile.moderationHistory = pushLimitedHistory(profile.moderationHistory, { action: 'unban', userId: targetId, by: interaction.user.id, at: Date.now() });
      changed += 1;
    }
    if (!changed) {
      await replyEphemeral(interaction, '❌ لم يتم اختيار أي عضو محظور فعلياً.');
      return true;
    }
    scheduleSave();
    await applyRoomState(roomChannel, resolvedOwnerId);
    await replyEphemeral(interaction, '✅ تم فك الحظر عن الأعضاء المحددين.');
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
      targetProfile.allowedEntries = { ...(oldProfile.allowedEntries || {}) };
      targetProfile.managerEntries = { ...(oldProfile.managerEntries || {}) };
      targetProfile.voiceMutedEntries = { ...(oldProfile.voiceMutedEntries || {}) };
      targetProfile.textMutedEntries = { ...(oldProfile.textMutedEntries || {}) };
      targetProfile.bannedEntries = { ...(oldProfile.bannedEntries || {}) };
      targetProfile.pendingInvites = { ...(oldProfile.pendingInvites || {}) };
      targetProfile.roomNameRotationNames = [...(oldProfile.roomNameRotationNames || [])];
      targetProfile.roomNameRotationIntervalMs = oldProfile.roomNameRotationIntervalMs || 0;
      targetProfile.roomNameRotationIndex = oldProfile.roomNameRotationIndex || 0;
      targetProfile.roomNameRotationNextAt = oldProfile.roomNameRotationNextAt || 0;
      targetProfile.ownershipHistory = pushLimitedHistory(targetProfile.ownershipHistory, { action: 'received', from: resolvedOwnerId, by: interaction.user.id, at: Date.now() });
      oldProfile.ownershipHistory = pushLimitedHistory(oldProfile.ownershipHistory, { action: 'transferred', to: newOwnerId, by: interaction.user.id, at: Date.now() });
      resetUserProfileState(oldProfile);

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
    if (adding) {
      const session = getSession(interaction.user.id);
      session.pendingAdminSelection = { ownerId: resolvedOwnerId, userIds: interaction.values };
      const modal = new ModalBuilder().setCustomId(`temp_room_admin_add_duration_modal:${resolvedOwnerId}`).setTitle('Room Admin Access');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('duration')
          .setLabel('Duration: off or 30m / 2h / 7d')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setValue('off')
      ));
      await interaction.showModal(modal).catch(() => {});
      return true;
    }

    for (const userId of interaction.values) {
      if (!adding) {
        profile.managers = profile.managers.filter(id => id !== userId);
        if (profile.managerEntries) delete profile.managerEntries[userId];
        const user = await interaction.guild.client.users.fetch(userId).catch(() => null);
        await notifyUser(user, {
          content: `تمت إزالة صلاحية الإدارة الخاصة بك من روم <#${roomChannel.id}> بواسطة <@${interaction.user.id}>.`
        });
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

async function handleInviteButton(interaction) {
  const { action, args } = parseCustomId(interaction.customId);
  if (action !== 'temp_invite_go') return false;
  const [guildId, roomIdOrOwnerId, targetId] = args;
  if (interaction.user.id !== targetId) {
    await replyEphemeral(interaction, '❌ هذه الدعوة ليست لك.');
    return true;
  }

  const guild = runtimeClient?.guilds?.cache?.get(guildId) || await runtimeClient?.guilds?.fetch?.(guildId).catch(() => null);
  if (!guild) {
    await replyEphemeral(interaction, '❌ السيرفر غير متوفر حالياً.');
    return true;
  }

  let ownerId = null;
  let roomRecord = null;
  let roomChannel = guild.channels.cache.get(roomIdOrOwnerId) || await guild.channels.fetch(roomIdOrOwnerId).catch(() => null);
  if (roomChannel) {
    for (const [candidateOwnerId, candidateRecord] of Object.entries(getRoomStore(guildId))) {
      if (candidateRecord.channelId === roomChannel.id) {
        ownerId = candidateOwnerId;
        roomRecord = candidateRecord;
        break;
      }
    }
  }
  if (!roomRecord) {
    ownerId = roomIdOrOwnerId;
    roomRecord = getRoomRecord(guildId, ownerId);
    roomChannel = roomRecord?.channelId ? guild.channels.cache.get(roomRecord.channelId) || await guild.channels.fetch(roomRecord.channelId).catch(() => null) : null;
  }
  if (!roomRecord || !roomChannel) {
    await replyEphemeral(interaction, '❌ هذه الدعوة انتهت لأن الروم لم يعد موجوداً.');
    return true;
  }

  if (!roomChannel?.isVoiceBased?.()) {
    await replyEphemeral(interaction, '❌ الروم الصوتي غير متوفر حالياً.');
    return true;
  }

  const profile = getUserProfile(guildId, ownerId);
  const inviteRecord = getActiveInvite(profile, targetId);
  if (!inviteRecord) {
    await replyEphemeral(interaction, '❌ الدعوة لم تعد فعالة.');
    return true;
  }
  if (inviteRecord.expiresAt && inviteRecord.expiresAt <= Date.now()) {
    await cleanupInviteRecord(guild, ownerId, profile, targetId, { removeAccess: true, deleteMessage: true });
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
    await replyEphemeral(interaction, '❌ انتهت صلاحية هذه الدعوة.');
    return true;
  }

  const member = guild.members.cache.get(targetId) || await guild.members.fetch(targetId).catch(() => null);
  if (!member) {
    await replyEphemeral(interaction, '❌ العضو غير موجود داخل السيرفر.');
    return true;
  }

  if (member.voice?.channelId === roomChannel.id) {
    if (!inviteRecord.joinedAt) inviteRecord.joinedAt = Date.now();
    scheduleSave();
    await replyEphemeral(interaction, 'ℹ️ أنت موجود بالفعل داخل هذا الروم.');
    return true;
  }

  if (!member.voice?.channelId) {
    await replyEphemeral(interaction, `✅ الدعوة ما زالت فعالة. ادخل أي فويس أولاً ثم اضغط الزر مرة أخرى ليتم سحبك إلى <#${roomChannel.id}>.`);
    return true;
  }

  const moved = await moveMemberToRoom(member, roomChannel);
  if (!moved) {
    await replyEphemeral(interaction, '❌ تعذر سحبك إلى الروم حالياً. جرّب الدخول إلى فويس آخر ثم أعد المحاولة.');
    return true;
  }
  inviteRecord.joinedAt = Date.now();
  scheduleSave();
  await replyEphemeral(interaction, `✅ تم سحبك إلى <#${roomChannel.id}>.`);
  return true;
}

async function handleRoomModal(interaction) {
  const { action, args } = parseCustomId(interaction.customId);
  const ownerId = args[0] || null;
  const access = await resolveManagedRoom(interaction, ownerId);
  if (!access) return true;
  const { profile, roomChannel } = access;

  if (action === 'temp_room_allow_duration_modal') {
    const session = getSession(interaction.user.id);
    const pending = session.pendingAllowSelection;
    if (!pending || pending.ownerId !== ownerId || !pending.userIds?.length) {
      await replyEphemeral(interaction, '❌ انتهت جلسة اختيار أعضاء السماح. حاول من جديد.');
      return true;
    }
    const duration = parseFlexibleDuration(interaction.fields.getTextInputValue('duration') || 'off');
    if (duration === null) {
      await replyEphemeral(interaction, '❌ مدة السماح غير صحيحة.');
      return true;
    }
    const expiresAt = duration > 0 ? Date.now() + duration : null;
    for (const userId of pending.userIds) {
      const pendingInvite = profile.pendingInvites?.[userId] || null;
      if (pendingInvite) {
        const user = await interaction.guild.client.users.fetch(userId).catch(() => null);
        await cleanupInviteRecord(interaction.guild, ownerId, profile, userId, { removeAccess: false, deleteMessage: true });
        if (user) await notifyUser(user, { content: `تم تحويل دعوتك المؤقتة إلى سماح يدوي دائم/مؤقت في روم <#${roomChannel.id}>.` });
      }
      if (!profile.allowedUsers.includes(userId)) profile.allowedUsers.push(userId);
      removeBanFromProfile(profile, userId);
      setTimedAccessEntry(profile.allowedEntries, userId, { grantedBy: interaction.user.id, expiresAt, source: 'manual' });
      profile.allowHistory = pushLimitedHistory(profile.allowHistory, { action: 'allow', userId, by: interaction.user.id, at: Date.now(), expiresAt });
      const user = await interaction.guild.client.users.fetch(userId).catch(() => null);
      await notifyUser(user, {
        content: `تم إعطاؤك سماح دخول إلى روم <#${roomChannel.id}> بواسطة <@${interaction.user.id}>.\nالمدة: ${describeTimedAccess(expiresAt)}`
      });
    }
    session.pendingAllowSelection = null;
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
    await replyEphemeral(interaction, `✅ تم حفظ السماح لـ ${pending.userIds.map(id => `<@${id}>`).join('، ')}.`);
    await logTempRoomState(interaction.guild, {
      title: '✅ **تحديث قائمة السماح**',
      description: '**تمت إضافة أعضاء إلى قائمة السماح الخاصة بالروم المؤقت.**',
      actorId: interaction.user.id,
      ownerId,
      roomId: roomChannel.id,
      roomName: roomChannel.name,
      roomRecord: access.roomRecord,
      extra: `**الأعضاء:** ${pending.userIds.map(id => `<@${id}>`).join('، ')}\n**المدة:** ${describeTimedAccess(expiresAt)}`
    });
    return true;
  }

  if (action === 'temp_room_action_ban_modal') {
    const session = getSession(interaction.user.id);
    const pending = session.pendingBanTarget;
    if (!pending || pending.ownerId !== ownerId || !pending.targetId) {
      await replyEphemeral(interaction, '❌ انتهت جلسة الحظر. حاول من جديد.');
      return true;
    }
    const duration = parseFlexibleDuration(interaction.fields.getTextInputValue('duration') || 'off');
    if (duration === null) {
      await replyEphemeral(interaction, '❌ مدة الحظر غير صحيحة.');
      return true;
    }
    const targetId = pending.targetId;
    const user = await interaction.guild.client.users.fetch(targetId).catch(() => null);
    const member = await interaction.guild.members.fetch(targetId).catch(() => null);
    const expiresAt = duration > 0 ? Date.now() + duration : null;
    if (profile.pendingInvites?.[targetId]) {
      await cleanupInviteRecord(interaction.guild, ownerId, profile, targetId, { removeAccess: true, deleteMessage: true });
    }
    removeTimedAccessEntry(profile, 'allow', targetId);
    removeTimedAccessEntry(profile, 'admin', targetId);
    removeMuteScopeFromProfile(profile, targetId, 'all');
    setTimedBanEntry(profile, targetId, { by: interaction.user.id, expiresAt });
    profile.moderationHistory = pushLimitedHistory(profile.moderationHistory, { action: 'ban', userId: targetId, by: interaction.user.id, at: Date.now(), expiresAt });
    session.pendingBanTarget = null;
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
    let disconnected = true;
    if (member?.voice.channelId === roomChannel.id) disconnected = await disconnectMemberFromVoice(member, 'Banned from temp room');
    await notifyUser(user, { content: `تم حظرك من روم <#${roomChannel.id}> بواسطة <@${interaction.user.id}>.\nالمدة: ${describeTimedAccess(expiresAt)}` });
    await replyEphemeral(interaction, disconnected
      ? `✅ تم حظر <@${targetId}> من الروم لمدة ${describeTimedAccess(expiresAt)}.`
      : `⚠️ تم تسجيل الحظر على <@${targetId}> لكن تعذر فصله من الروم فوراً. سيتم منعه من الدخول والمحاولة مجدداً عند تحديث الحالة.`);
    return true;
  }

  if (action === 'temp_room_admin_add_duration_modal') {
    const session = getSession(interaction.user.id);
    const pending = session.pendingAdminSelection;
    if (!pending || pending.ownerId !== ownerId || !pending.userIds?.length) {
      await replyEphemeral(interaction, '❌ انتهت جلسة اختيار المسؤولين. حاول من جديد.');
      return true;
    }
    const duration = parseFlexibleDuration(interaction.fields.getTextInputValue('duration') || 'off');
    if (duration === null) {
      await replyEphemeral(interaction, '❌ مدة المسؤول غير صحيحة.');
      return true;
    }
    const expiresAt = duration > 0 ? Date.now() + duration : null;
    for (const userId of pending.userIds) {
      if (userId !== ownerId && !profile.managers.includes(userId)) profile.managers.push(userId);
      setTimedAccessEntry(profile.managerEntries, userId, { grantedBy: interaction.user.id, expiresAt, source: 'manual' });
      profile.managerHistory = pushLimitedHistory(profile.managerHistory, { action: 'add', userId, by: interaction.user.id, at: Date.now(), expiresAt });
      const user = await interaction.guild.client.users.fetch(userId).catch(() => null);
      await notifyUser(user, {
        content: `تم تعيينك مسؤولاً في روم <#${roomChannel.id}> بواسطة <@${interaction.user.id}>.\nالمدة: ${describeTimedAccess(expiresAt)}`
      });
    }
    session.pendingAdminSelection = null;
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
    await replyEphemeral(interaction, `✅ تم إضافة المسؤولين المحددين (${pending.userIds.length}).`);
    await logTempRoomState(interaction.guild, {
      title: '🛡️ **إضافة مسؤولين للروم**',
      description: '**تمت إضافة مسؤولين جدد للروم المؤقت.**',
      actorId: interaction.user.id,
      ownerId,
      roomId: roomChannel.id,
      roomName: roomChannel.name,
      roomRecord: access.roomRecord,
      extra: `**الأعضاء:** ${pending.userIds.map(id => `<@${id}>`).join('، ')}\n**المدة:** ${describeTimedAccess(expiresAt)}`
    });
    return true;
  }

  if (action === 'temp_room_action_mute_member_modal') {
    const session = getSession(interaction.user.id);
    const pending = session.pendingModerationTarget;
    if (!pending || pending.ownerId !== ownerId || pending.action !== 'mute_member') {
      await replyEphemeral(interaction, '❌ انتهت جلسة الميوت. حاول من جديد.');
      return true;
    }
    const duration = parseFlexibleDuration(interaction.fields.getTextInputValue('duration') || 'off');
    if (duration === null) {
      await replyEphemeral(interaction, '❌ مدة الميوت غير صحيحة.');
      return true;
    }
    const expiresAt = duration > 0 ? Date.now() + duration : null;
    applyMuteScopeToProfile(profile, pending.targetId, pending.scope, expiresAt, interaction.user.id);
    profile.moderationHistory = pushLimitedHistory(profile.moderationHistory, { action: `mute_${pending.scope}`, userId: pending.targetId, by: interaction.user.id, at: Date.now(), expiresAt });
    session.pendingModerationTarget = null;
    session.pendingModerationScope = null;
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
    await replyEphemeral(interaction, `✅ تم إعطاء ميوت ${getScopeLabel(pending.scope)} لـ <@${pending.targetId}>.`);
    return true;
  }

  if (action === 'temp_room_action_mute_all_modal') {
    const session = getSession(interaction.user.id);
    const pending = session.pendingMuteAll;
    if (!pending || pending.ownerId !== ownerId) {
      await replyEphemeral(interaction, '❌ انتهت جلسة ميوت الكل. حاول من جديد.');
      return true;
    }
    const duration = parseFlexibleDuration(interaction.fields.getTextInputValue('duration') || 'off');
    if (duration === null) {
      await replyEphemeral(interaction, '❌ مدة الميوت غير صحيحة.');
      return true;
    }
    const expiresAt = duration > 0 ? Date.now() + duration : null;
    for (const userId of pending.targetIds) {
      applyMuteScopeToProfile(profile, userId, pending.scope, expiresAt, interaction.user.id);
      profile.moderationHistory = pushLimitedHistory(profile.moderationHistory, { action: `mute_all_${pending.scope}`, userId, by: interaction.user.id, at: Date.now(), expiresAt });
    }
    session.pendingMuteAll = null;
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
    await replyEphemeral(interaction, `✅ تم إعطاء ميوت ${getScopeLabel(pending.scope)} لكل الموجودين حالياً في الروم.`);
    return true;
  }

  if (action === 'temp_room_rename_modal') {
    const names = parseCommaSeparatedNames(interaction.fields.getTextInputValue('value'));
    if (!names.length) {
      await replyEphemeral(interaction, '❌ أدخل اسماً صالحاً واحداً على الأقل.');
      return true;
    }
    const intervalInput = interaction.fields.getTextInputValue('interval') || 'off';
    const interval = parseFlexibleDuration(intervalInput);
    if (interval === null) {
      await replyEphemeral(interaction, '❌ مدة تدوير الاسم غير صحيحة.');
      return true;
    }
    if (names.length > 1 && interval < 3600000) {
      await replyEphemeral(interaction, '❌ أقل مدة لتدوير الأسماء هي ساعة واحدة عند استخدام أكثر من اسم.');
      return true;
    }
    const shouldRenameNow = roomChannel.name !== names[0];
    if (shouldRenameNow) {
      const renamed = await roomChannel.setName(names[0]).then(() => true).catch(() => false);
      if (!renamed) {
        await replyEphemeral(interaction, '❌ تم حفظ الإدخال لكن تعذر تغيير اسم الروم حالياً. حاول مرة أخرى بعد قليل.');
        return true;
      }
    }
    profile.roomNameTemplate = names[0];
    profile.roomNameRotationNames = names.length > 1 ? names : [];
    profile.roomNameRotationIntervalMs = names.length > 1 ? interval : 0;
    profile.roomNameRotationIndex = 0;
    profile.roomNameRotationNextAt = names.length > 1 ? Date.now() + interval : 0;
    scheduleSave();
    await replyEphemeral(interaction, names.length > 1
      ? `✅ تم ضبط تدوير أسماء الروم: ${names.join('، ')} كل ${formatDuration(interval)}.`
      : `✅ تم تغيير اسم الروم إلى ${names[0]}.`);
    await logTempRoomState(interaction.guild, {
      title: '✏️ **تغيير اسم روم مؤقت**',
      description: '**تم تعديل اسم الروم المؤقت.**',
      actorId: interaction.user.id,
      ownerId,
      roomId: roomChannel.id,
      roomName: names[0],
      roomRecord: access.roomRecord,
      extra: names.length > 1
        ? `**الأسماء:** ${names.map(name => `**${name}**`).join('، ')}\n**المدة:** ${formatDuration(interval)}`
        : `**الاسم الجديد:** **${names[0]}**`
    });
    return true;
  }

  if (action === 'temp_room_limit_modal') {
    const limit = Number(interaction.fields.getTextInputValue('value'));
    if (!Number.isFinite(limit) || limit < 0 || limit > 99) {
      await replyEphemeral(interaction, '❌ الحد يجب أن يكون بين 0 و 99.');
      return true;
    }
    if ((profile.userLimit || 0) === limit) {
      await replyEphemeral(interaction, 'ℹ️ الحد الحالي مطابق للقيمة المدخلة.');
      return true;
    }
    profile.userLimit = limit;
    scheduleSave();
    await applyRoomState(roomChannel, ownerId);
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
      return handleRoomSelect(interaction);
    }
    if (interaction.isModalSubmit()) return handleRoomModal(interaction);
    return false;
  }, { name: 'temp-room', priority: 80, types: ['button', 'stringSelect', 'userSelect', 'modal'] });

  interactionRouter.register('temp_invite_', async interaction => {
    if (interaction.isButton()) return handleInviteButton(interaction);
    return false;
  }, { name: 'temp-invite', priority: 80, types: ['button'] });

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
