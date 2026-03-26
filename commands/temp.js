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
const TOP_ASSETS_DIR = path.join(__dirname, '..', 'data', 'temp-top-assets');
const DEFAULT_CREATOR_NAME = 'Create temp room ...';
const DEFAULT_DELETE_AFTER_LEAVE_MS = 5 * 60 * 1000;
const DEFAULT_AUTO_CLEAN_MS = 10 * 60 * 1000;
const CONTROL_CARD_SIGNATURE = 'By Ahmed';
const SESSION_TTL_MS = 12 * 60 * 1000;
const HEARTBEAT_MS = 45000;
const INVITE_TTL_MS = 60 * 60 * 1000;
const TOP_REFRESH_MS = 5 * 60 * 1000;
const MAX_TOP_SEPARATOR_BYTES = 8 * 1024 * 1024;
const TOP_SEPARATOR_FETCH_TIMEOUT_MS = 15000;
const KICK_REJOIN_BLOCK_MS = 30 * 1000;
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
  open: { label: 'Open', emoji: '<:emoji_15:1485476015688908830>', description: 'فتح الروم والسماح بالدخول' },
  lock: { label: 'Lock', emoji: '<:emoji_18:1485476234199826472>', description: 'قفل الروم ومنع الدخول العام' },
  show: { label: 'Show', emoji: '<:emoji_17:1485476188091580446>', description: 'إظهار الروم للجميع' },
  hide: { label: 'Hide', emoji: '<:emoji_17:1485476100774821938>', description: 'إخفاء الروم عن الجميع' },
  invite: { label: 'Invite', emoji: '<:emoji_28:1485476567239888907>', description: 'إنشاء دعوة مباشرة للروم' },
  rename: { label: 'Rename', emoji: '<:emoji_5:1484364982094266428>', description: 'تغيير اسم الروم' },
  limit: { label: 'Limit', emoji: '<:emoji_19:1485476294966640781>', description: 'تعديل حد أعضاء الروم' },
  region: { label: 'Region', emoji: '<:emoji_23:1485476473153392721>', description: 'تغيير ريجن الصوت' },
  allow: { label: 'Allow', emoji: '<:emoji_21:1485476368740519986>', description: 'السماح لعضو بالدخول والرؤية' },
  reject: { label: 'Deny', emoji: '<:emoji_23:1485476405151268904>', description: 'إزالة سماح أو حظر أو مسؤول' },
  music: { label: 'Music', emoji: '<:emoji_26:1485476531818987641>', description: 'سحب بوت أغاني إلى الروم إن أمكن' },
  admin: { label: 'Admin', emoji: '<:emoji_21:1485476329171320855>', description: 'إدارة مسؤولي الروم' },
  transfer: { label: 'Transfer', emoji: '<:emoji_23:1485476446330945777>', description: 'نقل ملكية الروم' },
  actions: { label: 'Actions', emoji: '⚡', description: 'عقوبات وتحكم سريع بالأعضاء' }
};

const TEMP_SETTINGS_META = {
  category: { label: 'Category'  },
  name: { label: 'Creator Name'  },
  control: { label: 'Control Room'  },
  log: { label: 'Log Room'  },
  music: { label: 'Music Room'  },
  card_color: { label: 'Card Color'  },
  autoclean: { label: 'Auto Clean'  },
  lifetime: { label: 'Lifetime' },
  leave: { label: 'Leave Delete'},
  top: { label: 'Top',},
  controls: { label: 'Controls' },
  refresh: { label: 'Refresh'},
  close: { label: 'Close' }
};

const ACTION_OPTIONS = [
  { label: 'Mute Member', value: 'mute_member', emoji: '<:emoji_28:1485476660055638146>', description: 'إعطاء ميوت صوتي أو كتابي أو الاثنين' },
  { label: 'Unmute', value: 'unmute_member', emoji: '<:emoji_30:1485476749889503334>', description: 'إزالة الميوت عن عضو محدد' },
  { label: 'Mute All', value: 'mute_all', emoji: '<:emoji_28:1485476660055638146>', description: 'إعطاء ميوت لكل الموجودين حالياً في الروم' },
  { label: 'Unmute All', value: 'unmute_all', emoji: '<:emoji_30:1485476749889503334>', description: 'إزالة الميوت من كل الأعضاء' },
  { label: 'Kick', value: 'kick', emoji: '<:emoji_33:1485476862619680788>', description: 'طرد العضو من الروم' },
  { label: 'Ban', value: 'ban', emoji: '<:emoji_30:1485476785914122270>', description: 'حظر العضو من الروم' },
  { label: 'Unban', value: 'unban', emoji: '<:emoji_30:1485476807947063306>', description: 'فك الحظر من الروم' }
];

const REGION_OPTIONS = [
  { label: 'Auto', value: 'auto', emoji: '<:emoji_23:1485476425686323262>', description: 'أفضل ريجن تلقائياً' },
  { label: 'Brazil', value: 'brazil', emoji: '🇧🇷', description: 'Brazil' },
  { label: 'Hong Kong', value: 'hongkong', emoji: '🇭🇰', description: 'Hong Kong' },
  { label: 'India', value: 'india', emoji: '🇮🇳', description: 'India' },
  { label: 'Japan', value: 'japan', emoji: '🇯🇵', description: 'Japan' },
  { label: 'Rotterdam', value: 'rotterdam', emoji: '🇳🇱', description: 'Rotterdam' },
  { label: 'Singapore', value: 'singapore', emoji: '🇸🇬', description: 'Singapore' },
  { label: 'South Africa', value: 'southafrica', emoji: '🇿🇦', description: 'South Africa' },
  { label: 'Sydney', value: 'sydney', emoji: '🇦🇺', description: 'Sydney' },
  { label: 'US Central', value: 'us-central', emoji: '🇺🇸', description: 'US Central' },
  { label: 'US East', value: 'us-east', emoji: '🇺🇸', description: 'US East' },
  { label: 'US South', value: 'us-south', emoji: '🇺🇸', description: 'US South' },
  { label: 'US West', value: 'us-west', emoji: '🇺🇸', description: 'US West' }
];

let dataCache = null;
let runtimeClient = null;
let heartbeatHandle = null;
let registered = false;
const sessions = new Map();
const roomLifecycleJobs = new Map();
const operationLocks = new Map();
const guildAccentCache = new Map();
const topSeparatorCache = new Map();
const controlCardCache = new Map();
const runtimeTempVoiceMuteState = new Map();
let runtimeBotOwners = [];

const saveQueues = new Map();
const saveInitPromises = new Map();

function ensureDataFile() {
  fs.mkdirSync(TOP_ASSETS_DIR, { recursive: true });
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
    if (!('controlMessageId' in guildConfig)) guildConfig.controlMessageId = null;
    if (!('logChannelId' in guildConfig)) guildConfig.logChannelId = null;
    if (!('musicChannelId' in guildConfig)) guildConfig.musicChannelId = null;
    if (!('controlCardColorMode' in guildConfig)) guildConfig.controlCardColorMode = 'avatar';
    if (!('controlCardCustomColor' in guildConfig)) guildConfig.controlCardCustomColor = null;
    if (!('topChannelId' in guildConfig)) guildConfig.topChannelId = null;
    if (!('topMessageId' in guildConfig)) guildConfig.topMessageId = null;
    if (!Number.isFinite(guildConfig.topLastUpdatedAt)) guildConfig.topLastUpdatedAt = 0;
    if (!('topSeparatorImage' in guildConfig) || !guildConfig.topSeparatorImage || typeof guildConfig.topSeparatorImage !== 'object') guildConfig.topSeparatorImage = null;
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
    if (!Number.isFinite(profile.totalVoiceMs)) profile.totalVoiceMs = 0;
  }

  for (const guildRooms of Object.values(migrated.rooms)) {
    if (!guildRooms || typeof guildRooms !== 'object') continue;
    for (const roomRecord of Object.values(guildRooms)) {
      if (!roomRecord || typeof roomRecord !== 'object') continue;
      if (!roomRecord.memberSessionStarts || typeof roomRecord.memberSessionStarts !== 'object') roomRecord.memberSessionStarts = {};
      ensureRoomModerationState(roomRecord);
      if (!('ownerDisplayName' in roomRecord)) roomRecord.ownerDisplayName = null;
    }
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

/**
 * Queues a data save operation to ensure sequential processing and prevent race conditions.
 * This is crucial for maintaining data integrity when multiple asynchronous operations
 * might attempt to modify the same data concurrently.
 * @returns {Promise<any>} A promise that resolves when the save task is completed.
 */
function scheduleSave() {
  const key = 'main-data-save'; // A single key for the main data file
  const previous = saveQueues.get(key) || Promise.resolve();
  const next = previous.catch((error) => logSilentError("temp.save.queue", error)).then(() => persistData());
  saveQueues.set(key, next.finally(() => {
    if (saveQueues.get(key) === next) saveQueues.delete(key);
  }));
  return next;
}

/**
 * Persists the current dataCache to the DATA_PATH file using atomic write.
 * This function is called by the save queue to ensure ordered writes.
 */
async function persistData() {
  try {
    await writeFileAtomic(DATA_PATH, JSON.stringify(dataCache, null, 2));
  } catch (error) {
    logSilentError("temp.save.persist", error);
  }
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
      topChannelId: null,
      topMessageId: null,
      topLastUpdatedAt: 0,
      topSeparatorImage: null,
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

  if (!('topChannelId' in data.guilds[guildId])) {
    data.guilds[guildId].topChannelId = null;
    scheduleSave();
  }
  if (!('topMessageId' in data.guilds[guildId])) {
    data.guilds[guildId].topMessageId = null;
    scheduleSave();
  }
  if (!Number.isFinite(data.guilds[guildId].topLastUpdatedAt)) {
    data.guilds[guildId].topLastUpdatedAt = 0;
    scheduleSave();
  }
  if (!('topSeparatorImage' in data.guilds[guildId]) || (data.guilds[guildId].topSeparatorImage && typeof data.guilds[guildId].topSeparatorImage !== 'object')) {
    data.guilds[guildId].topSeparatorImage = null;
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
      totalVoiceMs: 0,
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
  if (!Number.isFinite(data.users[key].totalVoiceMs)) data.users[key].totalVoiceMs = 0;
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
  const record = getRoomStore(guildId)[ownerId] || null;
  if (record && (!record.memberSessionStarts || typeof record.memberSessionStarts !== 'object')) record.memberSessionStarts = {};
  if (record) ensureRoomModerationState(record);
  return record;
}

function setRoomRecord(guildId, ownerId, value) {
  if (value && (!value.memberSessionStarts || typeof value.memberSessionStarts !== 'object')) value.memberSessionStarts = {};
  if (value) ensureRoomModerationState(value);
  getRoomStore(guildId)[ownerId] = value;
  scheduleSave();
}

function deleteRoomRecord(guildId, ownerId) {
  delete getRoomStore(guildId)[ownerId];
  scheduleSave();
}

function getSessionScopeKey(scopeOrUserId, userId = null) {
  return userId ? `${scopeOrUserId}:${userId}` : String(scopeOrUserId);
}

function pruneRuntimeCaches() {
  const now = Date.now();

  for (const [key, session] of sessions.entries()) {
    if (!session || (now - (session.createdAt || 0)) > SESSION_TTL_MS) sessions.delete(key);
  }

  for (const [guildId, asset] of topSeparatorCache.entries()) {
    if (!asset?.filePath || !fs.existsSync(asset.filePath)) topSeparatorCache.delete(guildId);
  }

  if (guildAccentCache.size > 250) guildAccentCache.clear();
}

function getSession(scopeOrUserId, userId = null) {
  const sessionKey = getSessionScopeKey(scopeOrUserId, userId);
  const existing = sessions.get(sessionKey);
  if (existing && Date.now() - existing.createdAt < SESSION_TTL_MS) return existing;
  const session = {
    createdAt: Date.now(),
    settingsMessageId: null,
    settingsChannelId: null,
    tempControls: null,
    lastResolvedOwnerId: null,
    pendingTopSeparatorUpload: null
  };
  sessions.set(sessionKey, session);
  return session;
}

function sanitizeRoomName(value, fallback = 'Temp Room') {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 96);
  return cleaned || fallback;
}

function topSeparatorAttachmentName(guildId, extension = 'png') {
  return `temp-top-separator-${guildId}.${String(extension || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png'}`;
}

function inferImageExtension(contentType = '', sourceUrl = '') {
  const normalizedType = String(contentType || '').toLowerCase().split(';')[0].trim();
  const typeMap = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/avif': 'avif',
    'image/heic': 'heic',
    'image/heif': 'heif'
  };
  if (typeMap[normalizedType]) return typeMap[normalizedType];

  try {
    const pathname = new URL(sourceUrl).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) return match[1].toLowerCase();
  } catch (_) {}

  return 'png';
}

function extractImageUrlFromText(content) {
  const matches = String(content || '').match(/https?:\/\/\S+/gi) || [];
  for (const candidate of matches) {
    const cleaned = candidate.replace(/[)>.,]+$/g, '');
    try {
      const parsed = new URL(cleaned);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    } catch (_) {}
  }
  return null;
}

async function downloadImageBuffer(sourceUrl) {
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch (_) {
    return { error: '❌ الرابط غير صالح.' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { error: '❌ مسموح فقط بروابط http أو https المباشرة.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOP_SEPARATOR_FETCH_TIMEOUT_MS);
  const response = await fetch(parsed.toString(), { redirect: 'follow', signal: controller.signal }).catch(error => ({ error }));
  clearTimeout(timeout);
  if (!response || response.error || !response.ok) return { error: '❌ تعذر تحميل الصورة من المصدر المحدد.' };

  const contentType = response.headers.get('content-type') || '';
  if (contentType && !contentType.toLowerCase().startsWith('image/')) {
    return { error: '❌ الرابط لا يشير إلى صورة مباشرة.' };
  }

  const contentLength = Number(response.headers.get('content-length')) || 0;
  if (contentLength > MAX_TOP_SEPARATOR_BYTES) {
    return { error: `❌ حجم الصورة أكبر من الحد المسموح (${Math.floor(MAX_TOP_SEPARATOR_BYTES / (1024 * 1024))}MB).` };
  }

  const arrayBuffer = await response.arrayBuffer().catch(() => null);
  if (!arrayBuffer) return { error: '❌ تعذر قراءة الصورة بعد تحميلها.' };

  const buffer = Buffer.from(arrayBuffer);
  if (buffer.length > MAX_TOP_SEPARATOR_BYTES) {
    return { error: `❌ حجم الصورة بعد التحميل أكبر من الحد المسموح (${Math.floor(MAX_TOP_SEPARATOR_BYTES / (1024 * 1024))}MB).` };
  }

  return { buffer, contentType };
}

async function resolveTopSeparatorImageFromMessage(message) {
  const attachment = message.attachments.find(item => String(item.contentType || '').toLowerCase().startsWith('image/'))
    || message.attachments.find(item => /\.(png|jpe?g|webp|gif|bmp|tiff?|ico|avif|heic|heif)(\?.*)?$/i.test(item.url || ''));

  if (attachment) {
    const downloaded = await downloadImageBuffer(attachment.url);
    if (!downloaded || downloaded.error) return { error: downloaded?.error || '❌ تعذر تحميل الصورة المرفقة. حاول مجددًا.' };
    return {
      buffer: downloaded.buffer,
      contentType: downloaded.contentType || attachment.contentType || '',
      sourceUrl: attachment.url
    };
  }

  const imageUrl = extractImageUrlFromText(message.content);
  if (!imageUrl) return { error: '❌ أرسل صورة كمرفق أو رابط مباشر لصورة صالحة.' };
  const downloaded = await downloadImageBuffer(imageUrl);
  if (!downloaded || downloaded.error) return { error: downloaded?.error || '❌ تعذر تحميل الصورة من الرابط المرسل. تأكد أن الرابط مباشر وقابل للوصول.' };
  return {
    buffer: downloaded.buffer,
    contentType: downloaded.contentType || '',
    sourceUrl: imageUrl
  };
}

async function saveTopSeparatorAsset(guildId, source) {
  const extension = inferImageExtension(source.contentType, source.sourceUrl);
  const attachmentName = topSeparatorAttachmentName(guildId, extension);
  const filePath = path.join(TOP_ASSETS_DIR, attachmentName);

  await loadImage(source.buffer).catch(() => {
    throw new Error('invalid-image');
  });

  fs.mkdirSync(TOP_ASSETS_DIR, { recursive: true });

  for (const existing of fs.readdirSync(TOP_ASSETS_DIR)) {
    if (existing.startsWith(`temp-top-separator-${guildId}.`) && existing !== attachmentName) {
      fs.unlinkSync(path.join(TOP_ASSETS_DIR, existing));
    }
  }

  fs.writeFileSync(filePath, source.buffer);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size <= 0) throw new Error('save-failed');

  topSeparatorCache.set(guildId, { filePath, attachmentName, buffer: source.buffer });
  return { filePath, attachmentName };
}

function getTopSeparatorAssetMeta(config) {
  if (!config.topSeparatorImage?.fileName) return null;
  const filePath = path.join(TOP_ASSETS_DIR, config.topSeparatorImage.fileName);
  return {
    filePath,
    attachmentName: config.topSeparatorImage.fileName
  };
}

function loadTopSeparatorAsset(config, guildId) {
  const meta = getTopSeparatorAssetMeta(config);
  if (!meta || !fs.existsSync(meta.filePath)) return null;
  const cached = topSeparatorCache.get(guildId);
  if (cached && cached.filePath === meta.filePath && cached.buffer?.length) return cached;
  const buffer = fs.readFileSync(meta.filePath);
  const asset = { ...meta, buffer };
  topSeparatorCache.set(guildId, asset);
  return asset;
}

function removeTopSeparatorAsset(config, guildId) {
  const meta = getTopSeparatorAssetMeta(config);
  if (meta?.filePath && fs.existsSync(meta.filePath)) fs.unlinkSync(meta.filePath);
  topSeparatorCache.delete(guildId);
  config.topSeparatorImage = null;
  scheduleSave();
}

function canUseAdminButton(member, roomRecord) {
  return Boolean(
    member && roomRecord && (
      member.id === roomRecord.ownerId ||
      member.id === member.guild.ownerId ||
      runtimeBotOwners.includes(member.id)
    )
  );
}

function setRecentKick(roomRecord, userId, expiresAt = Date.now() + KICK_REJOIN_BLOCK_MS) {
  if (!roomRecord.recentKicks || typeof roomRecord.recentKicks !== 'object') roomRecord.recentKicks = {};
  roomRecord.recentKicks[userId] = expiresAt;
}

function clearExpiredRecentKicks(roomRecord, now = Date.now()) {
  if (!roomRecord?.recentKicks || typeof roomRecord.recentKicks !== 'object') return false;
  let changed = false;
  for (const [userId, expiresAt] of Object.entries(roomRecord.recentKicks)) {
    if (!expiresAt || expiresAt <= now) {
      delete roomRecord.recentKicks[userId];
      changed = true;
    }
  }
  return changed;
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
  if (days) parts.push(`**${days}**d`);
  if (hours) parts.push(`**${hours}**h`);
  if (minutes) parts.push(`**${minutes}**m`);
  if (seconds && parts.length < 3) parts.push(`**${seconds}** s`);
  return parts.join(' , ');
}

function formatTopVoiceDuration(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  if (!safeMs) return '**0m**';

  const totalMinutes = Math.floor(safeMs / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const hours = totalHours;
  const minutes = totalMinutes % 60;
  const seconds = Math.floor((safeMs % 60000) / 1000);
  const parts = [];

  if (hours > 0) parts.push(`**${hours}h**`);
  if (minutes > 0) parts.push(`**${minutes}m**`);
  if (!parts.length) parts.push(seconds > 0 ? `**${seconds}s**` : '**0m**');

  return parts.slice(0, 2).join(' , ');
}

function getGuildUserProfiles(guildId) {
  return Object.entries(loadData().users)
    .filter(([key]) => key.startsWith(`${guildId}:`))
    .map(([key, profile]) => ({ userId: key.split(':')[1], profile }));
}

function getRoomLabel(guild, userId, profile) {
  const roomRecord = getRoomRecord(guild.id, userId);
  const roomId = roomRecord?.channelId || null;
  const roomChannel = roomId ? guild.channels.cache.get(roomId) : null;
  if (roomChannel) return `<#${roomChannel.id}>`;
  const fallbackName = profile.lastKnownRoomName || roomRecord?.lastKnownRoomName || roomRecord?.ownerDisplayName || profile.lastKnownDisplayName || 'Unknown Room';
  return `**${sanitizeRoomName(fallbackName, 'Unknown Room')}**`;
}

function getLiveRoomVoiceMs(roomRecord, now = Date.now()) {
  if (!roomRecord?.memberSessionStarts || typeof roomRecord.memberSessionStarts !== 'object') return 0;
  return Object.values(roomRecord.memberSessionStarts).reduce((total, startedAt) => {
    const started = Number(startedAt) || 0;
    if (!started || started >= now) return total;
    return total + (now - started);
  }, 0);
}

function getTempTopEntries(guild) {
  const now = Date.now();
  return getGuildUserProfiles(guild.id)
    .map(({ userId, profile }) => {
      const roomRecord = getRoomRecord(guild.id, userId);
      const totalVoiceMs = Math.max(0, Number(profile.totalVoiceMs) || 0) + getLiveRoomVoiceMs(roomRecord, now);
      return { userId, profile, totalVoiceMs };
    })
    .filter(entry => entry.totalVoiceMs > 0)
    .sort((a, b) => b.totalVoiceMs - a.totalVoiceMs);
}

function buildTopVoiceRoomsDescription(guild, limit = 10) {
  const entries = getTempTopEntries(guild);

  if (!entries.length) {
    return {
      totalEntries: 0,
      description: [
        '**لا يوجد أي وقت صوتي مسجل للرومات المؤقتة حتى الآن.**',
        '',
        '**سيظهر التوب تلقائياً بعد تجميع الوقت داخل الرومات المؤقتة.**'
      ].join('\n')
    };
  }

  const currentEntries = entries.slice(0, limit);

  return {
    totalEntries: entries.length,
    description: currentEntries.map(({ userId, profile, totalVoiceMs }, index) => [
      `**#${index + 1}**`,
      `**Owner :** <@${userId}>`,
      `**Room :** ${getRoomLabel(guild, userId, profile)}`,
      `**Room Voice :** ${formatTopVoiceDuration(totalVoiceMs)}`,
      ''
    ].join('\n')).join('\n\n')
  };
}


async function reorderTempCategoryByTop(guild) {
  const config = getGuildConfig(guild.id);
  if (!config?.categoryId) return;

  const category = guild.channels.cache.get(config.categoryId)
    || await guild.channels.fetch(config.categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) return;

  const creatorChannelId = config.creatorChannelId;
  const rankedRoomIds = getTempTopEntries(guild)
    .map(entry => getRoomRecord(guild.id, entry.userId)?.channelId)
    .filter(Boolean);

  const seen = new Set();
  const orderedIds = [];
  if (creatorChannelId) {
    orderedIds.push(creatorChannelId);
    seen.add(creatorChannelId);
  }

  for (const channelId of rankedRoomIds) {
    if (seen.has(channelId)) continue;
    orderedIds.push(channelId);
    seen.add(channelId);
  }

  const fallbackIds = guild.channels.cache
    .filter(channel => channel.parentId === category.id && channel.type === ChannelType.GuildVoice && !seen.has(channel.id))
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map(channel => channel.id);

  orderedIds.push(...fallbackIds);

  for (let index = 0; index < orderedIds.length; index += 1) {
    const channel = guild.channels.cache.get(orderedIds[index])
      || await guild.channels.fetch(orderedIds[index]).catch(() => null);
    if (!channel || channel.parentId !== category.id) continue;
    await channel.setPosition(index).catch(() => {});
  }
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

function ensureRoomModerationState(roomRecord) {
  if (!roomRecord || typeof roomRecord !== 'object') return;
  if (!roomRecord.recentKicks || typeof roomRecord.recentKicks !== 'object') roomRecord.recentKicks = {};
  if (!roomRecord.bulkMuteAllStates || typeof roomRecord.bulkMuteAllStates !== 'object') roomRecord.bulkMuteAllStates = {};
  if (!roomRecord.bulkMuteAllAffected || typeof roomRecord.bulkMuteAllAffected !== 'object') roomRecord.bulkMuteAllAffected = {};
  for (const scope of ['voice', 'text', 'all']) {
    if (!Object.prototype.hasOwnProperty.call(roomRecord.bulkMuteAllStates, scope)) roomRecord.bulkMuteAllStates[scope] = null;
    if (!Array.isArray(roomRecord.bulkMuteAllAffected[scope])) roomRecord.bulkMuteAllAffected[scope] = [];
  }
}

function getActiveBulkMuteAllState(roomRecord, scope, now = Date.now()) {
  ensureRoomModerationState(roomRecord);
  const state = roomRecord?.bulkMuteAllStates?.[scope] || null;
  if (!state) return null;
  if (state.expiresAt && state.expiresAt <= now) {
    roomRecord.bulkMuteAllStates[scope] = null;
    roomRecord.bulkMuteAllAffected[scope] = [];
    return null;
  }
  return state;
}

function addBulkMuteAllAffectedUser(roomRecord, scope, userId) {
  ensureRoomModerationState(roomRecord);
  if (!roomRecord.bulkMuteAllAffected[scope].includes(userId)) roomRecord.bulkMuteAllAffected[scope].push(userId);
}

function clearBulkMuteAllScope(roomRecord, scope) {
  ensureRoomModerationState(roomRecord);
  roomRecord.bulkMuteAllStates[scope] = null;
  roomRecord.bulkMuteAllAffected[scope] = [];
}

function clearExpiredBulkMuteAllStates(roomRecord, now = Date.now()) {
  ensureRoomModerationState(roomRecord);
  let changed = false;
  for (const scope of ['voice', 'text', 'all']) {
    const state = roomRecord.bulkMuteAllStates[scope];
    if (state?.expiresAt && state.expiresAt <= now) {
      clearBulkMuteAllScope(roomRecord, scope);
      changed = true;
    }
  }
  return changed;
}

function shouldBulkMuteMember(member, ownerId, profile, applyToManagers, actorId) {
  if (!member || member.user?.bot) return false;
  if (member.id === ownerId) return false;
  if (isTempPunishmentImmune(member.id, member.guild)) return false;
  if (profile.managers.includes(actorId) && actorId !== ownerId) {
    return !profile.managers.includes(member.id);
  }
  if (!applyToManagers && profile.managers.includes(member.id)) return false;
  return true;
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

function isTempPunishmentImmune(targetId, guild) {
  return Boolean(targetId && guild && (targetId === guild.ownerId || runtimeBotOwners.includes(targetId)));
}

function isProtectedModerationTarget(member, ownerId, profile, actorId = null) {
  if (!member) return false;
  return Boolean(
    member.id === ownerId ||
    member.user?.bot ||
    isTempPunishmentImmune(member.id, member.guild) ||
    (profile.managers.includes(member.id) && actorId !== ownerId)
  );
}

function validateModerationTarget({ member, user, ownerId, profile, actionType, actorId }) {
  const targetId = member?.id || user?.id || null;
  const guild = member?.guild || null;
  if (!targetId) return { ok: false, message: '❌ تعذر تحديد العضو المطلوب.' };
  if (targetId === ownerId) return { ok: false, message: '❌ لا يمكن استهداف مالك الروم من هذا المسار.' };
  if (member?.user?.bot || user?.bot) return { ok: false, message: `❌ لا يمكن ${actionType} بوت من هذا المسار.` };
  if (isTempPunishmentImmune(targetId, member?.guild || guild)) {
    return { ok: false, message: `❌ لا يمكن ${actionType} مالك السيرفر أو أحد أونرات البوت من هذا المسار.` };
  }
  if (profile.managers.includes(targetId) && actorId !== ownerId) {
    return { ok: false, message: `❌ لا يمكن ${actionType} مسؤول الروم إلا بواسطة المالك مباشرة.` };
  }
  return { ok: true };
}

function hasRoomScopedMute(profile, userId, scope = 'all') {
  if (scope === 'voice') return (profile.voiceMutedUsers || []).includes(userId);
  if (scope === 'text') return (profile.textMutedUsers || []).includes(userId);
  return (profile.voiceMutedUsers || []).includes(userId) || (profile.textMutedUsers || []).includes(userId);
}

function getTempVoiceMuteStateKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function rememberTempVoiceMuteState(guildId, userId, roomId) {
  runtimeTempVoiceMuteState.set(getTempVoiceMuteStateKey(guildId, userId), roomId);
}

function forgetTempVoiceMuteState(guildId, userId) {
  runtimeTempVoiceMuteState.delete(getTempVoiceMuteStateKey(guildId, userId));
}

function didTempRoomMuteMember(guildId, userId) {
  return runtimeTempVoiceMuteState.has(getTempVoiceMuteStateKey(guildId, userId));
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

async function syncDiscordVoiceMute(member, roomChannel, shouldMute, reason = 'Temp room voice mute sync') {
  if (!member?.voice || !roomChannel) return false;
  const inRoom = member.voice.channelId === roomChannel.id;
  const trackedByTemp = didTempRoomMuteMember(member.guild.id, member.id);

  if (shouldMute) {
    if (!inRoom) return false;
    rememberTempVoiceMuteState(member.guild.id, member.id, roomChannel.id);
    if (member.voice.serverMute) return false;
    return member.voice.setMute(true, reason).then(() => true).catch(() => false);
  }

  if (!trackedByTemp) return false;
  forgetTempVoiceMuteState(member.guild.id, member.id);
  if (!member.voice.serverMute) return false;
  return member.voice.setMute(false, reason).then(() => true).catch(() => false);
}

async function enforcePrivilegedMuteBypass(guild, ownerId, profile, roomChannel, member) {
  if (!member || !roomChannel || member.voice?.channelId !== roomChannel.id) return false;
  if (isTempPunishmentImmune(member.id, guild) || !member.permissions?.has?.(PermissionsBitField.Flags.Administrator)) return false;
  if (!hasRoomScopedMute(profile, member.id, 'voice') && !hasRoomScopedMute(profile, member.id, 'all')) {
    return syncDiscordVoiceMute(member, roomChannel, false, 'Temp room voice mute removed');
  }

  const changed = await syncDiscordVoiceMute(member, roomChannel, true, 'Temp room voice mute enforced');
  if (changed) {
    const user = await guild.client.users.fetch(member.id).catch(() => null);
    await notifyUser(user, { content: `تم تطبيق ميوت صوتي عليك داخل روم <#${roomChannel.id}> من ديسكورد نفسه حتى انتهاء الميوت الخاص بهذا الروم.` });
  }
  return changed;
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

function getModeratableRoomMembers(roomChannel, ownerId, profile, actorId = null) {
  return roomChannel.members
    .filter(member => !isProtectedModerationTarget(member, ownerId, profile, actorId))
    .sort((a, b) => getRoomMemberPriority(a, ownerId, profile) - getRoomMemberPriority(b, ownerId, profile));
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

function getRoomOccupancyCount(roomChannel, { includeOwner = true, ownerId = null } = {}) {
  if (!roomChannel?.members) return 0;
  return roomChannel.members.filter(member => {
    if (member.user.bot) return false;
    if (!includeOwner && ownerId && member.id === ownerId) return false;
    return true;
  }).size;
}


function shouldStartOwnerLeaveCountdown(roomChannel, ownerId) {
  return getRoomOccupancyCount(roomChannel, { includeOwner: false, ownerId }) === 0;
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

function createTopVoiceEmbed(guild) {
  const iconUrl = guild.iconURL({ extension: 'png', size: 256 }) || undefined;
  const topData = buildTopVoiceRoomsDescription(guild);
  const config = getGuildConfig(guild.id);
  const separatorAsset = loadTopSeparatorAsset(config, guild.id);
  const embed = colorManager.createEmbed()
    .setTitle('**Top**')
    .setAuthor({ name: `${guild.name} • Temp Voice `, iconURL: iconUrl })
    .setDescription(topData.description)
    .setThumbnail(iconUrl)
    .setFooter({ text: `By Ahmed. • ${guild.name}` })
    .setTimestamp(new Date());

  if (separatorAsset) embed.setImage(`attachment://${separatorAsset.attachmentName}`);

  return {
    embed,
    separatorAsset,
    topData
  };
}

function getTopBoardChannelPermissionError(channel, guildMember) {
  if (!channel?.isTextBased?.()) return '❌ روم التوب يجب أن يكون رومًا نصيًا صالحًا.';
  if (!guildMember?.permissionsIn) return '❌ تعذر التحقق من صلاحيات البوت داخل روم التوب.';

  const permissions = channel.permissionsFor(guildMember);
  if (!permissions) return '❌ تعذر قراءة صلاحيات البوت داخل روم التوب.';

  const required = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
    PermissionsBitField.Flags.AttachFiles
  ];
  const missing = permissions.missing(required);
  if (!missing.length) return null;

  return `❌ البوت لا يملك الصلاحيات المطلوبة في روم التوب: ${missing.join(', ')}.`;
}

async function refreshTopVoiceMessage(guild, preferredChannel = null) {
  const config = getGuildConfig(guild.id);
  const previousChannelId = config.topChannelId;
  const previousMessageId = config.topMessageId;
  const targetChannel = preferredChannel
    || (config.topChannelId ? guild.channels.cache.get(config.topChannelId) || await guild.channels.fetch(config.topChannelId).catch(() => null) : null);
  if (!targetChannel?.isTextBased?.()) return { error: '❌ روم التوب المحدد غير صالح أو غير نصي.' };

  const permissionError = getTopBoardChannelPermissionError(targetChannel, guild.members.me);
  if (permissionError) return { error: permissionError };

  const { embed, separatorAsset } = createTopVoiceEmbed(guild);
  const files = separatorAsset
    ? [new AttachmentBuilder(separatorAsset.buffer, { name: separatorAsset.attachmentName })]
    : [];
  const message = await targetChannel.send({ embeds: [embed], files, components: [] }).catch(() => null);
  if (!message) return { error: '❌ تعذر إرسال رسالة التوب في الروم المحدد.' };

  const previousChannel = previousChannelId ? guild.channels.cache.get(previousChannelId) || await guild.channels.fetch(previousChannelId).catch(() => null) : null;
  const previousMessage = previousChannel?.isTextBased?.() && previousMessageId
    ? await previousChannel.messages.fetch(previousMessageId).catch(() => null)
    : null;
  if (previousMessage && previousMessage.id !== message.id) await previousMessage.delete().catch(error => console.error('[temp] Failed to delete previous top message:', error));

  config.topMessageId = message.id;
  config.topChannelId = targetChannel.id;
  config.topLastUpdatedAt = Date.now();
  scheduleSave();

  await reorderTempCategoryByTop(guild).catch(() => null);
  return { message };
}

function registerRoomPresenceStart(roomRecord, memberId, at = Date.now()) {
  if (!roomRecord.memberSessionStarts || typeof roomRecord.memberSessionStarts !== 'object') roomRecord.memberSessionStarts = {};
  if (!roomRecord.memberSessionStarts[memberId]) roomRecord.memberSessionStarts[memberId] = at;
}

function flushRoomPresenceForMember(guildId, ownerId, roomRecord, memberId, at = Date.now()) {
  if (!roomRecord?.memberSessionStarts?.[memberId]) return 0;
  const startedAt = Number(roomRecord.memberSessionStarts[memberId]) || 0;
  delete roomRecord.memberSessionStarts[memberId];
  if (!startedAt || at <= startedAt) return 0;
  const elapsed = at - startedAt;
  const ownerProfile = getUserProfile(guildId, ownerId);
  ownerProfile.totalVoiceMs = (ownerProfile.totalVoiceMs || 0) + elapsed;
  scheduleSave();
  return elapsed;
}

function reconcileRoomPresenceSessions(guildId, ownerId, roomRecord, roomChannel, now = Date.now()) {
  if (!roomRecord?.memberSessionStarts || typeof roomRecord.memberSessionStarts !== 'object') roomRecord.memberSessionStarts = {};
  const liveMemberIds = new Set([...(roomChannel.members?.keys?.() || [])].filter(memberId => {
    const member = roomChannel.members.get(memberId);
    return member && !member.user.bot;
  }));

  for (const memberId of liveMemberIds) registerRoomPresenceStart(roomRecord, memberId, now);
  for (const memberId of Object.keys(roomRecord.memberSessionStarts)) {
    if (!liveMemberIds.has(memberId)) flushRoomPresenceForMember(guildId, ownerId, roomRecord, memberId, now);
  }
}

function finalizeRoomPresenceSessions(guildId, ownerId, roomRecord, roomChannel, now = Date.now()) {
  if (!roomRecord?.memberSessionStarts || typeof roomRecord.memberSessionStarts !== 'object') roomRecord.memberSessionStarts = {};
  const members = [...(roomChannel?.members?.values?.() || [])].filter(member => !member.user.bot);
  for (const member of members) registerRoomPresenceStart(roomRecord, member.id, now);
  for (const memberId of Object.keys(roomRecord.memberSessionStarts)) flushRoomPresenceForMember(guildId, ownerId, roomRecord, memberId, now);
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
  return canUseAdminButton(member, roomRecord);
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
  const formatChannelReference = channelId => channelId ? `<#${channelId}>` : '**غير محدد**';

  return colorManager.createEmbed()
    .setTitle('**Temp Voice Settings**')
    .setDescription([
      '**إعدادات نظام الرومات الصوتية المؤقتة.**',
      '',
      `**Category:** ${config.categoryId ? `<#${config.categoryId}>` : '**غير محددة**'}`,
      `**Creator Room:** ${config.creatorChannelId ? `<#${config.creatorChannelId}>` : '**سيتم إنشاؤه عند اختيار الكاتوقري**'}`,
      `**Creator Name:** **${sanitizeRoomName(config.creatorChannelName, DEFAULT_CREATOR_NAME)}**`,
      `**Control Room:** ${formatChannelReference(config.controlChannelId)}`,
      `**General Control Message:** ${config.controlMessageId ? `**جاهزة**` : '**غير منشأة**'}`,
      `**Log Room:** ${formatChannelReference(config.logChannelId)}`,
      `**Music Bot Room:** ${formatChannelReference(config.musicChannelId)}`,
      `**Top Board:** ${formatChannelReference(config.topChannelId)}`,
      `**Top Divider Image:** ${config.topSeparatorImage?.fileName ? '**محفوظة**' : '**غير مرفوعة**'}`,
      `**Controller Card Color:** ${getControlCardColorSummary(config)}`,
      `**Auto Clean:** ${boolText(config.autoCleanEnabled)} — ${formatDuration(config.autoCleanIntervalMs)}`,
      `**Room Lifetime:** ${formatDuration(config.maxRoomAgeMs)}`,
      `**Delete After Owner Leaves:** ${formatDuration(config.deleteAfterLeaveMs)}`,
      '',
      '**الأزرار المفعلة في لوحة التحكم العامة :**',
      settingStateText(config)
    ].join('\n'))
    .setFooter({ text: `Temp Settings • ${actorId}` })
    .setTimestamp();
}

function buildSettingsRows(userId) {
  const makeSettingsButton = key => {
    const button = new ButtonBuilder()
      .setCustomId(`temp_settings_${key}:${userId}`)
      .setLabel(TEMP_SETTINGS_META[key].label)
      .setStyle(getTempButtonStyle());

    if (TEMP_SETTINGS_META[key].emoji) button.setEmoji(TEMP_SETTINGS_META[key].emoji);
    return button;
  };

  return [
    new ActionRowBuilder().addComponents(
      makeSettingsButton('category'),
      makeSettingsButton('name'),
      makeSettingsButton('control'),
      makeSettingsButton('log'),
      makeSettingsButton('music')
    ),
    new ActionRowBuilder().addComponents(
      makeSettingsButton('card_color'),
      makeSettingsButton('autoclean'),
      makeSettingsButton('lifetime'),
      makeSettingsButton('leave'),
      makeSettingsButton('top')
    ),
    new ActionRowBuilder().addComponents(
      makeSettingsButton('controls'),
      makeSettingsButton('refresh'),
      makeSettingsButton('close')
    )
  ];
}

async function updateSettingsPanelMessage(guild, userId) {
  const session = getSession(guild.id, userId);
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

async function drawCircularServerIcon(ctx, guild, centerX, centerY, size, accent) {
  const ringSize = size + 10;
  const ringGradient = ctx.createLinearGradient(centerX - ringSize, centerY - ringSize, centerX + ringSize, centerY + ringSize);
  ringGradient.addColorStop(0, toRgba(mixHexColors(accent, '#ffffff', 0.35), 0.95));
  ringGradient.addColorStop(1, toRgba(mixHexColors(accent, '#0a1323', 0.45), 0.92));

  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, ringSize / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = ringGradient;
  ctx.shadowColor = toRgba(accent, 0.24);
  ctx.shadowBlur = 18;
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, (size + 4) / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(10,16,31,0.88)';
  ctx.fill();
  ctx.restore();

  const iconUrl = guild.iconURL({ extension: 'png', size: 256 });
  if (!iconUrl) return false;

  const image = await loadImage(iconUrl).catch(() => null);
  if (!image) return false;

  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(image, centerX - (size / 2), centerY - (size / 2), size, size);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  return true;
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
  const cacheKey = `control_card_${guild.id}_${config.controlCardColorMode}_${config.controlCardCustomColor}_${JSON.stringify(config.enabledControls)}`;

  if (controlCardCache.has(cacheKey)) {
    return controlCardCache.get(cacheKey);
  }

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
  const cardTitle = `${guild?.name || 'Servername'} Voice Controller`;
  const cardTitleSize = fitTextSize(ctx, cardTitle, width - 220, 72, 42, LATIN_FONT_FAMILY);
  ctx.font = `bold ${cardTitleSize}px ${LATIN_FONT_FAMILY}`;
  ctx.fillText(cardTitle, width / 2, 168);
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
  const footerLineY = panelY + panelHeight - 78;
  const footerPadding = 66;
  const footerBlockWidth = 420;
  const leftFooterX = panelX + footerPadding;
  const rightFooterRightX = panelX + panelWidth - footerPadding;
  const footerLabelFont = `600 27px ${LATIN_FONT_FAMILY}`;
  const footerValueFont = `700 30px ${LATIN_FONT_FAMILY}`;
  const footerIconCenterX = width / 2;
  const footerIconCenterY = panelY + panelHeight - 94;
  const footerIconSize = 58;

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

  await drawCircularServerIcon(ctx, guild, footerIconCenterX, footerIconCenterY, footerIconSize, accent);

  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.52)';
  ctx.font = `600 19px ${LATIN_FONT_FAMILY}`;
  ctx.fillText(CONTROL_CARD_SIGNATURE, width / 2, panelY + panelHeight - 30);

  ctx.shadowBlur = 0;
  const attachment = new AttachmentBuilder(canvas.toBuffer('image/png'), { name: `temp-general-control-${guild.id}.png` });
  controlCardCache.set(cacheKey, attachment);
  return attachment;
}

function buildGeneralControlRows(guildId) {
  const config = getGuildConfig(guildId);
  const enabled = key => config.enabledControls[key] !== false;
  const rows = [];

  const createButton = key => new ButtonBuilder()
    .setCustomId(`temp_room_${key}`)
    .setLabel(CONTROL_META[key].label)
    .setEmoji(CONTROL_META[key].emoji)
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
  return '**Temp Voice**';
}

async function ensureGuildControlPanel(guild) {
  const config = getGuildConfig(guild.id);
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
      continue;
    }

    const shouldMuteVoice = hasRoomScopedMute(effectiveProfile, member.id, 'voice') || hasRoomScopedMute(effectiveProfile, member.id, 'all');
    await syncDiscordVoiceMute(member, roomChannel, shouldMuteVoice, shouldMuteVoice ? 'Temp room voice mute enforced' : 'Temp room voice mute removed');
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
      ownerLeftAt: null,
      memberSessionStarts: {}
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
  await reorderTempCategoryByTop(guild);
  await scheduleRoomLifecycleJob(guild.id, member.id);
  await ensureGuildControlPanel(guild);
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

function findTempRoomOwnerIdsByChannelIds(guildId, channelIds = []) {
  const wanted = new Set((channelIds || []).filter(Boolean));
  if (!wanted.size) return [];
  return Object.entries(getRoomStore(guildId))
    .filter(([, roomRecord]) => roomRecord && wanted.has(roomRecord.channelId))
    .map(([ownerId]) => ownerId);
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
  const channel = roomRecord.channelId ? guild.channels.cache.get(roomRecord.channelId) || await guild.channels.fetch(roomRecord.channelId).catch(() => null) : null;
  const deadlines = [];
  if (config.maxRoomAgeMs > 0) deadlines.push(roomRecord.createdAt + config.maxRoomAgeMs);
  if (roomRecord.ownerLeftAt && (!channel || shouldStartOwnerLeaveCountdown(channel, ownerId))) deadlines.push(roomRecord.ownerLeftAt + config.deleteAfterLeaveMs);
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
      await updateGeneralPanelStatus(liveGuild);
      return;
    }
    if (currentRecord.ownerLeftAt && Date.now() - currentRecord.ownerLeftAt >= liveConfig.deleteAfterLeaveMs && shouldStartOwnerLeaveCountdown(channel, ownerId)) {
      await deleteTempRoom(liveGuild, ownerId, 'Owner left timeout reached');
      await updateGeneralPanelStatus(liveGuild);
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
    finalizeRoomPresenceSessions(guild.id, ownerId, roomRecord, channel, Date.now());
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

async function resolveManagedRoom(interaction, encodedOwnerId = null, { silent = false, allowAdminOverride = false } = {}) {
  const guild = interaction.guild;
  const member = interaction.member;
  const hasAdminOverride = allowAdminOverride && (runtimeBotOwners.includes(member?.id) || member?.id === member?.guild?.ownerId);

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
      if (canManageRoom(member, candidateRecord, profile) || (hasAdminOverride && canUseAdminButton(member, candidateRecord))) {
        ownerId = candidateOwnerId;
        roomRecord = candidateRecord;
        break;
      }
    }
  }

  if (!roomRecord) {
    for (const [candidateOwnerId, candidateRecord] of Object.entries(getRoomStore(guild.id))) {
      const profile = getUserProfile(guild.id, candidateOwnerId);
      if (canManageRoom(member, candidateRecord, profile) || (hasAdminOverride && canUseAdminButton(member, candidateRecord))) {
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
  if (!canManageRoom(member, roomRecord, profile) && !(hasAdminOverride && canUseAdminButton(member, roomRecord))) {
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

  getSession(member.guild.id, member.id).lastResolvedOwnerId = ownerId;
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

async function updateGeneralPanelStatus(guild) {
  await ensureGuildControlPanel(guild);
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
  profile.lastKnownRoomName = nextName;
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
  pruneRuntimeCaches();
  const data = loadData();
  const trackedGuildIds = new Set([
    ...Object.keys(data.rooms || {}),
    ...Object.keys(data.guilds || {})
  ]);

  for (const guildId of trackedGuildIds) {
    const guild = runtimeClient.guilds.cache.get(guildId) || await runtimeClient.guilds.fetch(guildId).catch(() => null);
    if (!guild) continue;
    const config = getGuildConfig(guildId);

    for (const [ownerId, roomRecord] of Object.entries(getRoomStore(guildId))) {
      const channel = guild.channels.cache.get(roomRecord.channelId) || await guild.channels.fetch(roomRecord.channelId).catch(() => null);
      if (!channel) {
        deleteRoomRecord(guildId, ownerId);
        continue;
      }
      if (clearExpiredRecentKicks(roomRecord, Date.now()) || clearExpiredBulkMuteAllStates(roomRecord, Date.now())) setRoomRecord(guildId, ownerId, roomRecord);
      reconcileRoomPresenceSessions(guildId, ownerId, roomRecord, channel, Date.now());
      setRoomRecord(guildId, ownerId, roomRecord);

      const ownerPresent = channel.members.has(ownerId);
      const shouldCountDown = !ownerPresent && shouldStartOwnerLeaveCountdown(channel, ownerId);
      let roomStateChanged = false;

      if (ownerPresent && roomRecord.ownerLeftAt) {
        roomRecord.ownerLeftAt = null;
        roomStateChanged = true;
      } else if (shouldCountDown && !roomRecord.ownerLeftAt) {
        roomRecord.ownerLeftAt = Date.now();
        roomStateChanged = true;
      } else if (!shouldCountDown && roomRecord.ownerLeftAt) {
        roomRecord.ownerLeftAt = null;
        roomStateChanged = true;
      }

      if (roomStateChanged) setRoomRecord(guildId, ownerId, roomRecord);

      if (config.maxRoomAgeMs > 0 && Date.now() - roomRecord.createdAt >= config.maxRoomAgeMs) {
        await deleteTempRoom(guild, ownerId, 'Temp room lifetime reached');
        continue;
      }

      if (!ownerPresent && roomRecord.ownerLeftAt && Date.now() - roomRecord.ownerLeftAt >= config.deleteAfterLeaveMs && shouldStartOwnerLeaveCountdown(channel, ownerId)) {
        await deleteTempRoom(guild, ownerId, 'Owner left timeout reached');
        continue;
      }

      const liveProfile = getUserProfile(guildId, ownerId);
      const accessChanged = await cleanupExpiredAccess(guild, ownerId, liveProfile, channel);
      const muteChanged = await cleanupExpiredMutes(guild, ownerId, liveProfile, channel);
      const banChanged = await cleanupExpiredBans(guild, ownerId, liveProfile, channel);
      const inviteChanged = await cleanupExpiredInvites(guild, ownerId, liveProfile, channel);
      const roomNameChanged = await processRotatingRoomName(guild, ownerId, liveProfile, channel);
      if (roomStateChanged || accessChanged || muteChanged || banChanged || inviteChanged || roomNameChanged) {
        await applyRoomState(channel, ownerId);
      }

      if (config.autoCleanEnabled && config.autoCleanIntervalMs > 0 && typeof channel.messages?.fetch === 'function') {
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

    await ensureCreatorChannel(guild).catch(error => console.error('[temp] ensureCreatorChannel failed:', error));
    if (config.controlChannelId) await ensureGuildControlPanel(guild).catch(error => console.error('[temp] ensureGuildControlPanel failed:', error));
    if (config.topChannelId && (!config.topLastUpdatedAt || (Date.now() - config.topLastUpdatedAt) >= TOP_REFRESH_MS)) {
      const topRefreshResult = await refreshTopVoiceMessage(guild).catch(error => {
        console.error('[temp] refreshTopVoiceMessage failed:', error);
        return null;
      });
      if (topRefreshResult?.error) console.error('[temp] refreshTopVoiceMessage:', topRefreshResult.error);
    }
  }
}

async function handleVoiceStateUpdate(oldState, newState) {
  if (!newState.member || newState.member.user.bot) return;
  const guild = newState.guild;
  const config = getGuildConfig(guild.id);

  if (newState.channelId && newState.channelId === config.creatorChannelId) {
    await createOrMoveToTempRoom(newState.member);
  }

  const affectedOwnerIds = findTempRoomOwnerIdsByChannelIds(guild.id, [oldState.channelId, newState.channelId]);
  if (!affectedOwnerIds.length) return;

  for (const ownerId of affectedOwnerIds) {
    const roomRecord = getRoomRecord(guild.id, ownerId);
    if (!roomRecord) continue;
    const channel = guild.channels.cache.get(roomRecord.channelId) || await guild.channels.fetch(roomRecord.channelId).catch(() => null);
    if (!channel) {
      deleteRoomRecord(guild.id, ownerId);
      continue;
    }
    const joinedTemp = newState.channelId === roomRecord.channelId && oldState.channelId !== roomRecord.channelId;
    const leftTemp = oldState.channelId === roomRecord.channelId && newState.channelId !== roomRecord.channelId;
    const isInTemp = newState.channelId === roomRecord.channelId;

    const ownerProfile = getUserProfile(guild.id, ownerId);
    // Strict ban check: if a banned user is in the temp room, disconnect them immediately.
    if (isInTemp && ownerProfile.bannedUsers.includes(newState.member.id)) {
      const user = await guild.client.users.fetch(newState.member.id).catch(() => null);
      await notifyUser(user, { content: `أنت محظور من روم <#${channel.id}> ولا يمكنك الدخول إليه.` });
      await newState.member.voice.disconnect("Banned from temp room").catch(() => newState.member.voice.setChannel(null).catch(() => null));
      continue; // Skip further processing for this room as the user is banned
    }
    const ownerPresent = channel.members.has(ownerId);
    const shouldCountDown = !ownerPresent && shouldStartOwnerLeaveCountdown(channel, ownerId);
    const previousOwnerLeftAt = roomRecord.ownerLeftAt;
    if (ownerPresent) {
      roomRecord.ownerLeftAt = null;
    } else if (shouldCountDown && !roomRecord.ownerLeftAt) {
      roomRecord.ownerLeftAt = Date.now();
    } else if (!shouldCountDown && roomRecord.ownerLeftAt) {
      roomRecord.ownerLeftAt = null;
    }
    roomRecord.ownerDisplayName = guild.members.cache.get(ownerId)?.displayName || roomRecord.ownerDisplayName;
    setRoomRecord(guild.id, ownerId, roomRecord);
    await scheduleRoomLifecycleJob(guild.id, ownerId);
    if (joinedTemp || leftTemp || previousOwnerLeftAt !== roomRecord.ownerLeftAt) {
      await applyRoomState(channel, ownerId);
    }

    if (!previousOwnerLeftAt && roomRecord.ownerLeftAt) {
      await logTempRoomState(guild, {
        title: '🚶 **خروج مالك الروم**',
        description: shouldCountDown ? '**خرج مالك الروم المؤقت من رومه وبدأ عداد الحذف التلقائي لأن الروم أصبح بلا أعضاء حقيقيين.**' : '**خرج مالك الروم المؤقت من رومه لكن الروم بقي فعالاً لوجود أعضاء حقيقيين داخله.**',
        ownerId,
        roomId: channel.id,
        roomName: channel.name,
        roomRecord,
        ownerLeftAt: roomRecord.ownerLeftAt,
        extra: `**حالة العداد:** ${shouldCountDown ? '**يعمل الآن**' : '**متوقف حتى يخرج آخر عضو غير بوت**'}
**مهلة الحذف الحالية:** ${formatDuration(config.deleteAfterLeaveMs)}
**عدد الأعضاء المتبقين (يشمل البوتات):** **${channel.members.size}**
**عدد الأعضاء الحقيقيين بدون المالك:** **${getRoomOccupancyCount(channel, { includeOwner: false, ownerId })}**`
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

    if (clearExpiredRecentKicks(roomRecord, Date.now()) || clearExpiredBulkMuteAllStates(roomRecord, Date.now())) setRoomRecord(guild.id, ownerId, roomRecord);
    if (joinedTemp && roomRecord.recentKicks?.[newState.member.id] && roomRecord.recentKicks[newState.member.id] > Date.now()) {
      const user = await guild.client.users.fetch(newState.member.id).catch(() => null);
      await notifyUser(user, { content: `تم طردك مؤقتاً من روم <#${channel.id}>. حاول الدخول مرة أخرى بعد ${Math.max(1, Math.ceil((roomRecord.recentKicks[newState.member.id] - Date.now()) / 1000))} ثانية.` });
      await newState.member.voice.disconnect('Recently kicked from temp room').catch(() => newState.member.voice.setChannel(null).catch(() => null));
      continue;
    }
    for (const scope of ['voice', 'text', 'all']) {
      const bulkMuteState = getActiveBulkMuteAllState(roomRecord, scope, Date.now());
      if (!joinedTemp || !bulkMuteState) continue;
      if (!shouldBulkMuteMember(newState.member, ownerId, ownerProfile, bulkMuteState.applyToManagers, bulkMuteState.by)) continue;
      applyMuteScopeToProfile(ownerProfile, newState.member.id, scope, bulkMuteState.expiresAt || null, bulkMuteState.by);
      addBulkMuteAllAffectedUser(roomRecord, scope, newState.member.id);
      scheduleSave();
      setRoomRecord(guild.id, ownerId, roomRecord);
      await applyRoomState(channel, ownerId);
    }
    if (joinedTemp && await enforcePrivilegedMuteBypass(guild, ownerId, ownerProfile, channel, newState.member)) {
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
    if (isInTemp) {
      const shouldMuteVoice = hasRoomScopedMute(ownerProfile, newState.member.id, 'voice') || hasRoomScopedMute(ownerProfile, newState.member.id, 'all');
      await syncDiscordVoiceMute(newState.member, channel, shouldMuteVoice, shouldMuteVoice ? 'Temp room voice mute re-applied' : 'Temp room voice mute removed');
    }
    const joinedInvite = joinedTemp ? getActiveInvite(ownerProfile, newState.member.id) : null;
    if (joinedInvite && !joinedInvite.joinedAt) {
      joinedInvite.joinedAt = Date.now();
      scheduleSave();
    }
    if (joinedTemp) {
      registerRoomPresenceStart(roomRecord, newState.member.id, Date.now());
      setRoomRecord(guild.id, ownerId, roomRecord);
    }
    if (leftTemp) {
      const leavingId = oldState.member?.id;
      if (oldState.member) {
        await syncDiscordVoiceMute(oldState.member, channel, false, 'Temp room voice mute removed after leaving room');
      }
      flushRoomPresenceForMember(guild.id, ownerId, roomRecord, leavingId, Date.now());
      setRoomRecord(guild.id, ownerId, roomRecord);
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
  runtimeBotOwners = Array.isArray(BOT_OWNERS) ? [...BOT_OWNERS] : [];
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

  const session = getSession(message.guild.id, message.author.id);
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

  if (action === 'temp_settings_top') {
    const session = getSession(interaction.guild.id, userId);
    session.pendingTopSeparatorUpload = {
      guildId: interaction.guild.id,
      channelId: interaction.channelId,
      requestedAt: Date.now()
    };
    await replyEphemeral(interaction, '🖼️ أرسل الآن صورة الخط الفاصل كمرفق أو كرابط مباشر داخل هذه الروم. يمكنك أيضًا إرسال `remove` أو `حذف` لإزالة الصورة الحالية..');
    return true;
  }

  if (action === 'temp_settings_card_color') {
    await interaction.reply({
      content: '**اختر مصدر لون صورة الكنترول : لون صورة السيرفر أو لون مخصص من اختيارك.**',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`temp_settings_card_color_avatar:${userId}`).setLabel('Guild Color').setEmoji('🖼️').setStyle(getTempButtonStyle()),
        new ButtonBuilder().setCustomId(`temp_settings_card_color_custom:${userId}`).setLabel('Other Color').setEmoji('🎨').setStyle(getTempButtonStyle())
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
    const session = getSession(interaction.guild.id, userId);
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
              emoji: CONTROL_META[key].emoji,
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
    const session = getSession(interaction.guild.id, userId);
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
      ensureGuildControlPanel(interaction.guild)
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

  if (action === 'temp_settings_top_select') {
    const selectedChannel = interaction.guild.channels.cache.get(interaction.values[0]) || await interaction.guild.channels.fetch(interaction.values[0]).catch(() => null);
    const topResult = await refreshTopVoiceMessage(interaction.guild, selectedChannel);
    if (!topResult?.message) {
      await interaction.update({ content: topResult?.error || '❌ تم حفظ صورة الخط ولكن تعذر إرسال رسالة التوب في الروم المحدد.', components: [] }).catch(error => console.error('[temp] Failed to update top settings select failure message:', error));
      return true;
    }

    await interaction.update({ content: `✅ تم حفظ صورة الخط وإرسال لوحة التوب الجديدة في <#${interaction.values[0]}>.`, components: [] }).catch(error => console.error('[temp] Failed to update top settings select success message:', error));
    await updateSettingsPanelMessage(interaction.guild, userId);
    await sendTempLog(interaction.guild, {
      title: '🏆 **تحديث لوحة التوب**',
      description: '**تم حفظ صورة الخط الفاصل وتحديد روم لوحة التوب وإعادة إرسال الرسالة.**',
      fields: [
        { name: '**المنفذ**', value: `<@${interaction.user.id}>`, inline: true },
        { name: '**روم التوب**', value: `<#${interaction.values[0]}>`, inline: true },
        { name: '**الصورة**', value: '**تم حفظها بنجاح**', inline: true }
      ]
    });
    return true;
  }

  if (action === 'temp_settings_controls_select') {
    const session = getSession(interaction.guild.id, userId);
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
  const access = resolverResult || await resolveManagedRoom(interaction, null, {
    allowAdminOverride: ['temp_room_admin', 'temp_room_transfer'].includes(action)
  });
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
    const moved = await musicBot.voice.setChannel(roomChannel).then(() => true).catch(() => false);
    if (!moved) {
      await editEphemeral(interaction, `❌ تعذر سحب بوت الأغاني ${musicBot.user.username} إلى الروم حالياً.`);
      return true;
    }

    let nicknameRenamed = true;
    const targetNickname = sanitizeRoomName(roomChannel.name, musicBot.displayName || musicBot.user.username).slice(0, 32);
    if (musicBot.manageable && musicBot.nickname !== targetNickname) {
      nicknameRenamed = await musicBot.setNickname(targetNickname, 'Sync music bot nickname with temp room name').then(() => true).catch(() => false);
    } else if (!musicBot.manageable) {
      nicknameRenamed = false;
    }

    if (!nicknameRenamed && typeof roomChannel.send === 'function') {
      await roomChannel.send(`❌ فشل تغيير اسم بوت الميوزك **${musicBot.user.username}** ليطابق اسم الروم **${roomChannel.name}**.`).catch(() => {});
    }

    await editEphemeral(interaction, `✅ تم سحب بوت الأغاني ${musicBot.user.username} إلى الروم.${nicknameRenamed ? ' وتمت مزامنة الاسم بنجاح.' : ' لكن فشل تغيير الاسم إلى اسم الروم.'}`);
    await logTempRoomState(guild, {
      title: '🎵 **سحب بوت أغاني**',
      description: '**تم تنفيذ محاولة سحب بوت أغاني إلى الروم المؤقت.**',
      actorId: interaction.user.id,
      ownerId,
      roomId: roomChannel.id,
      roomName: roomChannel.name,
      roomRecord,
      extra: `**البوت:** **${musicBot.user.username}**
**روم المصدر:** <#${sourceChannel.id}>
**مزامنة الاسم:** ${nicknameRenamed ? '**نجحت**' : '**فشلت**'}`
    });
    return true;
  }

  if (action === 'temp_room_admin') {
    if (!canUseAdminButton(interaction.member, roomRecord)) {
      await editEphemeral(interaction, '❌ زر Admin متاح فقط لمالك الروم أو مالك السيرفر أو أونرات البوت.');
      return true;
    }
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
      await editEphemeral(interaction, '❌ فقط مالك الروم أو مالك السيرفر أو أونرات البوت يقدر ينقل الملكية.');
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
    const { ownerId: resolvedOwnerId, profile, roomChannel, roomRecord } = access;

    if (action === 'temp_room_action_scope_mute_member') {
      const roomMembers = getModeratableRoomMembers(roomChannel, resolvedOwnerId, profile, interaction.user.id);
      if (!roomMembers.size) {
        await replyEphemeral(interaction, 'ℹ️ لا يوجد أعضاء داخل الروم لاختيارهم حالياً.');
        return true;
      }
      const session = getSession(interaction.guild.id, interaction.user.id);
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
      const session = getSession(interaction.guild.id, interaction.user.id);
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
      const targets = [...getModeratableRoomMembers(roomChannel, resolvedOwnerId, profile, interaction.user.id).values()]
        .filter(member => shouldBulkMuteMember(member, resolvedOwnerId, profile, false, interaction.user.id))
        .map(member => member.id);
      if (!targets.length) {
        await replyEphemeral(interaction, 'ℹ️ لا يوجد أعضاء حالياً داخل الروم لتطبيق الميوت عليهم.');
        return true;
      }
      const session = getSession(interaction.guild.id, interaction.user.id);
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
      clearExpiredRecentKicks(roomRecord, Date.now());
      const currentMemberIds = new Set([...(roomChannel.members?.keys?.() || [])].filter(memberId => !roomChannel.members.get(memberId)?.user?.bot));
      const targets = (roomRecord.bulkMuteAllAffected?.[scope] || []).filter(userId => currentMemberIds.has(userId));
      if (!targets.length) {
        await replyEphemeral(interaction, `ℹ️ لا يوجد أعضاء داخل الروم لديهم ميوت ${getScopeLabel(scope)} ناتج عن Mute All حالياً.`);
        return true;
      }
      for (const userId of targets) {
        removeMuteScopeFromProfile(profile, userId, scope);
      }
      clearBulkMuteAllScope(roomRecord, scope);
      profile.moderationHistory = pushLimitedHistory(profile.moderationHistory, { action: `unmute_all_${scope}`, userId: 'all', by: interaction.user.id, at: Date.now() });
      setRoomRecord(interaction.guild.id, resolvedOwnerId, roomRecord);
      await applyRoomState(roomChannel, resolvedOwnerId);
      await replyEphemeral(interaction, `✅ تم فك الميوت ${getScopeLabel(scope)} عن جميع الموجودين حالياً في الروم.`);
      return true;
    }
  }

  if (action === 'temp_room_action_apply_mute_all' || action === 'temp_room_action_apply_mute_all_skip_managers') {
    const scope = args[1];
    const access = await resolveManagedRoom(interaction, ownerId);
    if (!access) return true;
    const { ownerId: resolvedOwnerId, profile, roomChannel, roomRecord } = access;
    const session = getSession(interaction.guild.id, interaction.user.id);
    const pending = session.pendingMuteAllDecision;
    if (!pending || pending.ownerId !== resolvedOwnerId || pending.scope !== scope) {
      await replyEphemeral(interaction, '❌ انتهت جلسة تأكيد ميوت الكل. أعد المحاولة من جديد.');
      return true;
    }

    const applyToManagers = action === 'temp_room_action_apply_mute_all';
    const currentTargets = [...getModeratableRoomMembers(roomChannel, resolvedOwnerId, profile, interaction.user.id).values()]
      .filter(member => shouldBulkMuteMember(member, resolvedOwnerId, profile, applyToManagers, interaction.user.id));
    if (!currentTargets.length) {
      session.pendingMuteAllDecision = null;
      await replyEphemeral(interaction, 'ℹ️ لا يوجد أعضاء مطابقون داخل الروم حالياً لتطبيق ميوت الكل.');
      return true;
    }

    ensureRoomModerationState(roomRecord);
    roomRecord.bulkMuteAllStates[scope] = {
      by: interaction.user.id,
      expiresAt: pending.expiresAt,
      applyToManagers,
      startedAt: Date.now()
    };
    roomRecord.bulkMuteAllAffected[scope] = [];

    for (const member of currentTargets) {
      applyMuteScopeToProfile(profile, member.id, scope, pending.expiresAt, interaction.user.id);
      addBulkMuteAllAffectedUser(roomRecord, scope, member.id);
      profile.moderationHistory = pushLimitedHistory(profile.moderationHistory, { action: `mute_all_${scope}`, userId: member.id, by: interaction.user.id, at: Date.now(), expiresAt: pending.expiresAt });
      await enforcePrivilegedMuteBypass(interaction.guild, resolvedOwnerId, profile, roomChannel, member);
    }

    session.pendingMuteAllDecision = null;
    setRoomRecord(interaction.guild.id, resolvedOwnerId, roomRecord);
    await applyRoomState(roomChannel, resolvedOwnerId);
    await interaction.update({
      content: `✅ تم إعطاء ميوت ${getScopeLabel(scope)} لكل الموجودين حالياً في الروم${applyToManagers ? ' بما فيهم المسؤولون' : ' مع استثناء المسؤولين'}، وسيُطبق أيضًا على أي عضو جديد يدخل هذا الروم أثناء استمرار العقوبة.`,
      components: []
    }).catch(() => {});
    return true;
  }

  if (action === 'temp_room_action_renew_mute') {
    const scope = args[1];
    const access = await resolveManagedRoom(interaction, ownerId);
    if (!access) return true;
    const session = getSession(interaction.guild.id, interaction.user.id);
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
    const session = getSession(interaction.guild.id, interaction.user.id);
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
    const session = getSession(interaction.guild.id, interaction.user.id);
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
    const { ownerId: resolvedOwnerId, profile, roomChannel, roomRecord } = access;
    const targets = [...getModeratableRoomMembers(roomChannel, resolvedOwnerId, profile, interaction.user.id).values()].map(member => member.id);
    const kickedIds = [];
    for (const targetId of targets) {
      const member = await interaction.guild.members.fetch(targetId).catch(() => null);
      if (!member || member.voice.channelId !== roomChannel.id) continue;
      const moved = await disconnectMemberFromVoice(member, 'Kicked from temp room');
      if (!moved) continue;
      setRecentKick(roomRecord, targetId);
      profile.moderationHistory = pushLimitedHistory(profile.moderationHistory, { action: 'kick', userId: targetId, by: interaction.user.id, at: Date.now() });
      kickedIds.push(targetId);
    }
    if (!kickedIds.length) {
      await replyEphemeral(interaction, '❌ تعذر طرد أي عضو فعلياً من الروم.');
      return true;
    }
    setRoomRecord(interaction.guild.id, resolvedOwnerId, roomRecord);
    await replyEphemeral(interaction, `✅ تم طرد ${kickedIds.length} عضو من الروم ومنع رجوعهم لمدة ${Math.ceil(KICK_REJOIN_BLOCK_MS / 1000)} ثانية.`);
    return true;
  }

  if (action === 'temp_room_admin_add' || action === 'temp_room_admin_remove') {
    const access = await resolveManagedRoom(interaction, ownerId, { allowAdminOverride: true });
    if (!access) return true;
    if (!canManageAdminPanel(interaction.member, access.roomRecord)) {
      await replyEphemeral(interaction, '❌ فقط مالك الروم أو مالك السيرفر أو أونرات البوت يمكنه تعديل قائمة المسؤولين.');
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

  return performGeneralAction(interaction, action, ownerId ? await resolveManagedRoom(interaction, ownerId, {
    allowAdminOverride: ['temp_room_admin', 'temp_room_transfer'].includes(action)
  }) : null);
}

async function handleRoomSelect(interaction) {
  const { action, args } = parseCustomId(interaction.customId);
  const ownerId = args[0] || null;
  const access = action === 'temp_room_actions'
    ? await resolveManagedRoom(interaction)
    : await resolveManagedRoom(interaction, ownerId, { allowAdminOverride: ['temp_room_admin_add_select', 'temp_room_admin_remove_select', 'temp_room_transfer_select'].includes(action) });
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
    const session = getSession(interaction.guild.id, interaction.user.id);
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
      const roomMembers = getModeratableRoomMembers(roomChannel, resolvedOwnerId, profile, interaction.user.id);
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
    const session = getSession(interaction.guild.id, interaction.user.id);
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
    const session = getSession(interaction.guild.id, interaction.user.id);
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
      setRecentKick(roomRecord, targetId);
      profile.moderationHistory = pushLimitedHistory(profile.moderationHistory, { action: 'kick', userId: targetId, by: interaction.user.id, at: Date.now() });
      kickedIds.push(targetId);
    }
    if (!kickedIds.length) {
      await replyEphemeral(interaction, '❌ لا يوجد أعضاء مطابقون داخل الروم حالياً للطرد.');
      return true;
    }
    setRoomRecord(interaction.guild.id, resolvedOwnerId, roomRecord);
    await replyEphemeral(interaction, `✅ تم طرد ${kickedIds.map(id => `<@${id}>`).join('، ')} من الروم ومنع رجوعهم لمدة ${Math.ceil(KICK_REJOIN_BLOCK_MS / 1000)} ثانية.`);
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
    const session = getSession(interaction.guild.id, interaction.user.id);
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
      await replyEphemeral(interaction, '❌ غير مسموح. هذا الإجراء متاح فقط لمالك الروم أو مالك السيرفر أو أونرات البوت.');
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
      const session = getSession(interaction.guild.id, interaction.user.id);
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
  const access = await resolveManagedRoom(interaction, ownerId, { allowAdminOverride: action === 'temp_room_admin_add_duration_modal' });
  if (!access) return true;
  const { profile, roomChannel } = access;

  if (action === 'temp_room_allow_duration_modal') {
    const session = getSession(interaction.guild.id, interaction.user.id);
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
    const session = getSession(interaction.guild.id, interaction.user.id);
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
    const session = getSession(interaction.guild.id, interaction.user.id);
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
    const session = getSession(interaction.guild.id, interaction.user.id);
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
    const targetMember = await interaction.guild.members.fetch(pending.targetId).catch(() => null);
    await enforcePrivilegedMuteBypass(interaction.guild, ownerId, profile, roomChannel, targetMember);
    await replyEphemeral(interaction, `✅ تم إعطاء ميوت ${getScopeLabel(pending.scope)} لـ <@${pending.targetId}>.`);
    return true;
  }

  if (action === 'temp_room_action_mute_all_modal') {
    const session = getSession(interaction.guild.id, interaction.user.id);
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
    const currentTargets = [...getModeratableRoomMembers(roomChannel, ownerId, profile, interaction.user.id).values()]
      .filter(member => shouldBulkMuteMember(member, ownerId, profile, false, interaction.user.id));
    if (!currentTargets.length) {
      session.pendingMuteAll = null;
      await replyEphemeral(interaction, 'ℹ️ لا يوجد أعضاء مطابقون داخل الروم حالياً لتطبيق ميوت الكل.');
      return true;
    }

    if (profile.managers.includes(interaction.user.id) && interaction.user.id !== ownerId) {
      ensureRoomModerationState(access.roomRecord);
      access.roomRecord.bulkMuteAllStates[pending.scope] = {
        by: interaction.user.id,
        expiresAt,
        applyToManagers: false,
        startedAt: Date.now()
      };
      access.roomRecord.bulkMuteAllAffected[pending.scope] = [];
      for (const member of currentTargets) {
        applyMuteScopeToProfile(profile, member.id, pending.scope, expiresAt, interaction.user.id);
        addBulkMuteAllAffectedUser(access.roomRecord, pending.scope, member.id);
        profile.moderationHistory = pushLimitedHistory(profile.moderationHistory, { action: `mute_all_${pending.scope}`, userId: member.id, by: interaction.user.id, at: Date.now(), expiresAt });
        await enforcePrivilegedMuteBypass(interaction.guild, ownerId, profile, roomChannel, member);
      }
      session.pendingMuteAll = null;
      setRoomRecord(interaction.guild.id, ownerId, access.roomRecord);
      await applyRoomState(roomChannel, ownerId);
      await replyEphemeral(interaction, `✅ تم إعطاء ميوت ${getScopeLabel(pending.scope)} لكل الموجودين حالياً في الروم مع استثناء المالك وباقي المسؤولين، وسيُطبق أيضًا على الداخلين الجدد أثناء استمرار العقوبة.`);
      return true;
    }

    session.pendingMuteAllDecision = {
      ownerId,
      scope: pending.scope,
      expiresAt
    };
    session.pendingMuteAll = null;
    await replyEphemeral(interaction, 'اختر هل تريد تطبيق Mute All على المسؤولين أيضًا أم لا.', {
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`temp_room_action_apply_mute_all:${ownerId}:${pending.scope}`).setLabel('تطبيق على المسؤولين').setStyle(getTempButtonStyle()),
        new ButtonBuilder().setCustomId(`temp_room_action_apply_mute_all_skip_managers:${ownerId}:${pending.scope}`).setLabel('استثناء المسؤولين').setStyle(getTempButtonStyle())
      )]
    });
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
    profile.lastKnownRoomName = names[0];
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

async function handlePendingTopSeparatorMessage(message) {
  if (!message.guild || message.author.bot) return;

  const session = sessions.get(getSessionScopeKey(message.guild.id, message.author.id));
  if (!session?.pendingTopSeparatorUpload) return;

  const pending = session.pendingTopSeparatorUpload;
  if (pending.guildId !== message.guild.id || pending.channelId !== message.channel.id) return;
  if ((Date.now() - pending.requestedAt) > SESSION_TTL_MS) {
    session.pendingTopSeparatorUpload = null;
    return;
  }

  if (!isGuildAdmin(message.member)) {
    session.pendingTopSeparatorUpload = null;
    await message.reply({ content: '❌ لم تعد تملك صلاحية إدارة إعدادات Temp.' }).catch(error => console.error('[temp] Failed to reply to unauthorized top separator message:', error));
    return;
  }

  const normalizedContent = String(message.content || '').trim().toLowerCase();
  if (['remove', 'reset', 'default', 'حذف', 'ازالة', 'إزالة'].includes(normalizedContent)) {
    const config = getGuildConfig(message.guild.id);
    removeTopSeparatorAsset(config, message.guild.id);
    session.pendingTopSeparatorUpload = null;
    await message.reply({
      content: '✅ تم حذف صورة الخط الفاصل الحالية. الآن اختر روم التوب لإرسال الرسالة بدون صورة فاصلة.',
      components: [new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`temp_settings_top_select:${message.author.id}`)
          .setPlaceholder('اختر روم التوب')
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(1)
          .setMaxValues(1)
      )]
    }).catch(error => console.error('[temp] Failed to send top separator removal confirmation:', error));
    return;
  }

  const resolved = await resolveTopSeparatorImageFromMessage(message);
  if (resolved?.error) {
    await message.reply({ content: resolved.error }).catch(error => console.error('[temp] Failed to reply with top separator validation error:', error));
    return;
  }

  let savedAsset;
  try {
    savedAsset = await saveTopSeparatorAsset(message.guild.id, resolved);
  } catch (error) {
    const failureText = error?.message === 'invalid-image'
      ? '❌ الملف المرسل ليس صورة صالحة أو غير مدعوم من معالج الصور.'
      : '❌ تعذر حفظ صورة الخط الفاصل. حاول مجددًا بصورة أو رابط آخر.';
    await message.reply({ content: failureText }).catch(replyError => console.error('[temp] Failed to reply with top separator save error:', replyError));
    return;
  }

  const config = getGuildConfig(message.guild.id);
  config.topSeparatorImage = {
    fileName: savedAsset.attachmentName,
    updatedAt: Date.now()
  };
  scheduleSave();

  session.pendingTopSeparatorUpload = null;

  await message.delete().catch(() => {});
  await message.channel.send({
    content: `<@${message.author.id}> ✅ تم حفظ صورة الخط الفاصل بنجاح. الآن اختر روم التوب الذي تريد إرسال الرسالة داخله.`,
    components: [new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`temp_settings_top_select:${message.author.id}`)
        .setPlaceholder('اختر روم التوب')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1)
        .setMaxValues(1)
    )]
  }).catch(error => console.error('[temp] Failed to reply after saving top separator image:', error));
}

async function handleTempRoomModerationMessage(message) {
  if (!message.guild || message.author.bot) return;

  for (const [ownerId, roomRecord] of Object.entries(getRoomStore(message.guild.id))) {
    if (roomRecord.channelId !== message.channel.id) continue;
    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member || isTempPunishmentImmune(member.id, message.guild) || !member.permissions?.has?.(PermissionsBitField.Flags.Administrator)) return;

    const profile = getUserProfile(message.guild.id, ownerId);
    if (!hasRoomScopedMute(profile, member.id, 'text') && !hasRoomScopedMute(profile, member.id, 'all')) return;

    await message.delete().catch(() => {});
    const user = await message.guild.client.users.fetch(member.id).catch(() => null);
    await notifyUser(user, { content: `تم حذف رسالتك داخل روم <#${message.channel.id}> لأن لديك ميوت كتابي فعال خاص بهذا الروم.` });
    return;
  }
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
  client.on('messageCreate', handlePendingTopSeparatorMessage);
  client.on('messageCreate', handleTempRoomModerationMessage);

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
