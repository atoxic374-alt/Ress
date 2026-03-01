const fs = require('fs');
const path = require('path');
const colorManager = require('./colorManager');

// مسارات الملفات
const warnSettingsPath = path.join(__dirname, '..', 'data', 'warnSettings.json');
const activeWarnsPath = path.join(__dirname, '..', 'data', 'activeWarns.json');
const warnLogsPath = path.join(__dirname, '..', 'data', 'warnLogs.json');

// دالة مساعدة لقراءة JSON
function readJson(filePath, defaultValue = {}) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (error) {
        console.error(`خطأ في قراءة ${filePath}:`, error);
    }
    return defaultValue;
}

// دالة مساعدة لكتابة JSON
function writeJson(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error(`خطأ في كتابة ${filePath}:`, error);
        return false;
    }
}

class WarnManager {
    constructor() {
        this.client = null;
        this.ensureDataFiles();
    }

    // Initialize with Discord client
    init(client) {
        this.client = client;
        this.startMenuAutoRefresh(client);
    }

    // Start automatic menu refresh every 30 seconds
    startMenuAutoRefresh(client) {
        setInterval(async () => {
            try {
                const settings = this.getSettings();
                if (settings.menuChannel && settings.menuMessageId) {
                    const warnCommand = require('../commands/warn.js');
                    if (warnCommand && typeof warnCommand.createPermanentMenu === 'function') {
                        await warnCommand.createPermanentMenu(client, settings.menuChannel);
                        console.log('✅ تم تحديث منيو التحذيرات تلقائياً');
                    }
                }
            } catch (error) {
                console.error('خطأ في تحديث منيو التحذيرات التلقائي:', error);
            }
        }, 30000); // Update every 30 seconds
    }

    ensureDataFiles() {
        // Create default settings file
        if (!fs.existsSync(warnSettingsPath)) {
            const defaultSettings = {
                menuChannel: null,
                logChannel: null,
                downManagerUsers: [], // المسؤولين المختصين بالداون
                allowedUsers: {
                    type: null, // 'owners', 'roles', 'responsibility'
                    targets: []
                }
            };
            writeJson(warnSettingsPath, defaultSettings);
        }

        // Create active warnings file
        if (!fs.existsSync(activeWarnsPath)) {
            writeJson(activeWarnsPath, {});
        }

        // Create logs file
        if (!fs.existsSync(warnLogsPath)) {
            writeJson(warnLogsPath, []);
        }
    }

    // Settings Management
    getSettings() {
        return readJson(warnSettingsPath, {
            menuChannel: null,
            logChannel: null,
            downManagerUsers: [],
            allowedUsers: {
                type: null,
                targets: []
            }
        });
    }

    updateSettings(newSettings) {
        return writeJson(warnSettingsPath, newSettings);
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
                    const resp = responsibilities[respName];
                    if (resp && resp.responsible === userId) {
                        return true;
                    }
                }
                return false;

            default:
                return false;
        }
    }

    // Create Warning
    async createWarning(guild, targetMember, reason, byUserId) {
        try {
            const warnId = `${guild.id}_${targetMember.id}_${Date.now()}`;
            const activeWarns = this.getActiveWarnings();

            const warnRecord = {
                warnId,
                userId: targetMember.id,
                guildId: guild.id,
                reason,
                byUserId,
                timestamp: Date.now(),
                downRequested: false,
                downDuration: null
            };

            activeWarns[warnId] = warnRecord;
            writeJson(activeWarnsPath, activeWarns);

            // Log the action
            this.logAction('WARN_CREATED', {
                warnId,
                targetUserId: targetMember.id,
                reason,
                byUserId,
                timestamp: Date.now()
            });

            return { 
                success: true, 
                warnId: warnId,
                warnRecord
            };

        } catch (error) {
            console.error('Error creating warning:', error);
            return { success: false, error: 'حدث خطأ أثناء إنشاء التحذير' };
        }
    }

    // Update warning with down request
    async updateWarningWithDown(warnId, downDuration) {
        try {
            const activeWarns = this.getActiveWarnings();
            const warnRecord = activeWarns[warnId];

            if (!warnRecord) {
                return { success: false, error: 'التحذير غير موجود' };
            }

            warnRecord.downRequested = true;
            warnRecord.downDuration = downDuration;

            activeWarns[warnId] = warnRecord;
            writeJson(activeWarnsPath, activeWarns);

            // Log the update
            this.logAction('WARN_DOWN_REQUESTED', {
                warnId,
                downDuration,
                timestamp: Date.now()
            });

            return { success: true };

        } catch (error) {
            console.error('Error updating warning:', error);
            return { success: false, error: 'حدث خطأ أثناء تحديث التحذير' };
        }
    }

    // Delete Warning
    async deleteWarning(warnId) {
        try {
            const activeWarns = this.getActiveWarnings();

            if (!activeWarns[warnId]) {
                return { success: false, error: 'التحذير غير موجود' };
            }

            const warnRecord = activeWarns[warnId];
            delete activeWarns[warnId];
            writeJson(activeWarnsPath, activeWarns);

            // Log the deletion
            this.logAction('WARN_DELETED', {
                warnId,
                targetUserId: warnRecord.userId,
                timestamp: Date.now()
            });

            return { success: true };

        } catch (error) {
            console.error('Error deleting warning:', error);
            return { success: false, error: 'حدث خطأ أثناء حذف التحذير' };
        }
    }

    // Delete all warnings for a user
    async deleteAllUserWarnings(userId, guildId) {
        try {
            const activeWarns = this.getActiveWarnings();
            const userWarnings = Object.entries(activeWarns)
                .filter(([_, warn]) => warn.userId === userId && warn.guildId === guildId);

            let deletedCount = 0;
            for (const [warnId, _] of userWarnings) {
                delete activeWarns[warnId];
                deletedCount++;
            }

            writeJson(activeWarnsPath, activeWarns);

            // Log the deletion
            this.logAction('WARN_ALL_DELETED', {
                targetUserId: userId,
                count: deletedCount,
                timestamp: Date.now()
            });

            return { success: true, count: deletedCount };

        } catch (error) {
            console.error('Error deleting all warnings:', error);
            return { success: false, error: 'حدث خطأ أثناء حذف التحذيرات' };
        }
    }

    // Data Retrieval
    getActiveWarnings() {
        return readJson(activeWarnsPath, {});
    }

    getUserWarnings(userId, guildId) {
        const activeWarns = this.getActiveWarnings();
        return Object.entries(activeWarns)
            .filter(([_, warn]) => warn.userId === userId && warn.guildId === guildId)
            .map(([warnId, warn]) => ({ warnId, ...warn }));
    }

    getUsersWithWarnings(guildId) {
        const activeWarns = this.getActiveWarnings();
        const usersMap = new Map();

        Object.entries(activeWarns)
            .filter(([_, warn]) => warn.guildId === guildId)
            .forEach(([_, warn]) => {
                if (!usersMap.has(warn.userId)) {
                    usersMap.set(warn.userId, []);
                }
                usersMap.get(warn.userId).push(warn);
            });

        return Array.from(usersMap.entries()).map(([userId, warnings]) => ({
            userId,
            count: warnings.length
        }));
    }

    // Statistics
    getStatistics(guildId) {
        const activeWarns = this.getActiveWarnings();
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        const oneWeek = 7 * oneDay;

        const guildWarns = Object.values(activeWarns).filter(warn => warn.guildId === guildId);

        const total = guildWarns.length;
        const daily = guildWarns.filter(warn => (now - warn.timestamp) <= oneDay).length;
        const weekly = guildWarns.filter(warn => (now - warn.timestamp) <= oneWeek).length;

        // Count warnings per user
        const userCounts = {};
        guildWarns.forEach(warn => {
            userCounts[warn.userId] = (userCounts[warn.userId] || 0) + 1;
        });

        const dailyUserCounts = {};
        guildWarns.filter(warn => (now - warn.timestamp) <= oneDay).forEach(warn => {
            dailyUserCounts[warn.userId] = (dailyUserCounts[warn.userId] || 0) + 1;
        });

        const weeklyUserCounts = {};
        guildWarns.filter(warn => (now - warn.timestamp) <= oneWeek).forEach(warn => {
            weeklyUserCounts[warn.userId] = (weeklyUserCounts[warn.userId] || 0) + 1;
        });

        // Find top warned users
        const getTopUser = (counts) => {
            if (Object.keys(counts).length === 0) return null;
            return Object.entries(counts).reduce((max, [userId, count]) => 
                count > max.count ? { userId, count } : max, 
                { userId: null, count: 0 }
            );
        };

        return {
            total: {
                count: total,
                topUser: getTopUser(userCounts)
            },
            weekly: {
                count: weekly,
                topUser: getTopUser(weeklyUserCounts)
            },
            daily: {
                count: daily,
                topUser: getTopUser(dailyUserCounts)
            }
        };
    }

    // Logging
    logAction(type, data) {
        const logs = readJson(warnLogsPath, []);
        logs.push({
            type,
            data,
            timestamp: Date.now()
        });

        // Keep only last 1000 logs
        if (logs.length > 1000) {
            logs.splice(0, logs.length - 1000);
        }

        writeJson(warnLogsPath, logs);
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

        switch (type) {
            case 'WARN_CREATED':
                embed.setTitle('Warned')
                    .setDescription(`** Member Id : ${data.targetUser.id}**`)
                    .addFields([
                        { name: 'العضو', value: `<@${data.targetUser.id}>`, inline: true },
                        { name: 'رقم التحذير', value: `#${data.warnNumber}`, inline: true },
                        { name: 'المسؤول', value: `<@${data.byUser.id}>`, inline: true },
                        { name: 'السبب', value: data.reason, inline: false },
                        { name: 'هل تم طلب الداون؟', value: data.downRequested ? 'نعم' : 'لا', inline: true },
                        { name: 'الوقت', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ])
                    .setThumbnail(data.targetUser.displayAvatarURL({ dynamic: true, size: 128 }));
                break;

            case 'WARN_DELETED':
                embed.setTitle('Warn Deleted')
                    .addFields([
                        { name: 'العضو', value: `<@${data.targetUserId}>`, inline: true },
                        { name: 'رقم التحذير', value: `#${data.warnNumber}`, inline: true },
                        { name: 'تم الحذف بواسطة', value: `<@${data.deletedBy}>`, inline: true },
                        { name: 'الوقت', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ]);
                break;

            case 'WARN_ALL_DELETED':
                embed.setTitle('Delete All Warns For')
                    .addFields([
                        { name: 'العضو', value: `<@${data.targetUserId}>`, inline: true },
                        { name: 'عدد التحذيرات المحذوفة', value: `${data.count}`, inline: true },
                        { name: 'تم الحذف بواسطة', value: `<@${data.deletedBy}>`, inline: true },
                        { name: 'الوقت', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ]);
                break;
        }

        return embed;
    }
}

module.exports = new WarnManager();
