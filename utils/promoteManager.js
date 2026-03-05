const fs = require('fs');
const path = require('path');
// EmbedBuilder now handled by colorManager
const colorManager = require('./colorManager');
const ms = require('ms');

// File paths
const promoteSettingsPath = path.join(__dirname, '..', 'data', 'promoteSettings.json');
const activePromotesPath = path.join(__dirname, '..', 'data', 'activePromotes.json');
const promoteLogsPath = path.join(__dirname, '..', 'data', 'promoteLogs.json');
const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
const leftMembersPromotesPath = path.join(__dirname, '..', 'data', 'leftMembersPromotes.json');
const promoteBansPath = path.join(__dirname, '..', 'data', 'promoteBans.json');

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

async function writeJsonSafe(filePath, data) {
    const lockKey = filePath;

    // انتظار حتى يصبح الملف متاحاً للكتابة
    while (fileLocks.has(lockKey)) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }

    // قفل الملف
    fileLocks.set(lockKey, true);

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
    } finally {
        // إلغاء قفل الملف
        fileLocks.delete(lockKey);
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

class PromoteManager {
        // تتبع الرولات التي يضيفها البوت (استثناء من الحماية)

    
    constructor() {
        this.client = null;
        this.database = null;
        this.botPromotionTracking = new Set();
        this.ensureDataFiles();
        // قائمة تجاهل مؤقتة للرولات المُضافة تلقائياً
        this.autoPromoteIgnoreList = new Map();
        // قائمة تتبع الترقيات التي يقوم بها البوت (لمنع التداخل مع نظام الحماية)
        this.botPromotionTracking = new Set();
    }
// ================= PROMOTION PROTECTION =================

// هل العضو عليه Block ترقية نشط؟

getActivePromotionBlock(guildId, userId) {

    const promoteBans = readJson(promoteBansPath, {});

    const key = `${userId}_${guildId}`;

    const ban = promoteBans[key];

    if (!ban) return null;

    if (ban.endTime && ban.endTime < Date.now()) return null;

    return ban;

}

// تتبع إضافة رول من البوت (لتجاوز الحماية)

trackBotPromotion(guildId, userId, roleId) {

    const key = `${guildId}_${userId}_${roleId}`;

    this.botPromotionTracking.add(key);

    // إزالة التتبع تلقائياً

    setTimeout(() => {

        this.botPromotionTracking.delete(key);

    }, 15000);

}

// هل الرول أُضيف بواسطة البوت؟

isBotPromotion(guildId, userId, roleId) {

    return this.botPromotionTracking.has(`${guildId}_${userId}_${roleId}`);

}


    // Initialize with Discord client and database
    init(client, database = null) {
        this.client = client;
        this.database = database;
        this.startExpirationChecker(client);
        this.startBanMonitoring();
        // بدء مهام الصيانة فور التهيئة
        setTimeout(() => this.startMaintenanceTasks(), 5000); // تأخير 5 ثوانٍ
    
        // بدء تحديث المنيو التلقائي كل 30 ثانية
        this.startAutoMenuUpdate(client);
    }

    // تحديث المنيو تلقائياً كل 30 ثانية
    startAutoMenuUpdate(client) {
        setInterval(async () => {
            try {
                const settings = this.getSettings();
                if (!settings.menuChannel || !settings.menuMessageId) return;

                const channel = await client.channels.fetch(settings.menuChannel).catch(() => null);
                if (!channel) return;

                const message = await channel.messages.fetch(settings.menuMessageId).catch(() => null);
                if (!message) return;

                // تحديث الرسالة الحالية
                const promoteModule = require('../commands/promote.js');
                if (promoteModule && typeof promoteModule.updatePermanentMenu === 'function') {
                    await promoteModule.updatePermanentMenu(client, message);
                } else if (promoteModule && typeof promoteModule.createPermanentMenu === 'function') {
                    // Fallback to recreation if update is not exported correctly
                    await promoteModule.createPermanentMenu(client, settings.menuChannel);
                }
            } catch (error) {
                console.error('Error in auto menu update:', error);
            }
        }, 30000);
    }
    ensureDataFiles() {
        // Create default settings file
        if (!fs.existsSync(promoteSettingsPath)) {
            const defaultSettings = {
                menuChannel: null,
                logChannel: null,
                allowedUsers: {
                    type: null, // 'owners', 'roles', 'responsibility'
                    targets: []
                }
            };
            writeJson(promoteSettingsPath, defaultSettings);
        }

        // Create active promotes file
        if (!fs.existsSync(activePromotesPath)) {
            writeJson(activePromotesPath, {});
        }

        // Create logs file
        if (!fs.existsSync(promoteLogsPath)) {
            writeJson(promoteLogsPath, []);
        }

        // Create left members promotes file
        if (!fs.existsSync(leftMembersPromotesPath)) {
            writeJson(leftMembersPromotesPath, {});
        }

        // Create promote bans file
        if (!fs.existsSync(promoteBansPath)) {
            writeJson(promoteBansPath, {});
        }
    }

    // Settings Management
    getSettings() {
        const settings = readJson(promoteSettingsPath, {
            menuChannel: null,
            logChannel: null,
            allowedUsers: {
                type: null,
                targets: []
            }
        });
        // Ensure structure is maintained even if file was corrupted or empty
        if (!settings.allowedUsers) {
            settings.allowedUsers = { type: null, targets: [] };
        }
        return settings;
    }

    async updateSettings(newSettings) {
        return await writeJsonSafe(promoteSettingsPath, newSettings);
    }

    // Permission Checking
    async hasPermission(interaction, botOwners) {
        const settings = this.getSettings();
        const userId = interaction.user.id;

        // Bot owners always have permission
        if (botOwners.includes(userId)) return true;

        // Check configured permissions
        if (!settings.allowedUsers.type) return false;

        switch (settings.allowedUsers.type) {
            case 'owners':
                return botOwners.includes(userId);

            case 'roles':
                const userRoles = interaction.member.roles.cache.map(role => role.id);
                return settings.allowedUsers.targets.some(roleId => userRoles.includes(roleId));

            case 'responsibility':
                const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
                const responsibilities = readJson(responsibilitiesPath, {});

                for (const respName of settings.allowedUsers.targets) {
                    const respData = responsibilities[respName];
                    if (respData && respData.responsibles && respData.responsibles.includes(userId)) {
                        return true;
                    }
                }
                return false;
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

    // Role Hierarchy Validation for Promotions
    async validateRoleHierarchy(guild, targetUserId, roleId, promoterUserId) {
        try {
            const targetMember = await guild.members.fetch(targetUserId).catch(() => null);
            const promoterMember = await guild.members.fetch(promoterUserId).catch(() => null);
            const role = await guild.roles.fetch(roleId).catch(() => null);

            if (!targetMember || !promoterMember || !role) {
                return { valid: false, error: 'لا يمكن العثور على العضو أو الرول' };
            }

            // Get highest roles
            const promoterHighestRole = promoterMember.roles.highest;
            const adminRoles = this.getAdminRoles();
            const isTargetRoleRank = (role.name || '').length <= 3;

            // أعلى رول للعضو من نفس نوع العملية فقط (حرف/ظواهر)
            const targetHighestSameTypeRole = targetMember.roles.cache
                .filter((memberRole) => adminRoles.includes(memberRole.id) && ((memberRole.name || '').length <= 3) === isTargetRoleRank)
                .sort((a, b) => b.position - a.position)
                .first();

            // تحسين منطق التحقق: إذا كان الشخص المعين مالك البوت، يُسمح بالترقية بغض النظر عن الهرمية
            const botOwnersData = readJson(path.join(__dirname, '..', 'data', 'botConfig.json'), {});
            const botOwners = botOwnersData.owners || [];

            if (botOwners.includes(promoterUserId)) {
                // المالكون يمكنهم ترقية أي شخص لأي رول (طالما أن البوت يملك الصلاحية)
                return { valid: true };
            }

            // للأشخاص العاديين: الرول الجديد يجب أن يكون أعلى من أعلى رول للهدف من نفس النوع فقط
            if (targetHighestSameTypeRole && role.position <= targetHighestSameTypeRole.position) {
                return {
                    valid: false,
                    error: `لا يمكن الترقية: في نفس النوع (${isTargetRoleRank ? 'حرف' : 'ظواهر'}) العضو لديه رول أعلى/مساوٍ للرول المطلوب (الرول المطلوب: **${role.name}** | أعلى رول بنفس النوع: **${targetHighestSameTypeRole.name}**).`
                };
            }

            // الرول الجديد يجب أن يكون أقل من أعلى رول للمُرقي (إلا إذا كان مالك)
            if (role.position >= promoterHighestRole.position) {
                return {
                    valid: false,
                    error: `لا يمكنك ترقية شخص إلى رول (**${role.name}**) أعلى من أو مساوي لرولك الأعلى (**${promoterHighestRole.name}**)`
                };
            }

            return { valid: true };

        } catch (error) {
            console.error('Error validating role hierarchy:', error);
            return { valid: false, error: 'حدث خطأ في فحص الصلاحيات' };
        }
    }

    // Bot Permissions Validation
    async validateBotPermissionsOnly(guild, roleId) {
        try {
            const botMember = await guild.members.fetch(this.client.user.id);
            const role = await guild.roles.fetch(roleId);

            if (!role) {
                return { valid: false, error: 'الرول غير موجود' };
            }

            // Check if bot has permission to manage roles
            if (!botMember.permissions.has('ManageRoles')) {
                return { valid: false, error: 'البوت لا يملك صلاحية إدارة الرولات' };
            }

            // Check role hierarchy for bot
            if (role.position >= botMember.roles.highest.position) {
                return {
                    valid: false,
                    error: `الرول (**${role.name}**) أعلى من رول البوت - لا يمكن إدارته`
                };
            }

            return { valid: true };

        } catch (error) {
            console.error('Error validating bot permissions:', error);
            return { valid: false, error: 'حدث خطأ في فحص صلاحيات البوت' };
        }
    }

    // Get interaction statistics from database
    async getUserInteractionStats(userId) {
        let database = this.database;

        // Try to get database if not available
        if (!database) {
            try {
                const databaseModule = require('./database');
                database = databaseModule.getDatabase();
            } catch (error) {
                console.log('قاعدة البيانات غير متاحة للإحصائيات');
            }
        }

        if (!database) {
            return {
                totalVoiceTime: 0,
                totalMessages: 0,
                totalReactions: 0,
                totalSessions: 0,
                activeDays: 0
            };
        }

        try {
            const userStats = await database.get(`
                SELECT total_voice_time, total_messages, total_reactions,
                       total_sessions, active_days
                FROM user_totals
                WHERE user_id = ?
            `, [userId]);

            return {
                totalVoiceTime: userStats?.total_voice_time || 0,
                totalMessages: userStats?.total_messages || 0,
                totalReactions: userStats?.total_reactions || 0,
                totalSessions: userStats?.total_sessions || 0,
                activeDays: userStats?.active_days || 0
            };
        } catch (error) {
            console.error('Error getting user interaction stats:', error);
            return {
                totalVoiceTime: 0,
                totalMessages: 0,
                totalReactions: 0,
                totalSessions: 0,
                activeDays: 0
            };
        }
    }

    // Bulk Promotion Operations
    async createBulkPromotion(guild, client, targetUserId, sourceRoleId, targetRoleId, duration, reason, byUserId, isBulkOperation = true, sendDM = false) {
        try {
            const targetMember = await guild.members.fetch(targetUserId);
            const targetRole = await guild.roles.fetch(targetRoleId);
            
            if (targetMember && targetRole) {
                // حفظ الرولات الإدارية الحالية قبل الترقية الجماعية
                const adminRoles = this.getAdminRoles();
                const currentAdminRoles = targetMember.roles.cache.filter(r => 
                    r.name !== '@everyone' && adminRoles.includes(r.id)
                );

                // تطبيق الترقية
                const result = await this.createPromotion(guild, client, targetUserId, targetRoleId, duration, reason, byUserId, isBulkOperation, sendDM);

                // إزالة الرولات القديمة بناءً على المنطق الذكي (للترقيات الجماعية النهائية)
                if (result.success && (!duration || duration === 'نهائي')) {
                    for (const [oldRoleId, oldRole] of currentAdminRoles) {
                        if (oldRoleId !== targetRoleId && targetMember.roles.cache.has(oldRoleId)) {
                            const isNewRoleRank = targetRole.name.length <= 2;
                            const isOldRoleRank = oldRole.name.length <= 2;

                            if (isNewRoleRank === isOldRoleRank) {
                                await targetMember.roles.remove(oldRoleId, `إزالة الرول القديم (${isNewRoleRank ? 'حرف' : 'ظواهر'}) بعد الترقية الجماعية: ${reason}`);
                                console.log(`[Bulk-Smart Logic] تم إزالة ${oldRole.name} من ${targetMember.displayName}`);
                            }
                        }
                    }
                }
                return result;
            }
            return { success: false, error: 'العضو أو الرول غير موجود' };
        } catch (error) {
            console.error('Error in bulk promotion:', error);
            return { success: false, error: 'حدث خطأ أثناء الترقية الجماعية' };
        }
    }

    // Promotion Operations
    async createPromotion(guild, client, targetUserId, roleId, duration, reason, byUserId, isBulkOperation = false, sendDM = true, isMultiPromotion = false, transactionId = null) {
        try {
            // Input validation
            if (!guild || !targetUserId || !roleId || !byUserId) {
                return { success: false, error: 'معاملات مطلوبة مفقودة' };
            }

            // التحقق من صحة المدة - تقبل null للترقيات الدائمة
            if (duration !== null && duration !== undefined && duration !== 'نهائي' && typeof duration !== 'string') {
                return { success: false, error: 'مدة غير صحيحة' };
            }

            if (!reason || reason.trim().length === 0) {
                return { success: false, error: 'السبب مطلوب' };
            }

            // Validate admin role
            if (!this.isAdminRole(roleId)) {
                return { success: false, error: 'الرول المحدد ليس من الرولات الإدارية' };
            }

            // التحقق من صلاحيات البوت فقط
            const botValidation = await this.validateBotPermissionsOnly(guild, roleId);
            if (!botValidation.valid) {
                return { success: false, error: botValidation.error };
            }

            // فحص هرمية الرولات للترقية
            const hierarchyValidation = await this.validateRoleHierarchy(guild, targetUserId, roleId, byUserId);
            if (!hierarchyValidation.valid) {
                return { success: false, error: hierarchyValidation.error };
            }

            // Get target member with timeout protection
            const targetMember = await Promise.race([
                guild.members.fetch(targetUserId),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
            ]).catch(() => null);

            if (!targetMember) {
                return { success: false, error: 'العضو غير موجود أو لا يمكن الوصول إليه' };
            }

            // Get role with timeout protection
            const role = await Promise.race([
                guild.roles.fetch(roleId),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
            ]).catch(() => null);

            if (!role) {
                return { success: false, error: 'الرول غير موجود أو لا يمكن الوصول إليه' };
            }

            // Check if member already has the role
            if (targetMember.roles.cache.has(roleId)) {
                return { success: false, error: 'العضو يملك هذا الرول بالفعل' };
            }

            // Check if user is banned from promotions
            const promoteBans = readJson(promoteBansPath, {});
            const banKey = `${targetUserId}_${guild.id}`;
            if (promoteBans[banKey]) {
                const banData = promoteBans[banKey];
                const banEndTime = banData.endTime;

                if (!banEndTime || banEndTime > Date.now()) {
                    const banEndText = banEndTime ?
                        `<t:${Math.floor(banEndTime / 1000)}:R>` :
                        'نهائي';
                    return {
                        success: false,
                        error: `العضو محظور من الترقيات. ينتهي الحظر: ${banEndText}`
                    };
                }
            }

            // Get user interaction statistics
            const userStats = await this.getUserInteractionStats(targetUserId);

            // احفظ جميع الرولات الإدارية الحالية قبل الترقية فقط للترقيات النهائية المفردة
            const currentAdminRoles = targetMember.roles.cache.filter(r => 
                r.name !== '@everyone' && this.isAdminRole(r.id)
            );
            const previousHighestRole = targetMember.roles.highest;
            const previousRoleMention = previousHighestRole.id === guild.id ? '@everyone' : `<@&${previousHighestRole.id}>`;

            // تحديد إذا كان يجب إزالة الرولات القديمة (تم استبداله بالمنطق الذكي بالأسفل)
            const isPermanentPromotion = !duration || duration === null || duration === undefined || duration === 'نهائي';
            const shouldRemoveOldRoles = false; // تعطيل المنطق القديم لصالح المنطق الذكي المدمج بالأسفل

            // Add the role with error handling
            try {
                this.trackBotPromotion(guild.id, targetUserId, roleId);
                await targetMember.roles.add(roleId, `ترقية بواسطة ${await guild.members.fetch(byUserId).then(m => m.displayName).catch(() => 'غير معروف')}: ${reason}`);
            } catch (roleError) {
                console.error('Error adding role:', roleError);
                return { success: false, error: 'فشل في إضافة الرول - تحقق من صلاحيات البوت' };
            }

            // إزالة الرولات القديمة بناءً على قاعدة الـ 3 أحرف الذكية
            let removedOldRoles = [];
            for (const [oldRoleId, oldRole] of currentAdminRoles) {
                try {
                    // تأكد من أن الرول ليس هو نفسه الرول الجديد
                    if (oldRoleId !== roleId && targetMember.roles.cache.has(oldRoleId)) {
                        const newRoleName = role.name;
                        const oldRoleName = oldRole.name;

                        // قاعدة الـ 3 أحرف:
                        // إذا كان الرول الجديد <= 2 أحرف (حرف)، يزيل فقط الرولات اللي <= 2 أحرف
                        // إذا كان الرول الجديد > 2 أحرف (ظواهر)، يزيل فقط الرولات اللي > 2 أحرف
                        const isNewRoleRank = newRoleName.length <= 2;
                        const isOldRoleRank = oldRoleName.length <= 2;

                        if (isNewRoleRank === isOldRoleRank) {
                            await targetMember.roles.remove(oldRoleId, `إزالة الرول القديم (${isNewRoleRank ? 'حرف' : 'ظواهر'}) بعد الترقية: ${reason}`);
                            removedOldRoles.push(`<@&${oldRoleId}>`);
                            console.log(`[Smart Logic] تم إزالة ${oldRoleName} لأن الرول الجديد ${newRoleName} من نفس النوع`);
                        } else {
                            console.log(`[Smart Logic] تم الإبقاء على ${oldRoleName} لأن الرول الجديد ${newRoleName} من نوع مختلف`);
                        }
                    }
                } catch (removeError) {
                    console.error(`خطأ في إزالة الرول القديم ${oldRole.name}:`, removeError);
                }
            }

            // Calculate end time
            let endTime = null;
            if (duration && duration !== 'نهائي') {
                const durationMs = ms(duration);
                if (!durationMs || durationMs <= 0) {
                    return { success: false, error: 'صيغة المدة غير صحيحة' };
                }
                endTime = Date.now() + durationMs;
            }

            // Create promotion record
            const promoteId = `${targetUserId}_${roleId}_${Date.now()}`;
            const promoteRecord = {
                id: promoteId,
                userId: targetUserId,
                roleId: roleId,
                guildId: guild.id,
                reason: reason,
                byUserId: byUserId,
                startTime: Date.now(),
                endTime: endTime,
                duration: duration,
                status: 'active',
                userStats: userStats
            };

            // Save to active promotes
            const activePromotes = readJson(activePromotesPath, {});
            activePromotes[promoteId] = promoteRecord;
            writeJson(activePromotesPath, activePromotes);

            // Log and send log message only for single promotions (not multi-role or bulk)
            if (!isBulkOperation && !isMultiPromotion) {
                this.logAction('PROMOTION_APPLIED', {
                    targetUserId,
                    roleId,
                    guildId: guild.id,
                    duration,
                    reason,
                    byUserId,
                    userStats,
                    transactionId,
                    timestamp: Date.now()
                });

                // Send log message
                await this.sendLogMessage(guild, client, 'PROMOTION_APPLIED', {
                    targetUser: targetMember.user,
                    role: role,
                    previousRole: {
                        id: previousHighestRole.id,
                        mention: previousRoleMention
                    },
                    duration: duration || 'نهائي',
                    reason,
                    byUser: await client.users.fetch(byUserId),
                    userStats,
                    removedOldRoles: removedOldRoles,
                    removedOldRole: shouldRemoveOldRoles
                });
            }

            // Send private message to promoted user only if sendDM is true (handled externally for multi-promotions)
            if (sendDM && !isMultiPromotion) {
                try {
                    const dmEmbed = colorManager.createEmbed()
                        .setTitle('**تهانينا! تم ترقيتك**')
                        .setDescription(`تم ترقيتك في خادم **${guild.name}** من **${previousRoleMention}** إلى **${role}**`)
                        .addFields([
                            { name: '**معلومات الترقية**', value: 'تفاصيل الترقية', inline: false },
                            { name: '**من**', value: previousRoleMention, inline: true },
                            { name: '**إلى**', value: `**${role}**`, inline: true },
                            { name: '**المدة**', value: duration || 'نهائي', inline: true },
                            { name: '**السبب**', value: reason, inline: false },
                            { name: '**تم بواسطة**', value: `<@${byUserId}>`, inline: true },
                            { name: '**التاريخ**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                        ])
                        .setThumbnail(targetMember.displayAvatarURL({ dynamic: true }))
                        .setTimestamp()
                        .setFooter({ text: `خادم ${guild.name}`, iconURL: guild.iconURL({ dynamic: true }) });

                    // إضافة معلومة عن إزالة الرولات القديمة للترقية النهائية فقط
                    if (shouldRemoveOldRoles && removedOldRoles.length > 0) {
                        const removedRolesText = removedOldRoles.length === 1 ? 
                            `تم إزالة الرول السابق **${removedOldRoles[0]}**` :
                            `تم إزالة الرولات السابقة: **${removedOldRoles.join('**, **')}**`;

                        dmEmbed.addFields([
                            { name: '**ملاحظة مهمة**', value: `${removedRolesText} لأن الترقية نهائية`, inline: false }
                        ]);
                    }

                    await targetMember.send({ embeds: [dmEmbed] });
                } catch (dmError) {
                    console.log(`لا يمكن إرسال رسالة خاصة إلى ${targetMember.displayName}`);
                }
            }

            return {
                success: true,
                promoteId: promoteId,
                duration: duration,
                endTime: endTime,
                removedOldRoles: removedOldRoles,
                roleName: role.name,
                previousRoleMention: previousRoleMention
            };

        } catch (error) {
            console.error('Error creating promotion:', error);
            return { success: false, error: 'حدث خطأ أثناء تطبيق الترقية' };
        }
    }

    async endPromotion(guild, client, promoteId, reason = 'انتهاء المدة المحددة') {
        try {
            const activePromotes = readJson(activePromotesPath, {});
            const promoteRecord = activePromotes[promoteId];

            if (!promoteRecord) {
                return { success: false, error: 'الترقية غير موجودة' };
            }

            // Get member and role
            const member = await guild.members.fetch(promoteRecord.userId);
            const role = await guild.roles.fetch(promoteRecord.roleId);

            if (member && role) {
                // إضافة الرول لقائمة التجاهل قبل سحبه (للإنهاء اليدوي)
                this.addToAutoPromoteIgnore(promoteRecord.userId, promoteRecord.roleId);

                // تسجيل أن البوت سيقوم بسحب الرول (لمنع تداخل نظام الحماية)
                const removalKey = `${guild.id}_${promoteRecord.userId}_${promoteRecord.roleId}`;
                this.botPromotionTracking.add(removalKey);

                // إزالة المفتاح بعد 10 ثوانٍ
                setTimeout(() => {
                    this.botPromotionTracking.delete(removalKey);
                }, 10000);

                // Remove role
                await member.roles.remove(promoteRecord.roleId, `انتهاء ترقية مؤقتة: ${reason}`);

                // Send log message
                await this.sendLogMessage(guild, client, 'PROMOTION_ENDED', {
                    targetUser: member.user,
                    role: role,
                    reason,
                    originalReason: promoteRecord.reason,
                    duration: promoteRecord.duration || 'نهائي',
                    byUser: await client.users.fetch(promoteRecord.byUserId)
                });

                // Send private message to user
                try {
                    const dmEmbed = colorManager.createEmbed()
                        .setTitle('**انتهت مدة الترقية**')
                        .setDescription(`انتهت مدة ترقيتك في خادم **${guild.name}**`)
                        .addFields([
                            { name: '**الرول المُزال**', value: `${role.name}`, inline: true },
                            { name: '**سبب الإنهاء**', value: reason, inline: true },
                            { name: '**المدة الأصلية**', value: promoteRecord.duration || 'نهائي', inline: true },
                            { name: '**السبب الأصلي**', value: promoteRecord.reason, inline: false },
                            { name: '**وقت الإنهاء**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                        ])
                        .setThumbnail(member.displayAvatarURL({ dynamic: true }))
                        .setTimestamp();

                    await member.send({ embeds: [dmEmbed] });
                } catch (dmError) {
                    console.log(`لا يمكن إرسال رسالة خاصة إلى ${member.displayName}`);
                }
            }

            // Remove from active promotes
            delete activePromotes[promoteId];
            writeJson(activePromotesPath, activePromotes);

            // Log the action
            this.logAction('PROMOTION_ENDED', {
                targetUserId: promoteRecord.userId,
                roleId: promoteRecord.roleId,
                guildId: guild.id,
                reason,
                originalReason: promoteRecord.reason,
                duration: promoteRecord.duration,
                byUserId: promoteRecord.byUserId,
                timestamp: Date.now()
            });

            return { success: true };

        } catch (error) {
            console.error('Error ending promotion:', error);
            return { success: false, error: 'حدث خطأ أثناء إنهاء الترقية' };
        }
    }

    async modifyPromotionDuration(guild, client, promoteId, newDuration, modifiedBy) {
        try {
            const activePromotes = readJson(activePromotesPath, {});
            const promoteRecord = activePromotes[promoteId];

            if (!promoteRecord) {
                return { success: false, error: 'الترقية غير موجودة' };
            }

            const oldDuration = promoteRecord.duration || 'نهائي';

            // Calculate new end time
            let newEndTime = null;
            if (newDuration && newDuration !== 'نهائي') {
                const durationMs = ms(newDuration);
                if (!durationMs || durationMs <= 0) {
                    return { success: false, error: 'صيغة المدة غير صحيحة' };
                }
                newEndTime = Date.now() + durationMs;
            }

            // Update the record
            promoteRecord.duration = newDuration;
            promoteRecord.endTime = newEndTime;
            promoteRecord.modifiedBy = modifiedBy;
            promoteRecord.modifiedAt = Date.now();

            activePromotes[promoteId] = promoteRecord;
            writeJson(activePromotesPath, activePromotes);

            // Log the modification
            this.logAction('PROMOTION_MODIFIED', {
                targetUserId: promoteRecord.userId,
                roleId: promoteRecord.roleId,
                oldDuration,
                newDuration,
                modifiedBy,
                timestamp: Date.now()
            });

            // Send log message
            const member = await guild.members.fetch(promoteRecord.userId);
            const role = await guild.roles.fetch(promoteRecord.roleId);
            await this.sendLogMessage(guild, client, 'PROMOTION_MODIFIED', {
                targetUser: member.user,
                role: role,
                oldDuration,
                newDuration: newDuration || 'نهائي',
                modifiedBy: await client.users.fetch(modifiedBy)
            });

            return { success: true };

        } catch (error) {
            console.error('Error modifying promotion duration:', error);
            return { success: false, error: 'حدث خطأ أثناء تعديل المدة' };
        }
    }

    // Promotion Ban System
    async addPromotionBan(guild, client, targetUserId, duration, reason, byUserId) {
        try {
            const member = await guild.members.fetch(targetUserId);
            if (!member) {
                return { success: false, error: 'العضو غير موجود' };
            }

            // Calculate end time
            let endTime = null;
            if (duration && duration !== 'نهائي') {
                const durationMs = ms(duration);
                if (!durationMs || durationMs <= 0) {
                    return { success: false, error: 'صيغة المدة غير صحيحة' };
                }
                endTime = Date.now() + durationMs;
            }

            // Create ban record
            const banKey = `${targetUserId}_${guild.id}`;
            const banRecord = {
                userId: targetUserId,
                guildId: guild.id,
                reason: reason,
                byUserId: byUserId,
                startTime: Date.now(),
                endTime: endTime,
                duration: duration
            };

            // Save ban
            const promoteBans = readJson(promoteBansPath, {});
            promoteBans[banKey] = banRecord;
            writeJson(promoteBansPath, promoteBans);

            // Log the action
            this.logAction('PROMOTION_BAN_ADDED', {
                targetUserId,
                duration,
                reason,
                byUserId,
                timestamp: Date.now()
            });

            // Send log message
            await this.sendLogMessage(guild, client, 'PROMOTION_BAN_ADDED', {
                targetUser: member.user,
                duration: duration || 'نهائي',
                reason,
                byUser: await client.users.fetch(byUserId)
            });

            // Send private message to banned user
            try {
                const dmEmbed = colorManager.createEmbed()
                    .setTitle('**تم حظرك من الترقيات**')
                    .setDescription(`تم حظرك من الحصول على ترقيات في خادم **${guild.name}**`)
                    .addFields([
                        { name: '**المدة**', value: duration || 'نهائي', inline: true },
                        { name: '**السبب**', value: reason, inline: false },
                        { name: '**بواسطة**', value: `<@${byUserId}>`, inline: true },
                        { name: '**التاريخ**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ])
                    .setThumbnail(member.displayAvatarURL({ dynamic: true }))
                    .setTimestamp();

                if (endTime) {
                    dmEmbed.addFields([
                        { name: '**ينتهي الحظر**', value: `<t:${Math.floor(endTime / 1000)}:F>`, inline: true }
                    ]);
                }

                await member.send({ embeds: [dmEmbed] });
            } catch (dmError) {
                console.log(`لا يمكن إرسال رسالة خاصة إلى ${member.displayName}`);
            }

            return { success: true, endTime };

        } catch (error) {
            console.error('Error adding promotion ban:', error);
            return { success: false, error: 'حدث خطأ أثناء إضافة الحظر' };
        }
    }

    async removePromotionBan(guild, client, targetUserId, reason, byUserId) {
        try {
            const member = await guild.members.fetch(targetUserId);
            if (!member) {
                return { success: false, error: 'العضو غير موجود' };
            }

            const banKey = `${targetUserId}_${guild.id}`;
            const promoteBans = readJson(promoteBansPath, {});

            if (!promoteBans[banKey]) {
                return { success: false, error: 'العضو غير محظور من الترقيات' };
            }

            // Remove ban
            delete promoteBans[banKey];
            writeJson(promoteBansPath, promoteBans);

            // Log the action
            this.logAction('PROMOTION_BAN_REMOVED', {
                targetUserId,
                reason,
                byUserId,
                timestamp: Date.now()
            });

            // Send log message
            await this.sendLogMessage(guild, client, 'PROMOTION_BAN_REMOVED', {
                targetUser: member.user,
                reason,
                byUser: await client.users.fetch(byUserId)
            });

            // Send private message to unbanned user
            try {
                const dmEmbed = colorManager.createEmbed()
                    .setTitle('**تم إلغاء حظرك من الترقيات**')
                    .setDescription(`تم إلغاء حظرك من الترقيات في خادم **${guild.name}**`)
                    .addFields([
                        { name: '**السبب**', value: reason, inline: false },
                        { name: '**بواسطة**', value: `<@${byUserId}>`, inline: true },
                        { name: '**التاريخ**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ])
                    .setThumbnail(member.displayAvatarURL({ dynamic: true }))
                    .setTimestamp();

                await member.send({ embeds: [dmEmbed] });
            } catch (dmError) {
                console.log(`لا يمكن إرسال رسالة خاصة إلى ${member.displayName}`);
            }

            return { success: true };

        } catch (error) {
            console.error('Error removing promotion ban:', error);
            return { success: false, error: 'حدث خطأ أثناء إلغاء الحظر' };
        }
    }

    // Start ban monitoring system (every 10 seconds)
    startBanMonitoring() {
        setInterval(async () => {
            try {
                const expiredBans = this.getExpiredBans();
                for (const expiredBan of expiredBans) {
                    await this.processExpiredBan(expiredBan);
                }
            } catch (error) {
                console.error('Error in ban monitoring:', error);
            }
        }, 10000); // Check every 10 seconds
    }

    getExpiredBans() {
        const promoteBans = readJson(promoteBansPath, {});
        const now = Date.now();

        return Object.entries(promoteBans)
            .filter(([_, ban]) => ban.endTime && ban.endTime <= now)
            .map(([banKey, ban]) => ({ banKey, ...ban }));
    }

    async processExpiredBan(expiredBan) {
        try {
            if (!this.client) return;

            // إزالة الحظر من الملف
            const promoteBans = readJson(promoteBansPath, {});
            if (promoteBans[expiredBan.banKey]) {
                delete promoteBans[expiredBan.banKey];
                await writeJsonSafe(promoteBansPath, promoteBans);
            }

            // محاولة إرسال إشعار للمستخدم
            try {
                const user = await this.client.users.fetch(expiredBan.userId).catch(() => null);
                if (user) {
                    const dmEmbed = colorManager.createEmbed()
                        .setTitle('🎉 **تم إلغاء حظر الترقية**')
                        .setDescription(`انتهت مدة حظرك من الترقيات وأصبح بإمكانك الحصول على ترقيات مرة أخرى!`)
                        .addFields([
                            { name: '📅 **وقت الإلغاء**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                            { name: '⏱️ **السبب الأصلي**', value: expiredBan.reason || 'غير محدد', inline: false }
                        ])
                        .setColor('#00ff00')
                        .setTimestamp();

                    await user.send({ embeds: [dmEmbed] });
                }
            } catch (dmError) {
                console.log(`لا يمكن إرسال رسالة خاصة للمستخدم ${expiredBan.userId}`);
            }

            // تسجيل إلغاء الحظر في السجلات
            const guild = await this.client.guilds.fetch(expiredBan.guildId).catch(() => null);
            if (guild) {
                const settings = this.getSettings();
                if (settings.logChannel) {
                    try {
                        const logChannel = await guild.channels.fetch(settings.logChannel).catch(() => null);
                        if (logChannel) {
                            const logEmbed = colorManager.createEmbed()
                                .setTitle('✅ **انتهت مدة حظر الترقية - تم الإلغاء التلقائي**')
                                .setDescription(`انتهت مدة حظر عضو من الترقيات وتم إلغاء الحظر تلقائياً`)
                                .addFields([
                                    { name: '**العضو**', value: `<@${expiredBan.userId}>`, inline: true },
                                    { name: '**وقت الإلغاء**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                                    { name: '**السبب الأصلي**', value: expiredBan.reason || 'غير محدد', inline: false },
                                    { name: '**مدة الحظر الأصلية**', value: expiredBan.duration || 'غير محدد', inline: true },
                                    { name: '**تم الحظر بواسطة**', value: `<@${expiredBan.byUserId || 'غير معروف'}>`, inline: true }
                                ])
                                .setColor('#00ff00')
                                .setTimestamp();

                            await logChannel.send({ embeds: [logEmbed] });
                        }
                    } catch (logError) {
                        console.error('خطأ في إرسال سجل إلغاء الحظر:', logError);
                    }
                }
            }

            console.log(`تم إلغاء حظر الترقية للمستخدم ${expiredBan.userId} تلقائياً`);

        } catch (error) {
            console.error('خطأ في معالجة إلغاء حظر منتهي الصلاحية:', error);
        }
    }

    // Data Retrieval
    getActivePromotes() {
        return readJson(activePromotesPath, {});
    }

    // الحصول على السجلات المجمّعة بـ Transaction ID
    getGroupedPromotionLogs() {
        const logs = readJson(promoteLogsPath, []);
        const grouped = {};
        const standalone = [];

        logs.forEach(log => {
            if (log.data && log.data.transactionId) {
                const txId = log.data.transactionId;
                if (!grouped[txId]) {
                    grouped[txId] = [];
                }
                grouped[txId].push(log);
            } else {
                standalone.push(log);
            }
        });

        return { grouped, standalone };
    }

    // الحصول على سجلات ترقيات متعددة بـ Transaction ID
    getMultiPromotionsByTransaction(transactionId) {
        const logs = readJson(promoteLogsPath, []);
        return logs.filter(log => 
            log.data && 
            log.data.transactionId === transactionId
        ).sort((a, b) => a.timestamp - b.timestamp);
    }

    getSystemStats() {
        const logs = readJson(promoteLogsPath, []);
        const activePromotes = this.getActivePromotes();
        const settings = this.getSettings();

        // حساب إحصائيات مختلفة
        const totalPromotions = logs.filter(log => log.type === 'PROMOTION_APPLIED').length;
        const totalEnded = logs.filter(log => log.type === 'PROMOTION_ENDED').length;
        const activeCounts = Object.keys(activePromotes).length;

        return {
            totalPromotions,
            totalEnded,
            activeCounts,
            totalLogs: logs.length,
            systemStartTime: settings.systemStartTime || Date.now(),
            lastActivity: logs.length > 0 ? logs[logs.length - 1].timestamp : Date.now()
        };
    }

    getUserPromotes(userId) {
        const activePromotes = this.getActivePromotes();
        return Object.values(activePromotes).filter(promote => promote.userId === userId);
    }

    getUserPromoteHistory(userId) {
        const logs = readJson(promoteLogsPath, []);
        return logs.filter(log =>
            (log.type === 'PROMOTION_APPLIED' || log.type === 'PROMOTION_ENDED') &&
            log.data.targetUserId === userId
        );
    }

    getPromotionBans() {
        return readJson(promoteBansPath, {});
    }

    isUserBanned(userId, guildId) {
        const promoteBans = this.getPromotionBans();
        const banKey = `${userId}_${guildId}`;
        const banData = promoteBans[banKey];

        if (!banData) return false;

        // Check if ban is still active
        if (banData.endTime && banData.endTime <= Date.now()) {
            return false;
        }

        return true;
    }

    getExpiredPromotes() {
        const activePromotes = this.getActivePromotes();
        const now = Date.now();

        return Object.entries(activePromotes)
            .filter(([_, promote]) => promote.endTime && promote.endTime <= now)
            .map(([promoteId, promote]) => ({ promoteId, ...promote }));
    }

    // Logging
    async logAction(type, data) {
        const logs = readJson(promoteLogsPath, []);
        logs.push({
            type,
            data,
            timestamp: Date.now()
        });

        // Keep only last 1000 logs
        if (logs.length > 1000) {
            logs.splice(0, logs.length - 1000);
        }

        await writeJsonSafe(promoteLogsPath, logs);
    }

    async sendLogMessage(guild, client, type, data) {
        const settings = this.getSettings();
        if (!settings.logChannel) return;

        try {
            const channel = await guild.channels.fetch(settings.logChannel);
            if (!channel) return;

            const embed = this.createLogEmbed(type, data);

            // إضافة زر رؤية الأعضاء المترقين للترقيات الجماعية
            if (type === 'BULK_PROMOTION' && data.successfulMembers && data.successfulMembers.length > 0) {
                const { ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');

                const viewMembersButton = new ButtonBuilder()
                    .setCustomId(`bulk_promotion_members_${Date.now()}_${data.moderatorId}`)
                    .setLabel('احصائيات المترقين')
                    .setStyle(ButtonStyle.Secondary);

                const buttonRow = new ActionRowBuilder().addComponents(viewMembersButton);

                // حفظ قائمة الأعضاء المترقين في البوت للوصول إليها لاحقاً
                if (!client.bulkPromotionMembers) {
                    client.bulkPromotionMembers = new Map();
                }

                // تحويل الأعضاء إلى معرفات مناسبة
                const processedMembers = data.successfulMembers.map(member => {
                    if (typeof member === 'object' && member.id) {
                        return { id: member.id, displayName: member.displayName || 'Unknown' };
                    } else if (typeof member === 'object' && member.user && member.user.id) {
                        return { id: member.user.id, displayName: member.displayName || 'Unknown' };
                    } else if (typeof member === 'string' && /^\d{17,19}$/.test(member)) {
                        return { id: member, displayName: 'Unknown' };
                    } else if (typeof member === 'number') {
                        return { id: member.toString(), displayName: 'Unknown' };
                    }
                    return { id: member, displayName: 'Unknown' };
                });

                const membersData = {
                    successfulMembers: processedMembers,
                    sourceRoleId: data.sourceRoleId,
                    targetRoleId: data.targetRoleId,
                    reason: data.reason,
                    moderator: data.moderatorId,
                    timestamp: Date.now()
                };

                const buttonKey = `bulk_promotion_members_${Date.now()}_${data.moderatorId}`;
                client.bulkPromotionMembers.set(buttonKey, membersData);

                await channel.send({ embeds: [embed], components: [buttonRow] });
            } else {
                await channel.send({ embeds: [embed] });
            }
        } catch (error) {
            console.error('Error sending log message:', error);
        }
    }

    createLogEmbed(type, data) {
        const embed = colorManager.createEmbed()
            .setTimestamp();

        // إضافة أفتار البوت إذا كان متاحاً
        if (this.client && this.client.user) {
            embed.setThumbnail(this.client.user.displayAvatarURL({ dynamic: true, size: 256 }));
        }

        switch (type) {
            case 'PROMOTION_APPLIED':
                const promotionDescription = data.previousRole ?
                    `تم ترقية العضو <@${data.targetUser.id}> من ${data.previousRole.mention || data.previousRole.name} إلى <@&${data.role.id}>` :
                    `تم ترقية العضو <@${data.targetUser.id}> إلى <@&${data.role.id}>`;

                embed.setTitle('**تم تطبيق ترقية فردية**')
                    .setDescription(promotionDescription)
                    .addFields([
                        { name: '**العضو**', value: `<@${data.targetUser.id}>`, inline: true },
                        { name: '**الرول الجديد**', value: `<@&${data.role.id}>`, inline: true },
                        { name: '**المدة**', value: data.duration, inline: true },
                        { name: '**السبب**', value: data.reason, inline: false },
                        { name: '**بواسطة**', value: `<@${data.byUser.id}>`, inline: true },
                        { name: '**التاريخ**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ]);

                if (data.previousRole && data.previousRole.name !== 'لا يوجد رول') {
                    const oldRoleMention = data.previousRole.mention || `<@&${data.previousRole.id}>`;
                    const oldRoleText = data.removedOldRole ?
                        `${oldRoleMention} *(تم إزالته)*` :
                        oldRoleMention;
                    embed.addFields([{ name: '**الرول السابق**', value: oldRoleText, inline: true }]);
                }

                if (data.removedOldRole) {
                    embed.addFields([{ name: '**ملاحظة**', value: 'تم إزالة الرول السابق لأن الترقية نهائية', inline: false }]);
                }

                // إضافة إحصائيات التفاعل إذا كانت متاحة
                if (data.userStats) {
                    const voiceTimeHours = Math.round(data.userStats.totalVoiceTime / 3600000);
                    embed.addFields([
                        { name: '**إحصائيات العضو**', value: 'معلومات التفاعل', inline: false },
                        { name: '**الوقت الصوتي**', value: `${voiceTimeHours} ساعة`, inline: true },
                        { name: '**الرسائل**', value: `${data.userStats.totalMessages}`, inline: true },
                        { name: '**التفاعلات**', value: `${data.userStats.totalReactions}`, inline: true },
                        { name: '**الأيام النشطة**', value: `${data.userStats.activeDays}`, inline: true }
                    ]);
                }
                break;

            case 'BULK_PROMOTION':
                embed.setTitle('**تم ترقية رول**')
                    .addFields([
                        { name: '**من الرول:**', value: data.sourceRoleId ? `<@&${data.sourceRoleId}>` : (data.sourceRoleName || 'غير محدد'), inline: true },
                        { name: '**الى الرول:**', value: data.targetRoleId ? `<@&${data.targetRoleId}>` : (data.targetRoleName || 'غير محدد'), inline: true },
                        { name: '**بواسطة:**', value: `<@${data.moderatorId}>`, inline: true },
                        { name: '**السبب:**', value: data.reason, inline: false },
                        { name: '**المده:**', value: data.duration, inline: true },
                        { name: '**التاريخ:**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ])
                    .setColor(data.successCount > 0 ? '#00ff00' : '#ff0000');

                // إنشاء قائمة الأعضاء المتأثرين
                let affectedMembersText = '';

                // إضافة الأعضاء الناجحين
                if (data.successfulMembers && data.successfulMembers.length > 0) {
                    const successfulMentions = data.successfulMembers.map(member => {
                        if (typeof member === 'object' && member.id) {
                            return `<@${member.id}>`;
                        } else if (typeof member === 'string' && /^\d{17,19}$/.test(member)) {
                            return `<@${member}>`;
                        } else if (typeof member === 'number') {
                            return `<@${member}>`;
                        }
                        return `<@${member}>`;
                    });
                    
                    if (successfulMentions.length <= 10) {
                        affectedMembersText += successfulMentions.join(' ');
                    } else {
                        affectedMembersText += successfulMentions.slice(0, 10).join(' ');
                        affectedMembersText += `\n**و ${successfulMentions.length - 10} عضو آخر**`;
                    }
                }

                // إضافة الأعضاء الذين فشلت ترقيتهم
                if (data.failedMembers && data.failedMembers.length > 0) {
                    if (affectedMembersText) affectedMembersText += '\n\n';
                    affectedMembersText += '**الأعضاء الذين فشلت ترقيتهم:**\n';
                    data.failedMembers.slice(0, 5).forEach(failed => {
                        affectedMembersText += `<@${failed.id}> خطأ (${failed.reason})\n`;
                    });
                    if (data.failedMembers.length > 5) {
                        affectedMembersText += `**و ${data.failedMembers.length - 5} آخرين فشلوا**`;
                    }
                }

                // إضافة الأعضاء المحظورين
                if (data.bannedMembers && data.bannedMembers.length > 0) {
                    if (affectedMembersText) affectedMembersText += '\n\n';
                    affectedMembersText += '**الأعضاء المحظورين:**\n';
                    data.bannedMembers.slice(0, 5).forEach(banned => {
                        affectedMembersText += `<@${banned.id}> خطأ (${banned.reason})\n`;
                    });
                    if (data.bannedMembers.length > 5) {
                        affectedMembersText += `**و ${data.bannedMembers.length - 5} آخرين محظورين**`;
                    }
                }

                if (!affectedMembersText) {
                    affectedMembersText = 'لا يوجد أعضاء متأثرين';
                }

                // إضافة حقل الأعضاء المتأثرين
                if (affectedMembersText.length > 1024) {
                    affectedMembersText = affectedMembersText.substring(0, 1000) + '...\n**القائمة مقطوعة بسبب الطول**';
                }

                embed.addFields([
                    { name: '**الادارة المتاثرين:**', value: affectedMembersText, inline: false }
                ]);

                // إضافة إحصائيات في النهاية
                embed.addFields([
                    { name: '**إحصائيات:**', value: `✅ نجح: ${data.successCount} | ❌ فشل: ${data.failedCount} | 🚫 محظور: ${data.bannedCount} | 👥 الإجمالي: ${data.totalMembers}`, inline: false }
                ]);
                break;

            case 'PROMOTION_ENDED':
                embed.setTitle('**تم إنهاء ترقية**')
                    .addFields([
                        { name: '**معلومات إنهاء الترقية**', value: 'تفاصيل الإنهاء', inline: false },
                        { name: '**العضو**', value: `<@${data.targetUser.id}>`, inline: true },
                        { name: '**الرول**', value: `<@&${data.role.id}>`, inline: true },
                        { name: '**المدة الأصلية**', value: data.duration, inline: true },
                        { name: '**السبب الأصلي**', value: data.originalReason, inline: false },
                        { name: '**سبب الإنهاء**', value: data.reason, inline: false },
                        { name: '**الترقية كانت بواسطة**', value: `<@${data.byUser.id}>`, inline: true },
                        { name: '**تاريخ الإنهاء**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ]);
                break;

            case 'PROMOTION_MODIFIED':
                embed.setTitle('**تم تعديل مدة الترقية**')
                    .addFields([
                        { name: '**معلومات التعديل**', value: 'تفاصيل التعديل', inline: false },
                        { name: '**العضو**', value: `<@${data.targetUser.id}>`, inline: true },
                        { name: '**الرول**', value: `<@&${data.role.id}>`, inline: true },
                        { name: '**المدة القديمة**', value: data.oldDuration, inline: true },
                        { name: '**المدة الجديدة**', value: data.newDuration, inline: true },
                        { name: '**تم التعديل بواسطة**', value: `<@${data.modifiedBy.id}>`, inline: true },
                        { name: '**وقت التعديل**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ]);
                break;

            case 'PROMOTION_BAN_ADDED':
                embed.setTitle('**تم حظر عضو من الترقيات**')
                    .addFields([
                        { name: '**معلومات الحظر**', value: 'تفاصيل الحظر', inline: false },
                        { name: '**العضو**', value: `<@${data.targetUser.id}>`, inline: true },
                        { name: '**مدة الحظر**', value: data.duration || 'نهائي', inline: true },
                        { name: '**السبب**', value: data.reason, inline: false },
                        { name: '**بواسطة**', value: `<@${data.byUser.id}>`, inline: true },
                        { name: '**التاريخ**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ]);
                
                // إضافة وقت انتهاء الحظر إذا كان محدداً ورقمياً
                if (data.endTime && typeof data.endTime === 'number') {
                    embed.addFields([
                        { name: '**ينتهي الحظر**', value: `<t:${Math.floor(data.endTime / 1000)}:F>`, inline: true }
                    ]);
                }
                break;

            case 'MULTI_PROMOTION_APPLIED':
                embed.setTitle('**تم تطبيق ترقية متعددة**')
                    .setDescription(`تم ترقية العضو <@${data.targetUser.id}> إلى عدة رولات إدارية`)
                    .addFields([
                        { name: '**العضو**', value: `<@${data.targetUser.id}>`, inline: true },
                        { name: '**عدد الرولات**', value: `${data.successCount}`, inline: true },
                        { name: '**المدة**', value: data.duration, inline: true },
                        { name: '**السبب**', value: data.reason, inline: false },
                        { name: '**بواسطة**', value: `<@${data.byUser.id}>`, inline: true },
                        { name: '**التاريخ**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ]);

                // إضافة قائمة الرولات الجديدة
                if (data.roles && data.roles.length > 0) {
                    const rolesText = data.roles.map(role => `• <@&${role.id}>`).join('\n');
                    embed.addFields([
                        { name: '**الرولات الجديدة**', value: rolesText, inline: false }
                    ]);
                }

                // إضافة معلومات الرولات المُزالة إذا وجدت
                if (data.removedOldRoles && data.removedOldRoles.length > 0) {
                    const removedText = data.removedOldRoles.map(roleMention => `• ${roleMention}`).join('\n');
                    embed.addFields([
                        { name: '**الرولات المُزالة**', value: removedText, inline: false },
                        { name: '**سبب الإزالة**', value: 'ترقية نهائية - تم إزالة الرولات الإدارية السابقة', inline: false }
                    ]);
                }

                // إضافة معلومات الفشل إن وجدت
                if (data.failedCount > 0) {
                    embed.addFields([
                        { name: '**ملاحظة**', value: `${data.failedCount} رول فشل في الإضافة`, inline: true }
                    ]);
                }
                break;

            case 'PROMOTION_BAN_REMOVED':
                embed.setTitle('**تم إلغاء حظر عضو من الترقيات**')
                    .addFields([
                        { name: '**معلومات إلغاء الحظر**', value: 'تفاصيل إلغاء الحظر', inline: false },
                        { name: '**العضو**', value: `<@${data.targetUser.id}>`, inline: true },
                        { name: '**السبب**', value: data.reason, inline: false },
                        { name: '**بواسطة**', value: `<@${data.byUser.id}>`, inline: true },
                        { name: '**التاريخ**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ]);
                break;
        }

        return embed;
    }

    // Auto expiration checker with notification
    startExpirationChecker(client) {
        this.client = client; // Store client reference
        setInterval(async () => {
            try {
                const expiredPromotes = this.getExpiredPromotes();

                // تجميع الترقيات المنتهية حسب المستخدم والسيرفر
                const groupedExpired = this.groupExpiredPromotionsByUser(expiredPromotes);

                for (const [userGuildKey, userPromotes] of Object.entries(groupedExpired)) {
                    if (userPromotes.length === 1) {
                        // ترقية واحدة فقط - استخدام النظام العادي
                        await this.processExpiredPromotion(userPromotes[0]);
                    } else {
                        // ترقيات متعددة - استخدام النظام الموحد
                        await this.processMultipleExpiredPromotions(userPromotes);
                    }
                }
            } catch (error) {
                console.error('Error in promotion expiration checker:', error);
            }
        }, 60000); // Check every minute
    }

    // تجميع الترقيات المنتهية حسب المستخدم والسيرفر
    groupExpiredPromotionsByUser(expiredPromotes) {
        const grouped = {};

        for (const expiredPromote of expiredPromotes) {
            const key = `${expiredPromote.userId}_${expiredPromote.guildId}`;
            if (!grouped[key]) {
                grouped[key] = [];
            }
            grouped[key].push(expiredPromote);
        }

        return grouped;
    }

    // معالجة عدة ترقيات منتهية لنفس المستخدم
    async processMultipleExpiredPromotions(expiredPromotes) {
        try {
            if (!this.client || expiredPromotes.length === 0) return;

            const firstPromote = expiredPromotes[0];
            const guild = await this.client.guilds.fetch(firstPromote.guildId).catch(() => null);
            if (!guild) {
                // إزالة جميع الترقيات من القائمة النشطة
                expiredPromotes.forEach(promote => this.removeActivePromotion(promote.id));
                return;
            }

            const member = await guild.members.fetch(firstPromote.userId).catch(() => null);

            // التعامل مع العضو غير الموجود في السيرفر
            if (!member) {
                await this.handleMultipleExpiredPromotionsForLeftMember(expiredPromotes, guild);
                expiredPromotes.forEach(promote => this.removeActivePromotion(promote.id));
                return;
            }

            const expiredRoles = [];
            const failedRoles = [];

            // معالجة كل رول
            for (const expiredPromote of expiredPromotes) {
                const role = await guild.roles.fetch(expiredPromote.roleId).catch(() => null);

                if (!role) {
                    failedRoles.push({
                        roleId: expiredPromote.roleId,
                        reason: 'الرول غير موجود',
                        originalReason: expiredPromote.reason
                    });
                    this.removeActivePromotion(expiredPromote.id);
                    continue;
                }

                try {
                    // إضافة الرول لقائمة التجاهل قبل سحبه تلقائياً
                    this.addToAutoPromoteIgnore(member.id, role.id);

                    // تسجيل أن البوت سيقوم بسحب الرول (لمنع تداخل نظام الحماية)
                    const removalKey = `${member.guild.id}_${member.id}_${role.id}`;
                    this.botPromotionTracking.add(removalKey);

                    // إزالة المفتاح بعد 10 ثوانٍ
                    setTimeout(() => {
                        this.botPromotionTracking.delete(removalKey);
                    }, 10000);

                    // Remove the temporary role
                    await member.roles.remove(role, 'انتهاء مدة الترقية المؤقتة');

                    expiredRoles.push({
                        id: role.id,
                        name: role.name,
                        originalReason: expiredPromote.reason,
                        duration: expiredPromote.duration,
                        byUserId: expiredPromote.byUserId
                    });

                    // Remove from active promotes
                    this.removeActivePromotion(expiredPromote.id);

                } catch (roleError) {
                    console.error(`خطأ في إزالة الرول ${role.name}:`, roleError);
                    failedRoles.push({
                        roleId: expiredPromote.roleId,
                        roleName: role.name,
                        reason: 'فشل في إزالة الرول',
                        originalReason: expiredPromote.reason
                    });
                }
            }

            // إرسال إشعار موحد للمستخدم
            if (expiredRoles.length > 0) {
                await this.sendUnifiedExpirationDM(member, expiredRoles, failedRoles);
            }

            // إرسال لوق موحد
            await this.sendUnifiedExpirationLog(guild, member, expiredRoles, failedRoles);

        } catch (error) {
            console.error('Error processing multiple expired promotions:', error);
        }
    }

    // إرسال رسالة خاصة موحدة لانتهاء عدة ترقيات
    async sendUnifiedExpirationDM(member, expiredRoles, failedRoles = []) {
        try {
            const guild = member.guild;
            const totalRoles = expiredRoles.length + failedRoles.length;

            const dmEmbed = colorManager.createEmbed()
                .setTitle('**انتهت مدة عدة ترقيات**')
                .setDescription(`انتهت مدة ${totalRoles} ترقية في سيرفر **${guild.name}**`)
                .setThumbnail(member.displayAvatarURL({ dynamic: true }))
                .setTimestamp();

            // إضافة الرولات المُزالة بنجاح
            if (expiredRoles.length > 0) {
                let rolesText = '';
                expiredRoles.forEach((role, index) => {
                    rolesText += `**${index + 1}.** ${role.name}\n`;
                    rolesText += `├─ **السبب الأصلي:** ${role.originalReason}\n`;
                    rolesText += `└─ **المدة الأصلية:** ${role.duration || 'نهائي'}\n\n`;
                });

                dmEmbed.addFields([
                    { 
                        name: `✅ **تم إزالة ${expiredRoles.length} رول بنجاح**`, 
                        value: rolesText.trim(), 
                        inline: false 
                    }
                ]);
            }

            // إضافة الرولات التي فشلت في الإزالة
            if (failedRoles.length > 0) {
                let failedText = '';
                failedRoles.forEach((failed, index) => {
                    failedText += `**${index + 1}.** ${failed.roleName || `ID: ${failed.roleId}`}\n`;
                    failedText += `└─ **السبب:** ${failed.reason}\n\n`;
                });

                dmEmbed.addFields([
                    { 
                        name: `⚠️ **فشل في إزالة ${failedRoles.length} رول**`, 
                        value: failedText.trim(), 
                        inline: false 
                    }
                ]);
            }

            dmEmbed.addFields([
                { name: '**وقت الانتهاء**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                { name: '**الإجمالي**', value: `${totalRoles} ترقية`, inline: true }
            ]);

            await member.send({ embeds: [dmEmbed] });
        } catch (dmError) {
            console.log(`لا يمكن إرسال رسالة خاصة موحدة إلى ${member.displayName}`);
        }
    }

    // إرسال لوق موحد لانتهاء عدة ترقيات
    async sendUnifiedExpirationLog(guild, member, expiredRoles, failedRoles = []) {
        try {
            const settings = this.getSettings();
            if (!settings.logChannel || !this.client) return;

            const logChannel = await this.client.channels.fetch(settings.logChannel).catch(() => null);
            if (!logChannel) return;

            const totalRoles = expiredRoles.length + failedRoles.length;

            const logEmbed = colorManager.createEmbed()
                .setTitle('**انتهت مدة عدة ترقيات - إزالة تلقائية**')
                .setDescription(`تم سحب عدة رولات تلقائياً بعد انتهاء المدة المحددة`)
                .addFields([
                    { name: '**العضو**', value: `<@${member.id}>`, inline: true },
                    { name: '**وقت الإزالة**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                    { name: '**الإجمالي**', value: `${totalRoles} ترقية`, inline: true }
                ])
                .setTimestamp();

            // إضافة الرولات المُزالة بنجاح
            if (expiredRoles.length > 0) {
                let rolesText = '';
                expiredRoles.forEach((role, index) => {
                    rolesText += `**${index + 1}.** <@&${role.id}>\n`;
                    rolesText += `├─ **السبب الأصلي:** ${role.originalReason}\n`;
                    rolesText += `├─ **المدة الأصلية:** ${role.duration || 'نهائي'}\n`;
                    rolesText += `└─ **تم تطبيقها بواسطة:** <@${role.byUserId}>\n\n`;
                });

                if (rolesText.length > 1024) {
                    rolesText = rolesText.substring(0, 1000) + '...\n**القائمة مقطوعة بسبب الطول**';
                }

                logEmbed.addFields([
                    { 
                        name: `✅ **تم إزالة ${expiredRoles.length} رول بنجاح**`, 
                        value: rolesText.trim(), 
                        inline: false 
                    }
                ]);
            }

            // إضافة الرولات التي فشلت في الإزالة
            if (failedRoles.length > 0) {
                let failedText = '';
                failedRoles.forEach((failed, index) => {
                    failedText += `**${index + 1}.** ${failed.roleName || `<@&${failed.roleId}>`}\n`;
                    failedText += `└─ **السبب:** ${failed.reason}\n\n`;
                });

                if (failedText.length > 1024) {
                    failedText = failedText.substring(0, 1000) + '...\n**القائمة مقطوعة بسبب الطول**';
                }

                logEmbed.addFields([
                    { 
                        name: `⚠️ **فشل في إزالة ${failedRoles.length} رول**`, 
                        value: failedText.trim(), 
                        inline: false 
                    }
                ]);
            }

            logEmbed.addFields([
                { name: '**نوع الإجراء**', value: 'إزالة تلقائية موحدة', inline: true },
                { name: '**نجح**', value: `${expiredRoles.length}`, inline: true },
                { name: '**فشل**', value: `${failedRoles.length}`, inline: true }
            ]);

            await logChannel.send({ embeds: [logEmbed] });

        } catch (logError) {
            console.error('خطأ في إرسال لوق انتهاء الترقيات الموحد:', logError);
        }
    }

    // معالجة انتهاء عدة ترقيات لعضو خارج السيرفر
    async handleMultipleExpiredPromotionsForLeftMember(expiredPromotes, guild) {
        try {
            const settings = this.getSettings();
            if (!settings.logChannel) return;

            const logChannel = await guild.channels.fetch(settings.logChannel).catch(() => null);
            if (!logChannel) return;

            const userId = expiredPromotes[0].userId;

            const embed = colorManager.createEmbed()
                .setTitle('**انتهت مدة عدة ترقيات - عضو خارج السيرفر**')
                .setDescription(`انتهت مدة ${expiredPromotes.length} ترقية لعضو غير موجود في السيرفر`)
                .addFields([
                    { name: '**العضو**', value: `<@${userId}>`, inline: true },
                    { name: '**الحالة**', value: 'خارج السيرفر', inline: true },
                    { name: '**وقت الانتهاء**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                    { name: '**عدد الترقيات**', value: `${expiredPromotes.length}`, inline: true }
                ])
                .setColor('#ffa500')
                .setTimestamp();

            // إضافة قائمة الرولات المنتهية
            let rolesText = '';
            for (let i = 0; i < Math.min(expiredPromotes.length, 10); i++) {
                const promote = expiredPromotes[i];
                const role = await guild.roles.fetch(promote.roleId).catch(() => null);
                const roleName = role ? role.name : `Role ID: ${promote.roleId}`;
                const endTime = promote.endTime ? `<t:${Math.floor(promote.endTime / 1000)}:R>` : 'نهائي';
                rolesText += `• **${roleName}** - ينتهي: ${endTime}\n`;
            }

            if (expiredPromotes.length > 10) {
                rolesText += `• **+${expiredPromotes.length - 10} ترقية إضافية**\n`;
            }

            embed.addFields([
                { name: '**الرولات المنتهية**', value: rolesText.trim() || 'لا توجد تفاصيل', inline: false },
                { name: '**ملاحظة هامة**', value: 'إذا عاد هذا العضو للسيرفر، لن تعود الترقيات تلقائياً', inline: false }
            ]);

            await logChannel.send({ embeds: [embed] });

            console.log(`انتهت مدة ${expiredPromotes.length} ترقية لعضو خارج السيرفر: ${userId}`);

        } catch (error) {
            console.error('خطأ في معالجة انتهاء ترقيات متعددة لعضو خارج:', error);
        }
    }

    // Process expired promotion with notification and role removal
    async processExpiredPromotion(expiredPromote) {
        try {
            if (!this.client) return;

            const guild = await this.client.guilds.fetch(expiredPromote.guildId).catch(() => null);
            if (!guild) return;

            const member = await guild.members.fetch(expiredPromote.userId).catch(() => null);
            const role = await guild.roles.fetch(expiredPromote.roleId).catch(() => null);

            // التعامل مع العضو غير الموجود في السيرفر
            if (!member) {
                await this.handleExpiredPromotionForLeftMember(expiredPromote, guild, role);
                this.removeActivePromotion(expiredPromote.id);
                return;
            }

            if (!role) {
                this.removeActivePromotion(expiredPromote.id);
                return;
            }

            // إضافة الرول لقائمة التجاهل قبل سحبه تلقائياً
            this.addToAutoPromoteIgnore(member.id, role.id);

            // تسجيل أن البوت سيقوم بسحب الرول (لمنع تداخل نظام الحماية)
            const removalKey = `${member.guild.id}_${member.id}_${role.id}`;
            this.botPromotionTracking.add(removalKey);

            // إزالة المفتاح بعد 10 ثوانٍ
            setTimeout(() => {
                this.botPromotionTracking.delete(removalKey);
            }, 10000);

            // Remove the temporary role
            await member.roles.remove(role, 'انتهاء مدة الترقية المؤقتة');

            // Notify the user via DM
            try {
                const dmEmbed = colorManager.createEmbed()
                    .setTitle('**انتهت مدة الترقية**')
                    .setDescription(`انتهت مدة ترقيتك في سيرفر **${guild.name}**`)
                    .addFields([
                        { name: '**الرول المُزال**', value: `${role.name}`, inline: true },
                        { name: '**وقت الانتهاء**', value: `<t:${this.formatTimestamp(Date.now()).unix}:f>`, inline: true },
                        { name: '**السبب الأصلي**', value: expiredPromote.reason || 'غير محدد', inline: false }
                    ])
                    .setThumbnail(member.displayAvatarURL({ dynamic: true }));

                await member.send({ embeds: [dmEmbed] });
            } catch (dmError) {
                console.log(`لا يمكن إرسال رسالة خاصة إلى ${member.displayName}`);
            }

            // Log the removal
            const settings = this.getSettings();
            if (settings.logChannel && this.client) {
                const logChannel = await this.client.channels.fetch(settings.logChannel);
                if (logChannel) {
                    const logEmbed = colorManager.createEmbed()
                        .setTitle('**انتهت مدة الترقية - تم الإزالة التلقائية**')
                        .setDescription(`تم سحب الرول تلقائياً بعد انتهاء المدة المحددة`)
                        .addFields([
                            { name: '**العضو**', value: `<@${member.id}>`, inline: true },
                            { name: '**الرول المُزال**', value: `<@&${role.id}>`, inline: true },
                            { name: '**وقت الإزالة**', value: `<t:${this.formatTimestamp(Date.now()).unix}:f>`, inline: true },
                            { name: '**السبب الأصلي**', value: expiredPromote.reason || 'غير محدد', inline: false },
                            { name: '**كانت الترقية بواسطة**', value: `<@${expiredPromote.byUserId || 'غير معروف'}>`, inline: true },
                            { name: '**نوع الإجراء**', value: 'إزالة تلقائية', inline: true }
                        ])
                        .setTimestamp();

                    await logChannel.send({ embeds: [logEmbed] });
                }
            }

            // Remove from active promotes
            this.removeActivePromotion(expiredPromote.id);

        } catch (error) {
            console.error('Error processing expired promotion:', error);
        }
    }

    // Utility functions
    formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        const unix = Math.floor(timestamp / 1000);
        return {
            date: date.toLocaleString('ar-SA'),
            unix: unix
        };
    }

    addToAutoPromoteIgnore(userId, roleId) {
        const key = `${userId}_${roleId}`;
        this.autoPromoteIgnoreList.set(key, Date.now());

        // إزالة من القائمة بعد 30 ثانية
        setTimeout(() => {
            this.autoPromoteIgnoreList.delete(key);
        }, 30000);
    }

    // Display functions for commands
    createActivePromotesEmbed(activePromotes) {
        const embed = colorManager.createEmbed()
            .setTitle('**الترقيات النشطة**')
            .setTimestamp();

        if (Object.keys(activePromotes).length === 0) {
            embed.setDescription('لا توجد ترقيات نشطة حالياً');
            return embed;
        }

        const promotes = Object.values(activePromotes);
        const totalPromotes = promotes.length;
        const temporaryPromotes = promotes.filter(p => p.endTime).length;
        const permanentPromotes = promotes.filter(p => !p.endTime).length;

        embed.setDescription(`**إجمالي الترقيات النشطة:** ${totalPromotes}\n**مؤقتة:** ${temporaryPromotes} | **دائمة:** ${permanentPromotes}`);

        // Display first 10 promotes
        for (let i = 0; i < Math.min(promotes.length, 10); i++) {
            const promote = promotes[i];
            const endTimeText = promote.endTime ?
                `<t:${Math.floor(promote.endTime / 1000)}:R>` :
                'دائمة';

            embed.addFields([{
                name: `**ترقية ${i + 1}**`,
                value: `**العضو:** <@${promote.userId}>\n**الرول:** <@&${promote.roleId}>\n**تنتهي:** ${endTimeText}\n**السبب:** ${promote.reason}`,
                inline: true
            }]);
        }

        if (promotes.length > 10) {
            embed.addFields([{
                name: '**ملاحظة**',
                value: `يتم عرض أول 10 ترقيات فقط من أصل ${promotes.length}`,
                inline: false
            }]);
        }

        return embed;
    }

    createSettingsEmbed() {
        const settings = this.getSettings();
        const embed = colorManager.createEmbed()
            .setTitle('**إعدادات نظام الترقيات**')
            .setTimestamp();

        // إضافة أفتار البوت
        if (this.client && this.client.user) {
            embed.setThumbnail(this.client.user.displayAvatarURL({ dynamic: true, size: 256 }));
        }

        embed.addFields([
            {
                name: '**قناة القائمة**',
                value: settings.menuChannel ? `<#${settings.menuChannel}>` : 'غير محدد',
                inline: true
            },
            {
                name: '**قناة السجلات**',
                value: settings.logChannel ? `<#${settings.logChannel}>` : 'غير محدد',
                inline: true
            },
            {
                name: '**نوع الصلاحية**',
                value: settings.allowedUsers.type || 'غير محدد',
                inline: true
            }
        ]);

        let allowedText = 'غير محدد';
        if (settings.allowedUsers.type === 'roles' && settings.allowedUsers.targets.length > 0) {
            allowedText = settings.allowedUsers.targets.map(roleId => `<@&${roleId}>`).join('\n');
        } else if (settings.allowedUsers.type === 'responsibility' && settings.allowedUsers.targets.length > 0) {
            allowedText = settings.allowedUsers.targets.join('\n');
        } else if (settings.allowedUsers.type === 'owners') {
            allowedText = 'مالكي البوت فقط';
        }

        embed.addFields([
            {
                name: '**المصرح لهم**',
                value: allowedText,
                inline: false
            }
        ]);

        return embed;
    }

    // Remove active promotion from storage
    removeActivePromotion(promoteId) {
        try {
            const activePromotes = this.getActivePromotes();
            if (activePromotes[promoteId]) {
                delete activePromotes[promoteId];
                writeJson(activePromotesPath, activePromotes);
                return true;
            }
            return false;
        } catch (error) {
            console.error('Error removing active promotion:', error);
            return false;
        }
    }

    // فحص إذا كان البوت في عملية ترقية (لمنع التداخل)
    isBotPromoting(guildId, userId, roleId) {
        const promotionKey = `${guildId}_${userId}_${roleId}`;
        return this.botPromotionTracking.has(promotionKey);
    }

    // Start maintenance tasks
    startMaintenanceTasks() {
        // تنظيف قائمة التجاهل كل 5 دقائق
        setInterval(() => {
            const now = Date.now();
            for (const [key, timestamp] of this.autoPromoteIgnoreList.entries()) {
                if (now - timestamp > 60000) { // 1 minute
                    this.autoPromoteIgnoreList.delete(key);
                }
            }
        }, 300000); // 5 minutes
        }
    startAutoMenuUpdate(client) {

        setInterval(async () => {

            try {

                const settings = this.getSettings();

                if (settings.menuChannel && settings.menuMessageId) {
                    const channel = await client.channels.fetch(settings.menuChannel).catch(() => null);
                    if (channel) {
                        const message = await channel.messages.fetch(settings.menuMessageId).catch(() => null);
                        if (message) {
                            // تحديث الرسالة الحالية
                            const promoteModule = require('../commands/promote.js');
                            if (promoteModule && typeof promoteModule.updatePermanentMenu === 'function') {
                                await promoteModule.updatePermanentMenu(client, message);
                            }
                        }
                    }
                }

            } catch (error) {

                console.error('خطأ في تحديث المنيو التلقائي:', error);

            }

        }, 10000); // تحديث كل 30 ثانية

    }

    // Member leave/join handlers for promotions
    
    // Member leave/join handlers for promotions
    async handleMemberLeave(member) {
        try {
            const leftMembersPromotes = readJson(leftMembersPromotesPath, {});
            const memberKey = `${member.id}_${member.guild.id}`;
            if (leftMembersPromotes[memberKey]) {
                delete leftMembersPromotes[memberKey];
                writeJson(leftMembersPromotesPath, leftMembersPromotes);
            }
        } catch (error) {
            console.error('خطأ في معالجة انسحاب العضو:', error);
        }
    }

    async handleMemberJoin(member) {
        try {
            const leftMembersPromotes = readJson(leftMembersPromotesPath, {});
            const memberKey = `${member.id}_${member.guild.id}`;
            if (leftMembersPromotes[memberKey]) {
                delete leftMembersPromotes[memberKey];
                writeJson(leftMembersPromotesPath, leftMembersPromotes);
            }
        } catch (error) {
            console.error('خطأ في معالجة عودة العضو:', error);
        }
    }

    // معالجة انتهاء الترقية لعضو خارج السيرفر
    async handleExpiredPromotionForLeftMember(expiredPromote, guild, role) {
        try {
            const settings = this.getSettings();
            if (!settings.logChannel) return;

            const logChannel = await guild.channels.fetch(settings.logChannel).catch(() => null);
            if (!logChannel) return;

            // إنشاء embed للعضو الخارج
            const embed = colorManager.createEmbed()
                .setTitle('**انتهت مدة الترقية - عضو خارج السيرفر**')
                .setDescription(`انتهت مدة الترقية لعضو غير موجود في السيرفر`)
                .addFields([
                    { name: '**العضو**', value: `<@${expiredPromote.userId}>`, inline: true },
                    { name: '**الحالة**', value: 'خارج السيرفر', inline: true },
                    { name: '**وقت الانتهاء**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                ])
                .setColor('#ffa500')
                .setTimestamp();

            if (role) {
                embed.addFields([
                    { name: '**الرول المنتهي**', value: `<@&${role.id}>`, inline: true },
                    { name: '**السبب الأصلي**', value: expiredPromote.reason || 'غير محدد', inline: false }
                ]);
            } else {
                embed.addFields([
                    { name: '**الرول المنتهي**', value: `Role ID: ${expiredPromote.roleId}`, inline: true },
                    { name: '**السبب الأصلي**', value: expiredPromote.reason || 'غير محدد', inline: false }
                ]);
            }

            // إضافة معلومات إضافية
            const byUser = await this.client.users.fetch(expiredPromote.byUserId).catch(() => null);
            if (byUser) {
                embed.addFields([{ name: '**تم تطبيقها بواسطة**', value: `<@${byUser.id}>`, inline: true }]);
            }

            const startTime = expiredPromote.startTime || Date.now();
            embed.addFields([{ name: '**تاريخ التطبيق**', value: `<t:${Math.floor(startTime / 1000)}:F>`, inline: true }]);

            // إضافة ملاحظة هامة
            embed.addFields([{
                name: '**ملاحظة هامة**',
                value: 'إذا عاد هذا العضو للسيرفر، لن تعود الترقية تلقائياً',
                inline: false
            }]);

            await logChannel.send({ embeds: [embed] });

            console.log(`انتهت مدة ترقية لعضو خارج السيرفر: ${expiredPromote.userId}`);

        } catch (error) {
            console.error('خطأ في معالجة انتهاء ترقية عضو خارج:', error);
        }
    }

    // Additional function aliases needed by promote.js
    async getUserPromotionRecords(userId, guildId) {
        try {
            const logs = readJson(promoteLogsPath, []);
            return logs.filter(log => {
                if (!log.data) return false;
                
                // التحقق من guildId إذا تم تحديده
                if (guildId && log.data.guildId && log.data.guildId !== guildId) {
                    return false;
                }
                
                // سجلات الترقية الفردية
                if ((log.type === 'PROMOTION_APPLIED' || log.type === 'PROMOTION_ENDED') && 
                    log.data.targetUserId === userId) {
                    return true;
                }
                
                // سجلات الترقية الجماعية
                if (log.type === 'BULK_PROMOTION' && log.data.successfulMembers) {
                    const members = log.data.successfulMembers;
                    return members.some(member => {
                        if (typeof member === 'string') return member === userId;
                        if (typeof member === 'object' && member.id) return member.id === userId;
                        return false;
                    });
                }
                
                // سجلات الترقية المتعددة
                if (log.type === 'MULTI_PROMOTION_APPLIED' && log.data.targetUserId === userId) {
                    return true;
                }
                
                return false;
            }).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)); // Sort by newest first
        } catch (error) {
            console.error('Error getting user promotion records:', error);
            return [];
        }
    }

    async banFromPromotions(userId, guildId, duration, reason, byUserId) {
        // This is an alias for addPromotionBan
        if (!this.client) {
            return { success: false, error: 'البوت غير متاح' };
        }

        try {
            const guild = await this.client.guilds.fetch(guildId);
            return await this.addPromotionBan(guild, this.client, userId, duration, reason, byUserId);
        } catch (error) {
            console.error('Error in banFromPromotions:', error);
            return { success: false, error: 'حدث خطأ أثناء حظر العضو' };
        }
    }

    async unbanFromPromotions(userId, guildId, byUser) {
        // This is an alias for removePromotionBan
        if (!this.client) {
            return { success: false, error: 'البوت غير متاح' };
        }

        try {
            const guild = await this.client.guilds.fetch(guildId);
            const reason = 'تم إلغاء الحظر بواسطة أمر الترقيات';
            return await this.removePromotionBan(guild, this.client, userId, reason, byUser.id);
        } catch (error) {
            console.error('Error in unbanFromPromotions:', error);
            return { success: false, error: 'حدث خطأ أثناء إلغاء حظر العضو' };
        }
    }
}
// ================= PROMOTION PROTECTION =================

// هل العضو عليه Block ترقية نشط؟
// ================= PROMOTION PROTECTION =================

// هل العضو عليه Block ترقية نشط؟




    

module.exports = new PromoteManager();
