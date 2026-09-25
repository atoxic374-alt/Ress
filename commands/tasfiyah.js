const { getBotConfigPath } = require('../utils/storagePaths');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, AuditLogEvent, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const colorManager = require('../utils/colorManager.js');
const { isUserBlocked } = require('./block.js');
const { isChannelBlocked } = require('./chatblock.js');
const { getDatabase } = require('../utils/database.js');
const promoteManager = require('../utils/promoteManager');
const moment = require('moment-timezone');
const respCommand = require('./resp.js');

const name = 'تصفيه';

const interactiveRolesPath = path.join(__dirname, '..', 'data', 'interactiveRoles.json');
const adminApplicationsPath = path.join(__dirname, '..', 'data', 'adminApplications.json');
const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
const roleGrantHistoryPath = path.join(__dirname, '..', 'data', 'roleGrantHistory.json');
const undoOperationsPath = path.join(__dirname, '..', 'data', 'tasfiyahUndo.json');
let cachedAdminApplications = null;
let cachedAdminApplicationsMtime = null;
let cachedResponsibilities = null;
let cachedResponsibilitiesMtime = null;
const activeTasfiyahGuilds = new Map();
const auditGrantCacheStore = new Map();
const activeUndoOperations = new Map();

function readUndoOperations() {
    try {
        if (!fs.existsSync(undoOperationsPath)) return {};
        return JSON.parse(fs.readFileSync(undoOperationsPath, 'utf8')) || {};
    } catch (error) {
        console.error('Tasfiyah undo storage read error:', error);
        return {};
    }
}

function writeUndoOperations(data) {
    try {
        writeJsonAtomically(undoOperationsPath, data);
        return true;
    } catch (error) {
        console.error('Tasfiyah undo storage write error:', error);
        return false;
    }
}

function updatePersistedUndo(guildId, patch) {
    const data = readUndoOperations();
    const current = data[guildId] || {};
    data[guildId] = { ...current, ...patch };
    writeUndoOperations(data);
}

async function safeEditMessage(targetMessage, payload) {
    if (!targetMessage?.edit) return false;
    try {
        await targetMessage.edit(payload);
        return true;
    } catch (error) {
        const ignoredCodes = new Set([10008, 10003, 50001, 50013]);
        if (!ignoredCodes.has(error?.code)) {
            console.warn('Tasfiyah message update skipped:', error?.code || error?.message);
        }
        return false;
    }
}

function invalidateUndoOperation(guildId) {
    const operation = activeUndoOperations.get(guildId);
    if (!operation) return;
    updatePersistedUndo(guildId, { status: 'replaced', updatedAt: Date.now() });
    operation.collector?.stop('replaced');
    operation.message?.edit({ components: [] }).catch(() => {});
    activeUndoOperations.delete(guildId);
}

function registerUndoOperation(guildId, operation) {
    invalidateUndoOperation(guildId);
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const record = { ...operation, expiresAt };
    const cleanup = setTimeout(() => {
        if (activeUndoOperations.get(guildId) === record) {
            activeUndoOperations.delete(guildId);
            updatePersistedUndo(guildId, { status: 'expired', updatedAt: Date.now() });
            record.collector?.stop('expired');
            record.message?.edit({ components: [] }).catch(() => {});
        }
    }, 10 * 60 * 1000);
    cleanup.unref?.();
    record.cleanup = () => {
        clearTimeout(cleanup);
        if (activeUndoOperations.get(guildId) === record) activeUndoOperations.delete(guildId);
    };
    updatePersistedUndo(guildId, {
        operationId: record.token,
        executorId: record.executorId,
        messageId: record.message?.id,
        logChannelId: record.logChannelId || null,
        removedRoleEntries: (record.removedRoleEntries || []).map((entry) => ({
            memberId: entry.memberId,
            roleIds: entry.roleIds,
            removedAt: entry.removedAt || Date.now()
        })),
        removedMembers: record.removedMembers || {},
        createdAt: Date.now(),
        expiresAt,
        status: 'active'
    });
    activeUndoOperations.set(guildId, record);
    return record;
}

function writeJsonAtomically(filePath, data) {
    const directory = path.dirname(filePath);
    const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    const backupPath = `${filePath}.bak`;
    const backupTempPath = `${backupPath}.${process.pid}.${Date.now()}.tmp`;
    const serialized = JSON.stringify(data, null, 2);

    fs.mkdirSync(directory, { recursive: true });
    try {
        fs.writeFileSync(tempPath, serialized, { encoding: 'utf8', mode: 0o600 });
        if (fs.existsSync(filePath)) {
            fs.copyFileSync(filePath, backupTempPath);
        }
        fs.renameSync(tempPath, filePath);
        if (fs.existsSync(backupTempPath)) {
            try {
                fs.renameSync(backupTempPath, backupPath);
            } catch (backupError) {
                console.warn('Tasfiyah: تعذر تدوير النسخة الاحتياطية:', backupError.message);
                fs.rmSync(backupTempPath, { force: true });
            }
        }
    } catch (error) {
        if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
        if (fs.existsSync(backupTempPath)) fs.rmSync(backupTempPath, { force: true });
        throw error;
    }
}

async function undoRemovedRoles(guild, removedRoleEntries = [], removedMembers = {}, client = null) {
    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const botHighestPosition = botMember?.roles?.highest?.position;
    if (!Number.isFinite(botHighestPosition)) {
        return { success: 0, failed: [{ memberId: null, reason: 'تعذر التحقق من رتبة البوت.' }] };
    }

    let success = 0;
    const failed = [];
    const concurrency = removedRoleEntries.length <= 10 ? 2 : removedRoleEntries.length <= 50 ? 4 : 6;

    await mapWithConcurrency(removedRoleEntries, concurrency, async (entry) => {
        const member = await guild.members.fetch(entry.memberId).catch(() => null);
        if (!member) {
            failed.push({ memberId: entry.memberId, reason: 'تعذر جلب العضو.' });
            return;
        }

        const restorableRoles = entry.roleIds
            .map((roleId) => guild.roles.cache.get(roleId))
            .filter((role) => role && !role.managed && role.position < botHighestPosition && !member.roles.cache.has(role.id));

        if (restorableRoles.length === 0) {
            failed.push({ memberId: entry.memberId, reason: 'لا توجد رولات قابلة للإرجاع حاليًا.' });
            return;
        }

        try {
            await member.roles.add(restorableRoles, 'Tasfiyah undo');
            success += 1;
        } catch (error) {
            failed.push({ memberId: entry.memberId, reason: formatFailureReason(error) });
        }
    });

    const responsibilityResult = restoreMembersToResponsibilities(removedMembers);
    if (responsibilityResult.restored > 0 && typeof respCommand.updateEmbedMessage === 'function' && client) {
        await respCommand.updateEmbedMessage(client, guild.id).catch(() => {});
    }
    return { success, failed, responsibilityResult };
}

function acquireTasfiyahLock(guildId) {
    if (!guildId || activeTasfiyahGuilds.has(guildId)) return null;
    const token = `${guildId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const leaseDuration = 20 * 60 * 1000;
    let released = false;
    let expiryTimer;
    const renew = () => {
        if (released) return;
        if (activeTasfiyahGuilds.get(guildId)?.token !== token) {
            clearInterval(heartbeat);
            return;
        }
        clearTimeout(expiryTimer);
        expiryTimer = setTimeout(() => {
            if (activeTasfiyahGuilds.get(guildId)?.token === token) {
                activeTasfiyahGuilds.delete(guildId);
            }
            clearInterval(heartbeat);
        }, leaseDuration);
        expiryTimer.unref?.();
    };
    const heartbeat = setInterval(renew, 30 * 1000);
    heartbeat.unref?.();
    activeTasfiyahGuilds.set(guildId, { token, renew });
    renew();
    const release = () => {
        if (released) return;
        released = true;
        clearTimeout(expiryTimer);
        clearInterval(heartbeat);
        if (activeTasfiyahGuilds.get(guildId)?.token === token) {
            activeTasfiyahGuilds.delete(guildId);
        }
    };
    release.touch = renew;
    release.token = token;
    return release;
}

async function validateTasfiyahPermissions(message, logChannelId = null) {
    const botMember = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
    if (!botMember) return ['تعذر العثور على عضو البوت داخل السيرفر.'];

    const missing = [];
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) missing.push('ManageRoles');
    const executionPermissions = message.channel.permissionsFor(botMember);
    if (!executionPermissions?.has(PermissionFlagsBits.ViewChannel)) missing.push('ViewChannel في قناة التنفيذ');
    if (!executionPermissions?.has(PermissionFlagsBits.SendMessages)) missing.push('SendMessages في قناة التنفيذ');
    if (!executionPermissions?.has(PermissionFlagsBits.EmbedLinks)) missing.push('EmbedLinks في قناة التنفيذ');

    if (logChannelId) {
        const logChannel = message.guild.channels.cache.get(logChannelId)
            || await message.guild.channels.fetch(logChannelId).catch(() => null);
        if (!logChannel) {
            missing.push('قناة السجل غير موجودة');
        } else {
            const logPermissions = logChannel.permissionsFor(botMember);
            if (!logPermissions?.has(PermissionFlagsBits.ViewChannel)) missing.push('ViewChannel في قناة السجل');
            if (!logPermissions?.has(PermissionFlagsBits.SendMessages)) missing.push('SendMessages في قناة السجل');
            if (!logPermissions?.has(PermissionFlagsBits.EmbedLinks)) missing.push('EmbedLinks في قناة السجل');
        }
    }
    return missing;
}

function loadSettings() {
    try {
        if (fs.existsSync(interactiveRolesPath)) {
            const data = JSON.parse(fs.readFileSync(interactiveRolesPath, 'utf8'));
            if (!data.settings) {
                data.settings = { approvers: [], interactiveRoles: [], requestChannel: null, exceptions: [] };
            }
            return data;
        }
    } catch (error) {
        console.error('Error loading interactive roles settings:', error);
    }
    return {
        settings: { approvers: [], interactiveRoles: [], requestChannel: null, exceptions: [] },
        pendingRequests: {},
        cooldowns: {},
        exceptionCooldowns: {},
        pendingExceptionRequests: {}
    };
}

function getBotOwners() {
    const botConfigPath = getBotConfigPath();
    let BOT_OWNERS = global.BOT_OWNERS || [];
    if (BOT_OWNERS.length === 0) {
        try {
            if (fs.existsSync(botConfigPath)) {
                const botConfig = JSON.parse(fs.readFileSync(botConfigPath, 'utf8'));
                BOT_OWNERS = botConfig.owners || [];
            }
        } catch (e) {}
    }
    return BOT_OWNERS;
}

function hasPermission(member, settings) {
    const isGuildOwner = member.guild.ownerId === member.id;
    const BOT_OWNERS = getBotOwners();
    const approverRoles = Array.isArray(settings?.settings?.approvers) ? settings.settings.approvers : [];
    const hasApproverRole = approverRoles.length > 0
        ? member.roles.cache.some((role) => approverRoles.includes(role.id))
        : false;
    return isGuildOwner || BOT_OWNERS.includes(member.id) || hasApproverRole;
}

function loadAdminApplicationSettings() {
    try {
        if (fs.existsSync(adminApplicationsPath)) {
            const stats = fs.statSync(adminApplicationsPath);
            if (!cachedAdminApplications || cachedAdminApplicationsMtime !== stats.mtimeMs) {
                const data = fs.readFileSync(adminApplicationsPath, 'utf8');
                cachedAdminApplications = JSON.parse(data);
                cachedAdminApplicationsMtime = stats.mtimeMs;
            }
            return cachedAdminApplications;
        }
    } catch (error) {
        console.error('خطأ في قراءة إعدادات التقديم الإداري:', error);
    }
    return {
        settings: {
            approvers: { type: "roles", list: [] }
        }
    };
}

function canUseAdminFilter(member, settings) {
    const BOT_OWNERS = getBotOwners();
    const isBotOwner = BOT_OWNERS.includes(member.id);
    const isGuildOwner = member.guild.ownerId === member.id;
    if (isBotOwner || isGuildOwner) return true;
    const approvers = settings?.settings?.approvers;
    if (!approvers) return false;

    if (approvers.type === 'owners') {
        return isBotOwner;
    }

    if (approvers.type === 'roles') {
        return member.roles.cache.some(role => approvers.list.includes(role.id));
    }

    if (approvers.type === 'responsibility') {
        try {
            if (fs.existsSync(responsibilitiesPath)) {
                const stats = fs.statSync(responsibilitiesPath);
                if (!cachedResponsibilities || cachedResponsibilitiesMtime !== stats.mtimeMs) {
                    const data = fs.readFileSync(responsibilitiesPath, 'utf8');
                    cachedResponsibilities = JSON.parse(data);
                    cachedResponsibilitiesMtime = stats.mtimeMs;
                }
                const responsibilitiesData = cachedResponsibilities;
                const targetResp = approvers.list[0];
                if (responsibilitiesData[targetResp] && responsibilitiesData[targetResp].responsibles) {
                    return responsibilitiesData[targetResp].responsibles.includes(member.id);
                }
            }
        } catch (error) {
            console.error('خطأ في فحص المسؤوليات:', error);
        }
        return false;
    }

    return false;
}

function chunkArray(items, size) {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

async function getRemovableRoleIds(guild, roleIds = []) {
    const uniqueRoleIds = [...new Set(Array.isArray(roleIds) ? roleIds : [])];
    if (uniqueRoleIds.length === 0) return [];

    // جلب رتبة البوت مرة واحدة ثم فحص جميع الرولات محليًا بسرعة.
    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const botHighestPosition = botMember?.roles?.highest?.position;
    if (!Number.isFinite(botHighestPosition)) return [];

    return uniqueRoleIds.filter((roleId) => {
        const role = guild.roles.cache.get(roleId);
        return Boolean(role && !role.managed && role.position < botHighestPosition);
    });
}

function formatDuration(milliseconds) {
    if (!milliseconds || milliseconds <= 0) return '0';

    const totalSeconds = Math.floor(milliseconds / 1000);
    const totalMinutes = Math.floor(totalSeconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    const days = Math.floor(totalHours / 24);

    const hours = totalHours % 24;
    const minutes = totalMinutes % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    return parts.length > 0 ? parts.join(' and ') : 'أقل من دقيقة';
}

function formatShortDuration(milliseconds) {
    if (!milliseconds || milliseconds <= 0) return '0m';

    const totalSeconds = Math.floor(milliseconds / 1000);
    const totalMinutes = Math.floor(totalSeconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    const minutes = totalMinutes % 60;

    if (days > 0) {
        return `${days}d${hours > 0 ? ` ${hours}h` : ''}`;
    }

    if (hours > 0) {
        return `${hours}h${minutes > 0 ? ` ${minutes}m` : ''}`;
    }

    return `${Math.max(1, minutes)}m`;
}

async function getMemberRoleAgeText(guild, memberId, roleIds = [], auditGrantCache = null, history = {}) {
    try {
        if (!guild || !guild.id || !memberId || !Array.isArray(roleIds) || roleIds.length === 0) {
            return 'N/A';
        }

        const userHistory = history?.[guild.id]?.[memberId];
        const now = Date.now();
        const storedAges = Object.values(roleIds
            .map((roleId) => Number(userHistory?.[roleId] || 0))
            .filter((stamp) => Number.isFinite(stamp) && stamp > 0 && stamp <= now)
            .map((stamp) => now - stamp));

        const auditAges = (auditGrantCache && typeof auditGrantCache === 'object')
            ? roleIds
                .map((roleId) => Number(auditGrantCache?.[memberId]?.[roleId] || 0))
                .filter((stamp) => Number.isFinite(stamp) && stamp > 0 && stamp <= now)
                .map((stamp) => now - stamp)
            : [];

        const allReliableAges = [...storedAges, ...auditAges];
        if (allReliableAges.length === 0) {
            return 'N/A';
        }

        // نعرض الأقدم دائمًا حتى لا يتجدد العمر عند سحب/إعادة إعطاء الرول لاحقًا
        return formatShortDuration(Math.min(...allReliableAges));
    } catch (error) {
        console.error('Error while reading role grant history:', error);
        return 'N/A';
    }
}

async function buildAuditGrantCache(guild, roleIds = [], memberIds = [], maxPages = 12) {
    const cache = {};

    try {
        if (!guild || !Array.isArray(roleIds) || roleIds.length === 0 || !Array.isArray(memberIds) || memberIds.length === 0) {
            return cache;
        }

        const safeRoleIds = [...new Set(roleIds)].filter((id) => typeof id === 'string');
        const safeMemberIds = [...new Set(memberIds)].filter((id) => typeof id === 'string');
        const roleSet = new Set(safeRoleIds);
        const memberSet = new Set(safeMemberIds);
        const pendingMembers = new Set(safeMemberIds);
        const cacheKey = `${guild.id}:${safeRoleIds.sort().join(',')}:${safeMemberIds.sort().join(',')}`;
        const cached = auditGrantCacheStore.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.value;

        let before = null;
        const pageLimit = Math.min(12, Math.max(1, Number(maxPages) || 12));
        const fetchAuditPage = async (cursor) => {
            try {
                return await Promise.race([
                    guild.fetchAuditLogs({
                        type: AuditLogEvent.MemberRoleUpdate,
                        limit: 100,
                        ...(cursor ? { before: cursor } : {})
                    }),
                    new Promise((resolve) => setTimeout(() => resolve(null), 5000))
                ]);
            } catch (error) {
                console.warn('Tasfiyah audit log unavailable:', error.code || error.message);
                return null;
            }
        };

        for (let page = 0; page < pageLimit; page += 1) {
            const logs = await fetchAuditPage(before);

            if (!logs || !logs.entries || logs.entries.size === 0) break;

            await mapWithConcurrency(Array.from(logs.entries.values()), 10, async (entry) => {
                const targetId = entry?.target?.id;
                if (!targetId || !memberSet.has(targetId)) return;

                const addedChange = (entry.changes || []).find((change) => change?.key === '$add' && Array.isArray(change.new));
                if (!addedChange) return;

                const addedRoles = addedChange.new
                    .map((item) => item?.id)
                    .filter((id) => id && roleSet.has(id));

                if (addedRoles.length === 0) return;

                if (!cache[targetId]) cache[targetId] = {};
                const createdAt = Number(entry.createdTimestamp);
                if (!Number.isFinite(createdAt) || createdAt <= 0 || createdAt > Date.now()) return;

                for (const roleId of addedRoles) {
                    if (!cache[targetId][roleId] || createdAt < cache[targetId][roleId]) {
                        cache[targetId][roleId] = createdAt;
                    }
                }

                const foundRolesCount = Object.keys(cache[targetId] || {}).length;
                if (foundRolesCount >= roleSet.size) {
                    pendingMembers.delete(targetId);
                }
            });

            before = logs.entries.last()?.id;
            if (!before) break;
            if (pendingMembers.size === 0) break;
        }

        auditGrantCacheStore.set(cacheKey, { value: cache, expiresAt: Date.now() + 60 * 1000 });
        if (auditGrantCacheStore.size > 100) {
            const oldestKey = auditGrantCacheStore.keys().next().value;
            if (oldestKey) auditGrantCacheStore.delete(oldestKey);
        }
        return cache;
    } catch (error) {
        console.error('Error while building audit grant cache:', error);
        return {};
    }
}

function getLiveVoiceDuration(userId, fromTimestamp) {
    if (global.client && global.client.voiceSessions && global.client.voiceSessions.has(userId)) {
        const session = global.client.voiceSessions.get(userId);
        if (session && !session.isAFK) {
            const now = Date.now();
            const candidateStarts = [
                session.lastTrackedTime,
                session.startTime,
                session.sessionStartTime
            ]
                .map(Number)
                .filter((value) => Number.isFinite(value) && value > 0 && value <= now);
            const safeFromTimestamp = Number(fromTimestamp);
            const effectiveFrom = Number.isFinite(safeFromTimestamp) && safeFromTimestamp > 0
                ? Math.min(safeFromTimestamp, now)
                : 0;
            const liveStart = candidateStarts[0];
            if (!Number.isFinite(liveStart)) return 0;

            const effectiveStart = Math.max(liveStart, effectiveFrom);
            const duration = now - effectiveStart;
            return Number.isFinite(duration) && duration > 0 ? duration : 0;
        }
    }
    return 0;
}

async function mapWithConcurrency(items, limit, mapper) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const safeLimit = Math.max(1, Math.min(items.length, Math.floor(Number(limit) || 1)));
    const results = new Array(items.length);
    let nextIndex = 0;

    const worker = async () => {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;
            results[index] = await mapper(items[index], index, items);
        }
    };

    await Promise.all(Array.from({ length: safeLimit }, () => worker()));
    return results;
}

async function collectMembersForRoles(guild, roleIds = []) {
    const roles = [...new Set(roleIds)]
        .map((roleId) => guild.roles.cache.get(roleId))
        .filter(Boolean);
    if (roles.length === 0) return new Map();

    // role.members قد يكون ناقصًا؛ جلب الأعضاء مرة واحدة يجعل النتيجة موثوقة.
    const allMembers = await guild.members.fetch();
    const memberEntries = Array.from(allMembers.values());
    const membersMap = new Map();
    const workerCount = memberEntries.length <= 500
        ? 2
        : memberEntries.length <= 2000
            ? 4
            : 8;
    const chunkSize = Math.max(100, Math.ceil(memberEntries.length / workerCount));
    const chunks = chunkArray(memberEntries, chunkSize);

    await mapWithConcurrency(chunks, workerCount, async (chunk) => {
        for (const member of chunk) {
            if (member.user.bot) continue;
            const hasTargetRole = roles.some((role) => member.roles.cache.has(role.id));
            if (hasTargetRole) membersMap.set(member.id, member);
        }
    });

    return membersMap;
}

function getSmartLowestMemberIds(stats = []) {
    if (!Array.isArray(stats) || stats.length === 0) return new Set();

    const voiceValues = stats.map((stat) => Math.max(0, Number(stat.voiceTime) || 0)).sort((a, b) => a - b);
    const messageValues = stats.map((stat) => Math.max(0, Number(stat.messages) || 0)).sort((a, b) => a - b);
    const protectionIndex = Math.floor((stats.length - 1) * 0.7);
    const strongVoiceThreshold = voiceValues[protectionIndex] || 0;
    const strongMessageThreshold = messageValues[protectionIndex] || 0;
    const maxVoice = voiceValues[voiceValues.length - 1] || 0;
    const maxMessages = messageValues[messageValues.length - 1] || 0;

    const ranked = stats.map((stat) => {
        const voiceTime = Math.max(0, Number(stat.voiceTime) || 0);
        const messages = Math.max(0, Number(stat.messages) || 0);
        const voiceRatio = maxVoice > 0 ? voiceTime / maxVoice : 0;
        const messageRatio = maxMessages > 0 ? messages / maxMessages : 0;
        return {
            id: stat.member.id,
            activityScore: (voiceRatio * 0.5) + (messageRatio * 0.5),
            protected: (strongVoiceThreshold > 0 && voiceTime >= strongVoiceThreshold)
                || (strongMessageThreshold > 0 && messages >= strongMessageThreshold)
        };
    }).sort((a, b) => a.activityScore - b.activityScore);

    const targetCount = Math.max(1, Math.ceil(stats.length * 0.2));
    return new Set(
        ranked
            .filter((item) => !item.protected)
            .slice(0, targetCount)
            .map((item) => item.id)
    );
}

function formatEta(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0s';
    const totalSeconds = Math.max(1, Math.ceil(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
}

function buildProgressBar(done, total, size = 12) {
    if (!total) return '⬜'.repeat(size);
    const filled = Math.min(size, Math.max(0, Math.round((done / total) * size)));
    return `${'🟩'.repeat(filled)}${'⬜'.repeat(size - filled)}`;
}

function formatPercent(done, total) {
    if (!total) return '0%';
    return `${Math.min(100, Math.max(0, Math.round((done / total) * 100)))}%`;
}

function chunkLines(lines, maxLength = 3800) {
    if (!Array.isArray(lines) || lines.length === 0) {
        return ['لا يوجد'];
    }
    const chunks = [];
    let current = '';
    for (const line of lines) {
        const next = current ? `${current}\n${line}` : line;
        if (next.length > maxLength) {
            if (current) chunks.push(current);
            current = line;
        } else {
            current = next;
        }
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : ['لا يوجد'];
}

function buildDetailEmbeds(title, lines, thumbnail) {
    const safeLines = Array.isArray(lines) ? lines : [];
    const chunks = [];
    for (let index = 0; index < safeLines.length; index += 20) {
        chunks.push(...chunkLines(safeLines.slice(index, index + 20), 3800));
    }
    if (chunks.length === 0) chunks.push('لا يوجد');
    return chunks.map((chunk, index) => colorManager.createEmbed()
        .setTitle(chunks.length > 1 ? `${title} (${index + 1}/${chunks.length})` : title)
        .setDescription(chunk || 'لا يوجد')
        .setThumbnail(thumbnail)
        .setTimestamp());
}

function formatFailureReason(error) {
    if (!error) return 'سبب غير معروف.';
    const message = typeof error === 'string' ? error : error.message || 'سبب غير معروف.';
    return message.toString().slice(0, 200);
}

function isRetryableDiscordError(error) {
    const code = Number(error?.code);
    const status = Number(error?.status || error?.httpStatus);
    return code === 429 || status === 429 || (status >= 500 && status <= 599)
        || ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN'].includes(error?.code);
}

function getRetryDelay(error, attempt) {
    const retryAfter = Number(error?.retryAfter || 0)
        || (Number(error?.data?.retry_after || 0) * 1000);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return Math.min(10_000, Math.max(250, retryAfter));
    }
    return Math.min(5_000, 500 * (2 ** attempt) + Math.floor(Math.random() * 250));
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function removeRolesWithRetry(member, roles, reason, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
            await member.roles.remove(roles, reason);
            return { success: true, retried: attempt > 0, attempts: attempt + 1 };
        } catch (error) {
            if (!isRetryableDiscordError(error) || attempt >= maxRetries) {
                return { success: false, retried: attempt > 0, attempts: attempt + 1, error };
            }
            await wait(getRetryDelay(error, attempt));
        }
    }
    return { success: false, retried: true, attempts: maxRetries + 1, error: new Error('انتهت محاولات الحذف.') };
}

function formatRoleMentions(roleIds, guild) {
    if (!Array.isArray(roleIds) || roleIds.length === 0) {
        return 'لا يوجد';
    }
    return roleIds.map((roleId) => {
        const role = guild.roles.cache.get(roleId);
        return role ? `<@&${roleId}> (${role.name})` : roleId;
    }).join('، ');
}

function buildRoleFields(roleIds, guild, fieldName = 'Roles') {
    const roleMentions = formatRoleMentions(roleIds, guild);
    const chunks = chunkLines(roleMentions === 'لا يوجد' ? [] : roleMentions.split('، '), 950);
    return chunks.map((chunk, index) => ({
        name: chunks.length > 1 ? `${fieldName} (${index + 1}/${chunks.length})` : fieldName,
        value: chunk,
        inline: false
    }));
}

function removeMembersFromResponsibilities(memberIds = []) {
    if (!Array.isArray(memberIds) || memberIds.length === 0) {
        return { changed: false, removedEntries: [] };
    }

    try {
        if (!fs.existsSync(responsibilitiesPath)) {
            return { changed: false, removedEntries: [] };
        }

        const responsibilitiesData = JSON.parse(fs.readFileSync(responsibilitiesPath, 'utf8'));
        const targetIds = new Set(memberIds);
        const removedEntries = [];
        const removedMembers = {};
        let changed = false;

        for (const [respName, respData] of Object.entries(responsibilitiesData)) {
            if (!respData || !Array.isArray(respData.responsibles) || respData.responsibles.length === 0) {
                continue;
            }

            const beforeCount = respData.responsibles.length;
            const removedIds = respData.responsibles.filter((id) => targetIds.has(id));
            respData.responsibles = respData.responsibles.filter((id) => !targetIds.has(id));

            if (respData.responsibles.length !== beforeCount) {
                changed = true;
                for (const memberId of removedIds) {
                    if (!removedMembers[memberId]) removedMembers[memberId] = [];
                    removedMembers[memberId].push(respName);
                }
                removedEntries.push({
                    name: respName,
                    count: beforeCount - respData.responsibles.length
                });
            }
        }

        if (changed) {
            writeJsonAtomically(responsibilitiesPath, responsibilitiesData);
            global.responsibilities = responsibilitiesData;
        }

        return { changed, removedEntries, removedMembers };
    } catch (error) {
        console.error('Error while removing members from responsibilities:', error);
        return { changed: false, removedEntries: [] };
    }
}

function restoreMembersToResponsibilities(removedMembers = {}) {
    try {
        if (!removedMembers || typeof removedMembers !== 'object' || !fs.existsSync(responsibilitiesPath)) {
            return { restored: 0, failed: [] };
        }

        const data = JSON.parse(fs.readFileSync(responsibilitiesPath, 'utf8'));
        let restored = 0;
        const failed = [];
        for (const [memberId, names] of Object.entries(removedMembers)) {
            for (const name of Array.isArray(names) ? names : []) {
                const responsibility = data[name];
                if (!responsibility || !Array.isArray(responsibility.responsibles)) {
                    failed.push({ memberId, reason: `المسؤولية غير موجودة: ${name}` });
                    continue;
                }
                if (!responsibility.responsibles.includes(memberId)) {
                    responsibility.responsibles.push(memberId);
                    restored += 1;
                }
            }
        }

        if (restored > 0) {
            writeJsonAtomically(responsibilitiesPath, data);
            global.responsibilities = data;
        }
        return { restored, failed };
    } catch (error) {
        console.error('Error restoring responsibilities after tasfiyah undo:', error);
        return { restored: 0, failed: [{ memberId: null, reason: 'تعذر تحديث ملف المسؤوليات.' }] };
    }
}

async function handleUndoInteraction(interaction, client) {
    if (!interaction?.isButton?.() || !interaction.customId?.startsWith('tasfiyah_undo_')) return false;
    const data = readUndoOperations();
    const operation = data[interaction.guildId];
    const operationId = interaction.customId.replace('tasfiyah_undo_', '');
    const activeOperation = activeUndoOperations.get(interaction.guildId);
    if (activeOperation?.message?.id === operationId) return false;
    if (!operation || operation.messageId !== operationId || operation.status !== 'active') {
        await interaction.reply({ content: '**انتهت صلاحية عملية التراجع أو تم استخدامها.**', ephemeral: true }).catch(() => {});
        return true;
    }
    if (Number(operation.expiresAt) <= Date.now()) {
        updatePersistedUndo(interaction.guildId, { status: 'expired', updatedAt: Date.now() });
        await interaction.reply({ content: '**انتهت صلاحية عملية التراجع.**', ephemeral: true }).catch(() => {});
        return true;
    }
    if (interaction.user.id !== operation.executorId) {
        await interaction.reply({ content: '**هذا الزر متاح لمنفذ التصفية فقط.**', ephemeral: true }).catch(() => {});
        return true;
    }

    updatePersistedUndo(interaction.guildId, { status: 'used', updatedAt: Date.now() });
    await interaction.deferUpdate().catch(() => {});
    const undoResult = await undoRemovedRoles(
        interaction.guild,
        operation.removedRoleEntries || [],
        operation.removedMembers || {},
        client
    );
    const failedCount = undoResult.failed.length + (undoResult.responsibilityResult?.failed?.length || 0);
    const undoEmbed = colorManager.createEmbed()
        .setTitle(failedCount === 0 ? '↩️ **تم التراجع**' : '⚠️ **تم التراجع جزئيًا**')
        .setDescription('تمت محاولة استعادة بيانات عملية التصفية المحفوظة.')
        .addFields(
            { name: '**أعضاء تمت إعادتهم**', value: `**${undoResult.success}**`, inline: true },
            { name: '**مسؤوليات تمت إعادتها**', value: `**${undoResult.responsibilityResult?.restored || 0}**`, inline: true },
            { name: '**تعذر إرجاعهم**', value: `**${failedCount}**`, inline: true }
        )
        .setTimestamp();
    await safeEditMessage(interaction.message, { embeds: [undoEmbed], components: [] });
    updatePersistedUndo(interaction.guildId, { status: 'completed', updatedAt: Date.now() });
    return true;
}

module.exports = {
    name,
    description: 'تصفية الرولات التفاعلية حسب النشاط الشهري',
    handleUndoInteraction,
    async execute(message, args, { client }) {
        if (isChannelBlocked(message.channel.id)) {
            return;
        }

        if (isUserBlocked(message.author.id)) {
            const blockedEmbed = colorManager.createEmbed()
                .setDescription('**🚫 أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')
                .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

            await message.channel.send({ embeds: [blockedEmbed] });
            return;
        }

        const isAdminMode = args?.[0]?.toLowerCase() === 'admin';
        if (isAdminMode) {
            const adminSettings = loadAdminApplicationSettings();
            const promoteSettings = promoteManager.getSettings();
            const adminLogChannelId = adminSettings?.requestChannel
                || adminSettings?.settings?.requestChannel
                || promoteSettings?.logChannel
                || null;
            const adminRoles = promoteManager.getAdminRoles()
                .filter((roleId) => message.guild.roles.cache.has(roleId));

            if (!canUseAdminFilter(message.member, adminSettings)) {
                await message.reply('**❌ لا تملك صلاحية لاستخدام تصفية الإدارة.**');
                return;
            }

            if (adminRoles.length === 0) {
                await message.reply('**❌ لا توجد رولات إدارية محددة في Adminroles.**');
                return;
            }

            const missingPermissions = await validateTasfiyahPermissions(message, adminLogChannelId);
            if (missingPermissions.length > 0) {
                await message.reply(`**❌ لا يمكن بدء التصفية. الصلاحيات/المتطلبات الناقصة:**\n${missingPermissions.map((item) => `• ${item}`).join('\n')}`);
                return;
            }

            const releaseLock = acquireTasfiyahLock(message.guild.id);
            if (!releaseLock) {
                await message.reply('**⏳ توجد تصفية قيد التنفيذ على هذا السيرفر. انتظر حتى تنتهي.**');
                return;
            }
            invalidateUndoOperation(message.guild.id);
            await startAdminTypeSelection(message, client, adminRoles, releaseLock);
            return;
        }

        const settings = loadSettings();
        if (!hasPermission(message.member, settings)) {
            await message.reply('**❌ لا تملك صلاحية لاستخدام هذا الأمر.**');
            return;
        }
        const interactiveRoleIds = Array.isArray(settings.settings.interactiveRoles)
            ? settings.settings.interactiveRoles.filter((roleId) => message.guild.roles.cache.has(roleId))
            : [];

        if (interactiveRoleIds.length === 0) {
            await message.reply('**❌ لا توجد رولات تفاعلية محددة في setactive.**');
            return;
        }

        const missingPermissions = await validateTasfiyahPermissions(message, settings?.settings?.requestChannel || null);
        if (missingPermissions.length > 0) {
            await message.reply(`**❌ لا يمكن بدء التصفية. الصلاحيات/المتطلبات الناقصة:**\n${missingPermissions.map((item) => `• ${item}`).join('\n')}`);
            return;
        }

        const releaseLock = acquireTasfiyahLock(message.guild.id);
        if (!releaseLock) {
            await message.reply('**⏳ توجد تصفية قيد التنفيذ على هذا السيرفر. انتظر حتى تنتهي.**');
            return;
        }
        invalidateUndoOperation(message.guild.id);
        await startRoleSelection(message, client, interactiveRoleIds, settings, {
            logChannelId: settings?.settings?.requestChannel,
            resultTitle: 'Active roles',
            dmDetailsText: 'تم تصفيتك وازاله رولك التفاعلي.',
            releaseLock
        });
    }
};

async function startAdminTypeSelection(message, client, adminRoleIds, releaseLock) {
    const typeEmbed = colorManager.createEmbed()
        .setTitle('تصفيه الإدارة')
        .setDescription('**اختار نوع الرتب الادارية للتصفية (حرف أو ظواهر).**')
        .setThumbnail(message.guild.iconURL({ dynamic: true }))
        .setTimestamp();

    const typeMenu = new StringSelectMenuBuilder()
        .setCustomId('tasfiyah_admin_select_type')
        .setPlaceholder('اختر النوع...')
        .setMinValues(1)
        .setMaxValues(2)
        .addOptions([
            { label: 'رتب الحرف (Rank)', value: 'rank', description: 'التعامل مع رولات (A , B , C ...)' },
            { label: 'رتب ظاهرية (Visual)', value: 'visual', description: 'التعامل مع رولات الأسماء والظواهر' }
        ]);

    const sentMessage = await message.channel.send({
        embeds: [typeEmbed],
        components: [new ActionRowBuilder().addComponents(typeMenu)]
    });

    const filter = (interaction) => interaction.user.id === message.author.id && interaction.message.id === sentMessage.id;
    const collector = sentMessage.createMessageComponentCollector({ filter, time: 5 * 60 * 1000 });

    collector.on('collect', async (interaction) => {
        try {
            if (interaction.customId !== 'tasfiyah_admin_select_type') return;

            const selectedTypes = interaction.values;
            const selectedBothTypes = selectedTypes.includes('rank') && selectedTypes.includes('visual');
            const filteredAdminRoles = adminRoleIds.filter((roleId) => {
                const role = message.guild.roles.cache.get(roleId);
                if (!role) return false;
                if (selectedBothTypes) return true;
                const isRankType = selectedTypes.includes('rank');
                return (role.name.length <= 3) === isRankType;
            });

            if (filteredAdminRoles.length === 0) {
                await interaction.update({
                    content: '**❌ لا توجد رولات إدارية مطابقة لهذا النوع.**',
                    embeds: [],
                    components: []
                });
                collector.stop('empty');
                return;
            }

            collector.stop('selected');
            await interaction.update({ content: '**⏳ انتظر للمعالجة...**', embeds: [], components: [] });
            const promoteSettings = promoteManager.getSettings();

            if (selectedBothTypes) {
                const removableAdminRoleIds = await getRemovableRoleIds(message.guild, adminRoleIds);
                if (removableAdminRoleIds.length === 0) {
                    await safeEditMessage(sentMessage, {
                        content: '**❌ لا توجد رولات إدارية قابلة للإزالة من رتبة البوت.**',
                        embeds: [],
                        components: []
                    });
                    releaseLock?.();
                    return;
                }

                await startMemberSelection(sentMessage, message, client, removableAdminRoleIds, {
                    logChannelId: promoteSettings?.logChannel,
                    logTitle: 'Admin filter log',
                    removeAllAdminRoles: true,
                    removeResponsibilitiesOnSuccess: true,
                    allAdminRoleIds: removableAdminRoleIds,
                    resultTitle: 'Admin roles',
                    dmDetailsText: 'تم تصفيتك وازاله رولك الاداري.',
                    releaseLock
                });
                return;
            }

            await startRoleSelection(message, client, filteredAdminRoles, null, {
                title: 'Admin Roles',
                description: '**اختر الرولات الادارية التي تريد تصفيتها **',
                logChannelId: promoteSettings?.logChannel,
                logTitle: 'Admin filter log',
                removeAllAdminRoles: false,
                allAdminRoleIds: adminRoleIds,
                resultTitle: 'Admin roles',
                dmDetailsText: 'تم تصفيتك وازاله رولك الاداري.',
                releaseLock
            });
        } catch (error) {
            console.error('Error in tasfiyah admin type collector:', error);
        }
    });

    collector.on('end', async (_, reason) => {
        if (reason === 'selected') return;
        releaseLock?.();
        safeEditMessage(sentMessage, { components: [] }).catch(() => {});
    });
}

async function startRoleSelection(message, client, roleIds, settings, options = {}) {
    const removableRoleIds = await getRemovableRoleIds(message.guild, roleIds);
    if (removableRoleIds.length === 0) {
        await message.reply('**❌ لا توجد رولات قابلة للإزالة من رتبة البوت.**');
        options.releaseLock?.();
        return;
    }

    const rolePages = chunkArray(removableRoleIds, 25);
    let currentRolePage = 0;
    const selectedRolesByPage = new Map();
    const {
        title = 'Active Roles',
        description = '**اختر الرولات التفاعلية التي تريد تصفيتها **',
        logChannelId = settings?.settings?.requestChannel || null,
        logTitle = ' Active log',
        removeAllAdminRoles = false,
        allAdminRoleIds = null,
        releaseLock = null
    } = options;

    const buildRoleSelectionEmbed = () => {
        const selectedRoleIds = Array.from(selectedRolesByPage.values())
            .flatMap((set) => Array.from(set));
        const selectedMentions = selectedRoleIds.length > 0
            ? selectedRoleIds.map((id) => `<@&${id}>`).join('، ')
            : 'لا يوجد';

        return colorManager.createEmbed()
            .setTitle(title)
            .setDescription(description)
            .setThumbnail(message.guild.iconURL({ dynamic: true }))
            .addFields(
                { name: '**الرولات المختارة**', value: selectedMentions, inline: false },
                { name: '**الصفحة**', value: `**${currentRolePage + 1} / ${rolePages.length}**`, inline: true },
            )
            .setTimestamp();
    };

    const buildRoleMenu = () => {
        const roleOptions = rolePages[currentRolePage].map((roleId) => {
            const role = message.guild.roles.cache.get(roleId);
            const pageSelected = selectedRolesByPage.get(currentRolePage) || new Set();
            return {
                label: role ? role.name.slice(0, 100) : roleId,
                value: roleId,
                description: role ? `ID: ${roleId}` : 'Role not found',
                default: pageSelected.has(roleId)
            };
        });

        return new StringSelectMenuBuilder()
            .setCustomId('tasfiyah_roles_select')
            .setPlaceholder('اختر الرولات...')
            .setMinValues(0)
            .setMaxValues(roleOptions.length || 1)
            .addOptions(roleOptions);
    };

    const buildRoleButtons = () => {
        const prevButton = new ButtonBuilder()
            .setCustomId('tasfiyah_roles_prev')
            .setEmoji('<:emoji_13:1429263136136888501>')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentRolePage === 0);

        const nextButton = new ButtonBuilder()
            .setCustomId('tasfiyah_roles_next')
            .setEmoji('<:emoji_14:1429263186539974708>')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentRolePage >= rolePages.length - 1);

        const confirmButton = new ButtonBuilder()
            .setCustomId('tasfiyah_roles_confirm')
            .setLabel('Done')
            .setEmoji('<:emoji_7:1465221394966253768>')
            .setStyle(ButtonStyle.Primary);

        const cancelButton = new ButtonBuilder()
            .setCustomId('tasfiyah_roles_cancel')
            .setLabel('Cancel')
            .setEmoji('<:emoji_7:1465221361839505622>')
            .setStyle(ButtonStyle.Danger);

        return new ActionRowBuilder().addComponents(prevButton, nextButton, confirmButton, cancelButton);
    };

    const roleMenuRow = new ActionRowBuilder().addComponents(buildRoleMenu());
    const roleButtonsRow = buildRoleButtons();

    const sentMessage = await message.channel.send({
        embeds: [buildRoleSelectionEmbed()],
        components: [roleMenuRow, roleButtonsRow]
    });

    const filter = (interaction) => interaction.user.id === message.author.id && interaction.message.id === sentMessage.id;
    const collector = sentMessage.createMessageComponentCollector({ filter, time: 10 * 60 * 1000 });

    collector.on('collect', async (interaction) => {
        try {
            if (interaction.customId === 'tasfiyah_roles_select') {
                selectedRolesByPage.set(currentRolePage, new Set(interaction.values));
            } else if (interaction.customId === 'tasfiyah_roles_prev' && currentRolePage > 0) {
                currentRolePage -= 1;
            } else if (interaction.customId === 'tasfiyah_roles_next' && currentRolePage < rolePages.length - 1) {
                currentRolePage += 1;
            } else if (interaction.customId === 'tasfiyah_roles_cancel') {
                collector.stop('cancelled');
                await interaction.update({ content: '**تم إلغاء العملية.**', embeds: [], components: [] });
                return;
            } else if (interaction.customId === 'tasfiyah_roles_confirm') {
                const selectedRoleIds = Array.from(selectedRolesByPage.values())
                    .flatMap((set) => Array.from(set));

                if (selectedRoleIds.length === 0) {
                    await interaction.reply({ content: '**❌ يجب اختيار رول واحد على الأقل.**', ephemeral: true });
                    return;
                }

                collector.stop('confirmed');
                await interaction.update({ content: '**⏳ انتظر للمعالجة...**', embeds: [], components: [] });
                await startMemberSelection(sentMessage, message, client, selectedRoleIds, {
                    logChannelId,
                    logTitle,
                    removeAllAdminRoles,
                    allAdminRoleIds,
                    releaseLock
                });
                return;
            }

            collector.resetTimer();
            const updatedMenuRow = new ActionRowBuilder().addComponents(buildRoleMenu());
            const updatedButtonsRow = buildRoleButtons();
            await interaction.update({
                embeds: [buildRoleSelectionEmbed()],
                components: [updatedMenuRow, updatedButtonsRow]
            });
        } catch (error) {
            console.error('Error in tasfiyah role collector:', error);
        }
    });

    collector.on('end', async (_, reason) => {
        if (reason === 'confirmed') return;
        releaseLock?.();
        safeEditMessage(sentMessage, { components: [] }).catch(() => {});
    });
}

async function startMemberSelection(sentMessage, message, client, selectedRoleIds, options = {}) {
    const dbManager = getDatabase();
    const releaseLock = options.releaseLock;
    if (!dbManager || !dbManager.isInitialized) {
        await safeEditMessage(sentMessage, { content: '**❌ قاعدة البيانات غير متاحة.**', embeds: [], components: [] });
        releaseLock?.();
        return;
    }

    // إعادة التحقق لحماية العملية من تغيّر الرتب أثناء التفاعل مع القوائم.
    const removableRoleIds = await getRemovableRoleIds(message.guild, selectedRoleIds);
    if (removableRoleIds.length === 0) {
        await safeEditMessage(sentMessage, {
            content: '**❌ لم تعد الرولات المحددة قابلة للإزالة من رتبة البوت.**',
            embeds: [],
            components: []
        });
        releaseLock?.();
        return;
    }
    selectedRoleIds = removableRoleIds;

    const loadingEmbed = colorManager.createEmbed()
        .setTitle('⏳ **تجهيز بيانات التفاعل**')
        .setDescription('**جاري جمع بيانات الأعضاء، الرجاء الانتظار...**')
        .setThumbnail(message.guild.iconURL({ dynamic: true }))
        .setTimestamp();

    await safeEditMessage(sentMessage, { content: null, embeds: [loadingEmbed], components: [] });

    let membersMap;
    try {
        membersMap = await collectMembersForRoles(message.guild, selectedRoleIds);
    } catch (error) {
        console.error('Error collecting tasfiyah members:', error);
        await safeEditMessage(sentMessage, {
            content: '**❌ تعذر جلب أعضاء الرولات بشكل موثوق. حاول مرة أخرى.**',
            embeds: [],
            components: []
        });
        releaseLock?.();
        return;
    }

    const members = Array.from(membersMap.values());
    if (members.length === 0) {
        await safeEditMessage(sentMessage, { content: '**❌ لا يوجد أعضاء بهذه الرولات.**', embeds: [], components: [] });
        releaseLock?.();
        return;
    }

    const now = moment().tz('Asia/Riyadh');
    const monthStart = now.clone().startOf('month').valueOf();

    let roleGrantHistory = {};
    try {
        if (fs.existsSync(roleGrantHistoryPath)) {
            roleGrantHistory = JSON.parse(fs.readFileSync(roleGrantHistoryPath, 'utf8'));
        }
    } catch (historyError) {
        console.error('Error reading role grant history once in tasfiyah:', historyError);
    }

    const concurrencyLimit = members.length >= 200 ? 20 : members.length >= 80 ? 15 : 10;
    const auditGrantCache = await buildAuditGrantCache(
        message.guild,
        selectedRoleIds,
        members.map((member) => member.id),
        members.length <= 100 ? 4 : members.length <= 500 ? 8 : 12
    );

    let processed = 0;
    const startedAt = Date.now();
    const memberStats = await mapWithConcurrency(members, concurrencyLimit, async (member) => {
        const stats = await dbManager.getMonthlyStats(member.id, message.guild.id);
        const liveDuration = getLiveVoiceDuration(member.id, monthStart);
        const storedVoiceTime = Number(stats?.voiceTime);
        const storedMessages = Number(stats?.messages);
        const safeStoredVoiceTime = Number.isFinite(storedVoiceTime) && storedVoiceTime > 0
            ? Math.min(storedVoiceTime, Date.now() - monthStart)
            : 0;
        const safeMessages = Number.isFinite(storedMessages) && storedMessages > 0
            ? Math.floor(Math.min(storedMessages, 10_000_000))
            : 0;
        const voiceTime = safeStoredVoiceTime + liveDuration;
        const messages = safeMessages;
        processed += 1;

        if (processed % 15 === 0 || processed === members.length) {
            const elapsed = Date.now() - startedAt;
            const avgPerItem = elapsed / processed;
            const remaining = Math.max(0, members.length - processed);
            const eta = avgPerItem * remaining;
            const bar = buildProgressBar(processed, members.length, 14);
            const progressEmbed = colorManager.createEmbed()
                .setTitle('⏳ **تجهيز بيانات التفاعل**')
                .setDescription(`**تمت معالجة ${processed} / ${members.length} عضو (${formatPercent(processed, members.length)})**\n${bar}\n**⏱️ الوقت المتبقي :** ${formatEta(eta)}`)
                .setThumbnail(message.guild.iconURL({ dynamic: true }))
                .setTimestamp();
            safeEditMessage(sentMessage, { embeds: [progressEmbed] }).catch(() => {});
        }

        return {
            member,
            voiceTime,
            messages,
            score: Math.floor(voiceTime / 60000) + messages,
            roleAgeText: await getMemberRoleAgeText(message.guild, member.id, selectedRoleIds, auditGrantCache, roleGrantHistory)
        };
    });

    const cleanedStats = memberStats.filter((stat) => stat && stat.member);
    const memberSnapshot = new Map(cleanedStats.map((stat) => [stat.member.id, stat.member]));
    cleanedStats.sort((a, b) => b.score - a.score);

    if (cleanedStats.length === 0) {
        await safeEditMessage(sentMessage, { content: '**❌ لا يوجد نشاط لهذا الرول.**', embeds: [], components: [] });
        releaseLock?.();
        return;
    }

    const pageSize = 10;
    const totalPages = Math.ceil(cleanedStats.length / pageSize);
    let currentPage = 0;
    const selectedMembersByPage = new Map();

    const buildMembersEmbed = () => {
        const start = currentPage * pageSize;
        const pageData = cleanedStats.slice(start, start + pageSize);
        const description = pageData.map((stat, idx) => {
            const rank = start + idx + 1;
            const voiceTimeFormatted = formatDuration(stat.voiceTime);
            return `**#${rank}** - <@${stat.member.id}> **[\`${stat.roleAgeText}\`]**\n**<:emoji_85:1442986413510627530> :** ${voiceTimeFormatted} | **<:emoji_85:1442986444712054954> :** **${stat.messages}**`;
        }).join('\n\n');

        const selectedCount = Array.from(selectedMembersByPage.values())
            .reduce((count, set) => count + set.size, 0);
        const selectedIds = new Set(
            Array.from(selectedMembersByPage.values()).flatMap((set) => Array.from(set))
        );
        const selectedNames = cleanedStats
            .filter((stat) => selectedIds.has(stat.member.id))
            .map((stat) => `<@${stat.member.id}>`);
        const selectedPreview = selectedNames.length > 0
            ? `${selectedNames.slice(0, 20).join('، ')}${selectedNames.length > 20 ? ` … و${selectedNames.length - 20} آخرين` : ''}`
            : '**لا يوجد**';

        return colorManager.createEmbed()
            .setTitle('Active roles')
            .setDescription(description || '**لا يوجد بيانات**')
            .setThumbnail(message.guild.iconURL({ dynamic: true }))
            .addFields(
                { name: '**المختارون للتصفية**', value: `**${selectedCount}**`, inline: true },
                { name: '**الصفحة**', value: `**${currentPage + 1} / ${totalPages}**`, inline: true },
                { name: '**المحددون حاليًا**', value: selectedPreview, inline: false },
                { name: '**أساس "الأقل نشاط"**', value: '**يحدد أقل 20% من نشاط المجموعة تلقائيًا، مع حماية من لديه نشاط قوي في الفويس أو الشات.**', inline: false },
                { name: '**تنبيه**', value: '**التحديد والاختيار الذكي يشملان جميع الصفحات، ويمكنك مراجعة القائمة هنا دون التنقل بينها.**', inline: false }
            )
            .setTimestamp();
    };

    const buildMembersMenu = () => {
        const start = currentPage * pageSize;
        const pageData = cleanedStats.slice(start, start + pageSize);
        const pageSelected = selectedMembersByPage.get(currentPage) || new Set();
        const options = pageData.map((stat) => ({
            label: stat.member.displayName.slice(0, 100),
            value: stat.member.id,
            description: `فويس ${formatShortDuration(stat.voiceTime)} • شات ${stat.messages}`.slice(0, 100),
            default: pageSelected.has(stat.member.id)
        }));

        return new StringSelectMenuBuilder()
            .setCustomId('tasfiyah_members_select')
            .setPlaceholder('اختر الأعضاء للتصفية...')
            .setMinValues(0)
            .setMaxValues(options.length || 1)
            .addOptions(options);
    };

    const buildMembersButtons = () => {
        const selectAllButton = new ButtonBuilder()
            .setCustomId('tasfiyah_members_select_all')
            .setLabel('تحديد الكل')
            .setStyle(ButtonStyle.Secondary);

        const clearAllButton = new ButtonBuilder()
            .setCustomId('tasfiyah_members_clear_all')
            .setLabel('إزالة الكل')
            .setStyle(ButtonStyle.Secondary);

        const selectLowestButton = new ButtonBuilder()
            .setCustomId('tasfiyah_members_select_lowest')
            .setLabel('الأقل نشاط')
            .setStyle(ButtonStyle.Secondary);

        const prevButton = new ButtonBuilder()
            .setCustomId('tasfiyah_members_prev')
               .setEmoji('<:emoji_13:1429263136136888501>')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage === 0);

        const nextButton = new ButtonBuilder()
            .setCustomId('tasfiyah_members_next')
                 .setEmoji('<:emoji_14:1429263186539974708>')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage >= totalPages - 1);

        const applyButton = new ButtonBuilder()
            .setCustomId('tasfiyah_members_apply')
            .setLabel('Confirm')
             .setEmoji('<:emoji_7:1465221394966253768>')
            .setStyle(ButtonStyle.Success);

        const cancelButton = new ButtonBuilder()
            .setCustomId('tasfiyah_members_cancel')
            .setLabel('Cancel')
              .setEmoji('<:emoji_7:1465221361839505622>')
            .setStyle(ButtonStyle.Danger);

        return [
            new ActionRowBuilder().addComponents(selectAllButton, clearAllButton, selectLowestButton),
            new ActionRowBuilder().addComponents(prevButton, nextButton, applyButton, cancelButton)
        ];
    };

    await safeEditMessage(sentMessage, {
        embeds: [buildMembersEmbed()],
        components: [new ActionRowBuilder().addComponents(buildMembersMenu()), ...buildMembersButtons()]
    });

    const filter = (interaction) => interaction.user.id === message.author.id && interaction.message.id === sentMessage.id;
    const collector = sentMessage.createMessageComponentCollector({ filter, time: 10 * 60 * 1000 });

    collector.on('collect', async (interaction) => {
        try {
            if (interaction.customId === 'tasfiyah_members_select') {
                selectedMembersByPage.set(currentPage, new Set(interaction.values));
            } else if (interaction.customId === 'tasfiyah_members_select_all') {
                const start = currentPage * pageSize;
                const pageData = cleanedStats.slice(start, start + pageSize);
                selectedMembersByPage.set(currentPage, new Set(pageData.map((stat) => stat.member.id)));
            } else if (interaction.customId === 'tasfiyah_members_clear_all') {
                selectedMembersByPage.set(currentPage, new Set());
            } else if (interaction.customId === 'tasfiyah_members_select_lowest') {
                const smartLowestIds = getSmartLowestMemberIds(cleanedStats);
                selectedMembersByPage.clear();
                for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
                    const start = pageIndex * pageSize;
                    const pageData = cleanedStats.slice(start, start + pageSize);
                    selectedMembersByPage.set(
                        pageIndex,
                        new Set(pageData
                            .filter((stat) => smartLowestIds.has(stat.member.id))
                            .map((stat) => stat.member.id))
                    );
                }
            } else if (interaction.customId === 'tasfiyah_members_prev' && currentPage > 0) {
                currentPage -= 1;
            } else if (interaction.customId === 'tasfiyah_members_next' && currentPage < totalPages - 1) {
                currentPage += 1;
            } else if (interaction.customId === 'tasfiyah_members_cancel') {
                collector.stop('cancelled');
                await interaction.update({ content: '**تم إلغاء العملية.**', embeds: [], components: [] });
                return;
            } else if (interaction.customId === 'tasfiyah_members_apply') {
                const selectedMemberIds = Array.from(selectedMembersByPage.values())
                    .flatMap((set) => Array.from(set));

                if (selectedMemberIds.length === 0) {
                    await interaction.reply({ content: '**❌ يجب اختيار عضو واحد على الأقل.**', ephemeral: true });
                    return;
                }

                collector.stop('apply');
                await interaction.update({ content: '**⏳ جاري تنفيذ التصفية...**', embeds: [], components: [] });
                await applyRoleRemoval(sentMessage, message, client, selectedMemberIds, selectedRoleIds, {
                    ...options,
                    memberSnapshot
                });
                return;
            }

            collector.resetTimer();
            await interaction.update({
                embeds: [buildMembersEmbed()],
                components: [new ActionRowBuilder().addComponents(buildMembersMenu()), ...buildMembersButtons()]
            });
        } catch (error) {
            console.error('Error in tasfiyah members collector:', error);
        }
    });

    collector.on('end', async (_, reason) => {
        if (reason === 'apply') return;
        releaseLock?.();
        safeEditMessage(sentMessage, { components: [] }).catch(() => {});
    });
}

async function applyRoleRemoval(sentMessage, message, client, selectedMemberIds, selectedRoleIds, options = {}) {
    try {
        return await applyRoleRemovalInternal(sentMessage, message, client, selectedMemberIds, selectedRoleIds, options);
    } catch (error) {
        console.error('Tasfiyah fatal execution error:', error);
        invalidateUndoOperation(message.guild.id);
        await safeEditMessage(sentMessage, {
            content: '**❌ توقفت التصفية بسبب خطأ غير متوقع. تم تحرير القفل ويمكن المحاولة مرة أخرى.**',
            embeds: [],
            components: []
        }).catch(() => {});
        return { success: false, error };
    } finally {
        options.releaseLock?.();
    }
}

async function applyRoleRemovalInternal(sentMessage, message, client, selectedMemberIds, selectedRoleIds, options = {}) {
    const totalMembers = new Set(selectedMemberIds).size;
    selectedMemberIds = [...new Set(selectedMemberIds)];
    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    let departedCount = 0;
    let retriedSuccessCount = 0;
    let dmSentCount = 0;
    let dmFailedCount = 0;
    const successMemberIds = [];
    const removedRoleEntries = [];
    let removedMembersForUndo = {};
    const failedMembers = [];
    const skippedMembers = [];
    const departedMembers = [];
    const executor = message.member;
    const isGuildOwner = message.guild.ownerId === message.author.id;
    const botMember = message.guild.members.me || await message.guild.members.fetchMe().catch(() => null);
    const botHighestPosition = botMember?.roles?.highest?.position ?? -1;
    const logChannelId = options.logChannelId || null;
    const logTitle = options.logTitle || ' Active log';
    const removeAllAdminRoles = options.removeAllAdminRoles || false;
    const removeResponsibilitiesOnSuccess = options.removeResponsibilitiesOnSuccess || false;
    const allAdminRoleIds = Array.isArray(options.allAdminRoleIds) ? options.allAdminRoleIds : [];
    const resultTitle = options.resultTitle || 'Active roles';
    const dmDetailsText = options.dmDetailsText || 'تم تصفيتك وازاله رولك التفاعلي.';
    const releaseLock = options.releaseLock;
    const memberSnapshot = options.memberSnapshot instanceof Map ? options.memberSnapshot : new Map();
    const resultStore = [];

    const concurrencyLimit = totalMembers <= 10
        ? 2
        : totalMembers <= 30
            ? 4
            : totalMembers <= 80
                ? 6
                : totalMembers <= 150
                    ? 8
                    : 10;

    const progressEmbed = colorManager.createEmbed()
        .setTitle('🧹 **بدء تنفيذ التصفية**')
        .setDescription(
            `**المحددون:** ${totalMembers}\n` +
            '**تمت المعالجة:** 0 / ' + totalMembers + ' (0%)\n' +
            '**نجاح:** 0 | **نجح بعد إعادة المحاولة:** 0 | **فشل تقني:** 0 | **غادروا:** 0 | **تجاوز:** 0\n' +
            `**التوازي:** ${concurrencyLimit} أعضاء في نفس الوقت\n` +
            '**الوقت المتوقع:** يتم حسابه بعد بدء المعالجة...'
        )
        .setThumbnail(message.guild.iconURL({ dynamic: true }))
        .setTimestamp();

    await safeEditMessage(sentMessage, { embeds: [progressEmbed], components: [] });

    let processed = 0;
    const startedAt = Date.now();
    let lastProgressUpdate = 0;
    let progressUpdatePromise = Promise.resolve();
    const updateProgress = async (force = false) => {
        releaseLock?.touch?.();
        const now = Date.now();
        if (!force && processed !== totalMembers && processed % 5 !== 0 && now - lastProgressUpdate < 1000) return;
        if (!force && now - lastProgressUpdate < 750) return;
        lastProgressUpdate = now;

        const elapsed = Date.now() - startedAt;
        const avgPerItem = processed > 0 ? elapsed / processed : 0;
        const remaining = Math.max(0, totalMembers - processed);
        const eta = avgPerItem * remaining;
        const liveSuccessCount = resultStore.filter((result) => result?.status === 'success').length;
        const liveRetriedSuccessCount = resultStore.filter((result) => result?.status === 'success' && result.retried).length;
        const liveFailedCount = resultStore.filter((result) => result?.status === 'failed').length;
        const liveSkippedCount = resultStore.filter((result) => result?.status === 'skipped').length;
        const liveDepartedCount = resultStore.filter((result) => result?.status === 'departed').length;
        const bar = buildProgressBar(processed, totalMembers, 14);
        const updateEmbed = colorManager.createEmbed()
            .setTitle(processed >= totalMembers ? '✅ **اكتملت التصفية**' : '🧹 **تنفيذ التصفية**')
            .setDescription(
                `**المحددون:** ${totalMembers}\n` +
                `**تمت المعالجة:** ${processed} / ${totalMembers} (${formatPercent(processed, totalMembers)})\n` +
                `**نجاح:** ${liveSuccessCount} | **بعد Retry:** ${liveRetriedSuccessCount} | **فشل تقني:** ${liveFailedCount} | **غادروا:** ${liveDepartedCount} | **تجاوز:** ${liveSkippedCount}\n` +
                `${bar}\n` +
                `**التوازي:** ${concurrencyLimit} أعضاء في نفس الوقت\n` +
                `**الوقت المتوقع المتبقي:** ${processed > 0 ? formatEta(eta) : 'يتم الحساب...'}\n` +
                `**السرعة:** ${processed > 0 ? `${(processed / Math.max(elapsed / 1000, 1)).toFixed(1)} عضو/ث` : 'يتم الحساب...'}`
            )
            .setThumbnail(message.guild.iconURL({ dynamic: true }))
            .setTimestamp();
        progressUpdatePromise = progressUpdatePromise
            .then(() => safeEditMessage(sentMessage, { embeds: [updateEmbed], components: [] }))
            .catch((error) => console.error('Tasfiyah progress update error:', error));
        await progressUpdatePromise;
    };

    const processMember = async (memberId) => {
        let member;
        try {
            member = memberSnapshot.get(memberId) || await message.guild.members.fetch(memberId);
        } catch (error) {
            if (error?.code === 10007 || error?.code === 10013) {
                return { status: 'departed', memberId, reason: 'غادر العضو السيرفر.' };
            }
            console.error(`Error fetching member ${memberId}:`, error);
            return { status: 'failed', memberId, reason: 'تعذر جلب العضو.' };
        }

        const roleSource = removeAllAdminRoles ? allAdminRoleIds : selectedRoleIds;
        const rolesToRemove = roleSource
            .map((roleId) => message.guild.roles.cache.get(roleId))
            .filter((role) => role
                && !role.managed
                && role.position < botHighestPosition
                && member.roles.cache.has(role.id));

        if (!isGuildOwner && executor && member.roles.highest.comparePositionTo(executor.roles.highest) >= 0) {
            return { status: 'skipped', memberId, reason: 'عضو أعلى أو مساوي لرتبة المنفذ.' };
        }

        if (rolesToRemove.length === 0) {
            return { status: 'skipped', memberId, reason: 'لا يملك الرولات المحددة وقت التنفيذ.' };
        }

        try {
            const removalResult = await removeRolesWithRetry(member, rolesToRemove, 'Tasfiyah roles filter');
            if (!removalResult.success) {
                return { status: 'failed', memberId, reason: formatFailureReason(removalResult.error), retried: removalResult.retried };
            }
            return {
                status: 'success',
                memberId,
                roleIds: rolesToRemove.map((role) => role.id),
                removedAt: Date.now(),
                retried: removalResult.retried,
                member
            };
        } catch (error) {
            console.error(`Error removing roles from ${memberId}:`, error);
            return { status: 'failed', memberId, reason: formatFailureReason(error) };
        }
    };

    await updateProgress(true);
    const orderedMemberTasks = selectedMemberIds.map((memberId, index) => ({ memberId, index }));
    await mapWithConcurrency(orderedMemberTasks, concurrencyLimit, async (task) => {
        const result = await processMember(task.memberId);
        result.order = task.index;
        resultStore[task.index] = result;
        try {
            processed += 1;
            await updateProgress();
        } catch (progressError) {
            console.error('Tasfiyah progress aggregation error:', progressError);
        }
        return result;
    });
    await updateProgress(true);

    for (const result of resultStore) {
        if (!result) continue;
        if (result.status === 'success') {
            successCount += 1;
            if (result.retried) retriedSuccessCount += 1;
            successMemberIds.push(result.memberId);
            removedRoleEntries.push({
                memberId: result.memberId,
                roleIds: result.roleIds,
                removedAt: result.removedAt,
                member: result.member
            });
        } else if (result.status === 'failed') {
            failedCount += 1;
            failedMembers.push({ memberId: result.memberId, reason: result.reason });
        } else if (result.status === 'skipped') {
            skippedCount += 1;
            skippedMembers.push({ memberId: result.memberId, reason: result.reason });
        } else if (result.status === 'departed') {
            departedCount += 1;
            departedMembers.push({ memberId: result.memberId, reason: result.reason });
        }
    }

    const dmConcurrency = removedRoleEntries.length <= 10
        ? 2
        : removedRoleEntries.length <= 50
            ? 4
            : removedRoleEntries.length <= 150
                ? 6
                : 8;
    if (removedRoleEntries.length > 0) {
        const dmEmbedData = colorManager.createEmbed()
            .setTitle(resultTitle)
            .addFields(
                { name: 'Details', value: dmDetailsText, inline: false }
            )
            .setTimestamp();
        await mapWithConcurrency(removedRoleEntries, dmConcurrency, async (entry) => {
            const member = entry.member || await message.guild.members.fetch(entry.memberId).catch(() => null);
            if (!member) {
                dmFailedCount += 1;
                return;
            }
            const dmEmbed = EmbedBuilder.from(dmEmbedData);
            try {
                await member.send({ embeds: [dmEmbed] });
                dmSentCount += 1;
            } catch (error) {
                dmFailedCount += 1;
                console.warn(`Tasfiyah DM failed for ${entry.memberId}:`, error.code || error.message);
            }
        });
    }

    const resultEmbed = colorManager.createEmbed()
        .setTitle('✅ Done')
        .setDescription('**تم الانتهاء من تنفيذ التصفية.**')
        .setThumbnail(message.guild.iconURL({ dynamic: true }))
        .addFields(
            { name: '**المحددون**', value: `**${totalMembers}**`, inline: true },
            { name: '**نجاح**', value: `**${successCount}**`, inline: true },
            { name: '**نجح بعد Retry**', value: `**${retriedSuccessCount}**`, inline: true },
            { name: '**فشل تقني**', value: `**${failedCount}**`, inline: true },
            { name: '**غادروا السيرفر**', value: `**${departedCount}**`, inline: true },
            { name: '**تم تجاوزهم**', value: `**${skippedCount}**`, inline: true },
            { name: '**DM مرسل**', value: `**${dmSentCount}**`, inline: true },
            { name: '**DM فاشل**', value: `**${dmFailedCount}**`, inline: true }
        )
        .setTimestamp();

    if (removeResponsibilitiesOnSuccess && successMemberIds.length > 0) {
        const responsibilityCleanup = removeMembersFromResponsibilities(successMemberIds);

        if (responsibilityCleanup.changed) {
            removedMembersForUndo = responsibilityCleanup.removedMembers || {};
            const removedCount = responsibilityCleanup.removedEntries
                .reduce((sum, entry) => sum + entry.count, 0);
            resultEmbed.addFields({
                name: '**المسؤوليات المزالة تلقائيًا**',
                value: `**${removedCount}**`,
                inline: true
            });

            if (typeof respCommand.updateEmbedMessage === 'function') {
                await respCommand.updateEmbedMessage(client, message.guild.id);
            }
        }
    }

    const thumbnail = message.guild.iconURL({ dynamic: true });
    const undoButton = removedRoleEntries.length > 0
        ? new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`tasfiyah_undo_${sentMessage.id}`)
                .setLabel('تراجع عن التصفية')
                .setStyle(ButtonStyle.Danger)
        )
        : null;
    await safeEditMessage(sentMessage, { embeds: [resultEmbed], components: undoButton ? [undoButton] : [] });

    if (undoButton) {
        const undoCollector = sentMessage.createMessageComponentCollector({
            filter: (interaction) => interaction.customId === `tasfiyah_undo_${sentMessage.id}`
                && interaction.user.id === message.author.id,
            time: 10 * 60 * 1000,
            max: 1
        });
        const undoOperation = registerUndoOperation(message.guild.id, {
            message: sentMessage,
            collector: undoCollector,
            executorId: message.author.id,
            token: sentMessage.id,
            logChannelId,
            removedRoleEntries,
            removedMembers: removedMembersForUndo
        });
        undoCollector.on('collect', async (interaction) => {
            if (activeUndoOperations.get(message.guild.id) !== undoOperation
                || undoOperation.expiresAt <= Date.now()
                || undoOperation.used) {
                await interaction.reply({ content: '**انتهت صلاحية زر التراجع أو تم استبداله.**', ephemeral: true }).catch(() => {});
                return;
            }
            undoOperation.used = true;
            updatePersistedUndo(message.guild.id, { status: 'used', updatedAt: Date.now() });
            await interaction.deferUpdate().catch(() => {});
            const undoResult = await undoRemovedRoles(message.guild, removedRoleEntries, removedMembersForUndo, client);
            const undoHasFailures = undoResult.failed.length > 0
                || (undoResult.responsibilityResult?.failed?.length || 0) > 0;
            const undoEmbed = colorManager.createEmbed()
                .setTitle(!undoHasFailures ? '↩️ **تم التراجع**' : '⚠️ **تم التراجع جزئيًا**')
                .setDescription('تمت محاولة إعادة الرولات التي أزيلت في هذه العملية فقط.')
                .addFields(
                    { name: '**أعضاء تمت إعادتهم**', value: `**${undoResult.success}**`, inline: true },
                    { name: '**تعذر إرجاعهم**', value: `**${undoResult.failed.length}**`, inline: true },
                    { name: '**مسؤوليات تمت إعادتها**', value: `**${undoResult.responsibilityResult?.restored || 0}**`, inline: true }
                )
                .setTimestamp();
            await safeEditMessage(sentMessage, { embeds: [undoEmbed], components: [] }).catch(() => {});
            undoOperation.cleanup();
            const failedResponsibilityLines = (undoResult.responsibilityResult?.failed || [])
                .filter((item) => item.memberId)
                .map((item) => `<@${item.memberId}> — ${item.reason}`);
            if (undoResult.failed.length > 0 || failedResponsibilityLines.length > 0) {
                const failedUndoLines = undoResult.failed
                    .filter((item) => item.memberId)
                    .map((item) => `<@${item.memberId}> — ${item.reason}`)
                    .concat(failedResponsibilityLines);
                const undoLogChannel = logChannelId ? message.guild.channels.cache.get(logChannelId) : null;
                for (const embed of buildDetailEmbeds('⚠️ تعذر التراجع عن بعض الأعضاء', failedUndoLines, thumbnail)) {
                    if (undoLogChannel) await undoLogChannel.send({ embeds: [embed] }).catch(() => {});
                }
            }
        });
        undoCollector.on('end', (_, reason) => {
            if (activeUndoOperations.get(message.guild.id) === undoOperation && reason !== 'limit') {
                undoOperation.cleanup();
            }
            if (reason !== 'limit') safeEditMessage(sentMessage, { components: [] }).catch(() => {});
        });
    }

    const successLines = removedRoleEntries.map((entry) => `<@${entry.memberId}>`);
    const failureLines = failedMembers.map((item) => `<@${item.memberId}> — ${item.reason}`);
    const skippedLines = skippedMembers.map((item) => `<@${item.memberId}> — ${item.reason}`);
    const departedLines = departedMembers.map((item) => `<@${item.memberId}> — ${item.reason}`);
    const detailEmbeds = [];
    if (successLines.length > 0) {
        detailEmbeds.push(...buildDetailEmbeds('✅ الأعضاء الذين تم تصفيتهم', successLines, thumbnail));
    }
    if (failureLines.length > 0) {
        detailEmbeds.push(...buildDetailEmbeds('❌ الأعضاء الذين فشلوا', failureLines, thumbnail));
    }
    if (skippedLines.length > 0) {
        detailEmbeds.push(...buildDetailEmbeds('⏭️ الأعضاء الذين تم تجاوزهم', skippedLines, thumbnail));
    }
    if (departedLines.length > 0) {
        detailEmbeds.push(...buildDetailEmbeds('🚪 أعضاء غادروا السيرفر', departedLines, thumbnail));
    }

    if (logChannelId) {
        const logChannel = message.guild.channels.cache.get(logChannelId);
        if (logChannel) {
            const logEmbed = colorManager.createEmbed()
                .setTitle(logTitle)
                .setThumbnail(message.guild.iconURL({ dynamic: true }))
                .addFields(
                    { name: '**المنفذ**', value: `<@${message.author.id}>`, inline: true },
                    { name: '**عدد الأعضاء**', value: `**${totalMembers}**`, inline: true },
                    { name: '**نجاح**', value: `**${successCount}**`, inline: true },
                    { name: '**نجح بعد Retry**', value: `**${retriedSuccessCount}**`, inline: true },
                    { name: '**فشل تقني**', value: `**${failedCount}**`, inline: true },
                    { name: '**غادروا السيرفر**', value: `**${departedCount}**`, inline: true },
                    { name: '**تجاوز**', value: `**${skippedCount}**`, inline: true },
                    { name: '**DM مرسل**', value: `**${dmSentCount}**`, inline: true },
                    { name: '**DM فاشل**', value: `**${dmFailedCount}**`, inline: true }
                )
                .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] }).catch(() => {});
            for (const embed of detailEmbeds) {
                await logChannel.send({ embeds: [embed] }).catch(() => {});
            }
        }
    }

    releaseLock?.();
}
