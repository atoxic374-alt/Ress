// تحسين أولوية المعالجة عند دعم النظام لها.
try {
    require('os').setPriority(process.pid, -20);
} catch (e) {}

const { Client, GatewayIntentBits, Partials, Collection, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder, Events, MessageFlags, PermissionsBitField, ChannelType, ComponentType, AuditLogEvent } = require('discord.js');
const dotenv = require('dotenv');
dotenv.config();
const fs = require('fs');
const path = require('path');

// تسجيل خط Cairo بجميع أوزانه عند بدء التشغيل
require('./utils/cairoFont').ensureCairoFontsRegistered();
const { logEvent } = require('./utils/logs_system.js');
const { createStructuredContainer, componentsV2Payload, colorToNumber } = require('./utils/structuredContainer.js');
const { normalizeDiscordId, normalizeMentionableIds, userMention } = require('./utils/mentions.js');
// تعريف downManager في المستوى العلوي للوصول عبر جميع معالجات الأحداث
const downManager = require('./utils/downManager');
const warnManager = require('./utils/warnManager');
const colorManager = require('./utils/colorManager.js');
const { buildResponsibilitiesSummaryImage } = require('./utils/responsibilitiesSummaryRenderer.js');
const { getGuildBannerHex } = require('./utils/guildBannerColor.js');

// كولداون اختصارات المسؤوليات: الزران يشتركان في نفس الكولداون لكل مستخدم ومسؤولية.
const SHORTCUT_CALL_COOLDOWN_MS = 10 * 60 * 1000;
// يمنع تكرار نفس طلب المسؤولية خلال خمس دقائق، ويدمج أصحاب الطلبات في الرسالة الأولى.
const SHORTCUT_REQUEST_COOLDOWN_MS = 5 * 60 * 1000;
const MEMBER_REFRESH_RETRY_MS = 1500;
const MEMBER_REFRESH_QUEUE_TIMEOUT_MS = 5000;
const MEMBER_REFRESH_FETCH_TIMEOUT_MS = 10000;
const MAX_CONCURRENT_MEMBER_REFRESHES = 8;
const MAX_QUEUED_MEMBER_REFRESHES = 50;
const SHORTCUT_COOLDOWN_REACTION_MS = 30 * 1000;
const MAX_CONCURRENT_SHORTCUT_NOTIFICATION_JOBS = 2;
const MAX_SHORTCUT_CALL_RECIPIENTS = 100;
const SHORTCUT_REQUEST_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SHORTCUT_REQUESTS = 10000;
const shortcutCallCooldowns = new Map();
const shortcutCallLocks = new Set();
const shortcutUsageLocks = new Set();
const shortcutRequestLocks = new Set();
const shortcutActionLocks = new Set();
const shortcutBypassKeys = new Set();
const memberRefreshAttemptAt = new Map();
const memberRefreshWaiters = [];
const shortcutCooldownReactionAt = new Map();
const autoLevelCheckAt = new Map();
let activeShortcutNotificationJobs = 0;
let activeMemberRefreshes = 0;
let shortcutMatcherCache = null;
const RESPONSIBLE_KEYWORDS_NORMALIZED = ['مسؤولين', 'مسؤوليه', 'مسؤولية', 'مسيولين', 'مسيوليه'].map(normalizeArabicWord);

function normalizeArabicWord(text) {
    if (!text) return '';
    return String(text)
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/أ|إ|آ/g, 'ا')
        .replace(/ئ/g, 'ي')
        .trim()
        .toLowerCase();
}

function removeArabicArticle(word) {
    return String(word || '').startsWith('ال') ? String(word).slice(2) : String(word || '');
}

function setBoundedMapEntry(map, key, value, limit = 5000) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
}

function getShortcutMatcherCache(responsibilities) {
    const source = responsibilities && typeof responsibilities === 'object' ? responsibilities : {};
    if (shortcutMatcherCache?.source === source) return shortcutMatcherCache;
    const byPrefix = new Map();
    const prefixesByFirstCharacter = new Map();
    let order = 0;
    for (const [responsibilityName, config] of Object.entries(source)) {
        if (!config?.mentShortcut) continue;
        const prefix = String(config.mentPrefix || '-');
        const entry = {
            order: order++,
            responsibilityName,
            config,
            prefix,
            normalizedShortcut: normalizeArabicWord(removeArabicArticle(config.mentShortcut))
        };
        if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
        byPrefix.get(prefix).push(entry);
    }
    const prefixes = [...byPrefix.keys()];
    for (const prefix of prefixes) {
        const firstCharacter = prefix[0];
        if (!prefixesByFirstCharacter.has(firstCharacter)) prefixesByFirstCharacter.set(firstCharacter, []);
        prefixesByFirstCharacter.get(firstCharacter).push(prefix);
    }
    shortcutMatcherCache = { source, byPrefix, prefixes, prefixesByFirstCharacter };
    return shortcutMatcherCache;
}

function invalidateShortcutMatcherCache() {
    shortcutMatcherCache = null;
}

function shouldReactToShortcutCooldown(guildId, userId, responsibilityName, now = Date.now()) {
    const key = getShortcutUsageKey(guildId, userId, responsibilityName);
    const lastReacted = Number(shortcutCooldownReactionAt.get(key) || 0);
    if (now - lastReacted < SHORTCUT_COOLDOWN_REACTION_MS) return false;
    setBoundedMapEntry(shortcutCooldownReactionAt, key, now);
    return true;
}

function tryAcquireShortcutNotificationSlot() {
    if (activeShortcutNotificationJobs >= MAX_CONCURRENT_SHORTCUT_NOTIFICATION_JOBS) return null;
    activeShortcutNotificationJobs += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        activeShortcutNotificationJobs = Math.max(0, activeShortcutNotificationJobs - 1);
    };
}

function tryAcquireShortcutCallLock(guildId, userId, responsibilityName) {
    const key = getShortcutUsageKey(guildId, userId, responsibilityName);
    if (shortcutCallLocks.has(key)) return null;
    shortcutCallLocks.add(key);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        shortcutCallLocks.delete(key);
    };
}

function getShortcutUsageKey(guildId, userId, responsibilityName) {
    return JSON.stringify([String(guildId), String(userId), String(responsibilityName)]);
}
function getShortcutRequestKey(guildId, responsibilityName) {
    return JSON.stringify([String(guildId), String(responsibilityName)]);
}
function getShortcutUsageCooldown(guildId, userId, responsibilityName) {
    const key = getShortcutUsageKey(guildId, userId, responsibilityName);
    const lastUsed = Number(shortcutStore.cooldowns[key] || 0);
    const timeLeft = lastUsed + SHORTCUT_CALL_COOLDOWN_MS - Date.now();
    if (timeLeft > 0) return timeLeft;
    const expired = Object.prototype.hasOwnProperty.call(shortcutStore.cooldowns, key);
    delete shortcutStore.cooldowns[key];
    if (expired) shortcutStateStore.saveShortcutStore();
    return 0;
}
function startShortcutUsageCooldown(guildId, userId, responsibilityName) {
    shortcutStore.cooldowns[getShortcutUsageKey(guildId, userId, responsibilityName)] = Date.now();
    shortcutStateStore.saveShortcutStore();
}
function getShortcutCallCooldown(guildId, userId, responsibilityName) {
    const key = getShortcutUsageKey(guildId, userId, responsibilityName);
    const lastUsed = Number(shortcutStore.callCooldowns[key] || shortcutCallCooldowns.get(key) || 0);
    const timeLeft = lastUsed + SHORTCUT_CALL_COOLDOWN_MS - Date.now();
    if (timeLeft > 0) return timeLeft;
    shortcutCallCooldowns.delete(key);
    const expired = Object.prototype.hasOwnProperty.call(shortcutStore.callCooldowns, key);
    delete shortcutStore.callCooldowns[key];
    if (expired) shortcutStateStore.saveShortcutStore();
    return 0;
}
function startShortcutCallCooldown(guildId, userId, responsibilityName) {
    const key = getShortcutUsageKey(guildId, userId, responsibilityName);
    const now = Date.now();
    setBoundedMapEntry(shortcutCallCooldowns, key, now);
    shortcutStore.callCooldowns[key] = now;
    shortcutStateStore.saveShortcutStore();
}
const vacationManager = require('./utils/vacationManager');
const promoteManager = require('./utils/promoteManager');
const { getRoleEntry, addRoleEntry, getGuildRoles, findRoleByOwner, deleteRoleEntry } = require('./utils/customRolesSystem.js');
const interactionRouter = require('./utils/interactionRouter');
const { loadMapConfigsSync, writeMapConfigsQueued } = require('./utils/mapConfigStore');
const { handleAdminApplicationInteraction } = require('./commands/admin-apply.js');
const { restoreTopSchedules, restorePanelCleanups, handlePanelMessageDelete } = require('./commands/roles-settings.js');
const { handleChannelDelete, handleRoleDelete } = require('./utils/protectionManager.js');
const problemCommand = require('./commands/problem.js');
const { getDataDir, getBotConfigPath, writeBotConfigFile } = require('./utils/storagePaths');
const shortcutStateStore = require('./utils/responsibilityShortcutStore.js');
const shortcutStore = shortcutStateStore.loadShortcutStore();
const { isSupervisorForResponsibility, removeUserFromAllSupervisors } = require('./utils/responsibilitySupervisors');
const { ownersPath, normalizeIds, loadOwners, saveOwners } = require('./utils/ownersStore');
let interactiveRolesManager;

// مسارات ملفات البيانات
const dataDir = getDataDir();
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const DATA_FILES = {
    points: path.join(dataDir, 'points.json'),
    responsibilities: path.join(dataDir, 'responsibilities.json'),
    logConfig: path.join(dataDir, 'logConfig.json'),
    adminRoles: path.join(dataDir, 'adminRoles.json'),
    owners: ownersPath,
    botConfig: getBotConfigPath(),
    cooldowns: path.join(dataDir, 'cooldowns.json'),
    notifications: path.join(dataDir, 'notifications.json'),
    reports: path.join(dataDir, 'reports.json'),
    adminApplications: path.join(dataDir, 'adminApplications.json'),
    serverMapConfig: path.join(dataDir, 'serverMapConfig.json'),
    voiceSessions: path.join(dataDir, 'voiceSessions.json'),
wordTriggers: path.join(dataDir, 'wordTriggers.json'),
    roleGrantHistory: path.join(dataDir, 'roleGrantHistory.json'),
    responsibilityLeaveTracker: path.join(dataDir, 'responsibilityLeaveTracker.json')
    
};

// نظام التحقق التلقائي من ملفات البيانات
function ensureDataFiles() {
    
    const defaults = {
        roleGrantHistory: {},
        wordTriggers: {},
        serverMapConfig: {
            enabled: false,
            imageUrl: "https://i.imgur.com/Xv7XzXz.png",
            welcomeMessage: "مرحباً بك في السيرفر! استكشف الخريطة أدناه:",
            buttons: []
        }
    };

    for (const [key, filePath] of Object.entries(DATA_FILES)) {
        if (!fs.existsSync(filePath)) {
            // انقل النسخة المرفقة إلى المسار الدائم في أول تشغيل فقط.
            // لا ننسخها إذا كان الملف الدائم موجوداً حتى لا نعيد ضبط إعدادات المستخدم.
            const bundledPath = path.join(__dirname, 'data', path.basename(filePath));
            if (bundledPath !== filePath && fs.existsSync(bundledPath)) {
                fs.copyFileSync(bundledPath, filePath);
                console.log(`✅ تم ترحيل ملف البيانات إلى التخزين الدائم: ${path.basename(filePath)}`);
                continue;
            }

            const defaultValue = defaults[key] || (filePath.endsWith('.json') ? (key === 'adminRoles' ? [] : {}) : '');
            fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
            console.log(`✅ تم إنشاء ملف البيانات المفقود: ${path.basename(filePath)}`);
        }
    }
}
ensureDataFiles();



if (!global.adminRoleGrantBypass) {
    global.adminRoleGrantBypass = new Set();
}
if (!global.interactiveRoleGrantBypass) {
    global.interactiveRoleGrantBypass = new Set();
}

global.markAdminRoleGrant = function markAdminRoleGrant(guildId, userId, roleId) {
    if (!guildId || !userId || !roleId) return;
    const key = `${guildId}_${userId}_${roleId}`;
    global.adminRoleGrantBypass.add(key);
    setTimeout(() => global.adminRoleGrantBypass.delete(key), 15000);
};

global.markInteractiveRoleGrant = function markInteractiveRoleGrant(guildId, userId, roleId) {
    if (!guildId || !userId || !roleId) return;
    const key = `${guildId}_${userId}_${roleId}`;
    global.interactiveRoleGrantBypass.add(key);
    setTimeout(() => global.interactiveRoleGrantBypass.delete(key), 15000);
};
async function resolveActorIdFromReason(guild, reasonText = '', fallbackTargetId = null) {
    if (!guild || typeof reasonText !== 'string' || !reasonText.trim()) return null;

    const arabicDigitsMap = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
    const toAsciiDigits = (value = '') => String(value).replace(/[٠-٩]/g, d => arabicDigitsMap[d] || d);
    const normalize = (value = '') => toAsciiDigits(value)
        .normalize('NFKC')
        .replace(/[\u064B-\u065F\u0670]/g, '')
        .replace(/[^\p{L}\p{N}#@._\-\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

    const rawText = toAsciiDigits(reasonText);
    const normalizedText = normalize(rawText);
    if (!normalizedText) return null;

    const idCandidates = new Set();
    const nameCandidates = new Set();

    const addIdCandidate = (candidate) => {
        if (!candidate) return;
        const id = String(candidate).replace(/\D/g, '');
        if (!/^\d{15,21}$/.test(id)) return;
        if (fallbackTargetId && id === String(fallbackTargetId)) return;
        idCandidates.add(id);
    };

    const addNameCandidate = (candidate) => {
        if (!candidate) return;
        const cleaned = normalize(String(candidate));
        if (!cleaned || /^\d{15,21}$/.test(cleaned)) return;
        if (cleaned.length < 2) return;
        nameCandidates.add(cleaned);
    };

    for (const match of rawText.matchAll(/<@!?(\d{15,21})>/g)) addIdCandidate(match[1]);
    for (const match of rawText.matchAll(/\b(\d{15,21})\b/g)) addIdCandidate(match[1]);

    const actorKeys = [
        'by', 'actor', 'executor', 'user', 'member', 'admin', 'moderator', 'mod', 'staff',
        'بواسطة', 'بواسطه', 'منفذ', 'المنفذ', 'منفذها', 'فاعل', 'المسؤول', 'المشرف', 'ادمن', 'الإدمن', 'الادمن', 'يوزر', 'عضو'
    ];
    const keyPattern = actorKeys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const keyedRegex = new RegExp(`(?:^|\\s)(?:${keyPattern})\\s*[:=\\-]\\s*([^\\n\\r|,;]+)`, 'giu');
    for (const match of rawText.matchAll(keyedRegex)) {
        const value = (match[1] || '').trim();
        addIdCandidate(value);
        addNameCandidate(value);
    }

    for (const match of rawText.matchAll(/["'“”‘’`]\s*([^"'“”‘’`]{2,64})\s*["'“”‘’`]/g)) {
        addNameCandidate(match[1]);
    }

    const commonStopWords = new Set([
        'system', 'bot', 'unknown', 'none', 'null',
        'النظام', 'بوت', 'غير معروف', 'مجهول', 'لا يوجد'
    ]);

    const matchMemberByName = (candidate) => {
        const probe = normalize(candidate);
        if (!probe || commonStopWords.has(probe)) return null;
        for (const member of guild.members.cache.values()) {
            const values = [
                member.user?.username,
                member.user?.globalName,
                member.displayName,
                member.nickname,
                member.user?.tag
            ];
            for (const value of values) {
                const normalizedValue = normalize(value || '');
                if (!normalizedValue) continue;
                if (normalizedValue === probe) return member.id;
                if (probe.length >= 3 && normalizedValue.includes(probe)) return member.id;
            }
        }
        return null;
    };

    for (const candidate of idCandidates) {
        if (guild.members.cache.has(candidate) || guild.client.users.cache.has(candidate)) {
            return candidate;
        }
        const fetchedUser = await guild.client.users.fetch(candidate).catch(() => null);
        if (fetchedUser) return candidate;
    }

    for (const candidate of nameCandidates) {
        const fromCache = matchMemberByName(candidate);
        if (fromCache) return fromCache;

        const query = candidate.replace(/\s+/g, ' ').trim();
        if (query.length >= 2) {
            const fetchedMembers = await guild.members.fetch({ query, limit: 10 }).catch(() => null);
            if (fetchedMembers?.size) {
                for (const member of fetchedMembers.values()) {
                    const nameChecks = [
                        member.user?.username,
                        member.user?.globalName,
                        member.displayName,
                        member.nickname,
                        member.user?.tag
                    ];
                    if (nameChecks.some(value => normalize(value || '') === normalize(candidate))) {
                        if (!fallbackTargetId || String(member.id) !== String(fallbackTargetId)) {
                            return member.id;
                        }
                    }
                }
                const first = fetchedMembers.first();
                if (first && (!fallbackTargetId || String(first.id) !== String(fallbackTargetId))) {
                    return first.id;
                }
            }
        }
    }

    return null;
}

function hasRoleLinkIndicators(role) {
    if (!role || !role.tags) return false;
    const tags = role.tags;
    return Boolean(
        tags.guildConnections !== null && tags.guildConnections !== undefined ||
        tags.integrationId ||
        tags.botId ||
        tags.subscriptionListingId ||
        tags.availableForPurchase !== undefined ||
        tags.premiumSubscriberRole !== undefined
    );
}

function getRoleSecurityDiff(oldRole, newRole) {
    if (!oldRole || !newRole) return null;
    const oldLinked = hasRoleLinkIndicators(oldRole);
    const newLinked = hasRoleLinkIndicators(newRole);
    if (!newLinked || oldLinked === newLinked) return null;
    return {
        oldLinked,
        newLinked,
        hadGuildConnections: Boolean(oldRole?.tags?.guildConnections !== undefined && oldRole?.tags?.guildConnections !== null),
        hasGuildConnections: Boolean(newRole?.tags?.guildConnections !== undefined && newRole?.tags?.guildConnections !== null)
    };
}

async function findRoleLinkExecutor(guild, roleId) {
    if (!guild || !roleId) return null;
    const now = Date.now();
    const candidates = [];
    const pushCandidate = (entry, source, strictRoleTarget = false) => {
        if (!entry?.executor) return;
        const createdAt = entry.createdTimestamp || 0;
        const delta = Math.abs(now - createdAt);
        if (delta > 30_000) return;
        if (strictRoleTarget && String(entry?.target?.id || '') !== String(roleId)) return;
        candidates.push({ entry, source, delta });
    };

    try {
        const roleUpdateLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.RoleUpdate, limit: 10 }).catch(() => null);
        for (const entry of roleUpdateLogs?.entries?.values?.() || []) {
            pushCandidate(entry, 'RoleUpdate', true);
        }
    } catch (_) {}

    try {
        const roleCreateLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.RoleCreate, limit: 10 }).catch(() => null);
        for (const entry of roleCreateLogs?.entries?.values?.() || []) {
            pushCandidate(entry, 'RoleCreate', true);
        }
    } catch (_) {}

    try {
        const integrationLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.IntegrationCreate, limit: 10 }).catch(() => null);
        for (const entry of integrationLogs?.entries?.values?.() || []) {
            pushCandidate(entry, 'IntegrationCreate', false);
        }
    } catch (_) {}

    try {
        const integrationUpdateLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.IntegrationUpdate, limit: 10 }).catch(() => null);
        for (const entry of integrationUpdateLogs?.entries?.values?.() || []) {
            pushCandidate(entry, 'IntegrationUpdate', false);
        }
    } catch (_) {}

    try {
        const webhooksLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.WebhookCreate, limit: 10 }).catch(() => null);
        for (const entry of webhooksLogs?.entries?.values?.() || []) {
            pushCandidate(entry, 'WebhookCreate', false);
        }
    } catch (_) {}

    if (!candidates.length) return null;

    candidates.sort((a, b) => a.delta - b.delta);
    const best = candidates[0];
    if (best?.entry?.executor) {
        return { user: best.entry.executor, source: best.source, deltaMs: best.delta };
    }
    return null;
}

async function resolveRoleLinkExecutorWithRetry(guild, roleId, maxAttempts = 7, waitMs = 1100) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const candidate = await findRoleLinkExecutor(guild, roleId).catch(() => null);
        if (candidate?.user) return candidate;
        if (attempt < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
    }
    return null;
}

async function notifyGuildOwnerAboutRoleLinkIncident(guild, role, executor, connectionName = 'غير معروف', actionStatus = 'لم يحدث شي', incidentDetails = 'تم تنفيذ الحماية.') {
    if (!guild || !role) return;
    try {
        const guildOwner = await guild.fetchOwner().catch(() => null);
        const botOwners = Array.isArray(global.BOT_OWNERS) ? global.BOT_OWNERS : [];
        const recipients = new Map();

        if (guildOwner?.user?.id) {
            recipients.set(guildOwner.user.id, guildOwner.user);
        }

        for (const ownerId of botOwners) {
            if (!ownerId) continue;
            if (recipients.has(ownerId)) continue;
            const ownerUser = await guild.client.users.fetch(ownerId).catch(() => null);
            if (ownerUser) recipients.set(ownerId, ownerUser);
        }

        if (!recipients.size) return;

        const adminText = executor ? `${executor.tag} (${executor.id})` : 'غير معروف';
        const embed = new EmbedBuilder()
            .setColor('#ff3b30')
            .setTitle('🚨 تنبيه حماية الرولات')
            .setThumbnail(guild.iconURL({ dynamic: true, size: 256 }))
            .setDescription('تم ربط رول بمنصة')
            .addFields(
                { name: 'Role', value: `${role.name} (${role.id})`, inline: false },
                { name: 'Connections', value: connectionName || 'غير معروف', inline: true },
                { name: 'Admin', value: adminText, inline: true },
                { name: 'ACTION', value: actionStatus, inline: false },
                { name: 'Details', value: incidentDetails || 'تم تنفيذ الحماية.', inline: false }
            )
            .setTimestamp();

        for (const user of recipients.values()) {
            await user.send({ embeds: [embed] }).catch(() => null);
        }
    } catch (error) {
        console.error('❌ فشل إرسال تنبيه ربط الرول إلى أونر السيرفر:', error);
    }
}

async function restoreRoleAfterUnauthorizedLink(oldRole, newRole) {
    if (!oldRole || !newRole || !newRole.guild) return false;
    try {
        await newRole.edit({
            name: oldRole.name,
            color: oldRole.color,
            hoist: oldRole.hoist,
            permissions: oldRole.permissions,
            mentionable: oldRole.mentionable,
            icon: oldRole.icon ?? null,
            unicodeEmoji: oldRole.unicodeEmoji ?? null
        }, 'Protection: revert unauthorized role link/tags change');
        return true;
    } catch (error) {
        console.error(`❌ فشل استرجاع خصائص الرول بعد محاولة ربط غير مصرح (${newRole.id}):`, error);
        return false;
    }
}

async function hardRecoverRoleFromLink(oldRole, newRole) {
    if (!oldRole || !newRole || !newRole.guild) return null;
    const guild = newRole.guild;
    const compromisedRoleId = newRole.id;
    try {
        const roleMembers = guild.members.cache.filter(member => member.roles.cache.has(compromisedRoleId));
        const desiredPosition = oldRole.rawPosition;
        const restoredRole = await guild.roles.create({
            name: oldRole.name,
            color: oldRole.color,
            hoist: oldRole.hoist,
            permissions: oldRole.permissions?.bitfield ?? oldRole.permissions,
            mentionable: oldRole.mentionable,
            icon: oldRole.icon ?? null,
            unicodeEmoji: oldRole.unicodeEmoji ?? null,
            reason: 'Protection hard-recovery: replace linked/managed role'
        }).catch(() => null);

        if (!restoredRole) return null;

        await Promise.allSettled(roleMembers.map(async (member) => {
            await member.roles.add(restoredRole, 'Protection hard-recovery: restore unlinked role').catch(() => null);
            await member.roles.remove(compromisedRoleId, 'Protection hard-recovery: remove linked role').catch(() => null);
        }));

        await newRole.delete('Protection hard-recovery: delete compromised linked role').catch(() => null);
        await restoredRole.setPosition(desiredPosition).catch(() => null);
        return restoredRole;
    } catch (error) {
        console.error(`❌ فشل الاسترجاع الصارم للرول بعد الربط (${newRole.id}):`, error);
        return null;
    }
}

async function handleUnauthorizedRoleLink(oldRole, newRole) {
    const diff = getRoleSecurityDiff(oldRole, newRole);
    if (!diff) return;

    console.log(`🚨 تم رصد محاولة ربط رول مشبوهة: ${newRole.name} (${newRole.id})`);
    const executorPromise = resolveRoleLinkExecutorWithRetry(newRole.guild, newRole.id);
    const restored = await restoreRoleAfterUnauthorizedLink(oldRole, newRole);
    const refreshedRole = await newRole.guild.roles.fetch(newRole.id).catch(() => null);
    const stillLinked = hasRoleLinkIndicators(refreshedRole || newRole);

    if (stillLinked) {
        console.warn(`⚠️ الرول ${newRole.name} لا يزال يحتوي مؤشرات ربط بعد الاسترجاع.`);
    } else if (restored) {
        console.log(`✅ تم استرجاع الرول ${newRole.name} إلى حالته السابقة وإزالة الربط.`);
    }

    const connectionName = diff.hasGuildConnections ? 'guildConnections' : 'غير معروف';
    let activeRole = refreshedRole || newRole;
    const incidentSteps = [];
    incidentSteps.push(`تم اكتشاف ربط مشبوه على الرول ${newRole.name} (${newRole.id}).`);

    if (stillLinked) {
        const replacedRole = await hardRecoverRoleFromLink(oldRole, newRole);
        if (replacedRole) {
            activeRole = replacedRole;
            incidentSteps.push(`تم حذف الرول المخترق وإنشاء رول بديل: ${replacedRole.name} (${replacedRole.id}) بنفس الترتيب ${replacedRole.rawPosition}.`);
            console.log(`✅ تم تنفيذ استرجاع صارم وإنشاء رول بديل آمن: ${replacedRole.name} (${replacedRole.id})`);
        } else {
            incidentSteps.push('تعذر تنفيذ الاسترجاع الصارم للرول.');
        }
    } else {
        incidentSteps.push('تمت إعادة خصائص الرول مباشرة بدون الحاجة للحذف.');
    }

    const executorInfo = await executorPromise;
    const executor = executorInfo?.user || null;
    if (!executor || executor.id === newRole.client.user.id) {
        console.warn(`⚠️ تعذر تحديد منفذ الربط للرول ${newRole.name} (${newRole.id}) من سجلات التدقيق.`);
        incidentSteps.push('تعذر تحديد الفاعل من سجلات التدقيق.');
        await notifyGuildOwnerAboutRoleLinkIncident(newRole.guild, activeRole, null, connectionName, 'لم يحدث شي', incidentSteps.join('\n'));
        return;
    }

    const member = await newRole.guild.members.fetch(executor.id).catch(() => null);
    if (!member || !member.kickable) {
        console.warn(`⚠️ تعذر طرد منفذ الربط ${executor.tag} (${executor.id}) لعدم وجود صلاحيات كافية.`);
        incidentSteps.push(`تم تحديد الفاعل: ${executor.tag} (${executor.id}) ولكن تعذر طرده بسبب الصلاحيات.`);
        await notifyGuildOwnerAboutRoleLinkIncident(newRole.guild, activeRole, executor, connectionName, 'لم يحدث شي', incidentSteps.join('\n'));
        return;
    }

    await member.kick(`Unauthorized role link/tags update on role ${newRole.name} (${newRole.id})`).catch((error) => {
        console.error(`❌ فشل طرد منفذ الربط ${executor.tag} (${executor.id}):`, error);
    });
    incidentSteps.push(`تم تحديد الفاعل: ${executor.tag} (${executor.id}) وتم طرده.`);
    await notifyGuildOwnerAboutRoleLinkIncident(newRole.guild, activeRole, executor, connectionName, 'طرد', incidentSteps.join('\n'));
}

async function getRecentRoleUpdateExecutor(guild, targetUserId, roleId, actionType = 'add') {
    if (!guild || !targetUserId || !roleId) return null;
    try {
        const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 8 }).catch(() => null);
        if (!logs) return null;
        const now = Date.now();
        const changeKey = actionType === 'remove' ? '$remove' : '$add';
        let bestMatch = null;

        for (const entry of logs.entries.values()) {
            if (!entry?.target || String(entry.target.id) !== String(targetUserId)) continue;
            const createdTimestamp = entry.createdTimestamp || 0;
            if ((now - createdTimestamp) > 15000) continue;

            const hasRole = (entry.changes || []).some(change => (
                change?.key === changeKey &&
                (
                    (Array.isArray(change.new) && change.new.some(item => String(item?.id) === String(roleId))) ||
                    (Array.isArray(change.old) && change.old.some(item => String(item?.id) === String(roleId)))
                )
            ));
            if (!hasRole) continue;

            const currentMatch = {
                executor: entry.executor || null,
                reason: entry.reason || '',
                createdTimestamp
            };
            if (!bestMatch || currentMatch.createdTimestamp > bestMatch.createdTimestamp) {
                bestMatch = currentMatch;
            }
        }
        if (bestMatch) return bestMatch;
    } catch (error) {
        console.error('❌ خطأ في قراءة Audit Logs لتغييرات الرولات الخاصة:', error?.message || error);
    }
    return null;
}

async function notifyPrivateRoleMemberChange({ member, role, roleEntry, executor, action = 'add' }) {
    if (!member?.user || member.user.bot || !role || !roleEntry) return;
    const actionText = action === 'remove' ? '**تم ازالتك من رول خاص**' : '**تم اضافتك لرول خاص**';
    const ownerText = roleEntry.ownerId ? `<@${roleEntry.ownerId}>` : '**غير معروف**';
    const byText = executor ? `<@${executor.id}>` : '**غير معروف**';
        const roleName = role?.name || roleEntry?.name || roleEntry?.roleName || `Role (${roleEntry.roleId || role?.id || 'N/A'})`;
    const roleMention = role?.id ? `<@&${role.id}>` : (roleEntry?.roleId ? `<@&${roleEntry.roleId}>` : null);
    const roleText = roleMention ? `**${roleName}**` : `**${roleName}**`;
    const unixTime = Math.floor(Date.now() / 1000);
    const timeText = `**<t:${unixTime}:F> • <t:${unixTime}:R>**`;
    const avatar = executor?.displayAvatarURL?.({ size: 256 }) || member.guild.members.me?.displayAvatarURL?.({ size: 256 }) || null;

    const embed = new EmbedBuilder()
        .setTitle('Private Role')
        .setDescription(
            `${actionText}\n` +
            `*By :* ${byText}\n` +
            `*Role* : ${roleText}\n` +
            `*Role Owner :* ${ownerText}\n` +
            `*Time* : ${timeText}`
        )
        .setColor(colorManager.getColor ? colorManager.getColor() : (action === 'remove' ? '#e74c3c' : '#2ecc71'))
        .setTimestamp();
    if (avatar) {
        embed.setThumbnail(avatar);
    }

    await member.send({ embeds: [embed] }).catch(() => {});
}

async function sweepBotsFromSpecialRoles(clientInstance) {
    if (!clientInstance) return;
    for (const guild of clientInstance.guilds.cache.values()) {
        const entries = getGuildRoles(guild.id);
        for (const roleEntry of entries) {
            const role = guild.roles.cache.get(roleEntry.roleId) || await guild.roles.fetch(roleEntry.roleId).catch(() => null);
            if (!role) continue;
            for (const member of role.members.values()) {
                if (!member.user?.bot) continue;
                await member.roles.remove(role, 'منع وجود بوتات داخل الرولات الخاصة').catch(() => {});
            }
        }
    }
}
// دالة لقراءة ملف JSON
function readJSONFile(filePath, defaultValue = {}) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            if (!data || data.trim() === '') return defaultValue;
            return JSON.parse(data);
        }
        return defaultValue;
    } catch (error) {
        console.error(`خطأ في قراءة ${filePath}:`, error.message);
        // If file is corrupted, return default value
        return defaultValue;
    }
}

// دالة لكتابة ملف JSON
function writeJSONFile(filePath, data) {
    try {
        const serialized = JSON.stringify(data, null, 2);
        if (filePath === DATA_FILES.botConfig) {
            writeBotConfigFile(filePath, data);
        } else {
            fs.writeFileSync(filePath, serialized);
        }
        return true;
    } catch (error) {
        if (filePath === DATA_FILES.botConfig) {
            try { fs.unlinkSync(`${filePath}.tmp`); } catch (_) {}
        }
        console.error(`خطأ في كتابة ${filePath}:`, error);
        return false;
    }
}

const RESPONSIBILITY_LEAVE_LIMIT_MS = 6 * 60 * 60 * 1000;

function getResponsibilityLeaveTracker() {
    const tracker = readJSONFile(DATA_FILES.responsibilityLeaveTracker, { guilds: {} });
    if (!tracker.guilds || typeof tracker.guilds !== 'object') tracker.guilds = {};
    return tracker;
}

function saveResponsibilityLeaveTracker(tracker) {
    writeJSONFile(DATA_FILES.responsibilityLeaveTracker, tracker || { guilds: {} });
}

async function updateResponsibilitiesEmbedForGuild(guildId) {
    try {
        const respCommand = client.commands?.get('resp');
        if (respCommand && typeof respCommand.updateEmbedMessage === 'function') {
            await respCommand.updateEmbedMessage(client, guildId);
        }
    } catch (error) {
        console.error('❌ خطأ في تحديث ايمبد المسؤوليات:', error?.message || error);
    }
}

async function removeInactiveResponsiblesForGuild(guild, now = Date.now()) {
    if (!guild) return false;
    const guildId = guild.id;
    const tracker = getResponsibilityLeaveTracker();
    if (!tracker.guilds[guildId]) tracker.guilds[guildId] = { leftAtByUser: {}, removedByUser: {} };
    const guildTracker = tracker.guilds[guildId];
    guildTracker.leftAtByUser = guildTracker.leftAtByUser || {};
    guildTracker.removedByUser = guildTracker.removedByUser || {};

    const responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
    let changed = false;

    for (const [userId, leftAtRaw] of Object.entries(guildTracker.leftAtByUser)) {
        const leftAt = Number(leftAtRaw || 0);
        if (!leftAt || (now - leftAt) < RESPONSIBILITY_LEAVE_LIMIT_MS) continue;

        const removedFrom = [];
        for (const [respName, respData] of Object.entries(responsibilities)) {
            if (!Array.isArray(respData?.responsibles) || !respData.responsibles.includes(userId)) continue;
            respData.responsibles = respData.responsibles.filter((id) => String(id) !== String(userId));
            removedFrom.push(respName);
            changed = true;
        }

        if (removedFrom.length > 0) {
            guildTracker.removedByUser[userId] = {
                leftAt,
                removedAt: now,
                responsibilities: removedFrom
            };
            console.log(`🧹 تمت إزالة ${userId} من المسؤوليات بعد 6h خارج السيرفر (${guildId})`);
        }
        delete guildTracker.leftAtByUser[userId];
    }

    if (changed) {
        writeJSONFile(DATA_FILES.responsibilities, responsibilities);
        global.responsibilities = responsibilities;
        await updateResponsibilitiesEmbedForGuild(guildId);
        client.emit('responsibilityUpdate');
    }

    saveResponsibilityLeaveTracker(tracker);
    return changed;
}

async function removeMemberFromResponsibilityAssignmentsOnLeave(member) {
    if (!member?.guild?.id || !member.id) return { responsibilities: [], supervisors: [] };
    const guildId = member.guild.id;
    const userId = String(member.id);
    const responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
    const removedResponsibilities = [];
    for (const [name, config] of Object.entries(responsibilities)) {
        if (!Array.isArray(config?.responsibles)) continue;
        const next = config.responsibles.map(String).filter(id => id !== userId);
        if (next.length !== config.responsibles.length) {
            config.responsibles = next;
            removedResponsibilities.push(name);
        }
    }
    const removedSupervisors = removeUserFromAllSupervisors(guildId, userId);
    if (removedResponsibilities.length) {
        writeJSONFile(DATA_FILES.responsibilities, responsibilities);
        global.responsibilities = responsibilities;
        if (dbManager.isInitialized) {
            for (const name of removedResponsibilities) {
                await dbManager.updateResponsibility(name, responsibilities[name]).catch(error =>
                    console.error(`تعذر حفظ إزالة مسؤولية العضو ${userId} من قاعدة البيانات:`, error.message));
            }
        }
    }
    if (removedResponsibilities.length || removedSupervisors.length) {
        await updateResponsibilitiesEmbedForGuild(guildId);
        client.emit('responsibilityUpdate');
    }
    return { responsibilities: removedResponsibilities, supervisors: removedSupervisors };
}

// تحميل البيانات مباشرة من قاعدة البيانات والملفات
const { dbManager } = require('./utils/database.js');
const ticketState = require('./commands/ticket.js');
let points = ticketState.loadPoints();
global.responsibilities = {};


async function safeInitializeMainDatabase(scope = 'startup', timeoutMs = Number(process.env.DB_INIT_TIMEOUT_MS || 15000)) {
    if (dbManager.isInitialized) return true;

    const initPromise = dbManager.initialize();
    initPromise.catch((error) => {
        console.error(`⚠️ فشل تهيئة قاعدة البيانات لاحقاً (${scope})، سيستمر البوت:`, error.message || error);
    });

    const result = await Promise.race([
        initPromise.then(() => true).catch(() => false),
        new Promise(resolve => setTimeout(() => resolve(false), timeoutMs))
    ]);

    if (!result) {
        console.warn(`⚠️ قاعدة البيانات لم تجهز خلال ${timeoutMs}ms في ${scope}. سيكمل البوت التشغيل من JSON/الذاكرة حتى يعمل التكت.`);
    }
    return result;
}

let logConfig = readJSONFile(DATA_FILES.logConfig, {
    settings: {
        'RESPONSIBILITY_MANAGEMENT': { enabled: false, channelId: null },
        'RESPONSIBLE_MEMBERS': { enabled: false, channelId: null },
        'TASK_LOGS': { enabled: false, channelId: null },
        'POINT_SYSTEM': { enabled: false, channelId: null },
        'ADMIN_ACTIONS': { enabled: false, channelId: null },
        'NOTIFICATION_SYSTEM': { enabled: false, channelId: null },
        'COOLDOWN_SYSTEM': { enabled: false, channelId: null },
        'SETUP_ACTIONS': { enabled: false, channelId: null },
        'BOT_SETTINGS': { enabled: false, channelId: null },
        'ADMIN_CALLS': { enabled: false, channelId: null }
    }
});

// تحميل ADMIN_ROLES من JSON مباشرة
function loadAdminRoles() {
    try {
        const adminRolesData = readJSONFile(DATA_FILES.adminRoles, []);
        return Array.isArray(adminRolesData) ? adminRolesData : [];
    } catch (error) {
        console.error('خطأ في تحميل adminRoles:', error);
        return [];
    }
}

const memberRefreshInFlight = new Map();

function releaseMemberRefreshSlot() {
    const nextWaiter = memberRefreshWaiters.shift();
    if (nextWaiter) {
        clearTimeout(nextWaiter.timer);
        nextWaiter.resolve(true);
    } else {
        activeMemberRefreshes = Math.max(0, activeMemberRefreshes - 1);
    }
}

async function acquireMemberRefreshSlot() {
    if (activeMemberRefreshes < MAX_CONCURRENT_MEMBER_REFRESHES) {
        activeMemberRefreshes += 1;
        return true;
    }
    if (memberRefreshWaiters.length >= MAX_QUEUED_MEMBER_REFRESHES) return false;
    return new Promise(resolve => {
        const waiter = { resolve, timer: null };
        waiter.timer = setTimeout(() => {
            const index = memberRefreshWaiters.indexOf(waiter);
            if (index !== -1) {
                memberRefreshWaiters.splice(index, 1);
                resolve(false);
            }
        }, MEMBER_REFRESH_QUEUE_TIMEOUT_MS);
        memberRefreshWaiters.push(waiter);
    });
}

async function fetchGuildMemberWithLimit(guild, userId) {
    if (!await acquireMemberRefreshSlot()) return null;
    let releaseWhenNetworkSettles = true;
    let timeoutTimer = null;
    const request = Promise.resolve()
        .then(() => guild.members.fetch({ user: userId, force: true }))
        .then(member => ({ member: member || null }), () => ({ member: null }));
    try {
        const timedOut = Symbol('member-fetch-timeout');
        const outcome = await Promise.race([
            request,
            new Promise(resolve => { timeoutTimer = setTimeout(() => resolve(timedOut), MEMBER_REFRESH_FETCH_TIMEOUT_MS); })
        ]);
        if (outcome === timedOut) {
            releaseWhenNetworkSettles = false;
            request.finally(releaseMemberRefreshSlot);
            return null;
        }
        return outcome.member;
    } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (releaseWhenNetworkSettles) releaseMemberRefreshSlot();
    }
}

async function refreshMessageMember(message) {
    if (!message?.guild || !message.author?.id) return message?.member || null;
    const key = `${message.guild.id}:${message.author.id}`;
    let refreshPromise = memberRefreshInFlight.get(key);
    if (!refreshPromise) {
        const now = Date.now();
        const lastAttempt = Number(memberRefreshAttemptAt.get(key) || 0);
        if (now - lastAttempt < MEMBER_REFRESH_RETRY_MS) return message.member || null;
        setBoundedMapEntry(memberRefreshAttemptAt, key, now);
        refreshPromise = fetchGuildMemberWithLimit(message.guild, message.author.id);
        memberRefreshInFlight.set(key, refreshPromise);
    }
    const freshMember = await refreshPromise;
    if (memberRefreshInFlight.get(key) === refreshPromise) memberRefreshInFlight.delete(key);
    if (freshMember) message.member = freshMember;
    return freshMember || message.member || null;
}

let botConfig = readJSONFile(DATA_FILES.botConfig, {
    prefix: null,
    settings: {},
});

// لا نحتاج لمتغيرات محلية لـ cooldowns و notifications
// سيتم قراءتها مباشرة من الملفات عند الحاجة

// لا نحتاج لمتغير محلي للبريفكس - سنقرأه مباشرة من JSON

function buildGatewayIntents() {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
  ];

  const disabledPrivileged = String(process.env.DISABLE_PRIVILEGED_INTENTS || '').toLowerCase() === 'true';
  if (!disabledPrivileged) {
    intents.push(GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers);
  }

  const enablePresence = String(process.env.ENABLE_PRESENCE_INTENT || '').toLowerCase() === 'true';
  if (enablePresence && !disabledPrivileged) {
    intents.push(GatewayIntentBits.GuildPresences);
  }

  return intents;
}

const client = new Client({
  intents: buildGatewayIntents(),
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// تعريف client كمتغير عام للوصول من الأنظمة الأخرى
global.client = client;
client.shortcutRequests = new Map(Object.entries(shortcutStore.requests || {}));
client.on('responsibilityUpdate', invalidateShortcutMatcherCache);

function pruneRuntimeShortcutRequests(force = false) {
  const now = Date.now();
  if (!force && client.shortcutRequests.size <= MAX_SHORTCUT_REQUESTS) return;
  const cutoff = now - SHORTCUT_REQUEST_RETENTION_MS;
  let changed = false;
  for (const [token, request] of client.shortcutRequests) {
    if (!request || Number(request.createdAt || 0) < cutoff) {
      client.shortcutRequests.delete(token);
      delete shortcutStore.requests[token];
      changed = true;
    }
  }
  if (client.shortcutRequests.size > MAX_SHORTCUT_REQUESTS) {
    const oldestFirst = [...client.shortcutRequests.entries()]
      .sort((a, b) => Number(a[1]?.createdAt || 0) - Number(b[1]?.createdAt || 0));
    const targetSize = Math.max(0, MAX_SHORTCUT_REQUESTS - 500);
    const excess = client.shortcutRequests.size - targetSize;
    for (const [token] of oldestFirst.slice(0, excess)) {
      client.shortcutRequests.delete(token);
      delete shortcutStore.requests[token];
      changed = true;
    }
  }
  if (changed) shortcutStateStore.saveShortcutStore();
}
function findActiveShortcutRequest(guildId, responsibilityName, now = Date.now()) {
    const cutoff = now - SHORTCUT_REQUEST_COOLDOWN_MS;
    for (const request of client.shortcutRequests.values()) {
        if (String(request?.guildId) !== String(guildId)) continue;
        if (String(request?.responsibilityName) !== String(responsibilityName)) continue;
        if (Number(request?.createdAt || 0) < cutoff) continue;
        return request;
    }
    return null;
}
function startShortcutRequestCollector(sentMessage, requestToken) {
    const collector = sentMessage.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: SHORTCUT_REQUEST_COOLDOWN_MS
    });
    collector.on('end', async () => {
        const request = client.shortcutRequests.get(requestToken);
        if (!request || request.messageId !== sentMessage.id) return;
        const disabledRows = sentMessage.components.map(row => new ActionRowBuilder().addComponents(
            row.components.map(component => ButtonBuilder.from(component).setDisabled(true))
        ));
        await sentMessage.edit({ components: disabledRows }).catch(error => {
            console.error('تعذر تعطيل أزرار اختصار المسؤولية بعد انتهاء المهلة:', error.message);
        });
    });
    return collector;
}
const shortcutRequestCleanupTimer = setInterval(() => pruneRuntimeShortcutRequests(true), 60 * 60 * 1000);
shortcutRequestCleanupTimer.unref?.();

// استخدام نظام المهام النشطة من masoul.js
// نظام تتبع الجلسات الصوتية
if (!client.voiceSessions) {
  client.voiceSessions = new Map();
}

function loadVoiceSessionsFromDisk() {
    try {
        const storedSessions = readJSONFile(DATA_FILES.voiceSessions, {});
        for (const [userId, session] of Object.entries(storedSessions)) {
            if (!session || !session.channelId || !session.sessionStartTime) continue;
            client.voiceSessions.set(userId, {
                channelId: session.channelId,
                channelName: session.channelName || 'روم غير معروفة',
                sessionStartTime: session.sessionStartTime,
                startTime: session.startTime || session.sessionStartTime,
                lastTrackedTime: session.lastTrackedTime || session.sessionStartTime,
                isAFK: Boolean(session.isAFK),
                afkSince: session.afkSince || null
            });
        }
        console.log(`✅ تم تحميل ${client.voiceSessions.size} جلسة صوتية من JSON`);
    } catch (error) {
        console.error('❌ خطأ في تحميل الجلسات الصوتية:', error);
    }
}

function saveVoiceSessionsToDisk() {
    try {
        const sessions = {};
        for (const [userId, session] of client.voiceSessions.entries()) {
            sessions[userId] = {
                channelId: session.channelId,
                channelName: session.channelName,
                sessionStartTime: session.sessionStartTime,
                startTime: session.startTime,
                lastTrackedTime: session.lastTrackedTime,
                isAFK: session.isAFK,
                afkSince: session.afkSince || null
            };
        }
        writeJSONFile(DATA_FILES.voiceSessions, sessions);
    } catch (error) {
        console.error('❌ خطأ في حفظ الجلسات الصوتية:', error);
    }
}

loadVoiceSessionsFromDisk();

// إعداد قائمة مالكي البوت من owners.json مع ترحيل تلقائي للقائمة القديمة من botConfig/env
let BOT_OWNERS = [];
let BOT_OWNER_ROLES = [];
const storedOwners = loadOwners();
const legacyOwners = normalizeIds(botConfig.owners);
const envOwners = normalizeIds(String(process.env.BOT_OWNERS || process.env.OWNER_ID || '')
    .split(/[\s,;]+/).map(id => id.replace(/[<@!>]/g, '').trim()));
if (!storedOwners.users.length && !storedOwners.roles.length && (legacyOwners.length || envOwners.length)) {
    const migrated = saveOwners({ users: legacyOwners.length ? legacyOwners : envOwners, roles: [] });
    BOT_OWNERS = [...migrated.users];
    console.log('✅ تم ترحيل الأونرات إلى owners.json:', BOT_OWNERS);
} else {
    BOT_OWNERS = [...storedOwners.users];
    BOT_OWNER_ROLES = [...storedOwners.roles];
    console.log('✅ تم تحميل الأونرات من owners.json:', { users: BOT_OWNERS, roles: BOT_OWNER_ROLES });
}
if (Object.prototype.hasOwnProperty.call(botConfig, 'owners')) {
    delete botConfig.owners;
    writeJSONFile(DATA_FILES.botConfig, botConfig);
}
global.BOT_OWNERS = BOT_OWNERS;
global.BOT_OWNER_ROLES = BOT_OWNER_ROLES;

function isBotOwner(memberOrUser) {
    const member = memberOrUser?.roles ? memberOrUser : null;
    const userId = String(memberOrUser?.id || memberOrUser?.user?.id || '');
    return BOT_OWNERS.includes(userId) || (member && BOT_OWNER_ROLES.some(roleId => member.roles.cache.has(roleId)));
}

// دالة لإعادة تحميل BOT_OWNERS من الملف
function reloadBotOwners() {
    try {
        const currentOwners = loadOwners();
        BOT_OWNERS = [...currentOwners.users];
        BOT_OWNER_ROLES = [...currentOwners.roles];
        global.BOT_OWNERS = BOT_OWNERS;
        global.BOT_OWNER_ROLES = BOT_OWNER_ROLES;
        console.log('🔄 تم إعادة تحميل الأونرات:', { users: BOT_OWNERS, roles: BOT_OWNER_ROLES });
        return true;
    } catch (error) {
        console.error('❌ خطأ في إعادة تحميل المالكين:', error);
        return false;
    }
}

// دالة لتحديث BOT_OWNERS العالمي
function updateBotOwners(newOwners) {
    try {
        if (Array.isArray(newOwners)) {
            console.log('🔄 تحديث المالكين من:', BOT_OWNERS, 'إلى:', newOwners);

            // التحقق من صحة المعرفات
            const validOwners = newOwners.filter(id => typeof id === 'string' && /^\d{17,19}$/.test(id));

            if (validOwners.length !== newOwners.length) {
                console.warn('⚠️ تم تجاهل معرفات غير صحيحة:', newOwners.filter(id => !validOwners.includes(id)));
            }

            // تحديث المصفوفة المحلية والعالمية
            BOT_OWNERS.length = 0;
            BOT_OWNERS.push(...validOwners);
            global.BOT_OWNERS = BOT_OWNERS;

            // تحديث owners.json مع الحفاظ على أدوار الأونر
            saveOwners({ users: BOT_OWNERS, roles: BOT_OWNER_ROLES });

            console.log('✅ تم تحديث قائمة المالكين العالمية والدائمة بنجاح:', BOT_OWNERS);
            return true;
        } else {
            console.error('❌ المدخل ليس مصفوفة:', typeof newOwners);
            return false;
        }
    } catch (error) {
        console.error('❌ خطأ في تحديث المالكين العالمي:', error);
        return false;
    }
}

// Make the functions available globally
global.reloadBotOwners = reloadBotOwners;
global.updateBotOwners = updateBotOwners;
global.updateBotOwnerRoles = function updateBotOwnerRoles(newRoles) {
    const validRoles = normalizeIds(newRoles);
    BOT_OWNER_ROLES = validRoles;
    global.BOT_OWNER_ROLES = BOT_OWNER_ROLES;
    saveOwners({ users: BOT_OWNERS, roles: BOT_OWNER_ROLES });
    return true;
};
global.isBotOwner = isBotOwner;

client.commands = new Collection();
client.logConfig = logConfig;



// Load commands from the "commands" folder
const commandsPath = path.join(__dirname, 'commands');
const DISABLED_COMMAND_FILES = new Set(['masoul.js', 'backup.js', 'report.js', 'call.js', 'protection.js', 'notifications.js', 'cooldown.js']);
const commandFiles = fs.readdirSync(commandsPath)
  .filter(file => file.endsWith('.js') && !DISABLED_COMMAND_FILES.has(file));

for (const file of commandFiles) {
  try {
    const command = require(path.join(commandsPath, file));
    if ('name' in command && 'execute' in command && !command.hidden) {
      client.commands.set(command.name, command);
      console.log(`Loaded command: ${command.name}`);
if (command.aliases && Array.isArray(command.aliases)) {
        for (const alias of command.aliases) {
          client.commands.set(alias, command);
          console.log(`  ↳ Alias: ${alias}`);
        }
      }
      // تسجيل معالج التفاعلات المستقل للأوامر التي توفره
      if (typeof command.registerInteractionHandler === 'function') {
        command.registerInteractionHandler(client);
        console.log(`  ↳ Registered interaction handler for: ${command.name}`);
      }
    }
  } catch (error) {
    console.error(`Error loading command ${file}:`, error);
  }
}

// تسجيل سجل الداون العام بشكل صريح لضمان توفر الأمر باسم "داونات"
try {
  const allDownsHistoryCommand = require('./commands/all-downs-history.js');
  client.commands.set('داونات', allDownsHistoryCommand);
  console.log('Loaded command explicitly: داونات');
} catch (error) {
  console.error('Error loading command داونات:', error);
}

// تسجيل معالجات setroom المستقلة
try {
  const setroomCommand = require('./commands/setroom.js');
  if (setroomCommand.registerHandlers) {
    setroomCommand.registerHandlers(client);
  }

  // استعادة الجدولات المحفوظة عند بدء البوت
  if (setroomCommand.restoreSchedules) {
    setTimeout(async () => {
      try {
        await setroomCommand.restoreSchedules(client);
        console.log('✅ تم فحص واستعادة جدولات الغرف');
      } catch (error) {
        console.error('❌ فشل فحص واستعادة جدولات الغرف:', error);
      }
    }, 3000); // انتظار 3 ثواني لضمان جاهزية البوت
  }

  // تشغيل نظام الحذف التلقائي للرسائل (يحذف كل الرسائل ويرسل الإيمبد كل 3 دقائق)
  if (setroomCommand.startAutoMessageDeletion) {
    setTimeout(() => {
      setroomCommand.startAutoMessageDeletion(client);
    }, 15000); // بدء بعد 15 ثانية من تشغيل البوت
  }
} catch (error) {
  console.error('❌ خطأ في تسجيل معالجات setroom:', error);
}

// تسجيل معالجات نظام التذاكر (settings menus)
try {
  const ticketSettingsCommand = require('./commands/settings.js');
  if (ticketSettingsCommand.registerHandlers) {
    ticketSettingsCommand.registerHandlers(client);
console.log('✅ تم تسجيل معالجات إعدادات التذاكر (settings)');

  }

  const ticketCommand = require('./commands/ticket.js');

  if (ticketCommand.registerHandlers) {

    ticketCommand.registerHandlers(client);

    console.log('✅ تم تسجيل معالجات نظام ticket');  }
} catch (error) {
  console.error('❌ خطأ في تسجيل معالجات نظام التذاكر:', error);
}

  // تسجيل معالج setactive ونظام الرولات التفاعلية
  try {

    const setactiveCommand = require('./commands/setactive.js');

    interactiveRolesManager = require('./utils/interactiveRolesManager.js');

    

    

  } catch (error) {

    console.error('❌ خطأ في تسجيل نظام الرولات التفاعلية:', error);

  }

let isDataDirty = false;

let saveTimeout = null;

// Cache للبيانات المستخدمة بكثرة
const dataCache = {
    prefix: null,
    adminRoles: [],
    lastUpdate: 0,
    adminRolesUpdatedAt: 0,
    cacheDuration: 30000 // 30 ثانية
};

const topCommand = require('./commands/top_leaderboard.js');
const topsCommand = require('./commands/tops.js');

// دالة لوضع علامة للحفظ مع تأخير ذكي
function scheduleSave() {
    isDataDirty = true;

    // إلغاء المؤقت السابق إذا كان موجوداً
    if (saveTimeout) {
        clearTimeout(saveTimeout);
    }

    // تأخير الحفظ لتجميع التغييرات
    saveTimeout = setTimeout(() => {
        saveData();
        saveTimeout = null;
    }, 2000); // حفظ بعد ثانيتين من آخر تغيير

    if (topCommand.invalidateTopCache) {
        topCommand.invalidateTopCache();
    }
    if (topsCommand.invalidateTopsCache) {
        topsCommand.invalidateTopsCache();
    }
}

// دالة حفظ محسنة - أسرع وأقل استهلاك مع استخدام الحفظ غير المتزامن
async function saveData(force = false) {
    if (!isDataDirty && !force) {
        return false;
    }

    try {
        // قراءة وحفظ بشكل غير متزامن لتجنب حظر المعالج
        const currentBotConfig = readJSONFile(DATA_FILES.botConfig, {});
        
        botConfig = {
            ...currentBotConfig,
            prefix: botConfig.prefix !== undefined ? botConfig.prefix : currentBotConfig.prefix,
            settings: botConfig.settings || currentBotConfig.settings,
        };

        // استبدال ذري يمنع أي أمر من قراءة ملف إعدادات فارغ أو مبتور.
        writeBotConfigFile(DATA_FILES.botConfig, botConfig);
        
        // تنفيذ الحفظ بشكل متوازي وغير متزامن
        const dbPromises = [];
        if (dbManager.isInitialized) {
            for (const [name, config] of Object.entries(global.responsibilities)) {
                dbPromises.push(dbManager.updateResponsibility(name, config));
            }
        }

        await Promise.all([
            ...dbPromises,
            fs.promises.writeFile(DATA_FILES.logConfig, JSON.stringify(client.logConfig || logConfig, null, 2))
        ]);

        isDataDirty = false;
        return true;
    } catch (error) {
        console.error('❌ خطأ في حفظ البيانات:', error);
        return false;
    }
}

// دالة للحصول على البريفكس من الكاش
function getCachedPrefix() {
    const now = Date.now();
    if (dataCache.prefix !== null && (now - dataCache.lastUpdate) < dataCache.cacheDuration) {
        return dataCache.prefix;
    }

    // تحديث الكاش
    const currentBotConfig = readJSONFile(DATA_FILES.botConfig, {});
    let prefix = currentBotConfig.prefix;

    if (prefix && typeof prefix === 'string' && prefix.startsWith('"') && prefix.endsWith('"')) {
        prefix = prefix.slice(1, -1);
    }

    dataCache.prefix = prefix;
    dataCache.lastUpdate = now;
    return prefix;
}

// دالة للفحص التلقائي للترقيات
async function checkAutoLevelUp(userId, type, client) {
    try {
        const checkKey = `${String(userId)}:${String(type)}`;
        const now = Date.now();
        if (now - Number(autoLevelCheckAt.get(checkKey) || 0) < 30 * 1000) return;
        setBoundedMapEntry(autoLevelCheckAt, checkKey, now, 20000);

        const { getDatabase, getUserLevel, updateUserLevel, updateLastNotified } = require('./utils/database');
        const dbManager = getDatabase();

        // جلب الإحصائيات الحالية
        const userStats = await dbManager.getUserStats(userId);
        if (!userStats) return;

        // حساب المستويات الحالية باستخدام الملي ثانية مباشرة
        // 1 XP = 5 دقائق = 300,000 ملي ثانية
        const voiceXP = Math.floor(userStats.totalVoiceTime / 300000); 
        const chatXP = Math.floor(userStats.totalMessages / 10); // 10 رسائل = 1 XP
        
        const currentVoiceLevel = Math.floor(Math.sqrt(voiceXP / 100));
        const currentChatLevel = Math.floor(Math.sqrt(chatXP / 100));

        // جلب المستوى السابق
        const previousLevel = await getUserLevel(userId);
        const oldVoiceLevel = previousLevel.voice_level || 0;
        const oldChatLevel = previousLevel.chat_level || 0;
        const lastNotified = previousLevel.last_notified || 0;
        const isNewUser = (oldVoiceLevel === 0 && oldChatLevel === 0 && lastNotified === 0);

        // التحقق من وجود ترقية حقيقية (يجب أن يكون اللفل الجديد أكبر من القديم)
        // نستخدم Math.floor للتأكد من أننا نقارن الأرقام الصحيحة للمستويات فقط
        const hasVoiceLevelUp = currentVoiceLevel > oldVoiceLevel;
        const hasChatLevelUp = currentChatLevel > oldChatLevel;

        // إذا لم يرتفع المستوى (الرقم الصحيح)، نحدث البيانات في القاعدة بصمت ونخرج
        if (!hasVoiceLevelUp && !hasChatLevelUp) {
            // تحديث المستويات في القاعدة إذا كان هناك تغيير في الـ XP (بصمت)
            if (currentVoiceLevel !== oldVoiceLevel || currentChatLevel !== oldChatLevel) {
                await updateUserLevel(userId, currentVoiceLevel, currentChatLevel);
            }
            return;
        }

        // منع الإرسال للمستخدمين الجدد عند أول نشاط (لفل 0) أو إذا كان المستوى الجديد 0
        if (isNewUser || (currentVoiceLevel === 0 && !hasChatLevelUp && oldVoiceLevel === 0) || (currentChatLevel === 0 && !hasVoiceLevelUp && oldChatLevel === 0)) {
            await updateUserLevel(userId, currentVoiceLevel, currentChatLevel);
            // لا نحدث lastNotified هنا لنسمح بأول ترقية حقيقية لاحقاً
            return;
        }

        // التحقق من عدم إرسال إشعارات متكررة (تجنب الإرسال أكثر من مرة كل دقيقة)
        const timeSinceLastNotification = Date.now() - lastNotified;
        if (timeSinceLastNotification < 60000) {
            await updateUserLevel(userId, currentVoiceLevel, currentChatLevel);
            return;
        }

        // تحديث المستوى ووقت آخر إشعار أولاً لمنع التكرار في حال فشل الإرسال
        await updateUserLevel(userId, currentVoiceLevel, currentChatLevel);
        await updateLastNotified(userId);

        // إرسال إشعار الترقية
        const profileCommand = require('./commands/profile.js');
        if (profileCommand && typeof profileCommand.sendLevelUpNotification === 'function') {
            try {
                await profileCommand.sendLevelUpNotification(
                    client,
                    userId,
                    oldVoiceLevel,
                    currentVoiceLevel,
                    oldChatLevel,
                    currentChatLevel,
                    voiceXP,
                    chatXP
                );
            } catch (sendError) {
                console.log(`⚠️ فشل إرسال إشعار الترقية للمستخدم ${userId} (قد يكون الخاص مغلقاً)`);
            }
        }
    } catch (error) {
        console.error('❌ خطأ في الفحص التلقائي للترقيات:', error);
    }
}

// دالة للحصول على رولات المشرفين من الكاش
function getCachedAdminRoles() {
    const now = Date.now();
    if (now - dataCache.adminRolesUpdatedAt < dataCache.cacheDuration) {
        return dataCache.adminRoles;
    }

    const adminRoles = loadAdminRoles();
    dataCache.adminRoles = adminRoles.map(String);
    dataCache.adminRolesUpdatedAt = now;
    return adminRoles;
}

// Function to update prefix - محسن مع الكاش
function updatePrefix(newPrefix) {
  const oldPrefix = botConfig.prefix;

  // تحديث البيانات المحلية
  botConfig.prefix = newPrefix;

  // تحديث الكاش فوراً
  dataCache.prefix = newPrefix;
  dataCache.lastUpdate = Date.now();

  // حفظ فوري
  const success = writeJSONFile(DATA_FILES.botConfig, botConfig);

  if (success) {
    console.log(`✅ تم تغيير وحفظ البريفكس من "${oldPrefix === null ? 'null' : oldPrefix}" إلى "${newPrefix === null ? 'null' : newPrefix}" بنجاح`);
  } else {
    console.log(`⚠️ تم تغيير البريفكس ولكن قد تكون هناك مشكلة في الحفظ`);
  }

  // Update VIP command prefix as well
  const vipCommand = client.commands.get('vip');
  if (vipCommand && vipCommand.setCurrentPrefix) {
    vipCommand.setCurrentPrefix(newPrefix);
  }
}

// دالة لإعادة تحميل البيانات من الملفات
function reloadData() {
    try {
        points = ticketState.loadPoints();
        responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
        logConfig = readJSONFile(DATA_FILES.logConfig, logConfig);
        client.logConfig = logConfig;

        botConfig = readJSONFile(DATA_FILES.botConfig, botConfig);
        // ADMIN_ROLES, cooldowns, notifications يتم تحميلها ديناميكياً من الملفات عند الحاجة

        console.log('🔄 تم إعادة تحميل جميع البيانات من الملفات');
        return true;
    } catch (error) {
        console.error('❌ خطأ في إعادة تحميل البيانات:', error);
        return false;
    }
}

// دالة تنظيف المعرفات غير الصحيحة
function cleanInvalidUserIds() {
    try {
        let needsSave = false;

        // تنظيف responsibilities
        for (const [respName, respData] of Object.entries(global.responsibilities)) {
            if (respData.responsibles && Array.isArray(respData.responsibles)) {
                const validIds = respData.responsibles.filter(id => {
                    if (typeof id === 'string' && /^\d{17,19}$/.test(id)) {
                        return true;
                    } else {
                        console.log(`تم حذف معرف غير صحيح من مسؤولية ${respName}: ${id}`);
                        needsSave = true;
                        return false;
                    }
                });
                global.responsibilities[respName].responsibles = validIds;
            }
        }

        // تنظيف points
        for (const [respName, respData] of Object.entries(points)) {
            // Internal ticket/Take records are not responsibility buckets or user IDs.
            if (respName.startsWith('__')) continue;
            if (respData && typeof respData === 'object') {
                for (const userId of Object.keys(respData)) {
                    if (!/^\d{17,19}$/.test(userId)) {
                        console.log(`تم حذف نقاط لمعرف غير صحيح: ${userId}`);
                        delete points[respName][userId];
                        needsSave = true;
                    }
                }
            }
        }

        if (needsSave) {
            ticketState.savePoints(points);
            saveData();
            console.log('✅ تم تنظيف البيانات من المعرفات غير الصحيحة');
        }
    } catch (error) {
        console.error('❌ خطأ في تنظيف البيانات:', error);
    }
}

// Setup global setup collector function
function setupGlobalSetupCollector(client) {
  try {
    console.log('🔧 إعداد معالج السيتب العام...');

    // Override the collector creation for setup - simplified approach
    client.createMessageComponentCollector = function(options) {
      console.log('🔧 محاولة إنشاء collector للسيتب...');

      // This function will be used by setup.js to create collectors
      // We'll let the setup.js handle the channel selection
      return {
        on: () => {},
        stop: () => {},
        removeAllListeners: () => {}
      };
    };

  } catch (error) {
    console.error('❌ خطأ في إعداد معالج السيتب العام:', error);
  }
}

// دالة لتنظيف الكاش وإجبار التحديث
function invalidateCache() {
    dataCache.prefix = null;
    dataCache.adminRoles = [];
    dataCache.lastUpdate = 0;
}

// دالة لتحديث كاش الرولات فقط
function updateAdminRolesCache() {
    dataCache.adminRoles = [];
    dataCache.adminRolesUpdatedAt = 0;
    dataCache.lastUpdate = 0;
    // إعادة تحميل من الملف
    getCachedAdminRoles();
}

// Make functions available globally
global.updatePrefix = updatePrefix;
global.scheduleSave = scheduleSave;
global.reloadData = reloadData;
global.cleanInvalidUserIds = cleanInvalidUserIds;
global.invalidateCache = invalidateCache;
global.updateAdminRolesCache = updateAdminRolesCache;

const guildInvites = new Map();

client.on(Events.InviteCreate, (invite) => {

    const invites = guildInvites.get(invite.guild.id);

    if (invites) {

        invites.set(invite.code, invite.uses);

    }

});

client.on(Events.InviteDelete, (invite) => {

    const invites = guildInvites.get(invite.guild.id);

    if (invites) {

        invites.delete(invite.code);

    }

});

    // تتبع دخول الأعضاء (الدعوات وخريطة السيرفر)
    client.on(Events.GuildMemberAdd, async (member) => {
        try {
            // 1. تتبع الدعوات
            const oldInvites = guildInvites.get(member.guild.id);
            const newInvites = await member.guild.invites.fetch().catch(() => null);

            if (newInvites) {
                let usedInvite = newInvites.find(inv => {
                    const prevUses = oldInvites?.get(inv.code) || 0;
                    return inv.uses > prevUses;
                });

                const inviteMap = new Map();
                newInvites.forEach(inv => inviteMap.set(inv.code, inv.uses));
                guildInvites.set(member.guild.id, inviteMap);

                if (usedInvite) {
                    member.inviterId = usedInvite.inviter?.id;
                    console.log(`👤 العضو ${member.user.tag} انضم بواسطة ${usedInvite.inviter?.tag || "غير معروف"} (كود: ${usedInvite.code})`);
                    await dbManager.addInvite(member.id, member.inviterId, "invite");
                } else {
                    const isVanity = member.guild.vanityURLCode && (member.guild.features.includes("VANITY_URL"));
                    const method = isVanity ? "vanity" : "unknown";
                    const inviterId = member.guild.ownerId;
                    console.log(`🔗 العضو ${member.user.tag} انضم بطريقة (${method}) - تم احتسابها لمالك السيرفر: ${inviterId}`);
                    await dbManager.addInvite(member.id, inviterId, method);
                }
            }

            // 2. ترحيب خريطة السيرفر
            if (!member.user.bot) {
                const configPath = DATA_FILES.serverMapConfig;
                if (fs.existsSync(configPath)) {
                    const allConfigs = loadMapConfigsSync();
                    const config = allConfigs.global || allConfigs;
                    
                    if (config && config.enabled) {
                        const mapCommand = client.commands.get('map');
                        if (mapCommand) {
                            const dmChannel = await member.createDM().catch(() => null);
                            if (dmChannel) {
                                const fakeMessage = { 
                                    guild: member.guild, 
                                    channel: dmChannel, 
                                    author: member.user,
                                    client: client,
                                    isAutomatic: true,
                                    isGlobalOnly: true,
                                    reply: async (options) => dmChannel.send(options),
                                    react: async () => {},
                                    permissionsFor: () => ({ has: () => true })
                                };
                                await mapCommand.execute(fakeMessage, [], { client, BOT_OWNERS, BOT_OWNER_ROLES: process.env.BOT_OWNERS ? process.env.BOT_OWNERS.split(',') : [] }).catch(() => {});
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error("❌ خطأ في معالج انضمام العضو الموحد:", error);
        }
    });

// دالة لمزامنة الرولات لجميع المسؤوليات عند التشغيل

async function ensureRespMessageFreshness(client, reason = 'periodic') {
    try {
        const respCommand = client.commands.get('resp');
        if (!respCommand) return;

        if (typeof respCommand.initialize === 'function') {
            respCommand.initialize(client);
        }

        if (typeof respCommand.updateEmbedMessage === 'function') {
            await respCommand.updateEmbedMessage(client);
            console.log(`✅ [RESP] تم التحقق من تحديث رسالة المسؤوليات (${reason})`);
        }
    } catch (error) {
        console.error(`❌ [RESP] فشل التحقق من تحديث رسالة المسؤوليات (${reason}):`, error);
    }
}

async function syncAllResponsibilityRoles(client) {
    console.log('🔄 جاري بدء فحص ومزامنة رولات المسؤوليات...');
    try {
        const responsibilities = global.responsibilities || {};
        for (const guild of client.guilds.cache.values()) {
            console.log(`📡 جاري فحص سيرفر: ${guild.name}`);
            
            // تجميع الرولات ومن يملكها
            const roleToResponsibles = new Map();
            for (const config of Object.values(responsibilities)) {
                const roles = Array.isArray(config.roles) ? config.roles : (config.roleId ? [config.roleId] : []);
                const members = config.responsibles || config.members || [];
                for (const roleId of roles) {
                    if (!roleToResponsibles.has(roleId)) roleToResponsibles.set(roleId, new Set());
                    members.forEach(id => roleToResponsibles.get(roleId).add(id));
                }
            }
            for (const [responsibilityName, config] of Object.entries(responsibilities)) {
                const roles = Array.isArray(config.roles) ? config.roles : (config.roleId ? [config.roleId] : []);
                const supervisorIds = require('./utils/responsibilitySupervisors').getSupervisors(guild.id, responsibilityName).userIds;
                for (const roleId of roles) {
                    if (!roleToResponsibles.has(roleId)) roleToResponsibles.set(roleId, new Set());
                    supervisorIds.forEach(id => roleToResponsibles.get(roleId).add(id));
                }
            }

            const memberLookups = new Map();
            const getMember = async (userId) => {
                const cached = guild.members.cache.get(String(userId));
                if (cached) return cached;
                if (!memberLookups.has(String(userId))) {
                    memberLookups.set(String(userId), (async () => {
                        try {
                            return await guild.members.fetch({ user: String(userId), force: true });
                        } catch (error) {
                            if (Number(error?.code ?? error?.rawError?.code) === 10007 || Number(error?.status) === 404) return null;
                            throw error;
                        } finally {
                            // فاصل بين طلبات البحث الفردية عند التشغيل لتجنب دفعة REST كبيرة.
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                    })());
                }
                return memberLookups.get(String(userId));
            };

            for (const [roleId, allowedUsers] of roleToResponsibles) {
                const role = guild.roles.cache.get(roleId);
                if (!role) continue;
                const candidateIds = new Set([...role.members.keys(), ...allowedUsers]);
                for (const memberId of candidateIds) {
                    // لا نبحث عن عضو غير مخزّن إلا إذا كان معينًا لهذه المسؤولية.
                    if (!allowedUsers.has(memberId) && !guild.members.cache.has(memberId)) continue;
                    let member;
                    try {
                        member = await getMember(memberId);
                    } catch (error) {
                        console.warn(`⚠️ تعذر جلب العضو ${memberId} لمزامنة المسؤوليات في ${guild.name}: ${error.message}`);
                        continue;
                    }
                    if (!member) continue;
                    const hasRole = member.roles.cache.has(roleId);
                    const isResponsible = allowedUsers.has(member.id);
                    if (isResponsible && !hasRole) {
                        await member.roles.add(roleId, 'مزامنة: مسؤول بدون رول').catch(error => console.warn(`⚠️ لم تتم إضافة رول المسؤولية للعضو ${member.id}: ${error.message}`));
                        await new Promise(resolve => setTimeout(resolve, 500));
                    } else if (!isResponsible && hasRole) {
                        await member.roles.remove(roleId, 'مزامنة: رول بدون مسؤولية').catch(error => console.warn(`⚠️ لم تتم إزالة رول المسؤولية من العضو ${member.id}: ${error.message}`));
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
            }
        }
        console.log('✅ انتهت عملية مزامنة الرولات بنجاح.');
    } catch (error) {
        console.error('❌ خطأ في مزامنة رولات المسؤوليات:', error);
    }
}

client.once(Events.ClientReady, async () => {
  try {
    // تهيئة كاش الدعوات
    for (const guild of client.guilds.cache.values()) {
        try {
            const invites = await guild.invites.fetch();
            const inviteMap = new Map();
            invites.forEach(inv => inviteMap.set(inv.code, inv.uses));
            guildInvites.set(guild.id, inviteMap);
        } catch (err) {
            console.error(`❌ خطأ في جلب دعوات سيرفر ${guild.name}:`, err.message);
        }
    }

    const dbReady = await safeInitializeMainDatabase('client-ready', 10000);
    global.responsibilities = dbReady ? await dbManager.getResponsibilities() : readJSONFile(DATA_FILES.responsibilities, {});
    
    // تشغيل المزامنة فور الجاهزية
    await syncAllResponsibilityRoles(client);
    // تحديث رسالة المسؤوليات فور جاهزية البوت، ثم إعادة المحاولة بعد دقيقتين.
    await ensureRespMessageFreshness(client, 'startup');

    // فحص وتحديث رسالة المسؤوليات بعد بدء التشغيل بدقيقتين (إعادة محاولة آمنة)
    setTimeout(async () => {
      await ensureRespMessageFreshness(client, 'startup+2m');
    }, 2 * 60 * 1000);
  } catch (dbError) {
    console.error('❌ Error initializing database/responsibilities:', dbError);
  }
  console.log(`✅ تم تسجيل الدخول بنجاح باسم: ${client.user.tag}!`);

    // تهيئة نظام تتبع الجلسات الصوتية (إذا لم يكن موجود)
    if (!client.voiceSessions) {
        client.voiceSessions = new Map();
    }

    // تتبع المستخدمين الموجودين حالياً في القنوات الصوتية
    // تم حذف الجزء المعطل لتنظيف الملف
    
    // تهيئة نظام تتبع النشاط للمستخدمين
    try {
        const { initializeActivityTracking } = require('./utils/userStatsCollector');
        await initializeActivityTracking(client);
        console.log('✅ تم تهيئة نظام تتبع النشاط بنجاح');
        console.log('✅ نظام تتبع التفاعلات (reactions) مفعل ومهيأ');
    } catch (error) {
        console.error('❌ خطأ في تهيئة نظام تتبع النشاط:', error);
    }

    // بدء نظام فحص الإجازات المنتهية كل 30 ثانية
    const vacationManager = require('./utils/vacationManager');
    let vacationCheckRunning = false;
    setInterval(async () => {
        if (vacationCheckRunning) return;
        vacationCheckRunning = true;
        try {
            await vacationManager.checkVacations(client);
        } catch (error) {
            console.error('خطأ في فحص الإجازات المنتهية:', error);
        } finally {
            vacationCheckRunning = false;
        }
    }, 30000); // فحص كل 30 ثانية

    // فحص فوري عند بدء التشغيل
    setTimeout(async () => {
        try {
            await vacationManager.checkVacations(client);
            console.log('✅ تم فحص الإجازات المنتهية عند بدء التشغيل');
        } catch (error) {
            console.error('خطأ في الفحص الأولي للإجازات:', error);
        }
    }, 5000);

    // Initialize down manager with client (expiration checking is handled internally)
    downManager.init(client);
    console.log('✅ تم فحص الداونات المنتهية عند بدء التشغيل');

    // Initialize warn manager with client
    warnManager.init(client);
    console.log('✅ تم تهيئة نظام التحذيرات بنجاح');

    // Initialize promote manager with client (after database initialization)
    try {
        const databaseModule = require('./utils/database');
        const database = databaseModule.getDatabase();
        promoteManager.init(client, database);
        console.log('✅ تم تهيئة نظام الترقيات بنجاح مع قاعدة البيانات');
    } catch (error) {
        console.error('❌ خطأ في تهيئة نظام الترقيات:', error);
        // Initialize without database as fallback
        promoteManager.init(client);
        console.log('⚠️ تم تهيئة نظام الترقيات بدون قاعدة البيانات');
    }
    // Initialize prayer reminder system
    try {
        const prayerReminder = require('./commands/prayer-reminder.js');
        prayerReminder.startPrayerReminderSystem(client);
        console.log('✅ تم تهيئة نظام تذكير الصلاة بنجاح');
    } catch (error) {
        console.error('❌ خطأ في تهيئة نظام تذكير الصلاة:', error);
    }

    // Initialize Streak system
    try {
        const streakCommand = require('./commands/streak.js');
        if (streakCommand && streakCommand.initialize) {
            await streakCommand.initialize(client);
            console.log('✅ تم تهيئة نظام Streak بنجاح');
        }
    } catch (error) {
        console.error('❌ خطأ في تهيئة نظام Streak:', error);
    }

    // تتبع النشاط الصوتي باستخدام client.voiceSessions المحسّن
    client.on('voiceStateUpdate', async (oldState, newState) => {
        try {
            if (problemCommand && typeof problemCommand.handleVoice === 'function') {
                await problemCommand.handleVoice(oldState, newState, client);
            }
        } catch (error) {
            console.error('❌ خطأ في معالجة صوت البروبلم:', error);
        }

        // تجاهل البوتات
        if (!newState.member || newState.member.user.bot) return;

        const userId = newState.member.id;
        const displayName = newState.member.displayName;
        const now = Date.now();

        // معلومات القنوات
        const isOldTrackableVoice = !!oldState.channel && oldState.channel.type !== ChannelType.GuildStageVoice;

        const isNewTrackableVoice = !!newState.channel && newState.channel.type !== ChannelType.GuildStageVoice;

        const oldChannelId = isOldTrackableVoice ? oldState.channel.id : null;

        const newChannelId = isNewTrackableVoice ? newState.channel.id : null;

        const oldChannelName = isOldTrackableVoice ? (oldState.channel?.name || 'لا يوجد') : 'Stage';

        const newChannelName = isNewTrackableVoice ? (newState.channel?.name || 'لا يوجد') : 'Stage';
        // تحميل دالة تتبع النشاط
        const { trackUserActivity } = require('./utils/userStatsCollector');

        // التحقق من وجود جلسة نشطة
        const existingSession = client.voiceSessions.get(userId);


        // 1. المستخدم انضم لقناة صوتية لأول مرة (لم يكن في أي قناة)
        if (!oldChannelId && newChannelId) {
            await trackUserActivity(userId, 'voice_join', { guildId: newState.guild.id }).catch(() => {});
            
            const sessionStartTime = now;
            // تخزين الجلسة فقط بدون interval لتقليل الضغط
            client.voiceSessions.set(userId, {
                guildId: newState.guild.id,
                channelId: newChannelId,
                channelName: newChannelName, 
                sessionStartTime: now, 
                startTime: now, // Add startTime for compatibility
                lastTrackedTime: now, 
                isAFK: false 
            });
        }

        // 2. المستخدم غادر القناة الصوتية كلياً (من قناة إلى لا شيء)
        else if (oldChannelId && !newChannelId) {
            if (existingSession) {
                const currentTime = Date.now();
                const endTime = existingSession.isAFK
                    ? (existingSession.afkSince || existingSession.lastTrackedTime)
                    : currentTime;
                const startTime = existingSession.lastTrackedTime;
                const duration = endTime - startTime;

                if (duration > 1000) {
                    await trackUserActivity(userId, 'voice_time', {
                        guildId: newState.guild.id,
                        duration: duration,
                        channelId: oldChannelId,
                        channelName: oldChannelName,
                        startTime: startTime,
                        endTime: endTime
                    }).catch(() => {});
                }

                await checkAutoLevelUp(userId, 'voice', client).catch(() => {});
                client.voiceSessions.delete(userId);
                console.log(`🎤 ${displayName} غادر - تم إضافة ${Math.round(duration/1000)}ث متبقية لقاعدة البيانات.`);
            }
        }

        // 3. المستخدم انتقل بين القنوات (من قناة إلى قناة أخرى)
        else if (oldChannelId && newChannelId && oldChannelId !== newChannelId) {
            if (existingSession) {
                const currentTime = Date.now();
                const endTime = existingSession.isAFK
                    ? (existingSession.afkSince || existingSession.lastTrackedTime)
                    : currentTime;
                const startTime = existingSession.lastTrackedTime;
                const duration = endTime - startTime;
                
                if (duration > 1000) {
                    await trackUserActivity(userId, 'voice_time', {
                        guildId: newState.guild.id,
                        duration: duration,
                        channelId: oldChannelId,
                        channelName: oldChannelName,
                        startTime: startTime,
                        endTime: endTime
                    }).catch(() => {});
                }
            }

            await checkAutoLevelUp(userId, 'voice', client).catch(() => {});
            await trackUserActivity(userId, 'voice_join', { guildId: newState.guild.id }).catch(() => {});

            client.voiceSessions.set(userId, {
                guildId: newState.guild.id,
                channelId: newChannelId,
                channelName: newChannelName, 
                sessionStartTime: now, 
                startTime: now, // Add startTime for compatibility
                lastTrackedTime: now, 
                isAFK: false 
            });
        }

        // 4. أي تغيير آخر ضمن نفس القناة (mute/unmute, deafen/undeafen, etc.)
        else if (oldChannelId && newChannelId && oldChannelId === newChannelId) {
            // لا نحتاج لفعل شيء هنا - المستخدم لا يزال في نفس القناة
            return; // لا نحتاج لعرض الإحصائيات
        }

    });




    // نظام الحفظ الدوري وحماية البيانات من الفقدان (كل 3 دقائق)
    let voiceMaintenanceRunning = false;
    setInterval(async () => {
        if (voiceMaintenanceRunning) return;
        voiceMaintenanceRunning = true;
        try {
            const { trackUserActivity } = require('./utils/userStatsCollector');
            const now = Date.now();
            const AFK_LIMIT = 24 * 60 * 60 * 1000;

            for (const [userId, session] of client.voiceSessions.entries()) {
                try {
                    const sessionChannel = client.channels.cache.get(session.channelId);

                    if (sessionChannel && sessionChannel.type === ChannelType.GuildStageVoice) {

                        client.voiceSessions.delete(userId);

                        continue;

                    }
                    const sessionStart = session.startTime || session.sessionStartTime;
                    const totalSessionDuration = now - sessionStart;
                    if (totalSessionDuration >= AFK_LIMIT) {
                        if (!session.isAFK) {
                            const limitTime = sessionStart + AFK_LIMIT;
                            const remaining = limitTime - session.lastTrackedTime;
                            if (remaining > 1000) {
                                await trackUserActivity(userId, 'voice_time', {
                                    guildId: session.guildId,
                                    duration: remaining,
                                    channelId: session.channelId,
                                    channelName: session.channelName,
                                    startTime: session.lastTrackedTime,
                                    endTime: limitTime
                                }).catch(() => {});
                            }
                            session.lastTrackedTime = Math.max(session.lastTrackedTime, limitTime);
                            session.isAFK = true;
                            session.afkSince = limitTime;
                        }
                        continue;
                    }

                    const duration = now - session.lastTrackedTime;
                    if (duration >= 30000) { // حفظ إذا مرّت 30 ثانية على الأقل منذ آخر حفظ
                        await trackUserActivity(userId, 'voice_time', {
                            guildId: session.guildId,
                            duration: duration,
                            channelId: session.channelId,
                            channelName: session.channelName,
                            startTime: session.lastTrackedTime,
                            endTime: now
                        }).catch(() => {});
                        
                        session.lastTrackedTime = now;
                    }
                } catch (err) {}
                await new Promise(r => setTimeout(r, 20));
            }
            saveVoiceSessionsToDisk();
        } catch (error) {}
        finally {
            voiceMaintenanceRunning = false;
        }
    }, 3 * 60 * 1000);

    // حماية البيانات عند إغلاق البوت (Graceful Shutdown)
    async function saveAllSessions() {
        console.log('💾 جاري حفظ جميع الجلسات النشطة قبل الإغلاق...');
        try {
            const { trackUserActivity } = require('./utils/userStatsCollector');
            const now = Date.now();
            
            for (const [userId, session] of client.voiceSessions.entries()) {
                try {
                    const endTime = session.isAFK ? (session.afkSince || session.lastTrackedTime) : now;
                    const duration = endTime - session.lastTrackedTime;
                    if (duration > 1000) {
                        await trackUserActivity(userId, 'voice_time', {
                            guildId: session.guildId,
                            duration: duration,
                            channelId: session.channelId,
                            channelName: session.channelName,
                            startTime: session.lastTrackedTime,
                            endTime: endTime
                        }).catch(() => {});
                    }
                } catch (err) {}
            }
            saveVoiceSessionsToDisk();
            console.log('✅ تم حفظ جميع البيانات بنجاح.');
        } catch (error) {
            console.error('❌ خطأ أثناء حفظ الجلسات قبل الإغلاق:', error);
        }
    }

    process.on('SIGINT', async () => {
        await saveAllSessions();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        await saveAllSessions();
        process.exit(0);
    });

  // تم نقل تتبع الرسائل للمعالج الرئيسي لتجنب التكرار


  // تهيئة نظام المهام النشطة الجديد - بعد تحميل الأوامر
  setTimeout(async () => {
    try {
    // فحص الأعضاء الموجودين في الرومات الصوتية عند تشغيل البوت
    // تم تحويل هذا النظام ليعمل بشكل تدريجي لمنع ضغط الشبكة والمعالج
    setTimeout(async () => {
      try {
        const now = Date.now();
        let memberCount = 0;
        const activeUserIds = new Set();
        
        for (const guild of client.guilds.cache.values()) {
          for (const voiceState of guild.voiceStates.cache.values()) {
            if (!voiceState.member || voiceState.member.user.bot || !voiceState.channelId) continue;
            
            const userId = voiceState.member.id;
            const channelId = voiceState.channelId;
            const channelName = voiceState.channel?.name || 'Unknown Room';
            activeUserIds.add(userId);

            const existingSession = client.voiceSessions.get(userId);
            if (existingSession && existingSession.channelId === channelId) {
              existingSession.channelName = channelName;
              continue;
            }

            if (!existingSession || existingSession.channelId !== channelId) {
              // تخزين بيانات الجلسة في الذاكرة فقط (بدون أي طلبات API أو قاعدة بيانات)
              client.voiceSessions.set(userId, { 
                channelId, 
                channelName, 
                sessionStartTime: now, 
                startTime: now, // Add startTime for compatibility
                lastTrackedTime: now, 
                isAFK: false,
                isInitial: true 
              });
              memberCount++;
              
              // معالجة تدريجية (عضو كل 50ms) لمنع تعليق البوت
              if (memberCount % 5 === 0) await new Promise(r => setTimeout(r, 50));
            }
          }
        }
        for (const userId of client.voiceSessions.keys()) {
          if (!activeUserIds.has(userId)) {
            client.voiceSessions.delete(userId);
          }
        }
        saveVoiceSessionsToDisk();
        console.log(`✅ تم رصد ${memberCount} عضو في الرومات الصوتية تدريجياً.`);
      } catch (error) {
        console.error('❌ خطأ في رصد القنوات الصوتية:', error);
      }
    }, 45000); // زيادة التأخير لـ 45 ثانية لضمان استقرار الاتصال تماماً أولاً
    } catch (error) {
      console.error('❌ خطأ في تهيئة أنظمة الصوت:', error);
    }
  }, 20000); // زيادة التأخير لضمان استقرار الاتصال قبل بدء الفحص الثقيل

  // تهيئة نظام الألوان
  colorManager.initialize(client);
  await colorManager.forceUpdateColor();

  // مراقب لحالة البوت - كل دقيقة
  let reconnectInProgress = false;
  setInterval(() => {
    if (client.ws.status !== 0) { // 0 = READY
      console.log(`⚠️ حالة البوت: ${client.ws.status} - محاولة إعادة الاتصال التلقائي...`);
      // محاولة إعادة تشغيل اتصال دسكورد
      if ((client.ws.status === 4 || client.ws.status === 5) && !reconnectInProgress) {
          reconnectInProgress = true;
          console.log('🔄 إعادة تشغيل اتصال دسكورد...');
          client.destroy();
          setTimeout(async () => {
            try {
              await client.login(process.env.DISCORD_TOKEN);
            } catch (error) {
              console.error('❌ فشلت محاولة إعادة الاتصال:', error.message || error);
            } finally {
              reconnectInProgress = false;
            }
          }, 5000);
      }
    }
  }, 60000);

  // فحص دوري لرسالة المسؤوليات كل 30 دقيقة لضمان تزامنها مع أحدث التعديلات
  let responsibilityRefreshRunning = false;
  setInterval(async () => {
    if (responsibilityRefreshRunning) return;
    responsibilityRefreshRunning = true;
    try {
      await ensureRespMessageFreshness(client, '30m-check');
    } finally {
      responsibilityRefreshRunning = false;
    }
  }, 30 * 60 * 1000);

  // إزالة المسؤوليات تلقائياً بعد 6 ساعات خارج السيرفر
  let inactiveCleanupRunning = false;
  setInterval(async () => {
    if (inactiveCleanupRunning) return;
    inactiveCleanupRunning = true;
    try {
      for (const guild of client.guilds.cache.values()) {
        await removeInactiveResponsiblesForGuild(guild);
      }
    } finally {
      inactiveCleanupRunning = false;
    }
  }, 60 * 60 * 1000);

  setTimeout(async () => {
    for (const guild of client.guilds.cache.values()) {
      await removeInactiveResponsiblesForGuild(guild);
    }
  }, 15 * 1000);

  // حفظ البيانات فقط عند الحاجة - كل 5 دقائق أو عند وجود تغييرات
  setInterval(() => {
    if (isDataDirty) {
      saveData();
    }
  }, 300 * 1000); // كل 5 دقائق

  setInterval(() => {
    if (client.modalData) {
      const now = Date.now();
      for (const [key, data] of client.modalData.entries()) {
        if (now - data.timestamp > 15 * 60 * 1000) { // 15 دقيقة
          client.modalData.delete(key);
        }
      }
    }

    // تنظيف بيانات الأعضاء المترقين القديمة (أكثر من 24 ساعة)
    if (client.bulkPromotionMembers) {
      const now = Date.now();
      for (const [key, data] of client.bulkPromotionMembers.entries()) {
        if (now - data.timestamp > 24 * 60 * 60 * 1000) { // 24 ساعة
          client.bulkPromotionMembers.delete(key);
        }
      }
    }
  }, 300 * 1000); // كل 5 دقائق


  // إنشاء backup تلقائي كل ساعة
    
    // قراءة البريفكس من الملف مباشرة
  const currentBotConfig = readJSONFile(DATA_FILES.botConfig, {});
  let currentPrefix = currentBotConfig.prefix;

  // إزالة علامات التنصيص إذا كانت موجودة
  if (currentPrefix && typeof currentPrefix === 'string' && currentPrefix.startsWith('"') && currentPrefix.endsWith('"')) {
    currentPrefix = currentPrefix.slice(1, -1);
  }

  console.log(`البريفكس الحالي: "${currentPrefix === null ? 'null' : currentPrefix}"`);

  // التحقق من نظام الكولداون
  const cooldownData = readJSONFile(DATA_FILES.cooldowns, {});
  console.log(`✅ نظام الكولداون جاهز - الافتراضي: ${(cooldownData.default || 60000) / 1000} ثانية`);




  const RESTORE_SCHEDULES_DELAY_MS = 5000;

  setTimeout(() => {
    try {
      restoreTopSchedules(client);
      restorePanelCleanups(client);
      console.log('✅ تم استعادة جدولة لوحات الرولات الخاصة والتنظيف التلقائي.');
    } catch (error) {
      console.error('❌ خطأ في استعادة جدولة لوحات الرولات الخاصة:', error);
    }
  }, RESTORE_SCHEDULES_DELAY_MS);

  setTimeout(async () => {
    try {
      await sweepBotsFromSpecialRoles(client);
      console.log('✅ تم تنفيذ تصفية بوتات الرولات الخاصة عند بدء التشغيل.');
    } catch (error) {
      console.error('❌ خطأ أثناء تصفية بوتات الرولات الخاصة عند البدء:', error);
    }
  }, RESTORE_SCHEDULES_DELAY_MS + 2500);

        // تحديث صلاحيات اللوق عند بدء البوت
        setTimeout(async () => {
            try {
                const guild = client.guilds.cache.first();
                if (guild && client.logConfig && client.logConfig.logRoles && client.logConfig.logRoles.length > 0) {
                    const { updateLogPermissions } = require('./commands/logs.js');
                    await updateLogPermissions(guild, client.logConfig.logRoles);
                    console.log('✅ تم تحديث صلاحيات اللوق عند بدء البوت');
                }
            } catch (error) {
                console.error('خطأ في تحديث صلاحيات اللوق عند البدء:', error);
            }
        }, 5000);

  // Set initial prefix for VIP command
  const vipCommand = client.commands.get('vip');
  if (vipCommand && vipCommand.setCurrentPrefix) {
    vipCommand.setCurrentPrefix(currentPrefix);
  }

  // استعادة حالة البوت المحفوظة
  if (vipCommand && vipCommand.restoreBotStatus) {
    setTimeout(() => {
      vipCommand.restoreBotStatus(client);
    }, 2000); // انتظار ثانيتين للتأكد من جاهزية البوت
  }

  // إعداد نظام collectors عام للسيتب
  client.setupCollectors = new Map();

  // إعداد collector عام للسيتب يعمل بعد إعادة التشغيل
  setTimeout(() => {
    setupGlobalSetupCollector(client);
  }, 3000);

}); // إغلاق client.once('ready')

// مراقبة تحديثات الرولات لنظام setroom
client.on('roleUpdate', async (oldRole, newRole) => {
    try {
        const { handleRoleUpdate } = require('./commands/setroom.js');
        await handleRoleUpdate(oldRole, newRole, client);
        await handleUnauthorizedRoleLink(oldRole, newRole);
    } catch (error) {
        console.error('❌ خطأ في معالجة تحديث الرول:', error);
    }
});
client.on('channelDelete', channel => {

  try {

    handleChannelDelete(channel);

  } catch (error) {

    console.error('❌ خطأ في حماية القنوات:', error);

  }

});

client.on('roleDelete', role => {

  try {

    handleRoleDelete(role);
    const roleEntry = getRoleEntry(role.id);
    if (roleEntry) {
      deleteRoleEntry(role.id, role.client?.user?.id || 'system');
      console.log(`🧹 تم حذف بيانات الرول الخاص المحذوف: ${role.name} (${role.id})`);
    }

  } catch (error) {

    console.error('❌ خطأ في حماية الرولات:', error);

  }

});
// Reaction Log tracking for added and removed reactions
async function prepareReaction(reaction) {
  if (!reaction) return false;
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message?.partial) await reaction.message.fetch();
    return Boolean(reaction.message?.guild);
  } catch (error) {
    if (![10008, 50001].includes(Number(error?.code))) {
      console.error('Reaction preparation failed:', error?.message || error);
    }
    return false;
  }
}

let reactionEventQueue = Promise.resolve();

function snapshotReactionUser(user) {
  return {
    id: user?.id,
    bot: Boolean(user?.bot),
    tag: user?.tag || user?.username || user?.id,
    username: user?.username || user?.tag || user?.id
  };
}

function enqueueReactionLog(reaction, user, action) {
  const actor = snapshotReactionUser(user);
  const eventReaction = {
    message: reaction?.message,
    emoji: reaction?.emoji,
    count: reaction?.count
  };
  const task = reactionEventQueue.catch(() => {}).then(async () => {
    if (!(await prepareReaction(reaction))) return;
    const message = reaction.message;
    eventReaction.message = message;
    const { dispatchReactionLog, shouldLogReaction } = require('./utils/reactionLogManager');
    const channelId = message.channelId || message.channel?.id;
    if (!shouldLogReaction({ guildId: message.guild.id, channelId, action }).allowed) return;
    await dispatchReactionLog({ reaction: eventReaction, user: actor, action });
  });
  reactionEventQueue = task.catch(() => {});
  return task;
}

client.on('messageReactionAdd', async (reaction, user) => {
  if (user?.bot) return;
  try {
    await enqueueReactionLog(reaction, user, 'add');
  } catch (error) {
    console.error('Reaction add log failed:', error?.message || error);
  }
  try {
    if (!(await prepareReaction(reaction))) return;
    const { getDatabase } = require('./utils/database');
    const dbManager = getDatabase();
    if (!dbManager?.isInitialized) return;
    const { trackUserActivity } = require('./utils/userStatsCollector');
    await trackUserActivity(user.id, 'reaction', {
      guildId: reaction.message.guild.id,
      messageId: reaction.message.id,
      channelId: reaction.message.channelId,
      emoji: reaction.emoji.name || reaction.emoji.id || 'custom_emoji',
      timestamp: Date.now(),
      messageAuthorId: reaction.message.author?.id
    });
  } catch (error) {
    console.error(`Reaction stats tracking failed for ${user?.username || user?.id}:`, error?.message || error);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user?.bot) return;
  try {
    await enqueueReactionLog(reaction, user, 'remove');
  } catch (error) {
    console.error('Reaction remove log failed:', error?.message || error);
  }
});

// Pairings memory cache
let pairingsCache = {};
const pairingsPath = path.join(__dirname, 'data', 'pairings.json');
const pairingStatusPath = path.join(__dirname, 'data', 'pairingStatus.json');
let pairingStatusCache = { off: false, message: null };

function normalizeUserId(input) {
  if (!input) return null;
  const cleaned = String(input).replace(/[<@!>]/g, '').trim();
  return /^\d{17,19}$/.test(cleaned) ? cleaned : null;
}

async function fetchUserForDm(client, userId) {
  const normalizedId = normalizeUserId(userId);
  if (!normalizedId) return null;
  try {
    return await client.users.fetch(normalizedId);
  } catch (err) {
    if (err?.code !== 10013) {
      throw err;
    }
  }
  for (const guild of client.guilds.cache.values()) {
    try {
      const member = await guild.members.fetch(normalizedId);
      if (member?.user) return member.user;
    } catch (_) {
      // ignore guild lookup errors
    }
  }
  return null;
}

// Load pairings from disk to memory once at startup
function loadPairingsToCache() {
  try {
    if (fs.existsSync(pairingsPath)) {
      const data = fs.readFileSync(pairingsPath, 'utf8');
      if (data && data.trim() !== '') {
        pairingsCache = JSON.parse(data);
        let sanitized = 0;
        for (const [userId, entry] of Object.entries(pairingsCache)) {
          const normalizedUserId = normalizeUserId(userId);
          const normalizedTargetId = normalizeUserId(entry?.targetId);
          if (!normalizedUserId || !normalizedTargetId) {
            delete pairingsCache[userId];
            sanitized += 1;
            continue;
          }
          if (normalizedUserId !== userId) {
            pairingsCache[normalizedUserId] = {
              ...entry,
              targetId: normalizedTargetId,
            };
            delete pairingsCache[userId];
            sanitized += 1;
          } else if (normalizedTargetId !== entry?.targetId) {
            pairingsCache[userId].targetId = normalizedTargetId;
            sanitized += 1;
          }
        }
        if (sanitized > 0) {
          savePairings();
        }
        console.log('✅ Loaded pairings into memory cache');
      }
    }
  } catch (error) {
    console.error('Error loading pairings to cache:', error);
    pairingsCache = {};
  }
}

// Save pairings to disk
function savePairings() {
  try {
    fs.writeFileSync(pairingsPath, JSON.stringify(pairingsCache, null, 2));
  } catch (error) {
    console.error('Error saving pairings to disk:', error);
  }
}

loadPairingsToCache();

function loadPairingStatus() {
  try {
    if (fs.existsSync(pairingStatusPath)) {
      const data = fs.readFileSync(pairingStatusPath, 'utf8');
      if (data && data.trim() !== '') {
        const parsed = JSON.parse(data);
        pairingStatusCache = {
          off: Boolean(parsed?.off),
          message: typeof parsed?.message === 'string' ? parsed.message : null
        };
      }
    }
  } catch (error) {
    console.error('Error loading pairing status:', error);
    pairingStatusCache = { off: false, message: null };
  }
}

function savePairingStatus() {
  try {
    fs.writeFileSync(pairingStatusPath, JSON.stringify(pairingStatusCache, null, 2));
  } catch (error) {
    console.error('Error saving pairing status:', error);
  }
}

loadPairingStatus();

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const ALLOWED_ID = '636930315503534110';

  if (message.guild && pairingStatusCache.off) {
    const mentioned = message.mentions?.users?.has(ALLOWED_ID);
    const repliedUserId = message.mentions?.repliedUser?.id;
    if (mentioned || repliedUserId === ALLOWED_ID) {
      const replyMessage = pairingStatusCache.message || 'احمد مب موجود الحين كلمه خاص';
      await message.reply(replyMessage).catch(() => {});
    }
  }

  // 1. نظام الرولات التفاعلية
  if (typeof interactiveRolesManager !== 'undefined' && interactiveRolesManager.handleMessage) {
    try {
      await interactiveRolesManager.handleMessage(message);
    } catch (e) {
      console.error('Error in interactiveRolesManager handleMessage:', e);
    }
  }

  // 1.5 نظام البروبلم (حذف/تحذير الرسائل أثناء المشكلة)
  if (problemCommand && typeof problemCommand.handleMessage === 'function') {
    try {
      await problemCommand.handleMessage(message, client);
    } catch (e) {
      console.error('Error in problem handleMessage:', e);
    }
  }

  // 2. نظام الاقتران (DM)
  if (message.channel.type === 1) { // DM
    const content = message.content.trim();
    let forwardedToAllowed = false;

    if (message.author.id !== ALLOWED_ID) {
      try {
        const allowedUser = await fetchUserForDm(client, ALLOWED_ID);
        if (allowedUser) {
          const embed = new EmbedBuilder()
            .setColor(colorManager.getColor() || '#0099ff')
            .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
            .setDescription(message.content ? message.content : '*(بدون نص)*')
            .addFields({ name: 'المرسل', value: `<@${message.author.id}> (\`${message.author.id}\`)`, inline: false })
            .setTimestamp();

          const messageOptions = {
            content: `رسالة جديدة من <@${message.author.id}>`,
            embeds: [embed]
          };

          if (message.attachments.size > 0) {
            messageOptions.files = message.attachments.map(a => a.url);
          }

          await allowedUser.send(messageOptions);
          forwardedToAllowed = true;
        }
      } catch (e) {
        console.error('❌ خطأ في تحويل رسالة DM إلى الأونر:', e);
      }
    }

    if (content.startsWith('اقتران ')) {
      if (message.author.id !== ALLOWED_ID) {
        return message.reply('❌ **هذا الأمر متاح فقط لشخص محدد.**');
      }
      const targetId = normalizeUserId(content.split(' ')[1]);
      if (!targetId) {
        return message.reply('❌ **آيدي غير صحيح.**');
      }
      if (targetId === message.author.id) {
        return message.reply('❌ **لا يمكنك الاقتران بنفسك.**');
      }

      pairingsCache[message.author.id] = { targetId: targetId, timestamp: Date.now() };
      pairingsCache[targetId] = { targetId: message.author.id, timestamp: Date.now() };
      savePairings();

      message.reply('✅ **تم الاتصال بنجاح. أي رسالة ترسلها الآن ستصل للطرف الآخر.**');
      // Removed target notification
      return;
    }

    if (content.toLowerCase().startsWith('off') && message.author.id === ALLOWED_ID) {
      const customMessage = content.slice(3).trim();
      if (!customMessage) {
        await message.reply('❌ اكتب رسالة بعد الأمر. مثال: off مشغول حاليا، تواصل خاص');
        return;
      }
      pairingStatusCache.off = true;
      pairingStatusCache.message = customMessage;
      savePairingStatus();
      await message.reply(`✅ تم تفعيل وضع عدم التوفر. سيتم الرد بالرسالة: ${customMessage}`);
      return;
    }

    if (content.toLowerCase() === 'on' && message.author.id === ALLOWED_ID) {
      pairingStatusCache.off = false;
      savePairingStatus();
      await message.reply('✅ تم إلغاء وضع عدم التوفر.');
      return;
    }

    if (content === 'انهاء') {
      if (message.author.id !== ALLOWED_ID) {
        return message.reply('❌ **هذا الأمر متاح فقط لشخص محدد.**');
      }
      if (pairingsCache[message.author.id]) {
        const targetId = pairingsCache[message.author.id].targetId;
        delete pairingsCache[message.author.id];
        if (pairingsCache[targetId]) delete pairingsCache[targetId];
        savePairings();
        
        message.reply('🏁 **تم إنهاء الاقتران.**');
        // Removed target notification
        return;
      } else {
        message.reply('❌ **أنت لست في حالة اقتران حالياً.**');
      }
      return;
    }

    // Forward messages
    if (pairingsCache[message.author.id]) {
      const targetId = normalizeUserId(pairingsCache[message.author.id].targetId);

      if (!targetId) {
        delete pairingsCache[message.author.id];
        savePairings();
        return message.reply('❌ **تم حذف الاقتران بسبب آيدي غير صالح.**');
      }

      if (forwardedToAllowed && targetId === ALLOWED_ID) {
        return;
      }
      
      try {
        const targetUser = await fetchUserForDm(client, targetId);
        if (!targetUser) {
          throw Object.assign(new Error('Unknown User'), { code: 10013 });
        }
        
        const messageOptions = {
          content: message.content ? `**${message.content}**` : null
        };

        if (message.attachments.size > 0) {
          messageOptions.files = message.attachments.map(a => a.url);
        }

        await targetUser.send(messageOptions);
        
        // يضع صح فقط للشخص الأساسي (المصرح له)
        if (message.author.id === ALLOWED_ID) {
          await message.react('✅').catch(() => {});
        }
      } catch (e) {
        console.error('❌ خطأ في إرسال رسالة الاقتران:', {
          from: message.author.id,
          to: targetId,
          code: e?.code,
          name: e?.name,
          message: e?.message
        });
        if (e?.code === 10013) {
          delete pairingsCache[message.author.id];
          savePairings();
        }
        // يضع خطأ فقط للشخص الأساسي إذا فشل الإرسال
        if (message.author.id === ALLOWED_ID) {
          await message.react('❌').catch(() => {
            message.reply('❌ **فشل في إرسال الرسالة. قد يكون الطرف الآخر أغلق الخاص أو حظر البوت.**').catch(() => {});
          });
        }
      }
      return;
    }
  }

  // تتبع النشاط للمستخدمين العاديين (معالج واحد فقط)
  if (message.guild) {
    try {
      const { getDatabase } = require('./utils/database');
      const dbManager = getDatabase();

      // التحقق من أن قاعدة البيانات مهيأة
      if (dbManager && dbManager.isInitialized) {
        const { trackUserActivity } = require('./utils/userStatsCollector');
        await trackUserActivity(message.author.id, 'message', {
          guildId: message.guild?.id,
          channelId: message.channel.id,
          channelName: message.channel.name,
          messageId: message.id,
          timestamp: Date.now()
        });

        // فحص تلقائي للترقية في مستوى الشات
        await checkAutoLevelUp(message.author.id, 'chat', client);
      }
      // تم إزالة رسالة الكونسول لتجنب الإزعاج
    } catch (error) {
      console.error('❌ خطأ في تتبع الرسالة:', error);
    }

    // نظام البونس مستقل عن جامع الإحصاءات القديم؛ فشل أحدهما لا يمنع الآخر.
    try {
      const bonusCommand = client.commands.get('bonus');
      if (bonusCommand?.recordMessage) await bonusCommand.recordMessage(message, getCachedPrefix());
    } catch (bonusError) {
      console.error('❌ خطأ مستقل في تسجيل رسالة نظام البونس:', bonusError);
    }

    // Handle Streak system message processing
    try {
      const streakCommand = require('./commands/streak.js');
      if (streakCommand && streakCommand.handleMessage) {
        setImmediate(async () => {
          await streakCommand.handleMessage(message, client, BOT_OWNERS).catch(e => console.error('Streak Error:', e));
        });
      }
    } catch (error) {
      console.error('❌ خطأ في معالجة رسالة Streak:', error);
    }
  }

  // فحص البلوك قبل معالجة أي أمر
  const { isUserBlocked } = require('./commands/block.js');
  const canBypassMessageBlocks = isBotOwner(message.member || message.author)
    || message.guild?.ownerId === message.author.id;
  if (!canBypassMessageBlocks && isUserBlocked(message.author.id)) {
    return; // تجاهل المستخدمين المحظورين بصمت لتوفير الأداء
  }
  const { isChannelBlocked } = require('./commands/chatblock.js');
  if (!canBypassMessageBlocks && isChannelBlocked(message.channel.id)) {
    return; // تجاهل الأوامر في القنوات المحظورة بصمت
  }
  // نظام كلمات word

  try {

    const wordCommand = client.commands.get('word');

    if (wordCommand && typeof wordCommand.handleMessage === 'function') {

      const consumed = await wordCommand.handleMessage(message, { client, BOT_OWNERS, BOT_OWNER_ROLES });

      if (consumed) return;

    }

  } catch (error) {

    console.error('❌ خطأ في نظام word:', error);

  }
  // أوامر القروب الداخلية تمر هنا قبل parser الأوامر العامة لتجنب التعارض.
  try {
    const groupsCommand = client.commands.get('groups');
    if (groupsCommand?.handleInternalMessage) {
      const consumed = await groupsCommand.handleInternalMessage(message, { prefix: getCachedPrefix() });
      if (consumed) return;
    }
  } catch (error) {
    console.error('Group internal dispatcher error:', error);
  }
  // معالجة الأوامر (البريفكس)
  const prefix = getCachedPrefix();
  if (prefix && message.content.startsWith(prefix)) {
    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();

    const command = client.commands.get(commandName);
    if (command && commandName !== 'داونات') {
      // تشغيل الأوامر بشكل غير متزامن لضمان عدم تأثر سرعة البوت الكلية
      setImmediate(async () => {
        try {
          const publicCommands = new Set([
            'help', 'مساعدة', 'رولي', 'tops', 'توب', 'تفاعلي', 'تواجدي', 'انهاء', 'user',
            'ستريكي', 'profile', 'id', 'مشاكلي', 'myprofile', 'داوني', 'داوناتي', 'داونات'
          ]);
          const currentAdminRoles = getCachedAdminRoles();
          const cachedMember = message.member;
          const cachedMemberHasAdminAccess = isBotOwner(cachedMember || message.author)
            || message.guild?.ownerId === message.author.id
            || Boolean(cachedMember?.permissions?.has('Administrator'))
            || currentAdminRoles.some(roleId => cachedMember?.roles?.cache?.has(String(roleId)));
          if (message.guild && !publicCommands.has(commandName) && !cachedMemberHasAdminAccess) {
            await refreshMessageMember(message);
          }
          await command.execute(message, args, {
            client,
            BOT_OWNERS,
            BOT_OWNER_ROLES,
            ADMIN_ROLES: currentAdminRoles,
            responsibilities: global.responsibilities || {},
            points,
            scheduleSave,
            colorManager
          });
        } catch (error) {
          console.error(`Error executing command ${commandName}:`, error);
          message.reply('حدث خطأ أثناء تنفيذ هذا الأمر.').catch(() => {});
        }
      });
      return; // خرجنا لأننا وجدنا أمراً
    }
  }

  // ===== معالج اختصارات المنشن للمسؤوليات =====
  try {
    const content = message.content.trim();
    const responsibilities = global.responsibilities || {};
    const matcherCache = message.guild ? getShortcutMatcherCache(responsibilities) : { byPrefix: new Map(), prefixes: [] };
    const candidatePrefixes = matcherCache.prefixesByFirstCharacter.get(content[0]) || [];
    const candidateEntries = candidatePrefixes
      .filter(prefix => content.startsWith(prefix))
      .flatMap(prefix => matcherCache.byPrefix.get(prefix) || [])
      .sort((a, b) => a.order - b.order);

    // البحث عن المسؤولية المطابقة
    let matchedResponsibility = null;
    let extractedReason = '';

    for (const { responsibilityName: respName, config: resp, prefix, normalizedShortcut } of candidateEntries) {
      const afterPrefix = content.slice(prefix.length).trim();
      if (!afterPrefix) continue;

      const words = afterPrefix.split(/\s+/);

      // الصيغة 1: الاختصار مباشرة (مثل: -دعم)
      const firstWordNormalized = normalizeArabicWord(removeArabicArticle(words[0]));
      if (firstWordNormalized === normalizedShortcut) {
        matchedResponsibility = respName;
        extractedReason = words.slice(1).join(' ') || 'غير محدد';
        break;
      }

      // الصيغة 2: كلمة مسؤولين + الاختصار (مثل: -مسؤولين دعم، -المسؤولين الدعم)
      const firstWordWithoutArticle = normalizeArabicWord(removeArabicArticle(words[0]));
      const isResponsibleKeyword = RESPONSIBLE_KEYWORDS_NORMALIZED.some(kw =>
        firstWordWithoutArticle.includes(kw) || kw.includes(firstWordWithoutArticle)
      );

      if (isResponsibleKeyword && words.length >= 2) {
        const secondWordNormalized = normalizeArabicWord(removeArabicArticle(words[1]));
        if (secondWordNormalized === normalizedShortcut) {
          matchedResponsibility = respName;
          extractedReason = words.slice(2).join(' ') || 'غير محدد';
          break;
        }
      }

      // الصيغة 3: كلمة ملتصقة (مثل: -مسؤوليندعم)
      if (firstWordWithoutArticle.endsWith(normalizedShortcut)) {
        const potentialKeyword = firstWordWithoutArticle.slice(0, -normalizedShortcut.length);
        if (RESPONSIBLE_KEYWORDS_NORMALIZED.some(kw => potentialKeyword.includes(kw) || kw.includes(potentialKeyword))) {
          matchedResponsibility = respName;
          extractedReason = words.slice(1).join(' ') || 'غير محدد';
          break;
        }
      }
    }
    
    // إذا وجدنا مسؤولية مطابقة
    if (matchedResponsibility) {
      const resp = responsibilities[matchedResponsibility];
      const responsibles = resp.responsibles || [];
      
      // التحقق من صلاحية الأدمن إذا كان الاختصار للأدمن فقط
      if (resp.mentAdminOnly) {
        const adminRoles = loadAdminRoles().map(String);
        let member = message.member;
        let hasAdminRole = member && member.roles.cache.some(role => adminRoles.includes(String(role.id)));
        if (!hasAdminRole) {
          member = await refreshMessageMember(message);
          hasAdminRole = member && member.roles.cache.some(role => adminRoles.includes(String(role.id)));
        }
        
        if (!hasAdminRole) {
          const noPermEmbed = colorManager.createEmbed()
            .setDescription(`**🔒 هذا الاختصار متاح لرولات الأدمن فقط**`)
            .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390144795738175/download__2_-removebg-preview.png');
          await message.channel.send({ embeds: [noPermEmbed] });
          return;
        }
      }
      
      if (responsibles.length === 0) {
        const noRespEmbed = colorManager.createEmbed()
          .setDescription(`**لا يوجد مسؤولين معينين لمسؤولية "${matchedResponsibility}"**`)
          .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390144795738175/download__2_-removebg-preview.png');
        await message.channel.send({ embeds: [noRespEmbed] });
        return;
      }
      
      // إنشاء منشنات منظمة (1. 2. 3. الخ)
      const numberedMentions = responsibles.map((id, index) => `${index + 1}. <@${id}>`).join('\n');
      const timestamp = Date.now();
      
      const usageKey = getShortcutUsageKey(message.guild.id, message.author.id, matchedResponsibility);
      const bypassShortcutCooldown = shortcutBypassKeys.delete(usageKey);
      const usageCooldownLeft = bypassShortcutCooldown ? 0 : getShortcutUsageCooldown(message.guild.id, message.author.id, matchedResponsibility);
      if ((!bypassShortcutCooldown && usageCooldownLeft > 0) || shortcutUsageLocks.has(usageKey)) {
        if (shouldReactToShortcutCooldown(message.guild.id, message.author.id, matchedResponsibility)) {
          await message.react('⏰').catch(() => {});
        }
        return;
      }
      shortcutUsageLocks.add(usageKey);
      const requestCooldownKey = getShortcutRequestKey(message.guild.id, matchedResponsibility);
      if (!bypassShortcutCooldown && shortcutRequestLocks.has(requestCooldownKey)) {
        await message.react('⏳').catch(() => {});
        shortcutUsageLocks.delete(usageKey);
        return;
      }
      shortcutRequestLocks.add(requestCooldownKey);
      try {
        const activeRequest = bypassShortcutCooldown
          ? null
          : findActiveShortcutRequest(message.guild.id, matchedResponsibility, timestamp);
        if (activeRequest) {
          const originalChannel = activeRequest.channelId === message.channel.id
            ? message.channel
            : await client.channels.fetch(activeRequest.channelId).catch(() => null);
          const originalMessage = originalChannel?.messages?.fetch
            ? await originalChannel.messages.fetch(activeRequest.messageId).catch(() => null)
            : null;
          const channelMention = activeRequest.channelId !== message.channel.id
            ? ` <#${message.channel.id}>`
            : '';
          const retryButton = new ButtonBuilder()
            .setCustomId(`shortcut_retry_${activeRequest.requestToken}`)
            .setEmoji('<:emoji_3:1484364952780144710>')
            .setStyle(ButtonStyle.Success);
          const retryRow = new ActionRowBuilder().addComponents(retryButton);
          const duplicateContainer = createStructuredContainer({
            title: 'يوجد مشكلة بالفعل مفتوحه',
            description: [
              `<@${message.author.id}>${channelMention}`,
              '',
              '**إذا كانت لديك مشكلة غير الحالية اضغط الزر.**'
            ].join('\n'),
            thumbnailUrl: message.author.displayAvatarURL({ dynamic: true, size: 128 }),
            accentColor: colorToNumber(colorManager.getColor?.() || '#0099ff', 0x0099ff)
          });
          duplicateContainer.addActionRowComponents(retryRow);
          const duplicatePayload = {
            ...componentsV2Payload(duplicateContainer),
            allowedMentions: { users: [String(message.author.id)], repliedUser: false }
          };
          if (originalMessage?.reply) {
            await originalMessage.reply(duplicatePayload)
              .catch(error => console.error('تعذر إرسال رد الطلب المكرر على رسالة المشكلة:', error.message));
          } else {
            await message.channel.send(duplicatePayload)
              .catch(error => console.error('تعذر إرسال تنبيه الطلب المكرر:', error.message));
          }
          startShortcutUsageCooldown(message.guild.id, message.author.id, matchedResponsibility);
          return;
        }
        const requestToken = require('crypto').randomUUID().replace(/-/g, '');
        const callButtonId = `shortcut_call_${requestToken}`;
        const takeButtonId = `shortcut_take_${requestToken}`;
        const callButton = new ButtonBuilder()
          .setCustomId(callButtonId)
          .setLabel('Call')
          .setEmoji('<:emoji_11:1448570617950371861>')
          .setStyle(ButtonStyle.Secondary);
        const takeButton = new ButtonBuilder()
          .setCustomId(takeButtonId)
          .setLabel('Take')
          .setEmoji('<:emoji_3:1484364952780144710>')
          .setStyle(ButtonStyle.Success);
        const row = new ActionRowBuilder().addComponents(callButton, takeButton);
        const textMessage = `- **مسؤولين ال${matchedResponsibility}**\n\n${numberedMentions}`;
        const sentMessage = await message.channel.send({
          content: textMessage,
          components: [row]
        });
        const requestData = {
          requestToken,
          responsibilityName: matchedResponsibility,
          responsibles: responsibles.map(String),
          requesterId: message.author.id,
          channelId: message.channel.id,
          messageId: sentMessage.id,
          guildId: message.guild.id,
          timestamp,
          createdAt: Date.now(),
          claimedBy: null,
          claimedAt: null
        };
        client.shortcutRequests.set(requestToken, requestData);
        shortcutStore.requests[requestToken] = requestData;
        startShortcutRequestCollector(sentMessage, requestToken);
        pruneRuntimeShortcutRequests();
        startShortcutUsageCooldown(message.guild.id, message.author.id, matchedResponsibility);
        // The request and cooldown are included in the store's debounced batch write.
        // Avoid serializing and rewriting the entire shortcut store on every trigger.
      } finally {
        shortcutRequestLocks.delete(requestCooldownKey);
        shortcutUsageLocks.delete(usageKey);
      }
      return; // انتهاء المعالجة
    }
  } catch (error) {
    console.error('❌ خطأ في معالج اختصارات المنشن:', error);
  }
  // ===== نهاية معالج اختصارات المنشن =====

  try {
    // التحقق من منشن البوت فقط (ليس الرولات) وليس ريبلاي
    if (message.mentions.users.has(client.user.id) && !message.mentions.everyone && !message.reference) {
      const PREFIX = getCachedPrefix(); // استخدام الكاش

      const prefixEmbed = colorManager.createEmbed()
        .setTitle('Details')
        .setDescription(`**البريفكس الحالي:** ${PREFIX === null ? '**لا يوجد بريفكس **' : `\`${PREFIX}\``}`)
        .setThumbnail(client.user.displayAvatarURL())
        .addFields([
          { name: 'To Help', value: `${PREFIX === null ? '' : PREFIX}help`, inline: true },
        ])
        .setFooter({ text: 'Res Bot By Ahmed.' });

      await message.channel.send({ embeds: [prefixEmbed] });
      return;
    }

    // استخدام الكاش للبريفكس بدلاً من القراءة في كل مرة
    const PREFIX = getCachedPrefix();

    // معالج خاص لأمر "إدارة" (نظام التقديم الإداري)
    if (message.content.trim().startsWith('إدارة') || message.content.trim().startsWith('ادارة')) {
      try {
        const adminApplyCommand = client.commands.get('admin-apply');
        if (adminApplyCommand) {
          // إنشاء pseudo interaction للتوافق مع الكود الحالي
          const pseudoInteraction = {
            user: message.author,
            member: message.member,
            guild: message.guild,
            channel: message.channel,
            message: message,
            reply: async (options) => {
              // flags: 64 تعني ephemeral
              if (options.flags === 64 || options.ephemeral) {
                // للرسائل الخاصة، أرسلها للمستخدم مباشرة
                try {
                  await message.author.send(options.content || { embeds: options.embeds });
                } catch {
                  await message.channel.send(`${message.author}, ${options.content || 'رسالة خاصة'}`);
                }
              } else {
                await message.channel.send(options.content || { embeds: options.embeds });
              }
            },
            editReply: async (options) => {
              await message.channel.send(options.content || { embeds: options.embeds });
            },
            deferReply: async () => {
              // لا نحتاج لفعل شيء للرسائل العادية
            },
            deferred: false
          };

          await adminApplyCommand.execute(pseudoInteraction);
          return;
        }
      } catch (error) {
        console.error('خطأ في معالج أمر إدارة:', error);
        await message.reply('❌ حدث خطأ في معالجة طلب التقديم الإداري.');
        return;
      }
    }

  let args, commandName;

    // داونات يعمل بصيغته المباشرة حتى لا يعتمد على اختلاف إعداد البادئة بين النسخ
    if (message.content.trim().toLowerCase() === 'داونات') {
      args = [];
      commandName = 'داونات';
    } else if (PREFIX && PREFIX !== null && PREFIX.trim() !== '') {
      if (!message.content.startsWith(PREFIX)) return;
      args = message.content.slice(PREFIX.length).trim().split(/ +/);
      commandName = args.shift().toLowerCase();
    } else {
      args = message.content.trim().split(/ +/);
      commandName = args.shift().toLowerCase();
    }

    let command = client.commands.get(commandName);
    // fallback مباشر لداونات إذا كان البوت يعمل بنسخة لم تُحدّث محمّل الأوامر فيها
    if (!command && commandName === 'داونات') {
      try {
        command = require('./commands/all-downs-history.js');
        client.commands.set('داونات', command);
      } catch (error) {
        console.error('❌ تعذر تحميل أمر داونات:', error);
        await message.reply('❌ حدث خطأ أثناء تحميل أمر داونات.').catch(() => null);
        return;
      }
    }
    if (!command) return;

    // Check permissions - محسن مع الكاش
    const CURRENT_ADMIN_ROLES = getCachedAdminRoles();
    let member = message.member || null;
    let isOwner = isBotOwner(member || message.author) || message.guild?.ownerId === message.author.id;
    let hasAdminRole = CURRENT_ADMIN_ROLES.some(roleId => member?.roles?.cache?.has(String(roleId)));
    let hasAdministrator = Boolean(member?.permissions?.has('Administrator'));
    if (message.guild && !isOwner && !hasAdminRole && !hasAdministrator) {
      member = await refreshMessageMember(message) || member;
      isOwner = isBotOwner(member || message.author) || message.guild.ownerId === message.author.id;
      hasAdminRole = CURRENT_ADMIN_ROLES.some(roleId => member?.roles?.cache?.has(String(roleId)));
      hasAdministrator = Boolean(member?.permissions?.has('Administrator'));
    }

    // صلاحيات نظام البونس تُفحص داخليًا من إعدادات كل سيرفر، لذلك لا يُربط
    // بصلاحيات المالك العام/الرولات الإدارية المشتركة للأوامر الأخرى.
    if (commandName === 'bonus' || commandName === 'بونس') {
      await command.execute(message, args, { responsibilities, points, scheduleSave, BOT_OWNERS, BOT_OWNER_ROLES, client, colorManager });
      return;
    }
    if (['groups', 'group', 'قروب', 'قروبات', 'setup', 'إعدادات'].includes(commandName)) {
      await command.execute(message, args, { responsibilities, points, scheduleSave, BOT_OWNERS, BOT_OWNER_ROLES, ADMIN_ROLES: CURRENT_ADMIN_ROLES, client, colorManager });
      return;
    }
    if (commandName === 'settings' && ['bonus', 'بونس'].includes(String(args[0] || '').toLowerCase())) {
      await command.execute(message, args, { responsibilities, points, scheduleSave, BOT_OWNERS, BOT_OWNER_ROLES, client, colorManager });
      return;
    }

    // Commands for everyone (help, tops, تفاعلي, ستريكي, profile, myprofile, داوني)
    if (commandName === 'رولي' || commandName === 'tops' || commandName === 'توب' || commandName === 'تفاعلي' || commandName === 'تواجدي' || commandName === 'انهاء' || commandName === 'user' || commandName === 'ستريكي' || commandName === 'profile' || commandName === 'id' || commandName === 'مشاكلي' || commandName === 'myprofile' || commandName === 'داوني' || commandName === 'داوناتي' || commandName === 'داونات' || commandName === 'مسؤولياتي') {
      if (commandName === 'مسؤولياتي') {
        const requestedUser = message.mentions.users.first()
          || (args[0] ? await client.users.fetch(String(args[0]).replace(/[<@!>]/g, '')).catch(() => null) : null);
        const targetUser = requestedUser || message.author;
        const isRequestingSomeoneElse = targetUser.id !== message.author.id;
        if (isRequestingSomeoneElse && !isOwner && !hasAdminRole && !hasAdministrator) {
          await message.reply({ content: '❌ لا تملك صلاحية عرض مسؤوليات عضو آخر.' });
        } else {
          await showUserResponsibilities(message, targetUser, responsibilities, client);
        }
      } else {
        await command.execute(message, args, { responsibilities, points, scheduleSave, BOT_OWNERS, BOT_OWNER_ROLES, ADMIN_ROLES: CURRENT_ADMIN_ROLES, client, colorManager });
      }
    }
    // Commands for everyone (اجازتي)
    else if (commandName === 'اجازتي') {
      await command.execute(message, args, { responsibilities, points, scheduleSave, BOT_OWNERS, BOT_OWNER_ROLES, ADMIN_ROLES: CURRENT_ADMIN_ROLES, client, colorManager });
    }
    // أوامر إدارة المسؤوليات تفحص الأونر/مدير Resp داخل الأمر نفسه.
    else if (commandName === 'resp' || commandName === 'مسؤوليه' || commandName === 'مسؤولية') {
      await command.execute(message, args, { responsibilities, points, scheduleSave, BOT_OWNERS, BOT_OWNER_ROLES, ADMIN_ROLES: CURRENT_ADMIN_ROLES, client, colorManager });
    }
    // Commands for admins and owners (user, مسؤول, اجازه, check, rooms)
      else if (commandName === 'ترقيه' || commandName === 'list' || commandName === 'حذف' || commandName === 'settings' || commandName === 'problem' || commandName === 'مشكله' || commandName === 'word' || commandName === 'roled' || commandName === 'انشاء' || commandName === 'اجازه' || commandName === 'تصفيه' || commandName === 'مسؤولياتي' || commandName === 'اجازتي' || commandName === 'check' || commandName === 'rooms' || commandName === 'ticket' || commandName === 'تكت' || commandName === 'tclose' || commandName === 'اغلاق' || commandName === 'قفل' || commandName === 'اقفال' || commandName === 'myticket' || commandName === 'نقاطي' || commandName === 'tadd' || commandName === 'اضافه' || commandName === 'اضافة' || commandName === 'إضافة' || commandName === 'tremove' || commandName === 'ازاله' || commandName === 'ازالة' || commandName === 'إزالة' || commandName === 'tchange' || commandName === 'تغيير' || commandName === 'تحويل' || commandName === 'ttop' || commandName === 'نقاط' || commandName === 'tname' || commandName === 'اسم' || commandName === 'تسميه' || commandName === 'تسمية' || commandName === 'remind' || commandName === 'تنبيه' || commandName === 'استدعاء' || commandName === 'points' || commandName === 'tm' || commandName === 'treset' || commandName === 'tmreset' || commandName === 'tblock' || commandName === 'close' || commandName === 'open' || commandName === 'hide' || commandName === 'show' || commandName === 'store' || commandName === 'say' || commandName === 'reply' || commandName === 'قفل' || commandName === 'فتح' || commandName === 'اخفاء' || commandName === 'إخفاء' || commandName === 'اظهار' || commandName === 'إظهار' || commandName === 'ستور' || commandName === 'قول' || commandName === 'رد') {
      if (commandName === 'مسؤول') {
        console.log(`🔍 التحقق من صلاحيات المستخدم ${message.author.id} لأمر مسؤول:`);
        console.log(`- isOwner: ${isOwner}`);
        console.log(`- hasAdministrator: ${hasAdministrator}`);
        console.log(`- hasAdminRole: ${hasAdminRole}`);
        console.log(`- CURRENT_ADMIN_ROLES count: ${CURRENT_ADMIN_ROLES.length}`);
        console.log(`- CURRENT_ADMIN_ROLES: ${JSON.stringify(CURRENT_ADMIN_ROLES)}`);
        console.log(`- User roles: ${member.roles.cache.map(r => r.id).join(', ')}`);
        console.log(`- User roles names: ${member.roles.cache.map(r => r.name).join(', ')}`);
      }

      if (hasAdminRole || isOwner || hasAdministrator) {
        if (commandName === 'مسؤول') {
          console.log(`✅ تم منح الصلاحية للمستخدم ${message.author.id}`);
        }
        await command.execute(message, args, { responsibilities, points, scheduleSave, BOT_OWNERS, BOT_OWNER_ROLES, ADMIN_ROLES: CURRENT_ADMIN_ROLES, client, colorManager });
      } else {
        if (commandName === 'مسؤول') {
          console.log(`❌ المستخدم ${message.author.id} لا يملك الصلاحيات المطلوبة لأمر مسؤول`);
        }
        await message.react('❌');
        return;
      }
    }
    // top يقبل المالك والإدارة؛ بقية الأوامر في هذا الفرع تبقى للمالك فقط.
    else if (commandName === 'stats' || commandName === 'setup' || commandName === 'set-vacation' || commandName === 'top' || commandName === 'test') {
      if (isOwner || (commandName === 'top' && (hasAdminRole || hasAdministrator))) {
        await command.execute(message, args, { responsibilities, points, scheduleSave, BOT_OWNERS, BOT_OWNER_ROLES, ADMIN_ROLES: CURRENT_ADMIN_ROLES, client, colorManager });
      } else {
        await message.react('❌');
        return;
      }
    }
    // Commands for owners only (all other commands)
    else {
      if (isOwner) {
        await command.execute(message, args, { responsibilities, points, scheduleSave, BOT_OWNERS, BOT_OWNER_ROLES, ADMIN_ROLES: CURRENT_ADMIN_ROLES, client, colorManager });
      } else {
        await message.react('❌');
        return;
      }
    }
  } catch (error) {
    console.error('خطأ في معالج الرسائل:', error);
  }
});

// معالج حذف الرسائل - لنظام Streak
client.on('messageDelete', async message => {
  try {
    // Handle Streak system message deletion
    const streakCommand = require('./commands/streak.js');
    if (streakCommand && streakCommand.handleMessageDelete) {
      await streakCommand.handleMessageDelete(message, client);
    }
    await handlePanelMessageDelete(message, client);
  } catch (error) {
    console.error('❌ خطأ في معالجة حذف رسالة:', error);
  }
});

client.on('messageDeleteBulk', async messages => {
  try {
    for (const message of messages.values()) {
      await handlePanelMessageDelete(message, client);
    }
  } catch (error) {
    console.error('❌ خطأ في معالجة حذف الرسائل بالجملة:', error);
  }
});

// نظام الحماية ضد إعادة الرولات المسحوبة (للداون والإجازات والمحظورين من الترقيات)
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
        if (problemCommand && typeof problemCommand.handleMemberUpdate === 'function') {
            await problemCommand.handleMemberUpdate(oldMember, newMember, client);
        }

        const userId = newMember.id;
        const oldRoles = oldMember.roles.cache;
        const newRoles = newMember.roles.cache;
        const addedRoles = newRoles.filter(role => !oldRoles.has(role.id));
        const removedRoles = oldRoles.filter(role => !newRoles.has(role.id));
        if (addedRoles.size > 0 || removedRoles.size > 0) {
            try {
                const bonusCommand = client.commands.get('bonus');
                if (bonusCommand?.checkpointMemberVoice) await bonusCommand.checkpointMemberVoice(oldMember);
            } catch (bonusVoiceError) {
                console.error('❌ خطأ في حفظ بونس الصوت قبل تغيير الرول:', bonusVoiceError);
            }
        }
        // حماية طلبات التقديم الإداري: أي رول مسجل في adminRoles يُسحب
        // من صاحب الطلب المعلّق، مهما كان مصدر المنح. منح القبول الرسمي
        // يستعمل bypass مؤقتاً حتى لا تُسحب الرولات فور إضافتها.
        if (addedRoles.size > 0) {
            try {
                const adminRoles = readJSONFile(DATA_FILES.adminRoles, []);
                const adminRoleIds = new Set((Array.isArray(adminRoles) ? adminRoles : [])
                    .map(role => typeof role === 'object' ? role?.id : role)
                    .map(roleId => String(roleId || '').trim())
                    .filter(Boolean));
                const applications = readJSONFile(DATA_FILES.adminApplications, {});
                const pendingApplications = applications?.pendingApplications || {};
                const hasPendingApplication = Object.values(pendingApplications).some(application =>
                    String(application?.candidateId || '') === String(userId)
                );
                if (hasPendingApplication && adminRoleIds.size > 0) {
                    for (const [roleId, role] of addedRoles) {
                        const bypassKey = `${newMember.guild.id}_${userId}_${roleId}`;
                        if (!adminRoleIds.has(String(roleId)) || global.adminRoleGrantBypass?.has(bypassKey)) continue;
                        await newMember.roles.remove(role, 'حماية طلب إداري معلق: منع رول إداري قبل القبول أو الرفض');
                        console.log(`🔒 تم سحب رول الإدارة ${role.name} من صاحب طلب معلق ${newMember.displayName}`);
                    }
                }
            } catch (pendingAdminRoleError) {
                console.error('❌ خطأ في حماية رولات أصحاب الطلبات الإدارية المعلقة:', pendingAdminRoleError);
            }
        }

        try {

            if (addedRoles.size > 0 || removedRoles.size > 0) {

                const grantHistory = readJSONFile(DATA_FILES.roleGrantHistory, {});

                if (!grantHistory[newMember.guild.id]) grantHistory[newMember.guild.id] = {};

                if (!grantHistory[newMember.guild.id][userId]) grantHistory[newMember.guild.id][userId] = {};

                const userHistory = grantHistory[newMember.guild.id][userId];

                const now = Date.now();

                for (const [roleId] of addedRoles) {

                    userHistory[roleId] = now;

                }

                for (const [roleId] of removedRoles) {

                    delete userHistory[roleId];

                }

                if (Object.keys(userHistory).length === 0) {

                    delete grantHistory[newMember.guild.id][userId];

                }

                writeJSONFile(DATA_FILES.roleGrantHistory, grantHistory);

            }

        } catch (trackingError) {

            console.error('❌ خطأ في تحديث تتبع تواريخ الرولات:', trackingError);

        }
        
        // تحديث memberMeta للرولات الخاصة + حماية منع إضافة بوت + إشعار العضو الخاص
        const specialRoleChanges = [];

        for (const [roleId, role] of addedRoles) {
            const roleEntry = getRoleEntry(roleId);
            if (!roleEntry || roleEntry.guildId !== newMember.guild.id) continue;

            if (newMember.user?.bot) {
                await newMember.roles.remove(role, 'حماية الرولات الخاصة: منع إضافة البوتات').catch(() => {});
                continue;
            }

            if (!roleEntry.memberMeta) roleEntry.memberMeta = {};
            roleEntry.memberMeta[userId] = {
                assignedAt: Date.now(),
                assignedBy: null,
                assignedByIsBot: false
            };
            roleEntry.updatedAt = Date.now();
            addRoleEntry(roleId, roleEntry);
            specialRoleChanges.push({ action: 'add', roleId, role, roleEntry });
        }

        
        for (const [roleId, role] of removedRoles) {
            const roleEntry = getRoleEntry(roleId);
            if (!roleEntry || roleEntry.guildId !== newMember.guild.id) continue;
            const removedMeta = roleEntry.memberMeta?.[userId] || null;
            if (roleEntry.memberMeta) {
                delete roleEntry.memberMeta[userId];
            }
            roleEntry.updatedAt = Date.now();
            addRoleEntry(roleId, roleEntry);

            if (!newMember.user?.bot) {
                specialRoleChanges.push({ action: 'remove', roleId, role, roleEntry, assignmentMeta: removedMeta });
            }
        }

        if (specialRoleChanges.length && !newMember.user?.bot) {
            for (const change of specialRoleChanges) {
                const auditInfo = change.auditInfo || await getRecentRoleUpdateExecutor(newMember.guild, newMember.id, change.roleId, change.action);
                let executor = auditInfo?.executor || null;
                const actorIdFromReason = await resolveActorIdFromReason(newMember.guild, auditInfo?.reason || '', newMember.id);
                let assignedById = null;

                // نفس الأولوية في الإضافة والإزالة:
                // 1) الفاعل المستخرج من reason
                // 2) assignedBy القديم (إن وجد)
                assignedById = actorIdFromReason || change.assignmentMeta?.assignedBy || null;

                if ((!executor || executor.bot) && assignedById && String(assignedById) !== String(executor?.id || '')) {
                    executor = await newMember.client.users.fetch(assignedById).catch(() => executor);
                }

                if (change.action === 'add' && change.roleEntry?.memberMeta?.[userId]) {
                    const finalActorId = assignedById || executor?.id || null;
                    if (finalActorId) {
                        change.roleEntry.memberMeta[userId].assignedBy = finalActorId;
                        change.roleEntry.memberMeta[userId].assignedByIsBot = Boolean(executor?.bot);
                        change.roleEntry.updatedAt = Date.now();
                        addRoleEntry(change.roleId, change.roleEntry);
                    }
                }

                await notifyPrivateRoleMemberChange({
                    member: newMember,
                    role: change.role,
                    roleEntry: change.roleEntry,
                    executor,
                    action: change.action
                });
            }
        }

        // مزامنة نظام map open عند التعديل اليدوي للرولات
        if (addedRoles.size > 0 || removedRoles.size > 0) {
            try {
                if (fs.existsSync(DATA_FILES.serverMapConfig)) {
                    const mapConfigs = loadMapConfigsSync();
                    let changed = false;

                    for (const key of Object.keys(mapConfigs)) {
                        const cfg = mapConfigs[key];
                        if (!cfg?.open?.enabled || !cfg.open.roleId) continue;

                        const roleId = cfg.open.roleId;
                        const roleWasAdded = addedRoles.has(roleId);
                        const roleWasRemoved = removedRoles.has(roleId);
                        if (!roleWasAdded && !roleWasRemoved) continue;

                        const currentActive = Array.isArray(cfg.open.activeUsers) ? cfg.open.activeUsers : [];
                        if (roleWasAdded && !currentActive.includes(userId)) {
                            currentActive.push(userId);
                            cfg.open.activeUsers = currentActive;
                            changed = true;
                        }
                        if (roleWasRemoved && currentActive.includes(userId)) {
                            cfg.open.activeUsers = currentActive.filter(id => id !== userId);
                            changed = true;
                        }

                        if (roleWasAdded || roleWasRemoved) {
                            const panelListChanged = await refreshMapOpenPanelsForConfig(newMember.guild, key, cfg);
                            if (panelListChanged) changed = true;
                        }
                    }

                    if (changed) {
                        await writeMapConfigsQueued(mapConfigs);
                    }
                }
            } catch (mapSyncErr) {
                console.error('❌ خطأ في مزامنة map open مع التعديل اليدوي للرول:', mapSyncErr);
            }
        }

        // 1. حماية نظام الداون
        const activeDowns = downManager.getActiveDowns();
        const userActiveDowns = Object.values(activeDowns).filter(down =>
            String(down.userId) === String(userId) && down.status === 'active' &&
            (!down.endTime || Number(down.endTime) > Date.now())
        );
        const adminRoleIds = new Set(getCachedAdminRoles().map(String));

        // التحقق من الرولات المضافة حديثاً للداون
        for (const [roleId, role] of addedRoles) {
            if (!userActiveDowns.length || !adminRoleIds.has(String(roleId))) continue;
            const activeDown = userActiveDowns.find(down => String(down.roleId) === String(roleId)) || userActiveDowns[0];
            if (activeDown) {
                // فحص إذا كان البوت في عملية استعادة الرول (استعادة شرعية)
                if (downManager.isBotRestoring(newMember.guild.id, userId, roleId)) {
                    console.log(`✅ تجاهل إعادة الرول ${role.name} للعضو ${newMember.displayName} - استعادة شرعية بواسطة البوت`);
                    continue;
                }
                // رول تم إضافته بينما هناك داون نشط - يجب إزالته
                console.log(`🚨 محاولة إعادة رول مسحوب (داون): ${role.name} للعضو ${newMember.displayName}`);

                try {
                    // إزالة الرول مرة أخرى
                    await newMember.roles.remove(role, 'منع إعادة رول مسحوب - حماية نظام الداون');

                    // فحص ثاني بعد 10 ثوانٍ للتأكد من الإزالة
                    setTimeout(async () => {
                        try {
                            const updatedMember = await newMember.guild.members.fetch(userId);
                            if (updatedMember.roles.cache.has(roleId)) {
                                await updatedMember.roles.remove(role, 'فحص ثانوي - منع إعادة رول مسحوب');
                                console.log(`🔒 تم إزالة الرول مرة أخرى في الفحص الثانوي: ${role.name}`);
                            }
                        } catch (secondCheckError) {
                            console.error('خطأ في الفحص الثانوي للرول:', secondCheckError);
                        }
                    }, 10000); // 10 ثوانٍ

                    // استخدام نظام السجلات الموحد للحفاظ على التصنيف والتتبع
                    logEvent(client, newMember.guild, {
                        type: 'SECURITY_ACTIONS',
                        title: 'محاولة تجاوز نظام الداون',
                        description: 'تم اكتشاف وإحباط محاولة إعادة رول مسحوب',
                        details: 'نظام الحماية التلقائي تدخل لمنع تجاوز الداون - تم التحقق من نظام تتبع الاستعادة',
                        user: newMember.user,
                        fields: [
                            { name: '👤 العضو المستهدف', value: `<@${userId}>`, inline: true },
                            { name: '🏷️ الرول المُعاد', value: `<@&${roleId}> (${role.name})`, inline: true },
                            { name: '📝 الإجراء المتخذ', value: 'إزالة تلقائية + فحص ثانوي', inline: true },
                            { name: '🚫 السبب الأصلي', value: activeDown.reason || 'غير محدد', inline: false },
                            { name: '📅 ينتهي الداون', value: activeDown.endTime ? `<t:${Math.floor(activeDown.endTime / 1000)}:R>` : 'نهائي', inline: true },
                            { name: '⚡ طُبق بواسطة', value: `<@${activeDown.byUserId}>`, inline: true }
                        ]
                    });

                } catch (removeError) {
                    console.error(`خطأ في إزالة الرول المُعاد إضافته:`, removeError);
                }
            }
        }

        // 2. حماية نظام الإجازات
        const vacations = vacationManager.readJson(path.join(__dirname, 'data', 'vacations.json'));
        const activeVacation = vacations.active?.[userId];

        if (activeVacation && activeVacation.removedRoles) {
            console.log(`🔍 فحص حماية الإجازة للمستخدم ${newMember.displayName}`);

            // التحقق من الرولات المضافة حديثاً
            for (const [roleId, role] of addedRoles) {
                if (activeVacation.removedRoles.includes(roleId)) {
                    // فحص إذا كان البوت في عملية استعادة الرول (استعادة شرعية)
                    if (vacationManager.roleProtection.isBotRestoration(newMember.guild.id, userId, roleId)) {
                        console.log(`✅ تجاهل إعادة الرول ${role.name} للعضو ${newMember.displayName} - استعادة شرعية بواسطة البوت (إجازة)`);
                        continue;
                    }

                    // رول إداري تم إضافته أثناء الإجازة - يجب إزالته
                    console.log(`🚨 محاولة إعادة رول إداري أثناء الإجازة: ${role.name} للعضو ${newMember.displayName}`);

                    try {
                        // إزالة الرول مرة أخرى
                        await newMember.roles.remove(role, 'منع إعادة رول إداري أثناء الإجازة - حماية نظام الإجازات');

                        // فحص ثاني بعد 10 ثوانٍ للتأكد من الإزالة
                        setTimeout(async () => {
                            try {
                                const updatedMember = await newMember.guild.members.fetch(userId);
                                if (updatedMember.roles.cache.has(roleId)) {
                                    await updatedMember.roles.remove(role, 'فحص ثانوي - منع إعادة رول أثناء الإجازة');
                                    console.log(`🔒 تم إزالة الرول مرة أخرى في الفحص الثانوي (إجازة): ${role.name}`);
                                }
                            } catch (secondCheckError) {
                                console.error('خطأ في الفحص الثانوي للرول (إجازة):', secondCheckError);
                            }
                        }, 10000); // 10 ثوانٍ

                        // استخدام نظام السجلات الموحد
                        logEvent(client, newMember.guild, {
                            type: 'SECURITY_ACTIONS',
                            title: 'محاولة تجاوز نظام الإجازات',
                            description: 'تم اكتشاف وإحباط محاولة إعادة رول إداري أثناء الإجازة',
                            details: 'نظام الحماية التلقائي تدخل لمنع تجاوز الإجازة - تم التحقق من نظام تتبع الاستعادة',
                            user: newMember.user,
                            fields: [
                                { name: '👤 العضو في الإجازة', value: `<@${userId}>`, inline: true },
                                { name: '🏷️ الرول المُعاد', value: `<@&${roleId}> (${role.name})`, inline: true },
                                { name: '📝 الإجراء المتخذ', value: 'إزالة تلقائية + فحص ثانوي', inline: true },
                                { name: '🚫 سبب الإجازة', value: activeVacation.reason || 'غير محدد', inline: false },
                                { name: '📅 تنتهي الإجازة', value: `<t:${Math.floor(new Date(activeVacation.endDate).getTime() / 1000)}:R>`, inline: true },
                                { name: '⚡ موافق من', value: `<@${activeVacation.approvedBy}>`, inline: true }
                            ]
                        });

                        // إرسال رسالة تحذيرية للمستخدم
                        try {
                            const user = await client.users.fetch(userId);
                            const warningEmbed = new EmbedBuilder()
                                .setTitle('🚫 تحذير: محاولة استعادة رول أثناء الإجازة')
                                .setColor('#FF0000')
                                .setDescription(`تم اكتشاف محاولة لاستعادة رول إداري أثناء إجازتك النشطة`)
                                .addFields(
                                    { name: '🏷️ الرول المُزال', value: `${role.name}`, inline: true },
                                    { name: '📅 تنتهي إجازتك', value: `<t:${Math.floor(new Date(activeVacation.endDate).getTime() / 1000)}:R>`, inline: true },
                                    { name: '⚠️ تنبيه', value: 'لا يمكن استعادة الأدوار الإدارية أثناء الإجازة. ستتم استعادتها تلقائياً عند انتهاء الإجازة.', inline: false }
                                )
                                .setTimestamp();

                            await user.send({ embeds: [warningEmbed] });
                            console.log(`📧 تم إرسال تحذير للمستخدم ${userId} حول محاولة استعادة الرول أثناء الإجازة`);
                        } catch (dmError) {
                            console.error(`❌ فشل في إرسال تحذير للمستخدم ${userId}:`, dmError.message);
                        }

                    } catch (removeError) {
                        console.error(`خطأ في إزالة الرول المُعاد إضافته أثناء الإجازة:`, removeError);
                    }
                }
            }
        }

        // 3. حماية نظام التقديم الإداري
        const adminApplicationsPath = path.join(__dirname, 'data', 'adminApplications.json');
        if (fs.existsSync(adminApplicationsPath)) {
            try {
                const adminApps = JSON.parse(fs.readFileSync(adminApplicationsPath, 'utf8'));
                const adminRoles = loadAdminRoles();
                
                for (const [roleId, role] of addedRoles) {
                    if (adminRoles.includes(roleId)) {
                        const bypassKey = `${newMember.guild.id}_${userId}_${roleId}`;
                        if (global.adminRoleGrantBypass?.has(bypassKey)) {
                            console.log(`✅ تجاوز حماية التقديم الإداري للرول ${role.name} (موافقة رسمية)`);
                            continue;
                        }

                        // فحص إذا كان العضو لديه طلب معلق
                        const hasPending = adminApps.pendingApplications && Object.values(adminApps.pendingApplications).some(app => app.candidateId === userId);
                        
                        // فحص إذا كان العضو مرفوضاً (كولداون نشط)
                        const cooldown = adminApps.rejectedCooldowns?.[userId];
                        const isRejected = cooldown && (new Date().getTime() < new Date(cooldown.rejectedAt).getTime() + (adminApps.settings.rejectCooldownHours * 60 * 60 * 1000));

                        if (hasPending || isRejected) {
                            console.log(`🚨 منع رول إداري يدوي لـ ${newMember.displayName}: ${role.name} (${hasPending ? 'طلب معلق' : 'مرفوض'})`);
                            try {
                                await newMember.roles.remove(role, hasPending ? 'منع رول إداري - طلب تقديم معلق' : 'منع رول إداري - الشخص مرفوض حالياً');
                                
                                logEvent(client, newMember.guild, {
                                    type: 'SECURITY_ACTIONS',
                                    title: 'منع تعيين رول إداري يدوي',
                                    description: `تم منع إعطاء رول إداري للعضو <@${userId}>`,
                                    user: newMember.user,
                                    fields: [
                                        { name: 'الرول', value: `<@&${roleId}>`, inline: true },
                                        { name: 'السبب', value: hasPending ? 'لديه طلب تقديم قيد الدراسة' : 'تم رفض طلبه مسبقاً وهو في فترة التقييد', inline: true }
                                    ]
                                });
                            } catch (err) {
                                console.error('خطأ في منع الرول الإداري:', err);
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('خطأ في فحص حماية التقديم الإداري:', err);
            }
        }

        // 4. حماية نظام الرولات التفاعلية (setactive)
        const interactiveRolesPath = path.join(__dirname, 'data', 'interactiveRoles.json');
        if (fs.existsSync(interactiveRolesPath)) {
            try {
                const interactiveData = JSON.parse(fs.readFileSync(interactiveRolesPath, 'utf8'));
                const interactiveRoles = interactiveData?.settings?.interactiveRoles || [];
                const pendingRequests = interactiveData?.pendingRequests || {};
                const pendingExceptionRequests = interactiveData?.pendingExceptionRequests || {};
                let hasPendingInteractive = Boolean(pendingRequests[userId])
                    || Object.values(pendingExceptionRequests).some(req => req?.targetId === userId);

                // Validate pending interactive request to avoid false positives from stale JSON entries.
                if (hasPendingInteractive && pendingRequests[userId]) {
                    const requestChannelId = interactiveData?.settings?.requestChannel;
                    const requestChannel = requestChannelId ? newMember.guild.channels.cache.get(requestChannelId) : null;
                    const pendingRecord = pendingRequests[userId];
                    let validPendingRequest = false;

                    if (requestChannel && pendingRecord?.messageId) {
                        const pendingMessage = await requestChannel.messages.fetch(pendingRecord.messageId).catch(() => null);
                        validPendingRequest = Boolean(pendingMessage);
                    }

                    if (!validPendingRequest && requestChannel) {
                        const recentMessages = await requestChannel.messages.fetch({ limit: 50 }).catch(() => null);
                        if (recentMessages) {
                            validPendingRequest = recentMessages.some((msg) => {
                                const hasTarget = typeof msg.content === 'string' && msg.content.includes(`<@${userId}>`);
                                const hasInteractiveControls = Array.isArray(msg.components) && msg.components.some((row) =>
                                    Array.isArray(row.components) && row.components.some((component) => {
                                        const customId = component?.customId || '';
                                        return customId.startsWith('int_approve_') || customId.startsWith('int_reject_trigger_');
                                    })
                                );
                                return hasTarget && hasInteractiveControls;
                            });
                        }
                    }

                    if (!validPendingRequest) {
                        delete interactiveData.pendingRequests[userId];
                        hasPendingInteractive = Object.values(pendingExceptionRequests).some(req => req?.targetId === userId);
                        fs.writeFileSync(interactiveRolesPath, JSON.stringify(interactiveData, null, 2));
                    }
                }

                if (interactiveRoles.length > 0) {
                    let recentRoleUpdateEntries = null;
                    let approverRoleIds = [];
                    try {
                        approverRoleIds = Array.isArray(interactiveData?.settings?.approvers) ? interactiveData.settings.approvers : [];
                    } catch (_) {}

                    for (const [roleId, role] of addedRoles) {
                        if (!interactiveRoles.includes(roleId)) continue;

                        const bypassKey = `${newMember.guild.id}_${userId}_${roleId}`;
                        if (global.interactiveRoleGrantBypass?.has(bypassKey)) {
                            console.log(`✅ تجاوز حماية الرولات التفاعلية للرول ${role.name} (موافقة رسمية)`);
                            continue;
                        }

                        if (hasPendingInteractive) {
                            console.log(`🚨 منع رول تفاعلي أثناء وجود طلب معلق: ${role.name} للعضو ${newMember.displayName}`);
                            try {
                                await newMember.roles.remove(role, 'منع رول تفاعلي - العضو لديه طلب تقديم معلق');
                                logEvent(client, newMember.guild, {
                                    type: 'SECURITY_ACTIONS',
                                    title: 'منع رول تفاعلي أثناء تقديم',
                                    description: `تم منع إعطاء رول تفاعلي للعضو <@${userId}> أثناء وجود طلب معلق`,
                                    user: newMember.user,
                                    fields: [
                                        { name: 'الرول', value: `<@&${roleId}>`, inline: true },
                                        { name: 'السبب', value: 'لديه طلب تفاعلي قيد الدراسة', inline: true }
                                    ]
                                });
                            } catch (err) {
                                console.error('خطأ في منع الرول التفاعلي:', err);
                            }
                            continue;
                        }

                        // منع الإعطاء اليدوي من غير المسؤولين المعتمدين في نظام الرولات التفاعلية.
                        try {
                            if (!recentRoleUpdateEntries) {
                                const logs = await newMember.guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 10 }).catch(() => null);
                                const now = Date.now();
                                recentRoleUpdateEntries = logs?.entries?.filter((entry) => {
                                    if (!entry?.target || entry.target.id !== userId) return false;
                                    if (now - entry.createdTimestamp > 15000) return false;
                                    return true;
                                }) || [];
                            }

                            const recentRoleUpdateEntry = recentRoleUpdateEntries.find((entry) =>
                                entry.changes?.some((change) =>
                                    change?.key === '$add' && Array.isArray(change.new) && change.new.some((r) => r?.id === roleId)
                                )
                            ) || null;

                            const executor = recentRoleUpdateEntry?.executor || null;
                            const executorMember = executor ? await newMember.guild.members.fetch(executor.id).catch(() => null) : null;
                            const isAllowedExecutor = Boolean(
                                executorMember && isBotOwner(executorMember)
                                    || approverRoleIds.some((approverRoleId) => executorMember.roles.cache.has(approverRoleId))
                                )
                            

if (executorMember && !isAllowedExecutor) {

                                                   await newMember.roles.remove(role, 'منع إعطاء رول تفاعلي يدوي من غير المسؤولين المعتمدين');
                                logEvent(client, newMember.guild, {
                                    type: 'SECURITY_ACTIONS',
                                    title: 'منع إعطاء رول تفاعلي يدوي',
                                    description: `تم منع إعطاء رول تفاعلي للعضو <@${userId}> من جهة غير معتمدة`,
                                    user: newMember.user,
                                    fields: [
                                        { name: 'الرول', value: `<@&${roleId}>`, inline: true },
                                        { name: 'المنفذ', value: executor ? `<@${executor.id}>` : 'غير معروف', inline: true },
                                        { name: 'السبب', value: 'يسمح فقط للمسؤولين المعتمدين إعطاء الرولات التفاعلية يدوياً', inline: false }
                                    ]
                                });
                     
                            } else if (!executorMember) {

                                console.log(`⚠️ تعذر تحديد منفذ إعطاء الرول ${role.name} للعضو ${newMember.displayName}، تم تجاهل الحماية لهذه العملية لتجنب إزالة رول صحيح.`);

                 }
                        } catch (err) {
                            console.error('خطأ في التحقق من صلاحية مانح الرول التفاعلي:', err);
                        }
                    }
                }
            } catch (err) {
                console.error('خطأ في فحص حماية الرولات التفاعلية:', err);
            }
        }

        // 4. حماية نظام التذاكر والمنع من الترقيات (المحظورين من الترقيات)
        const promoteBans = promoteManager.getPromotionBans();
        const banKey = `${userId}_${newMember.guild.id}`;
        const banData = promoteBans[banKey];

        if (banData && banData.savedHighestRole) {
            console.log(`🔍 فحص حماية الحظر من الترقيات للمستخدم ${newMember.displayName}`);

            const adminRoles = promoteManager.getAdminRoles();
            const savedRolePosition = banData.savedHighestRole.position;

            // التحقق من الرولات الإدارية المضافة حديثاً
            for (const [roleId, role] of addedRoles) {
                // تحقق إذا كان الرول إداري
                if (!adminRoles.includes(roleId)) continue;

                // فحص إذا كان البوت في عملية ترقية شرعية
                if (promoteManager.isBotPromoting(newMember.guild.id, userId, roleId)) {
                    console.log(`✅ تجاهل إضافة الرول ${role.name} - عملية ترقية شرعية من البوت`);
                    continue;
                }

                // فحص موقع الرول بالنسبة للرول المحفوظ
                if (role.position > savedRolePosition) {
                    // رول أعلى من المحفوظ - يجب إزالته
                    console.log(`🚨 محاولة إضافة رول أعلى من المحفوظ: ${role.name} (${role.position}) > ${banData.savedHighestRole.name} (${savedRolePosition})`);

                    try {
                        // الحصول على معلومات من قام بالإضافة
                        const auditLogs = await newMember.guild.fetchAuditLogs({
                            type: 25, // MEMBER_ROLE_UPDATE
                            limit: 1
                        });

                        const roleAddLog = auditLogs.entries.first();
                        let addedByUser = null;

                        if (roleAddLog && roleAddLog.target.id === userId && 
                            (Date.now() - roleAddLog.createdTimestamp) < 5000) {
                            addedByUser = roleAddLog.executor;
                        }

                        // إزالة الرول
                        await newMember.roles.remove(role, 'منع إضافة رول أعلى من المحفوظ - محظور من الترقيات');

                        console.log(`🔒 تم إزالة الرول ${role.name} من ${newMember.displayName}`);

                        // فحص ثانوي بعد 10 ثوانٍ للتأكد من الإزالة
                        setTimeout(async () => {
                            try {
                                const updatedMember = await newMember.guild.members.fetch(userId);
                                if (updatedMember.roles.cache.has(roleId)) {
                                    await updatedMember.roles.remove(role, 'فحص ثانوي - منع إضافة رول أعلى من المحفوظ');
                                    console.log(`🔒 تم إزالة الرول مرة أخرى في الفحص الثانوي (حظر ترقيات): ${role.name}`);

                                    // إرسال تحذير إضافي في اللوق
                                    logEvent(client, newMember.guild, {
                                        type: 'SECURITY_ACTIONS',
                                        title: 'فحص ثانوي - محاولة تجاوز حظر الترقية',
                                        description: 'تم اكتشاف محاولة ثانية لإضافة رول محظور',
                                        details: 'الفحص الثانوي تدخل لإزالة الرول مرة أخرى',
                                        user: newMember.user,
                                        fields: [
                                            { name: '👤 العضو المحظور', value: `<@${userId}>`, inline: true },
                                            { name: '🏷️ الرول', value: `${role.name}`, inline: true },
                                            { name: '⚠️ التحذير', value: 'محاولة متكررة لتجاوز الحظر', inline: false }
                                        ]
                                    });
                                } else {
                                    console.log(`✅ الفحص الثانوي: الرول ${role.name} مُزال بنجاح`);
                                }
                            } catch (secondCheckError) {
                                console.error('خطأ في الفحص الثانوي للرول (حظر ترقيات):', secondCheckError);
                            }
                        }, 10000); // 10 ثوانٍ

                        // إرسال رسالة للشخص الذي حاول الإضافة
                        if (addedByUser) {
                            try {
                                const warningEmbed = colorManager.createEmbed()
                                    .setTitle('⚠️ محاولة ترقية محظور')
                                    .setDescription(`تم منع إضافة رول لعضو محظور من الترقيات`)
                                    .addFields([
                                        { name: '👤 العضو المستهدف', value: `${newMember}`, inline: true },
                                        { name: '🏷️ الرول المحاول إضافته', value: `${role}`, inline: true },
                                        { name: '🔒 الرول المحفوظ', value: `${banData.savedHighestRole.name}`, inline: true },
                                        { name: '⚠️ ملاحظة', value: `يُسمح فقط بإضافة رولات أقل من أو مساوية لـ **${banData.savedHighestRole.name}**`, inline: false },
                                        { name: '📋 سبب الحظر', value: banData.reason || 'غير محدد', inline: false },
                                        { name: '📅 ينتهي الحظر', value: banData.endTime ? `<t:${Math.floor(banData.endTime / 1000)}:R>` : 'نهائي', inline: true }
                                    ])
                                    .setTimestamp();

                                await addedByUser.send({ embeds: [warningEmbed] });
                                console.log(`📧 تم إرسال تحذير لـ ${addedByUser.tag} حول محاولة الترقية`);
                            } catch (dmError) {
                                console.log(`⚠️ لا يمكن إرسال رسالة لـ ${addedByUser.tag}`);
                            }
                        }

                        // تسجيل في اللوقات
                        logEvent(client, newMember.guild, {
                            type: 'SECURITY_ACTIONS',
                            title: 'منع ترقية محظور',
                            description: 'تم منع إضافة رول أعلى من المحفوظ لعضو محظور',
                            details: 'نظام الحماية منع محاولة تجاوز حظر الترقية',
                            user: newMember.user,
                            fields: [
                                { name: '👤 العضو المحظور', value: `<@${userId}>`, inline: true },
                                { name: '🏷️ الرول المحاول', value: `${role.name} (موقع: ${role.position})`, inline: true },
                                { name: '🔒 الرول المحفوظ', value: `${banData.savedHighestRole.name} (موقع: ${savedRolePosition})`, inline: true },
                                { name: '👮 محاولة من', value: addedByUser ? `<@${addedByUser.id}>` : 'غير معروف', inline: true },
                                { name: '📋 سبب الحظر', value: banData.reason || 'غير محدد', inline: false },
                                { name: '📅 ينتهي الحظر', value: banData.endTime ? `<t:${Math.floor(banData.endTime / 1000)}:R>` : 'نهائي', inline: true }
                            ]
                        });

                    } catch (removeError) {
                        console.error(`خطأ في إزالة الرول الأعلى:`, removeError);
                    }
                } else {
                    // رول أقل من أو مساوي للمحفوظ - مسموح
                    console.log(`✅ السماح بإضافة الرول ${role.name} (${role.position}) <= ${banData.savedHighestRole.name} (${savedRolePosition})`);
                }
            }
        }

        // 4. حماية رولات المسؤوليات - إزالة تلقائية من غير المسؤولين والحماية من الإزالة
        const responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
        
        // فحص الرولات المضافة
        for (const [roleId, role] of addedRoles) {
            // البحث عن المسؤولية التي تحتوي هذا الرول
            let foundResp = null;
            for (const [respName, resp] of Object.entries(responsibilities)) {
                if (resp.roles && resp.roles.includes(roleId)) {
                    foundResp = { name: respName, data: resp };
                    break;
                }
            }

            if (foundResp) {
                // التحقق من أن المستخدم مسؤول في هذه المسؤولية
                const isResponsible = foundResp.data.responsibles && foundResp.data.responsibles.includes(userId);
                const isSupervisor = isSupervisorForResponsibility(newMember.guild.id, foundResp.name, newMember);
                
                if (!isResponsible && !isSupervisor) {
                    // شخص غير مسؤول حصل على رول المسؤولية - يجب إزالته
                    console.log(`🚨 محاولة أخذ رول مسؤولية من غير مسؤول: ${role.name} للعضو ${newMember.displayName}`);
                    
                    try {
                        await newMember.roles.remove(role, 'منع رول مسؤولية - العضو ليس مسؤولاً');
                        
                        // فحص ثانوي بعد 10 ثوانٍ
                        setTimeout(async () => {
                            try {
                                const updatedMember = await newMember.guild.members.fetch(userId);
                                if (updatedMember.roles.cache.has(roleId)) {
                                    await updatedMember.roles.remove(role, 'فحص ثانوي - منع رول مسؤولية');
                                    console.log(`🔒 تم إزالة رول المسؤولية مرة أخرى: ${role.name}`);
                                }
                            } catch (secondCheckError) {
                                console.error('خطأ في الفحص الثانوي لرول المسؤولية:', secondCheckError);
                            }
                        }, 10000);
                        
                        logEvent(client, newMember.guild, {
                            type: 'SECURITY_ACTIONS',
                            title: 'منع رول مسؤولية من غير مسؤول',
                            description: 'تم منع عضو غير مسؤول من الحصول على رول مسؤولية',
                            user: newMember.user,
                            fields: [
                                { name: '👤 العضو', value: `<@${userId}>`, inline: true },
                                { name: '🏷️ الرول', value: `<@&${roleId}> (${role.name})`, inline: true },
                                { name: '📂 المسؤولية', value: foundResp.name, inline: true },
                                { name: '⚠️ السبب', value: 'العضو ليس مسؤولاً أو مشرفاً في هذه المسؤولية', inline: false }
                            ]
                        });
                    } catch (removeError) {
                        console.error(`خطأ في إزالة رول المسؤولية:`, removeError);
                    }
                }
            }
        }
        
        // فحص الرولات المحذوفة (حماية ضد الإزالة اليدوية)
        for (const [roleId, role] of removedRoles) {
            // البحث عن المسؤولية التي تحتوي هذا الرول
            let foundResp = null;
            for (const [respName, resp] of Object.entries(responsibilities)) {
                if (resp.roles && resp.roles.includes(roleId)) {
                    foundResp = { name: respName, data: resp };
                    break;
                }
            }

            if (foundResp) {
                // التحقق من أن المستخدم مسؤول في هذه المسؤولية
                const isResponsible = foundResp.data.responsibles && foundResp.data.responsibles.includes(userId);
                const isSupervisor = isSupervisorForResponsibility(newMember.guild.id, foundResp.name, newMember);
                
                if (isResponsible || isSupervisor) {
                    // مسؤول تم إزالة رول المسؤولية منه - يجب إعادته
                    console.log(`🔄 إعادة رول مسؤولية تم إزالته: ${role.name} للمسؤول ${newMember.displayName}`);
                    
                    try {
                        await newMember.roles.add(role, `إعادة رول المسؤولية: ${foundResp.name}`);
                        console.log(`✅ تم إعادة رول ${role.name} للمسؤول ${newMember.displayName}`);
                        
                        logEvent(client, newMember.guild, {
                            type: 'SECURITY_ACTIONS',
                            title: 'إعادة رول مسؤولية محذوف',
                            description: 'تم إعادة رول مسؤولية تمت إزالته من مسؤول',
                            user: newMember.user,
                            fields: [
                                { name: '👤 المسؤول', value: `<@${userId}>`, inline: true },
                                { name: '🏷️ الرول المُعاد', value: `<@&${roleId}> (${role.name})`, inline: true },
                                { name: '📂 المسؤولية', value: foundResp.name, inline: true },
                                { name: '✅ الإجراء', value: 'تمت إعادة الرول تلقائياً', inline: false }
                            ]
                        });
                    } catch (addError) {
                        console.error(`❌ خطأ في إعادة رول المسؤولية:`, addError);
                    }
                }
            }
        }

        // تحديث قروب البونس بعد حفظ تاريخ منح/سحب الرول؛ ينقل الرصيد والتقدم
        // الجزئي إلى القروب الجديد ضمن معاملة SQLite واحدة.
        if (addedRoles.size > 0 || removedRoles.size > 0) {
            try {
                const bonusCommand = client.commands.get('bonus');
                if (bonusCommand?.handleMemberRoleUpdate) {
                    await bonusCommand.handleMemberRoleUpdate(oldMember, newMember);
                }
            } catch (bonusRoleError) {
                console.error('❌ خطأ في مزامنة قروب البونس بعد تغيير الرول:', bonusRoleError);
            }
        }

    } catch (error) {
        console.error('خطأ في نظام الحماية:', error);
    }
});

// نظام حماية عند الانسحاب - حفظ بيانات الداون
client.on('guildMemberRemove', async (member) => {
    try {
        console.log(`📤 عضو غادر السيرفر: ${member.displayName} (${member.id})`);

        try {
            const bonusCommand = client.commands.get('bonus');
            if (bonusCommand?.handleMemberLeave) await bonusCommand.handleMemberLeave(member);
        } catch (bonusLeaveError) {
            console.error('❌ خطأ في حفظ رصيد البونس عند مغادرة العضو:', bonusLeaveError);
        }

        const assignmentRemoval = await removeMemberFromResponsibilityAssignmentsOnLeave(member);
        if (assignmentRemoval.responsibilities.length || assignmentRemoval.supervisors.length) {
            console.log(`🧹 تمت إزالة العضو ${member.id} فورًا من المسؤوليات (${assignmentRemoval.responsibilities.join('، ') || 'لا يوجد'}) والإشراف (${assignmentRemoval.supervisors.join('، ') || 'لا يوجد'})`);
        }
        const tracker = getResponsibilityLeaveTracker();
        if (!tracker.guilds[member.guild.id]) tracker.guilds[member.guild.id] = { leftAtByUser: {}, removedByUser: {} };
        tracker.guilds[member.guild.id].leftAtByUser = tracker.guilds[member.guild.id].leftAtByUser || {};
        delete tracker.guilds[member.guild.id].leftAtByUser[member.id];
        saveResponsibilityLeaveTracker(tracker);

        // Handle down system member leave
        const downManager = require('./utils/downManager');
        await downManager.handleMemberLeave(member);

        // Handle promotion system member leave
        await promoteManager.handleMemberLeave(member);

        // Handle vacation system member leave
        await vacationManager.handleMemberLeave(member);

        // تحديث بيانات الرولات الخاصة عند المغادرة
        const customRoles = getGuildRoles(member.guild.id);
        for (const roleEntry of customRoles) {
            if (roleEntry.memberMeta && roleEntry.memberMeta[member.id]) {
                delete roleEntry.memberMeta[member.id];
                roleEntry.updatedAt = Date.now();
                addRoleEntry(roleEntry.roleId, roleEntry);
            }
        }

        const ownedRoleEntry = findRoleByOwner(member.guild.id, member.id);
        if (ownedRoleEntry) {
            const role = member.guild.roles.cache.get(ownedRoleEntry.roleId) || await member.guild.roles.fetch(ownedRoleEntry.roleId).catch(() => null);
            if (role && role.editable) {
                await role.delete(`حذف رول خاص بعد مغادرة المالك ${member.id}`).catch(() => {});
            }
            deleteRoleEntry(ownedRoleEntry.roleId, member.id);
            console.log(`🗑️ تم حذف رول خاص بعد مغادرة المالك: ${ownedRoleEntry.roleId}`);
        }

    } catch (error) {
        console.error('خطأ في معالج الانسحاب:', error);
    }
});

// نظام حماية عند العودة - إعادة تطبيق الداون والترقيات ورولات المسؤوليات
client.on('guildMemberAdd', async (member) => {
    try {
        console.log(`📥 عضو انضم للسيرفر: ${member.displayName} (${member.id})`);
        try {
            const bonusCommand = client.commands.get('bonus');
            if (bonusCommand?.handleMemberJoin) await bonusCommand.handleMemberJoin(member);
        } catch (bonusJoinError) {
            console.error('❌ خطأ في استعادة رصيد البونس عند عودة العضو:', bonusJoinError);
        }
        const tracker = getResponsibilityLeaveTracker();
        const guildTracker = tracker.guilds?.[member.guild.id];
        const removalInfo = guildTracker?.removedByUser?.[member.id] || null;
        if (guildTracker?.leftAtByUser?.[member.id]) {
            delete guildTracker.leftAtByUser[member.id];
        }
        if (removalInfo) {
            delete guildTracker.removedByUser[member.id];
            saveResponsibilityLeaveTracker(tracker);
            const removedList = Array.isArray(removalInfo.responsibilities) && removalInfo.responsibilities.length
                ? removalInfo.responsibilities.join('، ')
                : 'غير محدد';
            const notifyEmbed = colorManager.createEmbed()
                .setTitle('تنبيه المسؤوليات')
                .setDescription(`تمت إزالتك من المسؤوليات تلقائياً بسبب بقائك خارج السيرفر أكثر من 6 ساعات.\n\n**المسؤوليات المتأثرة:** ${removedList}`);
            await member.send({ embeds: [notifyEmbed] }).catch(() => {});
            await updateResponsibilitiesEmbedForGuild(member.guild.id);
        } else {
            saveResponsibilityLeaveTracker(tracker);
        }

        // Handle down system member join
        const downManager = require('./utils/downManager');
        await downManager.handleMemberJoin(member);

        // Handle promotion system member join
        await promoteManager.handleMemberJoin(member);

        // Handle vacation system member join
        await vacationManager.handleMemberJoin(member);

        // Handle responsibility roles restoration
        const responsibilities = readJSONFile(DATA_FILES.responsibilities, {});
        const userId = member.id;
        let rolesRestored = 0;
        
        for (const [respName, respData] of Object.entries(responsibilities)) {
            // التحقق من أن العضو مسؤول في هذه المسؤولية
            if (respData.responsibles && respData.responsibles.includes(userId)) {
                // إعادة جميع رولات المسؤولية
                if (respData.roles && respData.roles.length > 0) {
                    for (const roleId of respData.roles) {
                        try {
                            const role = await member.guild.roles.fetch(roleId);
                            if (role && !member.roles.cache.has(roleId)) {
                                await member.roles.add(role, `إعادة رول المسؤولية عند العودة: ${respName}`);
                                rolesRestored++;
                                console.log(`✅ تم إعادة رول ${role.name} للمسؤول ${member.displayName}`);
                            }
                        } catch (roleError) {
                            console.error(`❌ خطأ في إعادة رول ${roleId}:`, roleError.message);
                        }
                    }
                }
            }
        }
        
        if (rolesRestored > 0) {
            console.log(`✅ تم إعادة ${rolesRestored} رول مسؤولية للعضو ${member.displayName}`);
            
            logEvent(client, member.guild, {
                type: 'RESPONSIBILITY_MANAGEMENT',
                title: 'إعادة رولات المسؤولية عند العودة',
                description: `تم إعادة رولات المسؤولية للعضو عند عودته للسيرفر`,
                user: member.user,
                fields: [
                    { name: '👤 العضو', value: `<@${userId}>`, inline: true },
                    { name: '🔢 عدد الرولات', value: rolesRestored.toString(), inline: true },
                    { name: '✅ الإجراء', value: 'تمت إعادة الرولات تلقائياً', inline: false }
                ]
            });
        }

    } catch (error) {
        console.error('خطأ في معالج العودة:', error);
    }
});

function registerMapOpenPanelMessage(config, channelId, messageId) {
    if (!config?.open || !/^\d{17,19}$/.test(channelId) || !/^\d{17,19}$/.test(messageId)) return false;
    const existing = Array.isArray(config.open.panelMessages) ? config.open.panelMessages : [];
    const filtered = existing.filter(item => item?.channelId && item?.messageId);
    const deduped = filtered.filter(item => !(item.channelId === channelId && item.messageId === messageId));
    deduped.unshift({ channelId, messageId, updatedAt: Date.now() });
    config.open.panelMessages = deduped.slice(0, 20);
    return true;
}

function buildMapOpenRows(config, configKey) {
    const counterMode = config.open?.counterButton?.mode === 'label_number' ? 'label_number' : 'emoji_digits';
    const digitMap = {
        '0': '<:emoji_27:1482578058199302195>',
        '1': '<:emoji_27:1482578008542937159>',
        '2': '<:emoji_28:1482578088511672320>',
        '3': '<:emoji_29:1482578116374433833>',
        '4': '<:emoji_29:1482578165485277295>',
        '5': '<:emoji_31:1482578227611435079>',
        '6': '<:emoji_32:1482578278966366208>',
        '7': '<:emoji_33:1482578299426177115>',
        '8': '<:emoji_35:1482578353771905157>',
        '9': '<:emoji_35:1482578379185324124>'
    };
    const activeCount = Array.isArray(config.open?.activeUsers) ? config.open.activeUsers.length : 0;

    const openButton = new ButtonBuilder()
        .setCustomId(`map_open_toggle_${configKey}`)
        .setLabel((config.open?.openButton?.label || 'اوبن').slice(0, 80))
        .setStyle(config.open?.openButton?.style || ButtonStyle.Success)
        .setDisabled(!config.open?.roleId || !/^\d{17,19}$/.test(config.open.roleId));
    if (config.open?.openButton?.emoji) openButton.setEmoji(config.open.openButton.emoji);

    const counterStyle = config.open?.counterButton?.style || ButtonStyle.Secondary;
    const rebuiltRows = [];

    if (counterMode === 'label_number') {
        const formattedCount = activeCount.toLocaleString('en-US');
        const counterButton = new ButtonBuilder()
            .setCustomId(`map_open_count_${configKey}`)
            .setStyle(counterStyle)
            .setDisabled(true)
            .setLabel(formattedCount);

        if (config.open?.counterButton?.emoji) counterButton.setEmoji(config.open.counterButton.emoji);
        rebuiltRows.push(new ActionRowBuilder().addComponents(openButton, counterButton));
        return rebuiltRows;
    }

    const digits = String(Math.max(0, Number(activeCount) || 0)).split('');
    let digitIndex = 0;

    const firstRow = new ActionRowBuilder().addComponents(openButton);
    while (digitIndex < digits.length && firstRow.components.length < 5) {
        const emoji = digitMap[digits[digitIndex]];
        if (emoji) {
            firstRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`map_open_count_${configKey}_${digitIndex}`)
                    .setStyle(counterStyle)
                    .setDisabled(true)
                    .setEmoji(emoji)
            );
        }
        digitIndex += 1;
    }
    rebuiltRows.push(firstRow);

    while (digitIndex < digits.length) {
        const row = new ActionRowBuilder();
        while (digitIndex < digits.length && row.components.length < 5) {
            const emoji = digitMap[digits[digitIndex]];
            if (emoji) {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`map_open_count_${configKey}_${digitIndex}`)
                        .setStyle(counterStyle)
                        .setDisabled(true)
                        .setEmoji(emoji)
                );
            }
            digitIndex += 1;
        }
        if (row.components.length > 0) rebuiltRows.push(row);
    }

    return rebuiltRows;
}

async function refreshMapOpenPanelsForConfig(guild, configKey, config) {
    if (!guild || !config?.open?.enabled) return false;
    const entries = Array.isArray(config.open.panelMessages) ? config.open.panelMessages : [];
    if (entries.length === 0) return false;

    const updatedRows = buildMapOpenRows(config, configKey);
    const keptEntries = [];

    for (const entry of entries) {
        if (!entry?.channelId || !entry?.messageId) continue;
        const channel = guild.channels.cache.get(entry.channelId) || await guild.channels.fetch(entry.channelId).catch(() => null);
        if (!channel?.isTextBased?.()) continue;
        const msg = await channel.messages.fetch(entry.messageId).catch(() => null);
        if (!msg) continue;
        await msg.edit({ components: updatedRows }).catch(() => null);
        keptEntries.push(entry);
    }

    const before = JSON.stringify(entries);
    const after = JSON.stringify(keptEntries);
    config.open.panelMessages = keptEntries;
    return before !== after;
}



async function handleMapOpenInteraction(interaction) {
    const configPath = DATA_FILES.serverMapConfig;
    if (!fs.existsSync(configPath)) {
        ensureDataFiles();
        await interaction.reply({ content: '⚠️ حدث خطأ في الإعدادات، يرجى المحاولة مرة أخرى.', ephemeral: true }).catch(() => {});
        return true;
    }

    const allConfigs = loadMapConfigsSync();

    if (interaction.customId.startsWith('map_open_count_')) {
        await interaction.reply({ content: 'ℹ️ هذا زر عداد فقط وغير قابل للتفعيل.', ephemeral: true }).catch(() => {});
        return true;
    }

    if (!interaction.customId.startsWith('map_open_toggle_')) return false;

    const rawKey = interaction.customId.replace('map_open_toggle_', '');
    const configKey = rawKey === 'global' ? 'global' : (rawKey.startsWith('channel_') ? rawKey : `channel_${rawKey}`);
    const config = allConfigs[configKey] || allConfigs.global;

    if (!config?.open?.enabled) {
        await interaction.reply({ content: '⚠️ نظام open غير مفعل حالياً.', ephemeral: true }).catch(() => {});
        return true;
    }

    if (!interaction.guild) {
        await interaction.reply({ content: '❌ هذا الزر يعمل داخل السيرفر فقط.', ephemeral: true }).catch(() => {});
        return true;
    }

    const roleId = config.open.roleId;
    if (!roleId || !/^\d{17,19}$/.test(roleId)) {
        await interaction.reply({ content: '❌ إعدادات الرول غير صحيحة، يرجى ضبط map-setup open.', ephemeral: true }).catch(() => {});
        return true;
    }

    let member = interaction.guild.members.cache.get(interaction.user.id);
    if (!member) member = await interaction.guild.members.fetch(interaction.user.id);

    let role = interaction.guild.roles.cache.get(roleId);
    if (!role) role = await interaction.guild.roles.fetch(roleId).catch(() => null);

    if (!role) {
        await interaction.reply({ content: '❌ لم يتم العثور على الرول المحدد. تأكد أن الرول ما انحذف.', ephemeral: true }).catch(() => {});
        return true;
    }

    const hadRole = member.roles.cache.has(role.id);
    let deferredReply = false;

    try {
        await interaction.deferReply({ ephemeral: true });
        deferredReply = true;
    } catch (_) {
        deferredReply = false;
    }

    try {
        if (hadRole) await member.roles.remove(role, 'إزالة رول Open عبر map open');
        else await member.roles.add(role, 'إعطاء رول Open عبر map open');
    } catch (roleManageErr) {
        const msg = roleManageErr?.code === 50013
            ? '❌ ما أقدر أعدل هذا الرول. تأكد أن رتبة البوت أعلى من الرول ومعه صلاحية Manage Roles.'
            : `❌ فشل تعديل الرول: ${roleManageErr.message || 'خطأ غير معروف'}`;
        if (deferredReply) await interaction.editReply({ content: msg }).catch(() => {});
        else await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
        return true;
    }

    const currentActive = Array.isArray(config.open.activeUsers) ? config.open.activeUsers : [];
    if (hadRole) config.open.activeUsers = currentActive.filter(id => id !== member.id);
    else if (!currentActive.includes(member.id)) config.open.activeUsers = [...currentActive, member.id];

    allConfigs[configKey] = config;
    await writeMapConfigsQueued(allConfigs);

    registerMapOpenPanelMessage(config, interaction.channelId, interaction.message.id);
    const rebuiltRows = buildMapOpenRows(config, configKey);

    try {
        await interaction.message.edit({ components: rebuiltRows });
    } catch (e) {
        console.error('Failed to update open counter button:', e.message);
    }

    const grantMsg = config.open.grantMessage || '✅ تم اعطائك رول الاوبن الان يمكنك رؤيه الرومات.';
    const removeMsg = config.open.removeMessage || '✅ تم ازالة رول الاوبن ولم يعد بإمكانك رؤية الرومات.';
    if (deferredReply) await interaction.editReply({ content: hadRole ? removeMsg : grantMsg }).catch(() => {});
    else await interaction.reply({ content: hadRole ? removeMsg : grantMsg, ephemeral: true }).catch(() => {});
    return true;
}

interactionRouter.register('map_open_', async (interaction) => {
    if (!interaction.isButton()) return false;
    return await handleMapOpenInteraction(interaction);
}, { name: 'map_open', priority: 90, types: ['button'] });

// معالج التفاعلات المحسن للأداء
client.on('interactionCreate', async (interaction) => {
    if (interaction.replied || interaction.deferred) return;
  try {
    // تعريف customId في البداية
    const customId = interaction?.customId || '';

    // Responsibility supervisor panel (settings button and مشرف command)
    if (customId.startsWith('supervisor_')) {
        const supervisorCommand = client.commands.get('مشرف') || client.commands.get('supervisor');
        if (supervisorCommand?.handleInteraction) {
            await supervisorCommand.handleInteraction(interaction, { client, BOT_OWNERS, BOT_OWNER_ROLES });
        }
        return;
    }

    if (await interactionRouter.route(interaction, { client, BOT_OWNERS, BOT_OWNER_ROLES })) {
        return;
    }
if ((interaction.isButton() || interaction.isModalSubmit() || interaction.isRoleSelectMenu() || interaction.isStringSelectMenu()) && customId.startsWith('word_')) {

        const wordCommand = client.commands.get('word');

        if (wordCommand && typeof wordCommand.handleInteraction === 'function') {

            const consumed = await wordCommand.handleInteraction(interaction, { client, BOT_OWNERS, BOT_OWNER_ROLES });

            if (consumed !== false) {

                return;

            }

        }

    }
    // أزرار التدمير القديمة أصبحت معطلة لتجنب جلب جميع الأعضاء وإنشاء/حذف مئات الموارد.
    if (interaction.isButton() && (interaction.customId === 'die_action' || interaction.customId === 'Dead_action' || interaction.customId.startsWith('die_action_') || interaction.customId.startsWith('Dead_action_'))) {
        await interaction.reply({
            content: '❌ هذا الإجراء معطل لحماية السيرفر ومنع العمليات عالية الاستهلاك.',
            flags: MessageFlags.Ephemeral
        }).catch(() => {});
        return;
    }

    // --- Start of Consolidated Handlers ---

    // 1. Handle setactive and interactiveRolesManager
    const setactiveCommand = client.commands.get('setactive');
    if (setactiveCommand && typeof setactiveCommand.handleSetActiveInteraction === 'function') {
        try {
            await setactiveCommand.handleSetActiveInteraction(interaction);
        } catch (e) {
            console.error('Error in setactiveCommand:', e);
        }
    }
    
    // Check if interactiveRolesManager is defined and has the method
    if (typeof interactiveRolesManager !== 'undefined' && interactiveRolesManager && typeof interactiveRolesManager.handleInteraction === 'function') {
        try {
            await interactiveRolesManager.handleInteraction(interaction);
        } catch (e) {
            console.error('Error in interactiveRolesManager:', e);
        }
    }

    // 2. Handle resp command modals/buttons and serverMapConfig modals
    const respCommand = client.commands.get('resp');
    if (respCommand) {
        if (interaction.isModalSubmit()) {
            // معالجة مودال تعديل زر الخريطة
            if (interaction.customId.startsWith('modal_edit_btn_')) {
                const editBtnMatch = interaction.customId.match(/^modal_edit_btn_(global|channel_\d+)_(\d+)$/);
                if (!editBtnMatch) {
                    return await interaction.reply({ content: '❌ صيغة غير صحيحة لتعديل الزر.', ephemeral: true });
                }

                const [, configKey, idxRaw] = editBtnMatch;
                const idx = parseInt(idxRaw, 10);
                const label = interaction.fields.getTextInputValue('btn_label');
                const emoji = interaction.fields.getTextInputValue('btn_emoji');
                const description = interaction.fields.getTextInputValue('btn_desc');
                const roleId = interaction.fields.getTextInputValue('btn_role');
                const embedRaw = (interaction.fields.getTextInputValue('btn_embed') || '').trim().toLowerCase();
                const useEmbed = embedRaw === 'yes';

                const configPath = path.join(__dirname, 'data', 'serverMapConfig.json');
                let allConfigs = {};
                try {
                    if (fs.existsSync(configPath)) {
                        allConfigs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                    }
                } catch (e) {}

                if (!allConfigs[configKey]?.buttons?.[idx]) {
                    return await interaction.reply({ content: '❌ لم يتم العثور على الزر المطلوب في هذه الخريطة.', ephemeral: true });
                }

                allConfigs[configKey].buttons[idx] = {
                    ...allConfigs[configKey].buttons[idx],
                    label,
                    emoji: emoji || null,
                    description,
                    roleId: roleId || null,
                    useEmbed
                };
                
                fs.writeFileSync(configPath, JSON.stringify(allConfigs, null, 2));
                return await interaction.reply({ content: `✅ تم تحديث بيانات الزر **${label}** بنجاح.`, ephemeral: true });
            }

            if (interaction.customId.startsWith('apply_resp_modal_') && typeof respCommand.handleApplyRespModal === 'function') {
                await respCommand.handleApplyRespModal(interaction, client);
            } else if (interaction.customId.startsWith('reject_reason_modal_') && typeof respCommand.handleRejectReasonModal === 'function') {
                await respCommand.handleRejectReasonModal(interaction, client);
            }
        } else if (interaction.isButton()) {
            if (interaction.customId === 'apply_resp_button' && typeof respCommand.handleApplyRespButton === 'function') {
                await respCommand.handleApplyRespButton(interaction, client);
            } else if ((interaction.customId.startsWith('approve_apply_') || interaction.customId.startsWith('reject_apply_')) && typeof respCommand.handleApplyAction === 'function') {
                await respCommand.handleApplyAction(interaction, client);
            }
        } else if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'apply_resp_select' && typeof respCommand.handleApplyRespSelect === 'function') {
                await respCommand.handleApplyRespSelect(interaction, client);
            }
        }
    }
    // 3. Handle map_btn_ interactions
    if (interaction.isButton() && interaction.customId.startsWith('map_btn_')) {
        const configPath = DATA_FILES.serverMapConfig;
        if (!fs.existsSync(configPath)) {
            ensureDataFiles();
            return interaction.reply({ content: '⚠️ حدث خطأ في الإعدادات، يرجى المحاولة مرة أخرى.', ephemeral: true });
        }

        const allConfigs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        // جلب الإعدادات وفقًا للنطاق المشفّر في customId (لتجنب التداخل بين خرائط الرومات والخاص)
        const btnIdBody = interaction.customId.replace('map_btn_', '');
        const newFormatMatch = btnIdBody.match(/^(g|c\d+)_(\d+)$/);

        let resolvedConfigKey;
        let index;

        if (newFormatMatch) {
            const [, scope, indexRaw] = newFormatMatch;
            resolvedConfigKey = scope === 'g' ? 'global' : `channel_${scope.slice(1)}`;
            index = parseInt(indexRaw, 10);
        } else {
            // توافق عكسي مع الرسائل القديمة
            const channelKey = `channel_${interaction.channel?.id}`;
            resolvedConfigKey = allConfigs[channelKey] ? channelKey : 'global';
            index = parseInt(btnIdBody, 10);
        }

        const config = allConfigs[resolvedConfigKey] || allConfigs['global'] || allConfigs;
        const buttons = Array.isArray(config.buttons) ? config.buttons : (config.global?.buttons || []);
        const btn = buttons[index];

        if (!btn) return interaction.reply({ content: '❌ لم يتم العثور على بيانات لهذا الزر.', ephemeral: true });

        // معالجة الرول المرتبط بالزر
        let roleStatus = "";
        if (btn.roleId && interaction.guild) {
            try {
                // إرجاء الرد لإعطاء وقت كافٍ لمعالجة الرولات
                if (!interaction.deferred && !interaction.replied) {
                    await interaction.deferReply({ ephemeral: true }).catch(err => {
                        if (err.code !== 10062) throw err;
                    });
                }

                // التحقق مرة أخرى من حالة التفاعل بعد التأجيل
                if (!interaction.deferred && !interaction.replied) return;

                let member = interaction.guild.members.cache.get(interaction.user.id);
                if (!member) member = await interaction.guild.members.fetch(interaction.user.id);
                
                let role = interaction.guild.roles.cache.get(btn.roleId);
                if (!role) role = await interaction.guild.roles.fetch(btn.roleId);

                if (role) {
                    const roleMention = interaction.guild.roles.cache.get(role.id) ? `<@&${role.id}>` : `**${role.name}**`;
                    if (member.roles.cache.has(role.id)) {
                        await member.roles.remove(role, 'إزالة رول عبر خريطة السيرفر');
                        roleStatus = `\n\n✅ **تم سحب رول:** ${roleMention}`;
                    } else {
                        await member.roles.add(role, 'إعطاء رول عبر خريطة السيرفر');
                        roleStatus = `\n\n✅ **تم منحك رول:** ${roleMention}`;
                    }
                }
            } catch (roleErr) {
                if (roleErr.code !== 10062) {
                    console.error('Error handling map button role:', roleErr);
                    roleStatus = `\n\n⚠️ **فشل في منح/سحب الرول:** ${roleErr.message}`;
                }
            }
        }

        const rows = [];
        const links = btn.links || (btn.link ? [{ label: btn.linkLabel || 'انتقال للروم', url: btn.link }] : []);
        
        if (links.length > 0) {
            let currentRow = new ActionRowBuilder();
            links.forEach((linkData, i) => {
                if (i > 0 && i % 5 === 0) {
                    rows.push(currentRow);
                    currentRow = new ActionRowBuilder();
                }
                currentRow.addComponents(
                    new ButtonBuilder()
                        .setLabel(linkData.label || 'انتقال للروم')
                        .setURL(linkData.url)
                        .setStyle(ButtonStyle.Link)
                );
            });
            rows.push(currentRow);
        }

        const descriptionText = (btn.description || 'لا يوجد شرح متاح.') + roleStatus;
        const imageFiles = Array.isArray(btn.images)
            ? btn.images.filter(img => typeof img === 'string' && /^https?:\/\//i.test(img)).slice(0, 10)
            : [];

        const replyPayload = {
            components: rows,
            ephemeral: true
        };

        if (btn.useEmbed === true) {
            const embed = new EmbedBuilder()
                .setDescription(descriptionText)
                .setColor('#2f3136');
            replyPayload.embeds = [embed];
        } else {
            replyPayload.content = descriptionText;
        }

        if (imageFiles.length > 0) {
            replyPayload.files = imageFiles;
        }

        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(replyPayload).catch(err => console.error('Error in editReply:', err));
        } else {
            await interaction.reply(replyPayload).catch(async err => {
                if (err.code === 50007) {
                    console.log(`🚫 لا يمكن الرد على ${interaction.user.tag} لأن الخاص مغلق أو لا يمكن الوصول إليه.`);
                } else {
                    console.error('Interaction Reply Error:', err);
                }
            });
        }
        return;
    }

    // --- End of Consolidated Handlers ---



    // Handle log system interactions
    if (interaction.customId && (interaction.customId.startsWith('log_') ||
        interaction.customId === 'auto_set_logs' ||
        interaction.customId === 'disable_all_logs' ||
        interaction.customId === 'manage_log_roles' ||
        interaction.customId === 'add_log_roles' ||
        interaction.customId === 'remove_all_log_roles')) {
        console.log(`معالجة تفاعل السجلات: ${interaction.customId}`);

        const logCommand = client.commands.get('log');
        if (logCommand && typeof logCommand.handleInteraction === 'function') {
            await logCommand.handleInteraction(interaction, client, typeof saveData !== 'undefined' ? saveData : () => {});
        }
        return;
    }

    // --- Points, Rating and Activity Modification System ---
    if (interaction.customId && (
        interaction.customId.startsWith('points_edit_') ||
        interaction.customId.startsWith('activity_edit_') ||
        interaction.customId.startsWith('rating_edit_') ||
        interaction.customId.startsWith('edit_points_') ||
        interaction.customId.startsWith('modify_activity_') ||
        interaction.customId === 'edit_points_start' ||
        interaction.customId === 'select_resp_for_edit'
    )) {
        console.log(`معالجة تفاعل تعديل النقاط/النشاط: ${interaction.customId}`);

        try {
            // Handle points editing interactions
            if (interaction.customId.startsWith('points_edit_') ||
                interaction.customId.startsWith('edit_points_') ||
                interaction.customId === 'edit_points_start') {

                const resetCommand = client.commands.get('reset');
                if (resetCommand && resetCommand.handleMainInteraction) {
                    await resetCommand.handleMainInteraction(interaction);
                } else {
                    console.log('⚠️ لم يتم العثور على معالج تعديل النقاط في أمر reset');
                    await interaction.reply({
                        content: '❌ معالج تعديل النقاط غير متوفر حالياً',
                        flags: MessageFlags.Ephemeral
                    });
                }
                return;
            }

            // Handle activity editing interactions
            if (interaction.customId.startsWith('activity_edit_') ||
                interaction.customId.startsWith('modify_activity_')) {

                const statsCommand = client.commands.get('stats');
                if (statsCommand && statsCommand.handleActivityEdit) {
                    await statsCommand.handleActivityEdit(interaction, {
                        points: typeof points !== 'undefined' ? points : {},
                        responsibilities: typeof global.responsibilities !== 'undefined' ? global.responsibilities : {},
                        saveData: typeof scheduleSave !== 'undefined' ? scheduleSave : () => {},
                        client: client
                    });
                } else {
                    console.log('⚠️ لم يتم العثور على معالج تعديل النشاط');
                    await interaction.reply({
                        content: '❌ معالج تعديل النشاط غير متوفر حالياً',
                        flags: MessageFlags.Ephemeral
                    });
                }
                return;
            }

            // Handle rating editing interactions
            if (interaction.customId.startsWith('rating_edit_')) {

                const setadminCommand = client.commands.get('setadmin');
                if (setadminCommand && setadminCommand.handleInteraction) {
                    await setadminCommand.handleInteraction(interaction);
                } else {
                    console.log('⚠️ لم يتم العثور على معالج تعديل التقييم');
                    await interaction.reply({
                        content: '❌ معالج تعديل التقييم غير متوفر حالياً',
                        flags: MessageFlags.Ephemeral
                    });
                }
                return;
            }

            // Handle responsibility selection for editing
            if (interaction.customId === 'select_resp_for_edit') {
                const resetCommand = client.commands.get('reset');
                if (resetCommand && resetCommand.handleMainInteraction) {
                    await resetCommand.handleMainInteraction(interaction);
                } else {
                    console.log('⚠️ لم يتم العثور على معالج اختيار المسؤولية للتعديل');
                    await interaction.reply({
                        content: '❌ معالج اختيار المسؤولية للتعديل غير متوفر حالياً',
                        flags: MessageFlags.Ephemeral
                    });
                }
                return;
            }

            // Fallback for any unhandled edit interactions
            console.log(`⚠️ تفاعل تعديل غير مُعرَّف: ${interaction.customId}`);
            await interaction.reply({
                content: '❌ هذه الميزة قيد التطوير - يرجى المحاولة لاحقاً',
                flags: MessageFlags.Ephemeral
            });

        } catch (error) {
            console.error('خطأ في معالجة تفاعلات تعديل النقاط/النشاط:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ حدث خطأ أثناء معالجة طلب التعديل',
                    flags: MessageFlags.Ephemeral
                });
            }
        }
        return;
    }

    // تم نقل معالجة تفاعلات التقارير إلى المعالج المستقل في report.js
    // لتجنب المعالجة المكررة والأخطاء

    // --- SetAdmin System Interaction Router ---
    if (interaction.customId && (
        interaction.customId === 'setadmin_menu' ||
        interaction.customId === 'select_approver_type' ||
        interaction.customId === 'select_approver_roles' ||
        interaction.customId === 'select_approver_responsibility' ||
        interaction.customId === 'select_acceptance_role' ||
        interaction.customId === 'set_pending_limit_modal' ||
        interaction.customId === 'set_cooldown_modal' ||
        interaction.customId === 'select_evaluation_setting' ||
        interaction.customId === 'messages_criteria_modal' ||
        interaction.customId === 'voice_time_criteria_modal' ||
        interaction.customId === 'activity_criteria_modal' ||
        interaction.customId === 'server_time_criteria_modal' ||
        interaction.customId === 'reactions_criteria_modal' ||
        interaction.customId.startsWith('roles_page_') ||
        interaction.customId.startsWith('acceptance_role_page_') ||
        interaction.customId.startsWith('resp_page_')
    )) {
        console.log(`معالجة تفاعل setadmin: ${interaction.customId}`);

        try {
            const setAdminCommand = client.commands.get('setadmin');
            if (setAdminCommand && typeof setAdminCommand.handleInteraction === 'function') {
                await setAdminCommand.handleInteraction(interaction);
            }
        } catch (error) {
            console.error('خطأ في معالجة تفاعل setadmin:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: 'حدث خطأ في معالجة إعدادات التقديم الإداري.',
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (replyError) {
                console.error('خطأ في الرد على خطأ setadmin:', replyError);
            }
        }
        return;
    }

    // --- Responsibility System Interaction Router ---
    if (interaction.customId === 'resp_delete_all_confirm') {
        const respCommand = client.commands.get('resp');
        if (respCommand && typeof respCommand.handleDeleteAllConfirm === 'function') {
            await respCommand.handleDeleteAllConfirm(interaction, client);
        }
        return;
    }

    if (interaction.customId === 'resp_delete_all_cancel') {
        await interaction.update({ content: '❌ تم إلغاء عملية الحذف.', embeds: [], components: [] });
        return;
    }

    // --- Admin Application System Interaction Router ---
    if (interaction.customId && (
        interaction.customId.startsWith('admin_approve_') ||
        interaction.customId.startsWith('admin_reject_') ||
        interaction.customId.startsWith('admin_select_roles_') ||
        interaction.customId.startsWith('admin_details_')
    )) {
        console.log(`معالجة تفاعل التقديم الإداري: ${interaction.customId}`);

        try {
            if (typeof handleAdminApplicationInteraction === 'function') {
                const handled = await handleAdminApplicationInteraction(interaction);
                if (!handled) {
                    console.log('لم يتم معالجة التفاعل في نظام التقديم الإداري');
                }
            }
        } catch (error) {
            console.error('خطأ في معالجة التقديم الإداري:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '❌ حدث خطأ في معالجة طلب التقديم الإداري.',
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (replyError) {
                console.error('خطأ في الرد على خطأ التقديم الإداري:', replyError);
            }
        }
        return;
    }

    // Handle bulk promotion statistics navigation
    if (interaction.customId && (interaction.customId.includes('stats_nav_') || interaction.customId.startsWith('bulk_promotion_members_'))) {
        console.log(`معالجة تفاعل إحصائيات المترقين: ${interaction.customId}`);

        try {
            if (typeof handleBulkPromotionStats === 'function') {
                await handleBulkPromotionStats(interaction, client);
            }
        } catch (error) {
            console.error('خطأ في معالجة إحصائيات المترقين:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '❌ حدث خطأ أثناء عرض الإحصائيات.',
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (replyError) {
                console.error('خطأ في الرد على خطأ الإحصائيات:', replyError);
            }
        }
        return;
    }

    // Handle promotion records navigation and deletion buttons
    if (interaction.customId && (
        interaction.customId.startsWith('role_record_prev_') ||
        interaction.customId.startsWith('role_record_next_') ||
        interaction.customId.startsWith('delete_record_') ||
        interaction.customId.startsWith('delete_all_records_') ||
        interaction.customId.startsWith('confirm_delete_all_') ||
        interaction.customId === 'cancel_delete_all' ||
        interaction.customId === 'promote_records_back'
    )) {
        console.log(`معالجة تفاعل سجلات الترقيات: ${interaction.customId}`);

        try {
            const promoteContext = { client, BOT_OWNERS, BOT_OWNER_ROLES };
            const promoteCommand = client.commands.get('promote');

            if (promoteCommand && promoteCommand.handleInteraction) {
                await promoteCommand.handleInteraction(interaction, promoteContext);
            } else {
                // إذا لم يتم العثور على أمر promote، استخدم promoteManager مباشرة
                await promoteManager.handleInteraction(interaction, promoteContext);
            }
        } catch (error) {
            console.error('خطأ في معالجة سجلات الترقيات:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '❌ حدث خطأ في معالجة سجلات الترقيات.',
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (replyError) {
                console.error('خطأ في الرد على خطأ سجلات الترقيات:', replyError);
            }
        }
        return;
    }

    // --- Promotion System Interaction Router ---
    if (interaction.customId && interaction.customId.startsWith('promote_')) {
        console.log(`معالجة تفاعل نظام الترقيات: ${interaction.customId}`);

        try {
            const promoteContext = typeof context !== 'undefined' ? context : { client, BOT_OWNERS, BOT_OWNER_ROLES: typeof BOT_OWNERS !== 'undefined' ? BOT_OWNERS : [] };
            const promoteCommand = client.commands.get('promote');

            if (promoteCommand && typeof promoteCommand.handleInteraction === 'function') {
                await promoteCommand.handleInteraction(interaction, promoteContext);
            } else if (typeof promoteManager !== 'undefined' && promoteManager && typeof promoteManager.handleInteraction === 'function') {
                // إذا لم يتم العثور على أمر promote، استخدم promoteManager مباشرة
                await promoteManager.handleInteraction(interaction, promoteContext);
            }
        } catch (error) {
            console.error('خطأ في معالجة نظام الترقيات:', error);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '❌ حدث خطأ في معالجة نظام الترقيات.',
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (replyError) {
                console.error('خطأ في الرد على خطأ نظام الترقيات:', replyError);
            }
        }
        return;
    }

    // --- Vacation System Interaction Router ---
    if (interaction.customId && interaction.customId.startsWith('vac_')) {
        const vacationContext = typeof context !== 'undefined' ? context : { client, BOT_OWNERS, BOT_OWNER_ROLES: typeof BOT_OWNERS !== 'undefined' ? BOT_OWNERS : [] };

        // Handle Rejection buttons SPECIFICALLY before deferUpdate
        if (interaction.isButton() && (interaction.customId.startsWith('vac_reject_') || interaction.customId.startsWith('vac_reject_termination_'))) {
            if (interaction.customId.startsWith('vac_reject_termination_')) {
                const myVacationCommand = client.commands.get('اجازتي');
                if (myVacationCommand && typeof myVacationCommand.handleInteraction === 'function') {
                    await myVacationCommand.handleInteraction(interaction, vacationContext);
                }
            } else {
                const vacationCommand = client.commands.get('اجازه');
                if (vacationCommand && typeof vacationCommand.handleInteraction === 'function') {
                    await vacationCommand.handleInteraction(interaction, vacationContext);
                }
            }
            return;
        }

        // Handle regular vacation approvals and rejections
        if (interaction.isButton() && interaction.customId.startsWith('vac_approve_') && !interaction.customId.startsWith('vac_approve_termination_')) {
            const vacationCommand = client.commands.get('اجازه');
            if (vacationCommand && typeof vacationCommand.handleInteraction === 'function') {
                await vacationCommand.handleInteraction(interaction, vacationContext);
            }
            return;
        }

        if (interaction.customId.startsWith('vac_list_') || 
            interaction.customId.startsWith('vac_pending_') || 
            interaction.customId.startsWith('vac_terminate_') ||
            interaction.customId.startsWith('vac_term_')) {

            const vacationsCommand = client.commands.get('اجازات');

            if (vacationsCommand && typeof vacationsCommand.handleInteraction === 'function') {

                await vacationsCommand.handleInteraction(interaction, vacationContext);

            }

            return;

        }

        // Route to set-vacation command - تحسين معالجة التفاعلات
        if (interaction.customId.includes('_set_') ||
            interaction.customId.includes('_choice_') ||
            interaction.customId.includes('_select') ||
            interaction.customId.includes('_back_') ||
            interaction.customId === 'vac_set_approver' ||
            interaction.customId === 'vac_set_notification' ||
            interaction.customId === 'vac_back_main' ||
            interaction.customId === 'vac_reject_cooldown_modal' ||
            interaction.customId.startsWith('vac_choice_') ||
            interaction.customId === 'vac_role_select' ||
            interaction.customId === 'vac_channel_select' ||
            interaction.customId === 'vac_resp_select') {
             const setVacationCommand = client.commands.get('set-vacation');
             if (setVacationCommand && typeof setVacationCommand.handleInteraction === 'function') {
                 await setVacationCommand.handleInteraction(interaction, vacationContext);
             }
             return;
        }

        // Route to vacation (ajaza) command
        if (interaction.customId.startsWith('vac_request_')) {
            const vacationCommand = client.commands.get('اجازه');
            if (vacationCommand && typeof vacationCommand.handleInteraction === 'function') {
                await vacationCommand.handleInteraction(interaction, vacationContext);
            }
            return;
        }

        // Route to my-vacation (ajazati) command for all vacation ending interactions
        if (interaction.customId.startsWith('vac_end_request_') ||
            interaction.customId.startsWith('vac_end_confirm_') ||
            interaction.customId === 'vac_end_cancel' ||
            interaction.customId.startsWith('vac_approve_termination_')) {
            const myVacationCommand = client.commands.get('اجازتي');
            if (myVacationCommand && typeof myVacationCommand.handleInteraction === 'function') {
                await myVacationCommand.handleInteraction(interaction, vacationContext);
            }
            return;
        }

        // Handle modal submissions and leftover vacation interactions
        if (interaction.customId && (interaction.customId.startsWith('vac_reject_modal_') || interaction.customId.startsWith('vac_reject_termination_modal_'))) {
            if (interaction.customId.startsWith('vac_reject_termination_modal_')) {
                const myVacationCommand = client.commands.get('اجازتي');
                if (myVacationCommand && typeof myVacationCommand.handleInteraction === 'function') {
                    await myVacationCommand.handleInteraction(interaction, vacationContext);
                }
            } else {
                const vacationCommand = client.commands.get('اجازه');
                if (vacationCommand && typeof vacationCommand.handleInteraction === 'function') {
                    await vacationCommand.handleInteraction(interaction, vacationContext);
                }
            }
            return;
        }
    }
      if (interaction.customId && interaction.customId.startsWith('myprofile_')) {
        const myProfileCommand = client.commands.get('myprofile');
        if (myProfileCommand && myProfileCommand.handleInteraction) {
            await myProfileCommand.handleInteraction(interaction, client);
        }
        return;
      }
        if (customId === 'suggestion_button') {

      const respCommand = client.commands.get('resp');

      if (respCommand && respCommand.handleSuggestionButton) {

        await respCommand.handleSuggestionButton(interaction, client);

      }

      return;

    }
    
    // معالج منيو اختيار المسؤولية
    if (customId === 'resp_info_select') {
      const respCommand = client.commands.get('resp');
      if (respCommand && respCommand.handleResponsibilitySelect) {
        await respCommand.handleResponsibilitySelect(interaction, client);
      }
      return;
    }

    // Handle resp modal submissions

    if (interaction.isModalSubmit() && customId === 'suggestion_modal') {

      const respCommand = client.commands.get('resp');

      if (respCommand && typeof respCommand.handleSuggestionModal === 'function') {

        await respCommand.handleSuggestionModal(interaction, client);

      }

      return;
    }

    if (interaction.isButton() && customId.startsWith('tasfiyah_undo_')) {
      try {
        const tasfiyahCommand = client.commands.get('tasfiyah') || client.commands.get('تصفيه');
        if (tasfiyahCommand?.handleUndoInteraction) {
          await tasfiyahCommand.handleUndoInteraction(interaction, client);
        }
      } catch (error) {
        console.error('Error in tasfiyah undo interaction:', error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '**❌ تعذر تنفيذ التراجع.**', ephemeral: true }).catch(() => {});
        }
      }
      return;
    }

    // Handle adminroles interactions (including refresh buttons)
    if (customId.startsWith('adminroles_') || customId === 'admin_roles_select' || customId === 'admin_roles_add' || customId === 'admin_roles_remove') {
      try {
        const adminrolesCommand = client.commands.get('adminroles');
        if (adminrolesCommand && typeof adminrolesCommand.handleInteraction === 'function') {
          await adminrolesCommand.handleInteraction(interaction, typeof context !== 'undefined' ? context : { client });
        } else {
          console.log('⚠️ لم يتم العثور على معالج adminroles');
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ 
              content: '❌ معالج adminroles غير متوفر حالياً', 
              flags: MessageFlags.Ephemeral 
            });
          }
        }
      } catch (error) {
        console.error('Error in adminroles interaction:', error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ 
            content: '❌ حدث خطأ أثناء معالجة التفاعل!', 
            flags: MessageFlags.Ephemeral 
          }).catch(() => {});
        }
      }
      return;
    }

    // Handle DM down interactions separately
    if (interaction.customId && interaction.customId.startsWith('dm_down_')) {
        console.log(`معالجة تفاعل DM down: ${interaction.customId}`);
        const downCommand = client.commands.get('down');
        if (downCommand && downCommand.handleInteraction) {
            await downCommand.handleInteraction(interaction, context);
        }
        return;
    }

    // --- Down System Interaction Router ---
    if (interaction.customId && (interaction.customId.startsWith('down_') || interaction.customId.startsWith('dm_down_'))) {
        console.log(`معالجة تفاعل down: ${interaction.customId}`);

        // Load fresh admin roles for down system
        const ADMIN_ROLES = typeof getCachedAdminRoles === 'function' ? getCachedAdminRoles() : [];
        const downContext = typeof context !== 'undefined' ? { ...context, ADMIN_ROLES } : { client, ADMIN_ROLES };

        const downCommand = client.commands.get('down');
        if (downCommand && typeof downCommand.handleInteraction === 'function') {
            try {
                await downCommand.handleInteraction(interaction, downContext);
            } catch (error) {
                console.error('خطأ في معالجة تفاعل down:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '❌ حدث خطأ أثناء معالجة التفاعل. يرجى المحاولة مرة أخرى.',
                        flags: MessageFlags.Ephemeral
                    }).catch(() => {});
                }
            }
        }
        return;
    }

    // --- Warn System Interaction Router ---
    if (interaction.customId && interaction.customId.startsWith('warn_')) {
        console.log(`معالجة تفاعل warn: ${interaction.customId}`);

        const warnCommand = client.commands.get('warn');
        if (warnCommand && typeof warnCommand.handleInteraction === 'function') {
            try {
                const warnContext = typeof context !== 'undefined' ? context : { client };
                await warnCommand.handleInteraction(interaction, warnContext);
            } catch (error) {
                console.error('خطأ في معالجة تفاعل warn:', error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: '❌ حدث خطأ أثناء معالجة التفاعل. يرجى المحاولة مرة أخرى.',
                        flags: MessageFlags.Ephemeral
                    }).catch(() => {});
                }
            }
        }
        return;
    }

    // Handle VIP system interactions
    if (interaction.customId && (interaction.customId.startsWith('vip_') ||
        interaction.customId === 'vip_status_select')) {
        const vipCommand = client.commands.get('vip');
        if (vipCommand && typeof vipCommand.handleInteraction === 'function') {
            await vipCommand.handleInteraction(interaction, client, { guild: interaction.guild, author: interaction.user });
        }
        return;
    }

    // Handle VIP modal submissions
    if (interaction.isModalSubmit() && interaction.customId.startsWith('activity_after_date_modal_')) {
        const activityStatsCommand = client.commands.get('تفاعلي');
        if (activityStatsCommand && typeof activityStatsCommand.handleModalSubmit === 'function') {
            await activityStatsCommand.handleModalSubmit(interaction, client);
        }
        return;
    }

    if (interaction.isModalSubmit() && (interaction.customId === 'vip_prefix_modal' ||
        interaction.customId === 'vip_name_modal' ||
        interaction.customId === 'vip_avatar_modal' ||
        interaction.customId === 'vip_banner_modal' ||
        interaction.customId.startsWith('activity_modal_'))) {
        const vipCommand = client.commands.get('vip');
        if (vipCommand && typeof vipCommand.handleModalSubmit === 'function') {
            await vipCommand.handleModalSubmit(interaction, client);
        }
        return;
    }

    // Handle Reaction Log settings panel interactions
    if (interaction.customId && interaction.customId.startsWith('reactionlog_')) {
        try {
            const reactionLogCommand = client.commands.get('reactionlog');
            if (reactionLogCommand && typeof reactionLogCommand.handleInteraction === 'function') {
                await reactionLogCommand.handleInteraction(interaction, { client, BOT_OWNERS, BOT_OWNER_ROLES });
            }
        } catch (error) {
            console.error('Reaction Log panel failed:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'Reaction Log panel error.', flags: MessageFlags.Ephemeral }).catch(() => {});
            }
        }
        return;
    }

    // Handle Streak system interactions
    if (interaction.customId && (
        interaction.customId.startsWith('streak_') ||
        interaction.customId === 'streak_divider_modal' ||
        interaction.customId === 'streak_emojis_modal'
    )) {
        console.log(`🔍 معالجة تفاعل Streak: ${interaction.customId}`);
        
        try {
            const streakCommand = client.commands.get('streak');
            if (streakCommand && streakCommand.handleInteraction) {
                await streakCommand.handleInteraction(interaction, { client, BOT_OWNERS, BOT_OWNER_ROLES });
            } else {
                console.log('⚠️ لم يتم العثور على معالج Streak');
                await interaction.reply({
                    content: '❌ معالج Streak غير متوفر حالياً',
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (error) {
            console.error('❌ خطأ في معالجة تفاعل Streak:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ حدث خطأ في معالجة الطلب',
                    flags: MessageFlags.Ephemeral
                });
            }
        }
        return;
    }

    // Handle category interactions (buttons and select menus)
    if (interaction.customId && (
        interaction.customId === 'add_category' ||
        interaction.customId === 'edit_category' ||
        interaction.customId === 'delete_category' ||
        interaction.customId === 'manage_category_resps' ||
        interaction.customId === 'reorder_category_resps' ||
        interaction.customId.startsWith('select_category_') ||
        interaction.customId.startsWith('confirm_delete_') ||
        interaction.customId === 'cancel_delete' ||
        interaction.customId.startsWith('save_category_resps_') ||
        interaction.customId.startsWith('add_resps_to_category_') ||
        interaction.customId.startsWith('category_resps_nav_')
    )) {
        const ctgCommand = client.commands.get('ctg');
        if (ctgCommand && typeof ctgCommand.handleInteraction === 'function') {
            await ctgCommand.handleInteraction(interaction, typeof context !== 'undefined' ? context : { client });
        }
        return;
    }

    // Handle category modal submissions
    if (interaction.isModalSubmit() && (interaction.customId === 'add_category_modal' ||
        interaction.customId.startsWith('edit_category_modal_') ||
        interaction.customId === 'reorder_category_resps_modal')) {
        const ctgCommand = client.commands.get('ctg');
        if (ctgCommand && typeof ctgCommand.handleModalSubmit === 'function') {
            await ctgCommand.handleModalSubmit(interaction, client);
        }
        return;
    }

    // معالج report تم نقله إلى ملف report.js كمعالج مستقل

    if (interaction.isButton() && interaction.customId.startsWith('shortcut_supervisor_call_')) {
      await interaction.reply({ content: '**تم دمج استدعاء المشرفين داخل زر Call الجديد؛ استخدم الاختصار مرة أخرى.**', flags: 64 }).catch(() => {});
      return;
    }

    // زر إعادة الاختصار الموجود في رسالة "يوجد مشكلة بالفعل مفتوحه".
    // يسمح لصاحب الطلب فقط بفتح طلب جديد لمشكلة مختلفة، دون كتابة الاختصار
    // يدويًا، مع تجاوز كولداون الطلب السابق لهذه الضغطة فقط.
    if (interaction.isButton() && interaction.customId.startsWith('shortcut_retry_')) {
      const requestToken = interaction.customId.slice('shortcut_retry_'.length);
      const requestData = client.shortcutRequests?.get(requestToken);
      if (!requestData || interaction.user.id !== requestData.requesterId) {
        await interaction.reply({ content: '**هذا الزر مخصص فقط للشخص الذي استخدم الاختصار.**', flags: 64 }).catch(() => {});
        return;
      }
      const responsibility = (global.responsibilities || {})[requestData.responsibilityName];
      const prefix = String(responsibility?.mentPrefix || '-');
      const shortcut = String(responsibility?.mentShortcut || '').trim();
      if (!shortcut) {
        await interaction.reply({ content: '**اختصار هذه المسؤولية غير مضبوط حاليًا.**', flags: 64 }).catch(() => {});
        return;
      }
      await interaction.deferUpdate().catch(() => {});
      const usageKey = getShortcutUsageKey(interaction.guild.id, interaction.user.id, requestData.responsibilityName);
      shortcutBypassKeys.add(usageKey);
      const syntheticMessage = {
        id: `shortcut-retry-${Date.now()}-${interaction.user.id}`,
        guild: interaction.guild,
        channel: interaction.channel,
        author: interaction.user,
        member: interaction.member,
        content: `${prefix}${shortcut}`,
        reference: null,
        mentions: { users: new Map(), everyone: false, repliedUser: null },
        react: async () => syntheticMessage
      };
      void client.emit('messageCreate', syntheticMessage);
      return;
    }

    // === معالج زر Call الموحّد: اختيار استدعاء المسؤولين أو المشرفين ===
    if (interaction.isButton() && interaction.customId.startsWith('shortcut_call_')) {
      const { isUserBlocked } = require('./commands/block.js');
      if (isUserBlocked(interaction.user.id)) {
        await interaction.reply({ content: '**لا يمكنك استخدام هذه الميزة حالياً.**', flags: 64 }).catch(() => {});
        return;
      }
      const requestToken = interaction.customId.slice('shortcut_call_'.length);
      const callData = client.shortcutRequests?.get(requestToken);
      if (!callData || interaction.message?.id !== callData.messageId) {
        await interaction.reply({ content: '**انتهت صلاحية هذا الزر. يرجى استخدام الاختصار مرة أخرى.**', flags: 64 }).catch(() => {});
        return;
      }
      if (interaction.user.id !== callData.requesterId) {
        await interaction.reply({ content: '**هذا الزر مخصص فقط للشخص الذي استخدم الاختصار.**', flags: 64 }).catch(() => {});
        return;
      }
      if (callData.claimedBy) {
        await interaction.reply({ content: `**تم استلام هذه المشكلة من قبل <@${callData.claimedBy}>، لذلك تم إيقاف الاستدعاء.**`, flags: 64 }).catch(() => {});
        return;
      }
      const menuEmbed = colorManager.createEmbed()
        .setTitle('Call')
        .setDescription(`**اختر من تريد استدعاءه لمسؤولية ${callData.responsibilityName}:**`)
        .setTimestamp();
      const menuRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`shortcut_do_responsibles_${requestToken}`).setLabel('Call Responsibles').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`shortcut_do_supervisors_${requestToken}`).setLabel('Call Supervisors').setStyle(ButtonStyle.Secondary)
      );
      await interaction.reply({ embeds: [menuEmbed], components: [menuRow], flags: 64 });
      return;
    }

    // اختيار استدعاء المسؤولين: يبقى تدفق كتابة السبب كما هو.
    if (interaction.isButton() && interaction.customId.startsWith('shortcut_do_responsibles_')) {
      const requestToken = interaction.customId.slice('shortcut_do_responsibles_'.length);
      const callData = client.shortcutRequests?.get(requestToken);
      if (!callData || interaction.user.id !== callData.requesterId) {
        await interaction.reply({ content: '**انتهت صلاحية هذا الخيار أو ليس مخصصًا لك.**', flags: 64 }).catch(() => {});
        return;
      }
      if (callData.claimedBy) {
        await interaction.reply({ content: `**تم استلام هذه المشكلة من قبل <@${callData.claimedBy}>، لذلك تم إيقاف الاستدعاء.**`, flags: 64 }).catch(() => {});
        return;
      }
      const callCooldownLeft = getShortcutCallCooldown(callData.guildId, interaction.user.id, callData.responsibilityName);
      if (callCooldownLeft > 0) {
        await interaction.reply({ content: `**عليك الانتظار ${Math.ceil(callCooldownLeft / 60000)} دقائق قبل استدعاء المسؤولين أو المشرفين لهذه المسؤولية مرة أخرى.**`, flags: 64 }).catch(() => {});
        return;
      }
      const modal = new ModalBuilder()
        .setCustomId(`shortcut_call_modal_${requestToken}`)
        .setTitle(`استدعاء مسؤولي: ${callData.responsibilityName}`);
      const reasonInput = new TextInputBuilder()
        .setCustomId('call_reason')
        .setLabel('سبب الاستدعاء')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setPlaceholder('اكتب سبب الاستدعاء...')
        .setMaxLength(1000);
      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      await interaction.showModal(modal).catch(async () => {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ حدث خطأ أثناء محاولة فتح النافذة، يرجى المحاولة مرة أخرى.', flags: 64 }).catch(() => {});
        }
      });
      return;
    }

    // اختيار استدعاء المشرفين: يحافظ على رسالة التأكيد والإرسال الخاص الحالي.
    if (interaction.isButton() && interaction.customId.startsWith('shortcut_do_supervisors_')) {
      const { isUserBlocked } = require('./commands/block.js');
      if (isUserBlocked(interaction.user.id)) {
        await interaction.reply({ content: '**لا يمكنك استخدام هذه الميزة حالياً.**', flags: 64 }).catch(() => {});
        return;
      }
      const requestToken = interaction.customId.slice('shortcut_do_supervisors_'.length);
      const callData = client.shortcutRequests?.get(requestToken);
      if (!callData || interaction.user.id !== callData.requesterId) {
        await interaction.reply({ content: '**انتهت صلاحية هذا الخيار أو ليس مخصصًا لك.**', flags: 64 }).catch(() => {});
        return;
      }
      if (callData.claimedBy) {
        await interaction.reply({ content: `**تم استلام هذه المشكلة من قبل <@${callData.claimedBy}>، لذلك تم إيقاف الاستدعاء.**`, flags: 64 }).catch(() => {});
        return;
      }
      const supervisorCooldownLeft = getShortcutCallCooldown(callData.guildId, interaction.user.id, callData.responsibilityName);
      if (supervisorCooldownLeft > 0) {
        await interaction.reply({ content: `**عليك الانتظار ${Math.ceil(supervisorCooldownLeft / 60000)} دقائق قبل استدعاء المسؤولين أو المشرفين لهذه المسؤولية مرة أخرى.**`, flags: 64 }).catch(() => {});
        return;
      }
      const { getSupervisors } = require('./utils/responsibilitySupervisors.js');
      const supervisorData = getSupervisors(callData.guildId, callData.responsibilityName);
      const supervisorMentions = [
        ...supervisorData.userIds.map(id => `<@${id}>`),
        ...supervisorData.roleIds.map(id => `<@&${id}>`)
      ];
      if (!supervisorMentions.length) {
        await interaction.reply({ content: `**لا يوجد مشرفين معينين لمسؤولية : ${callData.responsibilityName}**`, flags: 64 }).catch(() => {});
        return;
      }
      const confirmationEmbed = colorManager.createEmbed()
        .setTitle('Call Responsibility Supervisors')
        .setDescription(`**هل أنت متأكد من طلب مشرفين المسؤولية : ${callData.responsibilityName} ؟**`)
        .addFields({ name: 'Supervisors', value: supervisorMentions.join(' , ').slice(0, 1024), inline: false })
        .setThumbnail(interaction.guild.iconURL({ dynamic: true }) || client.user.displayAvatarURL())
        .setTimestamp();
      const confirmId = `shortcut_supervisor_confirm_${interaction.id}`;
      const cancelId = `shortcut_supervisor_cancel_${interaction.id}`;
      const confirmationRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(confirmId).setLabel('Confirm').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Danger)
      );
      const confirmationMessage = await interaction.reply({ embeds: [confirmationEmbed], components: [confirmationRow], flags: 64, fetchReply: true });
      let supervisorActionLockKey = null;
      let supervisorActionLockAcquired = false;
      let releaseNotificationSlot = null;
      let releaseCallCooldownLock = null;
      try {
        const confirmation = await confirmationMessage.awaitMessageComponent({
          filter: i => i.user.id === interaction.user.id && [confirmId, cancelId].includes(i.customId),
          time: 60000
        });
        if (confirmation.customId === cancelId) {
          await confirmation.update({ content: '**تم إلغاء طلب استدعاء المشرفين.**', embeds: [], components: [] });
          return;
        }
        supervisorActionLockKey = `${callData.guildId}:${callData.channelId}:${callData.messageId}`;
        if (shortcutActionLocks.has(supervisorActionLockKey)) {
          await confirmation.update({ content: '**يجري استلام أو معالجة هذه المشكلة الآن؛ لم يتم استدعاء المشرفين.**', embeds: [], components: [] });
          return;
        }
        shortcutActionLocks.add(supervisorActionLockKey);
        supervisorActionLockAcquired = true;
        if (callData.claimedBy) {
          await confirmation.update({ content: `**تم استلام المشكلة بواسطة <@${callData.claimedBy}>؛ لم يتم استدعاء المشرفين.**`, embeds: [], components: [] });
          return;
        }
        releaseCallCooldownLock = tryAcquireShortcutCallLock(callData.guildId, interaction.user.id, callData.responsibilityName);
        if (!releaseCallCooldownLock) {
          await confirmation.update({ content: '**لديك استدعاء آخر قيد المعالجة لهذه المسؤولية؛ لم يتم إرسال استدعاء مكرر.**', embeds: [], components: [] });
          return;
        }
        const confirmedCooldownLeft = getShortcutCallCooldown(callData.guildId, interaction.user.id, callData.responsibilityName);
        if (confirmedCooldownLeft > 0) {
          await confirmation.update({ content: `**تم استدعاء المسؤولين أو المشرفين لهذه المسؤولية للتو؛ انتظر ${Math.ceil(confirmedCooldownLeft / 60000)} دقائق.**`, embeds: [], components: [] });
          return;
        }
        releaseNotificationSlot = tryAcquireShortcutNotificationSlot();
        if (!releaseNotificationSlot) {
          await confirmation.update({ content: '**طلبات الاستدعاء كثيرة الآن؛ انتظر قليلًا ثم حاول مرة أخرى.**', embeds: [], components: [] });
          return;
        }
        await confirmation.deferUpdate();
        startShortcutCallCooldown(callData.guildId, interaction.user.id, callData.responsibilityName);
        if (!await shortcutStateStore.flushShortcutStore()) throw new Error('تعذر حفظ كولداون استدعاء المشرفين');
        const recipientIds = new Set();
        let recipientEnumerationCapped = supervisorData.userIds.length > MAX_SHORTCUT_CALL_RECIPIENTS * 5;
        for (const userId of supervisorData.userIds.slice(0, MAX_SHORTCUT_CALL_RECIPIENTS * 5 + 1)) {
          if (recipientIds.size > MAX_SHORTCUT_CALL_RECIPIENTS) { recipientEnumerationCapped = true; break; }
          recipientIds.add(String(userId));
        }
        if (!recipientEnumerationCapped) {
          for (const roleId of supervisorData.roleIds) {
            if (recipientIds.size > MAX_SHORTCUT_CALL_RECIPIENTS) { recipientEnumerationCapped = true; break; }
            const role = interaction.guild.roles.cache.get(roleId)
              || await interaction.guild.roles.fetch(roleId).catch(() => null);
            if (!role?.members) continue;
            for (const member of role.members.values()) {
              if (recipientIds.size > MAX_SHORTCUT_CALL_RECIPIENTS) { recipientEnumerationCapped = true; break; }
              recipientIds.add(String(member.id));
            }
            if (recipientEnumerationCapped) break;
          }
        }
        const messageLink = `https://discord.com/channels/${callData.guildId}/${callData.channelId}/${callData.messageId}`;
        const dmEmbed = colorManager.createEmbed()
          .setTitle('Responsibility Supervisor Call')
          .setDescription(`**تم استدعاؤك كمشرف على مسؤولية : ${callData.responsibilityName}**\n\n**المستدعي :** <@${interaction.user.id}>\n**الرابط :** [اذهب للرسالة](${messageLink})`)
          .setThumbnail(interaction.guild.iconURL({ dynamic: true }) || client.user.displayAvatarURL())
          .setTimestamp();
        const recipientList = [...recipientIds];
        const limitedRecipientList = recipientList.slice(0, MAX_SHORTCUT_CALL_RECIPIENTS);
        const recipientsCapped = recipientEnumerationCapped || recipientList.length > MAX_SHORTCUT_CALL_RECIPIENTS;
        let sentCount = 0;
        for (const userId of limitedRecipientList) {
          const user = client.users.cache.get(userId) || await client.users.fetch(userId).catch(() => null);
          if (user && await user.send({ embeds: [dmEmbed] }).then(() => true).catch(() => false)) sentCount++;
        }
        const cappedNotice = recipientsCapped
          ? `\n**للحماية من الضغط، اقتصر الإرسال على أول ${MAX_SHORTCUT_CALL_RECIPIENTS} مشرفًا.**`
          : '';
        await confirmation.editReply({ content: `**تم استدعاء مشرفي مسؤولية ${callData.responsibilityName} بنجاح.**\n**تم الإرسال إلى :** ${sentCount}${cappedNotice}`, embeds: [], components: [] });
      } catch (error) {
        await interaction.editReply({ content: '**انتهت مهلة التأكيد ولم يتم استدعاء المشرفين.**', embeds: [], components: [] }).catch(() => {});
      } finally {
        releaseNotificationSlot?.();
        releaseCallCooldownLock?.();
        if (supervisorActionLockAcquired) shortcutActionLocks.delete(supervisorActionLockKey);
      }
      return;
    }

    // نموذج سبب استدعاء المسؤولين.
    if (interaction.isModalSubmit() && interaction.customId.startsWith('shortcut_call_modal_')) {
      if (interaction.replied || interaction.deferred) return;
      const { isUserBlocked } = require('./commands/block.js');
      if (isUserBlocked(interaction.user.id)) {
        await interaction.reply({ content: '**لا يمكنك استخدام هذه الميزة حالياً.**', flags: 64 }).catch(() => {});
        return;
      }
      const requestToken = interaction.customId.slice('shortcut_call_modal_'.length);
      const callData = client.shortcutRequests?.get(requestToken);
      if (!callData || interaction.user.id !== callData.requesterId) {
        await interaction.reply({ content: '**انتهت صلاحية هذا النموذج أو ليس مخصصًا لك. يرجى استخدام الاختصار مرة أخرى.**', flags: 64 }).catch(() => {});
        return;
      }
      if (callData.claimedBy) {
        await interaction.reply({ content: `**تم استلام هذه المشكلة من قبل <@${callData.claimedBy}>، لذلك لم يتم إرسال الاستدعاء.**`, flags: 64 }).catch(() => {});
        return;
      }
      const modalCooldownLeft = getShortcutCallCooldown(callData.guildId, interaction.user.id, callData.responsibilityName);
      if (modalCooldownLeft > 0) {
        await interaction.reply({ content: `**عليك الانتظار ${Math.ceil(modalCooldownLeft / 60000)} دقائق قبل استدعاء المسؤولين أو المشرفين لهذه المسؤولية مرة أخرى.**`, flags: 64 }).catch(() => {});
        return;
      }
      const reason = interaction.fields.getTextInputValue('call_reason').trim() || 'غير محدد';
      const responsibleActionLockKey = `${callData.guildId}:${callData.channelId}:${callData.messageId}`;
      if (shortcutActionLocks.has(responsibleActionLockKey)) {
        await interaction.reply({ content: '**يجري استلام أو معالجة هذه المشكلة الآن؛ لم يتم إرسال الاستدعاء.**', flags: 64 }).catch(() => {});
        return;
      }
      shortcutActionLocks.add(responsibleActionLockKey);
      let releaseNotificationSlot = null;
      let releaseCallCooldownLock = null;
      try {
        releaseCallCooldownLock = tryAcquireShortcutCallLock(callData.guildId, interaction.user.id, callData.responsibilityName);
        if (!releaseCallCooldownLock) {
          await interaction.reply({ content: '**لديك استدعاء آخر قيد المعالجة لهذه المسؤولية؛ لم يتم إرسال استدعاء مكرر.**', flags: 64 }).catch(() => {});
          return;
        }
        const recheckedCooldown = getShortcutCallCooldown(callData.guildId, interaction.user.id, callData.responsibilityName);
        if (recheckedCooldown > 0) {
          await interaction.reply({ content: `**عليك الانتظار ${Math.ceil(recheckedCooldown / 60000)} دقائق قبل استدعاء المسؤولين أو المشرفين لهذه المسؤولية مرة أخرى.**`, flags: 64 }).catch(() => {});
          return;
        }
        releaseNotificationSlot = tryAcquireShortcutNotificationSlot();
        if (!releaseNotificationSlot) {
          await interaction.reply({ content: '**طلبات الاستدعاء كثيرة الآن؛ انتظر قليلًا ثم حاول مرة أخرى.**', flags: 64 }).catch(() => {});
          return;
        }
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        startShortcutCallCooldown(callData.guildId, interaction.user.id, callData.responsibilityName);
        if (!await shortcutStateStore.flushShortcutStore()) throw new Error('تعذر حفظ كولداون استدعاء المسؤولين');
        const messageLink = `https://discord.com/channels/${callData.guildId}/${callData.channelId}/${callData.messageId}`;
        const currentTime = new Date().toLocaleString('ar-EG', { timeZone: 'Asia/Riyadh' });
        const linkButton = new ButtonBuilder().setLabel('اذهب للرساله').setStyle(ButtonStyle.Link).setURL(messageLink);
        const row = new ActionRowBuilder().addComponents(linkButton);
        const rawRecipientIds = Array.isArray(callData.responsibles) ? callData.responsibles : [];
        const recipientCandidates = new Set(rawRecipientIds.slice(0, MAX_SHORTCUT_CALL_RECIPIENTS * 5 + 1).map(String));
        const recipientIds = [...recipientCandidates].slice(0, MAX_SHORTCUT_CALL_RECIPIENTS);
        const recipientsCapped = recipientCandidates.size > MAX_SHORTCUT_CALL_RECIPIENTS || rawRecipientIds.length > MAX_SHORTCUT_CALL_RECIPIENTS * 5;
        let successCount = 0;
        for (const userId of recipientIds) {
          try {
            const user = client.users.cache.get(userId) || await client.users.fetch(userId);
            await user.send({
              content: `**🔔 استدعاك إداري **\n\n**● المسؤولية :** ${callData.responsibilityName}\n**● الإداري المستدعي :** <@${interaction.user.id}>\n**● الوقت :** ${currentTime}\n**● السبب :** ${reason}`,
              components: [row]
            });
            successCount++;
          } catch (error) {
            console.error(`فشل إرسال رسالة خاصة للمسؤول ${userId}:`, error.message);
          }
        }
        logEvent(client, interaction.guild, {
          type: 'TASK_LOGS',
          title: 'استدعاء مسؤولين (خاص)',
          description: `تم استدعاء مسؤولي "${callData.responsibilityName}" عبر الخاص`,
          user: interaction.user,
          fields: [
            { name: 'المسؤولية', value: callData.responsibilityName, inline: true },
            { name: 'السبب', value: reason, inline: false },
            { name: 'عدد المسؤولين الناجح', value: `${successCount}/${recipientIds.length}${recipientsCapped ? ` (سقف الأمان ${MAX_SHORTCUT_CALL_RECIPIENTS})` : ''}`, inline: true }
          ]
        });
        const cappedNotice = recipientsCapped
          ? `\nتم تطبيق سقف الحماية: أُرسل إلى أول ${MAX_SHORTCUT_CALL_RECIPIENTS} مسؤولين فقط.`
          : '';
        await interaction.editReply({ content: `**✅ تم استدعاء مسؤولي "${callData.responsibilityName}" عبر الخاص!**${cappedNotice}` }).catch(() => {});
        return;

      } finally {
        releaseNotificationSlot?.();
        releaseCallCooldownLock?.();
        shortcutActionLocks.delete(responsibleActionLockKey);
      }
    }

    // === زر Take: تحقق صلاحية حي، قفل للتزامن، نقطة واحدة idempotent حسب الرسالة ===
    if (interaction.isButton() && interaction.customId.startsWith('shortcut_take_')) {
      const { isUserBlocked } = require('./commands/block.js');
      if (isUserBlocked(interaction.user.id)) {
        await interaction.reply({ content: '**لا يمكنك استخدام هذه الميزة حالياً.**', flags: 64 }).catch(() => {});
        return;
      }
      const requestToken = interaction.customId.slice('shortcut_take_'.length);
      const callData = client.shortcutRequests?.get(requestToken);
      if (!callData || interaction.message?.id !== callData.messageId || interaction.channelId !== callData.channelId || interaction.guildId !== callData.guildId) {
        await interaction.reply({ content: '**انتهت صلاحية زر Take أو بياناته غير مطابقة.**', flags: 64 }).catch(() => {});
        return;
      }
      const claimLockKey = `${callData.guildId}:${callData.channelId}:${callData.messageId}`;
      if (shortcutActionLocks.has(claimLockKey)) {
        await interaction.reply({ content: '**يجري استلام هذه المشكلة الآن؛ انتظر لحظة ثم حدّث الرسالة.**', flags: 64 }).catch(() => {});
        return;
      }
      shortcutActionLocks.add(claimLockKey);
      try {
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        if (callData.claimedBy) {
          await interaction.editReply({ content: `**هذه المشكلة مستلمة بالفعل من <@${callData.claimedBy}>.**` }).catch(() => {});
          return;
        }
        let currentResponsibilities = global.responsibilities || {};
        if (dbManager.isInitialized) {
          currentResponsibilities = await dbManager.getResponsibilities().catch(() => currentResponsibilities);
        }
        const assignedIds = (currentResponsibilities?.[callData.responsibilityName]?.responsibles || []).map(String);
        if (!assignedIds.includes(String(interaction.user.id))) {
          await interaction.editReply({ content: `**زر Take مخصص للمسؤولين المعيّنين لمسؤولية ${callData.responsibilityName} فقط.**` }).catch(() => {});
          return;
        }
        const claimId = `${callData.guildId}:${callData.channelId}:${callData.messageId}`;
        const ticketState = require('./commands/ticket.js');
        const pointResult = await ticketState.awardShortcutTakePoint({
          claimId,
          responsibilityName: callData.responsibilityName,
          userId: interaction.user.id
        });
        if (!pointResult?.claim?.userId) {
          throw new Error('لم يتم إنشاء سجل استلام أو نقطة للمسؤولية');
        }
        const actualClaimerId = String(pointResult.claim.userId);
        const member = interaction.guild.members.cache.get(actualClaimerId)
          || await fetchGuildMemberWithLimit(interaction.guild, actualClaimerId);
        const displayNameFallback = actualClaimerId === interaction.user.id
          ? (interaction.user.globalName || interaction.user.username || actualClaimerId)
          : actualClaimerId;
        const displayName = String(member?.displayName || displayNameFallback).slice(0, 55);
        callData.claimedBy = actualClaimerId;
        callData.claimedAt = Number(pointResult.claim.at || Date.now());
        callData.claimedByName = displayName;
        shortcutStore.requests[requestToken] = callData;
        shortcutStateStore.saveShortcutStore();
        const updatedRows = interaction.message.components.map(row => new ActionRowBuilder().addComponents(
          row.components.map(component => {
            const button = ButtonBuilder.from(component);
            if (component.customId === `shortcut_call_${requestToken}`) return button.setDisabled(true);
            if (component.customId === `shortcut_take_${requestToken}`) return button.setLabel(`Claimed By : ${displayName}`).setDisabled(true);
            return button;
          })
        ));
        await interaction.message.edit({ components: updatedRows }).catch(error => console.error('تعذر تحديث أزرار الاستلام:', error.message));
        const requesterId = normalizeDiscordId(callData.requesterId);
        const requesterMention = requesterId ? userMention(requesterId) : 'صاحب الاختصار';
        const claimerMention = userMention(actualClaimerId) || 'المستلم';
        const claimAccentColor = colorToNumber(colorManager.getColor?.() || '#0099ff', 0x0099ff);
        const claimContainer = createStructuredContainer({
          title: 'Claimed',
          accentColor: claimAccentColor,
          description: [
            `تم استلام مشكلتك : ${requesterMention}`,
            '',
            `**المسؤولية :** ${callData.responsibilityName}`,
            `**المستلم :** ${claimerMention}`
          ].join('\n')
        });
        await interaction.message.reply({
          ...componentsV2Payload(claimContainer),
          allowedMentions: {
            parse: [],
            users: normalizeMentionableIds([requesterId, actualClaimerId]),
            repliedUser: false
          }
        }).catch(error => console.error('تعذر إرسال رد استلام المشكلة:', error.message));
        if (topCommand?.invalidateTopCache) topCommand.invalidateTopCache();
        await interaction.editReply({
          content: pointResult.awarded
            ? `**تم استلام المشكلة وتسجيل نقطة واحدة لك في مسؤولية ${callData.responsibilityName}.**`
            : actualClaimerId === interaction.user.id
              ? '**أنت مستلم هذه المشكلة بالفعل؛ لم تُضف نقطة ثانية.**'
              : `**استلم هذه المشكلة بالفعل <@${actualClaimerId}>.**`
        }).catch(() => {});
      } catch (error) {
        console.error('خطأ في معالجة زر Take لاختصار المسؤولية:', error);
        await interaction.editReply({ content: '**تعذر إتمام الاستلام الآن؛ لم نؤكد تسجيله. حاول مرة أخرى بعد قليل.**' }).catch(() => {});
      } finally {
        shortcutActionLocks.delete(claimLockKey);
      }
      return;
    }

    // Handle modal submissions for setup
    if (interaction.isModalSubmit() && interaction.customId.startsWith('setup_reason_modal_')) {
      // منع التفاعلات المتكررة
      if (interaction.replied || interaction.deferred) {
        console.log('تم تجاهل تفاعل متكرر في نموذج السيتب');
        return;
      }

      const customIdParts = interaction.customId.replace('setup_reason_modal_', '').split('_');
      const responsibilityName = customIdParts[0];
      const target = customIdParts[1]; // This is the target user ID from the button click
      let reason = interaction.fields.getTextInputValue('reason').trim();

      // التعامل مع المنشن في النص
      if (reason.includes('<@')) {
        // استخراج المنشن وإزالة العلامات
        reason = reason.replace(/<@!?(\d+)>/g, (match, userId) => {
          try {
            return `<@${userId}>`;
          } catch (error) {
            return match;
          }
        });
      }

      // التعامل مع معرفات المستخدمين في النص
      const userIdPattern = /\b\d{17,19}\b/g;
      const foundIds = reason.match(userIdPattern);
      if (foundIds) {
        for (const id of foundIds) {
          try {
            await client.users.fetch(id);
            reason = reason.replace(new RegExp(`\\b${id}\\b`, 'g'), `<@${id}>`);
          } catch (error) {
            // ID غير صحيح، نتركه كما هو
          }
        }
      }

      if (!reason || reason.trim() === '') {
        reason = 'لا يوجد سبب محدد';
      }

      if (!responsibilities[responsibilityName]) {
        return interaction.reply({ content: '**المسؤولية غير موجودة!**', flags: 64 });
      }

      const responsibility = responsibilities[responsibilityName];
      const responsibles = responsibility.responsibles || [];

      if (responsibles.length === 0) {
        return interaction.reply({ content: '**لا يوجد مسؤولين معينين لهذه المسؤولية.**', flags: 64 });
      }

      // Get stored image URL for this user
      const storedImageUrl = client.setupImageData?.get(interaction.user.id);

      const embed = colorManager.createEmbed()
        .setTitle(`**طلب مساعدة في المسؤولية: ${responsibilityName}**`)
        .setDescription(`**السبب:** ${reason}\n**من:** ${interaction.user}`);

      // Add image if available
      if (storedImageUrl) {
        embed.setImage(storedImageUrl);
      }

      const claimButton = new ButtonBuilder()
        .setCustomId(`claim_task_${responsibilityName}_${Date.now()}_${interaction.user.id}`)
        .setLabel('claim')
.setEmoji('<:emoji_11:1448570670270251079>')
        .setStyle(ButtonStyle.Success);

      const buttonRow = new ActionRowBuilder().addComponents(claimButton);

      if (target === 'all') {
        // Send to all responsibles
        let sentCount = 0;
        for (const userId of responsibles) {
          try {
            const user = await client.users.fetch(userId);
            await user.send({ embeds: [embed], components: [buttonRow] });
            sentCount++;
          } catch (error) {
            console.error(`Failed to send DM to user ${userId}:`, error);
          }
        }

        await interaction.reply({ content: `**تم إرسال الطلب لـ ${sentCount} من المسؤولين.**`, flags: 64 });
      } else {
        // Send to specific user
        try {
          // التحقق من صحة معرف المستخدم المستهدف
          if (!/^\d{17,19}$/.test(target)) {
            return interaction.reply({ content: '**معرف المستخدم المستهدف غير صحيح.**', flags: 64 });
          }

          const user = await client.users.fetch(target);
          await user.send({ embeds: [embed], components: [buttonRow] });

          await interaction.reply({ content: `**تم إرسال الطلب إلى ${user.username}.**`, flags: 64 });
        } catch (error) {
          await interaction.reply({ content: '**فشل في إرسال الرسالة الخاصة أو المستخدم غير موجود.**', flags: 64 });
        }
      }

      // Log the task requested event
        logEvent(client, interaction.guild, {
            type: 'TASK_LOGS',
            title: 'Task Requested',
            description: `Responsibility: **${responsibilityName}**`,
            user: interaction.user,
            fields: [
                { name: 'Reason', value: reason, inline: false },
                { name: 'Target', value: target === 'all' ? 'All' : `<@${target}>`, inline: true }
            ]
        });
      return;
    }

    // Handle setup select menu interactions - معالج عام للسيتب يعمل مع جميع الرسائل
    if (interaction.isStringSelectMenu() && interaction.customId === 'setup_select_responsibility') {
      console.log(`🔄 معالجة اختيار المسؤولية من السيتب: ${interaction.values[0]} - Message ID: ${interaction.message.id}`);

      // التأكد من أن التفاعل لم يتم الرد عليه مسبقاً
      if (interaction.replied || interaction.deferred) {
        console.log('تم تجاهل تفاعل متكرر في منيو السيتب');
        return;
      }

      try {
        const selected = interaction.values[0];
        console.log(`✅ تم اختيار المسؤولية: ${selected}`);

        if (selected === 'no_responsibilities') {
          return interaction.reply({
            content: '**لا توجد مسؤوليات معرفة حتى الآن. يرجى إضافة مسؤوليات أولاً.**',
            flags: 64
          });
        }

        // التأكد من أن الرسالة التي تم الرد عليها هي رسالة الإعدادات
        if (!interaction.message.content.includes('Select a responsibility')) {
          return interaction.reply({ content: '**هذا ليس تفاعل إعدادات صالح.**', flags: 64 });
        }

        // التحقق من أن المستخدم الذي تفاعل هو نفس المستخدم الذي استدعى أمر setup
        const setupCommand = client.commands.get('setup');
        if (setupCommand && setupCommand.setupInitiatorId !== interaction.user.id) {
          return interaction.reply({ content: '**ليس لديك الإذن لاستخدام هذا التفاعل.**', flags: 64 });
        }

        // قراءة المسؤوليات مباشرة من الملف
        const fs = require('fs');
        const path = require('path');
        const responsibilitiesPath = path.join(__dirname, 'data', 'responsibilities.json');

        let currentResponsibilities = {};
        try {
          const data = fs.readFileSync(responsibilitiesPath, 'utf8');
          currentResponsibilities = JSON.parse(data);
        } catch (error) {
          console.error('Failed to load responsibilities:', error);
          return interaction.reply({ content: '**خطأ في تحميل المسؤوليات!**', flags: 64 });
        }

        const responsibility = currentResponsibilities[selected];
        if (!responsibility) {
          return interaction.reply({ content: '**المسؤولية غير موجودة!**', flags: 64 });
        }

        const desc = responsibility.description && responsibility.description.toLowerCase() !== 'لا'
          ? responsibility.description
          : '**No desc**';

        // بناء أزرار المسؤولين
        const buttons = [];
        const responsiblesList = [];

        if (responsibility.responsibles && responsibility.responsibles.length > 0) {
          for (let i = 0; i < responsibility.responsibles.length; i++) {
            const userId = responsibility.responsibles[i];
            try {
              const guild = interaction.guild;
              const member = await guild.members.fetch(userId);
              const displayName = member.displayName || member.user.username;
              responsiblesList.push(`${i + 1}. ${displayName}`);
              buttons.push(
                new ButtonBuilder()
                  .setCustomId(`setup_contact_${selected}_${userId}`)
                  .setLabel(`${i + 1}`)
                  .setStyle(ButtonStyle.Primary)
              );
            } catch (error) {
              console.error(`Failed to fetch member ${userId}:`, error);
              responsiblesList.push(`${i + 1}. User ${userId}`);
              buttons.push(
                new ButtonBuilder()
                  .setCustomId(`setup_contact_${selected}_${userId}`)
                  .setLabel(`${i + 1}`)
                  .setStyle(ButtonStyle.Primary)
              );
            }
          }
        }

        if (buttons.length > 0) {
          buttons.push(
            new ButtonBuilder()
              .setCustomId(`setup_contact_${selected}_all`)
              .setLabel('الكل')
              .setStyle(ButtonStyle.Success)
          );
        }

        if (buttons.length === 0) {
          return interaction.reply({
            content: `**المسؤولية:** __${selected}__\n**الشرح:** *${desc}*\n**لا يوجد مسؤولين معينين لهذه المسؤولية!**`,
            flags: 64
          });
        }

        // إنشاء الإيمبد والأزرار
        const responseEmbed = colorManager.createEmbed()
          .setTitle(`استدعاء مسؤولي: ${selected}`)
          .setDescription(`**الشرح:** *${desc}*\n\n**المسؤولين المتاحين:**\n*${responsiblesList.join('\n')}*\n\n**اختر من تريد استدعائه:**`)
          .setThumbnail('https://cdn.discordapp.com/emojis/1303973825591115846.png?v=1');

        const actionRows = [];
        for (let i = 0; i < buttons.length; i += 5) {
          actionRows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
        }

        await interaction.reply({
          embeds: [responseEmbed],
          components: actionRows,
          flags: 64
        });

        // إنشاء collector للأزرار - persistent
        const buttonCollector = interaction.channel.createMessageComponentCollector({
          filter: i => i.customId.startsWith('setup_contact_') && i.user.id === interaction.user.id,
          time: 10 * 60 * 1000
        });

        buttonCollector.on('collect', async buttonInteraction => {
          try {
            if (buttonInteraction.replied || buttonInteraction.deferred) {
              return;
            }

            const parts = buttonInteraction.customId.split('_');
            if (parts.length < 4) {
              return;
            }

            const responsibilityName = parts[2];
            const userId = parts[3]; // Store the target user ID

            // إظهار نموذج السبب
            const modal = new ModalBuilder()
              .setCustomId(`setup_reason_modal_${responsibilityName}_${userId}_${Date.now()}`) // Include target user ID in customId
              .setTitle('call reason');

            const reasonInput = new TextInputBuilder()
              .setCustomId('reason')
              .setLabel('Reason')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setPlaceholder('اكتب سبب الحاجة للمسؤول...')
              .setMaxLength(1000);

            const reasonRow = new ActionRowBuilder().addComponents(reasonInput);
            modal.addComponents(reasonRow);

            await buttonInteraction.showModal(modal);

          } catch (error) {
            console.error('Error in setup button collector:', error);
          }
        });

        // Set a timeout to delete the message after 10 minutes if no action is taken
        const deleteTimeout = setTimeout(async () => {
          try {
            buttonCollector.stop('time');
            await interaction.deleteReply().catch(() => {});
            console.log('تم حذف رسالة الاستدعاء بعد انتهاء الوقت المحدد من المعالج العام');

            // Try to update all setup menus
            try {
              const setupCommand = client.commands.get('setup');
              if (setupCommand && setupCommand.updateAllSetupMenus) {
                setupCommand.updateAllSetupMenus(client);
                console.log('تم تحديث جميع منيو السيتب من المعالج العام');
              }
            } catch (error) {
              console.error('خطأ في تحديث منيو السيتب من المعالج العام:', error);
            }
          } catch (error) {
            console.error('خطأ في حذف رسالة الاستدعاء من المعالج العام:', error);
          }
        }, 10 * 60 * 1000); // 10 دقائق

        buttonCollector.on('collect', async (buttonInteraction) => {
          // Clear the delete timeout when any button is clicked
          clearTimeout(deleteTimeout);
        });

        buttonCollector.on('end', async (collected, reason) => {
          try {
            console.log(`Button collector ended in global handler: ${reason}`);

            // Clear the timeout
            clearTimeout(deleteTimeout);

            // Only delete message if collector ended due to timeout or manual stop
            if (reason === 'time' || reason === 'manual') {
              try {
                await interaction.deleteReply().catch(() => {});
                console.log('تم حذف رسالة الاستدعاء من المعالج العام');
              } catch (error) {
                console.error('خطأ في حذف رسالة الاستدعاء من المعالج العام:', error);
              }

              // Try to update all setup menus
              try {
                const setupCommand = client.commands.get('setup');
                if (setupCommand && setupCommand.updateAllSetupMenus) {
                  setupCommand.updateAllSetupMenus(client);
                  console.log('تم تحديث جميع منيو السيتب من المعالج العام');
                }
              } catch (error) {
                console.error('خطأ في تحديث منيو السيتب من المعالج العام:', error);
              }
            }
          } catch (error) {
            console.error('خطأ في إنهاء button collector في المعالج العام:', error);
          }
        });

      } catch (error) {
        console.error('Error in setup select menu:', error);
        try {
          await interaction.reply({
            content: '**حدث خطأ أثناء معالجة الطلب.**',
            flags: 64
          });
        } catch (replyError) {
          console.error('Failed to send error reply:', replyError);
        }
      }
      return;
    }

    // Handle button clicks for setup contacts - الآن يعمل مع جميع الرسائل
    if (interaction.isButton() && interaction.customId.startsWith('setup_contact_')) {
      console.log(`🔘 معالجة زر الاتصال: ${interaction.customId}`);

      // التأكد من أن التفاعل لم يتم الرد عليه مسبقاً
      if (interaction.replied || interaction.deferred) {
        console.log('تم تجاهل تفاعل متكرر في أزرار السيتب');
        return;
      }

      // هذا الزر تم معالجته بالفعل في معالج select menu أعلاه
      // لا نحتاج معالجة إضافية هنا
      return;
    }

  } catch (error) {
    // تسجيل أي خطأ للتشخيص
    console.error(`[CATCH] خطأ في معالج التفاعلات: ${error.message}`);
    const customId = interaction?.customId || 'unknown';
    if (interaction && interaction.customId) {
      console.error(`[CATCH] customId: ${customId}`);
    }

    // قائمة الأخطاء المتجاهلة الموسعة
    const ignoredErrorCodes = [
      10008, // Unknown Message
      40060, // Interaction has already been acknowledged
      10062, // Unknown interaction
      10003, // Unknown channel
      50013, // Missing permissions
      50001, // Missing access
      50027, // Invalid webhook token
      10015, // Unknown webhook
      50035, // Invalid form body
      10014, // Unknown emoji
      10020, // Unknown user
      40061, // Interaction already replied
      50021, // Cannot edit a message that was not sent by the bot
      50025, // Invalid OAuth state
      30001, // Maximum number of guilds reached
      30003, // Maximum number of friends reached
      30005, // Maximum number of reactions reached
      30010, // Maximum number of channels reached
      50034  // You can only bulk delete messages that are under 14 days old
    ];

    // تجاهل أخطاء Discord المعروفة
    if (error.code && ignoredErrorCodes.includes(error.code)) {
      console.log(`تم تجاهل خطأ Discord المعروف: ${error.code}`);
      return;
    }

    // تجاهل رسائل الأخطاء المعروفة
    if (error.message && (
      error.message.includes('Unknown interaction') ||
      error.message.includes('Already replied') ||
      error.message.includes('Reply timeout') ||
      error.message.includes('Invalid Form Body') ||
      error.message.includes('Cannot read properties of undefined') ||
      error.message.includes('Unknown Message') ||
      error.message.includes('Unknown channel')
    )) {
      console.log(`تم تجاهل خطأ معروف: ${error.message.substring(0, 50)}...`);
      return;
    }

    // تجاهل التفاعلات القديمة
    if (interaction && interaction.createdTimestamp) {
      const interactionAge = Date.now() - interaction.createdTimestamp;
      if (interactionAge > 12 * 60 * 1000) { // 12 دقيقة
        console.log('تم تجاهل تفاعل قديم');
        return;
      }
    }

    // تسجيل الأخطاء المهمة فقط مع تفاصيل أقل
    if (error.code && !ignoredErrorCodes.includes(error.code)) {
      console.error(`خطأ مهم في التفاعل - كود: ${error.code}, رسالة: ${error.message?.substring(0, 100)}`);
    }
  }
});

// دالة لعرض مسؤوليات المستخدم
async function showUserResponsibilities(message, targetUser, responsibilities, client) {
    const { getSupervisedResponsibilities } = require('./utils/responsibilitySupervisors.js');
    const { getUserResponsibilityPointTotals } = require('./utils/responsibilityPoints.js');
    const targetMember = await message.guild.members.fetch(targetUser.id).catch(() => null);
    const responsibilityPointTotals = getUserResponsibilityPointTotals(ticketState.loadPoints(), targetUser.id);
    const supervisedNames = new Set(
        getSupervisedResponsibilities(message.guild.id, targetMember || targetUser, responsibilities)
    );
    const assignedResponsibilities = [];

    for (const [respName, respData] of Object.entries(responsibilities)) {
        const isResponsible = Array.isArray(respData.responsibles)
            && respData.responsibles.map(String).includes(String(targetUser.id));
        if (isResponsible) {
            assignedResponsibilities.push({
                name: respName,
                responsibilityPoints: responsibilityPointTotals[respName] || 0
            });
        }
    }

    const accentHex = await getGuildBannerHex(
        message.guild,
        colorManager.getColor?.() || '#5865F2'
    );
    const summaryImage = buildResponsibilitiesSummaryImage({
        guildName: message.guild.name,
        memberName: targetMember?.displayName || targetUser.globalName || targetUser.username,
        accentColor: accentHex,
        responsibilities: assignedResponsibilities,
        supervisors: [...supervisedNames].map(name => ({ name }))
    });
    await message.channel.send({ files: [summaryImage] });
}
async function handleBulkPromotionStats(interaction, client) {
    const { getRealUserStats } = require('./utils/userStatsCollector');
    const { ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');

    // تهيئة المتغير إذا لم يكن موجوداً
    if (!client.bulkPromotionMembers) {
        client.bulkPromotionMembers = new Map();
    }

    // استخراج معرف البيانات والصفحة الحالية
    let currentPage = 0;
    let dataKey = interaction.customId;

    if (interaction.customId.includes('stats_nav_')) {
        const parts = interaction.customId.split('_');
        dataKey = parts.slice(3).join('_'); // كل شيء بعد stats_nav_
        currentPage = parseInt(parts[2]) || 0;
    }

    // البحث عن البيانات في جميع المفاتيح المحفوظة
    let membersData = null;
    let actualKey = null;

    for (const [key, data] of client.bulkPromotionMembers.entries()) {
        if (key === dataKey || key.includes(dataKey.split('_').slice(-1)[0])) {
            membersData = data;
            actualKey = key;
            break;
        }
    }

    if (!membersData) {
        return interaction.reply({
            content: 'لم يتم العثور على بيانات الأعضاء المترقين أو انتهت صلاحيتها.',
            flags: MessageFlags.Ephemeral
        });
    }

    // التحقق من صلاحية البيانات (24 ساعة)
    const dataAge = Date.now() - membersData.timestamp;
    if (dataAge > 24 * 60 * 60 * 1000) {
        client.bulkPromotionMembers.delete(actualKey);
        return interaction.reply({
            content: 'انتهت صلاحية بيانات الأعضاء المترقين (24 ساعة).',
            flags: MessageFlags.Ephemeral
        });
    }

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // جمع الإحصائيات مرة واحدة فقط ثم إعادة استخدامها عند التنقل بين الصفحات.
        const membersWithStats = [];
        const statsCache = membersData.statsCache && typeof membersData.statsCache === 'object'
            ? membersData.statsCache
            : (membersData.statsCache = {});
        const membersToLoad = membersData.successfulMembers
            .map(member => typeof member === 'object' ? member : { id: member, displayName: null })
            .filter(member => member?.id && !statsCache[member.id]);

        // حد أقصى 5 عمليات متزامنة لتجنب ضغط REST/قاعدة البيانات.
        for (let i = 0; i < membersToLoad.length; i += 5) {
            await Promise.all(membersToLoad.slice(i, i + 5).map(async (memberObj) => {
                try {
                    const guildMember = interaction.guild.members.cache.get(memberObj.id)
                        || await interaction.guild.members.fetch(memberObj.id).catch(() => null);
                    if (!guildMember) return;
                    statsCache[memberObj.id] = {
                        id: memberObj.id,
                        displayName: guildMember.displayName || guildMember.user.username,
                        username: guildMember.user.username,
                        stats: await getRealUserStats(memberObj.id)
                    };
                } catch (error) {
                    console.error(`خطأ في جمع إحصائيات العضو ${memberObj.id}:`, error);
                }
            }));
        }

        for (const member of membersData.successfulMembers) {
            const cached = statsCache[typeof member === 'object' ? member.id : member];
            if (cached) membersWithStats.push(cached);
        }

        // ترتيب الأعضاء حسب الوقت الصوتي (الأكثر نشاطاً أولاً)
        membersWithStats.sort((a, b) => (b.stats.voiceTime || 0) - (a.stats.voiceTime || 0));

        // إعداد التنقل
        const membersPerPage = 10;
        const totalPages = Math.ceil(membersWithStats.length / membersPerPage);
        currentPage = Math.max(0, Math.min(currentPage, totalPages - 1));

        const startIndex = currentPage * membersPerPage;
        const endIndex = Math.min(startIndex + membersPerPage, membersWithStats.length);
        const currentMembers = membersWithStats.slice(startIndex, endIndex);

        // محاولة الحصول على أسماء الرولات
        let sourceRoleName = 'الرول المصدر';
        let targetRoleName = 'الرول المستهدف';

        try {
            if (membersData.sourceRoleId) {
                const sourceRole = await interaction.guild.roles.fetch(membersData.sourceRoleId);
                if (sourceRole) sourceRoleName = sourceRole.name;
            }
            if (membersData.targetRoleId) {
                const targetRole = await interaction.guild.roles.fetch(membersData.targetRoleId);
                if (targetRole) targetRoleName = targetRole.name;
            }
        } catch (roleError) {
            console.log('خطأ في جلب أسماء الرولات:', roleError);
        }

        // إنشاء الإمبد
        const statsEmbed = colorManager.createEmbed()
            .setTitle('احصائيات المترقين - ترقية جماعية')
            .setDescription(`من: ${sourceRoleName}\nإلى: ${targetRoleName}\nبواسطة: <@${membersData.moderator}>\nالسبب: ${membersData.reason || 'لم يتم تحديد سبب'}`)
            .setFooter({ 
                text: `الصفحة ${currentPage + 1} من ${totalPages} | إجمالي الأعضاء: ${membersWithStats.length}` 
            })
            .setTimestamp();

        // إضافة إحصائيات كل عضو كحقول منفصلة
        for (let i = 0; i < currentMembers.length; i++) {
            const member = currentMembers[i];
            const stats = member.stats;

            // تنسيق الوقت الصوتي
            const voiceTimeFormatted = formatDuration(stats.voiceTime || 0);

            const statsValue = `الوقت الصوتي: ${voiceTimeFormatted}\nالانضمامات: ${stats.joinedChannels || 0}\nالرسائل: ${stats.messages || 0}\nالتفاعلات: ${stats.reactionsGiven || 0}`;

            statsEmbed.addFields([{
                name: `${startIndex + i + 1}. ${member.displayName}`,
                value: statsValue,
                inline: true
            }]);
        }

        // إنشاء أزرار التنقل
        const components = [];
        if (totalPages > 1) {
            const navigationRow = new ActionRowBuilder();

            // زر السابق
            const prevButton = new ButtonBuilder()
                .setCustomId(`stats_nav_${Math.max(0, currentPage - 1)}_${actualKey}`)
                .setLabel('السابق')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === 0);

            // زر التالي
            const nextButton = new ButtonBuilder()
                .setCustomId(`stats_nav_${Math.min(totalPages - 1, currentPage + 1)}_${actualKey}`)
                .setLabel('التالي')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(currentPage === totalPages - 1);

            navigationRow.addComponents(prevButton, nextButton);
            components.push(navigationRow);
        }

        // إرسال الرد
        await interaction.editReply({
            embeds: [statsEmbed],
            components: components
        });

    } catch (error) {
        console.error('خطأ في عرض إحصائيات المترقين:', error);
        await interaction.editReply({
            content: 'حدث خطأ أثناء جمع الإحصائيات.',
            embeds: [],
            components: []
        });
    }
}

// دالة لتنسيق المدة الزمنية
function formatDuration(milliseconds) {
    if (!milliseconds || milliseconds <= 0) return 'لا يوجد';

    const totalSeconds = Math.floor(milliseconds / 1000);
    const totalMinutes = Math.floor(totalSeconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    const days = Math.floor(totalHours / 24);

    const hours = totalHours % 24;
    const minutes = totalMinutes % 60;
    const seconds = totalSeconds % 60;

    const parts = [];
    if (days > 0) parts.push(`${days} يوم`);
    if (hours > 0) parts.push(`${hours} ساعة`);
    if (minutes > 0) parts.push(`${minutes} دقيقة`);
    if (seconds > 0 && days === 0) parts.push(`${seconds} ثانية`);

    return parts.length > 0 ? parts.join(' و ') : 'أقل من ثانية';
}

async function gracefulShutdown(signal) {
    console.log(`\n🔄 جاري إيقاف البوت بأمان... (${signal})`);

    try {
        if (global.gc) {
            console.log('🧹 Triggering garbage collection...');
            global.gc();
        }
        saveData(true);
        client.destroy();
        process.exit(0);
    } catch (error) {
        process.exit(1);
    }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// معالج الأخطاء غير المعالجة
process.on('uncaughtException', (error) => {
  // تجاهل أخطاء Discord المعروفة
  const ignoredCodes = [10008, 40060, 10062, 10003, 50013, 50001, 50027, 10015, 50035, 10014, 10020, 40061];
  if (error.code && ignoredCodes.includes(error.code)) {
    console.log(`تم تجاهل خطأ Discord المعروف: ${error.code} - ${error.message}`);
    return;
  }

  // تجاهل رسائل الأخطاء المعروفة
  const ignoredMessages = [
    'Unknown interaction',
    'Unknown user',
    'already been acknowledged',
    'already replied',
    'Interaction has already been acknowledged',
    'Unknown Message',
    'Unknown channel'
  ];

  if (error.message && ignoredMessages.some(msg => error.message.includes(msg))) {
    console.log(`تم تجاهل خطأ معروف: ${error.message}`);
    return;
  }

  console.error('❌ خطأ غير معالج:', error);

  // حفظ البيانات بدون إيقاف البوت
  try {
    saveData();
    console.log('💾 تم حفظ البيانات بعد الخطأ');
  } catch (saveError) {
    console.error('❌ فشل في حفظ البيانات:', saveError);
  }

  // عدم إيقاف البوت للأخطاء البسيطة
  console.log('🔄 استمرار عمل البوت رغم الخطأ');
});

process.on('unhandledRejection', (reason, promise) => {
  // تجاهل أخطاء Discord المعروفة
  if (reason && reason.code) {
    const ignoredCodes = [10008, 40060, 10062, 10003, 50013, 50001, 50027, 10015, 50035, 10014, 10020, 40061];
    if (ignoredCodes.includes(reason.code)) {
      console.log(`تم تجاهل رفض Discord معروف: ${reason.code} - ${reason.message}`);
      return;
    }
  }

  // تجاهل رسائل الرفض المعروفة
  if (reason && reason.message) {
    const ignoredMessages = [
      'Unknown interaction',
      'Unknown user',
      'already been acknowledged',
      'already replied',
      'Interaction has already been acknowledged',
      'Unknown Message',
      'Unknown channel'
    ];

    if (ignoredMessages.some(msg => reason.message.includes(msg))) {
      console.log(`تم تجاهل رفض معروف: ${reason.message}`);
      return;
    }
  }

  console.error('❌ رفض غير معالج:', reason);

  // حفظ البيانات
  try {
    saveData();
  } catch (saveError) {
    console.error('❌ فشل في حفظ البيانات:', saveError);
  }
});

async function startBot() {
    await safeInitializeMainDatabase('pre-login', 12000);
    
    const respPath = DATA_FILES.responsibilities;
    if (fs.existsSync(respPath) && fs.statSync(respPath).size > 2) {
        try {
            const fileContent = fs.readFileSync(respPath, 'utf8').trim();
            if (fileContent && fileContent !== '{}') {
                const data = JSON.parse(fileContent);
                if (dbManager.isInitialized) {
                    for (const [name, config] of Object.entries(data)) {
                        await dbManager.updateResponsibility(name, config);
                    }
                    console.log('✅ Migrated Responsibilities to SQLite');
                } else {
                    console.warn('⚠️ تم تخطي مزامنة المسؤوليات إلى SQLite مؤقتاً لأن القاعدة غير جاهزة.');
                }
            }
        } catch (e) { 
            console.error('Migration failed:', e.message); 
        }
    }

    // 24-hour expiration check for pairings
setInterval(async () => {
  try {
    const now = Date.now();
    let changed = false;
    const notifiedPairs = new Set();
    const ALLOWED_ID = '636930315503534110';

    for (const [userId, data] of Object.entries(pairingsCache)) {
      if (now - data.timestamp > 24 * 60 * 60 * 1000) {
        const targetId = data.targetId;
        const pairKey = [userId, targetId].sort().join('_');
        if (notifiedPairs.has(pairKey)) {
          continue;
        }
        notifiedPairs.add(pairKey);
        delete pairingsCache[userId];
        if (pairingsCache[targetId]) delete pairingsCache[targetId];
        changed = true;
        
        try {
          if (userId === ALLOWED_ID || targetId === ALLOWED_ID) {
            const allowedUser = await client.users.fetch(ALLOWED_ID);
            const otherId = userId === ALLOWED_ID ? targetId : userId;
            await allowedUser.send(`⏳ **انتهى وقت الاقتران التلقائي (24 ساعة) مع <@${otherId}>.**`);
          }
        } catch (e) {}
      }
    }

    if (changed) {
      savePairings();
    }
  } catch (error) {
    console.error('Error in pairing expiration check:', error);
  }
}, 5 * 60 * 1000); // Check every 5 minutes

    // =================================
    

    client.login(process.env.DISCORD_TOKEN);
}

startBot();
