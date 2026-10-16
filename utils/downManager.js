const fs = require('fs');
const path = require('path');
const {
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    ThumbnailBuilder,
    SeparatorBuilder,
    MessageFlags
} = require('discord.js');
const colorManager = require('./colorManager');
const ms = require('ms');

// File paths
const downSettingsPath = path.join(__dirname, '..', 'data', 'downSettings.json');
const activeDownsPath = path.join(__dirname, '..', 'data', 'activeDowns.json');
const downLogsPath = path.join(__dirname, '..', 'data', 'downLogs.json');
const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
const leftMembersDownsPath = path.join(__dirname, '..', 'data', 'leftMembersDowns.json');

// Utility functions
function readJson(filePath, defaultValue = {}) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error);
    }
    return defaultValue;
}

// عداد للعمليات المتعلقة بالملفات لتجنب race conditions
const fileLocks = new Map();

function safeStableStringify(value) {
    try {
        return JSON.stringify(value, Object.keys(value || {}).sort());
    } catch (_) {
        return JSON.stringify(value);
    }
}

function writeJson(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // كتابة إلى ملف مؤقت أولاً
        const tempPath = `${filePath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));

        // استبدال الملف الأصلي (atomic operation)
        fs.renameSync(tempPath, filePath);

        return true;
    } catch (error) {
        console.error(`Error writing ${filePath}:`, error);
        return false;
    }
}

function normalizeSettings(settings = {}) {
    const normalized = settings && typeof settings === 'object' ? settings : {};
    if (!normalized.allowedUsers || typeof normalized.allowedUsers !== 'object') {
        normalized.allowedUsers = { type: null, targets: [] };
    }
    if (!Array.isArray(normalized.allowedUsers.targets)) normalized.allowedUsers.targets = [];
    if (typeof normalized.separatorEnabled !== 'boolean') normalized.separatorEnabled = true;
    if (typeof normalized.separatorImage !== 'string') normalized.separatorImage = null;
    return normalized;
}

function normalizeDuration(input) {

    if (!input) return null;

    const value = input.toString().trim().toLowerCase();

    const permanentKeywords = [

        'permanent',

        'perm',

        'perma',

        'نهائي',

        'نهائى',

        'نهائياً',

        'نهائيا',

        'دايم',

        'دائم',

        'دائما',

        'دائماً'

    ];

    if (permanentKeywords.includes(value)) {

        return 'permanent';

    }

    return input;

}


class DownManager {
    constructor() {
        this.client = null;
        this.ensureDataFiles();
        // قائمة تجاهل مؤقتة للرولات المُرجعة تلقائياً
        this.autoRestoreIgnoreList = new Map();
        // قائمة تتبع الاستعادات التي يقوم بها البوت (لمنع التداخل مع نظام الحماية)
        this.botRestorationTracking = new Set();
        this.expiredDownProcessing = new Set();
        this.leftMemberExpiryLogs = new Set();
        this.memberLifecycleLocks = new Map();
        this.recentLogDispatches = new Map();
    }

    getMemberKey(member) {
        return `${member.id}_${member.guild.id}`;
    }

    lockMemberLifecycle(member, action, ttlMs = 15000) {
        const key = `${action}:${this.getMemberKey(member)}`;
        if (this.memberLifecycleLocks.has(key)) {
            return false;
        }

        this.memberLifecycleLocks.set(key, Date.now());
        setTimeout(() => this.memberLifecycleLocks.delete(key), ttlMs);
        return true;
    }

    createDownLogContainer({ title, details = '', thumbnailURL = null, footer = 'Down Log' }) {
        const heading = `## ${String(title || 'Down Log').slice(0, 200)}`;
        const section = new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(heading));

        section.setThumbnailAccessory(new ThumbnailBuilder()
            .setURL(thumbnailURL || 'https://cdn.discordapp.com/embed/avatars/0.png')
            .setDescription(String(title || 'Down Log').slice(0, 200)));

        const container = new ContainerBuilder()
            .setAccentColor(0x5865F2)
            .addSectionComponents(section);

        if (details) {
            container.addSeparatorComponents(new SeparatorBuilder());
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(String(details).slice(0, 3500)));
        }
        if (footer) {
            container.addSeparatorComponents(new SeparatorBuilder());
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${String(footer).slice(0, 200)}`));
        }
        return container;
    }

    sendDownLog(channel, data) {
        if (!channel) return Promise.resolve(null);
        return (async () => {
            const message = await channel.send({
                components: [this.createDownLogContainer(data)],
                flags: MessageFlags.IsComponentsV2
            });
            const separatorFiles = this.getSeparatorAttachments();
            if (separatorFiles.length > 0) {
                try {
                    await channel.send({ files: separatorFiles });
                } catch (error) {
                    console.error('تعذر إرسال الخط الفاصل بعد سجل الداون:', error);
                }
            }
            return message;
        })();
    }

    getSeparatorAttachments() {
        const settings = this.getSettings();
        if (!settings.separatorEnabled) return [];

        if (settings.separatorImage) {
            if (/^https?:\/\//i.test(settings.separatorImage)) {
                let extension = '.png';
                try { extension = path.extname(new URL(settings.separatorImage).pathname) || '.png'; } catch (_) {}
                return [{ attachment: settings.separatorImage, name: `separator${extension}` }];
            }
            try {
                if (fs.existsSync(settings.separatorImage)) {
                    return [{ attachment: settings.separatorImage, name: path.basename(settings.separatorImage) }];
                }
            } catch (_) {}
        }

        const localSeparator = path.join(__dirname, '..', 'assets', 'separator.png');
        if (fs.existsSync(localSeparator)) {
            return [{ attachment: localSeparator, name: 'separator.png' }];
        }

        return [{
            attachment: 'https://cdn.discordapp.com/attachments/1446184605056106690/1447086623954173972/colors-5.png',
            name: 'separator.png'
        }];
    }

    mergeUniqueDowns(downs = []) {
        const unique = new Map();
        for (const down of downs) {
            if (!down || !down.downId) continue;
            const prev = unique.get(down.downId);
            if (!prev || (down.startTime || 0) < (prev.startTime || 0)) {
                unique.set(down.downId, down);
            }
        }
        return Array.from(unique.values());
    }

    // Initialize with Discord client
    init(client) {
        this.client = client;
        this.startExpirationChecker(client);
        // بدء مهام الصيانة فور التهيئة
        setTimeout(() => this.startMaintenanceTasks(), 5000); // تأخير 5 ثواني
        // فحص تكاملي مباشر بعد التشغيل
        setTimeout(() => this.verifyActiveDownRoleIntegrity().catch(() => {}), 10000);
    }

    ensureDataFiles() {
        // Create default settings file
        if (!fs.existsSync(downSettingsPath)) {
            const defaultSettings = {
                menuChannel: null,
                logChannel: null,
                separatorEnabled: true,
                separatorImage: null,
                allowedUsers: {
                    type: null, // 'owners', 'roles', 'responsibility'
                    targets: []
                }
            };
            writeJson(downSettingsPath, defaultSettings);
        }

        // Create active downs file
        if (!fs.existsSync(activeDownsPath)) {
            writeJson(activeDownsPath, {});
        }

        // Create logs file
        if (!fs.existsSync(downLogsPath)) {
            writeJson(downLogsPath, []);
        }

        // Create left members downs file
        if (!fs.existsSync(leftMembersDownsPath)) {
            writeJson(leftMembersDownsPath, {});
        }
    }

    // Settings Management
    getSettings() {
        return normalizeSettings(readJson(downSettingsPath, {
            menuChannel: null,
            logChannel: null,
            separatorEnabled: true,
            separatorImage: null,
            allowedUsers: {
                type: null,
                targets: []
            }
        }));
    }

    updateSettings(newSettings) {
        return writeJson(downSettingsPath, newSettings);
    }

    // Permission Checking
    async hasPermission(interaction, botOwners) {
        const settings = this.getSettings() || {};
        const userId = String(interaction?.user?.id || '');
        const owners = Array.isArray(botOwners) ? botOwners.map(String) : [];
        const guild = interaction?.member?.guild || interaction?.guild;

        if (!userId) return false;

        // Bot owners always have permission
        if (owners.includes(userId) || guild?.ownerId === userId) return true;

        const allowedUsers = settings.allowedUsers || { type: null, targets: [] };
        const allowedTargets = Array.isArray(allowedUsers.targets) ? allowedUsers.targets : [];

        // Check configured permissions
        if (!allowedUsers.type) return false;

        switch (allowedUsers.type) {
            case 'owners':
                return owners.includes(userId) || guild?.ownerId === userId;

            case 'roles': {
                const roleCache = interaction?.member?.roles?.cache;
                if (!roleCache) return false;
                const userRoles = typeof roleCache.map === 'function'
                    ? roleCache.map(role => String(role.id))
                    : [...(roleCache.keys?.() || [])].map(id => String(id));
                return allowedTargets.some(roleId => userRoles.includes(roleId));
            }

            case 'responsibility': {
                const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
                const responsibilities = readJson(responsibilitiesPath, {});
                const roleCache = interaction?.member?.roles?.cache;
                const memberRoleIds = roleCache
                    ? (typeof roleCache.map === 'function'
                        ? roleCache.map(role => String(role.id))
                        : [...(roleCache.keys?.() || [])].map(id => String(id)))
                    : [];

                for (const respName of allowedTargets) {
                    const respData = responsibilities[respName];
                    if (!respData) continue;
                    const responsibleUsers = Array.isArray(respData.responsibles)
                        ? respData.responsibles.map(id => String(id))
                        : [];
                    const responsibleRoles = Array.isArray(respData.roles)
                        ? respData.roles.map(id => String(id))
                        : [];
                    if (responsibleUsers.includes(String(userId)) || responsibleRoles.some(id => memberRoleIds.includes(id))) {
                        return true;
                    }
                }
                return false;
            }
        }

        return false;
    }

    // Admin Roles Validation
    getAdminRoles() {
        return readJson(adminRolesPath, []);
    }

    isAdminRole(roleId) {
        const adminRoles = this.getAdminRoles();
        return adminRoles.includes(roleId);
    }

    getRelatedActiveDowns(userId, guildId, activeDowns = this.getActiveDowns(), excludingId = null) {
        return Object.entries(activeDowns || {})
            .filter(([downId, down]) => downId !== excludingId &&
                String(down?.userId) === String(userId) &&
                String(down?.guildId) === String(guildId) &&
                down?.status === 'active')
            .map(([downId, down]) => ({ downId, ...down }));
    }

    async getDownResponsibilitySnapshot(member, userId, guildId, roleId, activeDowns = this.getActiveDowns()) {
        const vacationManager = require('./vacationManager');
        const relatedDowns = this.getRelatedActiveDowns(userId, guildId, activeDowns);
        const capturedDowns = relatedDowns.filter(down => down.responsibilitySnapshotCaptured === true);
        let responsibilityAssignments;

        if (capturedDowns.length > 0) {
            const assignmentsByName = new Map();
            for (const down of capturedDowns) {
                for (const assignment of down.responsibilityAssignments || []) {
                    const existing = assignmentsByName.get(assignment.name);
                    assignmentsByName.set(assignment.name, {
                        ...assignment,
                        index: existing ? Math.min(Number(existing.index) || 0, Number(assignment.index) || 0) : assignment.index,
                        roleIds: [...new Set([...(existing?.roleIds || []), ...(assignment.roleIds || [])].map(String))]
                    });
                }
            }
            responsibilityAssignments = [...assignmentsByName.values()];
        } else {
            const responsibilities = await vacationManager.getResponsibilitiesForVacation();
            responsibilityAssignments = vacationManager.captureResponsibilityAssignments(responsibilities, userId);
        }

        const adminRoleIds = new Set(this.getAdminRoles().map(String));
        const responsibilityRoleIds = new Set(responsibilityAssignments.flatMap(item => item.roleIds || []).map(String));
        const suspendedRoleIds = new Set(relatedDowns.map(down => String(down.roleId || '')).filter(Boolean));
        for (const role of member.roles.cache.values()) {
            if (adminRoleIds.has(String(role.id)) || responsibilityRoleIds.has(String(role.id))) {
                suspendedRoleIds.add(String(role.id));
            }
        }
        if (roleId) suspendedRoleIds.add(String(roleId));
        for (const down of capturedDowns) {
            for (const id of down.suspendedRoleIds || []) suspendedRoleIds.add(String(id));
        }

        return {
            responsibilityAssignments,
            suspendedRoleIds: [...suspendedRoleIds],
            responsibilitySnapshotCaptured: true
        };
    }

    persistDownResponsibilitySnapshot(activeDowns, snapshot, userId, guildId) {
        for (const down of Object.values(activeDowns || {})) {
            if (String(down?.userId) !== String(userId) || String(down?.guildId) !== String(guildId) || down?.status !== 'active') continue;
            down.responsibilityAssignments = snapshot.responsibilityAssignments;
            down.suspendedRoleIds = snapshot.suspendedRoleIds;
            down.responsibilitySnapshotCaptured = true;
        }
        return writeJson(activeDownsPath, activeDowns);
    }

    async completeDownSuspension(downRecord, guild, member, reason = 'انتهاء مدة الداون') {
        const downId = String(downRecord?.downId || downRecord?.id || '');
        if (!downId) return { success: false, error: 'معرف الداون غير موجود' };
        const activeDowns = this.getActiveDowns();
        const currentRecord = activeDowns[downId] || downRecord;
        activeDowns[downId] = currentRecord;
        if (currentRecord.responsibilitySnapshotCaptured !== true && member) {
            try {
                const legacySnapshot = await this.getDownResponsibilitySnapshot(
                    member, currentRecord.userId, currentRecord.guildId, currentRecord.roleId, activeDowns
                );
                Object.assign(currentRecord, legacySnapshot);
                if (!this.persistDownResponsibilitySnapshot(activeDowns, legacySnapshot, currentRecord.userId, currentRecord.guildId)) {
                    currentRecord.responsibilityRestorePending = true;
                    currentRecord.pendingEndReason = reason;
                    return { success: false, error: 'تعذر حفظ نسخة المسؤوليات؛ أُبقي الداون لإعادة المحاولة' };
                }
            } catch (error) {
                currentRecord.responsibilityRestorePending = true;
                currentRecord.pendingEndReason = reason;
                writeJson(activeDownsPath, activeDowns);
                console.error(`تعذر إنشاء snapshot للمسؤوليات أثناء إنهاء الداون ${downId}:`, error);
                return { success: false, error: 'تعذر حفظ نسخة المسؤوليات؛ ستتم إعادة المحاولة تلقائيًا' };
            }
        }
        const peers = this.getRelatedActiveDowns(currentRecord.userId, currentRecord.guildId, activeDowns, downId);
        const assignmentMap = new Map();
        const suspendedRoleSet = new Set();
        for (const record of [currentRecord, ...peers]) {
            for (const assignment of Array.isArray(record.responsibilityAssignments) ? record.responsibilityAssignments : []) {
                const previous = assignmentMap.get(assignment.name);
                assignmentMap.set(assignment.name, {
                    ...assignment,
                    index: previous ? Math.min(Number(previous.index) || 0, Number(assignment.index) || 0) : assignment.index,
                    roleIds: [...new Set([...(previous?.roleIds || []), ...(assignment.roleIds || [])].map(String))]
                });
            }
            for (const roleId of record.suspendedRoleIds || []) suspendedRoleSet.add(String(roleId));
            if (record.roleId) suspendedRoleSet.add(String(record.roleId));
        }
        const assignments = [...assignmentMap.values()];
        const suspendedRoleIds = [...suspendedRoleSet];

        if (peers.length > 0) {
            for (const peer of peers) {
                const stored = activeDowns[peer.downId];
                stored.responsibilityAssignments = assignments;
                stored.suspendedRoleIds = suspendedRoleIds;
                stored.responsibilitySnapshotCaptured = true;
            }
            delete activeDowns[downId];
            if (!writeJson(activeDownsPath, activeDowns)) return { success: false, error: 'تعذر حفظ بيانات المسؤوليات للداون المتبقي' };
            return { success: true, deferred: true };
        }

        const vacationManager = require('./vacationManager');
        try {
            const currentResponsibilities = await vacationManager.getResponsibilitiesForVacation();
            const currentAssignments = vacationManager.captureResponsibilityAssignments(currentResponsibilities, currentRecord.userId);
            const assignmentsToRemove = new Map();
            for (const assignment of [...assignments, ...currentAssignments]) {
                const previous = assignmentsToRemove.get(assignment.name);
                assignmentsToRemove.set(assignment.name, {
                    ...assignment,
                    roleIds: [...new Set([...(previous?.roleIds || []), ...(assignment.roleIds || [])].map(String))]
                });
            }
            const removal = await vacationManager.removeUserFromResponsibilities(currentRecord.userId, [...assignmentsToRemove.values()]);
            if (removal.failed.length > 0) {
                currentRecord.responsibilitiesRemoved = false;
                currentRecord.responsibilityRemovalFailures = removal.failed;
                currentRecord.responsibilityRestorePending = true;
                currentRecord.pendingEndReason = reason;
                writeJson(activeDownsPath, activeDowns);
                return { success: false, error: 'تعذر تعليق بعض المسؤوليات قبل استعادتها؛ ستتم إعادة المحاولة تلقائيًا' };
            }
        } catch (error) {
            currentRecord.responsibilityRestorePending = true;
            currentRecord.pendingEndReason = reason;
            writeJson(activeDownsPath, activeDowns);
            console.error(`تعذر تنظيف المسؤوليات قبل إنهاء داون ${downId}:`, error);
            return { success: false, error: 'تعذر التحقق من المسؤوليات؛ ستتم إعادة المحاولة تلقائيًا' };
        }

        let failedResponsibilities = [];
        try {
            failedResponsibilities = (await vacationManager.restoreUserResponsibilities(currentRecord.userId, assignments)).failed;
        } catch (error) {
            console.error(`تعذر استعادة مسؤوليات العضو ${currentRecord.userId} بعد الداون:`, error);
            failedResponsibilities = assignments;
        }
        if (failedResponsibilities.length > 0) {
            currentRecord.responsibilityAssignments = failedResponsibilities;
            currentRecord.responsibilitySnapshotCaptured = true;
            currentRecord.responsibilityRestorePending = true;
            currentRecord.pendingEndReason = reason;
            writeJson(activeDownsPath, activeDowns);
            return { success: false, error: 'تعذر استعادة بعض المسؤوليات؛ ستتم إعادة المحاولة تلقائيًا' };
        }

        if (!member && suspendedRoleIds.length > 0) {
            currentRecord.responsibilityAssignments = assignments;
            currentRecord.suspendedRoleIds = suspendedRoleIds;
            currentRecord.responsibilitySnapshotCaptured = true;
            currentRecord.responsibilityRestorePending = true;
            currentRecord.pendingEndReason = reason;
            currentRecord.roleRestorePending = true;
            if (!writeJson(activeDownsPath, activeDowns)) {
                return { success: false, error: 'العضو خارج السيرفر وتعذر حفظ استعادة الرولات للمحاولة لاحقًا' };
            }
            return { success: false, error: 'العضو خارج السيرفر؛ حُفظت الاستعادة وستتم عند عودته' };
        }

        if (member) {
            for (const restoreRoleId of suspendedRoleIds) {
                if (member.roles.cache.has(restoreRoleId)) continue;
                let role = guild.roles.cache.get(restoreRoleId) || null;
                if (!role) {
                    try {
                        role = await guild.roles.fetch(restoreRoleId);
                    } catch (error) {
                        const errorCode = Number(error?.code ?? error?.rawError?.code);
                        if (errorCode === 10011) {
                            console.warn(`تم تخطي استعادة الرول ${restoreRoleId} لأنه حُذف من السيرفر.`);
                            continue;
                        }
                        currentRecord.responsibilityAssignments = assignments;
                        currentRecord.suspendedRoleIds = suspendedRoleIds;
                        currentRecord.responsibilitySnapshotCaptured = true;
                        currentRecord.responsibilityRestorePending = true;
                        currentRecord.roleRestorePending = true;
                        currentRecord.roleRestoreLastError = error.message;
                        currentRecord.pendingEndReason = reason;
                        writeJson(activeDownsPath, activeDowns);
                        console.error(`تعذر جلب الرول ${restoreRoleId} لاستعادته؛ ستتم إعادة المحاولة:`, error);
                        return { success: false, error: 'تعذر جلب بعض الرولات؛ حُفظت العملية لإعادة المحاولة' };
                    }
                }
                if (!role) {
                    console.warn(`تم تخطي استعادة الرول ${restoreRoleId} لأنه لم يعد موجودًا في السيرفر.`);
                    continue;
                }
                const restorationKey = `${guild.id}_${member.id}_${restoreRoleId}`;
                this.addToAutoRestoreIgnore(member.id, restoreRoleId);
                this.botRestorationTracking.add(restorationKey);
                try {
                    await member.roles.add(role, `استعادة الرتب والمسؤوليات بعد انتهاء الداون: ${reason}`);
                } catch (error) {
                    currentRecord.responsibilityAssignments = assignments;
                    currentRecord.suspendedRoleIds = suspendedRoleIds;
                    currentRecord.responsibilitySnapshotCaptured = true;
                    currentRecord.responsibilityRestorePending = true;
                    currentRecord.pendingEndReason = reason;
                    writeJson(activeDownsPath, activeDowns);
                    console.error(`تعذر استعادة الرول ${restoreRoleId} بعد الداون:`, error);
                    return { success: false, error: 'تعذر استعادة بعض الرتب؛ ستتم إعادة المحاولة تلقائيًا' };
                } finally {
                    setTimeout(() => this.botRestorationTracking.delete(restorationKey), 10000);
                }
            }
        }

        delete activeDowns[downId];
        if (!writeJson(activeDownsPath, activeDowns)) return { success: false, error: 'تعذر حفظ إنهاء الداون بعد استعادة المسؤوليات' };
        return { success: true, deferred: false };
    }

    // Down Operations
    async createDown(guild, client, targetUserId, roleId, duration, reason, byUserId, botOwners = []) {
        try {
            duration = normalizeDuration(duration);
            const isVerbal = duration === 'شفوي' || duration === 'verbal';
            let endTime = null;

            if (!isVerbal && duration !== 'permanent') {
                const durationMs = ms(duration);
                if (!durationMs) {
                    return { success: false, error: 'صيغة المدة غير صحيحة' };
                }
                endTime = Date.now() + durationMs;
            }
            
            // Validate admin role (skip for verbal downs)
            if (!isVerbal && !this.isAdminRole(roleId)) {
                return { success: false, error: 'الرول المحدد ليس من الرولات الإدارية' };
            }

            // المعتمدون يستخدمون نفس استثناء المالك للرولات الحساسة، مع بقاء
            // فحص صلاحية البوت وهرمية الرول فعالين دائماً.
            const actorMember = await guild.members.fetch(byUserId).catch(() => null);
            const actorIsAuthorized = actorMember && await this.hasPermission(
                { user: { id: byUserId }, member: actorMember },
                botOwners
            );

            // التحقق من صلاحيات البوت وأمان الرول - تخطي للشفوي
            if (!isVerbal) {
                const validation = await this.validateBotPermissions(guild, roleId, actorIsAuthorized);
                if (!validation.valid) {
                    return { success: false, error: validation.error };
                }
            }

            // Get target member
            const targetMember = await guild.members.fetch(targetUserId);
            if (!targetMember) {
                return { success: false, error: 'العضو غير موجود' };
            }

            // Get role
            const role = isVerbal ? null : await guild.roles.fetch(roleId);
            if (!role && duration !== 'شفوي' && duration !== 'verbal') {
                return { success: false, error: 'الرول غير موجود' };
            }

            // Check if member has the role
            if (duration !== 'شفوي' && duration !== 'verbal' && !targetMember.roles.cache.has(roleId)) {
                return { success: false, error: 'العضو لا يملك هذا الرول' };
            }

            if (!isVerbal) {
                const duplicate = Object.values(this.getActiveDowns()).some(down =>
                    down?.guildId === guild.id &&
                    down?.userId === targetUserId &&
                    down?.roleId === roleId &&
                    down?.status === 'active' &&
                    (!down.endTime || down.endTime > Date.now())
                );
                if (duplicate) {
                    return { success: false, error: 'يوجد داون نشط على هذا العضو بهذا الرول بالفعل' };
                }
            }

            // Create down record
            const downId = isVerbal ? `${targetUserId}_verbal_${Date.now()}` : `${targetUserId}_${roleId}_${Date.now()}`;
            const downRecord = {
                id: downId,
                userId: targetUserId,
                roleId: isVerbal ? null : roleId,
                guildId: guild.id,
                reason: reason,
                byUserId: byUserId,
                startTime: Date.now(),
                endTime: endTime,
                duration: duration,
                status: isVerbal ? 'verbal' : 'active'
            };

            if (!isVerbal) {
                const activeDowns = this.getActiveDowns();
                const snapshot = await this.getDownResponsibilitySnapshot(targetMember, targetUserId, guild.id, roleId, activeDowns);
                Object.assign(downRecord, snapshot, { responsibilitiesRemoved: snapshot.responsibilityAssignments.length === 0 });
                activeDowns[downId] = downRecord;
                if (!this.persistDownResponsibilitySnapshot(activeDowns, snapshot, targetUserId, guild.id)) {
                    return { success: false, error: 'تعذر حفظ المسؤوليات قبل تطبيق الداون؛ لم يتم سحب الرتب' };
                }

                // اسحب الرول المختار الآن فقط؛ بقية adminRoles ورولات المسؤوليات
                // يسحبها فحص التكامل بعد حفظ كل سجلات الداون المختارة.
                const rolesToRemove = [String(roleId)];
                try {
                    const actorName = await guild.members.fetch(byUserId).then(m => m.displayName).catch(() => 'غير معروف');
                    await targetMember.roles.remove(rolesToRemove, `داون بواسطة ${actorName}: ${reason}`);
                } catch (roleError) {
                    delete activeDowns[downId];
                    writeJson(activeDownsPath, activeDowns);
                    console.error('Error removing roles for down:', roleError);
                    return { success: false, error: 'فشل في سحب الرولات - تحقق من صلاحيات البوت' };
                }

                try {
                    const removal = await require('./vacationManager').removeUserFromResponsibilities(targetUserId, snapshot.responsibilityAssignments);
                    downRecord.responsibilitiesRemoved = removal.failed.length === 0;
                    downRecord.responsibilityRemovalFailures = removal.failed;
                    if (removal.failed.length > 0) {
                        console.warn(`تعذر إزالة ${removal.failed.length} مسؤولية أثناء تطبيق الداون؛ ستتم إعادة المحاولة.`);
                    }
                } catch (responsibilityError) {
                    downRecord.responsibilitiesRemoved = false;
                    downRecord.responsibilityRemovalFailures = snapshot.responsibilityAssignments;
                    console.error('تعذر إزالة مسؤوليات العضو أثناء تطبيق الداون:', responsibilityError);
                }
                writeJson(activeDownsPath, activeDowns);
            }

            // Log the action
            this.logAction(isVerbal ? 'DOWN_VERBAL' : 'DOWN_APPLIED', {
                targetUserId,
                roleId: isVerbal ? null : roleId,
                guildId: guild.id,
                duration,
                reason,
                byUserId,
                timestamp: Date.now()
            });

            // Send log message
            await this.sendLogMessage(guild, client, isVerbal ? 'DOWN_VERBAL' : 'DOWN_APPLIED', {
                targetUserId: targetUserId, // for verbal
                targetUser: targetMember.user,
                role: isVerbal ? 'شفوي' : role,
                duration: duration || 'نهائي',
                reason,
                byUserId: byUserId, // for verbal
                byUser: await client.users.fetch(byUserId)
            });

            return { 
                success: true, 
                downId: downId,
                duration: duration,
                endTime: endTime
            };

        } catch (error) {
            console.error('Error creating down:', error);
            return { success: false, error: 'حدث خطأ أثناء تطبيق الداون' };
        }
    }

    async endDown(guild, client, downId, reason = 'انتهاء المدة المحددة') {
        try {
            const activeDowns = readJson(activeDownsPath, {});
            const downRecord = activeDowns[downId];

            if (!downRecord) {
                return { success: false, error: 'الداون غير موجود' };
            }

            // Get member and role; the record can outlive either resource.
            const member = await guild.members.fetch(downRecord.userId).catch(() => null);
            const role = await guild.roles.fetch(downRecord.roleId).catch(() => null);
            const completion = await this.completeDownSuspension(
                { ...downRecord, downId }, guild, member, reason
            );
            if (!completion.success) return completion;

            if (member) {
                await this.sendLogMessage(guild, client, 'DOWN_ENDED', {
                    targetUser: member.user,
                    role: role || 'الرول المحفوظ',
                    reason: completion.deferred ? `${reason} (تأجلت الاستعادة لوجود داون آخر)` : reason,
                    originalReason: downRecord.reason,
                    duration: downRecord.duration || 'نهائي',
                    byUser: await client.users.fetch(downRecord.byUserId).catch(() => null)
                });
            }

            // Log the action
            this.logAction('DOWN_ENDED', {
                targetUserId: downRecord.userId,
                roleId: downRecord.roleId,
                guildId: guild.id,
                reason,
                originalReason: downRecord.reason,
                duration: downRecord.duration,
                byUserId: downRecord.byUserId,
                timestamp: Date.now()
            });

            return { success: true };

        } catch (error) {
            console.error('Error ending down:', error);
            return { success: false, error: 'حدث خطأ أثناء إنهاء الداون' };
        }
    }

    async modifyDownDuration(guild, client, downId, newDuration, modifiedBy) {
        try {
            newDuration = normalizeDuration(newDuration);
            const modifiedById = String(modifiedBy?.id || modifiedBy?.user?.id || modifiedBy || '');
            const activeDowns = readJson(activeDownsPath, {});
            const downRecord = activeDowns[downId];

            if (!downRecord) {
                return { success: false, error: 'الداون غير موجود' };
            }
            if (!downRecord.roleId || downRecord.status === 'verbal') {
                return { success: false, error: 'لا يمكن تعديل مدة التنبيه الشفوي' };
            }

            const oldDuration = downRecord.duration || 'نهائي';

            // Calculate new end time
            let newEndTime = null;
            if (newDuration && newDuration !== 'permanent') {
                const durationMs = ms(newDuration);
                if (!durationMs) {
                    return { success: false, error: 'صيغة المدة غير صحيحة' };
                }
                newEndTime = Date.now() + durationMs;
            }

            // Update the record
            downRecord.duration = newDuration;
            downRecord.endTime = newEndTime;
            downRecord.modifiedBy = modifiedById;
            downRecord.modifiedAt = Date.now();

            activeDowns[downId] = downRecord;
            writeJson(activeDownsPath, activeDowns);

            // Log the modification
            this.logAction('DOWN_MODIFIED', {
                targetUserId: downRecord.userId,
                roleId: downRecord.roleId,
                guildId: guild.id,
                oldDuration,
                newDuration,
                modifiedBy: modifiedById,
                timestamp: Date.now()
            });

            // Send log message
            const member = await guild.members.fetch(downRecord.userId).catch(() => null);
            const role = await guild.roles.fetch(downRecord.roleId).catch(() => null);
            if (member && role) {
                await this.sendLogMessage(guild, client, 'DOWN_MODIFIED', {
                    targetUser: member.user,
                    role,
                    oldDuration,
                    newDuration: newDuration || 'نهائي',
                    modifiedBy: await client.users.fetch(modifiedById).catch(() => null)
                });
            }

            return { success: true, newDuration, endTime: newEndTime };

        } catch (error) {
            console.error('Error modifying down duration:', error);
            return { success: false, error: 'حدث خطأ أثناء تعديل المدة' };
        }
    }

    // Data Retrieval
    getActiveDowns() {
        return readJson(activeDownsPath, {});
    }

    getUserDowns(userId, guildId = null) {
        if (!userId) return [];

        const now = Date.now();
        const activeDowns = this.getActiveDowns();

        return Object.entries(activeDowns)
            .filter(([_, down]) => {
                if (!down || down.userId !== userId) return false;
                if (guildId && down.guildId !== guildId) return false;

                // تجاهل الداون المنتهي الذي لم تتم إزالته بعد من التخزين
                if (down.endTime && down.endTime <= now) return false;

                return true;
            })
            .map(([downId, down]) => ({
                downId,
                ...down,
                id: down.id || downId
            }))
            .sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
    }

    getUserDownHistory(userId, guildId = null) {
        const logs = readJson(downLogsPath, []);
        return logs.filter(log =>
            log?.data?.targetUserId === userId &&
            (!guildId || !log.data.guildId || log.data.guildId === guildId) &&
            (
                log.type === 'DOWN_APPLIED' ||
                log.type === 'DOWN_ENDED' ||
                log.type === 'DOWN_VERBAL'
            )
        );
    }

    getUsersWithDownHistory(guildId = null) {
        const userIds = new Set();
        const logs = readJson(downLogsPath, []);
        for (const log of logs) {
            if (!log?.data?.targetUserId) continue;
            if (guildId && log.data.guildId && log.data.guildId !== guildId) continue;
            if (['DOWN_APPLIED', 'DOWN_ENDED', 'DOWN_VERBAL'].includes(log.type)) {
                userIds.add(String(log.data.targetUserId));
            }
        }
        for (const down of Object.values(this.getActiveDowns())) {
            if (down?.userId && (!guildId || down.guildId === guildId)) {
                userIds.add(String(down.userId));
            }
        }
        return [...userIds];
    }

    getGuildDownHistory(guildId = null) {
        const logs = readJson(downLogsPath, []);
        return logs.filter(log => {
            if (!log?.data?.targetUserId) return false;
            if (!['DOWN_APPLIED', 'DOWN_ENDED', 'DOWN_VERBAL'].includes(log.type)) return false;
            return !guildId || !log.data.guildId || log.data.guildId === guildId;
        }).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    getExpiredDowns() {
        const activeDowns = this.getActiveDowns();
        const now = Date.now();

        return Object.entries(activeDowns)
            .filter(([_, down]) => down.endTime && down.endTime <= now)
            .map(([downId, down]) => ({ downId, ...down }));
    }

    // Logging
    logAction(type, data) {
        const logs = readJson(downLogsPath, []);
        const now = Date.now();

        // منع تكرار نفس السجل مرتين عند وصول نفس التفاعل بسرعة (ازدواجية المعالجات)
        const lastLog = logs[logs.length - 1];
        const isImmediateDuplicate =
            lastLog &&
            lastLog.type === type &&
            now - (lastLog.timestamp || 0) <= 2500 &&
            safeStableStringify(lastLog.data) === safeStableStringify(data);

        if (isImmediateDuplicate) {
            return;
        }

        logs.push({
            type,
            data,
            timestamp: now
        });

        // Keep only last 1000 logs
        if (logs.length > 1000) {
            logs.splice(0, logs.length - 1000);
        }

        writeJson(downLogsPath, logs);
    }

    async sendLogMessage(guild, client, type, data) {
        const settings = this.getSettings();
        if (!settings.logChannel) return;

        const now = Date.now();
        const dispatchKey = `${guild?.id || 'unknown'}:${settings.logChannel}:${type}:${safeStableStringify(data)}`;
        const previousDispatch = this.recentLogDispatches.get(dispatchKey);

        if (previousDispatch && now - previousDispatch <= 2500) {
            return;
        }

        this.recentLogDispatches.set(dispatchKey, now);
        setTimeout(() => this.recentLogDispatches.delete(dispatchKey), 10000);

        try {
            const channel = await guild.channels.fetch(settings.logChannel);
            if (!channel) return;

            await this.sendDownLog(channel, this.createLogData(type, data));
        } catch (error) {
            console.error('Error sending log message:', error);
        }
    }

    createLogData(type, data) {
        const targetUser = data.targetUser && typeof data.targetUser === 'object' ? data.targetUser : null;
        const targetId = targetUser?.id || data.targetUserId || null;
        const targetMention = targetId ? `<@${targetId}>` : 'Unknown';
        const roleText = data.role?.id ? `<@&${data.role.id}>` : String(data.role || 'Unspecified');
        const actor = data.byUser || data.modifiedBy || null;
        const actorId = actor?.id || data.byUserId || data.modifiedById || null;
        const actorMention = actorId ? `<@${actorId}>` : 'Unknown';
        const shortText = (value, max = 900) => String(value || 'Unspecified').slice(0, max);
        const thumbnailURL = targetUser && typeof targetUser.displayAvatarURL === 'function'
            ? targetUser.displayAvatarURL({ dynamic: true, size: 256 })
            : null;

        switch (type) {
            case 'DOWN_APPLIED':
                return {
                    title: 'Down Applied',
                    details: `**Member:** ${targetMention}\n**Role:** ${shortText(roleText, 100)}\n**Duration:** ${shortText(data.duration, 100)}\n**Moderator:** ${actorMention}\n\n**Reason**\n${shortText(data.reason)}`,
                    thumbnailURL,
                    footer: 'Down Log • Applied'
                };

            case 'DOWN_ENDED':
                return {
                    title: 'Down Ended',
                    details: `**Member:** ${targetMention}\n**Role:** ${shortText(roleText, 100)}\n**Original Duration:** ${shortText(data.duration, 100)}\n**Moderator:** ${actorMention}\n\n**Original Reason**\n${shortText(data.originalReason)}\n\n**End Reason**\n${shortText(data.reason)}`,
                    thumbnailURL,
                    footer: 'Down Log • Ended'
                };

            case 'DOWN_VERBAL':
                return {
                    title: 'Verbal Warning',
                    details: `**Member:** ${targetMention}\n**Moderator:** ${actorMention}\n\n**Reason**\n${shortText(data.reason)}`,
                    thumbnailURL,
                    footer: 'Down Log • Verbal Warning'
                };

            case 'DOWN_MODIFIED':
                return {
                    title: 'Down Duration Updated',
                    details: `**Member:** ${targetMention}\n**Role:** ${shortText(roleText, 100)}\n**Previous Duration:** ${shortText(data.oldDuration, 100)}\n**New Duration:** ${shortText(data.newDuration, 100)}\n**Moderator:** ${actorMention}`,
                    thumbnailURL,
                    footer: 'Down Log • Duration Updated'
                };

            default:
                return {
                    title: 'Down Log',
                    details: `**Member:** ${targetMention}`,
                    thumbnailURL,
                    footer: 'Down Log'
                };
        }
    }

    // Auto expiration checker with notification
    startExpirationChecker(client) {
        this.client = client; // Store client reference
        
        // فحص الداونات المنتهية كل دقيقة
        setInterval(async () => {
            try {
                const expiredDowns = this.getExpiredDowns();
                for (const expiredDown of expiredDowns) {
                    await this.processExpiredDown(expiredDown);
                }
            } catch (error) {
                console.error('Error in down expiration checker:', error);
            }
        }, 60000); // Check every minute

        // تحديث المنيو التلقائي كل 30 ثانية
        setInterval(async () => {
            try {
                const settings = this.getSettings();
                if (settings.menuChannel && settings.menuMessageId) {
                    const downCommand = require('../commands/down.js');
                    if (downCommand && downCommand.createPermanentMenu) {
                        await downCommand.createPermanentMenu(client, settings.menuChannel);
                        console.log('✅ تم تحديث منيو الداون تلقائياً');
                    }
                }
            } catch (error) {
                console.error('خطأ في تحديث المنيو التلقائي:', error);
            }
        }, 30000); // تحديث كل 30 ثانية

        // فحص تكاملي دوري: التأكد أن كل من عليه داون لا يملك الرول المسحوب
        setInterval(async () => {
            try {
                await this.verifyActiveDownRoleIntegrity();
            } catch (error) {
                console.error('خطأ في فحص تكامل الداون:', error);
            }
        }, 120000); // كل دقيقتين
    }

    async verifyActiveDownRoleIntegrity() {
        if (!this.client) return;

        const activeDowns = this.getActiveDowns();
        const settings = this.getSettings();
        let fixedCount = 0;

        for (const [downId, down] of Object.entries(activeDowns)) {
            try {
                if (!down || !down.roleId || down.status !== 'active') continue;

                if (down.responsibilityRestorePending) {
                    const pendingGuild = await this.client.guilds.fetch(down.guildId).catch(() => null);
                    const pendingMember = pendingGuild
                        ? await pendingGuild.members.fetch(down.userId).catch(() => null)
                        : null;
                    if (pendingGuild) {
                        const retry = await this.completeDownSuspension(
                            { ...down, downId }, pendingGuild, pendingMember, down.pendingEndReason || 'انتهاء الداون'
                        );
                        if (retry.success) continue;
                    }
                }

                if (down.endTime && down.endTime <= Date.now()) {
                    continue;
                }

                const guild = await this.client.guilds.fetch(down.guildId).catch(() => null);
                if (!guild) continue;

                const member = await guild.members.fetch(down.userId).catch(() => null);
                if (!member) continue;

                if (down.responsibilitySnapshotCaptured !== true) {
                    const snapshot = await this.getDownResponsibilitySnapshot(member, down.userId, guild.id, down.roleId, activeDowns);
                    this.persistDownResponsibilitySnapshot(activeDowns, snapshot, down.userId, guild.id);
                }

                const vacationManager = require('./vacationManager');
                const currentResponsibilities = await vacationManager.getResponsibilitiesForVacation();
                const currentAssignments = vacationManager.captureResponsibilityAssignments(currentResponsibilities, down.userId);
                const assignmentsToRemove = new Map();
                for (const assignment of [...(down.responsibilityAssignments || []), ...currentAssignments]) {
                    const previous = assignmentsToRemove.get(assignment.name);
                    assignmentsToRemove.set(assignment.name, {
                        ...assignment,
                        roleIds: [...new Set([...(previous?.roleIds || []), ...(assignment.roleIds || [])].map(String))]
                    });
                }
                const assignmentsToSuspend = [...assignmentsToRemove.values()];
                if (assignmentsToSuspend.length > 0) {
                    const removal = await vacationManager.removeUserFromResponsibilities(down.userId, assignmentsToSuspend);
                    down.responsibilitiesRemoved = removal.failed.length === 0;
                    down.responsibilityRemovalFailures = removal.failed;
                    writeJson(activeDownsPath, activeDowns);
                } else {
                    down.responsibilitiesRemoved = true;
                }

                const adminRoleIds = new Set(this.getAdminRoles().map(String));
                const responsibilityRoleIds = new Set(
                    assignmentsToSuspend.flatMap(item => item.roleIds || []).map(String)
                );
                const rolesToRemove = member.roles.cache.filter(role =>
                    adminRoleIds.has(String(role.id)) || responsibilityRoleIds.has(String(role.id))
                );
                if (!rolesToRemove.size) continue;

                for (const role of rolesToRemove.values()) {
                    if (this.isBotRestoring(guild.id, member.id, role.id)) continue;
                    await member.roles.remove(role, 'فحص تكاملي تلقائي: حماية جميع الرولات الإدارية أثناء الداون');
                    fixedCount++;
                    console.log(`🔒 Integrity check removed admin role ${role.name} from ${member.displayName}`);
                }

                if (settings.logChannel) {
                    const logChannel = await guild.channels.fetch(settings.logChannel).catch(() => null);
                    if (logChannel) {
                        await this.sendDownLog(logChannel, {
                            title: 'Down Role Protection',
                            details: `**Member:** <@${member.id}>\n**Roles:** ${rolesToRemove.map(role => `<@&${role.id}>`).join(', ').slice(0, 900)}\n**Down Ends:** ${down.endTime ? `<t:${Math.floor(down.endTime / 1000)}:R>` : 'Permanent'}`,
                            thumbnailURL: member.displayAvatarURL({ dynamic: true, size: 256 }),
                            footer: 'Down Log • Role Protection'
                        }).catch(() => null);
                    }
                }
            } catch (error) {
                console.error('خطأ أثناء فحص تكامل داون واحد:', error);
            }
        }

        if (fixedCount > 0) {
            console.log(`🛡️ Down integrity check fixed ${fixedCount} role restoration attempt(s)`);
        }
    }

    

    // Process expired down 
    // Process expired down with notification and role restoration
    async processExpiredDown(expiredDown) {
        try {
            if (!this.client) return;
            const processingKey = expiredDown.id || expiredDown.downId;
            if (!processingKey || this.expiredDownProcessing.has(processingKey)) return;
            this.expiredDownProcessing.add(processingKey);

            const guild = await this.client.guilds.fetch(expiredDown.guildId).catch(() => null);
            if (!guild) return;

            const member = await guild.members.fetch(expiredDown.userId).catch(() => null);
            const role = expiredDown.roleId
                ? await guild.roles.fetch(expiredDown.roleId).catch(() => null)
                : null;

            if (!member) await this.handleExpiredDownForLeftMember(expiredDown, guild, role);
            const completion = await this.completeDownSuspension(
                { ...expiredDown, downId: processingKey }, guild, member, 'انتهاء مدة الداون'
            );
            if (!completion.success) {
                console.warn(`ستتم إعادة محاولة استعادة المسؤوليات/الرولات للداون ${processingKey}: ${completion.error}`);
                return;
            }
            if (!member) return;

            // Notify the user via DM
            try {
                const dmEmbed = colorManager.createEmbed()
                    .setTitle('تمت إعادة الرول')
                    .setDescription(completion.deferred
                        ? 'انتهت مدة هذا الداون، لكن الرتب والمسؤوليات ستبقى معلقة حتى ينتهي آخر داون نشط.'
                        : 'انتهت مدة الداون وتمت استعادة الرتب والمسؤوليات المحفوظة.')
                    .addFields([
                        { name: 'الرول', value: role?.name || 'رول محفوظ', inline: true },
                        { name: 'وقت الإعادة', value: `<t:${this.formatTimestamp(Date.now()).unix}:f>`, inline: true }
                    ])
                    .setThumbnail(member.displayAvatarURL({ dynamic: true }));

                await member.send({ embeds: [dmEmbed] });
            } catch (dmError) {
                console.log(`لا يمكن إرسال رسالة خاصة إلى ${member.displayName}`);
            }

            // Log the restoration
            const settings = this.getSettings();
            if (settings.logChannel && this.client) {
                const logChannel = await this.client.channels.fetch(settings.logChannel).catch(() => null);
                if (logChannel) {
                    const moderatorId = expiredDown.byUserId || expiredDown.moderatorId;
                    await this.sendDownLog(logChannel, {
                        title: 'Down Expired',
                        details: `**Member:** <@${member.id}>\n**Role:** ${role ? `<@&${role.id}>` : 'Saved Roles'}\n**Moderator:** ${moderatorId ? `<@${moderatorId}>` : 'Unknown'}\n**Reason:** ${String(expiredDown.reason || 'Unspecified').slice(0, 900)}\n**Time:** <t:${this.formatTimestamp(Date.now()).unix}:R>\n**Restoration:** ${completion.deferred ? 'Pending until other downs end' : 'Roles and responsibilities restored'}`,
                        thumbnailURL: member.displayAvatarURL({ dynamic: true, size: 256 }),
                        footer: 'Down Log • Automatic Restoration'
                    });
                }
            }

            console.log(completion.deferred
                ? `⏳ انتهى الداون ${processingKey}; الاستعادة مؤجلة لوجود داون آخر.`
                : `✅ انتهى الداون واستعيدت الرتب والمسؤوليات للعضو ${member.displayName}.`);

        } catch (error) {
            console.error('Error processing expired down:', error);
        } finally {
            const processingKey = expiredDown.id || expiredDown.downId;
            if (processingKey) this.expiredDownProcessing.delete(processingKey);
        }
    }

    // إضافة رول للتجاهل المؤقت (عند الإرجاع التلقائي)
    addToAutoRestoreIgnore(userId, roleId) {
        const key = `${userId}_${roleId}`;
        this.autoRestoreIgnoreList.set(key, Date.now());

        // إزالة من القائمة بعد 60 ثانية
        setTimeout(() => {
            this.autoRestoreIgnoreList.delete(key);
        }, 60000);

        console.log(`🛡️ تم إضافة ${key} لقائمة التجاهل المؤقت`);
    }

    // التحقق من وجود رول في قائمة التجاهل
    isInAutoRestoreIgnore(userId, roleId) {
        const key = `${userId}_${roleId}`;
        const timestamp = this.autoRestoreIgnoreList.get(key);

        if (!timestamp) return false;

        // إذا مر أكثر من 60 ثانية، احذف وارجع false
        if (Date.now() - timestamp > 60000) {
            this.autoRestoreIgnoreList.delete(key);
            return false;
        }

        return true;
    }

    // التحقق من صلاحيات البوت وأمان الرولات (الأصلي - محفوظ)
    async validateBotPermissions(guild, roleId, allowDangerousRole = false) {
        try {
            const role = await guild.roles.fetch(roleId);
            if (!role) {
                return { valid: false, error: 'الرول غير موجود' };
            }

            const botMember = await guild.members.fetch(guild.client.user.id);

            // @everyone والرولات المُدارة محمية دائماً ولا يمكن سحبها حتى
            // للمعتمدين؛ الاستثناء يخص فقط الرولات الحساسة ذات الصلاحيات.
            if (role.id === guild.id || role.managed) {
                return { valid: false, error: 'لا يمكن سحب هذا الرول - رول حساس' };
            }

            // المعتمدون يمكنهم سحب الرولات الحساسة ذات الصلاحيات الخطرة.
            if (!allowDangerousRole && this.isDangerousRole(role, guild)) {
                return { valid: false, error: 'لا يمكن سحب هذا الرول - رول حساس' };
            }

            // التحقق من صلاحية إدارة الرولات
            if (!botMember.permissions.has('ManageRoles')) {
                return { valid: false, error: 'ليس لدي البوت صلاحية إدارة الرولات' };
            }

            // التحقق من هيراركية الرولات
            if (role.position >= botMember.roles.highest.position) {
                return { valid: false, error: 'رتبة البوت أقل من الرول المطلوب' };
            }

            return { valid: true };
        } catch (error) {
            console.error('Error validating bot permissions:', error);
            return { valid: false, error: 'خطأ في التحقق من الصلاحيات' };
        }
    }

    // التحقق من صلاحيات البوت فقط (بدون حماية الرولات الخطرة)
    async validateBotPermissionsOnly(guild, roleId) {
        try {
            const role = await guild.roles.fetch(roleId);
            if (!role) {
                return { valid: false, error: 'الرول غير موجود' };
            }

            const botMember = await guild.members.fetch(guild.client.user.id);

            // التحقق من صلاحية إدارة الرولات فقط
            if (!botMember.permissions.has('ManageRoles')) {
                return { valid: false, error: 'ليس لدي البوت صلاحية إدارة الرولات' };
            }

            // التحقق من هيراركية الرولات فقط
            if (role.position >= botMember.roles.highest.position) {
                return { valid: false, error: 'رتبة البوت أقل من الرول المطلوب' };
            }

            return { valid: true };
        } catch (error) {
            console.error('Error validating bot permissions:', error);
            return { valid: false, error: 'خطأ في التحقق من الصلاحيات' };
        }
    }

    // التحقق من الرولات الخطرة
    isDangerousRole(role, guild) {
        // رول @everyone
        if (role.id === guild.id) {
            console.log(`🛡️ رول مرفوض: @everyone`);
            return true;
        }

        // الرولات المحمية (بوتات، نيترو، إلخ)
        if (role.managed) {
            console.log(`🛡️ رول مرفوض: ${role.name} - رول محمي/مدار`);
            return true;
        }

        // رولات بصلاحيات خطرة (Discord.js v14 permission names)
        const dangerousPermissions = [
            'Administrator',
            'ManageGuild', 
            'ManageRoles',
            'ManageChannels',
            'BanMembers',
            'KickMembers',
            'ManageWebhooks',
            'ManageGuildExpressions'
        ];

        const hasDangerousPerms = dangerousPermissions.some(perm => role.permissions.has(perm));
        if (hasDangerousPerms) {
            console.log(`🛡️ رول مرفوض: ${role.name} - يحتوي على صلاحيات خطرة`);
            return true;
        }

        console.log(`✅ رول مسموح: ${role.name} - آمن للسحب`);
        return false;
    }

    // تنظيف البيانات القديمة
    cleanupOldData() {
        try {
            // تنظيف اللوقز القديمة (أقدم من 30 يوم)
            const logs = readJson(downLogsPath, []);
            const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
            const filteredLogs = logs.filter(log => log.timestamp > thirtyDaysAgo);

            if (filteredLogs.length !== logs.length) {
                writeJson(downLogsPath, filteredLogs);
                console.log(`🧹 تم حذف ${logs.length - filteredLogs.length} سجل قديم`);
            }

            // لا تحذف الداونات المنتهية من activeDowns هنا: قد تكون الاستعادة
            // بانتظار عضو عاد للسيرفر أو تعذر تنفيذها مؤقتًا. processExpiredDown
            // يحذف السجل فقط بعد اكتمال استعادة المسؤوليات والرولات.
            const activeDowns = readJson(activeDownsPath, {});
            const expiredPending = Object.values(activeDowns).filter(down =>
                down?.status === 'active' && down.endTime && Number(down.endTime) <= Date.now()
            ).length;
            if (expiredPending) console.log(`⏳ الإبقاء على ${expiredPending} داون منتهي حتى تكتمل استعادة الرولات والمسؤوليات.`);

        } catch (error) {
            console.error('خطأ في تنظيف البيانات:', error);
        }
    }

    // نظام نسخ احتياطي بسيط
    createBackup() {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupDir = path.join(__dirname, '..', 'data', 'backups');

            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }

            // نسخ الملفات المهمة
            const filesToBackup = [
                { src: downSettingsPath, name: 'downSettings.json' },
                { src: activeDownsPath, name: 'activeDowns.json' },
                { src: downLogsPath, name: 'downLogs.json' }
            ];

            filesToBackup.forEach(file => {
                if (fs.existsSync(file.src)) {
                    const backupPath = path.join(backupDir, `${timestamp}_${file.name}`);
                    fs.copyFileSync(file.src, backupPath);
                }
            });

            console.log(`💾 تم إنشاء نسخة احتياطية: ${timestamp}`);
            return true;
        } catch (error) {
            console.error('خطأ في إنشاء النسخة الاحتياطية:', error);
            return false;
        }
    }

    // التحقق من سلامة البيانات
    validateDataIntegrity() {
        try {
            let fixed = false;

            // فحص activeDowns
            const activeDowns = readJson(activeDownsPath, {});
            for (const [downId, down] of Object.entries(activeDowns)) {
                // التأكد من وجود الحقول المطلوبة
                if (!down.userId || !down.guildId || (down.status !== 'verbal' && !down.roleId)) {
                    delete activeDowns[downId];
                    fixed = true;
                    console.log(`🔧 حذف داون فاسد: ${downId}`);
                }

                // إصلاح الحقول الناقصة
                if (!down.status) {
                    down.status = 'active';
                    fixed = true;
                }
                if (!down.timestamp) {
                    down.timestamp = Date.now();
                    fixed = true;
                }
            }

            if (fixed) {
                writeJson(activeDownsPath, activeDowns);
                console.log('🔧 تم إصلاح بعض مشاكل البيانات');
            }

            return true;
        } catch (error) {
            console.error('خطأ في فحص سلامة البيانات:', error);
            return false;
        }
    }

    // مهام الصيانة الدورية
    startMaintenanceTasks() {
        // تنظيف البيانات كل 6 ساعات
        setInterval(() => {
            console.log('🧹 بدء تنظيف البيانات...');
            this.cleanupOldData();
        }, 6 * 60 * 60 * 1000);

        // نسخة احتياطية يومية
        setInterval(() => {
            console.log('💾 إنشاء نسخة احتياطية...');
            this.createBackup();
        }, 24 * 60 * 60 * 1000);

        // فحص سلامة البيانات كل ساعة
        setInterval(() => {
            console.log('🔧 فحص سلامة البيانات...');
            this.validateDataIntegrity();
        }, 60 * 60 * 1000);

        // فحص فوري عند بدء التشغيل
        console.log('🚀 بدء مهام الصيانة الدورية');
        this.cleanupOldData();
        this.validateDataIntegrity();
    }

    // تحسين timezone handling
    formatTimestamp(timestamp, locale = 'ar-SA') {
        try {
            const date = new Date(timestamp);
            return {
                unix: Math.floor(timestamp / 1000),
                readable: date.toLocaleString(locale, {
                    timeZone: 'Asia/Riyadh',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                })
            };
        } catch (error) {
            console.error('Error formatting timestamp:', error);
            return {
                unix: Math.floor(Date.now() / 1000),
                readable: 'غير محدد'
            };
        }
    }

    // Menu helpers
    createStatusEmbed() {
        const settings = this.getSettings();
        const activeDowns = Object.keys(this.getActiveDowns()).length;

        const embed = colorManager.createEmbed()
            .setTitle('إعدادات نظام الداون')
            .addFields([
                { 
                    name: ' روم المنيو', 
                    value: settings.menuChannel ? `<#${settings.menuChannel}>` : 'غير محدد', 
                    inline: true 
                },
                { 
                    name: ' روم السجلات', 
                    value: settings.logChannel ? `<#${settings.logChannel}>` : 'غير محدد', 
                    inline: true 
                },
                { 
                    name: '👥 المصرح لهم', 
                    value: settings.allowedUsers.type ? 
                        `${this.getPermissionTypeText(settings.allowedUsers.type)} (${settings.allowedUsers.targets.length})` : 
                        'غير محدد', 
                    inline: true 
                },
                { 
                    name: ' الداونات النشطة', 
                    value: `${activeDowns}`, 
                    inline: true 
                }
            ])
            .setTimestamp();

        // إضافة أفتار البوت إذا كان متاحاً
        if (this.client && this.client.user) {
            embed.setThumbnail(this.client.user.displayAvatarURL({ dynamic: true, size: 256 }));
        }

        return embed;
    }

    getPermissionTypeText(type) {
        switch (type) {
            case 'owners': return 'المالكين';
            case 'roles': return 'رولات محددة';
            case 'responsibility': return 'مسؤوليات محددة';
            default: return 'غير محدد';
        }
    }

    // Apply down to a member (remove role temporarily or permanently)
    // This is an alias to createDown for compatibility with commands/down.js
    async applyDown(member, role, duration, reason, moderator) {
        const downId = `${member.id}_${role.id}`;
        const result = await this.createDown(
            member.guild,
            this.client || require('../bot').client,
            member.id,
            role.id,
            duration,
            reason,
            moderator.id
        );

        if (result.success) {
            return {
                success: true,
                duration: result.duration,
                endTime: result.endTime ? `<t:${Math.floor(result.endTime / 1000)}:R>` : null
            };
        } else {
            return result;
        }
    }

    // Log down action to configured channel
    async logDownAction(guild, data) {
        try {
            const settings = this.getSettings();
            if (!settings.logChannel) return;

            if (!data?.user || !data?.role || !data?.moderator) {
                this.logAction('DOWN_SYSTEM', {
                    guildId: guild?.id,
                    type: data?.type || 'UNKNOWN',
                    moderatorId: data?.moderator?.id || data?.moderator?.user?.id || null,
                    reason: data?.reason || null,
                    timestamp: Date.now()
                });
                return;
            }

            const { logEvent } = require('./logs_system');

            logEvent(this.client || require('../bot').client, guild, {
                type: 'DOWN_SYSTEM',
                title: data.type === 'ROLE_REMOVED' ? 'Down Role Removed' : 'Down Action',
                details: `Role: ${data.role.name} | Duration: ${data.duration} | Reason: ${data.reason}`,
                user: data.moderator,
                fields: [
                    { name: 'Member', value: `<@${data.user.id}>`, inline: true },
                    { name: 'Removed Role', value: `<@&${data.role.id}>`, inline: true },
                    { name: 'Duration', value: data.duration, inline: true },
                    { name: 'Reason', value: data.reason, inline: false },
                    { name: 'Moderator', value: `<@${data.moderator.id}>`, inline: true },
                    { name: 'Ends At', value: data.endTime || 'Permanent', inline: true }
                ]
            });

        } catch (error) {
            console.error('Error logging down action:', error);
        }
    }

    // Remove active down from storage (using flat structure)
    removeActiveDown(downId) {
        try {
            const activeDowns = this.getActiveDowns();
            if (activeDowns[downId]) {
                delete activeDowns[downId];
                writeJson(activeDownsPath, activeDowns);
                return true;
            }
            return false;
        } catch (error) {
            console.error('Error removing active down:', error);
            return false;
        }
    }

    // فحص إذا كان البوت في عملية استعادة رول (لمنع التداخل)
    isBotRestoring(guildId, userId, roleId) {
        const restorationKey = `${guildId}_${userId}_${roleId}`;
        return this.botRestorationTracking.has(restorationKey);
    }

    // نظام حماية عند الانسحاب - حفظ بيانات الداون
    async handleMemberLeave(member) {
        try {
            if (!this.lockMemberLifecycle(member, 'leave')) {
                return;
            }

            const activeDowns = readJson(activeDownsPath, {});
            const leftMembersDowns = readJson(leftMembersDownsPath, {});
            const userDowns = [];

            // البحث عن الداونات النشطة للعضو
            for (const [downId, downData] of Object.entries(activeDowns)) {
                if (downData.userId === member.id && downData.guildId === member.guild.id && downData.roleId && downData.status === 'active') {
                    userDowns.push({ downId, ...downData });
                }
            }

            if (userDowns.length > 0) {
                // حفظ بيانات العضو المنسحب
                const memberKey = this.getMemberKey(member);
                const existingDowns = leftMembersDowns[memberKey]?.downs || [];
                const mergedDowns = this.mergeUniqueDowns([...existingDowns, ...userDowns]);

                leftMembersDowns[memberKey] = {
                    userId: member.id,
                    guildId: member.guild.id,
                    username: member.user.username,
                    displayName: member.displayName,
                    leftAt: Date.now(),
                    downs: mergedDowns
                };

                writeJson(leftMembersDownsPath, leftMembersDowns);

                // تسجيل انسحاب
                const settings = this.getSettings();
                if (settings.logChannel) {
                    try {
                        const logChannel = await member.guild.channels.fetch(settings.logChannel);
                        if (logChannel) {
                            // إضافة ملخص قصير للداونات المحفوظة
                            let downsList = '';
                            for (let i = 0; i < Math.min(mergedDowns.length, 5); i++) {
                                const downData = mergedDowns[i];
                                const role = await member.guild.roles.fetch(downData.roleId).catch(() => null);
                                const roleName = role ? role.name : `Role ID: ${downData.roleId}`;
                                const endTime = downData.endTime ? `<t:${Math.floor(downData.endTime / 1000)}:R>` : 'Permanent';
                                downsList += `- **${roleName}** — Ends ${endTime}\n`;
                            }

                            if (mergedDowns.length > 5) {
                                downsList += `- ${mergedDowns.length - 5} additional down(s)\n`;
                            }

                            await this.sendDownLog(logChannel, {
                                title: 'Member Left During Down',
                                details: `**Member:** <@${member.id}>\n**Active Downs:** ${mergedDowns.length}\n**Time:** <t:${Math.floor(Date.now() / 1000)}:R>\n\n**Role Summary**\n${(downsList || 'None').slice(0, 2200)}`,
                                thumbnailURL: member.displayAvatarURL({ dynamic: true, size: 256 }),
                                footer: 'Down Log • Member Left'
                            });
                        }
                    } catch (error) {
                        console.error('خطأ في إرسال لوق الانسحاب:', error);
                    }
                }

                console.log(`🚪 تم حفظ ${mergedDowns.length} داون للعضو المنسحب: ${member.displayName}`);
            }

        } catch (error) {
            console.error('خطأ في معالجة انسحاب العضو:', error);
        }
    }

    // نظام حماية عند العودة - إعادة تطبيق الداون
    async handleMemberJoin(member) {
        try {
            if (!this.lockMemberLifecycle(member, 'join')) {
                return;
            }

            const leftMembersDowns = readJson(leftMembersDownsPath, {});
            const memberKey = this.getMemberKey(member);
            const memberData = leftMembersDowns[memberKey];

            if (memberData && memberData.downs && memberData.downs.length > 0) {
                let activeDowns = readJson(activeDownsPath, {});
                memberData.downs = this.mergeUniqueDowns(memberData.downs);
                let restoredDowns = 0;
                let expiredDownsProcessed = 0;
                const failedDowns = [];

                for (const downData of memberData.downs) {
                    try {
                        // فحص إذا كان الداون منتهي الصلاحية
                        if (downData.endTime && downData.endTime <= Date.now()) {
                            const downId = String(downData.downId || downData.id || '');
                            if (!downId) {
                                failedDowns.push({ reason: 'معرف الداون غير موجود', roleId: downData.roleId });
                                continue;
                            }
                            const expiredRecord = {
                                ...downData,
                                ...(activeDowns[downId] || {}),
                                id: downData.id || downId,
                                downId,
                                status: 'active',
                                responsibilityRestorePending: true,
                                pendingEndReason: 'انتهاء الداون أثناء غياب العضو'
                            };
                            activeDowns[downId] = expiredRecord;
                            if (!writeJson(activeDownsPath, activeDowns)) {
                                failedDowns.push({ downId, reason: 'تعذر حفظ استعادة الداون المنتهي', roleId: downData.roleId });
                                continue;
                            }
                            const completion = await this.completeDownSuspension(
                                expiredRecord, member.guild, member, 'انتهاء الداون أثناء غياب العضو'
                            );
                            activeDowns = this.getActiveDowns();
                            if (!completion.success) {
                                failedDowns.push({ downId, reason: completion.error, roleId: downData.roleId });
                            } else {
                                expiredDownsProcessed++;
                            }
                            continue;
                        }

                        // التحقق من وجود الرول
                        const role = await member.guild.roles.fetch(downData.roleId).catch(() => null);
                        if (!role) {
                            failedDowns.push({
                                reason: 'الرول غير موجود',
                                roleId: downData.roleId
                            });
                            continue;
                        }

                        // التحقق من أن العضو يملك الرول
                        if (member.roles.cache.has(downData.roleId)) {
                            // سحب الرول مرة أخرى
                            await member.roles.remove(downData.roleId, `إعادة تطبيق داون بعد العودة: ${downData.reason}`);
                        }

                        // تحديث نفس سجل الداون الحالي بدل إنشاء سجل جديد (لتفادي التكرار)
                        const restoredDown = {
                            ...downData,
                            restoredAfterLeave: true,
                            restoredAt: Date.now(),
                            originalLeftAt: memberData.leftAt
                        };

                        activeDowns[downData.downId] = restoredDown;
                        restoredDowns++;

                    } catch (error) {
                        console.error(`خطأ في إعادة تطبيق داون:`, error);
                        failedDowns.push({
                            reason: error.message || 'خطأ غير معروف',
                            roleId: downData.roleId
                        });
                    }
                }

                // حفظ التغييرات
                if (restoredDowns > 0) {
                    writeJson(activeDownsPath, activeDowns);
                }

                // أبقِ نسخة العضو المنسحب فقط إذا فشل حفظ سجل الاستعادة النشط.
                const failedDownIds = new Set(failedDowns.map(item => String(item.downId || '')).filter(Boolean));
                const unresolvedLeftDowns = memberData.downs.filter(down => {
                    const downId = String(down.downId || down.id || '');
                    return failedDownIds.has(downId) && !activeDowns[downId];
                });
                if (unresolvedLeftDowns.length > 0) {
                    leftMembersDowns[memberKey] = { ...memberData, downs: unresolvedLeftDowns };
                } else {
                    delete leftMembersDowns[memberKey];
                }
                writeJson(leftMembersDownsPath, leftMembersDowns);

                // تسجيل العودة
                const settings = this.getSettings();
                if (settings.logChannel) {
                    try {
                        const logChannel = await member.guild.channels.fetch(settings.logChannel);
                        if (logChannel) {
                            const timeSinceLeft = Date.now() - memberData.leftAt;
                            const timeAwayText = timeSinceLeft > 3600000 ?
                                `${Math.floor(timeSinceLeft / 3600000)} hour(s)` :
                                `${Math.floor(timeSinceLeft / 60000)} minute(s)`;

                            await this.sendDownLog(logChannel, {
                                title: 'Member Returned During Down',
                                details: `**Member:** <@${member.id}>\n**Downs Reapplied:** ${restoredDowns}\n**Expired Downs Processed:** ${expiredDownsProcessed}\n**Restoration Failures:** ${failedDowns.length}\n**Time Away:** ${timeAwayText}`,
                                thumbnailURL: member.displayAvatarURL({ dynamic: true, size: 256 }),
                                footer: 'Down Log • Member Returned'
                            });
                        }
                    } catch (error) {
                        console.error('خطأ في إرسال لوق العودة:', error);
                    }
                }

                console.log(`🔄 تم إعادة تطبيق ${restoredDowns} داون للعضو العائد: ${member.displayName}`);
            }

        } catch (error) {
            console.error('خطأ في معالجة عودة العضو:', error);
        }
    }

    // معالجة انتهاء الداون لعضو خارج السيرفر
    async handleExpiredDownForLeftMember(expiredDown, guild, role) {
        const downId = String(expiredDown?.downId || expiredDown?.id || '');
        const logLockKey = downId || `${expiredDown?.guildId}_${expiredDown?.userId}_${expiredDown?.endTime}`;
        if (this.leftMemberExpiryLogs.has(logLockKey)) return false;

        const activeDowns = this.getActiveDowns();
        const storedDown = activeDowns[downId] || expiredDown;
        if (storedDown.leftMemberExpiryLogSentAt) {
            this.leftMemberExpiryLogs.add(logLockKey);
            return false;
        }

        this.leftMemberExpiryLogs.add(logLockKey);
        let sent = false;
        try {
            const settings = this.getSettings();
            if (!settings.logChannel) return false;

            const logChannel = await guild.channels.fetch(settings.logChannel).catch(() => null);
            if (!logChannel) return false;

            const leftUser = this.client.users.cache.get(expiredDown.userId)
                || await this.client.users.fetch(expiredDown.userId).catch(() => null);
            const byUserId = expiredDown.byUserId || expiredDown.moderatorId;
            const endTime = Number(expiredDown.endTime) || Date.now();
            const startTime = Number(expiredDown.startTime) || null;
            const details = [
                `**Member:** <@${expiredDown.userId}>`,
                `**Role:** ${role ? `<@&${role.id}>` : 'Unavailable'}`,
                `**Moderator:** ${byUserId ? `<@${byUserId}>` : 'Unknown'}`,
                `**Ended:** <t:${Math.floor(endTime / 1000)}:R>`,
                ...(startTime ? [`**Started:** <t:${Math.floor(startTime / 1000)}:R>`] : []),
                '',
                '**Reason**',
                String(expiredDown.reason || 'Unspecified').slice(0, 900)
            ].join('\n');
            const sentMessage = await this.sendDownLog(logChannel, {
                title: 'Down Expired While Member Away',
                details,
                thumbnailURL: leftUser?.displayAvatarURL({ dynamic: true, size: 256 }) || null,
                footer: 'Down Log • Member Away'
            });
            sent = true;

            storedDown.leftMemberExpiryLogSentAt = Date.now();
            if (sentMessage?.id) storedDown.leftMemberExpiryLogMessageId = sentMessage.id;
            if (downId) activeDowns[downId] = storedDown;
            if (!writeJson(activeDownsPath, activeDowns)) {
                console.error(`تعذر حفظ علامة سجل انتهاء الداون ${logLockKey}؛ سيمنع التكرار خلال التشغيل الحالي فقط.`);
            }

            console.log(`⏰ انتهت مدة داون لعضو خارج السيرفر: ${expiredDown.userId} (سجل واحد)`);
            return true;

        } catch (error) {
            console.error('خطأ في معالجة انتهاء داون عضو خارج:', error);
            return false;
        } finally {
            if (!sent) this.leftMemberExpiryLogs.delete(logLockKey);
        }
    }
}

module.exports = new DownManager();
