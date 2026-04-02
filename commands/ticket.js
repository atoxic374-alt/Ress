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
  TextInputStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MessageFlags
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage, registerFont } = require('canvas');
const { registerTicketInteractionRouter } = require('../utils/ticketInteractionRouter');
const colorManager = require('../utils/colorManager');
const { getDatabase } = require('../utils/database');
const { getResponsibilitiesSnapshot } = require('../utils/responsibilitiesStore');

const name = 'ticket';
const aliases = ['تكت', 'tclose', 'اغلاق', 'قفل', 'اقفال', 'myticket', 'نقاطي', 'tadd', 'اضافه', 'اضافة', 'إضافة', 'tremove', 'ازاله', 'ازالة', 'إزالة', 'tchange', 'تغيير', 'تحويل', 'ttop', 'نقاط', 'tname', 'اسم', 'تسميه', 'تسمية', 'remind', 'تنبيه', 'استدعاء', 'points', 'tm', 'treset', 'tmreset', 'tblock'];
const dataPath = path.join(__dirname, '..', 'data', 'ticketConfig.json');
const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
const ticketImagesDir = path.join(__dirname, '..', 'data', 'ticket_images');
const pointsPath = path.join(__dirname, '..', 'data', 'points.json');
const ticketSearchSessions = new Map();
const pointsAdjustSessions = new Map();
const memberFetchInFlight = new Map();
const ticketFeedbackSessions = new Map();
const feedbackPromptSessions = new Map();
const botOwnersCache = new Set();

let handlersRegistered = false;
const pingCooldowns = new Map();

let feedbackFontsRegistered = false;
function ensureFeedbackFontsRegistered() {
  if (feedbackFontsRegistered) return;
  const regularPath = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  const boldPath = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  try {
    if (fs.existsSync(regularPath)) registerFont(regularPath, { family: 'Cairo', weight: 'normal' });
    if (fs.existsSync(boldPath)) registerFont(boldPath, { family: 'Cairo', weight: 'bold' });
    feedbackFontsRegistered = true;
  } catch (error) {
    logSilentError('feedback.font.register', error);
  }
}
const ticketClaimLocks = new Set();
const ticketOpenRequestLocks = new Set();
const activeTicketSetupSessions = new Map();
const recentTicketCommandMessages = new Set();
const TICKET_SEARCH_SESSION_TTL_MS = 30 * 60 * 1000;
const PING_COOLDOWN_RETENTION_MS = 60 * 60 * 1000;
const CLOSE_DELETE_DELAY_MS = 3 * 1000;
const PING_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_POINTS_AUDIT_ENTRIES = 5000;
const MAX_MANAGER_AUDIT_ENTRIES = 5000;
const FEEDBACK_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const TICKET_STATE_TABLES_READY = Symbol.for('ticket.state.tables.ready');
const STATE_KEY_STORE = 'ticket.store';
const STATE_KEY_POINTS = 'ticket.points';
const STATE_KEY_RESPONSIBILITIES = 'ticket.responsibilities';
const stateWriteQueues = new Map();
const stateInitPromises = new Map();
const STATE_SNAPSHOT_QUEUE_KEY = '__ticket-state-snapshot__';
const storeCache = {
  [STATE_KEY_STORE]: null,
  [STATE_KEY_POINTS]: null,
  [STATE_KEY_RESPONSIBILITIES]: null
};

/**
 * Queues a state write operation to ensure sequential processing and prevent race conditions.
 * This is crucial for maintaining data integrity when multiple asynchronous operations
 * might attempt to modify the same state concurrently.
 * @param {string} key - The key identifying the state being written (e.g., STATE_KEY_POINTS, session ID).
 * @param {Function} task - An asynchronous function that performs the actual write operation.
 * @returns {Promise<any>} A promise that resolves when the task is completed.
 */
function queueStateWrite(key, task) {
  // Get the previous pending write operation for this key, or a resolved promise if none.
  const previous = stateWriteQueues.get(key) || Promise.resolve();
  // Chain the new task to the previous one, ensuring sequential execution.
  // Any errors in previous tasks are silently logged but don't block subsequent tasks.
  const next = previous.catch((error) => logSilentError("suppressed", error)).then(task);
  // Store the new pending task.
  stateWriteQueues.set(key, next.finally(() => {
    // Once the task completes (successfully or with error), remove it from the queue
    // if it's still the latest task for this key.
    if (stateWriteQueues.get(key) === next) stateWriteQueues.delete(key);
  }));
  return next;
}

function getTicketDb() {
  return getDatabase();
}

async function ensureTicketStateTables() {
  const db = getTicketDb();
  if (db[TICKET_STATE_TABLES_READY]) return db;
  await db.run(`CREATE TABLE IF NOT EXISTS ticket_state (
    state_key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`).catch((error) => logSilentError('ticket.state.table', error));
  await db.run(`CREATE TABLE IF NOT EXISTS ticket_runtime_session (
    session_type TEXT NOT NULL,
    session_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    expires_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_type, session_id)
  )`).catch((error) => logSilentError('ticket.session.table', error));
  db[TICKET_STATE_TABLES_READY] = true;
  return db;
}

function execTicketDb(dbManager, sql) {
  return new Promise((resolve, reject) => {
    dbManager.db.exec(sql, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function parseStoredJson(raw, fallback = {}) {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function replaceCachedState(key, nextValue = {}) {
  if (!storeCache[key] || typeof storeCache[key] !== 'object') storeCache[key] = {};
  for (const existingKey of Object.keys(storeCache[key])) delete storeCache[key][existingKey];
  Object.assign(storeCache[key], nextValue && typeof nextValue === 'object' ? nextValue : {});
  return storeCache[key];
}

/**
 * Primes the state cache for a given key, prioritizing data from SQLite and migrating from JSON if necessary.
 * This function ensures that the cache is populated with the most up-to-date persistent state.
 * It also handles the initial migration of data from legacy JSON files to the SQLite database
 * for improved performance and consistency.
 * @param {string} key - The state key (e.g., STATE_KEY_POINTS).
 * @param {string} filePath - The path to the legacy JSON file for initial migration.
 * @returns {Promise<object>} A promise that resolves with the cached state object.
 */
function primeStateCache(key, filePath) {
  if (stateInitPromises.has(key)) return stateInitPromises.get(key);
  const pending = ensureTicketStateTables().then(async (db) => {
    // Attempt to load from SQLite first for speed and consistency
    const row = await db.get("SELECT value FROM ticket_state WHERE state_key = ?", [key]).catch(() => null);
    const parsedDbValue = parseStoredJson(row?.value, null);
    if (parsedDbValue && typeof parsedDbValue === "object") {
      replaceCachedState(key, parsedDbValue);
      return storeCache[key];
    }

    // If not found in SQLite, try to load from the legacy JSON file (migration step)
    const fileValue = await fs.promises.readFile(filePath, "utf8")
      .then((raw) => parseStoredJson(raw, {}))
      .catch(() => ({}));
    replaceCachedState(key, fileValue);
    // If data was found in the JSON file, queue a write to persist it to SQLite
    // This effectively migrates the data and ensures future loads are from SQLite.
    if (Object.keys(fileValue).length) {
      await queueStateWrite(STATE_SNAPSHOT_QUEUE_KEY, () => persistStateSnapshot(key, filePath, fileValue));
    }
    return storeCache[key];
  }).catch((error) => {
    logSilentError(`ticket.state.hydrate.${key}`, error);
    return storeCache[key];
  });
  stateInitPromises.set(key, pending);
  return pending;
}

/**
 * Ensures the in-memory cache for a given state key is hydrated. It prioritizes loading from SQLite.
 * If the cache is not yet initialized or is an invalid type, it will be initialized.
 * This function ensures that subsequent reads from the cache are as up-to-date as possible
 * given the internal modification flow (via saveCachedState).
 * @param {string} key - The state key (e.g., STATE_KEY_POINTS).
 * @param {string} filePath - The fallback JSON file path.
 * @returns {object} The cached state object.
 */
function hydrateStateCache(key, filePath) {
  if (!storeCache[key] || typeof storeCache[key] !== 'object') {
    storeCache[key] = {};
  }
  // primeStateCache will attempt to load from SQLite first, then fallback to JSON.
  // It also handles the initial migration of JSON data to SQLite.
  primeStateCache(key, filePath).catch((error) => logSilentError('suppressed', error));
  return storeCache[key];
}

async function persistStateSnapshot(key, filePath, value) {
  const db = await ensureTicketStateTables();
  const now = Date.now();
  await execTicketDb(db, 'BEGIN IMMEDIATE TRANSACTION');
  try {
    await db.run(
      `INSERT INTO ticket_state (state_key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(state_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value ?? {}), now]
    );
    await execTicketDb(db, 'COMMIT');
  } catch (error) {
    await execTicketDb(db, 'ROLLBACK').catch((error) => logSilentError('suppressed', error));
    throw error;
  }
}

/**
 * Saves the given value to the in-memory cache and queues a write operation to persist it to SQLite.
 * This ensures that the in-memory cache is immediately updated for consistency, and the disk write
 * happens asynchronously to maintain performance.
 * @param {string} key - The state key.
 * @param {string} filePath - The JSON file path (used for initial migration if needed).
 * @param {object} value - The state object to save.
 */
function saveCachedState(key, filePath, value) {
  storeCache[key] = value; // Update in-memory cache immediately
  queueStateWrite(STATE_SNAPSHOT_QUEUE_KEY, () => persistStateSnapshot(key, filePath, value)).catch((error) => {
    logSilentError(`ticket.state.save.${key}`, error);
  });
}

/**
 * Saves a runtime session to the SQLite database, ensuring data persistence and synchronization.
 * Uses a write queue to prevent race conditions and ensure atomic updates.
 * @param {string} sessionType - The type of the session (e.g., 'ticket-setup').
 * @param {string} sessionId - The unique ID of the session.
 * @param {object} payload - The data payload of the session.
 * @param {number|null} ttlMs - Time-to-live in milliseconds for the session, or null for no expiration.
 */
function saveRuntimeSession(sessionType, sessionId, payload, ttlMs = null) {
  const expiresAt = Number.isFinite(ttlMs) ? Date.now() + ttlMs : null;
  queueStateWrite(`${sessionType}:${sessionId}`, async () => {
    const db = await ensureTicketStateTables();
    await db.run(
      `INSERT INTO ticket_runtime_session (session_type, session_id, payload, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_type, session_id) DO UPDATE SET
         payload = excluded.payload,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
      [sessionType, sessionId, JSON.stringify(payload ?? {}), expiresAt, Date.now()]
    );
  }).catch((error) => logSilentError(`ticket.session.save.${sessionType}`, error));
}

/**
 * Loads a runtime session from the SQLite database.
 * It also handles the expiration of sessions, deleting them if they are past their TTL.
 * @param {string} sessionType - The type of the session.
 * @param {string} sessionId - The unique ID of the session.
 * @returns {Promise<object|null>} A promise that resolves with the session payload, or null if not found or expired.
 */
async function loadRuntimeSession(sessionType, sessionId) {
  const db = await ensureTicketStateTables();
  const row = await db.get(
    "SELECT payload, expires_at FROM ticket_runtime_session WHERE session_type = ? AND session_id = ?",
    [sessionType, sessionId]
  ).catch(() => null);
  if (!row) return null;
  if (row.expires_at && Number(row.expires_at) <= Date.now()) {
    deleteRuntimeSession(sessionType, sessionId);
    return null;
  }
  return parseStoredJson(row.payload, null);
}

function deleteRuntimeSession(sessionType, sessionId) {
  queueStateWrite(`${sessionType}:${sessionId}`, async () => {
    const db = await ensureTicketStateTables();
    await db.run('DELETE FROM ticket_runtime_session WHERE session_type = ? AND session_id = ?', [sessionType, sessionId]);
  }).catch((error) => logSilentError(`ticket.session.delete.${sessionType}`, error));
}

function pruneRuntimeSessions(sessionType, now = Date.now()) {
  queueStateWrite(`prune:${sessionType || 'all'}`, async () => {
    const db = await ensureTicketStateTables();
    if (sessionType) {
      await db.run('DELETE FROM ticket_runtime_session WHERE session_type = ? AND expires_at IS NOT NULL AND expires_at <= ?', [sessionType, now]);
      return;
    }
    await db.run('DELETE FROM ticket_runtime_session WHERE expires_at IS NOT NULL AND expires_at <= ?', [now]);
  }).catch((error) => logSilentError(`ticket.session.prune.${sessionType || 'all'}`, error));
}

primeStateCache(STATE_KEY_STORE, dataPath).catch((error) => logSilentError('suppressed', error));
primeStateCache(STATE_KEY_POINTS, pointsPath).catch((error) => logSilentError('suppressed', error));
primeStateCache(STATE_KEY_RESPONSIBILITIES, responsibilitiesPath).catch((error) => logSilentError('suppressed', error));

function logSilentError(scope, error) {
  const msg = error?.message || error;
  console.warn(`[ticket] ${scope}:`, msg);
}

async function runConcurrentTasks(tasks = [], scope = 'task.batch') {
  const settled = await Promise.allSettled(tasks.filter(Boolean));
  const failed = settled.filter((item) => item.status === 'rejected');
  if (failed.length) {
    logSilentError(scope, `failed=${failed.length}`);
  }
  return settled;
}

async function editOverwriteFast(channel, targetId, permissions, timeoutMs = 8000) {
  if (!channel || !targetId) return null;
  return withTimeout(
    channel.permissionOverwrites.edit(targetId, permissions)
      .catch((error) => {
        logSilentError('permission.edit', error);
        return null;
      }),
    timeoutMs
  );
}


async function runTransferParallelPipeline(stages = {}, scope = 'transfer.pipeline') {
  const entries = Object.entries(stages).filter(([, tasks]) => {
    if (Array.isArray(tasks)) return tasks.length > 0;
    return Boolean(tasks);
  });
  if (!entries.length) return [];

  const started = entries.map(([stageName, tasks]) => {
    const list = Array.isArray(tasks) ? tasks : [tasks];
    const normalized = list
      .filter(Boolean)
      .map((task) => (typeof task === 'function' ? task() : task));
    return runConcurrentTasks(normalized, `${scope}.${stageName}`);
  });

  return Promise.allSettled(started);
}

async function withTimeout(promise, timeoutMs = 2500) {
  let timeoutRef;
  const timeoutPromise = new Promise((resolve) => {
    timeoutRef = setTimeout(() => resolve(null), timeoutMs);
  });
  const result = await Promise.race([promise, timeoutPromise]).catch(() => null);
  clearTimeout(timeoutRef);
  return result;
}

async function resolveGuildMember(guild, userId, timeoutMs = 2500) {
  if (!guild || !userId) return null;
  const cached = guild.members.cache.get(userId);
  if (cached) return cached;
  const key = `${guild.id}:${userId}`;
  if (!memberFetchInFlight.has(key)) {
    memberFetchInFlight.set(key, guild.members.fetch(userId).catch((error) => {
      const errMsg = String(error?.message || error || '');
      if (!/Unknown Member/i.test(errMsg)) {
        logSilentError('guild.member.fetch', error);
      }
      return null;
    }).finally(() => {
      memberFetchInFlight.delete(key);
    }));
  }
  return withTimeout(memberFetchInFlight.get(key), timeoutMs);
}

function pruneTicketSearchSessions(now = Date.now()) {
  for (const [sessionId, session] of ticketSearchSessions.entries()) {
    if (!session?.createdAt || (now - Number(session.createdAt)) > TICKET_SEARCH_SESSION_TTL_MS) {
      ticketSearchSessions.delete(sessionId);
      deleteRuntimeSession('ticket-search', sessionId);
    }
  }
  pruneRuntimeSessions('ticket-search', now);
}

function prunePingCooldowns(now = Date.now()) {
  for (const [key, ts] of pingCooldowns.entries()) {
    if (!ts || (now - Number(ts)) > PING_COOLDOWN_RETENTION_MS) {
      pingCooldowns.delete(key);
      deleteRuntimeSession('ticket-ping', key);
    }
  }
  pruneRuntimeSessions('ticket-ping', now);
}


async function getPingCooldownValue(cooldownKey) {
  if (pingCooldowns.has(cooldownKey)) return Number(pingCooldowns.get(cooldownKey) || 0);
  const persisted = await loadRuntimeSession('ticket-ping', cooldownKey).catch(() => null);
  const at = Number(persisted?.at || 0);
  if (at) pingCooldowns.set(cooldownKey, at);
  return at;
}

function setPingCooldownValue(cooldownKey, at) {
  pingCooldowns.set(cooldownKey, at);
  saveRuntimeSession('ticket-ping', cooldownKey, { at }, PING_COOLDOWN_RETENTION_MS);
}

function formatCooldownText(ms) {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0 && seconds > 0) return `${minutes} دقيقة و ${seconds} ثانية`;
  if (minutes > 0) return `${minutes} دقيقة`;
  return `${seconds} ثانية`;
}

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

function pickReasonOverride(reasonValue, globalValue) {
  if (reasonValue === null || reasonValue === undefined || reasonValue === '') return globalValue;
  return reasonValue;
}

function isImageSettingValue(value) {
  if (!value || typeof value !== 'string') return false;
  return value.startsWith('local:') || /^https?:\/\//i.test(value);
}


function buildV2InfoCard(title, lines = []) {
  return new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${title}`),
      new TextDisplayBuilder().setContent((Array.isArray(lines) ? lines : [String(lines || '')]).filter(Boolean).join('\n'))
    )
    .addSeparatorComponents(new SeparatorBuilder());
}

function buildV2ComponentsFromEmbed(embed, actionRows = [], note = null) {
  const data = typeof embed?.toJSON === 'function' ? embed.toJSON() : (embed?.data || embed || {});
  const segments = [];

  if (data.title) segments.push(`## ${String(data.title).replace(/\*\*/g, '').trim()}`);
  if (note) segments.push(String(note));
  if (data.description) segments.push(String(data.description));
  for (const field of data.fields || []) {
    segments.push(`### ${String(field.name || '').replace(/\*\*/g, '').trim()}
${String(field.value || '')}`);
  }
  if (data.footer?.text) segments.push(`-# ${String(data.footer.text)}`);

  const chunks = [];
  let current = '';
  for (const segment of segments.filter(Boolean)) {
    const next = current ? `${current}

${segment}` : segment;
    if (next.length > 3500 && current) {
      chunks.push(current);
      current = segment;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  if (chunks.length === 0) chunks.push('## Ticket');

  const container = new ContainerBuilder();
  container.addTextDisplayComponents(...chunks.map((chunk) => new TextDisplayBuilder().setContent(chunk.slice(0, 4000))));
  if (chunks.length > 0) container.addSeparatorComponents(new SeparatorBuilder());
  return [container, ...actionRows];
}

function buildMessageFlags({ ephemeral = false, useComponentsV2 = false } = {}) {
  let flags = 0;
  if (useComponentsV2) flags |= MessageFlags.IsComponentsV2;
  if (ephemeral) flags |= MessageFlags.Ephemeral;
  return flags || undefined;
}

function normalizeEmbedForStandardMessage(embed, note = null) {
  const normalized = EmbedBuilder.from(typeof embed?.toJSON === 'function' ? embed.toJSON() : (embed?.data || embed || {}));
  if (note) {
    const previous = normalized.data?.description || normalized.description || '';
    normalized.setDescription([String(note), previous].filter(Boolean).join('\n\n'));
  }
  return normalized;
}

function buildTicketMessagePayload(title, description, options = {}) {
  const {
    user = null,
    components = [],
    note = null,
    files = null,
    content = null,
    ephemeral = false,
    useComponentsV2 = false
  } = options;

  const embed = normalizeEmbedForStandardMessage(makeTicketEmbed(title, description, { user }), note);
  const payload = {
    embeds: [embed]
  };

  if (components?.length) payload.components = components;
  const flags = buildMessageFlags({ ephemeral, useComponentsV2 });
  if (flags) payload.flags = flags;
  if (content) payload.content = content;
  if (files) payload.files = Array.isArray(files) ? files : [files];
  return payload;
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

async function resolveExistingGuildMembers(guild, userIds = [], timeoutMs = 1500) {
  const uniqueIds = [...new Set((userIds || []).map((id) => String(id || '').trim()).filter((id) => /^\d{16,20}$/.test(id)))];
  if (!guild || uniqueIds.length === 0) return [];
  const settled = await Promise.allSettled(uniqueIds.map((id) => resolveGuildMember(guild, id, timeoutMs)));
  return settled
    .map((item, idx) => ({ item, id: uniqueIds[idx] }))
    .filter(({ item }) => item.status === 'fulfilled' && item.value)
    .map(({ id }) => id);
}

function resolveButtonStyle(styleValue) {
  const safe = String(styleValue || 'primary').toLowerCase();
  if (safe === 'success') return ButtonStyle.Success;
  if (safe === 'danger') return ButtonStyle.Danger;
  if (safe === 'secondary') return ButtonStyle.Secondary;
  return ButtonStyle.Primary;
}

/**
 * Loads the points data, ensuring the cache is up-to-date.
 * @returns {object} The points data.
 */
function loadPoints() {
  return hydrateStateCache(STATE_KEY_POINTS, pointsPath);
}

function savePoints(points) {
  saveCachedState(STATE_KEY_POINTS, pointsPath, points);
}

function ensurePointsAudit(points) {
  if (!Array.isArray(points.__audit)) points.__audit = [];
  if (points.__audit.length > MAX_POINTS_AUDIT_ENTRIES) {
    points.__audit = points.__audit.slice(-MAX_POINTS_AUDIT_ENTRIES);
  }
  return points.__audit;
}

function ensureManagerAudit(points) {
  if (!Array.isArray(points.__managerAudit)) points.__managerAudit = [];
  if (points.__managerAudit.length > MAX_MANAGER_AUDIT_ENTRIES) {
    points.__managerAudit = points.__managerAudit.slice(-MAX_MANAGER_AUDIT_ENTRIES);
  }
  return points.__managerAudit;
}

function ensureManagerPointsAudit(points) {
  if (!Array.isArray(points.__managerPointsAudit)) points.__managerPointsAudit = [];
  if (points.__managerPointsAudit.length > MAX_MANAGER_AUDIT_ENTRIES) {
    points.__managerPointsAudit = points.__managerPointsAudit.slice(-MAX_MANAGER_AUDIT_ENTRIES);
  }
  return points.__managerPointsAudit;
}

function sumPointBucket(bucket) {
  if (bucket && typeof bucket === 'object') {
    return Object.values(bucket).reduce((sum, value) => sum + Number(value || 0), 0);
  }
  return Number(bucket || 0);
}

function getUserTotalPoints(points, userId) {
  const targetId = String(userId || '').trim();
  if (!targetId) return 0;
  let total = 0;
  for (const [key, bucket] of Object.entries(points || {})) {
    if (key.startsWith('__')) continue;
    if (!bucket || typeof bucket !== 'object') continue;
    total += sumPointBucket(bucket[targetId]);
  }
  return total;
}

function getTopPointUsers(points, limit = 10) {
  const totals = new Map();
  for (const [key, bucket] of Object.entries(points || {})) {
    if (key.startsWith('__')) continue;
    if (!bucket || typeof bucket !== 'object') continue;
    for (const [userId, userBucket] of Object.entries(bucket)) {
      totals.set(userId, (totals.get(userId) || 0) + sumPointBucket(userBucket));
    }
  }
  return [...totals.entries()]
    .map(([userId, total]) => ({ userId, total }))
    .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId))
    .slice(0, Math.max(1, limit));
}

function getTopPointAwarder(points, userId) {
  const targetId = String(userId || '').trim();
  const awards = new Map();
  const auditEntries = Array.isArray(points?.__audit) ? points.__audit : [];
  for (const entry of auditEntries) {
    if (String(entry?.targetId || '') !== targetId || !entry?.actorId) continue;
    awards.set(entry.actorId, (awards.get(entry.actorId) || 0) + Number(entry.delta || 0));
  }
  if (!awards.size) return null;
  const [actorId, total] = [...awards.entries()].sort((a, b) => b[1] - a[1])[0];
  return { actorId, total };
}

function appendPointAuditEntry(points, entry) {
  const audit = ensurePointsAudit(points);
  audit.push({
    id: String(entry?.id || Date.now()),
    targetId: String(entry?.targetId || ''),
    actorId: String(entry?.actorId || ''),
    delta: Number(entry?.delta || 0),
    respName: String(entry?.respName || 'general'),
    source: String(entry?.source || 'manual'),
    at: String(entry?.at || Date.now())
  });
  if (audit.length > MAX_POINTS_AUDIT_ENTRIES) points.__audit = audit.slice(-MAX_POINTS_AUDIT_ENTRIES);
}

function removePointAuditEntry(points, entryId) {
  const audit = ensurePointsAudit(points);
  const before = audit.length;
  points.__audit = audit.filter((entry) => String(entry?.id || '') !== String(entryId || ''));
  return points.__audit.length !== before;
}

function appendManagerAuditEntry(points, entry) {
  const audit = ensureManagerAudit(points);
  if (audit.some((item) => String(item?.ticketKey || '') === String(entry?.ticketKey || ''))) return false;
  audit.push({
    ticketKey: String(entry?.ticketKey || ''),
    actorId: String(entry?.actorId || ''),
    targetId: String(entry?.targetId || ''),
    at: String(entry?.at || Date.now())
  });
  if (audit.length > MAX_MANAGER_AUDIT_ENTRIES) points.__managerAudit = audit.slice(-MAX_MANAGER_AUDIT_ENTRIES);
  return true;
}

function recordManagerClosePoint(points, { guildId, panelId = 'default', channelId, actorId, targetId = '', at = Date.now() } = {}) {
  if (!points || !guildId || !channelId || !actorId) return false;
  return appendManagerAuditEntry(points, {
    ticketKey: `${guildId}:${panelId || 'default'}:${channelId}`,
    actorId,
    targetId,
    at
  });
}

function appendManagerPointEntry(points, entry) {
  const audit = ensureManagerPointsAudit(points);
  if (audit.some((item) => String(item?.ticketKey || '') === String(entry?.ticketKey || ''))) return false;
  audit.push({
    ticketKey: String(entry?.ticketKey || ''),
    actorId: String(entry?.actorId || ''),
    targetId: String(entry?.targetId || ''),
    at: String(entry?.at || Date.now())
  });
  if (audit.length > MAX_MANAGER_AUDIT_ENTRIES) points.__managerPointsAudit = audit.slice(-MAX_MANAGER_AUDIT_ENTRIES);
  return true;
}

function removeManagerPointEntry(points, ticketKey) {
  const audit = ensureManagerPointsAudit(points);
  const before = audit.length;
  points.__managerPointsAudit = audit.filter((entry) => String(entry?.ticketKey || '') !== String(ticketKey || ''));
  return points.__managerPointsAudit.length !== before;
}

function recordManagerPoint(points, { guildId, panelId = 'default', channelId, actorId, targetId = '', at = Date.now() } = {}) {
  if (!points || !guildId || !channelId || !actorId) return false;
  return appendManagerPointEntry(points, {
    ticketKey: `${guildId}:${panelId || 'default'}:${channelId}`,
    actorId,
    targetId,
    at
  });
}

function recordClaimPointIfNeeded(ticket, { guildId, panelId = 'default', channelId, actorId, targetId = '' } = {}) {
  if (!ticket || ticket.claimPointRecordedAt) return false;
  // Points are no longer awarded on claim as per user request.
  // The claimPointRecordedAt flag is still set to prevent re-processing.
  ticket.claimPointRecordedAt = Date.now();
  return true;
}

function getManagerPointCount(points, userId) {
  const targetId = String(userId || '').trim();
  const audit = Array.isArray(points?.__managerPointsAudit) ? points.__managerPointsAudit : [];
  return audit.filter((entry) => String(entry?.actorId || '') === targetId).length;
}

function getManagerEvaluationCount(points, userId) {
  const targetId = String(userId || '').trim();
  const audit = Array.isArray(points?.__managerAudit) ? points.__managerAudit : [];
  return audit.filter((entry) => String(entry?.actorId || '') === targetId).length;
}

function getTopManagers(points, limit = 10) {
  const totals = new Map();
  const audit = Array.isArray(points?.__managerPointsAudit) ? points.__managerPointsAudit : [];
  for (const entry of audit) {
    const actorId = String(entry?.actorId || '').trim();
    if (!actorId) continue;
    totals.set(actorId, (totals.get(actorId) || 0) + 1);
  }
  return [...totals.entries()]
    .map(([userId, total]) => ({ userId, total }))
    .sort((a, b) => b.total - a.total || a.userId.localeCompare(b.userId))
    .slice(0, Math.max(1, limit));
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function buildLogEvent(type, message, extra = {}) {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: String(type || 'note'),
    message: String(message || '').trim(),
    at: Number(extra.at || Date.now()),
    actorId: extra.actorId ? String(extra.actorId) : null,
    targetId: extra.targetId ? String(extra.targetId) : null,
    metadata: extra.metadata && typeof extra.metadata === 'object' ? extra.metadata : {}
  };
}

function formatTicketLogEvent(event) {
  if (!event) return '';
  if (typeof event === 'string') return event.trim();
  if (typeof event.message === 'string' && event.message.trim()) return event.message.trim();
  const label = String(event.type || 'note');
  return `[${label}]`;
}

function appendTicketLogEntry(ticket, entry) {
  if (!ticket) return;
  const normalized = typeof entry === 'object' && entry !== null
    ? buildLogEvent(entry.type, entry.message, entry)
    : buildLogEvent('note', String(entry || '').trim());
  if (!normalized.message) return;
  if (!Array.isArray(ticket.logEvents)) ticket.logEvents = [];

  if (normalized.type === 'unauthorized_message' && normalized.actorId) {
    const existingIndex = [...ticket.logEvents].reverse().findIndex((event) => (
      event?.type === 'unauthorized_message'
      && String(event?.actorId || '') === String(normalized.actorId || '')
    ));
    if (existingIndex !== -1) {
      const absoluteIndex = ticket.logEvents.length - 1 - existingIndex;
      const existing = ticket.logEvents[absoluteIndex] || {};
      ticket.logEvents[absoluteIndex] = {
        ...existing,
        ...normalized,
        id: existing.id || normalized.id
      };
    } else {
      ticket.logEvents.push(normalized);
    }
  } else {
    ticket.logEvents.push(normalized);
  }

  if (ticket.logEvents.length > 40) ticket.logEvents = ticket.logEvents.slice(-40);
  ticket.logHistory = ticket.logEvents.slice(-12).map((event) => formatTicketLogEvent(event));
}

function getTicketLogTimeline(ticket, channel = null, limit = 8) {
  const events = Array.isArray(ticket?.logEvents) ? ticket.logEvents.slice(-limit) : [];
  return events
    .map((event) => {
      const at = Number(event?.at || 0);
      const time = at ? new Date(at).toISOString() : 'unknown-time';
      const renderedMessage = renderTranscriptContent(channel, formatTicketLogEvent(event), { renderImageLinks: false }) || '<span class="muted">(empty)</span>';
      return `<div class="timeline-entry"><span class="timeline-time">${escapeHtml(time)}</span> — <span class="timeline-text">${renderedMessage}</span></div>`;
    })
    .join('');
}

function renderTranscriptContent(channel, rawText = '', options = {}) {
  const { renderImageLinks = true } = options;
  const guild = channel?.guild;
  let html = escapeHtml(rawText || '');
  html = html
    .replace(/&lt;@!?(\d{1,22})&gt;/g, (_, id) => {
      const member = guild?.members?.cache?.get?.(id);
      const label = member?.displayName || member?.user?.username || id;
      return `<span class="mention user-mention">@${escapeHtml(label)}</span>`;
    })
    .replace(/&lt;@&(\d{1,22})&gt;/g, (_, id) => {
      const role = guild?.roles?.cache?.get?.(id);
      const label = role?.name || id;
      return `<span class="mention role-mention">@${escapeHtml(label)}</span>`;
    })
    .replace(/&lt;#(\d{1,22})&gt;/g, (_, id) => {
      const linked = guild?.channels?.cache?.get?.(id);
      const label = linked?.name || id;
      return `<span class="mention channel-mention">#${escapeHtml(label)}</span>`;
    });
  html = html.replace(/(https?:\/\/[^\s<]+)/gi, (url) => {
    const safeUrl = escapeHtml(url);
    const imageLike = /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(url);
    if (renderImageLinks && imageLike) {
      return `<a href="${safeUrl}" target="_blank" rel="noreferrer">${safeUrl}</a><br><div class="media"><img src="${safeUrl}" alt="inline-image" loading="lazy"></div>`;
    }
    return `<a href="${safeUrl}" target="_blank" rel="noreferrer">${safeUrl}</a>`;
  });
  return html.replace(/\n/g, '<br>');
}

function formatDeletedTranscriptEntry(entry, channel = null) {
  const author = entry?.authorTag || entry?.authorName || entry?.authorId || 'unknown';
  const ts = new Date(Number(entry?.deletedAt || entry?.createdTimestamp || Date.now())).toLocaleString('en-GB', { hour12: false, timeZone: 'UTC' });
  const content = renderTranscriptContent(channel, entry?.content || '') || '<span class="muted">(empty)</span>';
  const avatar = entry?.avatarUrl
    ? `<img class="avatar-img" src="${escapeHtml(entry.avatarUrl)}" alt="${escapeHtml(author)}" loading="lazy">`
    : `<div class="avatar-fallback">${escapeHtml(String(author).slice(0, 2).toUpperCase())}</div>`;
  return {
    timestamp: Number(entry?.deletedAt || entry?.createdTimestamp || Date.now()),
    html: `
      <article class="message deleted-message">
        <div class="avatar">${avatar}</div>
        <div class="content">
          <div class="meta">
            <span class="author">${escapeHtml(author)}</span>
            <span class="time">${escapeHtml(ts)} UTC</span>
          </div>
          <div class="body" dir="auto"><span class="deleted-label">(deleted)</span> <span class="deleted-body">${content}</span></div>
        </div>
      </article>
    `
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTranscriptComponents(message) {
  const rows = Array.isArray(message?.components) ? message.components : [];
  if (!rows.length) return '';
  const parts = rows.map((row) => {
    const items = (row.components || []).map((component) => {
      if (component.data?.options?.length || component.options?.length) {
        const options = component.data?.options || component.options || [];
        return `<div class="component select-menu">[Menu] ${options.map((option) => escapeHtml(option.label || option.value || 'option')).join(' | ')}</div>`;
      }
      const label = component.label || component.data?.label || component.placeholder || component.data?.placeholder || component.customId || 'component';
      return `<div class="component button">${escapeHtml(label)}</div>`;
    }).join('');
    return `<div class="component-row">${items}</div>`;
  }).join('');
  return `<div class="components-wrap">${parts}</div>`;
}

function isImageLikeAttachment(attachment) {
  const name = String(attachment?.name || '').toLowerCase();
  const url = String(attachment?.url || '').toLowerCase();
  const contentType = String(attachment?.contentType || '').toLowerCase();
  return contentType.startsWith('image/')
    || (Number(attachment?.width || 0) > 0 && Number(attachment?.height || 0) > 0)
    || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)
    || /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(url);
}

function buildTranscriptAvatar(author) {
  const url = author?.displayAvatarURL?.({ extension: 'png', forceStatic: false, size: 128 })
    || author?.avatarURL?.({ extension: 'png', forceStatic: false, size: 128 })
    || author?.avatarURL?.()
    || '';
  if (url) {
    return `<img class="avatar-img" src="${escapeHtml(url)}" alt="${escapeHtml(author?.tag || author?.username || 'avatar')}" loading="lazy">`;
  }
  const fallback = String(author?.tag || author?.username || author?.id || '??').slice(0, 2).toUpperCase();
  return `<div class="avatar-fallback">${escapeHtml(fallback)}</div>`;
}

function formatTranscriptEmbeds(channel, embeds = []) {
  return embeds.map((e) => {
    const parts = [];
    if (e.author?.name) parts.push(`<div class="embed-author">${escapeHtml(e.author.name)}</div>`);
    if (e.title) parts.push(`<div class="embed-title">${escapeHtml(e.title)}</div>`);
    if (e.description) parts.push(`<div class="embed-description">${renderTranscriptContent(channel, e.description, { renderImageLinks: false })}</div>`);
    if (Array.isArray(e.fields) && e.fields.length) {
      const fields = e.fields.map((field) => `
        <div class="embed-field">
          <div class="embed-field-name">${renderTranscriptContent(channel, field.name || '-', { renderImageLinks: false })}</div>
          <div class="embed-field-value">${renderTranscriptContent(channel, field.value || '-', { renderImageLinks: false })}</div>
        </div>
      `).join('');
      parts.push(`<div class="embed-fields">${fields}</div>`);
    }
    if (e.footer?.text) parts.push(`<div class="embed-footer">${escapeHtml(e.footer.text)}</div>`);
    const mediaUrls = [...new Set([e.image?.url, e.thumbnail?.url].filter(Boolean))];
    if (mediaUrls.length) {
      parts.push(mediaUrls.map((mediaUrl) => `<div class="media"><img src="${escapeHtml(mediaUrl)}" alt="embed-media" loading="lazy"></div>`).join(''));
    }
    if (!parts.length) return '';
    return `<section class="embed-card">${parts.join('')}</section>`;
  }).filter(Boolean).join('');
}

async function warmMentionCaches(channel, rawText = '') {
  const guild = channel?.guild;
  if (!guild || !rawText) return;
  const text = String(rawText);
  const memberIds = [...text.matchAll(/<@!?(\d{1,22})>/g)].map((m) => m[1]);
  const roleIds = [...text.matchAll(/<@&(\d{1,22})>/g)].map((m) => m[1]);
  const channelIds = [...text.matchAll(/<#(\d{1,22})>/g)].map((m) => m[1]);

  await runConcurrentTasks(
    [...new Set(memberIds)]
      .filter((id) => !guild.members.cache.has(id))
      .map((id) => resolveGuildMember(guild, id, 1500)),
    'mentions.members.warm'
  );
  await runConcurrentTasks(
    [...new Set(roleIds)]
      .filter((id) => !guild.roles.cache.has(id))
      .map((id) => withTimeout(guild.roles.fetch(id).catch(() => null), 1500)),
    'mentions.roles.warm'
  );
  await runConcurrentTasks(
    [...new Set(channelIds)]
      .filter((id) => !guild.channels.cache.has(id))
      .map((id) => withTimeout(guild.channels.fetch(id).catch(() => null), 1500)),
    'mentions.channels.warm'
  );
}

async function buildTicketTranscript(channel, maxMessagesOrOptions = Infinity, maybeOptions = {}) {
  try {
    const options = (typeof maxMessagesOrOptions === 'object' && maxMessagesOrOptions !== null)
      ? maxMessagesOrOptions
      : maybeOptions;
    const maxMessages = (typeof maxMessagesOrOptions === 'number')
      ? maxMessagesOrOptions
      : Number.isFinite(options.maxMessages) ? Number(options.maxMessages) : Infinity;
    const fastMode = options.fastMode === true;
    const warmMentions = options.warmMentions !== false && !fastMode;
    const timeBudgetMs = Number.isFinite(options.timeBudgetMs) && options.timeBudgetMs > 0
      ? Number(options.timeBudgetMs)
      : Infinity;
    const startedAt = Date.now();
    const deadlineAt = Number.isFinite(timeBudgetMs) ? (startedAt + timeBudgetMs) : Infinity;

    const rows = [];
    let lastId = null;
    let fetchedTotal = 0;

    while (true) {
      if (Date.now() >= deadlineAt) break;
      if (Number.isFinite(maxMessages) && fetchedTotal >= maxMessages) break;
      const remaining = Number.isFinite(maxMessages) ? Math.min(100, maxMessages - fetchedTotal) : 100;
      const batch = await channel.messages.fetch({ limit: remaining, before: lastId }).catch(() => null);
      if (!batch || batch.size === 0) break;

      const ordered = [...batch.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const msg of ordered) {
        if (Date.now() >= deadlineAt) break;
        const warmTexts = [msg.content || ''];
        if (Array.isArray(msg.embeds) && msg.embeds.length) {
          for (const embed of msg.embeds) {
            warmTexts.push(embed?.description || '');
            if (Array.isArray(embed?.fields)) {
              for (const field of embed.fields) {
                warmTexts.push(field?.name || '', field?.value || '');
              }
            }
          }
        }
        if (warmMentions) {
          await runConcurrentTasks(
            warmTexts.filter(Boolean).map((textItem) => warmMentionCaches(channel, textItem)),
            'transcript.warm.texts'
          );
        }
        const ts = new Date(msg.createdTimestamp).toLocaleString('en-GB', { hour12: false, timeZone: 'UTC' });
        const author = msg.author?.tag || msg.author?.username || msg.author?.id || 'unknown';
        const content = renderTranscriptContent(channel, (msg.content || '').trim());
        const attachments = msg.attachments?.size
          ? [...msg.attachments.values()].map((a) => {
            const imagePreview = isImageLikeAttachment(a)
              ? `<div class="media"><img src="${escapeHtml(a.url)}" alt="${escapeHtml(a.name || 'image')}" loading="lazy"></div>`
              : '';
            return `<div class="attachment">${imagePreview}<a href="${escapeHtml(a.url)}" target="_blank" rel="noreferrer">${escapeHtml(a.name || a.url)}</a></div>`;
          }).join('<br>')
          : '';
        const embeds = msg.embeds?.length ? formatTranscriptEmbeds(channel, msg.embeds) : '';
        const stickers = msg.stickers?.size
          ? `<div class="sticker-list">${[...msg.stickers.values()].map((sticker) => `🎟️ ${escapeHtml(sticker.name || sticker.id || 'sticker')}`).join('<br>')}</div>`
          : '';
        const reactions = msg.reactions?.cache?.size
          ? `<div class="reactions">${[...msg.reactions.cache.values()].map((reaction) => `:${escapeHtml(reaction.emoji?.name || 'emoji')}: ×${reaction.count || 1}`).join(' ')}</div>`
          : '';
        const reference = msg.reference?.messageId ? `<div class="reply-ref">↪️ Reply to message ${escapeHtml(msg.reference.messageId)}</div>` : '';
        const components = formatTranscriptComponents(msg);
        const blocks = [reference, content, attachments, embeds, stickers, reactions, components].filter(Boolean).join('<br>');
        rows.push({
          timestamp: msg.createdTimestamp,
          html: `
          <article class="message">
            <div class="avatar">${buildTranscriptAvatar(msg.author)}</div>
            <div class="content">
              <div class="meta">
                <span class="author">${escapeHtml(author)}</span>
                <span class="time">${escapeHtml(ts)} UTC</span>
              </div>
              <div class="body" dir="auto">${blocks || '<span class="muted">(empty)</span>'}</div>
            </div>
          </article>
        `
        });
      }

      fetchedTotal += batch.size;
      lastId = ordered[0]?.id;
      if (!lastId) break;
    }

    const deletedRows = Array.isArray(channel.ticketMeta?.deletedMessages)
      ? channel.ticketMeta.deletedMessages.map((entry) => formatDeletedTranscriptEntry(entry, channel))
      : [];
    const combinedRows = [...rows, ...deletedRows].sort((a, b) => a.timestamp - b.timestamp).map((row) => row.html);
    if (combinedRows.length === 0) return null;
    const logTimeline = getTicketLogTimeline(channel.ticketMeta || null, channel);
    const fileName = `transcript-${channel.id}.html`;
    const html = `<!doctype html>
<html lang="ar">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Transcript ${escapeHtml(channel.name || channel.id)}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #313338; color: #dbdee1; }
    .wrap { max-width: 1000px; margin: 0 auto; padding: 24px 16px 48px; }
    .header { background: #1e1f22; border: 1px solid #3f4147; border-radius: 16px; padding: 16px 18px; margin-bottom: 16px; }
    .header h1 { margin: 0 0 8px; font-size: 22px; }
    .header p { margin: 4px 0; color: #b5bac1; }
    .message { display: flex; gap: 12px; padding: 12px 10px; border-radius: 12px; }
    .message:hover { background: rgba(255,255,255,0.03); }
    .avatar { width: 40px; height: 40px; border-radius: 50%; overflow: hidden; background: #5865f2; display: flex; align-items: center; justify-content: center; font-weight: 700; flex: 0 0 40px; }
    .avatar-img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .avatar-fallback { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
    .content { min-width: 0; flex: 1; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; margin-bottom: 4px; }
    .author { font-weight: 700; color: #fff; }
    .time { font-size: 12px; color: #949ba4; }
    .body { line-height: 1.6; word-break: break-word; }
    .body a { color: #00a8fc; text-decoration: none; }
    .body a:hover { text-decoration: underline; }
    .attachment { display: grid; gap: 6px; }
    .media img { max-width: min(100%, 520px); border-radius: 12px; border: 1px solid #3f4147; display: block; }
    .embed-card { margin-top: 8px; border-left: 4px solid #5865f2; background: #2b2d31; border-radius: 8px; padding: 10px 12px; display: grid; gap: 8px; }
    .mention { display: inline-block; border-radius: 6px; padding: 0 4px; background: rgba(88,101,242,.18); color: #c9cdfb; }
    .component-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .component { border: 1px solid #4e5058; border-radius: 8px; padding: 6px 10px; background: #2b2d31; color: #f2f3f5; font-size: 12px; }
    .embed-author, .embed-footer, .reply-ref, .reactions, .sticker-list { color: #b5bac1; font-size: 12px; }
    .embed-title, .embed-field-name { font-weight: 700; color: #fff; }
    .embed-fields { display: grid; gap: 8px; }
    .timeline { margin-bottom: 16px; background: #1e1f22; border: 1px solid #3f4147; border-radius: 12px; padding: 14px 16px; }
    .timeline-entry { margin-top: 6px; line-height: 1.6; }
    .timeline-time { color: #949ba4; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    .deleted-message { background: rgba(237, 66, 69, 0.08); border: 1px solid rgba(237, 66, 69, 0.25); }
    .deleted-label, .deleted-body { color: #ff6b6b; }
    .muted { color: #949ba4; }
    @media (max-width: 640px) { .wrap { padding: 12px 8px 32px; } .header h1 { font-size: 18px; } }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="header">
      <h1>#${escapeHtml(channel.name || channel.id)}</h1>
      <p>Channel ID: ${escapeHtml(channel.id)}</p>
      <p>Generated at: ${escapeHtml(new Date().toISOString())}</p>
      ${Number.isFinite(timeBudgetMs) ? `<p>Mode: fast transcript (${escapeHtml(String(timeBudgetMs))}ms budget)</p>` : ''}
    </section>
    ${logTimeline ? `<section class="timeline"><strong>Ticket activity</strong><br>${logTimeline}</section>` : ''}
    ${combinedRows.join('\n')}
  </main>
</body>
</html>`;
    return new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: fileName });
  } catch (error) {
    console.error('[ticket] buildTicketTranscript failed:', error?.message || error);
    return null;
  }
}

async function retryAsync(fn, attempts = 3) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const result = await fn(i);
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)));
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function finalizeTransferDmNotifications(ticket, guild, closedByLabel = 'غير محدد') {
  const notices = Array.isArray(ticket?.transferDmNotifications) ? ticket.transferDmNotifications : [];
  if (!notices.length || !guild?.client) return;
  for (const notice of notices) {
    const user = await guild.client.users.fetch(notice.userId).catch(() => null);
    if (!user) continue;
    const dm = await user.createDM().catch(() => null);
    if (!dm) continue;
    const msg = notice.messageId ? await dm.messages.fetch(notice.messageId).catch(() => null) : null;
    if (!msg?.editable) continue;
    const resolvedBy = closedByLabel || 'غير محدد';
    const transferredBy = notice.transferredById ? `<@${notice.transferredById}>` : 'غير محدد';
    await msg.edit({
      embeds: [makeTicketEmbed('Change To Resp', `**من الذي حوّل التكت :** ${transferredBy}\n**ولكن تم حلها بنجاح بواسطة :** ${resolvedBy}`)]
    }).catch((error) => logSilentError('suppressed', error));
  }
}

async function syncTicketLogMessage({
  guild,
  config,
  ticket,
  channelId,
  actionText,
  actor = null,
  transcriptFile = null
}) {
  const logChannelId = config?.logChannelId;
  if (!guild || !ticket || !logChannelId) return false;

  const logChannel = guild.channels.cache.get(logChannelId)
    || await guild.channels.fetch(logChannelId).catch(() => null);
  if (!logChannel || !logChannel.isTextBased?.()) {
    ticket.logSyncFailedAt = Date.now();
    ticket.logSyncError = 'LOG_CHANNEL_UNAVAILABLE';
    return false;
  }

  appendTicketLogEntry(ticket, typeof actionText === 'object' ? actionText : { type: 'action', message: actionText, actorId: actor?.id || null });
  ticket.logSyncFailedAt = null;
  ticket.logSyncError = null;

  const reason = config.reasons?.[ticket.reasonKey] || {};
  const historyText = (ticket.logHistory || []).slice(-12).map((line, index) => `${index + 1}) ${line}`).join('\n') || 'لا يوجد';
  const statusLabel = ticket.status === 'closed' ? 'Closed' : 'Open';
  let transcriptUrl = ticket.lastTranscriptUrl || null;
  let transcriptUploadFailed = false;
  const ticketLabel = ticket.deletedChannel ? 'Deleted' : (channelId ? `<#${channelId}>` : (ticket.channelId ? `<#${ticket.channelId}>` : 'غير محدد'));
  const buildDescription = (url, uploadFailed) => {
    const summaryLines = [
      `**Ticket :** ${ticketLabel}`,
      `**Member :** ${ticket.memberId ? `<@${ticket.memberId}>` : 'غير محدد'}`,
      `**Reason :** ${reason.name || `سبب ${ticket.reasonKey || '-'}`}`,
      `**Status :** ${statusLabel}`,
      url ? `**Transcript :** [Open here](${url})` : null,
      uploadFailed ? '**Transcript :** Failed to upload transcript file.' : null,
      '',
      '**Results :**',
      historyText
    ].filter(Boolean);

    let nextDescription = summaryLines.join('\n');
    if (nextDescription.length > 3800) {
      const trimmedHistory = (ticket.logHistory || []).slice(-8).map((line, index) => `${index + 1}) ${line}`).join('\n') || 'لا يوجد';
      nextDescription = [
        `**Ticket :** ${ticketLabel}`,
        `**Member :** ${ticket.memberId ? `<@${ticket.memberId}>` : 'غير محدد'}`,
        `**Reason :** ${reason.name || `سبب ${ticket.reasonKey || '-'}`}`,
        `**Status :** ${statusLabel}`,
        url ? `**Transcript :** [Open here](${url})` : null,
        uploadFailed ? '**Transcript :** Failed to upload transcript file.' : null,
        '',
        '**Results :**',
        trimmedHistory
      ].filter(Boolean).join('\n');
    }
    return nextDescription;
  };

  let description = buildDescription(transcriptUrl, transcriptUploadFailed);

  const embed = colorManager.createEmbed()
    .setTitle('Log')
    .setDescription(description)
    .setFooter({ text: `Ticket ID : ${ticket.channelId || channelId || 'unknown'}` })
    .setTimestamp(new Date());

  embed.setAuthor({ name: guild.name || 'Server', iconURL: guild.iconURL?.({ dynamic: true, size: 128 }) || undefined });

  const payload = { embeds: [embed] };
  if (transcriptFile) payload.files = [transcriptFile];

  let targetMessage = null;
  if (ticket.logMessageId) {
    const existing = await retryAsync(() => logChannel.messages.fetch(ticket.logMessageId).catch(() => null), 2).catch(() => null);
    if (existing?.editable) {
      targetMessage = await retryAsync(() => existing.edit(payload).catch(() => null), 2).catch(() => null);
    }
  }
  if (!targetMessage) {
    targetMessage = await retryAsync(() => logChannel.send(payload).catch(() => null), 2).catch(() => null);
    if (!targetMessage) {
      ticket.logSyncFailedAt = Date.now();
      ticket.logSyncError = 'LOG_MESSAGE_SEND_FAILED';
      return false;
    }
  }
  ticket.logMessageId = targetMessage.id;

  if (transcriptFile) {
    const transcriptAttachment = [...targetMessage.attachments.values()].find((item) => String(item.name || '').startsWith('transcript-'));
    if (transcriptAttachment?.url) {
      transcriptUrl = transcriptAttachment.url;
      ticket.lastTranscriptUrl = transcriptUrl;
    } else {
      transcriptUploadFailed = true;
      ticket.logSyncError = 'TRANSCRIPT_UPLOAD_FAILED';
    }

    const updatedDescription = buildDescription(transcriptUrl, transcriptUploadFailed);
    if (updatedDescription !== description) {
      embed.setDescription(updatedDescription);
      await retryAsync(() => targetMessage.edit({ embeds: [embed] }).catch(() => null), 2).catch(() => null);
    }
  }

  return true;
}

async function sendClaimAnnounce({ channel, config, ticket, claimerId, claimImage, suppressRoleMentions = false }) {
  const adminRoleIds = getAdminRoles(config, ticket?.reasonKey)
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id));

  const reasonName = config.reasons?.[ticket.reasonKey]?.name || `سبب ${ticket.reasonKey}`;
  if (!suppressRoleMentions) {
    const mentionChunks = buildMentionChunks(adminRoleIds);
    await runConcurrentTasks(
      mentionChunks.map((chunk) => channel.send({ content: chunk })),
      'claim.announce.mentions'
    );
  }

  const modalAnswers = ticket?.openModalAnswers && typeof ticket.openModalAnswers === 'object'
    ? Object.entries(ticket.openModalAnswers)
      .filter(([, value]) => String(value || '').trim().length > 0)
      .slice(0, 8)
      .map(([label, value]) => `**${String(label).slice(0, 80)} :** ${String(value).slice(0, 250)}`)
      .join('\n')
    : '';
  const modalSection = modalAnswers ? `\n\n**Modal Answers :**\n${modalAnswers}` : '';

  const claimEmbed = makeTicketEmbed('Ticket claimed', `**Reason :** ${reasonName}\n**Admin :** <@${claimerId}>${modalSection}`);

  await channel.send({ embeds: [claimEmbed] }).catch((error) => logSilentError('suppressed', error));
}

function buildClaimRequestContent(ticket, config, claimerId = null) {
  const reason = config?.reasons?.[ticket?.reasonKey] || {};
  const lines = [
    `**العضو :** <@${ticket?.memberId || 'unknown'}>`,
    `**السبب :** ${reason.name || `سبب ${ticket?.reasonKey || '-'}`}`
  ];
  if (reason.description) lines.push(`**الوصف :** ${reason.description}`);
  if (claimerId) lines.push(`**الإداري :** <@${claimerId}>`);
  return lines.join('\n');
}

function buildPostCloseControls(guildId, panelId, channelId, ticket = {}) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_down2_${guildId}_${panelId}_${channelId}`).setLabel('2').setEmoji('<:emoji_12:1484365293974327477>').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_down_${guildId}_${panelId}_${channelId}`).setLabel('1').setEmoji('<:emoji_12:1484365293974327477>').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_delete_${guildId}_${panelId}_${channelId}`).setLabel('Delete').setEmoji('<:emoji_10:1484365185941635153>').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket_up1_${guildId}_${panelId}_${channelId}`).setLabel('1').setEmoji('<:emoji_11:1484365260251987968>').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_up2_${guildId}_${panelId}_${channelId}`).setLabel('2').setEmoji('<:emoji_11:1484365260251987968>').setStyle(ButtonStyle.Secondary)
  );

  const memberHidden = ticket.memberHidden !== false;
  const claimerHidden = ticket.claimerHidden !== false;
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_toggle_member_${guildId}_${channelId}`)
      .setLabel(memberHidden ? 'ارجاع العضو' : 'اخفاء العضو')
      .setEmoji('<:emoji_11:1484365220926455948>')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ticket_toggle_claimer_${guildId}_${channelId}`)
      .setLabel(claimerHidden ? 'ارجاع المسؤول' : 'اخفاء المسؤول')
      .setEmoji('<:emoji_11:1484365220926455948>')
      .setStyle(ButtonStyle.Primary)
  );

  return [row1, row2];
}

function buildPointRevertControls(guildId, panelId, channelId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_points_revert_${guildId}_${panelId}_${channelId}`)
      .setLabel('تراجع عن النقاط')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`ticket_points_cancel_${guildId}_${panelId}_${channelId}`)
      .setLabel('إلغاء')
      .setStyle(ButtonStyle.Secondary)
  )];
}

/**
 * Loads the main store configuration, ensuring the cache is up-to-date.
 * @returns {object} The store configuration.
 */
function loadStore() {
  return hydrateStateCache(STATE_KEY_STORE, dataPath);
}

/**
 * Saves the main store configuration, updating the cache and queuing a persistent write.
 * @param {object} store - The store configuration to save.
 */
function saveStore(store) {
  saveCachedState(STATE_KEY_STORE, dataPath, store);
}

/**
 * Loads the responsibilities configuration, ensuring the cache is up-to-date.
 * @returns {object} The responsibilities configuration.
 */
function loadResponsibilities() {
  const fromFile = getResponsibilitiesSnapshot();
  const hydrated = hydrateStateCache(STATE_KEY_RESPONSIBILITIES, responsibilitiesPath);
  const hasFileData = fromFile && typeof fromFile === 'object' && Object.keys(fromFile).length > 0;

  // استرجاع من كاش التكت القديم فقط إذا كان ملف المسؤوليات فارغاً
  // حتى لا تتعطل تحديثات الإضافة/الإزالة الجديدة.
  if (!hasFileData && hydrated && typeof hydrated === 'object' && Object.keys(hydrated).length) {
    try {
      fs.writeFileSync(responsibilitiesPath, JSON.stringify(hydrated, null, 2), 'utf8');
      global.responsibilities = hydrated;
    } catch (error) {
      logSilentError('responsibilities.restore.from.ticket.cache', error);
    }
    storeCache[STATE_KEY_RESPONSIBILITIES] = hydrated;
    return hydrated;
  }

  if (hasFileData) {
    storeCache[STATE_KEY_RESPONSIBILITIES] = fromFile;
    return fromFile;
  }

  return hydrated;
}

async function waitForResponsibilitiesRecovery({ attempts = 4, delayMs = 300 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const responsibilities = loadResponsibilities();
    if (responsibilities && Object.keys(responsibilities).length > 0) {
      return responsibilities;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return loadResponsibilities();
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

function getReasonVisualSettings(config, reasonKey) {
  const reason = config?.reasons?.[reasonKey] || {};
  return {
    reason,
    beforeText: pickReasonOverride(reason.beforeImage, config?.messages?.beforeImage),
    openImage: pickReasonOverride(reason.openImage, config?.messages?.ticketImage),
    afterText: pickReasonOverride(reason.afterImage, config?.messages?.afterImage),
    claimImage: pickReasonOverride(reason.claimImage, config?.messages?.claimImage || config?.messages?.ticketImage)
  };
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

function normalizeHexColor(input, fallback) {
  const raw = String(input || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  return fallback;
}

function parseStars(value) {
  const n = Number(String(value || '').trim());
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 1 || rounded > 5) return null;
  return rounded;
}

function buildFeedbackSessionToken() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function drawRoundedRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawStarPath(ctx, cx, cy, outer, inner, spikes = 5) {
  let rot = Math.PI / 2 * 3;
  const step = Math.PI / spikes;
  ctx.beginPath();
  ctx.moveTo(cx, cy - outer);
  for (let i = 0; i < spikes; i += 1) {
    ctx.lineTo(cx + Math.cos(rot) * outer, cy + Math.sin(rot) * outer);
    rot += step;
    ctx.lineTo(cx + Math.cos(rot) * inner, cy + Math.sin(rot) * inner);
    rot += step;
  }
  ctx.lineTo(cx, cy - outer);
  ctx.closePath();
}

function addFilmGrain(ctx, width, height, alpha = 0.06) {
  const count = Math.floor((width * height) / 120);
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let i = 0; i < count; i += 1) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    const c = Math.random() > 0.5 ? 255 : 0;
    ctx.fillStyle = `rgb(${c},${c},${c})`;
    ctx.fillRect(x, y, 1.5, 1.5);
  }
  ctx.restore();
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
    hideOnClaim: true,
    claimFromDedicatedChannel: false,
    claimChannelId: null,
    keepClosedTickets: false,
    deleteClaimMessageOnClaim: true,
    logChannelId: null,
    autoCloseEnabled: true,
    autoCloseHours: 12,
    autoCloseWarningMinutes: 10,
    feedback: {
      enabled: false,
      channelId: null,
      triggerWord: 'يرجى وضع تقييمك لخدماتنا',
      promptText: 'يرجى تقييم خدماتنا ونكون شاكرين لك',
      triggerScope: 'dm',
      separatorEnabled: true,
      separatorText: '────────────',
      separatorImage: '',
      style: {
        background: '#070b15',
        cardStart: '#4c3b96',
        cardEnd: '#6a57c1',
        text: '#f7f2ff',
        accent: '#0b0d14',
        border: '#7f6ad9',
        quote: '#171027',
        star: '#7f6ad9',
        name: '#09090f',
        shadow: '#000000',
        version: 'v6'
      }
    },
    messages: {
      beforeImage: '',
      ticketImage: '',
      claimImage: '',
      afterImage: ''
    },
    reasons: {},
    displayMode: 'buttons',
    buttonRows: 2,
    panelMessageId: null,
    exportedAt: null,
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
  store[guildId] = { ...existing, panels };
  saveStore(store);
}

function getPanelData(guildId, panelId = 'default') {
  const { guild } = getGuildData(guildId);
  const panel = guild.panels[panelId] || { config: baseConfig(), tickets: {}, pendingRequests: {} };
  const config = { ...baseConfig(), ...(panel?.config || {}) };
  config.feedback = {
    ...baseConfig().feedback,
    ...(panel?.config?.feedback || {}),
    style: {
      ...baseConfig().feedback.style,
      ...(panel?.config?.feedback?.style || {})
    }
  };
  config.messages = { ...baseConfig().messages, ...(panel?.config?.messages || {}) };
  config.reasons = panel?.config?.reasons || {};
  const tickets = panel?.tickets || {};
  const pendingRequests = panel?.pendingRequests || {};
  return { config, tickets, pendingRequests };
}

function exportPanelSnapshot(guildId, panelId = 'default') {
  const { config } = getPanelData(guildId, panelId);
  return Buffer.from(JSON.stringify({
    version: 1,
    panelId,
    exportedAt: new Date().toISOString(),
    config
  }, null, 2), 'utf8').toString('base64');
}

function importPanelSnapshot(guildId, panelId, encoded, preserveRuntime = true) {
  const decoded = Buffer.from(String(encoded || ''), 'base64').toString('utf8');
  const parsed = JSON.parse(decoded);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.config !== 'object') throw new Error('SNAPSHOT_INVALID');
  const current = getPanelData(guildId, panelId);
  const nextConfig = { ...baseConfig(), ...parsed.config };
  nextConfig.messages = { ...baseConfig().messages, ...(parsed.config.messages || {}) };
  nextConfig.reasons = parsed.config.reasons || {};
  if (preserveRuntime) {
    nextConfig.counter = current.config.counter || nextConfig.counter;
    nextConfig.panelMessageId = current.config.panelMessageId || nextConfig.panelMessageId;
  }
  setGuildData(guildId, nextConfig, current.tickets, current.pendingRequests, panelId);
  return nextConfig;
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

function getTicketContext(guildId, channelId, preferredPanelId = 'default') {
  const panelId = findTicketPanel(guildId, channelId, preferredPanelId || 'default');
  const { config, tickets, pendingRequests } = getPanelData(guildId, panelId);
  const ticket = tickets[channelId] || null;
  return { panelId, config, tickets, pendingRequests, ticket };
}

function getTicketContextFromInteraction(guildId, interaction, channelId, preferredPanelId = 'default') {
  const parsedChannelId = String(channelId || '').trim() || interaction.channelId;
  let context = getTicketContext(guildId, parsedChannelId, preferredPanelId || 'default');

  if (!context.ticket && interaction?.channelId && interaction.channelId !== parsedChannelId) {
    context = getTicketContext(guildId, interaction.channelId, preferredPanelId || context.panelId || 'default');
  }

  return {
    ...context,
    actionChannelId: context.ticket ? (context.ticket.channelId || interaction.channelId || parsedChannelId) : parsedChannelId
  };
}

function parseTicketGuildPanelChannel(customId, guildIndex) {
  const parts = String(customId || '').split('_');
  const guildId = String(parts[guildIndex] || '').trim();
  const channelId = String(parts[parts.length - 1] || '').trim();
  const panelSlice = parts.slice(guildIndex + 1, -1);
  const panelId = panelSlice.length ? panelSlice.join('_') : 'default';
  return {
    guildId,
    panelId: panelId || 'default',
    channelId
  };
}

function findPendingRequestContext(guildId, reqId, preferredPanelId = 'default') {
  const direct = getPanelData(guildId, preferredPanelId || 'default');
  if (direct.pendingRequests?.[reqId]) {
    return { panelId: preferredPanelId || 'default', ...direct, req: direct.pendingRequests[reqId] };
  }

  const { guild } = getGuildData(guildId);
  for (const [panelId, panel] of Object.entries(guild.panels || {})) {
    const pendingRequests = panel?.pendingRequests || {};
    if (pendingRequests[reqId]) {
      const { config, tickets, pendingRequests: resolvedPendingRequests } = getPanelData(guildId, panelId);
      return { panelId, config, tickets, pendingRequests: resolvedPendingRequests, req: resolvedPendingRequests[reqId] };
    }
  }

  return null;
}

function touchTicketActivity(ticket, timestamp = Date.now()) {
  if (!ticket || ticket.status !== 'open') return false;
  ticket.lastActivityAt = timestamp;
  delete ticket.autoCloseWarningSentAt;
  return true;
}

function getTicketAutoCloseMs(config) {
  if (!config?.autoCloseEnabled) return 0;
  const hours = Number(config.autoCloseHours || 0);
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return Math.round(hours * 60 * 60 * 1000);
}

function getTicketDueAt(ticket, config) {
  const timeoutMs = getTicketAutoCloseMs(config);
  if (!timeoutMs) return 0;
  const base = Number(ticket?.lastActivityAt || ticket?.createdAt || Date.now());
  return base + timeoutMs;
}

function getConfiguredResponsibleRoleIds(config, guild, ticket = null) {
  const sourceRoleIds = Array.isArray(ticket?.transferredRoleIds) && ticket.transferredRoleIds.length
    ? ticket.transferredRoleIds
    : (config.responsibleRoleIds || []);

  return [...new Set(sourceRoleIds.map((id) => String(id)))]
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id) && guild?.roles?.cache?.has(id));
}

function getGeneralResponsibleRoleIds(config, guild) {
  return [...new Set((config?.responsibleRoleIds || []).map((id) => String(id)))]
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id) && guild?.roles?.cache?.has(id));
}

function getActiveResponsibleRoleIds(config, guild, ticket = null) {
  const generalRoleIds = (config?.responsibleRoleIds || []).map((id) => String(id || '').trim());
  const transferredRoleIds = Array.isArray(ticket?.transferredRoleIds) ? ticket.transferredRoleIds.map((id) => String(id || '').trim()) : [];
  return [...new Set([...generalRoleIds, ...transferredRoleIds])]
    .filter((id) => /^\d{16,20}$/.test(id) && guild?.roles?.cache?.has(id));
}

function getClosedTicketViewerTargets(config, ticket, guild) {
  const roleIds = getGeneralResponsibleRoleIds(config, guild);
  const userIds = [];

  return { roleIds, userIds };
}

function normalizeId(input) {
  if (!input) return null;
  const match = String(input).trim().match(/^(?:(?:<@!?)|(?:<@&)|(?:<#))?(\d{16,20})>?$/);
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

function levenshteinDistance(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  const matrix = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[left.length][right.length];
}

function searchResponsibilitiesByName(rawQuery, responsibilities = {}, limit = 10) {
  const query = normalizeResponsibilityInput(rawQuery);
  if (!query) return [];

  return Object.keys(responsibilities || {})
    .map((name) => {
      const normalized = normalizeResponsibilityInput(name);
      const exact = normalized === query;
      const startsWith = normalized.startsWith(query);
      const includes = normalized.includes(query);
      const distance = levenshteinDistance(query, normalized);
      return {
        name,
        score: exact ? 1000 : startsWith ? 700 : includes ? 400 : Math.max(0, 250 - distance * 10)
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ar'))
    .slice(0, limit)
    .map((entry) => entry.name);
}

function createResponsibilitySearchSession({ guildId, panelId, channelId, query, results }) {
  pruneTicketSearchSessions();
  const sessionId = `${guildId}_${panelId}_${channelId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const payload = {
    guildId,
    panelId,
    channelId,
    query,
    results,
    createdAt: Date.now()
  };
  ticketSearchSessions.set(sessionId, payload);
  saveRuntimeSession('ticket-search', sessionId, payload, TICKET_SEARCH_SESSION_TTL_MS);
  return sessionId;
}

async function buildResponsibilitySearchResultsMessage(sessionId, responsibilities, page = 0) {
  let session = ticketSearchSessions.get(sessionId);
  if (!session) {
    session = await loadRuntimeSession('ticket-search', sessionId).catch(() => null);
    if (session) ticketSearchSessions.set(sessionId, session);
  }
  if (!session) return null;
  const perPage = 10;
  const totalPages = Math.max(1, Math.ceil(session.results.length / perPage));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = session.results.slice(safePage * perPage, (safePage + 1) * perPage);
  const allNames = Object.keys(responsibilities || {});
  const options = slice.map((name) => {
    const index = allNames.indexOf(name);
    const count = Array.isArray(responsibilities?.[name]?.responsibles) ? responsibilities[name].responsibles.length : 0;
    return {
      label: name.slice(0, 100),
      value: `respidx_${index}`,
        emoji: '<:emoji_1:1484364853832319056>',
      description: `عدد المسؤولين : ${count}`
    };
  });
  return {
    page: safePage,
    totalPages,
    payload: {
      ...buildTicketMessagePayload(' Results', `**نتائج البحث عن :** ${session.query}\n**Page :** ${safePage + 1}/${totalPages}\n**اختر المسؤولية ثم أكد التحويل.**`, { ephemeral: true }),
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_transfer_confirm_${session.guildId}_${session.panelId}_${session.channelId}`)
            .setPlaceholder('اختر المسؤولية المطلوبة')
            .addOptions(options.slice(0, 25))
        ),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`ticket_transfer_search_page_${sessionId}_${safePage - 1}`)
            .setLabel('السابق')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safePage <= 0),
          new ButtonBuilder()
            .setCustomId(`ticket_transfer_search_page_${sessionId}_${safePage + 1}`)
            .setLabel('التالي')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safePage + 1 >= totalPages)
        )
      ]
    }
  };
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

async function countOpenMemberTicketsSafe(guild, tickets, userId) {
  let changed = false;
  for (const [channelId, ticket] of Object.entries(tickets || {})) {
    if (!ticket || ticket.status !== 'open' || ticket.memberId !== userId) continue;
    const cached = guild?.channels?.cache?.get(channelId);
    if (cached) continue;
    const fetched = guild ? await withTimeout(guild.channels.fetch(channelId).catch(() => null), 1200) : null;
    if (!fetched) {
      ticket.status = 'closed';
      ticket.deletedChannel = true;
      ticket.claimedBy = null;
      changed = true;
    }
  }
  return { count: countOpenMemberTickets(tickets, userId), changed };
}

function countPendingMemberRequests(pendingRequests, userId) {
  return Object.values(pendingRequests || {}).filter((req) => req?.userId === userId).length;
}

function countClaimedByAdmin(tickets, adminId) {
  return Object.values(tickets).filter((t) => t.status === 'open' && t.claimedBy === adminId).length;
}

async function countClaimedByAdminSafe(guild, tickets, adminId) {
  let changed = false;
  for (const [channelId, ticket] of Object.entries(tickets || {})) {
    if (!ticket || ticket.status !== 'open' || ticket.claimedBy !== adminId) continue;
    const cached = guild?.channels?.cache?.get(channelId);
    if (cached) continue;
    const fetched = guild ? await withTimeout(guild.channels.fetch(channelId).catch(() => null), 1200) : null;
    if (!fetched) {
      ticket.status = 'closed';
      ticket.deletedChannel = true;
      ticket.claimedBy = null;
      changed = true;
    }
  }
  return { count: countClaimedByAdmin(tickets, adminId), changed };
}

function prunePendingRequests(pendingRequests, config = null) {
  let changed = false;
  for (const [reqId, req] of Object.entries(pendingRequests || {})) {
    const createdAt = Number(req?.createdAt || 0);
    if (!req || typeof req !== 'object' || !createdAt) {
      delete pendingRequests[reqId];
      changed = true;
      continue;
    }

    const hasClaimRefs = Array.isArray(req?.claimMessageRefs) && req.claimMessageRefs.length > 0;
    if (config?.autoCreateOnRequest) {
      delete pendingRequests[reqId];
      changed = true;
      continue;
    }

    if (config?.claimFromDedicatedChannel && !config?.claimChannelId) {
      delete pendingRequests[reqId];
      changed = true;
      continue;
    }

    if (!hasClaimRefs && !req?.claimedAt) {
      delete pendingRequests[reqId];
      changed = true;
    }
  }
  return changed;
}

function removeClaimMessageRefFromPendingRequests(pendingRequests, channelId, messageId) {
  let changed = false;
  let releasedRequests = 0;
  const safeChannelId = String(channelId || '');
  const safeMessageId = String(messageId || '');
  if (!safeChannelId || !safeMessageId) return { changed: false, releasedRequests: 0 };

  for (const [reqId, req] of Object.entries(pendingRequests || {})) {
    if (!req || !Array.isArray(req.claimMessageRefs) || !req.claimMessageRefs.length) continue;

    const nextRefs = req.claimMessageRefs.filter((ref) => {
      const refChannelId = String(ref?.channelId || '');
      const refMessageId = String(ref?.messageId || '');
      return !(refChannelId === safeChannelId && refMessageId === safeMessageId);
    });

    if (nextRefs.length === req.claimMessageRefs.length) continue;

    changed = true;
    req.claimMessageRefs = nextRefs;
    req.updatedAt = Date.now();

    if (!nextRefs.length && !req.claimedAt) {
      delete pendingRequests[reqId];
      releasedRequests += 1;
    }
  }

  return { changed, releasedRequests };
}

function removeClaimMessageRefFromGuildPanels(guildId, channelId, messageId) {
  const { guild } = getGuildData(guildId);
  let changedPanels = 0;

  for (const panelId of Object.keys(guild?.panels || {})) {
    const { config, tickets, pendingRequests } = getPanelData(guildId, panelId);
    const result = removeClaimMessageRefFromPendingRequests(pendingRequests, channelId, messageId);
    if (!result.changed) continue;
    setGuildData(guildId, config, tickets, pendingRequests, panelId);
    changedPanels += 1;
  }

  return changedPanels;
}

async function hasLiveClaimMessageReference(guild, req) {
  const refs = Array.isArray(req?.claimMessageRefs) ? req.claimMessageRefs : [];
  if (!guild || !refs.length) return false;

  for (const ref of refs) {
    const refChannelId = String(ref?.channelId || '').trim();
    const refMessageId = String(ref?.messageId || '').trim();
    if (!refChannelId || !refMessageId) continue;
    const channel = guild.channels.cache.get(refChannelId)
      || await withTimeout(guild.channels.fetch(refChannelId).catch(() => null), 1200);
    if (!channel?.isTextBased?.()) continue;
    const message = await withTimeout(channel.messages.fetch(refMessageId).catch(() => null), 1200);
    if (message) return true;
  }

  return false;
}

async function cleanupPendingRequestsForOpenAttempt(guild, config, pendingRequests, userId, panelId = 'default') {
  let changed = prunePendingRequests(pendingRequests, config);
  const relevant = Object.entries(pendingRequests || {})
    .filter(([, req]) => req?.userId === userId && req?.panelId === panelId && !req?.claimedAt);

  for (const [reqId, req] of relevant) {
    if (config?.autoCreateOnRequest) {
      delete pendingRequests[reqId];
      changed = true;
      continue;
    }

    if (config?.claimFromDedicatedChannel && !config?.claimChannelId) {
      delete pendingRequests[reqId];
      changed = true;
      continue;
    }

    const hasLiveMessage = await hasLiveClaimMessageReference(guild, req);
    if (!hasLiveMessage) {
      delete pendingRequests[reqId];
      changed = true;
    }
  }

  return changed;
}

function hasStaffAccess(member, config, reasonKey = null, ticket = null) {
  if (member?.user?.bot || member?.bot) return true;
  if (resolveTicketBlockForMember(member?.guild?.id, member)) return false;
  const adminRoles = getAdminRoles(config, reasonKey);
  const responsibleRoles = ((Array.isArray(ticket?.transferredRoleIds) && ticket.transferredRoleIds.length)
    ? ticket.transferredRoleIds
    : (config.responsibleRoleIds || [])).map((id) => String(id));
  let roleIds = [];

  if (member?.roles?.cache) roleIds = [...member.roles.cache.keys()];
  else if (Array.isArray(member?.roles)) roleIds = member.roles;
  else if (Array.isArray(member?.roles?.value)) roleIds = member.roles.value;
  else if (Array.isArray(member?.roles?.ids)) roleIds = member.roles.ids;

  roleIds = roleIds.map((id) => String(id));
  const hasRole = roleIds.some((id) => adminRoles.includes(id) || responsibleRoles.includes(id));
  return hasRole;
}

function hasStrictClaimAccess(member, config, reasonKey = null) {
  if (member?.user?.bot || member?.bot) return true;
  if (resolveTicketBlockForMember(member?.guild?.id, member)) return false;

  const adminRoles = getAdminRoles(config, reasonKey).map((id) => String(id));
  if (!adminRoles.length) return false;

  let roleIds = [];
  if (member?.roles?.cache) roleIds = [...member.roles.cache.keys()];
  else if (Array.isArray(member?.roles)) roleIds = member.roles;
  else if (Array.isArray(member?.roles?.value)) roleIds = member.roles.value;
  else if (Array.isArray(member?.roles?.ids)) roleIds = member.roles.ids;

  roleIds = roleIds.map((id) => String(id));
  return roleIds.some((id) => adminRoles.includes(id));
}

function hasResponsibleTicketAccess(member, config, guild, ticket = null) {
  if (resolveTicketBlockForMember(guild?.id, member)) return false;
  const allowedRoleIds = getActiveResponsibleRoleIds(config, guild, ticket);
  let memberRoleIds = [];
  const memberUserId = String(member?.id || member?.user?.id || '');
  const transferredUserIds = Array.isArray(ticket?.transferredUserIds) ? ticket.transferredUserIds.map((id) => String(id || '').trim()) : [];

  if (member?.roles?.cache) memberRoleIds = [...member.roles.cache.keys()];
  else if (Array.isArray(member?.roles)) memberRoleIds = member.roles;
  else if (Array.isArray(member?.roles?.value)) memberRoleIds = member.roles.value;
  else if (Array.isArray(member?.roles?.ids)) memberRoleIds = member.roles.ids;

  memberRoleIds = memberRoleIds.map((id) => String(id));
  if (memberUserId && transferredUserIds.includes(memberUserId)) return true;
  return memberRoleIds.some((id) => allowedRoleIds.includes(id));
}

function canManageTicket(interaction, ticket, config) {
  if (interaction.user.id === ticket.claimedBy) return true;
  return hasResponsibleTicketAccess(interaction.member, config, interaction.guild, ticket);
}

function canManagePostCloseControls(interaction, ticket, config) {
  if (resolveTicketBlockForMember(interaction.guild?.id, interaction.member)) return false;
  const allowedRoleIds = getGeneralResponsibleRoleIds(config, interaction.guild);
  const memberRoleIds = interaction.member?.roles?.cache ? [...interaction.member.roles.cache.keys()].map((id) => String(id)) : [];
  return memberRoleIds.some((id) => allowedRoleIds.includes(id));
}

function getGuildResponsibleRoleIds(guildId, guild) {
  const { guild: guildData } = getGuildData(guildId);
  const roleIds = new Set();
  for (const panel of Object.values(guildData?.panels || {})) {
    for (const roleId of panel?.config?.responsibleRoleIds || []) {
      const normalized = String(roleId || '').trim();
      if (/^\d{16,20}$/.test(normalized) && guild?.roles?.cache?.has(normalized)) {
        roleIds.add(normalized);
      }
    }
  }
  return [...roleIds];
}

function canUseGeneralPointsCommand(member, guildId, guild) {
  if (resolveTicketBlockForMember(guildId, member)) return false;
  const allowedRoleIds = getGuildResponsibleRoleIds(guildId, guild);
  let memberRoleIds = [];
  if (member?.roles?.cache) memberRoleIds = [...member.roles.cache.keys()];
  else if (Array.isArray(member?.roles)) memberRoleIds = member.roles;
  return memberRoleIds.map((id) => String(id)).some((id) => allowedRoleIds.includes(id));
}

function shouldShowManagerStats({ points, guildId, guild, targetId, targetMember = null }) {
  if (!targetMember) return false;
  return canUseGeneralPointsCommand(targetMember, guildId, guild);
}

function hasGlobalAdminAccess(member, message, BOT_OWNERS = [], ADMIN_ROLES = []) {
  if (!member || !message?.guild) return false;
  const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
  if (isOwner) return true;
  return member.roles?.cache?.some?.((role) => ADMIN_ROLES.includes(role.id)) || false;
}

function getTicketBlockData(guildId) {
  const store = loadStore();
  const guildEntry = store[guildId] || {};
  const blocks = Array.isArray(guildEntry.ticketBlocks) ? guildEntry.ticketBlocks : [];
  const blockChannelId = guildEntry.ticketBlockChannelId || null;
  return { store, guildEntry, blocks, blockChannelId };
}

function saveTicketBlockData(guildId, { blocks, blockChannelId }) {
  const store = loadStore();
  const guildEntry = store[guildId] || {};
  store[guildId] = {
    ...guildEntry,
    ticketBlocks: Array.isArray(blocks) ? blocks : [],
    ticketBlockChannelId: blockChannelId || null
  };
  saveStore(store);
}

function pruneTicketBlocks(blocks = [], now = Date.now()) {
  return (Array.isArray(blocks) ? blocks : []).filter((entry) => !entry?.expiresAt || Number(entry.expiresAt) > now);
}

function resolveTicketBlockForMember(guildId, member) {
  if (!guildId || !member) return null;
  const { blocks } = getTicketBlockData(guildId);
  const activeBlocks = pruneTicketBlocks(blocks);
  const memberId = String(member.id || member.user?.id || '');
  const roleIds = member.roles?.cache ? [...member.roles.cache.keys()].map((id) => String(id)) : [];
  return activeBlocks.find((entry) => {
    const targetId = String(entry?.targetId || '');
    if (entry?.targetType === 'user') return targetId === memberId;
    if (entry?.targetType === 'role') return roleIds.includes(targetId);
    return false;
  }) || null;
}

function formatBlockDuration(expiresAt) {
  if (!expiresAt) return 'بدون مدة';
  return `<t:${Math.floor(Number(expiresAt) / 1000)}:R>`;
}

function formatBlockDurationText(expiresAt) {
  if (!expiresAt) return 'بدون مدة (دائم)';
  return `حتى <t:${Math.floor(Number(expiresAt) / 1000)}:F> (${formatBlockDuration(expiresAt)})`;
}

async function syncTicketBlocks(guildId) {
  const data = getTicketBlockData(guildId);
  const cleaned = pruneTicketBlocks(data.blocks);
  if (cleaned.length !== data.blocks.length) {
    saveTicketBlockData(guildId, { blocks: cleaned, blockChannelId: data.blockChannelId });
  }
  return cleaned;
}

async function logTicketBlockAction(guild, actor, blockEntry, action = 'block') {
  if (!guild || !blockEntry) return false;
  const { blockChannelId } = getTicketBlockData(guild.id);
  if (!blockChannelId) return false;
  const channel = guild.channels.cache.get(blockChannelId) || await guild.channels.fetch(blockChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) return false;
  const targetMention = blockEntry.targetType === 'role' ? `<@&${blockEntry.targetId}>` : `<@${blockEntry.targetId}>`;
  const embed = makeTicketEmbed(
    action === 'unblock' ? 'Ticket Unblock' : 'Ticket Blocked',
    [
      `**الهدف :** ${targetMention}`,
      `**النوع :** ${blockEntry.targetType === 'role' ? 'رول' : 'عضو'}`,
      `**المدة :** ${formatBlockDuration(blockEntry.expiresAt)}`,
      `**السبب :** ${blockEntry.reason || 'بدون سبب'}`,
      `**الوقت :** <t:${Math.floor(Number(blockEntry.createdAt || Date.now()) / 1000)}:F>`,
      `**بواسطة :** <@${actor.id}>`
    ].join('\n'),
    { user: actor }
  );
  await channel.send({ embeds: [embed] }).catch((error) => logSilentError('suppressed', error));
  return true;
}

async function notifyTicketBlockTarget(guild, actor, blockEntry, action = 'block') {
  if (!guild || !actor || !blockEntry || blockEntry.targetType !== 'user') return false;
  const user = await guild.client.users.fetch(blockEntry.targetId).catch(() => null);
  if (!user) return false;

  const description = action === 'unblock'
    ? [
      '**تم فك بلوك التكت عنك.**',
      `**بواسطة :** <@${actor.id}>`,
      `**الوقت :** <t:${Math.floor(Date.now() / 1000)}:F>`
    ].join('\n')
    : [
      '**تم اعطائك بلوك تكت.**',
      `**المدة :* ${formatBlockDurationText(blockEntry.expiresAt)}`,
      `**السبب :** ${blockEntry.reason || 'بدون سبب'}`,
      `**بواسطة :** <@${actor.id}>`,
      `**الوقت :** <t:${Math.floor(Number(blockEntry.createdAt || Date.now()) / 1000)}:F>`
    ].join('\n');

  await user.send(buildTicketMessagePayload(action === 'unblock' ? 'Ticket Unblock' : 'Ticket Blocked', description, { user: actor })).catch((error) => logSilentError('suppressed', error));
  return true;
}

function canUserWriteInTicket(message, ticket, config) {
  const userId = message.author?.id;
  if (!userId || message.author?.bot) return true;
  if (resolveTicketBlockForMember(message.guild?.id, message.member)) return false;
  if (!ticket) return true;
  if (ticket.memberId === userId) return true;
  if (ticket.claimedBy === userId) return true;
  if (Array.isArray(ticket.extraMembers) && ticket.extraMembers.includes(userId)) return true;
  return hasResponsibleTicketAccess(message.member, config, message.guild, ticket);
}

async function deleteClaimMessageIfEnabled(interaction, config) {
  if (!config?.deleteClaimMessageOnClaim || !interaction?.message?.id) return false;
  const directDelete = await interaction.message.delete().then(() => true).catch(() => false);
  if (directDelete) return true;
  const fallbackChannel = interaction.channel
    || interaction.guild?.channels?.cache?.get?.(interaction.message.channelId)
    || await interaction.guild?.channels?.fetch?.(interaction.message.channelId).catch(() => null);
  if (!fallbackChannel?.messages?.delete) return false;
  return fallbackChannel.messages.delete(interaction.message.id).then(() => true).catch(() => false);
}

function normalizeMessageRefs(refs = []) {
  if (!Array.isArray(refs)) return [];
  return refs
    .map((ref) => ({
      channelId: String(ref?.channelId || '').trim(),
      messageId: String(ref?.messageId || '').trim()
    }))
    .filter((ref) => /^\d{16,20}$/.test(ref.channelId) && /^\d{16,20}$/.test(ref.messageId));
}

async function deleteTrackedMessages(guild, refs = [], preserveMessageId = null) {
  const normalized = normalizeMessageRefs(refs)
    .filter((ref) => !preserveMessageId || ref.messageId !== String(preserveMessageId));
  if (!normalized.length || !guild) return false;

  let deletedAny = false;
  const refsByChannel = normalized.reduce((acc, ref) => {
    if (!acc.has(ref.channelId)) acc.set(ref.channelId, []);
    acc.get(ref.channelId).push(ref.messageId);
    return acc;
  }, new Map());

  for (const [channelId, messageIds] of refsByChannel.entries()) {
    const channel = guild.channels?.cache?.get?.(channelId)
      || await guild.channels?.fetch?.(channelId).catch((error) => {
        logSilentError('tracked-messages.channel-fetch', error);
        return null;
      });
    if (!channel?.bulkDelete && !channel?.messages?.delete) continue;

    const uniqueMessageIds = [...new Set(messageIds)];
    if (channel.bulkDelete && uniqueMessageIds.length > 1) {
      const bulkDeleted = await channel.bulkDelete(uniqueMessageIds, true).catch((error) => {
        logSilentError('tracked-messages.bulk-delete', error);
        return null;
      });
      if (bulkDeleted?.size) {
        deletedAny = true;
        const deletedIds = new Set([...bulkDeleted.keys()].map((id) => String(id)));
        for (const messageId of uniqueMessageIds) {
          if (deletedIds.has(String(messageId))) continue;
          const deleted = await channel.messages.delete(messageId).then(() => true).catch((error) => {
            logSilentError('tracked-messages.single-delete', error);
            return false;
          });
          if (deleted) deletedAny = true;
        }
        continue;
      }
    }

    for (const messageId of uniqueMessageIds) {
      const deleted = await channel.messages.delete(messageId).then(() => true).catch((error) => {
        logSilentError('tracked-messages.single-delete', error);
        return false;
      });
      if (deleted) deletedAny = true;
    }
  }

  return deletedAny;
}

async function recordUnauthorizedTicketMessage(message, ticket, config) {
  if (!message?.guild || !ticket || !config) return;
  const actorId = message.author?.id || 'unknown';
  if (!ticket.unauthorizedMessageCounts || typeof ticket.unauthorizedMessageCounts !== 'object') {
    ticket.unauthorizedMessageCounts = {};
  }
  ticket.unauthorizedMessageCounts[actorId] = Number(ticket.unauthorizedMessageCounts[actorId] || 0) + 1;
  const unauthorizedCount = ticket.unauthorizedMessageCounts[actorId];

  await syncTicketLogMessage({
    guild: message.guild,
    config,
    ticket,
    channelId: message.channelId || message.channel?.id,
    actionText: {
      type: 'unauthorized_message',
      message: `تم حذف رسايل غير مصرح بها من : <@${actorId}>  ( عدد الرسايل : ${unauthorizedCount} )`,
      actorId: message.author?.id || null,
      metadata: {
        snippet: String(message.content || '').slice(0, 180)
      }
    },
    actor: message.author || null
  }).catch((error) => logSilentError('suppressed', error));
}

function rememberDeletedTicketMessage(ticket, message) {
  if (!ticket || !message) return false;
  if (!Array.isArray(ticket.deletedMessages)) ticket.deletedMessages = [];
  if (message.id && ticket.deletedMessages.some((entry) => entry?.id === message.id)) return false;
  const avatarUrl = message.author?.displayAvatarURL?.({ extension: 'png', forceStatic: false, size: 128 })
    || message.author?.avatarURL?.({ extension: 'png', forceStatic: false, size: 128 })
    || message.author?.avatarURL?.()
    || null;
  ticket.deletedMessages.push({
    id: message.id || `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    authorId: message.author?.id || null,
    authorTag: message.author?.tag || null,
    authorName: message.author?.username || null,
    avatarUrl,
    content: String(message.content || ''),
    createdTimestamp: Number(message.createdTimestamp || Date.now()),
    deletedAt: Date.now()
  });
  if (ticket.deletedMessages.length > 100) ticket.deletedMessages = ticket.deletedMessages.slice(-100);
  return true;
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
  const includeClaimButton = options.includeClaimButton !== false && !options.disableClaimButton;
  const includeReassignButton = options.hideReassignButton !== true;
  const row1Buttons = [];
  if (includeClaimButton) row1Buttons.push(new ButtonBuilder().setCustomId(`ticket_claim_${guildId}_${panelId}_${channelId}`).setLabel('Claim').setEmoji('<:emoji_3:1484364952780144710>').setStyle(ButtonStyle.Success));
  row1Buttons.push(
    new ButtonBuilder().setCustomId(`ticket_close_${guildId}_${panelId}_${channelId}`).setLabel('Close').setEmoji('<:emoji_7:1484365118576918638>').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_reassign_${guildId}_${panelId}_${channelId}`).setLabel('Change').setEmoji('<:emoji_2:1484364894491902034>').setStyle(ButtonStyle.Secondary)
  );
  if (includeReassignButton) {
    row1Buttons.push(
      new ButtonBuilder().setCustomId(`ticket_rename_${guildId}_${panelId}_${channelId}`).setLabel(' Name').setEmoji('<:emoji_5:1484364982094266428>').setStyle(ButtonStyle.Secondary)
    );
  }
  const row1 = new ActionRowBuilder().addComponents(row1Buttons);

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_add_${guildId}_${panelId}_${channelId}`).setLabel('Add').setEmoji('<:emoji_7:1484365079435542678>').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_remove_${guildId}_${panelId}_${channelId}`).setLabel('Remove').setEmoji('<:emoji_6:1484365038868365507>').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ticket_ping_${guildId}_${panelId}_${channelId}`).setEmoji('<:emoji_3:1484364925865558086>').setStyle(ButtonStyle.Secondary)
  );

  let responsibilities = loadResponsibilities();
  const responsibilitiesFileExists = fs.existsSync(responsibilitiesPath);
  if (!responsibilitiesFileExists && Object.keys(responsibilities || {}).length === 0) {
    responsibilities = await waitForResponsibilitiesRecovery();
  }
  const allResponsibilityNames = Object.keys(responsibilities);
  const canSearchResponsibilities = allResponsibilityNames.length > 25;
  const responsibilityNames = canSearchResponsibilities ? allResponsibilityNames.slice(0, 24) : allResponsibilityNames.slice(0, 25);
  const responsibilityOptions = responsibilityNames
    .map((respName, index) => {
      const count = Array.isArray(responsibilities?.[respName]?.responsibles)
        ? responsibilities[respName].responsibles.length
        : 0;
      const originalIndex = allResponsibilityNames.indexOf(respName);
      return {
        label: respName.slice(0, 100),
        value: `respidx_${originalIndex}`,
          emoji: '<:emoji_1:1484364853832319056>',
        description: `عدد المسؤولين : ${count}`
      };
    });
  if (canSearchResponsibilities) {
    responsibilityOptions.push({
      label: 'بحث بالاسم',
        
      value: 'resp_search',
        emoji: '<:emoji_73:1442588719201648811>',
      description: 'ابحث عن المسؤولية بالاسم '
    });
  }

  const row3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`ticket_transfer_${guildId}_${panelId}_${channelId}`)
      .setPlaceholder(
        responsibilityOptions.length
          ? 'اختر مسؤولية لتحويل التكت'
          : (responsibilitiesFileExists ? 'لا توجد مسؤوليات متاحة للتحويل' : 'ملف المسؤوليات محذوف أو فارغ')
      )
      .addOptions(
        responsibilityOptions.length
          ? responsibilityOptions
          : [{
            label: responsibilitiesFileExists ? 'لا توجد مسؤوليات' : '⚠️ ملف المسؤوليات محذوف/فارغ',
            value: 'resp_none'
          }]
      )
      .setDisabled(responsibilityOptions.length === 0)
  );

  return [row1, row2, row3];
}

async function createTicketChannel({
  guild,
  member,
  config,
  reasonKey,
  tickets,
  pendingRequests,
  includeClaimButton = true,
  panelId = 'default',
  openModalAnswers = null,
  claimedByOnCreate = null
}) {
  const reasonSettings = getReasonVisualSettings(config, reasonKey);
  const reason = reasonSettings.reason;
  const prefix = sanitizeName(reason.ticketName || config.ticketNamePrefix || 'ticket') || 'ticket';
  const memberId = member?.id || member?.user?.id || null;
  if (!memberId) {
    throw new Error('MEMBER_ID_MISSING');
  }

  const memberUsername = member?.user?.username || member?.displayName || 'user';
  const suffix = config.ticketNameMode === 'user' ? sanitizeName(memberUsername) : String(config.counter || 1);
  const channelName = `${prefix}-${suffix}`.slice(0, 90);
  const categoryId = reason.categoryId || config.openCategoryId || null;

  const configuredStaffRoles = [...new Set([...(config.responsibleRoleIds || [])])]
    .map((roleId) => String(roleId || '').trim())
    .filter((roleId) => /^\d{16,20}$/.test(roleId) && guild.roles.cache.has(roleId));
  const adminRoles = getAdminRoles(config, reasonKey)
    .map((roleId) => String(roleId || '').trim())
    .filter((roleId) => /^\d{16,20}$/.test(roleId) && guild.roles.cache.has(roleId));
  const allStaffRoles = [...new Set([...configuredStaffRoles, ...adminRoles])];
  const shouldApplyHideOnCreate = Boolean(claimedByOnCreate && config.hideOnClaim);

  const permissionOverwrites = [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }];

  if (shouldApplyHideOnCreate) {
    permissionOverwrites.push({
      id: memberId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    });
    if (claimedByOnCreate !== memberId) {
      permissionOverwrites.push({
        id: claimedByOnCreate,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
      });
    }
    for (const roleId of allStaffRoles) {
      const shouldSee = configuredStaffRoles.includes(roleId);
      permissionOverwrites.push(shouldSee
        ? { id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
        : { id: roleId, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }
  } else {
    const shouldExposeAdminRolesUntilClaim = includeClaimButton && !config.claimFromDedicatedChannel;
    const bootstrapStaffRoles = shouldExposeAdminRolesUntilClaim
      ? [...new Set([...configuredStaffRoles, ...adminRoles])]
      : [...new Set([...configuredStaffRoles])];
    permissionOverwrites.push({
      id: memberId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
    });
    for (const roleId of bootstrapStaffRoles) {
      permissionOverwrites.push({
        id: roleId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
      });
    }
  }

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: categoryId || undefined,
    permissionOverwrites
  });

  const controls = await buildTicketControls(guild.id, panelId, channel.id, config, { includeClaimButton });

  const shouldMentionAdminsOnOpen = Boolean(includeClaimButton && config.autoCreateOnRequest && !config.claimFromDedicatedChannel && !claimedByOnCreate);
  const openMentionsText = shouldMentionAdminsOnOpen
    ? buildMentionChunks(getAdminRoles(config, reasonKey)).join(' ')
    : '';

  const introText = renderTicketText(reasonSettings.beforeText, memberId);
  const openImage = resolveImageForSend(reasonSettings.openImage);
  const outroText = renderTicketText(reasonSettings.afterText, memberId);
  const introContent = introText && openMentionsText
    ? `${introText} | ${openMentionsText}`
    : (introText || openMentionsText || '');

  // Send initial message with controls and intro text/image first
  await channel.send({
    ...(introContent ? { content: introContent } : {}),
    ...(openImage ? { files: [openImage] } : {}),
    components: controls
  }).catch((error) => logSilentError("create.sendIntroMessage", error));

  // Trigger outro after intro is confirmed to preserve order, without blocking the rest of creation flow.
  const outroSendPromise = outroText
    ? channel.send({ content: outroText }).catch((error) => logSilentError("create.sendOutroMessage", error))
    : Promise.resolve();

  // Update counter if not in user mode (this will be handled by setGuildData which queues writes)
  if (config.ticketNameMode !== "user") {
    config.counter = (config.counter || 1) + 1;
  }

  tickets[channel.id] = {
    channelId: channel.id,
    panelId,
    memberId,
    reasonKey,
    claimedBy: claimedByOnCreate || null,
    pointsReceiverId: claimedByOnCreate || null,
    status: 'open',
    extraMembers: [],
    logMessageId: null,
    logHistory: [],
    logEvents: [],
    deletedMessages: [],
    unauthorizedMessageCounts: {},
    openModalAnswers: openModalAnswers && typeof openModalAnswers === 'object' ? openModalAnswers : undefined,
    createdAt: Date.now(),
    lastActivityAt: Date.now()
  };

  const syncLogPromise = syncTicketLogMessage({
    guild,
    config,
    ticket: tickets[channel.id],
    channelId: channel.id,
    actionText: `تم فتح التكت عن طريق : <@${memberId}>`,
    actor: member?.user || null
  });

  await Promise.allSettled([outroSendPromise, syncLogPromise]);

  setGuildData(guild.id, config, tickets, pendingRequests, panelId);
  return channel;
}

async function applyHideOnClaim(channel, guild, config, claimerId, memberId, extraMembers = [], reasonKey = null) {
  const adminRoles = getAdminRoles(config, reasonKey)
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id) && guild.roles.cache.has(id));
  const configuredStaffRoles = [...new Set([...(config.responsibleRoleIds || [])])]
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id) && guild.roles.cache.has(id));
  const visibleStaffRoles = [...configuredStaffRoles];
  const allStaffRoles = [...new Set([...adminRoles, ...configuredStaffRoles])];

  const tasks = [
    channel.permissionOverwrites.edit(guild.roles.everyone.id, {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: false
    }),
    channel.permissionOverwrites.edit(claimerId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    }),
    channel.permissionOverwrites.edit(memberId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    }),
    ...allStaffRoles.map((roleId) => {
      const shouldSee = visibleStaffRoles.includes(roleId);
      return channel.permissionOverwrites.edit(roleId, {
        ViewChannel: shouldSee,
        SendMessages: shouldSee,
        ReadMessageHistory: shouldSee
      });
    }),
    ...extraMembers.map((userId) => channel.permissionOverwrites.edit(userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    }))
  ];
  await runConcurrentTasks(tasks, 'claim.hide.permissions');
}

async function handleOpenRequest(interaction, guildId, panelId, reasonKey) {
  const safePanelId = panelId || 'default';
  const lockKey = `openreq:${guildId}:${safePanelId}:${interaction.user.id}`;
  if (!interaction.deferred && !interaction.replied) {
    await interaction.reply(buildTicketMessagePayload('Request', '**يرجى الانتظار...**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
  }
  if (ticketOpenRequestLocks.has(lockKey)) {
    await interaction.editReply(buildTicketMessagePayload('Alert', '**جاري تنفيذ طلبك، انتظر لحظات ولا تضغط أكثر من مرة.**'));
    return;
  }
  ticketOpenRequestLocks.add(lockKey);
  try {
  const guild = interaction.guild;
  const { config, tickets, pendingRequests } = getPanelData(guildId, safePanelId);
  const isBlocked = await Promise.resolve(resolveTicketBlockForMember(guildId, interaction.member));

  if (isBlocked) {
    await interaction.editReply(buildTicketMessagePayload('Ticket Blocked', '**عندك بلوك تكت لا يمكنك فتح تكت.**'));
    return;
  }

  const pruned = await cleanupPendingRequestsForOpenAttempt(
    guild,
    config,
    pendingRequests,
    interaction.user.id,
    safePanelId
  );
  if (pruned) setGuildData(guildId, config, tickets, pendingRequests, safePanelId);

  const duplicateRequest = Object.values(pendingRequests)
    .find((req) => req.userId === interaction.user.id && req.panelId === safePanelId && !req.claimedAt);
  if (duplicateRequest) {
    await interaction.editReply(buildTicketMessagePayload('Alert', '**لديك طلب استلام معلّق بالفعل، انتظر حتى تتم معالجته.**'));
    return;
  }

  if (!config.autoCreateOnRequest && !config.claimFromDedicatedChannel && !interaction.channelId) {
    await interaction.editReply(buildTicketMessagePayload('Eror', '**لا يمكن إنشاء طلب الاستلام بدون شات صالح.**'));
    return;
  }

  if (!config.autoCreateOnRequest && config.claimFromDedicatedChannel && !config.claimChannelId) {
    await interaction.editReply(buildTicketMessagePayload('Error', '**لا يمكن فتح الطلب الآن : شات الاستلام المخصص غير محدد.**'));
    return;
  }

  const openState = await countOpenMemberTicketsSafe(guild, tickets, interaction.user.id);
  if (openState.changed) {
    setGuildData(guildId, config, tickets, pendingRequests, safePanelId);
  }
  const openCount = openState.count;
  const pendingCount = countPendingMemberRequests(pendingRequests, interaction.user.id);
  if ((openCount + pendingCount) >= (config.memberOpenLimit || 1)) {
    await interaction.editReply(buildTicketMessagePayload('Alert', `**الحد : وصلت لاقصى تكت مفتوح (${config.memberOpenLimit}).**`));
    return;
  }

  if (config.autoCreateOnRequest) {
    try {
      await createTicketChannel({ guild, member: interaction.member, config, reasonKey, tickets, pendingRequests, panelId: safePanelId, openModalAnswers: interaction.ticketModalAnswers || null });
      await interaction.editReply(buildTicketMessagePayload('Request', ` ** تم ارسال طلبك للإدارة يرجى الانتظار.. ** `));
    } catch (error) {
      console.error('ticket open create channel error:', error?.message || error);
      await interaction.editReply(buildTicketMessagePayload('Error', '**فشل فتح التكت، تأكد من صلاحيات البوت .**'));
    }
    return;
  }

  const reqId = `${guildId}_${safePanelId}_${interaction.user.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  pendingRequests[reqId] = {
    guildId,
    panelId: safePanelId,
    userId: interaction.user.id,
    reasonKey,
    sourceChannelId: interaction.channelId,
    openModalAnswers: interaction.ticketModalAnswers || null,
    claimMessageRefs: [],
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  const targetChannelId = config.claimFromDedicatedChannel ? config.claimChannelId : interaction.channelId;
  const targetChannel = await guild.channels.fetch(targetChannelId).catch(() => null);
  if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
    delete pendingRequests[reqId];
    setGuildData(guildId, config, tickets, pendingRequests, safePanelId);
    await interaction.editReply(buildTicketMessagePayload('خطأ', '**فشل : شات الاستلام غير صالح.**'));
    return;
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_claimreq_${reqId}`).setStyle(ButtonStyle.Secondary).setEmoji('<:emoji_5:1484364982094266428>').setLabel('Claim')
  );

  const reasonSettings = getReasonVisualSettings(config, reasonKey);
  const reasonData = reasonSettings.reason;
  const claimImage = resolveImageForSend(reasonSettings.claimImage);

  const mentionChunks = buildMentionChunks(getAdminRoles(config, reasonKey));

  try {
    const mentionMessages = await Promise.allSettled(
      mentionChunks.map((chunk) => targetChannel.send({ content: chunk }))
    );
    for (const item of mentionMessages) {
      if (item.status !== 'fulfilled') continue;
      const sent = item.value;
      if (sent?.id) {
        pendingRequests[reqId].claimMessageRefs.push({ channelId: sent.channelId || targetChannel.id, messageId: sent.id });
      }
    }

    const requestSummary = `**العضو :** <@${interaction.user.id}>\n**السبب :** ${reasonData.name || `سبب ${reasonKey}`}${reasonData.description ? `\n**الوصف :** ${reasonData.description}` : ''}`;

    if (claimImage) {
      const sent = await targetChannel.send({ content: requestSummary, files: [claimImage], components: [row] });
      if (sent?.id) {
        pendingRequests[reqId].claimMessageRefs.push({ channelId: sent.channelId || targetChannel.id, messageId: sent.id });
      }
    } else {
      const sent = await targetChannel.send({ content: requestSummary, components: [row] });
      if (sent?.id) {
        pendingRequests[reqId].claimMessageRefs.push({ channelId: sent.channelId || targetChannel.id, messageId: sent.id });
      }
    }
  } catch (error) {
    const refsToDelete = Array.isArray(pendingRequests[reqId]?.claimMessageRefs) ? [...pendingRequests[reqId].claimMessageRefs] : [];
    delete pendingRequests[reqId];
    setGuildData(guildId, config, tickets, pendingRequests, safePanelId);
    await deleteTrackedMessages(guild, refsToDelete).catch((error) => logSilentError('suppressed', error));
    console.error('ticket open request send error:', error?.message || error);
    await interaction.editReply(buildTicketMessagePayload('Error', '**فشل إرسال طلب التكت، حاول مرة أخرى بعد قليل.**'));
    return;
  }

  setGuildData(guildId, config, tickets, pendingRequests, safePanelId);
  await interaction.editReply(buildTicketMessagePayload('Request', '**تم ارسال طلبك للإدارة يرجى الانتظار..**'));
  } finally {
    ticketOpenRequestLocks.delete(lockKey);
  }
}

async function handleClaimInTicket(interaction, guildId, panelId, channelId) {
  await interaction.deferReply({ ephemeral: true }).catch((error) => logSilentError('suppressed', error));
  const lockKey = `claim:${guildId}:${channelId}`;
  if (ticketClaimLocks.has(lockKey)) {
    await interaction.editReply(buildTicketMessagePayload('Alert', '**جاري المعالجة حاول بعد لحظات.**', { user: interaction.user }));
    return;
  }
  ticketClaimLocks.add(lockKey);
  try {
  const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId || 'default');
  if (!ticket || ticket.status !== 'open' || interaction.channelId !== actionChannelId) {
    await interaction.editReply(buildTicketMessagePayload('Alert', '**هذا التكت غير متاح.**', { user: interaction.user }));
    return;
  }

  if (!hasStaffAccess(interaction.member, config, ticket?.reasonKey, ticket)) {
    await interaction.editReply(buildTicketMessagePayload('Alert', '**ليس لديك صلاحية الاستلام.**', { user: interaction.user }));
    return;
  }

  if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) {
    await interaction.editReply(buildTicketMessagePayload('Alert', `**التكت مستلم مسبقاً بواسطة :** <@${ticket.claimedBy}>`, { user: interaction.user }));
    return;
  }

  if (ticket.claimedBy === interaction.user.id) {
    await interaction.editReply(buildTicketMessagePayload('Alert', '**أنت مستلم هذا التكت بالفعل.**', { user: interaction.user }));
    return;
  }

  const claimedState = await countClaimedByAdminSafe(interaction.guild, tickets, interaction.user.id);
  if (claimedState.changed) {
    setGuildData(guildId, config, tickets, pendingRequests, resolvedPanelId);
  }
  const claimedCount = claimedState.count;
  if (claimedCount >= (config.adminClaimLimit || 1)) {
    await interaction.editReply(buildTicketMessagePayload('Alert', `**الحد :** لا يمكنك استلام أكثر من ${config.adminClaimLimit} تكت مفتوح.`, { user: interaction.user }));
    return;
  }

  ticket.claimedBy = interaction.user.id;
  ticket.pointsReceiverId = interaction.user.id;
  touchTicketActivity(ticket);
  recordClaimPointIfNeeded(ticket, {
    guildId,
    panelId: resolvedPanelId,
    channelId: actionChannelId,
    actorId: interaction.user.id,
    targetId: ticket.memberId || ''
  });
  setGuildData(guildId, config, tickets, pendingRequests, resolvedPanelId);
  await interaction.editReply(buildTicketMessagePayload('Claimed', '**تم استلام التكت بنجاح.**', { user: interaction.user }));

  await sendClaimAnnounce({
    channel: interaction.channel,
    config,
    ticket,
    claimerId: interaction.user.id,
    claimImage: null,
    suppressRoleMentions: Boolean(config.autoCreateOnRequest && !config.claimFromDedicatedChannel)
  }).catch((error) => logSilentError('suppressed', error));

  const postClaimTasks = [];
  if (config.hideOnClaim || !config.claimFromDedicatedChannel) {
    postClaimTasks.push(
      applyHideOnClaim(
        interaction.channel,
        interaction.guild,
        config,
        interaction.user.id,
        ticket.memberId,
        ticket.extraMembers || [],
        ticket.reasonKey
      )
    );
  }
  postClaimTasks.push(
    syncTicketLogMessage({
      guild: interaction.guild,
      config,
      ticket,
      channelId: actionChannelId,
      actionText: `تم الاستلام عن طريق : <@${interaction.user.id}>`,
      actor: interaction.user
    })
  );

  if (interaction.message?.components?.length) {
    const updatedRows = interaction.message.components.map((row) => {
      const updatedComponents = row.components.map((component) => {
        if (component.customId?.startsWith('ticket_claim_')) {
          return ButtonBuilder.from(component).setDisabled(true).setEmoji('<:emoji_3:1484364952780144710>').setLabel('Claimed');
        }
        return component;
      });
      return new ActionRowBuilder().addComponents(updatedComponents);
    });

const keepClaimMessageInTicketFlow = Boolean(config.autoCreateOnRequest && !config.claimFromDedicatedChannel);
    if (config.deleteClaimMessageOnClaim && !keepClaimMessageInTicketFlow) {      postClaimTasks.push(deleteClaimMessageIfEnabled(interaction, config));
    } else {
      postClaimTasks.push(interaction.message.edit({
        components: updatedRows
      }));
    }
  }

  await Promise.allSettled(postClaimTasks);
  } finally {
    ticketClaimLocks.delete(lockKey);
  }
}

async function handleClaimFromRequest(interaction, reqId) {
  await interaction.deferReply({ ephemeral: true }).catch((error) => logSilentError('suppressed', error));
  const lockKey = `claimreq:${reqId}`;
  if (ticketClaimLocks.has(lockKey)) {
    await interaction.editReply(buildTicketMessagePayload('Alert', '**جاري معالجة هذا الطلب، حاول بعد لحظات.**', { user: interaction.user }));
    return;
  }
  ticketClaimLocks.add(lockKey);
  try {
  const [guildId, preferredPanelId = 'default'] = reqId.split('_');
  let requestContext = findPendingRequestContext(guildId, reqId, preferredPanelId);

  if (!requestContext) {
    await interaction.editReply(buildTicketMessagePayload('Alert', '**انتهى الطلب.**', { user: interaction.user }));
    return;
  }

  let { panelId, config, tickets, pendingRequests, req } = requestContext;
  const pruned = prunePendingRequests(pendingRequests, config);
  if (pruned) {
    setGuildData(guildId, config, tickets, pendingRequests, panelId);
    requestContext = findPendingRequestContext(guildId, reqId, panelId);
    if (!requestContext) {
      await interaction.editReply(buildTicketMessagePayload('Alert', '**انتهى الطلب.**', { user: interaction.user }));
      return;
    }
    ({ panelId, config, tickets, pendingRequests, req } = requestContext);
  }

  if (!hasStaffAccess(interaction.member, config, req?.reasonKey)) {
    await interaction.editReply(buildTicketMessagePayload('Alert', '**ليس لديك صلاحية الاستلام.**', { user: interaction.user }));
    return;
  }

  const claimedState = await countClaimedByAdminSafe(interaction.guild, tickets, interaction.user.id);
  if (claimedState.changed) {
    setGuildData(guildId, config, tickets, pendingRequests, panelId);
  }
  const claimedCount = claimedState.count;
  if (claimedCount >= (config.adminClaimLimit || 1)) {
    await interaction.editReply(buildTicketMessagePayload('Alert', `**الحد :** لا يمكنك استلام أكثر من ${config.adminClaimLimit} تكت مفتوح.`, { user: interaction.user }));
    return;
  }

  const member = await resolveGuildMember(interaction.guild, req.userId);
  if (!member) {
    delete pendingRequests[reqId];
    setGuildData(guildId, config, tickets, pendingRequests, panelId);
    await interaction.editReply(buildTicketMessagePayload('Member', '**لا يمكن العثور على العضو.**', { user: interaction.user }));
    return;
  }

  let channel;
  req.claimedAt = Date.now();
  req.claimedBy = interaction.user.id;
  req.status = 'claiming';
  req.updatedAt = Date.now();
  setGuildData(guildId, config, tickets, pendingRequests, panelId);
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
      openModalAnswers: req.openModalAnswers || null,
      claimedByOnCreate: interaction.user.id
    });
  } catch (error) {
    req.claimedAt = null;
    req.claimedBy = null;
    req.status = 'pending';
    req.updatedAt = Date.now();
    setGuildData(guildId, config, tickets, pendingRequests, panelId);
    console.error('ticket claimreq create channel error:', error?.message || error);
    await interaction.editReply(buildTicketMessagePayload('Error', '**فشل انشاء التكت من طلب الاستلام، تأكد من صلاحيات .**', { user: interaction.user }));
    return;
  }
  const createdTicket = tickets[channel.id];
  createdTicket.claimedBy = interaction.user.id;
  createdTicket.pointsReceiverId = interaction.user.id;
  touchTicketActivity(createdTicket);
  recordClaimPointIfNeeded(createdTicket, {
    guildId,
    panelId,
    channelId: channel.id,
    actorId: interaction.user.id,
    targetId: createdTicket.memberId || ''
  });

  delete pendingRequests[reqId];
  setGuildData(guildId, config, tickets, pendingRequests, panelId);
  await interaction.editReply(buildTicketMessagePayload('Claimed', `**تم الاستلام والانشاء :** <#${channel.id}>`));

  const claimImage = resolveImageForSend(getReasonVisualSettings(config, createdTicket.reasonKey).claimImage);
  await sendClaimAnnounce({ channel, config, ticket: createdTicket, claimerId: interaction.user.id, claimImage });

  const postClaimTasks = [];
  // الصلاحيات تُضبط أثناء إنشاء التكت عند تفعيل hideOnClaim لتفادي أي تأخير بعد الإنشاء.
  postClaimTasks.push(
    syncTicketLogMessage({
      guild: interaction.guild,
      config,
      ticket: createdTicket,
      channelId: channel.id,
      actionText: `تم الاستلام عن طريق : <@${interaction.user.id}>`,
      actor: interaction.user
    })
  );

  if (interaction.message?.editable) {
    postClaimTasks.push((async () => {
      const updatedRows = interaction.message.components.map((row) => {
        const components = row.components.map((component) => {
          if (component.customId?.startsWith('ticket_claimreq_')) {
            return ButtonBuilder.from(component).setDisabled(true).setEmoji('<:emoji_3:1484364952780144710>').setLabel('Claimed');
          }
          return component;
        });
        return new ActionRowBuilder().addComponents(components);
      });
      if (config.deleteClaimMessageOnClaim) {
        await Promise.allSettled([
          deleteTrackedMessages(interaction.guild, req?.claimMessageRefs, interaction.message.id),
          deleteClaimMessageIfEnabled(interaction, config)
        ]);
      } else {
        await interaction.message.edit({
          content: buildClaimRequestContent(createdTicket, config, interaction.user.id),
          embeds: [],
          components: updatedRows
        });
      }
    })());
  }

  await Promise.allSettled(postClaimTasks);

  } finally {
    ticketClaimLocks.delete(lockKey);
  }
}

async function buildFeedbackCardImage({ guild, member, stars, comment, style = {} }) {
  ensureFeedbackFontsRegistered();
  const width = 1800;
  const height = 860;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.antialias = 'subpixel';

  // External background intentionally transparent (render card only)
  ctx.clearRect(0, 0, width, height);

  const cardX = 250;
  const cardY = 104;
  const cardW = 1300;
  const cardH = 520;
  const radius = 58;

  const cardGrad = ctx.createLinearGradient(cardX, cardY, cardX + cardW, cardY + cardH);
  cardGrad.addColorStop(0, normalizeHexColor(style.cardStart, '#46357f'));
  cardGrad.addColorStop(1, normalizeHexColor(style.cardEnd, '#6652a3'));
  // Multi-pass outer shadow for heavy 3D look
  ctx.save();
  ctx.shadowColor = normalizeHexColor(style.shadow, '#000000');
  ctx.shadowBlur = 62;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = cardGrad;
  drawRoundedRectPath(ctx, cardX, cardY, cardW, cardH, radius);
  ctx.fill();
  ctx.restore();

  // Additional soft glow around top edge
  const topGlow = ctx.createLinearGradient(cardX, cardY - 20, cardX, cardY + 120);
  topGlow.addColorStop(0, '#ffffff20');
  topGlow.addColorStop(1, '#ffffff00');
  ctx.fillStyle = topGlow;
  drawRoundedRectPath(ctx, cardX + 4, cardY + 2, cardW - 8, 130, radius - 8);
  ctx.fill();

  // Inner highlight and border pass
  ctx.globalAlpha = 0.16;
  const inner = ctx.createLinearGradient(cardX, cardY, cardX + cardW, cardY + cardH);
  inner.addColorStop(0, '#ffffff');
  inner.addColorStop(1, '#ffffff00');
  ctx.fillStyle = inner;
  drawRoundedRectPath(ctx, cardX, cardY, cardW, cardH, radius);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = normalizeHexColor(style.border, '#9c88ff');
  ctx.lineWidth = 4;
  drawRoundedRectPath(ctx, cardX, cardY, cardW, cardH, radius);
  ctx.stroke();

  // Inner motifs on card (left + right) to match reference
  ctx.save();
  ctx.globalAlpha = 0.09;
  ctx.strokeStyle = '#b6a9f0';
  ctx.lineWidth = 1.25;
  for (let i = 0; i < 6; i += 1) {
    const lx = cardX + 82 + (i * 58);
    const ly = cardY + 94 + (i * 46);
    ctx.beginPath();
    ctx.moveTo(lx, ly + 36);
    ctx.lineTo(lx + 34, ly);
    ctx.lineTo(lx + 72, ly + 14);
    ctx.lineTo(lx + 38, ly + 52);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.globalAlpha = 0.085;
  for (let i = 0; i < 6; i += 1) {
    const rx = cardX + cardW - 330 + ((i % 2) * 72);
    const ry = cardY + 118 + (i * 56);
    ctx.beginPath();
    ctx.moveTo(rx, ry + 34);
    ctx.lineTo(rx + 32, ry);
    ctx.lineTo(rx + 68, ry + 13);
    ctx.lineTo(rx + 36, ry + 48);
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();

  const textColor = normalizeHexColor(style.text, '#000000');
  const accentColor = normalizeHexColor(style.accent, '#11121a');
  const quoteColor = normalizeHexColor(style.quote, '#060608');
  const starColor = normalizeHexColor(style.star, '#7d68d8');
  const nameColor = normalizeHexColor(style.name, '#0f0f16');
  const finalComment = String(comment || 'بدون تعليق').trim();
  // Decorative mark (replaces quotes)
  ctx.fillStyle = quoteColor;
  ctx.font = 'bold 104px Cairo';
  ctx.fillText('❝', cardX + 62, cardY + 118);

  // Star capsule
  const pillX = cardX + cardW - 400;
  const pillY = cardY + 26;
  const pillW = 360;
  const pillH = 86;
  ctx.fillStyle = accentColor;
  drawRoundedRectPath(ctx, pillX, pillY, pillW, pillH, 45);
  ctx.fill();
  ctx.globalAlpha = 0.12;
  const pillGloss = ctx.createLinearGradient(0, pillY, 0, pillY + pillH);
  pillGloss.addColorStop(0, '#ffffff');
  pillGloss.addColorStop(1, '#ffffff00');
  ctx.fillStyle = pillGloss;
  drawRoundedRectPath(ctx, pillX + 3, pillY + 2, pillW - 6, (pillH / 2), 42);
  ctx.fill();
  ctx.globalAlpha = 0.08;
  ctx.strokeStyle = '#ffffff88';
  ctx.lineWidth = 1.5;
  drawRoundedRectPath(ctx, pillX, pillY, pillW, pillH, 45);
  ctx.stroke();
  ctx.globalAlpha = 1;

  for (let i = 0; i < 5; i += 1) {
    const cx = pillX + 44 + (i * 62);
    const cy = pillY + 43;
    const active = i < stars;
    ctx.fillStyle = active ? starColor : '#5a5480';
    ctx.strokeStyle = active ? '#ffffff88' : '#ffffff22';
    drawStarPath(ctx, cx, cy, 20, 9, 5);
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  ctx.fillStyle = textColor;
  ctx.font = 'bold 52px Cairo';
  ctx.textAlign = 'right';
  ctx.direction = 'rtl';
  ctx.shadowColor = '#00000020';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetY = 1;
  const wrapped = finalComment.slice(0, 220);
  const words = wrapped.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width > 790) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  lines.slice(0, 4).forEach((line, i) => ctx.fillText(line, cardX + cardW - 110, cardY + 285 + (i * 62)));
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.textAlign = 'left';
  ctx.direction = 'ltr';

  const avatarUrl = member?.displayAvatarURL?.({ extension: 'png', size: 256 }) || member?.user?.displayAvatarURL?.({ extension: 'png', size: 256 });
  if (avatarUrl) {
    try {
      const avatar = await loadImage(avatarUrl);
      const avX = cardX - 58;
      const avY = cardY + cardH - 206;
      const avSize = 214;
      // Avatar frame: cleaner and less black, with subtle glass effect
      ctx.save();
      const avatarFrame = ctx.createLinearGradient(avX - 24, avY - 24, avX + avSize + 24, avY + avSize + 24);
      avatarFrame.addColorStop(0, normalizeHexColor(style.cardStart, '#725ad0'));
      avatarFrame.addColorStop(1, normalizeHexColor(style.cardEnd, '#8d78df'));
      ctx.fillStyle = avatarFrame;
      ctx.shadowColor = '#00000055';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 6;
      drawRoundedRectPath(ctx, avX - 24, avY - 24, avSize + 48, avSize + 48, 64);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#ffffff66';
      ctx.lineWidth = 2;
      drawRoundedRectPath(ctx, avX - 16, avY - 16, avSize + 32, avSize + 32, 58);
      ctx.stroke();

      // Transparent inner plate like reference
      ctx.fillStyle = '#ffffff18';
      drawRoundedRectPath(ctx, avX - 10, avY - 10, avSize + 20, avSize + 20, 52);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(avX + avSize / 2, avY + avSize / 2, (avSize / 2) + 2, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff88';
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(avatar, avX, avY, avSize, avSize);
      ctx.restore();
    } catch (error) {
      logSilentError('feedback.avatar.load', error);
    }
  }

  ctx.fillStyle = nameColor;
  ctx.font = 'bold 54px Cairo';
  ctx.fillText(member?.displayName || member?.user?.username || 'Member', cardX + 230, cardY + cardH - 48);

  // Server signature bottom-right with real server avatar crop
  const serverName = guild?.name || 'Server';
  const serverAvatarUrl = guild?.iconURL?.({ extension: 'png', size: 256 }) || null;
  const signY = cardY + cardH - 14;
  const signX = cardX + cardW - 46;
  if (serverAvatarUrl) {
    try {
      const serverAvatar = await loadImage(serverAvatarUrl);
      const sSize = 56;
      const sx = signX - sSize - 14;
      const sy = signY - 42;
      ctx.save();
      ctx.beginPath();
      ctx.arc(sx + sSize / 2, sy + sSize / 2, sSize / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(serverAvatar, sx, sy, sSize, sSize);
      ctx.restore();
      ctx.strokeStyle = '#00000066';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx + sSize / 2, sy + sSize / 2, sSize / 2, 0, Math.PI * 2);
      ctx.stroke();
    } catch (error) {
      logSilentError('feedback.server-avatar.load', error);
    }
  }
  ctx.fillStyle = textColor;
  ctx.globalAlpha = 0.92;
  ctx.textAlign = 'right';
  ctx.font = '32px Cairo';
  ctx.fillText(serverName, signX - 78, signY);
  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;

  return canvas.toBuffer('image/png');
}

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  };
}

function rgbToHex(r, g, b) {
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function mixHex(a, b, amount = 0.5) {
  const ca = hexToRgb(normalizeHexColor(a, '#6d54c7'));
  const cb = hexToRgb(normalizeHexColor(b, '#8f7ce2'));
  const t = Math.max(0, Math.min(1, Number(amount) || 0));
  if (!ca || !cb) return '#7f69d5';
  return rgbToHex(
    ca.r + ((cb.r - ca.r) * t),
    ca.g + ((cb.g - ca.g) * t),
    ca.b + ((cb.b - ca.b) * t)
  );
}

function getLuminance(hex) {
  const c = hexToRgb(normalizeHexColor(hex, '#777777'));
  if (!c) return 0.5;
  const toLinear = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = toLinear(c.r);
  const g = toLinear(c.g);
  const b = toLinear(c.b);
  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
}

async function extractAverageHexFromImageUrl(url) {
  if (!url) return null;
  try {
    const img = await loadImage(url);
    const sample = createCanvas(24, 24);
    const sctx = sample.getContext('2d');
    sctx.drawImage(img, 0, 0, 24, 24);
    const data = sctx.getImageData(0, 0, 24, 24).data;
    let r = 0; let g = 0; let b = 0; let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha < 20) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count += 1;
    }
    if (!count) return null;
    return rgbToHex(r / count, g / count, b / count);
  } catch (error) {
    logSilentError('feedback.auto-style.extract', error);
    return null;
  }
}

async function generateAutoFeedbackStyle(guild, currentStyle = {}) {
  const iconUrl = guild?.iconURL?.({ extension: 'png', size: 256 }) || null;
  const bannerUrl = guild?.bannerURL?.({ extension: 'png', size: 512 }) || null;
  const fromBanner = await extractAverageHexFromImageUrl(bannerUrl);
  const fromIcon = await extractAverageHexFromImageUrl(iconUrl);
  const base = fromBanner || fromIcon || '#7b69d4';

  // Keep final scene background navy as requested, while matching the card to guild assets.
  const background = '#040a1d';
  const cardStart = mixHex(base, '#2f254f', 0.72);
  const cardEnd = mixHex(base, '#7462ad', 0.32);
  const border = mixHex(cardEnd, '#d7d1ee', 0.18);
  const star = mixHex(cardEnd, '#9e92c8', 0.28);
  const textBase = getLuminance(cardEnd) > 0.46 ? '#101116' : '#f0eefb';

  return {
    ...currentStyle,
    version: 'v6',
    background,
    cardStart,
    cardEnd,
    text: textBase,
    name: textBase,
    quote: textBase,
    accent: mixHex(cardStart, '#0f111a', 0.45),
    border,
    star,
    shadow: '#000000'
  };
}

async function sendFeedbackPrompt({ guild, channel, ticket, config, panelId, channelId }) {
  const feedbackCfg = config?.feedback || {};
  if (!feedbackCfg.enabled || !feedbackCfg.channelId || !ticket?.memberId) return;
  const promptKey = `${guild.id}:${panelId || 'default'}:${channelId}:${ticket.memberId}`;
  const existingPrompt = feedbackPromptSessions.get(promptKey);
  if (existingPrompt && !existingPrompt.submittedAt) return;

  const token = buildFeedbackSessionToken();
  const sessionPayload = {
    guildId: guild.id,
    panelId,
    ticketChannelId: channelId,
    memberId: ticket.memberId,
    expiresAt: Date.now() + FEEDBACK_SESSION_TTL_MS
  };
  ticketFeedbackSessions.set(token, sessionPayload);
  saveRuntimeSession('ticket-feedback', token, sessionPayload, FEEDBACK_SESSION_TTL_MS);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_feedback_open_${token}`)
      .setLabel('Rate')
      .setStyle(ButtonStyle.Secondary)
  );

  const promptDescription = String(feedbackCfg.promptText || 'يرجى تقييم خدماتنا ونكون شاكرين لك').trim();
  if (feedbackCfg.triggerScope === 'ticket') {
    const actor = await guild.members.fetch(ticket.memberId).catch(() => null);
    const sent = await channel.send({
      embeds: [
        colorManager.createEmbed()
          .setTitle('Rate')
          .setDescription(promptDescription)
          .setThumbnail(actor?.displayAvatarURL?.({ extension: 'png', size: 256 }) || undefined)
      ],
      components: [row]
    }).catch((error) => {
      logSilentError('feedback.prompt.ticket', error);
      return null;
    });
    if (sent?.id) {
      sessionPayload.promptChannelId = sent.channelId;
      sessionPayload.promptMessageId = sent.id;
      ticketFeedbackSessions.set(token, sessionPayload);
      feedbackPromptSessions.set(promptKey, { token, submittedAt: null });
      saveRuntimeSession('ticket-feedback', token, sessionPayload, FEEDBACK_SESSION_TTL_MS);
    }
    return;
  }

  const user = await guild.client.users.fetch(ticket.memberId).catch(() => null);
  if (!user) return;
  const icon = user.displayAvatarURL({ extension: 'png', size: 256 }) || undefined;
  const dmMsg = await user.send({
    embeds: [colorManager.createEmbed().setTitle('Rate').setDescription(promptDescription).setThumbnail(icon)],
    components: [row]
  }).catch((error) => {
    logSilentError('feedback.prompt.dm', error);
    return null;
  });
  if (dmMsg?.id) {
    sessionPayload.promptChannelId = dmMsg.channelId;
    sessionPayload.promptMessageId = dmMsg.id;
    ticketFeedbackSessions.set(token, sessionPayload);
    feedbackPromptSessions.set(promptKey, { token, submittedAt: null });
    saveRuntimeSession('ticket-feedback', token, sessionPayload, FEEDBACK_SESSION_TTL_MS);
  }
}

async function sendFeedbackSeparator(channel, feedbackCfg = {}) {
  if (!feedbackCfg?.separatorEnabled) return;
  const separatorImage = resolveImageForSend(feedbackCfg.separatorImage || '');
  const separatorMode = String(feedbackCfg.separatorMode || '').toLowerCase();
  const imageOnlySeparator = feedbackCfg.separatorImageOnly === true || separatorMode === 'image-only';
  if (separatorImage) {
    await channel.send({ files: [separatorImage] }).catch((error) => logSilentError('suppressed', error));
    if (imageOnlySeparator) return;
  }
  if (feedbackCfg.separatorText && !imageOnlySeparator) {
    await channel.send({ content: feedbackCfg.separatorText }).catch((error) => logSilentError('suppressed', error));
  }
}

async function sendAutoCloseWarning(channel, ticket, dueAt) {
  const mentions = [...new Set([ticket?.claimedBy, ticket?.memberId].filter(Boolean))]
    .map((id) => `<@${id}>`)
    .join(' ');

  await channel.send({
    content: mentions || undefined,
    ...buildTicketMessagePayload(
      'Auto Close',
      `**هذا التكت سيتم قفله تلقائيًا قريبًا.**\n**موعد الإقفال :** <t:${Math.floor(dueAt / 1000)}:R>\n**أي رسالة جديدة داخل التكت ستعيد المدة من البداية.**`
    )
  }).catch((error) => logSilentError('suppressed', error));
}

async function closeTicketCore({
  channel,
  guildId,
  panelId = 'default',
  channelId,
  config,
  tickets,
  pendingRequests,
  ticket,
  interaction = null,
  closedByLabel = null,
  closedByUserId = null,
  autoClose = false,
  silentCloseNotice = false
}) {
  if (!ticket || ticket.closedAt) return false;

  ticket.status = 'closed';
  ticket.closedAt = Date.now();
  ticket.deletedChannel = !config.keepClosedTickets;
  ticket.memberHidden = true;
  ticket.claimerHidden = true;
  ticket.closedBy = closedByUserId || null;
  delete ticket.autoCloseWarningSentAt;

  if (!autoClose && closedByUserId) {
    const closerMember = await resolveGuildMember(channel.guild, closedByUserId);
    if (closerMember && canUseGeneralPointsCommand(closerMember, guildId, channel.guild)) {
      const points = loadPoints();
      const appended = recordManagerClosePoint(points, {
        guildId,
        panelId,
        channelId,
        actorId: closedByUserId,
        targetId: ticket.memberId || '',
        at: ticket.closedAt
      });
      if (appended) savePoints(points);
    }
  }

  setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default');

  channel.ticketMeta = ticket;
  const transcriptFile = await buildTicketTranscript(channel).catch(() => null);
  const logTranscriptFile = config.keepClosedTickets ? null : transcriptFile;
  await Promise.allSettled([
    syncTicketLogMessage({
      guild: channel.guild,
      config,
      ticket,
      channelId,
      actionText: {
        type: autoClose ? 'auto_close' : 'close',
        message: `تم الغلق عن طريق : ${closedByLabel || (autoClose ? 'خمول التكت' : 'غير محدد')}`,
        actorId: interaction?.user?.id || null
      },
      actor: interaction?.user || null,
      transcriptFile: logTranscriptFile
    }),
    finalizeTransferDmNotifications(ticket, channel.guild, closedByLabel || (autoClose ? 'خمول التكت' : 'غير محدد'))
  ]);
  if (!config.keepClosedTickets) {
    delete tickets[channelId];
    setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default');

    if (interaction) {
      const closeNoticePayload = buildTicketMessagePayload(
        autoClose ? 'إغلاق تلقائي' : 'اقفال',
        `**سيتم حذف التكت خلال ${Math.floor(CLOSE_DELETE_DELAY_MS / 1000)} ثواني.**`,
        { ephemeral: true }
      );
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(closeNoticePayload).catch((error) => logSilentError('close.editReply.delete-notice', error));
      } else {
        await interaction.reply(closeNoticePayload).catch((error) => logSilentError('close.reply.delete-notice', error));
      }
    } else if (!silentCloseNotice) {
      await channel.send(buildTicketMessagePayload('إغلاق تلقائي', `**تم إقفال هذا التكت تلقائيًا${closedByLabel ? ` بواسطة ${closedByLabel}` : ''} وسيتم حذفه خلال ${Math.floor(CLOSE_DELETE_DELAY_MS / 1000)} ثواني.**`)).catch((error) => logSilentError('close.channel.delete-notice', error));
    }

    setTimeout(() => channel.delete().catch((error) => logSilentError('close.channel.delete', error)), CLOSE_DELETE_DELAY_MS);
    return true;
  }

  let closeSuffix = '';
  if (config.ticketNameMode === 'user') {
    const memberName = channel.guild.members.cache.get(ticket.memberId)?.user?.username
      || channel.guild.members.cache.get(ticket.memberId)?.displayName
      || ticket.memberId;
    closeSuffix = sanitizeName(memberName || 'user');
  } else {
    const parts = String(channel.name || '').split('-').filter(Boolean);
    closeSuffix = sanitizeName(parts[parts.length - 1] || String(config.counter || 1));
  }
  const closedChannelName = `closed-${closeSuffix || 'ticket'}`.slice(0, 90);

  const parallelTasks = [];

  // 1. Change channel name and parent category
  parallelTasks.push(channel.setName(closedChannelName).catch((error) => logSilentError('close.setName', error)));
  if (config.closedCategoryId) {
    parallelTasks.push(channel.setParent(config.closedCategoryId).catch((error) => logSilentError('close.setParent', error)));
  }

  // 2. Update base permissions
  if (ticket.memberId) {
    parallelTasks.push(
      channel.permissionOverwrites.edit(ticket.memberId, {
        ViewChannel: false,
        SendMessages: false
      }).catch((error) => logSilentError('close.permissions.member', error))
    );
  }
  parallelTasks.push(
    channel.permissionOverwrites.edit(channel.guild.roles.everyone.id, {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: false
    }).catch((error) => logSilentError('close.permissions.everyone', error))
  );

  // 3. Update permissions for transferred users
  (ticket.transferredUserIds || []).forEach((userId) => {
    parallelTasks.push(channel.permissionOverwrites.edit(userId, {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: true
    }).catch((error) => logSilentError('close.permissions.transferred-user', error)));
  });

  // 4. Update permissions for visible roles and users
  const { roleIds: visibleRoleIds, userIds: visibleUserIds } = getClosedTicketViewerTargets(config, ticket, channel.guild);
  visibleRoleIds.forEach((roleId) => {
    parallelTasks.push(channel.permissionOverwrites.edit(roleId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    }).catch((error) => logSilentError('close.permissions.visible-role', error)));
  });
  visibleUserIds.forEach((userId) => {
    parallelTasks.push(channel.permissionOverwrites.edit(userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    }).catch((error) => logSilentError('close.permissions.visible-user', error)));
  });

  // Execute all channel-related modifications in parallel
  await Promise.allSettled(parallelTasks);

  // 5. Disable interaction message components if editable
  if (interaction?.message?.editable && interaction.message?.components?.length) {
    const disabledRows = interaction.message.components.map((row) => {
      const disabledComponents = row.components.map((component) => ButtonBuilder.from(component).setDisabled(true));
      return new ActionRowBuilder().addComponents(disabledComponents);
    });
    await interaction.message.edit({ components: disabledRows }).catch((error) => logSilentError('suppressed', error));
  }

  // 6. Send final closed ticket message and update guild data
  const finalTasks = [];
  finalTasks.push(channel.send({
    embeds: [makeTicketEmbed(
      'Closed Ticket',
      [
        `**تم إقفال التكت${autoClose ? ' تلقائيًا' : ''}.**`,
        `**Amdin :** ${ticket.claimedBy ? `<@${ticket.claimedBy}>` : 'غير محدد'}`,
        `**Closer :** ${closedByLabel || (autoClose ? 'خمول التكت' : 'غير محدد')}`,
        `**Member :** ${ticket.memberId ? `<@${ticket.memberId}>` : 'غير محدد'}`
      ].join('\n')
    )],
    components: buildPostCloseControls(guildId, panelId || 'default', channelId, ticket)
  }).catch((error) => logSilentError('close.sendFinalMessage', error)));

  // setGuildData can be done in parallel as it updates the cache and queues a write
  finalTasks.push(Promise.resolve(setGuildData(guildId, config, tickets, pendingRequests, panelId || 'default')));

  if (interaction) {
    const donePayload = buildTicketMessagePayload(autoClose ? 'Ticket;' : 'Ticket;', autoClose ? '**Done Closed Auto ✅️**' : '**Done closed ✅️.**', { ephemeral: true });
    if (interaction.deferred || interaction.replied) {
      finalTasks.push(interaction.editReply(donePayload).catch((error) => logSilentError('close.editReply.done', error)));
    } else {
      finalTasks.push(interaction.reply(donePayload).catch((error) => logSilentError('close.reply.done', error)));
    }
  }

  await Promise.allSettled(finalTasks);

  return true;
}

function resolveCloseContext(guildId, panelId, channelId, actor) {
  const resolved = getTicketContext(guildId, channelId, panelId || 'default');
  const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket } = resolved;
  if (!ticket) {
    return { error: buildTicketMessagePayload('Error', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }) };
  }
  if (!canManageTicket(actor, ticket, config)) {
    return { error: buildTicketMessagePayload('Perm', '**ليس لديك صلاحية الاقفال.**', { ephemeral: true }) };
  }
  if (ticket.closedAt) {
    return { error: buildTicketMessagePayload('Alert', '**التكت مقفل مسبقاً.**', { ephemeral: true }) };
  }
  return {
    panelId: resolvedPanelId,
    config,
    tickets,
    pendingRequests,
    ticket,
    actionChannelId: ticket?.channelId || channelId
  };
}

async function handleClose(interaction, guildId, panelId, channelId) {
  const resolved = resolveCloseContext(guildId, panelId, channelId, interaction);
  if (resolved.error) {
    await interaction.reply(resolved.error);
    return;
  }
  const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = resolved;
  if (interaction.channelId !== actionChannelId) {
    await interaction.reply(buildTicketMessagePayload('Error', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
    return;
  }
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true }).catch((error) => logSilentError('suppressed', error));
  }
  await closeTicketCore({
    channel: interaction.channel,
    guildId,
    panelId: resolvedPanelId,
    channelId: actionChannelId,
    config,
    tickets,
    pendingRequests,
    ticket,
    interaction,
    closedByLabel: `<@${interaction.user.id}>`,
    closedByUserId: interaction.user.id
  });
}

async function handleCloseAliasMessage(message) {
  if (!message.guild || !message.channel) return false;
  const guildId = message.guild.id;
  const channelId = message.channel.id;
  const resolved = resolveCloseContext(guildId, 'default', channelId, { member: message.member, guild: message.guild, user: message.author });
  if (resolved.error) {
    return false;
  }

  const { panelId, config, tickets, pendingRequests, ticket, actionChannelId } = resolved;
  await closeTicketCore({
    channel: message.channel,
    guildId,
    panelId,
    channelId: actionChannelId,
    config,
    tickets,
    pendingRequests,
    ticket,
    interaction: null,
    closedByLabel: `<@${message.author.id}>`,
    closedByUserId: message.author.id,
    silentCloseNotice: true
  });
  return true;
}

function resolveTicketMessageContext(message) {
  if (!message.guild || !message.channel) {
    return { error: buildTicketMessagePayload('خطأ', '**هذا الأمر يعمل داخل السيرفر فقط.**') };
  }
  const guildId = message.guild.id;
  const channelId = message.channel.id;
  const panelId = findTicketPanel(guildId, channelId, 'default');
  const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket } = getTicketContext(guildId, channelId, panelId);
  const actionChannelId = ticket?.channelId || channelId;
  if (!ticket || channelId !== actionChannelId) {
    return { error: buildTicketMessagePayload('Error', '**يجب استخدام هذا الأمر داخل روم التكت.**') };
  }
  return { guildId, panelId: resolvedPanelId, channelId: actionChannelId, config, tickets, pendingRequests, ticket };
}

function resolveTicketAliasContext(message, { requireOpen = true } = {}) {
  const ctx = resolveTicketMessageContext(message);
  if (ctx.error) return { ok: false, ctx: null };
  if (requireOpen && ctx.ticket?.status !== 'open') return { ok: false, ctx: null };
  return { ok: true, ctx };
}

async function handleRenameAliasMessage(message, newNameRaw) {
  const { ok, ctx } = resolveTicketAliasContext(message, { requireOpen: false });
  if (!ok) return false;
  if (!canManageTicket({ user: message.author, member: message.member, guild: message.guild }, ctx.ticket, ctx.config)) {
    return false;
  }
  const newName = sanitizeName(newNameRaw);
  if (!newName) return false;
  await message.channel.setName(newName).catch((error) => logSilentError('suppressed', error));
  await syncTicketLogMessage({
    guild: message.guild,
    config: ctx.config,
    ticket: ctx.ticket,
    channelId: ctx.channelId,
    actionText: `تم تغيير اسم التكت عن طريق : <@${message.author.id}> -> ${newName}`,
    actor: message.author
  });
  return true;
}

async function handleAddRemoveAliasMessage(message, userInput, mode = 'add') {
  const { ok, ctx } = resolveTicketAliasContext(message, { requireOpen: false });
  if (!ok) return false;
  const actor = { user: message.author, member: message.member, guild: message.guild };
  if (!canManageTicket(actor, ctx.ticket, ctx.config)) {
    return false;
  }
  const userId = normalizeId(userInput);
  if (!userId) return false;
  if (mode === 'add') {
    if (ctx.ticket.memberId === userId) {
      return false;
    }
    const targetMember = await resolveGuildMember(message.guild, userId);
    if (!targetMember) return false;
    await message.channel.permissionOverwrites.edit(userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true
    }).catch((error) => logSilentError('suppressed', error));
    if (!ctx.ticket.extraMembers.includes(userId)) ctx.ticket.extraMembers.push(userId);
    await syncTicketLogMessage({
      guild: message.guild,
      config: ctx.config,
      ticket: ctx.ticket,
      channelId: ctx.channelId,
      actionText: `تمت إضافة شخص عن طريق : <@${message.author.id}> -> <@${userId}>`,
      actor: message.author
    });
    setGuildData(ctx.guildId, ctx.config, ctx.tickets, ctx.pendingRequests, ctx.panelId);
    return true;
  }

  if (ctx.ticket.memberId === userId) {
    return false;
  }
  await message.channel.permissionOverwrites.edit(userId, { ViewChannel: false }).catch((error) => logSilentError('suppressed', error));
  ctx.ticket.extraMembers = (ctx.ticket.extraMembers || []).filter((id) => id !== userId);
  await syncTicketLogMessage({
    guild: message.guild,
    config: ctx.config,
    ticket: ctx.ticket,
    channelId: ctx.channelId,
    actionText: `تمت إزالة شخص عن طريق : <@${message.author.id}> -> <@${userId}>`,
    actor: message.author
  });
  setGuildData(ctx.guildId, ctx.config, ctx.tickets, ctx.pendingRequests, ctx.panelId);
  return true;
}

async function handlePingAliasMessage(message) {
  const { ok, ctx } = resolveTicketAliasContext(message, { requireOpen: true });
  if (!ok) return false;
  const actor = { user: message.author, member: message.member, guild: message.guild };
  if (!canManageTicket(actor, ctx.ticket, ctx.config)) {
    return false;
  }
  const cooldownKey = `${message.guild.id}:${ctx.channelId}:${message.author.id}`;
  prunePingCooldowns();
  const last = await getPingCooldownValue(cooldownKey);
  const now = Date.now();
  const cooldownMs = PING_COOLDOWN_MS;
  if (now - last < cooldownMs) {
    return false;
  }
  const user = await message.client.users.fetch(ctx.ticket.memberId).catch(() => null);
  const link = `https://discord.com/channels/${message.guild.id}/${message.channel.id}`;
  if (user) {
    await user.send(buildTicketMessagePayload('استدعاء من الإدارة ', `**تم الرد عليك بالتكت يرجى الرجوع ورؤية التكت الآن **\n**الرابط :** ${link}`)).catch((error) => logSilentError('suppressed', error));
  }
  setPingCooldownValue(cooldownKey, now);
  await syncTicketLogMessage({
    guild: message.guild,
    config: ctx.config,
    ticket: ctx.ticket,
    channelId: ctx.channelId,
    actionText: `تم استدعاء العضو عن طريق : <@${message.author.id}>`,
    actor: message.author
  });
  setGuildData(ctx.guildId, ctx.config, ctx.tickets, ctx.pendingRequests, ctx.panelId);
  return true;
}

async function handleReassignAliasMessage(message) {
  const { ok, ctx } = resolveTicketAliasContext(message, { requireOpen: true });
  if (!ok) return false;
  const fakeInteraction = {
    guild: message.guild,
    channel: message.channel,
    channelId: message.channel.id,
    user: message.author,
    member: message.member,
    client: message.client,
    deferred: false,
    replied: false,
    deferReply: async () => { fakeInteraction.deferred = true; },
    editReply: async () => { fakeInteraction.replied = true; return null; },
    deleteReply: async () => {}
  };
  return handleReassignRequest(fakeInteraction, message.guild.id, ctx.panelId, ctx.channelId, { silent: true });
}

function buildMemberPointsEmbed({ requester, targetUser, targetId, guildId, targetIsResponsible = false, note = null, thumbnailMode = 'user', guild = null }) {
  const points = loadPoints();
  const totalPoints = getUserTotalPoints(points, targetId);
  const topAwarder = getTopPointAwarder(points, targetId);
  const managerPoints = getManagerPointCount(points, targetId);
  const managerClosedTickets = getManagerEvaluationCount(points, targetId);
  const { guild: guildData } = getGuildData(guildId);
  let claimedTickets = 0;
  for (const panel of Object.values(guildData?.panels || {})) {
    claimedTickets += Object.values(panel?.tickets || {}).filter((ticket) => ticket?.claimedBy === targetId).length;
  }

  const guildIcon = guild?.iconURL?.({ forceStatic: false, size: 128 }) || null;
  const userAvatar = targetUser?.displayAvatarURL?.({ forceStatic: false, size: 128 }) || null;
  const thumbnail = thumbnailMode === 'server' ? (guildIcon || userAvatar) : (userAvatar || guildIcon);

  const embed = colorManager.createEmbed()
    .setTitle('Points')
    .setDescription(targetIsResponsible
      ? [
        `**الإداري :** <@${targetId}>`,
        `**نقاطه كمسؤول :** ${managerPoints}m`,
        `**عدد التكتات الذي اقفلها :** ${managerClosedTickets}`,
        note ? `\n${note}` : null
      ].filter(Boolean).join('\n')
      : [
        `**العضو :** <@${targetId}>`,
        `**التكتات المستلمة :** ${claimedTickets}`,
        `**النقاط الحالية :** ${totalPoints}p`,
        `**أكثر مسؤول عطاه نقاط :** ${topAwarder ? `<@${topAwarder.actorId}> (${topAwarder.total}p)` : 'N/A'}`,
        note ? `\n${note}` : null
      ].filter(Boolean).join('\n'))
    .setThumbnail(thumbnail)
    .setFooter({ text: `By : ${requester?.username || requester?.tag || 'System'}` });

  return embed;
}

async function handleMyTicketPointsMessage(message, targetInput = null, { thumbnailMode = 'user' } = {}) {
  const targetId = normalizeId(targetInput) || message.author.id;
  const targetUser = await message.client.users.fetch(targetId).catch(() => null);
  const targetMember = await resolveGuildMember(message.guild, targetId);
  const targetIsResponsible = shouldShowManagerStats({
    points: loadPoints(),
    guildId: message.guild.id,
    guild: message.guild,
    targetId,
    targetMember
  });
  const embed = buildMemberPointsEmbed({
    requester: message.author,
    targetUser,
    targetId,
    guildId: message.guild.id,
    targetIsResponsible,
    thumbnailMode,
    guild: message.guild
  });
  return message.reply({ embeds: [embed] }).catch((error) => logSilentError('suppressed', error));
}

function applyManualPointsDelta({ targetId, actorId, delta }) {
  const points = loadPoints();
  const respName = 'general';
  if (!points[respName] || typeof points[respName] !== 'object') points[respName] = {};
  const existing = points[respName][targetId];
  const total = sumPointBucket(existing);
  const next = Math.max(0, total + delta);
  const actualDelta = next - total;
  const auditId = `${Date.now()}_${actorId}_${targetId}`;
  points[respName][targetId] = { ...(typeof existing === 'object' && existing ? existing : {}), [Date.now()]: actualDelta };
  appendPointAuditEntry(points, {
    id: auditId,
    targetId,
    actorId,
    delta: actualDelta,
    respName,
    source: 'manual_command',
    at: auditId
  });
  savePoints(points);
  return actualDelta;
}

function applyManagerPointsDelta({ targetId, delta }) {
  const points = loadPoints();
  if (!Array.isArray(points.__managerPointsAudit)) points.__managerPointsAudit = [];
  const amount = Math.max(0, Math.abs(Number(delta || 0)));
  if (!amount) return 0;
  if (delta > 0) {
    for (let i = 0; i < amount; i += 1) {
      points.__managerPointsAudit.push({
        ticketKey: `manual_manager_${Date.now()}_${i}`,
        actorId: targetId,
        targetId: targetId,
        source: 'manual_manager',
        at: `${Date.now()}_${i}`
      });
    }
    savePoints(points);
    return amount;
  }

  let removed = 0;
  for (let i = points.__managerPointsAudit.length - 1; i >= 0 && removed < amount; i -= 1) {
    if (String(points.__managerPointsAudit[i]?.actorId || '') === String(targetId)) {
      points.__managerPointsAudit.splice(i, 1);
      removed += 1;
    }
  }
  savePoints(points);
  return -removed;
}

async function handlePointsAdjustMessage(message, args, { BOT_OWNERS = [] } = {}) {
  const actorIsResponsible = canUseGeneralPointsCommand(message.member, message.guild.id, message.guild);
  const actorIsOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
  if (!actorIsResponsible && !actorIsOwner) {
    return message.reply(buildTicketMessagePayload('No perms', '**هذا الأمر متاح للمسؤولين فقط.**')).catch((error) => logSilentError('suppressed', error));
  }

  const targetId = normalizeId(args?.[0]);
  if (!targetId) {
    return message.reply(buildTicketMessagePayload('خطأ فالاستخدام','Use it :** points 636930315503534110 | @user **')).catch((error) => logSilentError('suppressed', error));
  }
  const targetUser = await message.client.users.fetch(targetId).catch(() => null);
  const targetMember = await resolveGuildMember(message.guild, targetId);
  const targetIsResponsible = shouldShowManagerStats({
    points: loadPoints(),
    guildId: message.guild.id,
    guild: message.guild,
    targetId,
    targetMember
  });
  if (targetIsResponsible && !actorIsOwner) {
    return message.reply(buildTicketMessagePayload('No perms', '**لا يمكن تعديل نقاط المسؤولين إلا بواسطة مسؤولين المسؤوليات.**')).catch((error) => logSilentError('suppressed', error));
  }

  const sessionId = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const adjustSession = { targetId, actorId: message.author.id, targetIsResponsible };
  pointsAdjustSessions.set(sessionId, adjustSession);
  saveRuntimeSession('ticket-points-adjust', sessionId, adjustSession, 3 * 60 * 1000);

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_points_action_add_${sessionId}`).setLabel('Add').setEmoji('<:emoji_91:1442990316549312582>').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ticket_points_action_remove_${sessionId}`).setLabel('Remove').setEmoji('<:emoji_90:1442990214925520976>').setStyle(ButtonStyle.Danger)
  );

  const sent = await message.reply({
    embeds: [buildMemberPointsEmbed({ requester: message.author, targetUser, targetId, guildId: message.guild.id, targetIsResponsible, note: '**اختر العملية من الأزرار.**', thumbnailMode: 'server', guild: message.guild })],
    components: [actionRow]
  }).catch(async (error) => {
    logSilentError('points.adjust.reply', error);
    return message.channel.send({
      embeds: [buildMemberPointsEmbed({ requester: message.author, targetUser, targetId, guildId: message.guild.id, targetIsResponsible, note: '**اختر العملية من الأزرار.**', thumbnailMode: 'server', guild: message.guild })],
      components: [actionRow]
    }).catch((fallbackError) => {
      logSilentError('points.adjust.channel-send', fallbackError);
      return null;
    });
  });
  if (!sent) {
    await message.channel.send(buildTicketMessagePayload('Error', '**تعذر فتح لوحة تعديل النقاط. تأكد من صلاحيات البوت في هذا الشات.**')).catch((error) => logSilentError('suppressed', error));
    return;
  }

  const collector = sent.createMessageComponentCollector({ time: 3 * 60 * 1000 });
  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== message.author.id) {
      await interaction.reply(buildTicketMessagePayload('ملقوف', '**فقط صاحب الأمر يمكنه استخدام الأزرار.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
      return;
    }

    const addPrefix = `ticket_points_action_add_${sessionId}`;
    const removePrefix = `ticket_points_action_remove_${sessionId}`;
    const amountPrefix = `ticket_points_amount_`;
    if (interaction.customId === addPrefix || interaction.customId === removePrefix) {
      const mode = interaction.customId === addPrefix ? 'add' : 'remove';
      const updatedSession = { ...(pointsAdjustSessions.get(sessionId) || {}), mode };
      pointsAdjustSessions.set(sessionId, updatedSession);
      saveRuntimeSession('ticket-points-adjust', sessionId, updatedSession, 3 * 60 * 1000);
      const amountRow = new ActionRowBuilder().addComponents(
        [1, 2, 3, 4, 5].map((value) => new ButtonBuilder()
          .setCustomId(`${amountPrefix}${mode}_${value}_${sessionId}`)
          .setLabel(String(value))
          .setStyle(mode === 'add' ? ButtonStyle.Success : ButtonStyle.Danger))
      );
      await interaction.update({
        embeds: [buildMemberPointsEmbed({ requester: message.author, targetUser, targetId, guildId: message.guild.id, targetIsResponsible, note: `**تم اختيار :** ${mode === 'add' ? 'إضافة' : 'إزالة'}\n**اختر العدد من 1 إلى 5.**`, thumbnailMode: 'server', guild: message.guild })],
        components: [amountRow]
      }).catch((error) => logSilentError('suppressed', error));
      return;
    }

    if (interaction.customId.startsWith(amountPrefix) && interaction.customId.endsWith(`_${sessionId}`)) {
      const [, , , mode, valueStr] = interaction.customId.split('_');
      const amount = Number(valueStr);
      if (!['add', 'remove'].includes(mode) || !Number.isFinite(amount) || amount <= 0) {
        await interaction.reply(buildTicketMessagePayload('Error', '**خيار غير صالح.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
        return;
      }
      const delta = mode === 'remove' ? -Math.abs(amount) : Math.abs(amount);
          // As per user request, manager points are only awarded via internal ticket evaluation buttons.
          // Manual point adjustments via command will now only affect general user points.
          const actualDelta = applyManualPointsDelta({ targetId, actorId: message.author.id, delta });
      collector.stop('done');
      await interaction.update({
        embeds: [buildMemberPointsEmbed({
          requester: message.author,
          targetUser,
          targetId,
          guildId: message.guild.id,
          targetIsResponsible,
          note: `**✅ تم ${actualDelta >= 0 ? 'إضافة' : 'إزالة'} ${Math.abs(actualDelta)} ${targetIsResponsible ? 'نقطة مسؤول' : 'نقطة'} للعضو :** <@${targetId}>`,
          thumbnailMode: 'server',
          guild: message.guild
        })],
        components: []
      }).catch((error) => logSilentError('suppressed', error));
    }
  });

  collector.on('end', async () => {
    pointsAdjustSessions.delete(sessionId);
    deleteRuntimeSession('ticket-points-adjust', sessionId);
    await sent.edit({ components: [] }).catch((error) => logSilentError('suppressed', error));
  });
}


async function getPointsAdjustSession(sessionId) {
  let session = pointsAdjustSessions.get(sessionId);
  if (!session) {
    session = await loadRuntimeSession('ticket-points-adjust', sessionId).catch(() => null);
    if (session) pointsAdjustSessions.set(sessionId, session);
  }
  return session;
}

async function handlePointsAdjustActionInteraction(interaction, sessionId, mode) {
  const session = await getPointsAdjustSession(sessionId);
  if (!session) {
    await interaction.reply(buildTicketMessagePayload('Alert', '**انتهت صلاحية جلسة تعديل النقاط.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
    return;
  }
  if (interaction.user.id !== session.actorId) {
    await interaction.reply(buildTicketMessagePayload('ملقوف', '**فقط صاحب الأمر يمكنه استخدام الأزرار.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
    return;
  }
  const updatedSession = { ...session, mode };
  pointsAdjustSessions.set(sessionId, updatedSession);
  saveRuntimeSession('ticket-points-adjust', sessionId, updatedSession, 3 * 60 * 1000);
  const targetUser = await interaction.client.users.fetch(session.targetId).catch(() => null);
  const amountRow = new ActionRowBuilder().addComponents(
    [1, 2, 3, 4, 5].map((value) => new ButtonBuilder()
      .setCustomId(`ticket_points_amount_${mode}_${value}_${sessionId}`)
      .setLabel(String(value))
      .setStyle(mode === 'add' ? ButtonStyle.Success : ButtonStyle.Danger))
  );
  await interaction.update({
    embeds: [buildMemberPointsEmbed({
      requester: interaction.user,
      targetUser,
      targetId: session.targetId,
      guildId: interaction.guild.id,
      targetIsResponsible: Boolean(session.targetIsResponsible),
      note: `**تم اختيار :** ${mode === 'add' ? 'إضافة' : 'إزالة'}
**اختر العدد من 1 إلى 5.**`,
      thumbnailMode: 'server',
      guild: interaction.guild
    })],
    components: [amountRow]
  }).catch((error) => logSilentError('suppressed', error));
}

async function handlePointsAdjustAmountInteraction(interaction, sessionId, mode, amount) {
  const session = await getPointsAdjustSession(sessionId);
  if (!session) {
    await interaction.reply(buildTicketMessagePayload('Alert', '**انتهت صلاحية جلسة تعديل النقاط.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
    return;
  }
  if (interaction.user.id !== session.actorId) {
    await interaction.reply(buildTicketMessagePayload('ملقوف', '**فقط صاحب الأمر يمكنه استخدام الأزرار.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
    return;
  }
  if (!['add', 'remove'].includes(mode) || !Number.isFinite(amount) || amount <= 0) {
    await interaction.reply(buildTicketMessagePayload('Error', '**خيار غير صالح.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
    return;
  }
  const delta = mode === 'remove' ? -Math.abs(amount) : Math.abs(amount);
  const actualDelta = session.targetIsResponsible
    ? applyManagerPointsDelta({ targetId: session.targetId, delta })
    : applyManualPointsDelta({ targetId: session.targetId, actorId: session.actorId, delta });
  const targetUser = await interaction.client.users.fetch(session.targetId).catch(() => null);
  pointsAdjustSessions.delete(sessionId);
  deleteRuntimeSession('ticket-points-adjust', sessionId);
  await interaction.update({
    embeds: [buildMemberPointsEmbed({
      requester: interaction.user,
      targetUser,
      targetId: session.targetId,
      guildId: interaction.guild.id,
      targetIsResponsible: Boolean(session.targetIsResponsible),
      note: `**✅ تم ${actualDelta >= 0 ? 'إضافة' : 'إزالة'} ${Math.abs(actualDelta)} ${session.targetIsResponsible ? 'نقطة مسؤول' : 'نقطة'} للعضو :** <@${session.targetId}>`,
      thumbnailMode: 'server',
      guild: interaction.guild
    })],
    components: []
  }).catch((error) => logSilentError('suppressed', error));
}

async function handleTopPointsMessage(message, page = 1) {
  const points = loadPoints();
  const entries = getTopPointUsers(points, 1000);
  const safePage = Math.max(1, Number(page || 1));
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const currentPage = Math.min(safePage, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageEntries = entries.slice(start, start + pageSize);
  const description = pageEntries.length
    ? pageEntries.map((entry, index) => {
      const rank = start + index + 1;
      const topAwarder = getTopPointAwarder(points, entry.userId);
      return `**#${rank} - <@${entry.userId}> : ${entry.total}p**`;
    }).join('\n\n')
    : '**لا توجد نقاط مسجلة حالياً.**';
  const embed = makeTicketEmbed('Top Ticket', description, { user: message.author })
    .setThumbnail(message.guild?.iconURL?.({ forceStatic: false, size: 128 }) || null)
    .setFooter({ text: `Page ${currentPage}/${totalPages} • Your Points : ${getUserTotalPoints(points, message.author.id)}` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_top_prev_${message.author.id}_${currentPage}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(currentPage <= 1),
    new ButtonBuilder().setCustomId(`ticket_top_next_${message.author.id}_${currentPage}`).setLabel('التالي').setStyle(ButtonStyle.Primary).setDisabled(currentPage >= totalPages)
  );
  const sent = await message.reply({ embeds: [embed], components: [row] }).catch(() => null);
  if (!sent) return;
  const collector = sent.createMessageComponentCollector({ time: 5 * 60 * 1000 });
  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== message.author.id) {
      await interaction.reply(buildTicketMessagePayload('ملقوف', '**فقط طالب الأمر يمكنه التحكم بالتصفح.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
      return;
    }
    const isNext = interaction.customId.startsWith('ticket_top_next_');
    const nextPage = Math.min(totalPages, Math.max(1, currentPage + (isNext ? 1 : -1)));
    collector.stop();
    await interaction.update({ components: [] }).catch((error) => logSilentError('suppressed', error));
    await handleTopPointsMessage(message, nextPage);
  });
  collector.on('end', async () => {
    await sent.edit({ components: [] }).catch((error) => logSilentError('suppressed', error));
  });
}

async function handleTopManagersMessage(message, page = 1) {
  const points = loadPoints();
  const rawEntries = getTopManagers(points, 1000);
  const entries = [];
  for (const entry of rawEntries) {
    const member = await resolveGuildMember(message.guild, entry.userId, 1200);
    if (!member || !canUseGeneralPointsCommand(member, message.guild.id, message.guild)) continue;
    entries.push(entry);
  }
  const safePage = Math.max(1, Number(page || 1));
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const currentPage = Math.min(safePage, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageEntries = entries.slice(start, start + pageSize);
  const description = pageEntries.length
    ? pageEntries.map((entry, index) => `#${start + index + 1} - <@${entry.userId}> : ${entry.total}m`).join('\n\n')
    : '**لا توجد نقاط مسؤولين مسجلة حالياً.**';
  const embed = makeTicketEmbed('Top manager', description, { user: message.author })
    .setThumbnail(message.guild?.iconURL?.({ forceStatic: false, size: 128 }) || null)
    .setFooter({ text: `Page ${currentPage}/${totalPages} • نقاطك كمسؤول : ${getManagerPointCount(points, message.author.id)}` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_tm_prev_${message.author.id}_${currentPage}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(currentPage <= 1),
    new ButtonBuilder().setCustomId(`ticket_tm_next_${message.author.id}_${currentPage}`).setLabel('التالي').setStyle(ButtonStyle.Primary).setDisabled(currentPage >= totalPages)
  );
  const sent = await message.reply({ embeds: [embed], components: [row] }).catch(() => null);
  if (!sent) return;
  const collector = sent.createMessageComponentCollector({ time: 5 * 60 * 1000 });
  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== message.author.id) {
      await interaction.reply(buildTicketMessagePayload('ملقوف', '**فقط طالب الأمر يمكنه التحكم بالتصفح.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
      return;
    }
    const isNext = interaction.customId.startsWith('ticket_tm_next_');
    const nextPage = Math.min(totalPages, Math.max(1, currentPage + (isNext ? 1 : -1)));
    collector.stop();
    await interaction.update({ components: [] }).catch((error) => logSilentError('suppressed', error));
    await handleTopManagersMessage(message, nextPage);
  });
  collector.on('end', async () => {
    await sent.edit({ components: [] }).catch((error) => logSilentError('suppressed', error));
  });
}

async function handleResetPointsMessage(message, { ownerOnly = false } = {}) {
  const points = loadPoints();
  const adminCount = getTopPointUsers(points, 100000).length;
  const managerCount = getTopManagers(points, 100000).length;
  const actionLabel = ownerOnly ? 'Reset Managers' : 'Reset Admins';
  const warning = ownerOnly
    ? `**سيتم تصفيير توب المسؤولين فقط.**\n**لن يتم حذف نقاط الإدارة العادية.**\n**عدد المسؤولين المتأثرين :** ${managerCount}`
    : `**سيتم تصفيير نقاط الإدارة العادية فقط.**\n**لن يتم حذف توب المسؤولين.**\n**عدد الإداريين المتأثرين :** ${adminCount}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_reset_confirm_${ownerOnly ? 'manager' : 'admin'}_${message.author.id}`).setLabel('Done?').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ticket_reset_cancel_${ownerOnly ? 'manager' : 'admin'}_${message.author.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
  );
  const prompt = await message.reply({ ...buildTicketMessagePayload(actionLabel, warning), components: [row] }).catch(() => null);
  if (!prompt) return;
  const collector = prompt.createMessageComponentCollector({ time: 60 * 1000 });
  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== message.author.id) {
      await interaction.reply(buildTicketMessagePayload('ملقوف', '**فقط طالب الأمر يمكنه التأكيد.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
      return;
    }
    if (interaction.customId.startsWith('ticket_reset_cancel_')) {
      collector.stop();
      await interaction.update({ components: [], embeds: [makeTicketEmbed(actionLabel, '**تم إلغاء العملية.**', { user: message.author })] }).catch((error) => logSilentError('suppressed', error));
      return;
    }
    const nextPoints = loadPoints();
    if (ownerOnly) {
      nextPoints.__managerAudit = [];
      nextPoints.__managerPointsAudit = [];
    } else {
      for (const key of Object.keys(nextPoints)) {
        if (!key.startsWith('__')) delete nextPoints[key];
      }
      nextPoints.__audit = [];
    }
    savePoints(nextPoints);
    collector.stop();
    await interaction.update({
      components: [],
      embeds: [makeTicketEmbed('Reseted', ownerOnly ? '**تم تصفير توب المسؤولين بنجاح.**' : '**تم تصفير نقاط الإدارة بنجاح.**', { user: message.author })]
    }).catch((error) => logSilentError('suppressed', error));
  });
  collector.on('end', async () => {
    await prompt.edit({ components: [] }).catch((error) => logSilentError('suppressed', error));
  });
}

async function handleTicketBlockListMessage(message, page = 1) {
  const blocks = await syncTicketBlocks(message.guild.id);
  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(blocks.length / pageSize));
  const currentPage = Math.min(Math.max(1, Number(page || 1)), totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageItems = blocks.slice(start, start + pageSize);
  const embed = makeTicketEmbed('Tblock list', pageItems.length ? '**قائمة البلوكات الحالية:**' : '**لا توجد بلوكات تكت حالياً.**', { user: message.author })
    .setFooter({ text: `page ${currentPage}/${totalPages}` });
  for (const entry of pageItems) {
    embed.addFields({
      name: `${entry.targetType === 'role' ? 'رول' : 'عضو'} • ${entry.targetType === 'role' ? `<@&${entry.targetId}>` : `<@${entry.targetId}>`}`,
      value: `**المدة :** ${formatBlockDuration(entry.expiresAt)}\n**السبب :** ${entry.reason || 'N/A '}\n**بواسطة :** <@${entry.actorId}>\n**الوقت :** <t:${Math.floor(Number(entry.createdAt) / 1000)}:F>`,
      inline: false
    });
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket_block_list_prev_${message.author.id}_${currentPage}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(currentPage <= 1),
    new ButtonBuilder().setCustomId(`ticket_block_list_next_${message.author.id}_${currentPage}`).setLabel('التالي').setStyle(ButtonStyle.Primary).setDisabled(currentPage >= totalPages)
  );
  const sent = await message.reply({ embeds: [embed], components: [row] }).catch(() => null);
  if (!sent) return;
  const collector = sent.createMessageComponentCollector({ time: 5 * 60 * 1000 });
  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== message.author.id) {
      await interaction.reply(buildTicketMessagePayload('ملقوف', '**فقط طالب الأمر يمكنه التحكم بالتصفح.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
      return;
    }
    const isNext = interaction.customId.startsWith('ticket_block_list_next_');
    collector.stop();
    await interaction.update({ components: [] }).catch((error) => logSilentError('suppressed', error));
    await handleTicketBlockListMessage(message, currentPage + (isNext ? 1 : -1));
  });
  collector.on('end', async () => {
    await sent.edit({ components: [] }).catch((error) => logSilentError('suppressed', error));
  });
}

async function collectTicketBlockPrompt(message, promptText) {
  const prompt = await message.channel.send(buildTicketMessagePayload('Tblock ', promptText, { user: message.author })).catch(() => null);
  if (!prompt) return null;
  const collected = await message.channel.awaitMessages({
    filter: (m) => m.author.id === message.author.id,
    max: 1,
    time: 120000
  }).catch(() => null);
  const reply = collected?.first?.() || null;
  return { prompt, reply };
}

async function handleTicketBlockApplyMessage(message, targetInput, BOT_OWNERS = []) {
  const member = message.member;
  const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
  if (!isOwner && !canUseGeneralPointsCommand(member, message.guild.id, message.guild)) {
    await message.react('❌').catch((error) => logSilentError('suppressed', error));
    return;
  }

  const targetId = normalizeId(targetInput);
  if (!targetId) {
    await message.reply(buildTicketMessagePayload('Error', '**أرسل منشن أو آيدي صحيح.**')).catch((error) => logSilentError('suppressed', error));
    return;
  }

  await syncTicketBlocks(message.guild.id);
  const data = getTicketBlockData(message.guild.id);
  const targetType = message.guild.roles.cache.has(targetId) ? 'role' : 'user';
  const existing = data.blocks.find((entry) => entry.targetId === targetId && entry.targetType === targetType);
  if (existing) {
    const nextBlocks = data.blocks.filter((entry) => !(entry.targetId === targetId && entry.targetType === targetType));
    saveTicketBlockData(message.guild.id, { blocks: nextBlocks, blockChannelId: data.blockChannelId });
    await message.delete().catch((error) => logSilentError('suppressed', error));
    await logTicketBlockAction(message.guild, message.author, existing, 'unblock');
    await notifyTicketBlockTarget(message.guild, message.author, existing, 'unblock');
    await message.channel.send(buildTicketMessagePayload('Done Unblock ✅️', `**تم فك بلوك التكت عن** ${targetType === 'role' ? `<@&${targetId}>` : `<@${targetId}>`}.`, { user: message.author })).catch((error) => logSilentError('suppressed', error));
    return;
  }

  await message.delete().catch((error) => logSilentError('suppressed', error));
  const durationStep = await collectTicketBlockPrompt(message, '**كم تريد المدة؟**\n**0 = بدون مدة**');
  const durationText = durationStep?.reply?.content?.trim();
  await durationStep?.prompt?.delete().catch((error) => logSilentError('suppressed', error));
  await durationStep?.reply?.delete().catch((error) => logSilentError('suppressed', error));
  if (!durationText) return;

  const hours = Number(durationText);
  const expiresAt = durationText === '0' ? null : (Number.isFinite(hours) && hours > 0 ? Date.now() + (hours * 60 * 60 * 1000) : null);
  if (durationText !== '0' && !expiresAt) {
    await message.channel.send(buildTicketMessagePayload('خطأ', '**المدة غير صالحة.**', { user: message.author })).catch((error) => logSilentError('suppressed', error));
    return;
  }

  const reasonStep = await collectTicketBlockPrompt(message, '**اذكر السبب أو 0 (بدون سبب)**');
  const reasonText = reasonStep?.reply?.content?.trim();
  await reasonStep?.prompt?.delete().catch((error) => logSilentError('suppressed', error));
  await reasonStep?.reply?.delete().catch((error) => logSilentError('suppressed', error));
  if (reasonText === undefined) return;

  const blockEntry = {
    targetId,
    targetType,
    actorId: message.author.id,
    createdAt: Date.now(),
    expiresAt,
    reason: reasonText === '0' ? '' : reasonText
  };
  const nextBlocks = pruneTicketBlocks([...data.blocks, blockEntry]);
  saveTicketBlockData(message.guild.id, { blocks: nextBlocks, blockChannelId: data.blockChannelId });
  await logTicketBlockAction(message.guild, message.author, blockEntry, 'block');
  await notifyTicketBlockTarget(message.guild, message.author, blockEntry, 'block');
  await message.channel.send(buildTicketMessagePayload('Done block ✅️', `**تم إعطاء بلوك تكت إلى** ${targetType === 'role' ? `<@&${targetId}>` : `<@${targetId}>`}.`, { user: message.author })).catch((error) => logSilentError('suppressed', error));
}

async function handleReassignRequest(interaction, guildId, panelId, channelId, options = {}) {
  const silent = options?.silent === true;
  if (!silent) await interaction.deferReply({ ephemeral: true }).catch((error) => logSilentError('suppressed', error));
  const reply = async (payload) => {
    if (silent) return;
    await interaction.editReply(payload).catch((error) => logSilentError('suppressed', error));
  };
  const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId || 'default');
  if (!ticket || interaction.channelId !== actionChannelId) {
    await reply(buildTicketMessagePayload('Error', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
    return false;
  }
  if (!isAdminOnly(interaction, config, ticket?.reasonKey)) {
    await reply(buildTicketMessagePayload('No perms', '**ليس لديك صلاحية تغيير المستلم.**', { ephemeral: true }));
    return false;
  }
  if (ticket.status !== 'open') {
    await reply(buildTicketMessagePayload('Alert', '**تغيير المستلم متاح فقط قبل إغلاق التكت.**', { ephemeral: true }));
    return false;
  }

  const previousClaimer = ticket.claimedBy || null;
  if (ticket.reassignPendingAt) {
    await reply(buildTicketMessagePayload('Alert', '**يوجد طلب تغيير مستلم معلّق بالفعل.**', { ephemeral: true }));
    return false;
  }

  const targetChannelId = config.claimFromDedicatedChannel ? config.claimChannelId : interaction.channelId;
  const targetChannel = await interaction.guild.channels.fetch(targetChannelId).catch(() => null);
  if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
    await reply(buildTicketMessagePayload('error', '**شات القبول غير صالح أو غير متاح.**', { ephemeral: true }));
    return false;
  }

  const mentionChunks = buildMentionChunks(getAdminRoles(config, ticket?.reasonKey));
  const requestRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket_reassign_claim_${guildId}_${resolvedPanelId}_${actionChannelId}`)
      .setLabel('Claim')
      .setEmoji('<:emoji_3:1484364952780144710>')
      .setStyle(ButtonStyle.Secondary)
  );

  const reasonSettings = getReasonVisualSettings(config, ticket.reasonKey);
  const reason = reasonSettings.reason;
  const isInternalReassignFlow = !config.claimFromDedicatedChannel && targetChannelId === actionChannelId;
  const requestText = isInternalReassignFlow
    ? '**تم تغير المستلم، انتظر مستلم جديد.**'
    : [
      '# طلب تغيير الاداري',
      `**العضو :** <@${ticket.memberId}>`,
      `**السبب :** ${reason.name || `سبب ${ticket.reasonKey}`}`,
      `**التكت :** <#${actionChannelId}>`
    ].join('\n');

  try {
    ticket.reassignRequestMessageRefs = [];
    for (const chunk of mentionChunks) {
      const sent = await targetChannel.send({ content: chunk });
      if (sent?.id) {
        ticket.reassignRequestMessageRefs.push({ channelId: sent.channelId || targetChannel.id, messageId: sent.id });
      }
    }

    const claimImage = resolveImageForSend(reasonSettings.claimImage);
    if (claimImage) {
      const sent = await targetChannel.send({ content: requestText, files: [claimImage], components: [requestRow] });
      if (sent?.id) {
        ticket.reassignRequestMessageRefs.push({ channelId: sent.channelId || targetChannel.id, messageId: sent.id });
      }
    } else {
      const sent = await targetChannel.send({ content: requestText, components: [requestRow] });
      if (sent?.id) {
        ticket.reassignRequestMessageRefs.push({ channelId: sent.channelId || targetChannel.id, messageId: sent.id });
      }
    }
  } catch {
    delete ticket.reassignRequestMessageRefs;
    await reply(buildTicketMessagePayload('error', '**فشل إرسال طلب تغيير المستلم في شات القبول، تم إلغاء العملية.**', { ephemeral: true }));
    return false;
  }

  // عند إلغاء الاستلام، تصبح التذكرة غير مستلمة، لذا يجب مسح pointsReceiverId.
  // سيتم تعيين pointsReceiverId للمستلم الجديد عند استلام التذكرة لاحقاً.
  ticket.pointsReceiverId = null;
  ticket.claimedBy = null;
  ticket.reassignPendingAt = Date.now();
  ticket.reassignPreviousClaimer = previousClaimer || interaction.user.id;

  if (interaction.user.id) {
    await editOverwriteFast(interaction.channel, interaction.user.id, {
      ViewChannel: false,
      SendMessages: false
    });
  }
  if (previousClaimer && previousClaimer !== interaction.user.id) {
    await editOverwriteFast(interaction.channel, previousClaimer, {
      ViewChannel: false,
      SendMessages: false
    });
  }

  setGuildData(guildId, config, tickets, pendingRequests, resolvedPanelId);
  await syncTicketLogMessage({
    guild: interaction.guild,
    config,
    ticket,
    channelId: actionChannelId,
    actionText: `تم تغيير المستلم عن طريق : <@${interaction.user.id}>`,
    actor: interaction.user
  });
  if (interaction.message?.editable) {
    const refreshedControls = await buildTicketControls(guildId, resolvedPanelId, actionChannelId, config, {
      includeClaimButton: true,
      disableClaimButton: false,
      hideReassignButton: true
    });
    await interaction.message.edit({ components: refreshedControls }).catch((error) => logSilentError('suppressed', error));
  }

  await reply(buildTicketMessagePayload('Done', '**تم إخراجك من التكت وإرسال طلب استلام جديد.**', { ephemeral: true }));
  return true;
}


async function handleReassignClaim(interaction, guildId, panelId, channelId) {
  await interaction.deferReply({ ephemeral: true }).catch((error) => logSilentError('suppressed', error));
  const lockKey = `reassign_claim:${guildId}:${channelId}`;
  if (ticketClaimLocks.has(lockKey)) {
    await interaction.editReply(buildTicketMessagePayload('Alert', '**جاري معالجة الطلب، حاول بعد لحظات.**')).catch((error) => logSilentError('suppressed', error));
    return;
  }
  ticketClaimLocks.add(lockKey);
  try {
  const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId || 'default');
  if (!ticket) {
    await interaction.editReply(buildTicketMessagePayload('Error', '**لا توجد بيانات لهذا التكت.**'));
    return;
  }
  if (!hasStaffAccess(interaction.member, config, ticket?.reasonKey, ticket)) {
    await interaction.editReply(buildTicketMessagePayload('No perms', '**ليس لديك صلاحية الاستلام.**'));
    return;
  }
  const claimedState = await countClaimedByAdminSafe(interaction.guild, tickets, interaction.user.id);
  if (claimedState.changed) {
    setGuildData(interaction.guild.id, config, tickets, pendingRequests, panelId || 'default');
  }
  const claimedCount = claimedState.count;
  if (claimedCount >= (config.adminClaimLimit || 1)) {
    await interaction.editReply(buildTicketMessagePayload('Alert', `**الحد :** لا يمكنك استلام أكثر من ${config.adminClaimLimit} تكت مفتوح.`));
    return;
  }
  if (ticket.claimedBy && ticket.claimedBy !== interaction.user.id) {
    await interaction.editReply(buildTicketMessagePayload('Alert', `**تم الاستلام بالفعل بواسطة :** <@${ticket.claimedBy}>`));
    return;
  }
  if (!ticket.reassignPendingAt) {
    await interaction.editReply(buildTicketMessagePayload('Alert', '**لا يوجد طلب تغيير مستلم نشط لهذا التكت.**')).catch((error) => logSilentError('suppressed', error));
    return;
  }
  if (ticket.reassignPreviousClaimer && ticket.reassignPreviousClaimer === interaction.user.id) {
    await interaction.editReply(buildTicketMessagePayload('Alert', '** مايمدي نفس المستلم القديم يستلم طلب التغيير .**')).catch((error) => logSilentError('suppressed', error));
    return;
  }

  const ticketChannel = interaction.guild.channels.cache.get(actionChannelId)
    || await interaction.guild.channels.fetch(actionChannelId).catch(() => null);
  if (!ticketChannel || ticketChannel.type !== ChannelType.GuildText) {
    await interaction.editReply(buildTicketMessagePayload('Error', '**تعذر العثور على روم التكت.**')).catch((error) => logSilentError('suppressed', error));
    return;
  }

  ticket.claimedBy = interaction.user.id;
  ticket.pointsReceiverId = interaction.user.id;
  delete ticket.reassignPendingAt;
  touchTicketActivity(ticket);
  await ticketChannel.permissionOverwrites.edit(interaction.user.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true
  }).catch((error) => logSilentError('suppressed', error));

  if (interaction.message?.editable) {
    const rows = interaction.message.components.map((row) => {
      const comps = row.components.map((component) => {
        if (component.customId?.startsWith('ticket_reassign_claim_')) {
          return ButtonBuilder.from(component).setDisabled(true).setEmoji('<:emoji_3:1484364952780144710>').setLabel('Claimed');
        }
        return component;
      });
      return new ActionRowBuilder().addComponents(comps);
    });
    if (config.deleteClaimMessageOnClaim) {
      await deleteTrackedMessages(interaction.guild, ticket?.reassignRequestMessageRefs, interaction.message.id);
      await deleteClaimMessageIfEnabled(interaction, config);
    } else {
      await interaction.message.edit({
        content: buildClaimRequestContent(ticket, config, interaction.user.id),
        embeds: [],
        components: rows
      }).catch((error) => logSilentError('suppressed', error));
    }
  }

  const claimImage = resolveImageForSend(getReasonVisualSettings(config, ticket.reasonKey).claimImage);
  await sendClaimAnnounce({ channel: ticketChannel, config, ticket, claimerId: interaction.user.id, claimImage });
  delete ticket.reassignRequestMessageRefs;

  await syncTicketLogMessage({
    guild: interaction.guild,
    config,
    ticket,
    channelId: actionChannelId,
    actionText: `تم استلام التكت بالمستلم الجديد عن طريق : <@${interaction.user.id}>`,
    actor: interaction.user
  });

  setGuildData(guildId, config, tickets, pendingRequests, resolvedPanelId);
  await interaction.editReply(buildTicketMessagePayload('تم', '**تم استلام التكت بالمستلم الجديد.**'));
  } finally {
    ticketClaimLocks.delete(lockKey);
  }
}

function createReasonComponents(config, guildId, panelId = 'default') {
  const reasons = Object.entries(config.reasons || {}).sort((a, b) => Number(a[0]) - Number(b[0])).slice(0, 25);
  if (config.displayMode === 'menu') {
    const options = reasons.length
      ? reasons.map(([k, v]) => ({ label: (v.name || `سبب ${k}`).slice(0, 100), description: (v.description || '').slice(0, 100) || undefined, value: `reason_${k}`, emoji: v.emoji || undefined }))
      : [{ label: 'فتح تكت عام', value: 'reason_0', emoji: '<:emoji_8:1484365144963289238>' }];
    return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`ticket_open_menu_${guildId}_${panelId}`).setPlaceholder('اختر السبب').addOptions(options))];
  }

  const maxButtons = Math.max(1, Math.min(25, (config.buttonRows || 2) * 5));
  const entries = (reasons.length ? reasons : [['0', { name: 'فتح تكت', emoji: '<:emoji_8:1484365144963289238>' }]])
    .sort((a, b) => Number(a[1]?.buttonOrder || a[0]) - Number(b[1]?.buttonOrder || b[0]))
    .slice(0, maxButtons);
  const buttons = entries.map(([k, v]) => new ButtonBuilder()
    .setCustomId(`ticket_open_btn_${guildId}_${panelId}_${k}`)
    .setLabel((v.name || `سبب ${k}`).slice(0, 80))
    .setStyle(resolveButtonStyle(v.buttonStyle))
    .setEmoji(v.emoji || '<:emoji_8:1484365144963289238>'));

  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  return rows;
}

async function execute(message, args, { BOT_OWNERS = [], ADMIN_ROLES = [] }) {
  botOwnersCache.clear();
  for (const ownerId of BOT_OWNERS || []) botOwnersCache.add(String(ownerId));
  const dedupeKey = `${message.guild?.id || 'dm'}:${message.id}`;
  if (recentTicketCommandMessages.has(dedupeKey)) return;
  recentTicketCommandMessages.add(dedupeKey);
  setTimeout(() => recentTicketCommandMessages.delete(dedupeKey), 60 * 1000);

  const invokedToken = String(message.content || '').trim().split(/\s+/)[0]?.toLowerCase() || '';
  const member = await resolveGuildMember(message.guild, message.author.id);
  if (!member) return;
  const hasGlobalAdmin = hasGlobalAdminAccess(member, message, BOT_OWNERS, ADMIN_ROLES);
  const activeBlock = resolveTicketBlockForMember(message.guild.id, member);
  if (activeBlock && !invokedToken.endsWith('tblock')) {
    await message.reply(buildTicketMessagePayload('Blocked', '** عندك بلوك تكت لرؤية المدة اتجه للخاص.**')).catch((error) => logSilentError('suppressed', error));
    return;
  }
  const closeAliases = ['tclose', 'اغلاق', 'قفل', 'اقفال'];
  const isCloseAliasInvocation = closeAliases.some((alias) => invokedToken.endsWith(alias));
  if (isCloseAliasInvocation) {
    const ok = await handleCloseAliasMessage(message);
    await message.react(ok ? '<:emoji_42:1430334150057001042>' : '<:emoji_44:1430334506371645593>').catch((error) => logSilentError('suppressed', error));
    return;
  }

  if (['myticket', 'نقاطي'].some((alias) => invokedToken.endsWith(alias))) {
    const targetArg = args?.[0] || null;
    const hasTargetLookup = Boolean(normalizeId(targetArg));
    if (hasTargetLookup && !hasGlobalAdmin) {
      await message.react('<:emoji_44:1430334506371645593>').catch((error) => logSilentError('suppressed', error));
      return;
    }
    await handleMyTicketPointsMessage(message, targetArg, { thumbnailMode: 'user' });
    return;
  }
  if (['tadd', 'اضافه', 'اضافة', 'إضافة'].some((alias) => invokedToken.endsWith(alias))) {
    const ok = await handleAddRemoveAliasMessage(message, args?.join(' '), 'add');
    await message.react(ok ? '<:emoji_42:1430334150057001042>' : '<:emoji_44:1430334506371645593>').catch((error) => logSilentError('suppressed', error));
    return;
  }
  if (['tremove', 'ازاله', 'ازالة', 'إزالة'].some((alias) => invokedToken.endsWith(alias))) {
    const ok = await handleAddRemoveAliasMessage(message, args?.join(' '), 'remove');
    await message.react(ok ? '<:emoji_42:1430334150057001042>' : '<:emoji_44:1430334506371645593>').catch((error) => logSilentError('suppressed', error));
    return;
  }
  if (['tchange', 'تغيير', 'تحويل'].some((alias) => invokedToken.endsWith(alias))) {
    const ok = await handleReassignAliasMessage(message);
    await message.react(ok ? '<:emoji_42:1430334150057001042>' : '<:emoji_44:1430334506371645593>').catch((error) => logSilentError('suppressed', error));
    return;
  }
  if (['tname', 'اسم', 'تسميه', 'تسمية'].some((alias) => invokedToken.endsWith(alias))) {
    const ok = await handleRenameAliasMessage(message, args?.join(' '));
    await message.react(ok ? '<:emoji_42:1430334150057001042>' : '<:emoji_44:1430334506371645593>').catch((error) => logSilentError('suppressed', error));
    return;
  }
  if (['remind', 'تنبيه', 'استدعاء'].some((alias) => invokedToken.endsWith(alias))) {
    const ok = await handlePingAliasMessage(message);
    await message.react(ok ? '<:emoji_42:1430334150057001042>' : '<:emoji_44:1430334506371645593>').catch((error) => logSilentError('suppressed', error));
    return;
  }
  const pointsTargetCandidate = normalizeId(args?.[0]);
  if (invokedToken.endsWith('ttop') || (invokedToken.endsWith('نقاط') && !pointsTargetCandidate && String(args?.[0] || '').toLowerCase() !== 'add')) {
    if (!hasGlobalAdmin) {
      await message.react('<:emoji_44:1430334506371645593>').catch((error) => logSilentError('suppressed', error));
      return;
    }
    await handleTopPointsMessage(message, Number(args?.[0] || 1));
    return;
  }
  if (invokedToken.endsWith('tm')) {
    if (!hasGlobalAdmin) {
      await message.react('<:emoji_44:1430334506371645593>').catch((error) => logSilentError('suppressed', error));
      return;
    }
    await handleTopManagersMessage(message, Number(args?.[0] || 1));
    return;
  }
  if (invokedToken.endsWith('points')) {
    await handlePointsAdjustMessage(message, args, { BOT_OWNERS });
    return;
  }
  if (invokedToken.endsWith('نقاط') && pointsTargetCandidate) {
    await handlePointsAdjustMessage(message, args, { BOT_OWNERS });
    return;
  }
  if (invokedToken.endsWith('treset')) {
    if (!canUseGeneralPointsCommand(member, message.guild.id, message.guild)) {
      await message.react('<:emoji_44:1430334506371645593>').catch((error) => logSilentError('suppressed', error));
      return;
    }
    await handleResetPointsMessage(message, { ownerOnly: false });
    return;
  }
  if (invokedToken.endsWith('tmreset')) {
    const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
    if (!isOwner) {
      await message.react('<:emoji_44:1430334506371645593>').catch((error) => logSilentError('suppressed', error));
      return;
    }
    await handleResetPointsMessage(message, { ownerOnly: true });
    return;
  }
  if (invokedToken.endsWith('tblock')) {
    const sub = String(args?.[0] || '').toLowerCase();
    const isOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
    if (sub === 'chat') {
      if (!isOwner) {
        await message.react('<:emoji_44:1430334506371645593>').catch((error) => logSilentError('suppressed', error));
        return;
      }
      const channelId = normalizeId(args?.[1]);
      const channel = channelId ? await message.guild.channels.fetch(channelId).catch(() => null) : null;
      if (!channel?.isTextBased?.()) {
        await message.reply(buildTicketMessagePayload('Mention', '**أرسل منشن أو آيدي روم بلوك صالح.**')).catch((error) => logSilentError('suppressed', error));
        return;
      }
      const data = getTicketBlockData(message.guild.id);
      saveTicketBlockData(message.guild.id, { blocks: data.blocks, blockChannelId: channelId });
      await message.reply(buildTicketMessagePayload('Done ✅️', `**تم تعيين شات بلوك التكت :** <#${channelId}>`)).catch((error) => logSilentError('suppressed', error));
      return;
    }
    if (sub === 'list') {
      if (!canUseGeneralPointsCommand(member, message.guild.id, message.guild) && !isOwner) {
        await message.react('<:emoji_44:1430334506371645593>').catch((error) => logSilentError('suppressed', error));
        return;
      }
      await handleTicketBlockListMessage(message, Number(args?.[1] || 1));
      return;
    }
    await handleTicketBlockApplyMessage(message, args?.[0], BOT_OWNERS);
    return;
  }

  if (!hasGlobalAdmin) {
    await message.react('<:emoji_44:1430334506371645593>');
    return;
  }

  const subcommand = String(args?.[0] || '').toLowerCase();
  if (subcommand === 'export') {
    const panelId = extractChannelId(args?.[1]) || message.channel.id;
    const snapshot = exportPanelSnapshot(message.guild.id, panelId);
    await message.reply(buildTicketMessagePayload('تصدير إعدادات التكت', `\`\`\`\n${snapshot}\n\`\`\``, { ephemeral: false })).catch((error) => logSilentError('suppressed', error));
    return;
  }
  if (subcommand === 'import' || subcommand === 'restore') {
    const panelId = extractChannelId(args?.[1]) || message.channel.id;
    const encoded = args?.slice(2).join('').trim();
    if (!encoded) {
      await message.reply(buildTicketMessagePayload('خطأ', '**أرسل snapshot base64 بعد الروم.**')).catch((error) => logSilentError('suppressed', error));
      return;
    }
    try {
      importPanelSnapshot(message.guild.id, panelId, encoded, true);
      await message.reply(buildTicketMessagePayload('تم', `**تم استيراد إعدادات التكت للروم:** <#${panelId}>`)).catch((error) => logSilentError('suppressed', error));
    } catch {
      await message.reply(buildTicketMessagePayload('خطأ', '**snapshot غير صالح أو تالف.**')).catch((error) => logSilentError('suppressed', error));
    }
    return;
  }
const isServerOwnerOrBotOwner = BOT_OWNERS.includes(message.author.id) || message.guild.ownerId === message.author.id;
  if (!isServerOwnerOrBotOwner) {
    await message.reply(buildTicketMessagePayload('Perm', '**لا تملك صلاحية تعديل اعدادات التكت.**')).catch((error) => logSilentError('suppressed', error));
    return;
  }
  const setupSessionKey = `${message.guild.id}:${message.author.id}`;
  let existingSession = activeTicketSetupSessions.get(setupSessionKey);
  if (!existingSession) {
    existingSession = await loadRuntimeSession('ticket-setup', setupSessionKey).catch(() => null);
    if (existingSession) activeTicketSetupSessions.set(setupSessionKey, existingSession);
  }

  let resumedSetupPanelId = null;
  let resumedSetupNotice = null;
  let previousSetupMessageRef = null;
  if (existingSession && (Date.now() - existingSession.startedAt) < (30 * 60 * 1000)) {
    if (existingSession.sourceMessageId === message.id) return;
    resumedSetupPanelId = extractChannelId(existingSession.panelId || '') || null;
    if (!resumedSetupPanelId) {
      activeTicketSetupSessions.delete(setupSessionKey);
      deleteRuntimeSession('ticket-setup', setupSessionKey);
      existingSession = null;
    } else {
      if (existingSession.channelId && existingSession.messageId) {
        previousSetupMessageRef = {
          channelId: existingSession.channelId,
          messageId: existingSession.messageId
        };
      }
      resumedSetupNotice = '**تم استرجاع جلسة الإعداد السابقة، ويمكنك المتابعة من آخر إعداد محفوظ.**';
    }
  }

  const setupInstanceId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const initialSetupSession = {
    setupInstanceId,
    startedAt: Date.now(),
    messageId: null,
    channelId: message.channel.id,
    sourceMessageId: message.id,
    initializing: true
  };
  activeTicketSetupSessions.set(setupSessionKey, initialSetupSession);
  saveRuntimeSession('ticket-setup', setupSessionKey, initialSetupSession, 30 * 60 * 1000);

  const controlChannel = message.channel;
  let setupMessage = null;
  let activePromptInteraction = null;

  let panelId = resumedSetupPanelId || extractChannelId((args || []).join(' '));
  if (!panelId) {
    await controlChannel.send(buildTicketMessagePayload('Ticket Settings', '**ارسل اي دي او منشن الروم المراد ربط إعدادات التكت به.**')).catch((error) => logSilentError('suppressed', error));
    const collected = await controlChannel.awaitMessages({
      filter: (m) => m.author.id === message.author.id,
      max: 1,
      time: 180000
    });
    const first = collected.first();
    if (first) {
      panelId = extractChannelId(first.content || '');
      await first.delete().catch((error) => logSilentError('suppressed', error));
    }
  }

  const panelChannel = panelId ? await message.guild.channels.fetch(panelId).catch(() => null) : null;
  if (!panelChannel || !panelChannel.isTextBased?.()) {
    activeTicketSetupSessions.delete(setupSessionKey);
    deleteRuntimeSession('ticket-setup', setupSessionKey);
    await controlChannel.send(buildTicketMessagePayload('Failed', '**❌ الروم غير صالح، استخدم منشن أو اي دي روم نصي صحيح.**')).catch((error) => logSilentError('suppressed', error));
    return;
  }

  initialSetupSession.panelId = panelId;
  saveRuntimeSession('ticket-setup', setupSessionKey, initialSetupSession, 30 * 60 * 1000);

  const { config, tickets, pendingRequests } = getPanelData(message.guild.id, panelId);

  if (previousSetupMessageRef) {
    const previousSetupChannel = await message.guild.channels.fetch(previousSetupMessageRef.channelId).catch(() => null);
    if (previousSetupChannel?.isTextBased?.()) {
      const previousSetupMessage = await previousSetupChannel.messages.fetch(previousSetupMessageRef.messageId).catch(() => null);
      if (previousSetupMessage?.editable) {
        await previousSetupMessage.edit({ components: [] }).catch((error) => logSilentError('suppressed', error));
      }
    }
  }

  const ask = async (prompt, timeout = 180000, options = {}) => {
    const opts = options && typeof options === 'object' ? options : {};
    const imageOnly = Boolean(opts.imageOnly);
    const preferAttachment = Boolean(opts.preferAttachment);

    if (activePromptInteraction) {
      await activePromptInteraction.followUp(buildTicketMessagePayload('Alert', `🔒 ${prompt}`, { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
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

      if (first) await first.delete().catch((error) => logSilentError('suppressed', error));

      if (imageOnly) {
        if (text === '0') return '0';
        if (attachmentUrl) return attachmentUrl;
        if (/^https?:\/\//i.test(text)) return text;

        const remaining = maxAttempts - attempt;
        if (remaining > 0) {
          await controlChannel.send(buildTicketMessagePayload(
            'Error',
            `**❌ ادخال الصورة غير صالح. المتبقي ${remaining} محاولة.**\n**ارسل الصورة كمرفق بدون نص، او رابط مباشر للصورة، او 0 للإلغاء.**`
          )).catch((error) => logSilentError('suppressed', error));
          continue;
        }

        await controlChannel.send(buildTicketMessagePayload('Error', '**❌ تم إلغاء العملية: لم يتم استلام صورة صالحة.**')).catch((error) => logSilentError('suppressed', error));
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
      await controlChannel.send(buildTicketMessagePayload('Error', `**❌ ادخال غير صالح. اكتب رقمًا بين ${min} و ${max}.**`)).catch((error) => logSilentError('suppressed', error));
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
      await activePromptInteraction?.followUp(buildTicketMessagePayload('Alert', '**⚠️ لم يتم تغيير الصورة.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
      return currentValue;
    }
    if (v === '0') {
      removeStoredImage(currentValue);
      await activePromptInteraction?.followUp(buildTicketMessagePayload('Dome', '**✅ تم حذف الصورة بنجاح.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
      return '';
    }
    try {
      const stored = await storeImageLocally(v, message.guild.id, slotKey, currentValue);
      await activePromptInteraction?.followUp(buildTicketMessagePayload('Done', '**✅ تم حفظ الصورة بنجاح**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
      return stored;
    } catch {
      await activePromptInteraction?.followUp(buildTicketMessagePayload('Error', failureText || '**❌ فشل حفظ الصورة. تأكد ان الرابط مباشر او ارسل الصورة كمرفق.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
      return currentValue;
    }
  };

  const notifySetupResult = async (text) => {
    await activePromptInteraction?.followUp(buildTicketMessagePayload('Updated', text, { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
  };


  const buildSetupEmbed = () => {
    const reasonsCount = Object.keys(config.reasons || {}).length;
    const responsiblesMentions = (config.responsibleRoleIds || []).length
      ? (config.responsibleRoleIds || []).map((id) => `<@&${id}>`).join(' ')
      : 'غير معين';
    const adminRolesMentions = config.useGlobalAdminRoles
      ? 'adminRoles'
      : ((config.adminRoleIds || []).length
        ? (config.adminRoleIds || []).map((id) => `<@&${id}>`).join(' ')
        : 'غير معين');
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
      .setAuthor({ name: message.guild.name, iconURL: message.guild.iconURL({ dynamic: true, size: 256 }) || undefined })
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
        { name: 'روم اللوق', value: config.logChannelId ? `<#${config.logChannelId}>` : 'غير معين', inline: true },
        { name: 'حدود النظام', value: `حد الاستلام : ${config.adminClaimLimit}\nحد الفتح : ${config.memberOpenLimit}`, inline: true },
        { name: 'حالة التبديلات', value: `انشاء قبل الاستلام : ${config.autoCreateOnRequest ? 'مفعل' : 'مقفل'}\nاخفاء عند الاستلام : ${config.hideOnClaim ? 'مفعل' : 'مقفل'}\nشات استلام مخصص: ${config.claimFromDedicatedChannel ? 'مفعل' : 'مقفل'}\nالاحتفاظ بعد الاغلاق: ${config.keepClosedTickets ? 'مفعل' : 'مقفل'}\nحذف رسالة الاستلام بعد التنفيذ : ${config.deleteClaimMessageOnClaim ? 'مفعل' : 'مقفل'}\nالإغلاق التلقائي : ${config.autoCloseEnabled ? `مفعل (${config.autoCloseHours}h)` : 'مقفل'}`, inline: false },
        { name: `الاسباب (${reasonsCount})`, value: reasonsNames, inline: false },
        { name: 'جاهزية النظام', value: setupStatus.slice(0, 1024), inline: false }
      )
      .setFooter({ text: 'Ticket Settings' });
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
      .setPlaceholder('Ticket Settings')
      .addOptions([
        { label: ' شات التكت', value: 'set_name', description: 'تحديد بادئة الاسم وطريقة تسمية التكت', emoji: '<:emoji_14:1484393414551408771>' },
        { label: ' كاتوقري الفتح', value: 'set_open_category', description: 'تحديد كاتوقري استقبال التكتات', emoji: '<:emoji_14:1484393414551408771>' },
        { label: ' تحديد المسؤولين', value: 'set_responsibles', description: 'الرولات التي تدير التكتات', emoji: '<:emoji_14:1484393414551408771>' },
        { label: ' تحديد رولات الادمن', value: 'set_admin_roles', description: 'الرولات التي لها صلاحيات إدارية', emoji: '<:emoji_14:1484393414551408771>' },
        { label: 'حد استلام الاداري', value: 'set_admin_limit', description: 'عدد التكتات المفتوحة لكل إداري', emoji: '<:emoji_14:1484393414551408771>' },
        { label: ' حد فتح العضو', value: 'set_member_limit', description: 'عدد التكتات المفتوحة لكل عضو', emoji: '<:emoji_14:1484393414551408771>' },
        { label: 'انشاء قبل الاستلام ', value: 'toggle_auto_create', description: 'فتح مباشر أو انتظار الاستلام', emoji: '<:emoji_14:1484393414551408771>' },
        { label: 'اخفاء عند الاستلام ', value: 'toggle_hide_on_claim', description: 'إخفاء/إظهار عن الادارة', emoji: '<:emoji_14:1484393414551408771>' },
        { label: 'الاستلام من شات مخصص', value: 'toggle_claim_channel', description: 'تفعيل شات القبول لطلبات الاستلام', emoji: '<:emoji_14:1484393414551408771>' },
        { label: 'الاحتفاظ بعد الاغلاق', value: 'toggle_keep_closed', description: 'حذف التكت أو إبقاؤه بعد الإغلاق', emoji: '<:emoji_14:1484393414551408771>' },
        { label: 'اعدادات الرسائل', value: 'set_messages', description: 'تخصيص النصوص قبل/بعد/قبول', emoji: '<:emoji_14:1484393414551408771>' },
        { label: 'اعدادات الصور', value: 'set_images', description: 'تخصيص صور الفتح/الاستلام/الفاصل', emoji: '<:emoji_14:1484393414551408771>' },
        { label: 'تعديل الاسباب', value: 'set_reasons', description: 'تعديل أسماء/وصف/كاتوقري الأسباب', emoji: '<:emoji_14:1484393414551408771>' },
        { label: 'طريقة العرض', value: 'set_display_mode', description: 'الاختيار بين buttons أو menu', emoji: '<:emoji_14:1484393414551408771>' },
        { label: 'حذف رسالة الاستلام بعد التنفيذ', value: 'toggle_delete_claim_msg', description: 'حذف رسالة القبول بعد الاستلام', emoji: '<:emoji_14:1484393414551408771>' },
        { label: 'الإغلاق التلقائي', value: 'toggle_auto_close', description: 'تفعيل مدة إغلاق تلقائي حسب آخر رسالة', emoji: '<:emoji_14:1484393414551408771>' },
        { label: 'روم اللوق', value: 'set_log_channel', description: 'روم يسجل كل عمليات التكت', emoji: '<:emoji_14:1484393414551408771>' },
        { label: ' ارسال رسالة التكت', value: 'send_panel_now', description: 'إرسال بانل الفتح للروم المحدد', emoji: '<:emoji_14:1484393414551408771>' },
        { label: 'Finish', value: 'finish', description: 'حفظ الإعدادات الإغلاق ', emoji: '<:emoji_14:1484393414551408771>' }
      ]);

    const feedbackButton = new ButtonBuilder()
      .setCustomId(`ticket_setup_feedback_btn_${message.author.id}`)
      .setLabel('التقييم')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⭐');
    return [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(feedbackButton)];
  };

  setupMessage = await controlChannel.send({ embeds: [buildSetupEmbed()], components: buildMenuComponents() });
  const liveSetupSession = {
    setupInstanceId,
    startedAt: Date.now(),
    messageId: setupMessage.id,
    channelId: setupMessage.channel.id,
    sourceMessageId: message.id,
    panelId,
    initializing: false
  };
  activeTicketSetupSessions.set(setupSessionKey, liveSetupSession);
  saveRuntimeSession('ticket-setup', setupSessionKey, liveSetupSession, 30 * 60 * 1000);
  if (resumedSetupNotice) {
    await controlChannel.send(buildTicketMessagePayload('Resume', resumedSetupNotice)).catch((error) => logSilentError('suppressed', error));
  }

  const collector = setupMessage.createMessageComponentCollector({
    filter: (i) => i.user.id === message.author.id
      && (i.customId.startsWith('ticket_setup_menu_') || i.customId === `ticket_setup_feedback_btn_${message.author.id}`),
    time: 30 * 60 * 1000
  });

  const refresh = async (note = null, components = buildMenuComponents()) => {
    setGuildData(message.guild.id, config, tickets, pendingRequests, panelId);
    await setupMessage.edit({
      embeds: [normalizeEmbedForStandardMessage(buildSetupEmbed(), note)],
      components
    }).catch((error) => logSilentError('suppressed', error));
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
        emoji: reason.emoji || '<:emoji_14:1484393414551408771>'
      });
    }
    return options;
  };

  const pickReasonFromMenu = async () => {
    await setupMessage.edit({
      embeds: [colorManager.createEmbed()
        .setTitle('**اختيار السبب**')
        .setDescription('**اختر السبب من المنيو ثم عدّل كل تفاصيله (الاسم / الكاتوقري / الرسائل / الصور / المودال).**')],
      components: [new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`ticket_reason_pick_${message.author.id}_${Date.now()}`)
          .setPlaceholder('اختر السبب المراد تعديله')
          .addOptions(buildReasonSelectOptions())
      )]
    }).catch((error) => logSilentError('suppressed', error));

    const pick = await setupMessage.awaitMessageComponent({
      filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_reason_pick_'),
      time: 240000
    }).catch(() => null);

    if (!pick) return null;
    activePromptInteraction = pick;
    await pick.deferUpdate().catch((error) => logSilentError('suppressed', error));
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
        .setDescription('**التعديل من الأعلى للأقل أهمية : الاسم ← الكاتوقري ← الرسائل ← الصور ← العرض (عند الأزرار فقط) ← المودال.**')
        .addFields(
          {
            name: 'Settings',
            value: [
              `**الاسم :** ${reason.name || `سبب ${idx}`}`,
              `**اسم التكت :** ${reason.ticketName || 'افتراضي'}`,
              `**وصف السبب :** ${formatSettingValue(reason.description)}`,
              `**الايموجي :** ${formatSettingValue(reason.emoji || '🎫')}`,
              `**الكاتوقري :** ${reason.categoryId ? `<#${reason.categoryId}>` : 'افتراضي'}`
            ].join('\n'),
            inline: false
          },
          {
            name: 'رسائل السبب',
            value: [
              `**رسالة قبل الصورة :** ${formatSettingValue(reason.beforeImage)}`,
              `**رسالة بعد الصورة :** ${formatSettingValue(reason.afterImage)}`
            ].join('\n'),
            inline: false
          },
          {
            name: 'صور السبب',
            value: [
              `**صورة الفتح :** ${formatSettingValue(reason.openImage)}`,
              `**صورة الاستلام :** ${formatSettingValue(reason.claimImage)}`
            ].join('\n'),
            inline: false
          },
          {
            name: 'العرض الخاص بالسبب',
            value: [
              `**لون الزر :** ${formatSettingValue(reason.buttonStyle || 'primary')}`,
              `**ترتيب الزر :** ${formatSettingValue(reason.buttonOrder || idx)}`,
              `**الحالة :** ${config.displayMode === 'buttons' ? 'يعمل الآن' : 'غير مستخدم لأن طريقة العرض الحالية ليست أزرار'}`
            ].join('\n'),
            inline: false
          },
          {
            name: 'إدارة السبب',
            value: [
              `**الحالة :** ${reason.useCustomAdminRoles ? 'رولات خاصة بهذا السبب' : 'الرولات الإدارية العامة'}`,
              `**الرولات :** ${reason.useCustomAdminRoles ? ((reason.adminRoleIds || []).map((id) => `<@&${id}>`).join(' ') || 'لا يوجد') : 'يستخدم العام'}`
            ].join('\n').slice(0, 1024),
            inline: false
          },
          {
            name: 'مودال السبب',
            value: [
              `**الحالة :** ${reason.openModal?.enabled ? 'مفعل' : 'غير مفعل'}`,
              `**العنوان :** ${formatSettingValue(reason.openModal?.title)}`,
              `**الوصف :** ${formatSettingValue(reason.openModal?.description)}`,
              `**ترتيب الحقول :** ${modalOrderText}`
            ].join('\n').slice(0, 1024),
            inline: false
          }
        );

      await setupMessage.edit({
        embeds: [normalizeEmbedForStandardMessage(state, '**اختر العنصر المطلوب تعديله لهذا السبب، أو انهاء للرجوع.**')],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_reason_menu_${message.author.id}_${Date.now()}`)
            .setPlaceholder('Reason Settings')
            .addOptions([
              { label: ' اسم السبب', value: 'r1', description: 'الاسم الذي يظهر للعضو' },
              { label: ' ايموجي السبب', value: 'r10', description: 'ايموجي يظهر مع السبب' },
              { label: ' كاتوقري السبب', value: 'r2', description: 'كاتوقري مخصص لهذا السبب' },
              { label: ' اسم التكت لهذا السبب', value: 'r3', description: 'اسم مخصص بديل الافتراضي' },
              { label: ' وصف السبب', value: 'r4', description: 'يظهر داخل منيو الأسباب' },
              { label: ' رسالة قبل صورة التكت', value: 'r6', description: 'داخل التكت قبل الصورة' },
              { label: ' رسالة بعد صورة التكت', value: 'r7', description: 'داخل التكت بعد الصورة وتحت منيو المسؤوليات' },
              { label: ' صورة الفتح لهذا السبب', value: 'r8', description: 'ترسل عند فتح التكت' },
              { label: ' صورة الاستلام لهذا السبب', value: 'r9', description: 'تظهر في طلبات وإعلانات الاستلام' },   
              { label: ' لون وترتيب زر السبب', value: 'r11', description: 'يعمل فقط إذا كانت طريقة العرض أزرار' },
              { label: ' رولات الإدارة الخاصة بهذا السبب', value: 'r12', description: 'تستبدل الرولات الإدارية العامة لهذا السبب فقط' },
              { label: ' مودال السبب وترتيب حقوله', value: 'r13', description: 'حقول لفتح السبب  ' },
              { label: 'Finish', value: 'finish' }
            ])
        )]
      }).catch((error) => logSilentError('suppressed', error));

      const pick = await setupMessage.awaitMessageComponent({
        filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_reason_menu_'),
        time: 240000
      }).catch(() => null);

      if (!pick) break;
      activePromptInteraction = pick;
      await pick.deferUpdate().catch((error) => logSilentError('suppressed', error));
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
        const v = await ask('**وصف السبب : (0 لاعادة التعيين)**');
        reason.description = v === '0' ? '' : (v || reason.description || '');
        await notifySetupResult('**✅ تم تحديث وصف السبب.**');
      }
      if (c === 'r6') {
        const v = await ask('**رسالة قبل الصورة : (0 لاعادة التعيين)**');
        reason.beforeImage = v === '0' ? '' : (v || reason.beforeImage);
        await notifySetupResult('**✅ تم تحديث رسالة ما قبل الصورة.**');
      }
      if (c === 'r7') {
        const v = await ask('**رسالة بعد الصورة : (0 لاعادة التعيين)**');
        reason.afterImage = v === '0' ? '' : (v || reason.afterImage);
        await notifySetupResult('**✅ تم تحديث رسالة ما بعد الصورة.**');
      }
      if (c === 'r8') {
        reason.openImage = await promptAndStoreImage({
          prompt: '**صورة فتح السبب: ارسل رابط صورة او ارفق صورة (0 للحذف)**',
          currentValue: reason.openImage,
          slotKey: `reason_${key}_open`,
          failureText: '**❌ فشل حفظ صورة فتح السبب.**'
        });
      }
      if (c === 'r9') {
        reason.claimImage = await promptAndStoreImage({
          prompt: '**صورة استلام السبب: ارسل رابط صورة او ارفق صورة (0 للحذف)**',
          currentValue: reason.claimImage,
          slotKey: `reason_${key}_claim`,
          failureText: '**❌ فشل حفظ صورة استلام السبب.**'
        });
      }
      if (c === 'r10') {
        const emo = await ask('**ايموجي السبب : (0 لاعادة التعيين)**');
        reason.emoji = emo === '0' ? '🎫' : (emo || reason.emoji);
        await notifySetupResult('**✅ تم تحديث ايموجي السبب.**');
      }
      if (c === 'r11') {
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
      if (c === 'r12') {
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
      if (c === 'r13') {
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

          const labelsRaw = await ask('**حقول المودال بالترتيب من الأهم للأقل (افصل بينهم |) مثال: اسم القروب؟|اي دي الاونر؟|عدد القروب؟**');
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
        .setTitle('**Messages Settings**')
        .setDescription('**كل خيار يوضح مكان ظهور الرسالة داخل نظام التكت.**')
        .addFields(
          {
            name: ' رسالة قبل صورة التكت',
            value: `**المكان :** داخل التكت قبل صورة فتح التكت\n**القيمة الحالية :** ${formatSettingValue(config.messages.beforeImage)}`,
            inline: false
          },
          {
            name: ' رسالة بعد صورة التكت',
            value: `**المكان :** داخل شات التكت بعد صورة فتح التكت\n**القيمة الحالية :** ${formatSettingValue(config.messages.afterImage)}`,
            inline: false
          }
        );

      await setupMessage.edit({
        embeds: [normalizeEmbedForStandardMessage(state, '**اختر من قائمة اعدادات الرسائل، او انهاء للرجوع.**')],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_msg_menu_${message.author.id}_${Date.now()}`)
            .setPlaceholder('اختر اعداد الرسائل')
            .addOptions([
              { label: 'رسالة قبل الصورة - شات التكت', description: 'تظهر قبل صورة فتح التكت', value: 'm2' },
              { label: 'رسالة بعد الصورة - شات التكت', description: 'تظهر بعد صورة فتح التكت', value: 'm3' },
              { label: 'Finish', value: 'finish' }
            ])
        )]
      }).catch((error) => logSilentError('suppressed', error));

      const pick = await setupMessage.awaitMessageComponent({
        filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_msg_menu_'),
        time: 180000
      }).catch(() => null);

      if (!pick) break;
      activePromptInteraction = pick;
      await pick.deferUpdate().catch((error) => logSilentError('suppressed', error));
      const c = pick.values?.[0];
      if (c === 'finish') { done = true; break; }

      if (c === 'm2') {
        const v = await ask('**رسالة قبل صورة التكت (داخل شات التكت) : (0 لاعادة التعيين)**');
        config.messages.beforeImage = v === '0' ? '' : (v || '');
        await activePromptInteraction?.followUp(buildTicketMessagePayload('تم', '**✅ تم تحديث رسالة ما قبل الصورة.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
      }
      if (c === 'm3') {
        const v = await ask('**رسالة بعد صورة التكت (داخل شات التكت) : (0 لاعادة التعيين)**');
        config.messages.afterImage = v === '0' ? '' : (v || '');
        await activePromptInteraction?.followUp(buildTicketMessagePayload('تم', '**✅ تم تحديث رسالة ما بعد الصورة.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
      }
    }
  };


  const openImagesSubmenu = async () => {
    let done = false;
    while (!done) {
      const state = colorManager.createEmbed()
        .setTitle('**Pic Settings**')
        .setDescription('**رفع الصورة :** ارسال رابط مباشر للصورة ولا ترفق الصوره ارسل رابط.')
        .addFields(
          {
            name: 'صورة التكت العامة',
            value: `**المكان :** داخل شات التكت عند الفتح\n**القيمة الحالية :** ${formatSettingValue(config.messages.ticketImage)}`,
            inline: false
          },
          {
            name: 'صورة الاستلام العامة',
            value: `**المكان :** صورة القبول/شات الاستلام المخصص\n**القيمة الحالية :** ${formatSettingValue(config.messages.claimImage || config.messages.ticketImage)}`,
            inline: false
          },
          {
            name: 'صور الاسباب',
            value: '**المكان :** لكل سبب على حده).',
            inline: false
          }
        );

      await setupMessage.edit({
        embeds: [normalizeEmbedForStandardMessage(state, '**اختر اعداد الصور، او انهاء للرجوع.**')],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_img_menu_${message.author.id}_${Date.now()}`)
            .setPlaceholder('اختر اعداد الصور')
            .addOptions([
              { label: ' صورة التكت العامة', description: 'تظهر داخل شات التكت', value: 'i1' },
              { label: ' صورة الاستلام العامة', description: 'تظهر في طلبات وإعلانات الاستلام', value: 'i2' },
              { label: ' صور السبب', description: 'لكل سبب: فتح + استلام', value: 'i3' },
              { label: 'Finish', value: 'finish' }
            ])
        )]
      }).catch((error) => logSilentError('suppressed', error));

      const pick = await setupMessage.awaitMessageComponent({
        filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_img_menu_'),
        time: 240000
      }).catch(() => null);

      if (!pick) break;
      activePromptInteraction = pick;
      await pick.deferUpdate().catch((error) => logSilentError('suppressed', error));
      const c = pick.values?.[0];
      if (c === 'finish') { done = true; break; }

      if (c === 'i1') {
        config.messages.ticketImage = await promptAndStoreImage({
          prompt: '**صورة التكت العامة : ارسل رابط صورة او ارفق صورة (0 للحذف)**',
          currentValue: config.messages.ticketImage,
          slotKey: 'global_ticket_image',
          failureText: '**❌ فشل حفظ الصورة العامة.**'
        });
      }

      if (c === 'i2') {
        config.messages.claimImage = await promptAndStoreImage({
          prompt: '**صورة الاستلام العامة: ارسل رابط صورة او ارفق صورة (0 للحذف)**',
          currentValue: config.messages.claimImage,
          slotKey: 'global_claim_image',
          failureText: '**❌ فشل حفظ صورة الاستلام العامة.**'
        });
      }

      if (c === 'i3') {
        await setupMessage.edit({
          embeds: [normalizeEmbedForStandardMessage(colorManager.createEmbed().setTitle('**فهرس الأسباب (1 - 25)**').setDescription(buildReasonsIndexText()), '**اختر رقم السبب من القائمة التالية ثم اكتب الرقم في الشات.**')]
        }).catch((error) => logSilentError('suppressed', error));

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
          embeds: [normalizeEmbedForStandardMessage(
            colorManager.createEmbed().setTitle(`**صور السبب ${idx}**`).setDescription([
              `**صورة الفتح (داخل شات التكت عند الانشاء):** ${formatSettingValue(reason.openImage)}`,
              `**صورة الاستلام (في طلبات وإعلانات الاستلام):** ${formatSettingValue(reason.claimImage)}`
            ].join('\n')),
            '**اختر نوع الصورة لهذا السبب.**'
          )],
          components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`ticket_img_reason_menu_${message.author.id}_${Date.now()}`)
              .setPlaceholder('اختر الصورة')
              .addOptions([
                { label: 'صورة الفتح', value: 'open' },
                { label: 'صورة الاستلام/القبول', value: 'claim' },
                { label: 'Finish', value: 'finish' }
              ])
          )]
        }).catch((error) => logSilentError('suppressed', error));

        const reasonPick = await setupMessage.awaitMessageComponent({
          filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_img_reason_menu_'),
          time: 180000
        }).catch(() => null);
        if (!reasonPick) continue;
        activePromptInteraction = reasonPick;
        await reasonPick.deferUpdate().catch((error) => logSilentError('suppressed', error));
        const rc = reasonPick.values?.[0];
        if (rc === 'finish') continue;

        if (rc === 'open') {
          reason.openImage = await promptAndStoreImage({
            prompt: '**صورة فتح السبب : ارسل رابط صورة او ارفق صورة (0 للحذف)**',
            currentValue: reason.openImage,
            slotKey: `reason_${key}_open`,
            failureText: '**❌ فشل حفظ صورة السبب.**'
          });
        }
        if (rc === 'claim') {
          reason.claimImage = await promptAndStoreImage({
            prompt: '**صورة استلام السبب : ارسل رابط صورة او ارفق صورة (0 للحذف)**',
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
          `**الوضع الحالي :** ${config.displayMode}`,
          `**عدد صفوف الازرار :** ${config.buttonRows || 2}`,
          '**في وضع المنيو يمكنك استخدام وصف السبب لكل سبب ليظهر تحت الاسم.**'
        ].join('\n'));

      await setupMessage.edit({
        embeds: [normalizeEmbedForStandardMessage(state, '**اختر طريقة العرض او انهاء للرجوع.**')],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_display_menu_${message.author.id}_${Date.now()}`)
            .setPlaceholder('اختر طريقة العرض')
            .addOptions([
              { label: 'استخدام الازرار', value: 'buttons' },
              { label: 'استخدام المنيو', value: 'menu' },
              { label: 'تعديل صفوف الازرار', value: 'rows' },
              { label: 'Finish', value: 'finish' }
            ])
        )]
      }).catch((error) => logSilentError('suppressed', error));

      const pick = await setupMessage.awaitMessageComponent({
        filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_display_menu_'),
        time: 180000
      }).catch(() => null);

      if (!pick) break;
      activePromptInteraction = pick;
      await pick.deferUpdate().catch((error) => logSilentError('suppressed', error));
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

  const openFeedbackSubmenu = async () => {
    if (!config.feedback || typeof config.feedback !== 'object') {
      config.feedback = baseConfig().feedback;
    }
    let done = false;
    while (!done) {
      const feedbackCfg = config.feedback;
      const style = feedbackCfg.style || {};
      const state = colorManager.createEmbed()
        .setTitle('**إعدادات التقييم**')
        .setDescription('**خصص نظام التقييم، الروم، الكلمة، الفاصل، والألوان.**')
        .addFields(
          { name: 'الحالة', value: feedbackCfg.enabled ? 'مفعل ✅' : 'مقفل ❌', inline: true },
          { name: 'روم التقييم', value: feedbackCfg.channelId ? `<#${feedbackCfg.channelId}>` : 'غير معين', inline: true },
          { name: 'مكان زر التقييم', value: feedbackCfg.triggerScope === 'ticket' ? 'داخل التكت' : 'الخاص', inline: true },
          { name: 'كلمة التقييم', value: formatSettingValue(feedbackCfg.triggerWord), inline: false },
          { name: 'الفاصل', value: feedbackCfg.separatorEnabled ? `مفعل • نص: ${formatSettingValue(feedbackCfg.separatorText)}\nصورة: ${formatSettingValue(feedbackCfg.separatorImage)}` : 'مقفل', inline: false },
          { name: 'ألوان التصميم', value: `الخلفية: ${style.background}\nبداية الكرت: ${style.cardStart}\nنهاية الكرت: ${style.cardEnd}\nلون النص: ${style.text}\nاللون الثانوي: ${style.accent}\nحدود الكرت: ${style.border}\nلون الاقتباس: ${style.quote}\nلون النجوم: ${style.star}\nلون الاسم: ${style.name}\nلون الظل: ${style.shadow}`, inline: false }
        );

      await setupMessage.edit({
        embeds: [normalizeEmbedForStandardMessage(state, '**اختر تعديل من القائمة.**')],
        components: [new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_feedback_menu_${message.author.id}_${Date.now()}`)
            .setPlaceholder('Feedback Settings')
            .addOptions([
              { label: 'تفعيل/ايقاف', value: 'toggle' },
              { label: 'روم التقييم', value: 'channel' },
              { label: 'كلمة التقييم', value: 'word' },
              { label: 'مكان الطلب (خاص/تكت)', value: 'scope' },
              { label: 'الفاصل بين التقييمات', value: 'separator' },
              { label: 'ألوان التصميم', value: 'style' },
              { label: 'مطابقة تلقائية مع السيرفر', value: 'style_auto' },
              { label: 'إعادة الألوان الافتراضية', value: 'style_reset' },
              { label: 'Finish', value: 'finish' }
            ])
        )]
      }).catch((error) => logSilentError('suppressed', error));

      const pick = await setupMessage.awaitMessageComponent({
        filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_feedback_menu_'),
        time: 180000
      }).catch(() => null);
      if (!pick) break;
      activePromptInteraction = pick;
      await pick.deferUpdate().catch((error) => logSilentError('suppressed', error));
      const c = pick.values?.[0];
      if (c === 'finish') { done = true; break; }
      if (c === 'toggle') feedbackCfg.enabled = !feedbackCfg.enabled;
      if (c === 'channel') {
        const raw = await ask('**ارسل منشن/ايدي روم التقييم (0 لاعادة التعيين)**');
        if (raw === '0') feedbackCfg.channelId = null;
        else feedbackCfg.channelId = normalizeId(raw);
      }
      if (c === 'word') {
        const raw = await ask('**اكتب كلمة/رسالة طلب التقييم (0 لاعادة التعيين)**');
        feedbackCfg.triggerWord = raw === '0' ? baseConfig().feedback.triggerWord : (raw || feedbackCfg.triggerWord);
      }
      if (c === 'scope') {
        const raw = ((await ask('**مكان الزر: dm أو ticket**')) || '').toLowerCase();
        if (raw === 'dm' || raw === 'ticket') feedbackCfg.triggerScope = raw;
      }
      if (c === 'separator') {
        const enabled = ((await ask('**تفعيل الفاصل؟ yes/no**')) || '').toLowerCase();
        feedbackCfg.separatorEnabled = ['yes', 'y', 'نعم'].includes(enabled);
        if (feedbackCfg.separatorEnabled) {
          const text = await ask('**نص الفاصل (0 للإفتراضي)**');
          feedbackCfg.separatorText = text === '0' ? baseConfig().feedback.separatorText : (text || feedbackCfg.separatorText);
          feedbackCfg.separatorImage = await promptAndStoreImage({
            prompt: '**صورة الفاصل: ارسل رابط مباشر/ارفق صورة (0 للحذف)**',
            currentValue: feedbackCfg.separatorImage,
            slotKey: `feedback_separator_${message.guild.id}`,
            failureText: '**❌ فشل حفظ صورة الفاصل.**'
          });
        }
      }
      if (c === 'style_reset') {
        feedbackCfg.style = { ...(baseConfig().feedback.style || {}), version: 'v6' };
      }
      if (c === 'style_auto') {
        feedbackCfg.style = await generateAutoFeedbackStyle(message.guild, feedbackCfg.style || {});
      }
      if (c === 'style') {
        feedbackCfg.style.version = 'v6';
        const styleMenu = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`ticket_feedback_style_field_${message.author.id}_${Date.now()}`)
            .setPlaceholder('اختر العنصر الذي تريد تعديله')
            .addOptions([
              { label: 'الخلفية', value: 'background' },
              { label: 'بداية الكرت', value: 'cardStart' },
              { label: 'نهاية الكرت', value: 'cardEnd' },
              { label: 'لون النص', value: 'text' },
              { label: 'اللون الثانوي', value: 'accent' },
              { label: 'حدود الكرت', value: 'border' },
              { label: 'لون الاقتباس', value: 'quote' },
              { label: 'لون النجوم', value: 'star' },
              { label: 'لون الاسم', value: 'name' },
              { label: 'لون الظل', value: 'shadow' },
              { label: 'إعادة الافتراضي', value: 'reset' }
            ])
        );

        const styleMsg = await message.channel.send({ content: '**اختر من القائمة لون واحد للتعديل (أو إعادة الافتراضي).**', components: [styleMenu] }).catch(() => null);
        if (styleMsg) {
          const stylePick = await styleMsg.awaitMessageComponent({
            filter: (i) => i.user.id === message.author.id && i.isStringSelectMenu() && i.customId.startsWith('ticket_feedback_style_field_'),
            time: 120000
          }).catch(() => null);

          if (stylePick) {
            await stylePick.deferUpdate().catch((error) => logSilentError('suppressed', error));
            const key = stylePick.values?.[0];
            if (key === 'reset') {
              feedbackCfg.style = { ...(baseConfig().feedback.style || {}), version: 'v6' };
            } else if (key && ['background', 'cardStart', 'cardEnd', 'text', 'accent', 'border', 'quote', 'star', 'name', 'shadow'].includes(key)) {
              const current = feedbackCfg.style[key];
              const rawColor = await ask(`**اكتب اللون الجديد Hex للحقل (${key}) - الحالي: ${current}**`);
              const normalizedInput = String(rawColor || '').trim();
              const isValidHex = /^#?[0-9a-fA-F]{6}$/.test(normalizedInput);
              if (!isValidHex) {
                await message.channel.send('**❌ تنسيق اللون غير صحيح. استخدم Hex مثل: #7A5AF8**')
                  .then((m) => setTimeout(() => m.delete().catch(() => {}), 7000))
                  .catch(() => {});
              } else {
                feedbackCfg.style[key] = normalizeHexColor(normalizedInput, current);
              }
            }
          }
          await styleMsg.delete().catch(() => {});
        }
      }
    }
  };

  collector.on('collect', async (interaction) => {
    try {
      const choice = interaction.customId === `ticket_setup_feedback_btn_${message.author.id}`
        ? 'set_feedback'
        : interaction.values?.[0];
      if (!choice) return;

      activePromptInteraction = interaction;
      await interaction.deferUpdate().catch((error) => logSilentError('suppressed', error));

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
          await refresh('**❌ فشل تحديث كاتوقري الفتح : أرسل منشن أو آيدي كاتوقري صحيح.**');
          await notifySetupResult('**❌ فشل تحديث كاتوقري الفتح : أرسل منشن أو آيدي كاتوقري صحيح.**');
          return;
        }

        config.openCategoryId = catId;
        await refresh('**✅ تم تحديث كاتوقري الفتح.**');
        await notifySetupResult('**✅ تم تحديث كاتوقري الفتح بنجاح.**');
        return;
      }

      if (choice === 'set_responsibles') {
        const v = await ask([
          '**تحديد المسؤولين - اختر طريقة واحدة :**',
          '**0 = رولات الادمن العامة**',
          '**اسم مسؤولية = مسؤولية معينة** (مثال : مسؤولية الدعم / المسؤولية الدعم)',
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
          await refresh('**❌ فشل تحديث حد فتح العضو : أدخل رقمًا أكبر من 0.**');
          await notifySetupResult('**❌ فشل تحديث حد فتح العضو : أدخل رقمًا أكبر من 0.**');
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
        }
        await refresh(`**✅ تم التحديث : ${config.claimFromDedicatedChannel ? 'مفعل' : 'مقفل'}**`);
        await notifySetupResult(`**✅ حالة شات الاستلام المخصص : ${config.claimFromDedicatedChannel ? 'مفعل' : 'مقفل'}.**`);
        return;
      }

      if (choice === 'toggle_keep_closed') {
        config.keepClosedTickets = !config.keepClosedTickets;
        if (config.keepClosedTickets) {
          const v = await ask('**ارسل : كاتوقري المقفلة (0 للبقاء بنفس المكان)**');
          config.closedCategoryId = v === '0' ? null : normalizeId(v);
        }
        await refresh(`**✅ تم التحديث : ${config.keepClosedTickets ? 'مفعل' : 'مقفل'}**`);
        await notifySetupResult(`**✅ حالة الاحتفاظ بالتكت بعد الإغلاق : ${config.keepClosedTickets ? 'مفعل' : 'مقفل'}.**`);
        return;
      }

      if (choice === 'set_messages') {
        await openMessagesSubmenu();
        await refresh('**✅ تم تحديث اعدادات الرسائل.**');
        await notifySetupResult('**✅ تم حفظ إعدادات الرسائل بنجاح.**');
        return;
      }

      if (choice === 'set_feedback') {
        await openFeedbackSubmenu();
        await refresh('**✅ تم تحديث اعدادات التقييم.**');
        await notifySetupResult('**✅ تم حفظ إعدادات التقييم بنجاح.**');
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
          useCustomAdminRoles: false,
          adminRoleIds: [],
          description: '',
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

        const previousPanelMessage = config.panelMessageId
          ? await panelChannel.messages.fetch(config.panelMessageId).catch(() => null)
          : null;

        if (mode === 'image' || mode === 'both') {
          if (!imageInput || imageInput === '0') {
            await refresh('**❌ تم إلغاء ارسال البانل : وضع الصورة يتطلب صورة صالحة.**');
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

          if (previousPanelMessage?.editable) {
            await previousPanelMessage.edit({ ...payload, files: [panelImage] }).catch((error) => logSilentError('suppressed', error));
          } else {
            const sentPanelMessage = await panelChannel.send({ ...payload, files: [panelImage] }).catch(() => null);
            if (sentPanelMessage) config.panelMessageId = sentPanelMessage.id;
          }
          removeStoredImage(storedPanelImage);
        } else {
          if (previousPanelMessage?.editable) {
            await previousPanelMessage.edit(payload).catch((error) => logSilentError('suppressed', error));
          } else {
            const sentPanelMessage = await panelChannel.send(payload).catch(() => null);
            if (sentPanelMessage) config.panelMessageId = sentPanelMessage.id;
          }
        }

        if (previousPanelMessage?.id) config.panelMessageId = previousPanelMessage.id;

        await refresh(`**✅ تم ارسال بانل التكت بنجاح في <#${panelId}>.**`);
        return;
      }

      if (choice === 'toggle_delete_claim_msg') {
        config.deleteClaimMessageOnClaim = !config.deleteClaimMessageOnClaim;
        await refresh(`**✅ تم التحديث : ${config.deleteClaimMessageOnClaim ? 'مفعل' : 'مقفل'}**`);
        await notifySetupResult(`**✅ حالة حذف رسالة الاستلام بعد التنفيذ : ${config.deleteClaimMessageOnClaim ? 'مفعل' : 'مقفل'}.**`);
        return;
      }

      if (choice === 'toggle_auto_close') {
        config.autoCloseEnabled = !config.autoCloseEnabled;
        if (config.autoCloseEnabled) {
          const hours = Number(await ask('**ارسل مدة الإغلاق التلقائي بالساعات (مثال: 24 أو 12**'));
          if (!Number.isFinite(hours) || hours <= 0) {
            config.autoCloseEnabled = false;
            await refresh('**❌ فشل التفعيل : أدخل مدة صحيحة بالساعات أكبر من 0.**');
            await notifySetupResult('**❌ فشل تفعيل الإغلاق التلقائي بسبب مدة غير صالحة.**');
            return;
          }
          config.autoCloseHours = Math.round(hours * 100) / 100;
        }
        await refresh(`**✅ تم التحديث : ${config.autoCloseEnabled ? `مفعل (${config.autoCloseHours} ساعة)` : 'مقفل'}**`);
        await notifySetupResult(`**✅ حالة الإغلاق التلقائي: ${config.autoCloseEnabled ? `مفعل (${config.autoCloseHours} ساعة)` : 'مقفل'}.**`);
        return;
      }

      if (choice === 'set_log_channel') {
        const v = await ask('**ارسل : منشن/ايدي روم اللوق (0 لاعادة التعيين)**');
        if (v === '0') {
          config.logChannelId = null;
          await refresh('**✅ تم إعادة تعيين روم اللوق.**');
          await notifySetupResult('**✅ تم حذف روم اللوق من الإعدادات.**');
          return;
        }

        const logChannelId = normalizeId(v);
        const logChannel = logChannelId ? await message.guild.channels.fetch(logChannelId).catch(() => null) : null;
        if (!logChannel || !logChannel.isTextBased?.()) {
          await refresh('**❌ روم اللوق غير صالح. أرسل منشن أو آيدي روم نصي صحيح.**');
          await notifySetupResult('**❌ فشل تعيين روم اللوق.**');
          return;
        }

        config.logChannelId = logChannelId;
        await refresh(`**✅ تم تعيين روم اللوق :** <#${logChannelId}>`);
        await notifySetupResult(`**✅ تم تعيين روم اللوق :** <#${logChannelId}>`);
        return;
      }

    } catch {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply(buildTicketMessagePayload('خطأ', '**حدث خطأ اثناء تحديث الاعدادات.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
      }
    }
  });

  collector.on('end', async () => {
    const latestSetupSession = activeTicketSetupSessions.get(setupSessionKey);
    if (!latestSetupSession || latestSetupSession.setupInstanceId !== setupInstanceId) return;
    setGuildData(message.guild.id, config, tickets, pendingRequests, panelId);
    await setupMessage.edit({ embeds: [buildSetupEmbed()], components: [] }).catch((error) => logSilentError('suppressed', error));
    await controlChannel.send(buildTicketMessagePayload('Done✅️', '**تم حفظ اعدادات التكت**')).catch((error) => logSilentError('suppressed', error));
    activeTicketSetupSessions.delete(setupSessionKey);
    deleteRuntimeSession('ticket-setup', setupSessionKey);
  });
}

async function handleTransferResponsibility(interaction, guildId, panelId, channelId, value) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.reply(buildTicketMessagePayload('تحويل', '**يرجى الانتظار...**', { ephemeral: true, user: interaction.user })).catch((error) => logSilentError('suppressed', error));
  }

  if (!value || value === 'resp_none') {
    await interaction.editReply(buildTicketMessagePayload('Error', '**لا توجد مسؤولية صالحة.**')).catch((error) => logSilentError('suppressed', error));
    return;
  }

  let responsibilities = loadResponsibilities();
  const responsibilityNames = Object.keys(responsibilities);
  const responsibilitiesFileExists = fs.existsSync(responsibilitiesPath);

  if (!responsibilitiesFileExists && responsibilityNames.length === 0) {
    responsibilities = await waitForResponsibilitiesRecovery();
  }
  const refreshedNames = Object.keys(responsibilities || {});

  if (refreshedNames.length === 0) {
    const missingHint = responsibilitiesFileExists
      ? '**لا توجد مسؤوليات حاليًا.**'
      : '**ملف responsibilities.json محذوف/فارغ، وحاولت الاسترجاع من الكاش لكن ما لقيت بيانات كافية.**';
    await interaction.editReply(buildTicketMessagePayload('Error', missingHint)).catch((error) => logSilentError('suppressed', error));
    return;
  }

  let respName = null;
  if (value.startsWith('respidx_')) {
    const index = Number(value.replace('respidx_', ''));
    if (Number.isInteger(index) && index >= 0 && index < refreshedNames.length) {
      respName = refreshedNames[index];
    }
  } else if (value.startsWith('resp_')) {
    respName = value.replace('resp_', '');
  }

  if (!respName) {
    await interaction.editReply(buildTicketMessagePayload('Error', '**لا توجد مسؤولية صالحة.**')).catch((error) => logSilentError('suppressed', error));
    return;
  }

  const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId || 'default');
  if (!ticket || interaction.channelId !== actionChannelId) {
    await interaction.editReply(buildTicketMessagePayload('Error', '**لا توجد بيانات لهذا التكت.**')).catch((error) => logSilentError('suppressed', error));
    return;
  }

  if (!canManageTicket(interaction, ticket, config)) {
    await interaction.deleteReply().catch((error) => logSilentError('suppressed', error));
    return;
  }

  const selected = responsibilities[respName];
  if (!selected) {
    await interaction.editReply(buildTicketMessagePayload('Error', '**المسؤولية غير موجودة.**')).catch((error) => logSilentError('suppressed', error));
    return;
  }

  const previousClaimer = ticket.claimedBy || null;
  const previousTransferredUserIds = Array.isArray(ticket.transferredUserIds)
    ? ticket.transferredUserIds.map((id) => String(id || '').trim()).filter((id) => /^\d{16,20}$/.test(id))
    : [];

  // بعد التحويل نبقي المستلم الحالي ومسار النقاط كما هو
  // حتى يظهر اسم المستلم عند الإغلاق وتُحسب النقاط له.
  if (!ticket.pointsReceiverId && previousClaimer) {
    ticket.pointsReceiverId = previousClaimer;
  }
  ticket.transferredTo = respName;

  const targetRoles = (selected.roles || [])
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id) && interaction.guild.roles.cache.has(id));
  const generalResponsibleRoles = (config.responsibleRoleIds || [])
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id) && interaction.guild.roles.cache.has(id));
  const adminRoles = getAdminRoles(config, ticket?.reasonKey);
  const allKnownRoles = [...new Set([...generalResponsibleRoles, ...targetRoles, ...adminRoles])];

  const rolesPermissionTasks = allKnownRoles.map((roleId) => {
    const shouldSee = targetRoles.includes(roleId) || generalResponsibleRoles.includes(roleId);
    return () => editOverwriteFast(interaction.channel, roleId, {
      ViewChannel: shouldSee,
      SendMessages: shouldSee,
      ReadMessageHistory: shouldSee
    });
  });

  ticket.transferredRoleIds = [...targetRoles];
  await syncTicketLogMessage({
    guild: interaction.guild,
    config,
    ticket,
    channelId: actionChannelId,
    actionText: `تم تحويل التكت عن طريق : <@${interaction.user.id}> -> ${respName}`,
    actor: interaction.user
  });
  setGuildData(guildId, config, tickets, pendingRequests, resolvedPanelId);

  const responsibleUsers = (selected.responsibles || [])
    .map((id) => String(id || '').trim())
    .filter((id) => /^\d{16,20}$/.test(id));
  const existingResponsibleUsers = [...new Set(responsibleUsers)];
  const shouldGrantIndividualTransferUsers = true;

  const usersPermissionTasks = [...new Set([...previousTransferredUserIds, ...existingResponsibleUsers])].map((userId) => {
    const shouldSee = shouldGrantIndividualTransferUsers && existingResponsibleUsers.includes(userId);
    return () => editOverwriteFast(interaction.channel, userId, {
      ViewChannel: shouldSee,
      SendMessages: shouldSee,
      ReadMessageHistory: true
    });
  });

  const mentions = [
    ...targetRoles.map((id) => `<@&${id}>`),
    ...existingResponsibleUsers.map((id) => `<@${id}>`)
  ];

  const onlineResponsibleMentions = existingResponsibleUsers
    .filter((uid) => {
      const member = interaction.guild.members.cache.get(uid);
      const presence = member?.presence?.status;
      return presence && presence !== 'offline';
    })
    .map((uid) => `<@${uid}>`);

  const previousClaimerHideTasks = previousClaimer
    ? [() => editOverwriteFast(interaction.channel, previousClaimer, { ViewChannel: false, SendMessages: false })]
    : [];
  ticket.transferredUserIds = [...existingResponsibleUsers];
  const dmEmbed = makeTicketEmbed(
    'Ticket Change',
    [
      `يوجد تكت تم تحويله لمسؤوليتكم في <#${actionChannelId}>`,
      `**الاداري الذي حول :** <@${interaction.user.id}>`
    ].join('\n')
  ).setThumbnail(interaction.user.displayAvatarURL({ dynamic: true, size: 256 }));
  if (!Array.isArray(ticket.transferDmNotifications)) ticket.transferDmNotifications = [];

  const renamed = `مسؤولين-${sanitizeName(respName)}`.slice(0, 90);
  const transferUiTasks = [() => interaction.channel.setName(renamed)];
  if (interaction.message?.editable) {
    transferUiTasks.push(async () => {
      const refreshedControls = await buildTicketControls(guildId, resolvedPanelId, actionChannelId, config, {
        includeClaimButton: false,
        disableClaimButton: true,
        hideReassignButton: true
      });
      await interaction.message.edit({ components: refreshedControls });
    });
  }

  await runTransferParallelPipeline({
    permissions: [...rolesPermissionTasks, ...usersPermissionTasks, ...previousClaimerHideTasks],
    ui: transferUiTasks,
    feedback: [
      () => interaction.channel.send({
        content: mentions.join(' ') || undefined,
        ...buildTicketMessagePayload('Changed', `**تم تحويل التكت لمسؤولين : ${respName}**\n**المتصلون الآن :** ${onlineResponsibleMentions.join(' ') || 'N/A'}\n**الرولات :** ${targetRoles.map((id) => `<@&${id}>`).join(' ') || 'N/A'}`, { user: interaction.user })
      }).catch((error) => logSilentError('suppressed', error)),
      () => interaction.editReply(buildTicketMessagePayload('Changed', '**تم التحويل بنجاح.**', { ephemeral: true, user: interaction.user })).catch((error) => logSilentError('suppressed', error))
    ]
  }, 'transfer.parallel');

  Promise.allSettled(
    existingResponsibleUsers.map(async (uid) => {
      const user = await interaction.client.users.fetch(uid).catch(() => null);
      if (!user) return null;
      const sentDm = await user.send({ embeds: [dmEmbed] }).catch(() => null);
      if (!sentDm) return null;
      return {
        userId: uid,
        messageId: sentDm.id,
        transferredById: interaction.user.id
      };
    })
  ).then((dmResults) => {
    for (const item of dmResults) {
      if (item.status === 'fulfilled' && item.value) {
        ticket.transferDmNotifications.push(item.value);
      }
    }
    setGuildData(guildId, config, tickets, pendingRequests, resolvedPanelId);
  }).catch((error) => logSilentError('transfer.dm.notifications', error));
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

async function showResponsibilitySearchModal(interaction, guildId, panelId, channelId) {
  const modal = new ModalBuilder()
    .setCustomId(`ticket_transfer_search_modal_${guildId}_${panelId}_${channelId}`)
    .setTitle('بحث المسؤولية');

  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel('اسم المسؤولية')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder('اكتب اسم المسؤولية أو جزء منه')
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

function registerTicketMessageActivityTracker(client) {
  if (client.__ticketMessageActivityTrackerRegistered) return;
  client.__ticketMessageActivityTrackerRegistered = true;

  client.on('messageCreate', async (message) => {
    if (!message.guild || !message.channel || message.author?.bot) return;
    const guildId = message.guild.id;
    const channelId = message.channel.id;
    const { config: defaultPanelConfig } = getPanelData(guildId, 'default');
    const feedbackCfg = defaultPanelConfig?.feedback || baseConfig().feedback;
    if (feedbackCfg.enabled && feedbackCfg.channelId && channelId === feedbackCfg.channelId) {
      const rawText = String(message.content || '').trim();
      const trigger = String(feedbackCfg.triggerWord || '').trim();
      if (!trigger || rawText.startsWith(trigger) || rawText.length > 0) {
        const starsMatch = rawText.match(/\b([1-5])\b/);
        const stars = parseStars(starsMatch?.[1] || '5') || 5;
        const comment = rawText.replace(/\b([1-5])\b/, '').replace(trigger, '').trim() || 'بدون تعليق';
        await message.delete().catch((error) => logSilentError('suppressed', error));
        const member = await resolveGuildMember(message.guild, message.author.id);
        const image = await buildFeedbackCardImage({ guild: message.guild, member, stars, comment, style: feedbackCfg.style || {} });
        const attachment = new AttachmentBuilder(image, { name: `feedback_${message.author.id}_${Date.now()}.png` });
        await message.channel.send({ files: [attachment] }).catch((error) => logSilentError('suppressed', error));
        await sendFeedbackSeparator(message.channel, feedbackCfg);
        return;
      }
    }
    const { panelId, config, tickets, pendingRequests, ticket } = getTicketContext(guildId, channelId, 'default');
    if (!ticket) return;

    if (!canUserWriteInTicket(message, ticket, config)) {
      rememberDeletedTicketMessage(ticket, message);
      await message.delete().catch((error) => logSilentError('suppressed', error));
      await recordUnauthorizedTicketMessage(message, ticket, config);
      setGuildData(guildId, config, tickets, pendingRequests, panelId);
      return;
    }

    const feedbackConfig = config?.feedback || baseConfig().feedback;
    const triggerWord = String(feedbackConfig.triggerWord || '').trim();
    if (feedbackConfig.enabled && triggerWord && String(message.content || '').trim().toLowerCase() === triggerWord.toLowerCase()) {
      const isBotOwner = botOwnersCache.has(message.author.id);
      const isServerOwner = message.guild.ownerId === message.author.id;
      const isTicketClaimer = ticket?.claimedBy === message.author.id;
      const isSystemResponsible = hasStaffAccess(message.member, config, ticket?.reasonKey, ticket);
      if (!isBotOwner && !isServerOwner && !isTicketClaimer && !isSystemResponsible) {
        await message.delete().catch((error) => logSilentError('suppressed', error));
        return;
      }
      await message.delete().catch((error) => logSilentError('suppressed', error));
      await sendFeedbackPrompt({
        guild: message.guild,
        channel: message.channel,
        ticket: { memberId: message.author.id },
        config: { ...config, feedback: feedbackConfig },
        panelId,
        channelId
      });
      if (feedbackConfig.triggerScope === 'dm') {
        await message.channel.send(buildTicketMessagePayload('التقييم', `**تم إرسال رسالة التقييم بالخاص لـ <@${message.author.id}>.**`))
          .then((m) => setTimeout(() => m.delete().catch((error) => logSilentError('suppressed', error)), 12000))
          .catch((error) => logSilentError('suppressed', error));
      }
      return;
    }

    if (ticket.status !== 'open') return;
    if (touchTicketActivity(ticket, message.createdTimestamp || Date.now())) {
      setGuildData(guildId, config, tickets, pendingRequests, panelId);
    }
  });

  client.on('messageDelete', async (message) => {
    if (!message?.guild || !message.channel) return;
    const guildId = message.guild.id;
    const channelId = message.channel.id;
    const { panelId, config, tickets, pendingRequests, ticket } = getTicketContext(guildId, channelId, 'default');
    let changed = false;
    if (ticket && rememberDeletedTicketMessage(ticket, message)) {
      changed = true;
    }
    if (changed) {
      setGuildData(guildId, config, tickets, pendingRequests, panelId);
    }
    removeClaimMessageRefFromGuildPanels(guildId, channelId, message.id);
  });

  client.on('messageDeleteBulk', async (messages) => {
    const first = messages?.first?.();
    if (!first?.guild || !first.channel) return;
    const guildId = first.guild.id;
    const channelId = first.channel.id;
    const { panelId, config, tickets, pendingRequests, ticket } = getTicketContext(guildId, channelId, 'default');
    let changed = false;
    for (const message of messages.values()) {
      if (ticket) {
        changed = rememberDeletedTicketMessage(ticket, message) || changed;
      }
    }
    if (changed) {
      setGuildData(guildId, config, tickets, pendingRequests, panelId);
    }
    for (const message of messages.values()) {
      removeClaimMessageRefFromGuildPanels(guildId, channelId, message.id);
    }
  });
}

function startTicketAutoCloseWatcher(client) {
  if (client.__ticketAutoCloseWatcherStarted) return;
  client.__ticketAutoCloseWatcherStarted = true;

  const runCheck = async () => {
    const store = loadStore();

    for (const [guildId, guildData] of Object.entries(store || {})) {
      const panels = guildData?.panels || {};
      for (const [panelId, panel] of Object.entries(panels)) {
        const { config, tickets, pendingRequests } = getPanelData(guildId, panelId);
        const timeoutMs = getTicketAutoCloseMs(config);
        if (!timeoutMs) continue;
        const warningMs = Math.max(1, Number(config.autoCloseWarningMinutes || 10)) * 60 * 1000;

        let changed = false;
        if (prunePendingRequests(pendingRequests, config)) {
          changed = true;
        }
        for (const [channelId, ticket] of Object.entries(tickets || {})) {
          if (!ticket || ticket.status !== 'open') continue;
          const dueAt = getTicketDueAt(ticket, config);
          if (!dueAt) continue;

          const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          if (!guild) continue;
          const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
          if (!channel || channel.type !== ChannelType.GuildText) continue;

          const now = Date.now();
          if (ticket.logSyncFailedAt && channel) {
            await syncTicketLogMessage({
              guild,
              config,
              ticket,
              channelId,
              actionText: {
                type: 'log_retry',
                message: 'إعادة مزامنة سجل التكت بعد فشل سابق'
              }
            }).catch((error) => logSilentError('suppressed', error));
          }
          if (now >= dueAt) {
            await closeTicketCore({
              channel,
              guildId,
              panelId,
              channelId,
              config,
              tickets,
              pendingRequests,
              ticket,
              autoClose: true,
              closedByLabel: 'خمول التكت'
            });
            changed = true;
            continue;
          }

          if ((dueAt - now) <= warningMs && !ticket.autoCloseWarningSentAt) {
            await sendAutoCloseWarning(channel, ticket, dueAt);
            ticket.autoCloseWarningSentAt = now;
            changed = true;
          }
        }

        if (changed) {
          setGuildData(guildId, config, tickets, pendingRequests, panelId);
        }
      }
    }
  };

  runCheck().catch((error) => logSilentError('suppressed', error));
  client.__ticketAutoCloseWatcherInterval = setInterval(() => {
    runCheck().catch((error) => logSilentError('suppressed', error));
  }, 60 * 1000);
}

function registerHandlers(client) {
  if (handlersRegistered) return;
  handlersRegistered = true;
  registerTicketMessageActivityTracker(client);
  startTicketAutoCloseWatcher(client);

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
        if (interaction.guild && interaction.member && id.startsWith('ticket_') && resolveTicketBlockForMember(interaction.guild.id, interaction.member)) {
          await interaction.reply(buildTicketMessagePayload('Ticket Block', '**عندك بلوك تكت شوف الخاص لتعرف المدة.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
          return;
        }

        if (id.startsWith('ticket_open_btn_')) {
          const parts = id.split('_');
          const guildId = parts[3];
          const payloadParts = parts.slice(4);
          const panelId = payloadParts.length > 1 ? payloadParts.slice(0, -1).join('_') : 'default';
          const reasonKey = payloadParts.length ? payloadParts[payloadParts.length - 1] : parts[4];
          await handleOpenWithReasonModal(interaction, guildId, panelId, reasonKey, client);
          return;
        }

        if (id.startsWith('ticket_feedback_open_')) {
          const token = id.replace('ticket_feedback_open_', '');
          let session = ticketFeedbackSessions.get(token);
          if (!session) session = await loadRuntimeSession('ticket-feedback', token).catch(() => null);
          if (!session || (session.expiresAt && Date.now() > session.expiresAt)) {
            await interaction.reply(buildTicketMessagePayload('التقييم', '**انتهت صلاحية رابط التقييم.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
            return;
          }
          if (interaction.user.id !== session.memberId) {
            await interaction.reply(buildTicketMessagePayload('التقييم', '**هذا الزر مخصص لصاحب التكت فقط.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
            return;
          }

          const modal = new ModalBuilder()
            .setCustomId(`ticket_feedback_modal_${token}`)
            .setTitle('تقييم الخدمة');
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('stars')
                .setLabel('عدد النجوم (1-5)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(1)
                .setPlaceholder('5')
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('review')
                .setLabel('رأيك بالخدمة')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(300)
            )
          );
          await interaction.showModal(modal);
          return;
        }

        if (interaction.isStringSelectMenu() && id.startsWith('ticket_open_menu_')) {
          const raw = id.replace('ticket_open_menu_', '');
          const rawParts = raw.split('_');
          const guildId = rawParts[0];
          const panelId = rawParts.length > 1 ? rawParts.slice(1).join('_') : 'default';
          const value = interaction.values?.[0] || 'reason_0';
          const reasonKey = value.replace('reason_', '');
          await handleOpenWithReasonModal(interaction, guildId, panelId, reasonKey, client);
          const { config } = getPanelData(guildId, panelId || 'default');
          if (interaction.message?.editable) {
            await interaction.message.edit({ components: createReasonComponents(config, guildId, panelId || 'default') }).catch((error) => logSilentError('suppressed', error));
          }
          return;
        }

        if (id.startsWith('ticket_claimreq_')) {
          const reqId = id.replace('ticket_claimreq_', '');
          await handleClaimFromRequest(interaction, reqId);
          return;
        }

        if (id.startsWith('ticket_claim_')) {
          const { guildId, panelId, channelId } = parseTicketGuildPanelChannel(id, 2);
          await handleClaimInTicket(interaction, guildId, panelId, channelId);
          return;
        }

        if (id.startsWith('ticket_close_')) {
          const { guildId, panelId, channelId } = parseTicketGuildPanelChannel(id, 2);
          await handleClose(interaction, guildId, panelId, channelId);
          return;
        }

        if (id.startsWith('ticket_reassign_claim_')) {
          const { guildId, panelId, channelId } = parseTicketGuildPanelChannel(id, 3);
          await handleReassignClaim(interaction, guildId, panelId, channelId);
          return;
        }

        if (id.startsWith('ticket_reassign_')) {
          const { guildId, panelId, channelId } = parseTicketGuildPanelChannel(id, 2);
          await handleReassignRequest(interaction, guildId, panelId, channelId);
          return;
        }

        if (id.startsWith('ticket_delete_')) {
          const { guildId, panelId, channelId } = parseTicketGuildPanelChannel(id, 2);
          const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('Error', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (ticket.status !== 'closed') {
            await interaction.reply(buildTicketMessagePayload('Alert', '**هذا الزر متاح بعد الإغلاق فقط.**', { ephemeral: true }));
            return;
          }
          if (!canManagePostCloseControls(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('Perms', '**ليس لديك صلاحية الحذف.**', { ephemeral: true }));
            return;
          }
          if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true }).catch((error) => logSilentError('suppressed', error));
          }
          await interaction.editReply(buildTicketMessagePayload(
            'Deleted',
            '**سيتم حذف التكت خلال 3 ثواني.**',
            { ephemeral: true }
          )).catch((error) => logSilentError('suppressed', error));

          const channelRef = interaction.channel;
          channelRef.ticketMeta = ticket;
          ticket.deletedChannel = true;

          delete tickets[channelId];
          setGuildData(guildId, config, tickets, pendingRequests || {}, resolvedPanelId);

          const deleteStartedAt = Date.now();
          (async () => {
            const baseLogTask = withTimeout(syncTicketLogMessage({
              guild: interaction.guild,
              config,
              ticket,
              channelId,
              actionText: `تم حذف التكت عن طريق : <@${interaction.user.id}>`,
              actor: interaction.user,
              transcriptFile: null
            }), 2500);

            const transcriptTask = withTimeout(
              buildTicketTranscript(channelRef, {
                fastMode: true,
                warmMentions: false,
                timeBudgetMs: 2800
              }).catch(() => null),
              2900
            );
            const transcriptLogTask = (async () => {
              const transcriptFile = await transcriptTask;
              if (!transcriptFile) return null;
              return withTimeout(syncTicketLogMessage({
                guild: interaction.guild,
                config,
                ticket,
                channelId,
                actionText: { type: 'action', message: `تم حفظ الترانسكريبت قبل حذف التكت بواسطة <@${interaction.user.id}>`, actorId: interaction.user.id },
                actor: interaction.user,
                transcriptFile
              }), 2500);
            })();

            await Promise.allSettled([baseLogTask, transcriptLogTask]);

            const remaining = Math.max(0, 3000 - (Date.now() - deleteStartedAt));
            setTimeout(() => channelRef.delete().catch((error) => logSilentError('suppressed', error)), remaining);
          })().catch((error) => {
            logSilentError('ticket.delete.background', error);
            setTimeout(() => channelRef.delete().catch((err) => logSilentError('suppressed', err)), 3000);
          });
          return;
        }

        if (id.startsWith('ticket_down2_') || id.startsWith('ticket_down_') || id.startsWith('ticket_up1_') || id.startsWith('ticket_up2_')) {
          const { guildId, panelId, channelId } = parseTicketGuildPanelChannel(id, 2);
          const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('Error', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (ticket.status !== 'closed') {
            await interaction.reply(buildTicketMessagePayload('Alert', '**أزرار النقاط متاحة بعد إغلاق التكت فقط.**', { ephemeral: true }));
            return;
          }
          if (!canManagePostCloseControls(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('Perm', '**ليس لديك صلاحية اعطاء نقاط.**', { ephemeral: true }));
            return;
          }

          const delta = id.startsWith('ticket_down2_') ? -2
            : id.startsWith('ticket_down_') ? -1
              : id.startsWith('ticket_up1_') ? 1 : 2;
          const reasonName = config.reasons?.[ticket.reasonKey]?.name;
          const respName = ticket.transferredTo || reasonName || 'ticket';
          const targetId = ticket.pointsReceiverId || ticket.claimedBy;
          if (!targetId) {
            await interaction.reply(buildTicketMessagePayload('Failed', '**لا يوجد مستلم مرتبط بهذا التكت للنقاط.**', { ephemeral: true }));
            return;
          }

          const points = loadPoints();
          const now = Date.now().toString();
          if (!points[respName] || typeof points[respName] !== 'object') points[respName] = {};
          const existingAward = ticket.pointAward && typeof ticket.pointAward === 'object' ? ticket.pointAward : null;
          if (existingAward) {
            if (existingAward.actorId === interaction.user.id) {
              await interaction.reply({
                ...buildTicketMessagePayload(
                  'Points',
                  `**أنت بالفعل وضعت ${existingAward.delta > 0 ? '+' : ''}${existingAward.delta} نقطة لهذا الإداري.**\n**هل تريد التراجع؟**`,
                  { ephemeral: true }
                ),
                components: buildPointRevertControls(guildId, resolvedPanelId, channelId)
              });
            } else {
              await interaction.reply(buildTicketMessagePayload(
                'Points',
                `**المسؤول :** <@${existingAward.actorId}>\n**أعطى الإداري بالفعل :** ${existingAward.delta > 0 ? '+' : ''}${existingAward.delta} نقطة.`,
                { ephemeral: true }
              ));
            }
            return;
          }
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
          appendPointAuditEntry(points, {
            id: now,
            targetId,
            actorId: interaction.user.id,
            delta: actualDelta,
            respName,
            source: 'ticket_button',
            at: now
          });
          recordManagerPoint(points, {
            guildId,
            panelId: resolvedPanelId,
            channelId,
            actorId: interaction.user.id,
            targetId: ticket.memberId || '',
            at: now
          });
          ticket.pointAward = {
            actorId: interaction.user.id,
            delta: actualDelta,
            respName,
            targetId,
            at: now,
            auditId: now,
            managerPointKey: `${guildId}:${resolvedPanelId}:${channelId}`
          };
          savePoints(points);

          await syncTicketLogMessage({
            guild: interaction.guild,
            config,
            ticket,
            channelId,
            actionText: `تم تعديل النقاط عن طريق : <@${interaction.user.id}> (${actualDelta > 0 ? '+' : ''}${actualDelta})`,
            actor: interaction.user
          });

          setGuildData(guildId, config, tickets, pendingRequests || {}, resolvedPanelId);
          await interaction.reply(buildTicketMessagePayload('تم', `**تم تعديل النقاط (${delta > 0 ? '+' : ''}${delta}) للمستلم.**`, { ephemeral: true }));
          return;
        }

        if (id.startsWith('ticket_points_revert_') || id.startsWith('ticket_points_cancel_')) {
          const { guildId, panelId, channelId } = parseTicketGuildPanelChannel(id, 3);
          if (id.startsWith('ticket_points_cancel_')) {
            await interaction.update({ components: [] });
            return;
          }
          const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('Error', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          const existingAward = ticket.pointAward && typeof ticket.pointAward === 'object' ? ticket.pointAward : null;
          if (!existingAward) {
            await interaction.update({ components: [] });
            return;
          }
          if (existingAward.actorId !== interaction.user.id) {
            await interaction.reply(buildTicketMessagePayload('Alert', '**فقط المسؤول الذي قيّم يمكنه التراجع عن النقاط.**', { ephemeral: true }));
            return;
          }
          const points = loadPoints();
          const bucket = points?.[existingAward.respName]?.[existingAward.targetId];
          if (bucket && typeof bucket === 'object') {
            delete bucket[existingAward.at];
          }
          removePointAuditEntry(points, existingAward.auditId || existingAward.at);
          removeManagerPointEntry(points, existingAward.managerPointKey || `${guildId}:${resolvedPanelId}:${channelId}`);
          delete ticket.pointAward;
          savePoints(points);
          setGuildData(guildId, config, tickets, pendingRequests || {}, resolvedPanelId);
          await interaction.update({
            ...buildTicketMessagePayload('Done✅️', '**تم التراجع عن النقاط السابقة، يمكنك اختيار نقاط جديدة الآن.**', { ephemeral: true }),
            components: []
          });
          return;
        }

        if (id.startsWith('ticket_toggle_member_') || id.startsWith('ticket_toggle_claimer_')) {
          const parts = id.split('_');
          const guildId = parts[3];
          const channelId = parts[4];
          const panelId = findTicketPanel(guildId, channelId, 'default');
          const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('Error', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (ticket.status !== 'closed') {
            await interaction.reply(buildTicketMessagePayload('Alert', '**هذه الأزرار متاحة بعد إغلاق التكت فقط.**', { ephemeral: true }));
            return;
          }
          if (!canManagePostCloseControls(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('Perms', '**ليس لديك صلاحية هذا الإجراء.**', { ephemeral: true }));
            return;
          }

          const isMember = id.startsWith('ticket_toggle_member_');
          const targetId = isMember ? ticket.memberId : ticket.claimedBy;
          if (!targetId) {
            await interaction.reply(buildTicketMessagePayload('Alert', '**لا يوجد مستخدم مرتبط بهذا الزر.**', { ephemeral: true }));
            return;
          }

          const key = isMember ? 'memberHidden' : 'claimerHidden';
          ticket[key] = !(ticket[key] !== false);
          await interaction.channel.permissionOverwrites.edit(targetId, {
            ViewChannel: !ticket[key],
            SendMessages: !ticket[key],
            ReadMessageHistory: true
          }).catch((error) => logSilentError('suppressed', error));

          setGuildData(guildId, config, tickets, pendingRequests || {}, resolvedPanelId);
          await interaction.update({
            components: buildPostCloseControls(guildId, resolvedPanelId, channelId, ticket)
          });
          return;
        }

        if (id.startsWith('ticket_rename_')) {
          const { guildId, panelId, channelId } = parseTicketGuildPanelChannel(id, 2);
          const { panelId: resolvedPanelId, config, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('Error', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('Perm', '**ليس لديك صلاحية تغيير الاسم.**', { ephemeral: true }));
            return;
          }
          await showInputModal(interaction, `ticket_rename_modal_${guildId}_${resolvedPanelId}_${actionChannelId}`, 'تغيير اسم التكت', 'الاسم الجديد', 'مثال : support-user');
          return;
        }

        if (id.startsWith('ticket_points_action_add_') || id.startsWith('ticket_points_action_remove_')) {
          const parts = id.split('_');
          const sessionId = parts.slice(4).join('_');
          const mode = id.startsWith('ticket_points_action_add_') ? 'add' : 'remove';
          await handlePointsAdjustActionInteraction(interaction, sessionId, mode);
          return;
        }

        if (id.startsWith('ticket_points_amount_')) {
          const parts = id.split('_');
          const mode = parts[3];
          const amount = Number(parts[4]);
          const sessionId = parts.slice(5).join('_');
          await handlePointsAdjustAmountInteraction(interaction, sessionId, mode, amount);
          return;
        }

        if (id.startsWith('ticket_transfer_search_page_')) {
          const parts = id.split('_');
          const page = Number(parts.pop());
          const sessionId = parts.slice(4).join('_');
          const responsibilities = loadResponsibilities();
          const pageData = await buildResponsibilitySearchResultsMessage(sessionId, responsibilities, page);
          if (!pageData) {
            await interaction.reply(buildTicketMessagePayload('Alert', '**انتهت صلاحية نتائج البحث، أعد البحث مرة أخرى.**', { ephemeral: true }));
            return;
          }
          await interaction.update(pageData.payload);
          return;
        }

        if (id.startsWith('ticket_add_')) {
          const { guildId, panelId, channelId } = parseTicketGuildPanelChannel(id, 2);
          const { panelId: resolvedPanelId, config, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('Error', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('Perms', '**ليس لديك صلاحية الاضافة.**', { ephemeral: true }));
            return;
          }
          await showInputModal(interaction, `ticket_add_modal_${guildId}_${resolvedPanelId}_${actionChannelId}`, 'اضافة شخص للتكت', 'ايدي او منشن الشخص');
          return;
        }

        if (id.startsWith('ticket_remove_')) {
          const { guildId, panelId, channelId } = parseTicketGuildPanelChannel(id, 2);
          const { panelId: resolvedPanelId, config, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('Error', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('Perms', '**ليس لديك صلاحية الازالة.**', { ephemeral: true }));
            return;
          }
          await showInputModal(interaction, `ticket_remove_modal_${guildId}_${resolvedPanelId}_${actionChannelId}`, 'ازالة شخص من التكت', 'ايدي او منشن الشخص');
          return;
        }

        if (id.startsWith('ticket_ping_')) {
          const { guildId, panelId, channelId } = parseTicketGuildPanelChannel(id, 2);
          const { panelId: resolvedPanelId, tickets, config, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('Error', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('Perms', '**ليس لديك صلاحية الاستدعاء.**', { ephemeral: true }));
            return;
          }
          if (ticket.status !== 'open') {
            await interaction.reply(buildTicketMessagePayload('Alert', '**لا يمكن الاستدعاء بعد إقفال التكت.**', { ephemeral: true }));
            return;
          }
	          const cooldownKey = `${interaction.guild.id}:${channelId}:${interaction.user.id}`;
	          prunePingCooldowns();
	          const last = await getPingCooldownValue(cooldownKey);
          const now = Date.now();
          const cooldownMs = PING_COOLDOWN_MS;
          if (now - last < cooldownMs) {
            const leftText = formatCooldownText(cooldownMs - (now - last));
            await interaction.reply(buildTicketMessagePayload('كولداون', `**انتظر ${leftText} قبل استخدام الاستدعاء مرة أخرى.**`, { ephemeral: true }));
            return;
          }

          const user = await client.users.fetch(ticket.memberId).catch(() => null);
          const link = `https://discord.com/channels/${interaction.guild.id}/${interaction.channel.id}`;
          if (user) {
            await user.send(buildTicketMessagePayload('تم استدعاؤك', `**رد عليك إداري فالتكت يرجى التوجه ورؤية التكت **\n**الرابط :** ${link}`)).catch((error) => logSilentError('suppressed', error));
          }
          setPingCooldownValue(cooldownKey, now);
          await syncTicketLogMessage({
            guild: interaction.guild,
            config,
            ticket,
            channelId: actionChannelId,
            actionText: `تم استدعاء العضو عن طريق : <@${interaction.user.id}>`,
            actor: interaction.user
          });
          setGuildData(guildId, config, tickets, pendingRequests, resolvedPanelId);
          await interaction.reply(buildTicketMessagePayload('تم', `**تم استدعاء العضو :** <@${ticket.memberId}>`, { ephemeral: true }));
          return;
        }

        if (interaction.isStringSelectMenu() && id.startsWith('ticket_transfer_')) {
          const { guildId, panelId, channelId } = parseTicketGuildPanelChannel(id, 2);
          const selected = interaction.values?.[0] || 'resp_none';
          if (selected === 'resp_search') {
            await showResponsibilitySearchModal(interaction, guildId, panelId, channelId);
            return;
          }
          await handleTransferResponsibility(interaction, guildId, panelId, channelId, selected);
          const { panelId: resolvedPanelId, config, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (ticket && interaction.message?.editable) {
            const hasTransferredAssignment = Boolean(ticket.transferredRoleIds?.length || ticket.transferredUserIds?.length || ticket.transferredTo);
            const refreshedControls = await buildTicketControls(guildId, resolvedPanelId, actionChannelId, config, {
              includeClaimButton: !hasTransferredAssignment,
              disableClaimButton: hasTransferredAssignment,
              hideReassignButton: hasTransferredAssignment
            });
            await interaction.message.edit({ components: refreshedControls }).catch((error) => logSilentError('suppressed', error));
          }
          return;
        }

        if (interaction.isStringSelectMenu() && id.startsWith('ticket_transfer_confirm_')) {
          const { guildId, panelId, channelId } = parseTicketGuildPanelChannel(id, 3);
          const selected = interaction.values?.[0] || 'resp_none';
          await handleTransferResponsibility(interaction, guildId, panelId, channelId, selected);
          return;
        }
      }

      if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket_')) {
        const modalId = interaction.customId;
        if (interaction.guild && interaction.member && resolveTicketBlockForMember(interaction.guild.id, interaction.member)) {
          await interaction.reply(buildTicketMessagePayload('Ticket Blocked', '**عليك بلوك تكت يرجى التوجه للخاص لرؤية المدة.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
          return;
        }

        if (modalId.startsWith('ticket_open_reason_modal_')) {
          const data = client.ticketOpenModalData?.get(modalId);
          if (!data) {
            await interaction.reply(buildTicketMessagePayload('Alert', '**انتهت صلاحية نموذج فتح التكت، حاول مرة أخرى.**', { ephemeral: true }));
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

        if (modalId.startsWith('ticket_feedback_modal_')) {
          const token = modalId.replace('ticket_feedback_modal_', '');
          let session = ticketFeedbackSessions.get(token);
          if (!session) session = await loadRuntimeSession('ticket-feedback', token).catch(() => null);
          if (!session || (session.expiresAt && Date.now() > session.expiresAt)) {
            await interaction.reply(buildTicketMessagePayload('التقييم', '**انتهت صلاحية نموذج التقييم.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
            return;
          }

          const stars = parseStars(interaction.fields.getTextInputValue('stars'));
          if (!stars) {
            await interaction.reply(buildTicketMessagePayload('التقييم', '**النجوم يجب أن تكون من 1 إلى 5.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
            return;
          }
          const review = String(interaction.fields.getTextInputValue('review') || '').trim().slice(0, 300);
          const { config } = getPanelData(session.guildId, session.panelId || 'default');
          const feedbackCfg = config.feedback || baseConfig().feedback;
          if (session.submittedAt) {
            await interaction.reply(buildTicketMessagePayload('التقييم', '**تم إرسال تقييمك مسبقًا.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
            return;
          }
          const guild = client.guilds.cache.get(session.guildId) || await client.guilds.fetch(session.guildId).catch(() => null);
          if (!guild || !feedbackCfg.channelId) {
            await interaction.reply(buildTicketMessagePayload('التقييم', '**تعذر العثور على روم التقييم.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
            return;
          }
          const feedbackChannel = guild.channels.cache.get(feedbackCfg.channelId) || await guild.channels.fetch(feedbackCfg.channelId).catch(() => null);
          if (!feedbackChannel || !feedbackChannel.isTextBased?.()) {
            await interaction.reply(buildTicketMessagePayload('التقييم', '**روم التقييم غير صالح.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
            return;
          }
          // Prevent "Something went wrong" on slow render/send by acknowledging modal early
          await interaction.deferReply({ ephemeral: true }).catch((error) => logSilentError('suppressed', error));
          const member = await resolveGuildMember(guild, interaction.user.id);
          const image = await buildFeedbackCardImage({ guild, member, stars, comment: review, style: feedbackCfg.style || {} });
          const attachment = new AttachmentBuilder(image, { name: `feedback_${interaction.user.id}_${Date.now()}.png` });
          await feedbackChannel.send({ files: [attachment] }).catch((error) => logSilentError('suppressed', error));
          await sendFeedbackSeparator(feedbackChannel, feedbackCfg);
          session.submittedAt = Date.now();
          ticketFeedbackSessions.set(token, session);
          saveRuntimeSession('ticket-feedback', token, session, FEEDBACK_SESSION_TTL_MS);
          const promptKey = `${session.guildId}:${session.panelId || 'default'}:${session.ticketChannelId}:${session.memberId}`;
          feedbackPromptSessions.set(promptKey, { token, submittedAt: session.submittedAt });
          if (session.promptChannelId && session.promptMessageId) {
            const promptChannel = await client.channels.fetch(session.promptChannelId).catch(() => null);
            const promptMsg = promptChannel?.messages?.fetch
              ? await promptChannel.messages.fetch(session.promptMessageId).catch(() => null)
              : null;
            if (promptMsg?.editable && promptMsg.components?.length) {
              const disabledRows = promptMsg.components.map((row) => {
                const components = row.components.map((component) => ButtonBuilder.from(component).setDisabled(true));
                return new ActionRowBuilder().addComponents(components);
              });
              await promptMsg.edit({ components: disabledRows }).catch((error) => logSilentError('suppressed', error));
            }
          }
          ticketFeedbackSessions.delete(token);
          deleteRuntimeSession('ticket-feedback', token);
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply(buildTicketMessagePayload('التقييم', '**شكراً لك، تم إرسال تقييمك بنجاح.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
          } else {
            await interaction.reply(buildTicketMessagePayload('التقييم', '**شكراً لك، تم إرسال تقييمك بنجاح.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
          }
          return;
        }

        if (modalId.startsWith('ticket_transfer_search_modal_')) {
          const [, , , , guildId, panelId = 'default', channelId] = modalId.split('_');
          const query = interaction.fields.getTextInputValue('value');
          const responsibilities = loadResponsibilities();
          const results = searchResponsibilitiesByName(query, responsibilities, 50);
          if (results.length === 0) {
            await interaction.reply(buildTicketMessagePayload(' Search', '**لا توجد نتائج مطابقة.**', { ephemeral: true }));
            return;
          }
          const sessionId = createResponsibilitySearchSession({ guildId, panelId, channelId, query, results });
          const pageData = await buildResponsibilitySearchResultsMessage(sessionId, responsibilities, 0);
          await interaction.reply(pageData.payload);
          return;
        }

        if (modalId.startsWith('ticket_rename_modal_')) {
          const { guildId, panelId, channelId } = parseTicketGuildPanelChannel(modalId, 3);
          const newName = sanitizeName(interaction.fields.getTextInputValue('value'));
          if (!newName) {
            await interaction.reply(buildTicketMessagePayload('Failed', '**الاسم غير صالح.**', { ephemeral: true }));
            return;
          }
          const { config, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('Error', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('Perms', '**ليس لديك صلاحية تغيير الاسم.**', { ephemeral: true }));
            return;
          }
          await interaction.channel.setName(newName).catch((error) => logSilentError('suppressed', error));
          await syncTicketLogMessage({
            guild: interaction.guild,
            config,
            ticket,
            channelId: actionChannelId,
            actionText: `تم تغيير اسم التكت عن طريق : <@${interaction.user.id}> -> ${newName}`,
            actor: interaction.user
          });
          await interaction.reply(buildTicketMessagePayload('Done Rename ✅️', `**تم تغيير الاسم :** ${newName}`, { ephemeral: true }));
          return;
        }

        if (modalId.startsWith('ticket_add_modal_')) {
          const { guildId, panelId, channelId } = parseTicketGuildPanelChannel(modalId, 3);
          const userId = normalizeId(interaction.fields.getTextInputValue('value'));
          if (!userId) {
            await interaction.reply(buildTicketMessagePayload('Error', '**المدخل غير صالح.**', { ephemeral: true }));
            return;
          }
          const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('Error', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('Perms', '**ليس لديك صلاحية الاضافة.**', { ephemeral: true }));
            return;
          }
          if (ticket.memberId === userId) {
            await interaction.reply(buildTicketMessagePayload('Failed', '**الشخص هو صاحب التكت بالفعل.**', { ephemeral: true }));
            return;
          }
          const targetMember = await resolveGuildMember(interaction.guild, userId);
          if (!targetMember) {
            await interaction.reply(buildTicketMessagePayload('Failed', '**لا يمكن العثور على العضو.**', { ephemeral: true }));
            return;
          }
          await interaction.channel.permissionOverwrites.edit(userId, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true
          }).catch((error) => logSilentError('suppressed', error));
          if (!ticket.extraMembers.includes(userId)) ticket.extraMembers.push(userId);
          await syncTicketLogMessage({
            guild: interaction.guild,
            config,
            ticket,
            channelId: actionChannelId,
            actionText: `تمت إضافة شخص عن طريق : <@${interaction.user.id}> -> <@${userId}>`,
            actor: interaction.user
          });
          setGuildData(guildId, config, tickets, pendingRequests, resolvedPanelId);
          await interaction.reply(buildTicketMessagePayload('Done Added✅️', `**تم اضافة الشخص :** <@${userId}>`, { ephemeral: true }));
          return;
        }

        if (modalId.startsWith('ticket_remove_modal_')) {
          const { guildId, panelId, channelId } = parseTicketGuildPanelChannel(modalId, 3);
          const userId = normalizeId(interaction.fields.getTextInputValue('value'));
          if (!userId) {
            await interaction.reply(buildTicketMessagePayload('Error', '**المدخل غير صالح.**', { ephemeral: true }));
            return;
          }
          const { panelId: resolvedPanelId, config, tickets, pendingRequests, ticket, actionChannelId } = getTicketContextFromInteraction(guildId, interaction, channelId, panelId);
          if (!ticket || interaction.channelId !== actionChannelId) {
            await interaction.reply(buildTicketMessagePayload('Error', '**لا توجد بيانات لهذا التكت.**', { ephemeral: true }));
            return;
          }
          if (!canManageTicket(interaction, ticket, config)) {
            await interaction.reply(buildTicketMessagePayload('Perms', '**ليس لديك صلاحية الازالة.**', { ephemeral: true }));
            return;
          }
          if (ticket.memberId === userId) {
            await interaction.reply(buildTicketMessagePayload('Failed', '**لا يمكن إزالة صاحب التكت.**', { ephemeral: true }));
            return;
          }
          await interaction.channel.permissionOverwrites.edit(userId, { ViewChannel: false }).catch((error) => logSilentError('suppressed', error));
          ticket.extraMembers = (ticket.extraMembers || []).filter((id) => id !== userId);
          await syncTicketLogMessage({
            guild: interaction.guild,
            config,
            ticket,
            channelId: actionChannelId,
            actionText: `تمت إزالة شخص عن طريق : <@${interaction.user.id}> -> <@${userId}>`,
            actor: interaction.user
          });
          setGuildData(guildId, config, tickets, pendingRequests, resolvedPanelId);
          await interaction.reply(buildTicketMessagePayload('Done Removed✅️', `**تم ازالة الشخص :** <@${userId}>`, { ephemeral: true }));
          return;
        }
      }

      return false;
    } catch {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply(buildTicketMessagePayload('Error', '**حدث خطأ أثناء معالجة التكت.**', { ephemeral: true })).catch((error) => logSilentError('suppressed', error));
      }
      return true;
    }
  });
}

module.exports = { name, aliases, execute, registerHandlers };
