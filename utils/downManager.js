const fs = require('fs');
const path = require('path');
// EmbedBuilder now handled by colorManager
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
        this.memberLifecycleLocks = new Map();
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

    withEmbedIdentity(embed, user, label = 'Down System') {
        if (!user) return embed;
        embed.setAuthor({
            name: label,
            iconURL: user.displayAvatarURL({ dynamic: true, size: 128 })
        });
        return embed;
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
        return readJson(downSettingsPath, {
            menuChannel: null,
            logChannel: null,
            allowedUsers: {
                type: null,
                targets: []
            }
        });
    }

    updateSettings(newSettings) {
        return writeJson(downSettingsPath, newSettings);
    }

    // Permission Checking
    async hasPermission(interaction, botOwners) {
        const settings = this.getSettings() || {};
        const userId = interaction?.user?.id;
        const owners = Array.isArray(botOwners) ? botOwners : [];

        if (!userId) return false;

        // Bot owners always have permission
        if (owners.includes(userId)) return true;

        const allowedUsers = settings.allowedUsers || { type: null, targets: [] };
        const allowedTargets = Array.isArray(allowedUsers.targets) ? allowedUsers.targets : [];

        // Check configured permissions
        if (!allowedUsers.type) return false;

        switch (allowedUsers.type) {
            case 'owners':
                return owners.includes(userId);

            case 'roles': {
                const roleCache = interaction?.member?.roles?.cache;
                if (!roleCache) return false;
                const userRoles = roleCache.map(role => role.id);
                return allowedTargets.some(roleId => userRoles.includes(roleId));
            }

            case 'responsibility': {
                const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
                const responsibilities = readJson(responsibilitiesPath, {});

                for (const respName of allowedTargets) {
                    const respData = responsibilities[respName];
                    if (respData && respData.responsibles && respData.responsibles.includes(userId)) {
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

    // Down Operations
    async createDown(guild, client, targetUserId, roleId, duration, reason, byUserId) {
        try {
            duration = normalizeDuration(duration);
            const isVerbal = duration === 'شفوي' || duration === 'verbal';
            
            // Validate admin role (skip for verbal downs)
            if (!isVerbal && !this.isAdminRole(roleId)) {
                return { success: false, error: 'الرول المحدد ليس من الرولات الإدارية' };
            }

            // التحقق من صلاحيات البوت فقط (بدون فحص أمان الرولات) - تخطي للشفوي
            if (!isVerbal) {
                const validation = await this.validateBotPermissionsOnly(guild, roleId);
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
            const role = await guild.roles.fetch(roleId);
            if (!role && duration !== 'شفوي' && duration !== 'verbal') {
                return { success: false, error: 'الرول غير موجود' };
            }

            // Check if member has the role
            if (duration !== 'شفوي' && duration !== 'verbal' && !targetMember.roles.cache.has(roleId)) {
                return { success: false, error: 'العضو لا يملك هذا الرول' };
            }

            // Remove the role with error handling
            if (duration !== 'شفوي' && duration !== 'verbal') {
                try {
                    await targetMember.roles.remove(roleId, `داون بواسطة ${await guild.members.fetch(byUserId).then(m => m.displayName).catch(() => 'غير معروف')}: ${reason}`);
                } catch (roleError) {
                    console.error('Error removing role:', roleError);
                    return { success: false, error: 'فشل في سحب الرول - تحقق من صلاحيات البوت' };
                }
            }

            // Calculate end time
            let endTime = null;
            
            if (isVerbal) {
                // No end time for verbal, it's just a record
            } else if (duration !== 'permanent') {
                const durationMs = ms(duration);
                if (!durationMs) {
                    return { success: false, error: 'صيغة المدة غير صحيحة' };
                }
                endTime = Date.now() + durationMs;
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

            // Save to active downs
            const activeDowns = readJson(activeDownsPath, {});
            activeDowns[downId] = downRecord;
            writeJson(activeDownsPath, activeDowns);

            // Log the action
            this.logAction(isVerbal ? 'DOWN_VERBAL' : 'DOWN_APPLIED', {
                targetUserId,
                roleId: isVerbal ? null : roleId,
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

            // Get member and role
            const member = await guild.members.fetch(downRecord.userId);
            const role = await guild.roles.fetch(downRecord.roleId);

            if (member && role) {
                // إضافة الرول لقائمة التجاهل قبل إرجاعه (للإنهاء اليدوي)
                this.addToAutoRestoreIgnore(downRecord.userId, downRecord.roleId);

                // تسجيل أن البوت سيقوم بإعادة الرول (لمنع تداخل نظام الحماية)
                const restorationKey = `${guild.id}_${downRecord.userId}_${downRecord.roleId}`;
                this.botRestorationTracking.add(restorationKey);

                // إزالة المفتاح بعد 10 ثوانٍ
                setTimeout(() => {
                    this.botRestorationTracking.delete(restorationKey);
                }, 10000);

                // Add role back
                await member.roles.add(downRecord.roleId);

                // Send log message
                await this.sendLogMessage(guild, client, 'DOWN_ENDED', {
                    targetUser: member.user,
                    role: role,
                    reason,
                    originalReason: downRecord.reason,
                    duration: downRecord.duration || 'نهائي',
                    byUser: await client.users.fetch(downRecord.byUserId)
                });
            }

            // Remove from active downs
            delete activeDowns[downId];
            writeJson(activeDownsPath, activeDowns);

            // Log the action
            this.logAction('DOWN_ENDED', {
                targetUserId: downRecord.userId,
                roleId: downRecord.roleId,
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
            const activeDowns = readJson(activeDownsPath, {});
            const downRecord = activeDowns[downId];

            if (!downRecord) {
                return { success: false, error: 'الداون غير موجود' };
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
            downRecord.modifiedBy = modifiedBy;
            downRecord.modifiedAt = Date.now();

            activeDowns[downId] = downRecord;
            writeJson(activeDownsPath, activeDowns);

            // Log the modification
            this.logAction('DOWN_MODIFIED', {
                targetUserId: downRecord.userId,
                roleId: downRecord.roleId,
                oldDuration,
                newDuration,
                modifiedBy,
                timestamp: Date.now()
            });

            // Send log message
            const member = await guild.members.fetch(downRecord.userId);
            const role = await guild.roles.fetch(downRecord.roleId);
            await this.sendLogMessage(guild, client, 'DOWN_MODIFIED', {
                targetUser: member.user,
                role: role,
                oldDuration,
                newDuration: newDuration || 'نهائي',
                modifiedBy: await client.users.fetch(modifiedBy)
            });

            return { success: true };

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

    getUserDownHistory(userId) {
        const logs = readJson(downLogsPath, []);
        return logs.filter(log =>
            log?.data?.targetUserId === userId &&
            (
                log.type === 'DOWN_APPLIED' ||
                log.type === 'DOWN_ENDED' ||
                log.type === 'DOWN_VERBAL'
            )
        );
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
        logs.push({
            type,
            data,
            timestamp: Date.now()
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

        try {
            const channel = await guild.channels.fetch(settings.logChannel);
            if (!channel) return;

            const embed = this.createLogEmbed(type, data);
            await channel.send({ embeds: [embed] });
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
            case 'DOWN_APPLIED':
                embed.setTitle('Down Applied')
                    .setDescription(`تم سحب رول من <@${data.targetUser.id}>`)
                    .addFields([
                        { name: 'العضو', value: `<@${data.targetUser.id}>`, inline: true },
                        { name: 'الرول', value: `${data.role}`, inline: true },
                        { name: 'المدة', value: data.duration, inline: true },
                        { name: 'السبب', value: data.reason, inline: false },
                        { name: 'بواسطة', value: `<@${data.byUser.id}>`, inline: true },
                        { name: 'التاريخ', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ])
                    .setFooter({ text: 'Down Log • Action Applied' });

                this.withEmbedIdentity(embed, data.byUser, 'Moderator');
                break;

            case 'DOWN_ENDED':
                embed.setTitle('Down Ended')
                    .addFields([
                        { name: 'العضو', value: `${data.targetUser}`, inline: true },
                        { name: 'الرول', value: `${data.role}`, inline: true },
                        { name: 'المدة الأصلية', value: data.duration, inline: true },
                        { name: 'السبب الأصلي', value: data.originalReason, inline: false },
                        { name: 'سبب الإنهاء', value: data.reason, inline: false },
                        { name: 'الداون كان بواسطة', value: `${data.byUser}`, inline: true },
                        { name: 'تاريخ الإنهاء', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ])
                    .setFooter({ text: 'Down Log • Action Ended' });

                this.withEmbedIdentity(embed, data.targetUser, 'Member');
                break;
            case 'DOWN_VERBAL':
                embed.setTitle('Verbal Down')
                    .setDescription(`**تنبيه شفوي للعضو :** <@${data.targetUserId}>`)
                    .addFields([
                        { name: 'النوع', value: 'شفوي', inline: true },
                        { name: 'السبب', value: data.reason, inline: false },
                        { name: 'بواسطة', value: `<@${data.byUserId}>`, inline: true },
                        { name: 'التاريخ', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ])
                    .setFooter({ text: 'Down Log • Verbal Notice' });

                this.withEmbedIdentity(embed, data.byUser, 'Moderator');
                break;


            case 'DOWN_MODIFIED':
                embed.setTitle('Down Duration Updated')
                    .addFields([
                        { name: 'العضو', value: `${data.targetUser}`, inline: true },
                        { name: 'الرول', value: `${data.role}`, inline: true },
                        { name: 'المدة القديمة', value: data.oldDuration, inline: true },
                        { name: 'المدة الجديدة', value: data.newDuration, inline: true },
                        { name: 'تم التعديل بواسطة', value: `${data.modifiedBy}`, inline: true },
                        { name: 'وقت التعديل', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ])
                    .setFooter({ text: 'Down Log • Duration Changed' });

                this.withEmbedIdentity(embed, data.modifiedBy, 'Moderator');
                break;
        }

        return embed;
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

        for (const down of Object.values(activeDowns)) {
            try {
                if (!down || !down.roleId || down.status !== 'active') continue;

                if (down.endTime && down.endTime <= Date.now()) {
                    continue;
                }

                const guild = await this.client.guilds.fetch(down.guildId).catch(() => null);
                if (!guild) continue;

                const member = await guild.members.fetch(down.userId).catch(() => null);
                if (!member) continue;

                if (!member.roles.cache.has(down.roleId)) {
                    continue;
                }

                const role = await guild.roles.fetch(down.roleId).catch(() => null);
                if (!role) continue;

                await member.roles.remove(role, 'فحص تكاملي تلقائي لنظام الداون');
                fixedCount++;
                console.log(`🔒 Integrity check removed restored role ${role.name} from ${member.displayName}`);

                if (settings.logChannel) {
                    const logChannel = await guild.channels.fetch(settings.logChannel).catch(() => null);
                    if (logChannel) {
                        const embed = colorManager.createEmbed()
                            .setTitle('Down Integrity Check Triggered')
                            .setDescription('تم اكتشاف أن العضو استرجع رولاً وهو ما زال تحت داون نشط، وتمت إزالته تلقائياً بواسطة فحص التكامل الدوري.')
                            .addFields([
                                { name: ' العضو', value: `<@${member.id}>`, inline: true },
                                { name: ' الرول', value: `<@&${role.id}>`, inline: true },
                                { name: ' نوع الفحص', value: 'دوري كل دقيقتين', inline: true },
                                { name: ' سبب الداون', value: down.reason || 'غير محدد', inline: false },
                                { name: ' ينتهي الداون', value: down.endTime ? `<t:${Math.floor(down.endTime / 1000)}:R>` : 'نهائي', inline: true }
                            ])
                            .setTimestamp();

                        await logChannel.send({ embeds: [embed] }).catch(() => null);
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
            const role = await guild.roles.fetch(expiredDown.roleId).catch(() => null);

            // التعامل مع العضو غير الموجود في السيرفر
            if (!member) {
                await this.handleExpiredDownForLeftMember(expiredDown, guild, role);
                this.removeActiveDown(expiredDown.id || expiredDown.downId);
                return;
            }

            if (!role) {
                this.removeActiveDown(expiredDown.id || expiredDown.downId);
                return;
            }

            // إضافة الرول لقائمة التجاهل قبل إرجاعه تلقائياً
            this.addToAutoRestoreIgnore(member.id, role.id);

            // تسجيل أن البوت سيقوم بإعادة الرول (لمنع تداخل نظام الحماية)
            const restorationKey = `${member.guild.id}_${member.id}_${role.id}`;
            this.botRestorationTracking.add(restorationKey);

            // إزالة المفتاح بعد 10 ثوانٍ
            setTimeout(() => {
                this.botRestorationTracking.delete(restorationKey);
            }, 10000);

            // Restore the role
            await member.roles.add(role, 'إعادة رول بعد انتهاء مدة الداون');

            // Notify the user via DM
            try {
                const dmEmbed = colorManager.createEmbed()
                    .setTitle('تمت إعادة الرول')
                    .setDescription(`تم إعادة الرول **${role.name}** إليك بعد انتهاء مدة الداون.`)
                    .addFields([
                        { name: 'الرول', value: `${role.name}`, inline: true },
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
                    const logEmbed = colorManager.createEmbed()
                        .setTitle ('Down Ended')
                        .setDescription(`تم إعادة الرول تلقائياً بعد انتهاء المدة المحددة`)
                        .addFields([
                            { name: 'العضو', value: `<@${member.id}>`, inline: true },
                            { name: 'الرول المُعاد', value: `<@&${role.id}>`, inline: true },
                            { name: 'وقت الإعادة', value: `<t:${this.formatTimestamp(Date.now()).unix}:f>`, inline: true },
                            { name: 'السبب الأصلي', value: expiredDown.reason || 'غير محدد', inline: false },
                            { name: ' كان الداون بواسطة', value: `<@${expiredDown.byUserId || expiredDown.moderatorId || 'غير معروف'}>`, inline: true },
                            { name: 'Status', value: 'Restored', inline: true }
                        ])
                        .setFooter({ text: 'Down Log • Auto Restore' })
                        .setTimestamp();

                    this.withEmbedIdentity(logEmbed, member.user, 'Member');

                    await logChannel.send({ embeds: [logEmbed] });
                }
            }

            // Remove from active downs
            this.removeActiveDown(expiredDown.id || expiredDown.downId);

            console.log(`✅ تمت إعادة الرول ${role.name} إلى ${member.displayName} تلقائياً`);

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
    async validateBotPermissions(guild, roleId) {
        try {
            const role = await guild.roles.fetch(roleId);
            if (!role) {
                return { valid: false, error: 'الرول غير موجود' };
            }

            const botMember = await guild.members.fetch(guild.client.user.id);

            // التحقق من الرولات الخطرة
            if (this.isDangerousRole(role, guild)) {
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

            // تنظيف الداونات المنتهية الصلاحية من activeDowns
            const activeDowns = readJson(activeDownsPath, {});
            let cleaned = false;

            for (const [downId, down] of Object.entries(activeDowns)) {
                if (down.endTime && down.endTime < Date.now()) {
                    delete activeDowns[downId];
                    cleaned = true;
                }
            }

            if (cleaned) {
                writeJson(activeDownsPath, activeDowns);
                console.log('🧹 تم تنظيف الداونات المنتهية الصلاحية');
            }

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
                if (!down.userId || !down.roleId || !down.guildId) {
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

            const { logEvent } = require('./logs_system');

            logEvent(this.client || require('../bot').client, guild, {
                type: 'DOWN_SYSTEM',
                title: data.type === 'ROLE_REMOVED' ? 'تم سحب رول' : 'تم تطبيق إجراء',
                description: `تم تطبيق داون على العضو ${data.user.username}`,
                details: `الرول: ${data.role.name} | المدة: ${data.duration} | السبب: ${data.reason}`,
                user: data.moderator,
                fields: [
                    { name: 'لعضو المتأثر', value: `<@${data.user.id}>`, inline: true },
                    { name: 'الرول المسحوب', value: `<@&${data.role.id}>`, inline: true },
                    { name: ' المدة', value: data.duration, inline: true },
                    { name: ' السبب', value: data.reason, inline: false },
                    { name: ' بواسطة', value: `<@${data.moderator.id}>`, inline: true },
                    { name: ' ينتهي في', value: data.endTime || 'نهائي', inline: true }
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

    // Alias for compatibility with commands/down.js
    async logDownAction(guild, data) {
        return await this.logAction('DOWN_SYSTEM', {
            userId: data.user.id,
            roleId: data.role.id,
            guildId: guild.id,
            moderatorId: data.moderator.id,
            reason: data.reason,
            duration: data.duration,
            endTime: data.endTime,
            type: data.type
        });
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
                if (downData.userId === member.id && downData.guildId === member.guild.id) {
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
                            const embed = colorManager.createEmbed()
                                .setTitle('Member Left with Active Downs')
                                .setDescription('خرج عضو عليه داون من السيرفر، وتم حفظ بيانات الداون تلقائياً لضمان استمرار الحماية عند العودة.')
                                .addFields([
                                    { name: ' العضو', value: `<@${member.id}>`, inline: true },
                                    { name: ' وقت الانسحاب', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                                    { name: ' عدد الداونات', value: mergedDowns.length.toString(), inline: true }
                                ])
                                .setFooter({ text: 'Down Log • Member Leave' })
                                .setTimestamp();

                            this.withEmbedIdentity(embed, member.user, 'Member');

                            // إضافة تفاصيل الداونات
                            let downsList = '';
                            for (let i = 0; i < Math.min(mergedDowns.length, 5); i++) {
                                const downData = mergedDowns[i];
                                const role = await member.guild.roles.fetch(downData.roleId).catch(() => null);
                                const roleName = role ? role.name : `Role ID: ${downData.roleId}`;
                                const endTime = downData.endTime ? `<t:${Math.floor(downData.endTime / 1000)}:R>` : 'نهائي';
                                downsList += `• **${roleName}** - ينتهي: ${endTime}\n`;
                            }

                            if (mergedDowns.length > 5) {
                                downsList += `• **+${mergedDowns.length - 5} داون إضافي**\n`;
                            }

                            embed.addFields([{ name: '📋 الداونات المحفوظة', value: downsList || 'لا توجد', inline: false }]);

                            await logChannel.send({ embeds: [embed] });
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
                const activeDowns = readJson(activeDownsPath, {});
                memberData.downs = this.mergeUniqueDowns(memberData.downs);
                let restoredDowns = 0;
                const failedDowns = [];

                for (const downData of memberData.downs) {
                    try {
                        // فحص إذا كان الداون منتهي الصلاحية
                        if (downData.endTime && downData.endTime <= Date.now()) {
                            failedDowns.push({
                                reason: 'انتهت المدة أثناء الغياب',
                                roleId: downData.roleId
                            });
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

                // حذف بيانات العضو المنسحب
                delete leftMembersDowns[memberKey];
                writeJson(leftMembersDownsPath, leftMembersDowns);

                // تسجيل العودة
                const settings = this.getSettings();
                if (settings.logChannel) {
                    try {
                        const logChannel = await member.guild.channels.fetch(settings.logChannel);
                        if (logChannel) {
                            const embed = colorManager.createEmbed()
                                .setTitle('Member Rejoined - Down Reapplied')
                                .setDescription('عاد العضو إلى السيرفر وتمت إعادة تطبيق الداونات النشطة عليه تلقائياً مع استمرار نظام الحماية.')
                                .addFields([
                                    { name: ' العضو', value: `<@${member.id}>`, inline: true },
                                    { name: ' وقت العودة', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                                    { name: ' تم استعادتها', value: restoredDowns.toString(), inline: true }
                                ])
                                .setFooter({ text: 'Down Log • Member Rejoin' })
                                .setTimestamp();

                            this.withEmbedIdentity(embed, member.user, 'Member');

                            if (failedDowns.length > 0) {
                                embed.addFields([{ 
                                    name: 'فشل في استعادتها', 
                                    value: failedDowns.length.toString(), 
                                    inline: true 
                                }]);
                            }

                            const timeSinceLeft = Date.now() - memberData.leftAt;
                            const timeLeftText = timeSinceLeft > 3600000 ? 
                                `${Math.floor(timeSinceLeft / 3600000)} ساعة` : 
                                `${Math.floor(timeSinceLeft / 60000)} دقيقة`;

                            embed.addFields([{ 
                                name: ' فترة الغياب', 
                                value: timeLeftText, 
                                inline: true 
                            }]);

                            await logChannel.send({ embeds: [embed] });
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
        try {
            const settings = this.getSettings();
            if (!settings.logChannel) return;

            const logChannel = await guild.channels.fetch(settings.logChannel).catch(() => null);
            if (!logChannel) return;

            // إنشاء embed للعضو الخارج
            const embed = colorManager.createEmbed()
                .setTitle('Down Ended - Member Left' )
                .setDescription(`انتهت مدة الداون لعضو غير موجود في السيرفر`)
                .addFields([
                    { name: ' العضو', value: `<@${expiredDown.userId}>`, inline: true },
                    { name: ' الحالة', value: 'خارج السيرفر', inline: true },
                    { name: ' وقت الانتهاء', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                ])
                .setFooter({ text: 'Down Log • Expired Outside Server' })
                .setTimestamp();

            const leftUser = await this.client.users.fetch(expiredDown.userId).catch(() => null);
            if (leftUser) {
                this.withEmbedIdentity(embed, leftUser, 'Member');
            }

            if (role) {
                embed.addFields([
                    { name: ' الرول المنتهي', value: `<@&${role.id}>`, inline: true },
                    { name: ' السبب الأصلي', value: expiredDown.reason || 'غير محدد', inline: false }
                ]);
            } else {
                embed.addFields([
                    { name: 'الرول المنتهي', value: `Role ID: ${expiredDown.roleId}`, inline: true },
                    { name: ' السبب الأصلي', value: expiredDown.reason || 'غير محدد', inline: false }
                ]);
            }

            // إضافة معلومات إضافية
            const byUser = await this.client.users.fetch(expiredDown.byUserId).catch(() => null);
            if (byUser) {
                embed.addFields([{ name: ' تم تطبيقه بواسطة', value: `<@${byUser.id}>`, inline: true }]);
            }

            const startTime = expiredDown.startTime || Date.now();
            embed.addFields([{ name: 'تاريخ التطبيق', value: `<t:${Math.floor(startTime / 1000)}:F>`, inline: true }]);

            // إضافة ملاحظة هامة
            embed.addFields([{ 
                name: 'ملاحظة هامة', 
                value: 'إذا عاد هذا العضو للسيرفر، لن يعود الداون تلقائياً', 
                inline: false 
            }]);

            await logChannel.send({ embeds: [embed] });

            console.log(`⏰ انتهت مدة داون لعضو خارج السيرفر: ${expiredDown.userId}`);

        } catch (error) {
            console.error('خطأ في معالجة انتهاء داون عضو خارج:', error);
        }
    }
}

module.exports = new DownManager();
