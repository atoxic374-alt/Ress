const { EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const colorManager = require('./colorManager');

// Enhanced event types with better categorization and colors
const EVENT_TYPES = {
    'RESPONSIBILITY_MANAGEMENT': {
        name: 'إدارة المسؤوليات',
        description: 'سجل إنشاء وحذف وتعديل المسؤوليات',
        color: '#3498db',
        emoji: '⚙️'
    },
    'RESPONSIBLE_MEMBERS': {
        name: 'مساعدة الاعضاء',
        description: 'سجل تعيين وإزالة المسؤولين',
        color: '#e74c3c',
        emoji: '👥'
    },
    'TASK_LOGS': {
        name: 'المهام',
        description: 'سجل طلب واستلام المهام',
        color: '#f39c12',
        emoji: '📋'
    },
    'POINT_SYSTEM': {
        name: 'نظام النقاط',
        description: 'سجل إضافة وحذف النقاط',
        color: '#2ecc71',
        emoji: '🏆'
    },
    'ADMIN_ACTIONS': {
        name: 'إجراءات الإدارة',
        description: 'سجل إجراءات الإدارة العامة',
        color: '#9b59b6',
        emoji: '🔧'
    },
    'NOTIFICATION_SYSTEM': {
        name: 'نظام التنبيهات',
        description: 'سجل التنبيهات والإشعارات',
        color: '#1abc9c',
        emoji: '🔔'
    },
    'COOLDOWN_SYSTEM': {
        name: 'نظام الكولداون',
        description: 'سجل استخدام الكولداون',
        color: '#34495e',
        emoji: '⏱️'
    },
    'SETUP_ACTIONS': {
        name: 'إجراءات السيتب',
        description: 'سجل إجراءات إعداد البوت',
        color: '#95a5a6',
        emoji: '🔨'
    },
    'BOT_SETTINGS': {
        name: 'إعدادات البوت',
        description: 'سجل تغيير إعدادات البوت',
        color: '#8e44ad',
        emoji: '⚙️'
    },
    'ADMIN_CALLS': {
        name: 'استدعاء الإداريين',
        description: 'سجل استدعاء المشرفين والإداريين',
        color: '#c0392b',
        emoji: '📢'
    },
    'REPORT_SYSTEM': {
        name: 'نظام التقارير',
        description: 'سجل التقارير المقدمة من المسؤولين',
        color: '#7f8c8d',
        emoji: '📝'
    }
};

// Log templates for different event types
const LOG_TEMPLATES = {
    RESPONSIBILITY_CREATED: (responsibilityName, user) => ({
        type: 'RESPONSIBILITY_MANAGEMENT',
        title: 'تم إنشاء مسؤولية جديدة',
        description: `تم إنشاء المسؤولية: **${responsibilityName}**`,
        user,
        fields: [
            { name: 'اسم المسؤولية', value: responsibilityName, inline: true },
            { name: ' منشئ المسؤوليه', value: `<@${user.id}>`, inline: true }
        ]
    }),

    RESPONSIBILITY_DELETED: (responsibilityName, user) => ({
        type: 'RESPONSIBILITY_MANAGEMENT',
        title: 'تم حذف مسؤولية',
        description: `تم حذف المسؤولية: **${responsibilityName}**`,
        user,
        fields: [
            { name: ' اسم المسؤولية', value: responsibilityName, inline: true },
            { name: ' محذوف بواسطة', value: `<@${user.id}>`, inline: true }
        ]
    }),

    MEMBER_ADDED: (responsibilityName, userId, user) => ({
        type: 'RESPONSIBLE_MEMBERS',
        title: 'تم إضافة مسؤول جديد',
        description: `تم إضافة مسؤول جديد للمسؤولية: **${responsibilityName}**`,
        user,
        fields: [
            { name: ' المسؤولية', value: responsibilityName, inline: true },
            { name: ' المسؤول الجديد', value: `<@${userId}>`, inline: true },
            { name: ' أضيف بواسطة', value: `<@${user.id}>`, inline: true }
        ]
    }),

    MEMBER_REMOVED: (responsibilityName, userId, user) => ({
        type: 'RESPONSIBLE_MEMBERS',
        title: 'تم إزالة مسؤول',
        description: `تم إزالة مسؤول من المسؤولية: **${responsibilityName}**`,
        user,
        fields: [
            { name: ' المسؤولية', value: responsibilityName, inline: true },
            { name: ' المسؤول المُزال', value: `<@${userId}>`, inline: true },
            { name: ' أُزيل بواسطة', value: `<@${user.id}>`, inline: true }
        ]
    }),

    TASK_REQUESTED: (responsibilityName, requester, target) => ({
        type: 'TASK_LOGS',
        title: 'تم طلب مهمة',
        description: `تم طلب مهمة للمسؤولية: **${responsibilityName}**`,
        user: requester,
        fields: [
            { name: ' المسؤولية', value: responsibilityName, inline: true },
            { name: ' طلبها', value: `<@${requester.id}>`, inline: true },
            { name: ' الهدف', value: target === 'all' ? 'جميع المسؤولين' : `<@${target}>`, inline: true }
        ]
    }),

    TASK_CLAIMED: (responsibilityName, claimedBy, requester, user) => ({
        type: 'TASK_LOGS',
        title: 'تم استلام مهمة',
        description: `تم استلام مهمة المسؤولية: **${responsibilityName}**`,
        user,
        fields: [
            { name: 'المسؤولية', value: responsibilityName, inline: true },
            { name: 'استلمها', value: `<@${claimedBy}>`, inline: true },
            { name: ' طلبها', value: `<@${requester}>`, inline: true }
        ]
    }),

    POINTS_ADDED: (responsibilityName, userId, points, user) => ({
        type: 'POINT_SYSTEM',
        title: 'تم إضافة نقاط',
        description: `تم إضافة نقاط للعضو في المسؤولية: **${responsibilityName}**`,
        user,
        fields: [
            { name: ' المسؤولية', value: responsibilityName, inline: true },
            { name: ' العضو', value: `<@${userId}>`, inline: true },
            { name: ' النقاط المضافة', value: `+${points}`, inline: true }
        ]
    }),

    POINTS_REMOVED: (responsibilityName, userId, points, user) => ({
        type: 'POINT_SYSTEM',
        title: 'تم خصم نقاط',
        description: `تم خصم نقاط من العضو في المسؤولية: **${responsibilityName}**`,
        user,
        fields: [
            { name: ' المسؤولية', value: responsibilityName, inline: true },
            { name: ' العضو', value: `<@${userId}>`, inline: true },
            { name: 'النقاط المخصومة', value: `-${points}`, inline: true }
        ]
    }),

    ADMIN_ACTION: (action, details, user) => ({
        type: 'ADMIN_ACTIONS',
        title: 'إجراء إداري',
        description: `تم تنفيذ إجراء إداري: **${action}**`,
        user,
        fields: [
            { name: ' الإجراء', value: action, inline: true },
            { name: ' التفاصيل', value: details, inline: false },
            { name: ' المسؤول', value: `<@${user.id}>`, inline: true }
        ]
    }),

    NOTIFICATION_SENT: (type, target, user) => ({
        type: 'NOTIFICATION_SYSTEM',
        title: 'تم إرسال تنبيه',
        description: `تم إرسال تنبيه من نوع: **${type}**`,
        user,
        fields: [
            { name: 'نوع التنبيه', value: type, inline: true },
            { name: ' الهدف', value: target, inline: true },
            { name: ' أرسله', value: `<@${user.id}>`, inline: true }
        ]
    }),

    COOLDOWN_USED: (command, duration, user) => ({
        type: 'COOLDOWN_SYSTEM',
        title: 'استخدام كولداون',
        description: `تم تطبيق كولداون على الأمر: **${command}**`,
        user,
        fields: [
            { name: ' الأمر', value: command, inline: true },
            { name: ' المدة', value: `${duration} ثانية`, inline: true },
            { name: ' المستخدم', value: `<@${user.id}>`, inline: true }
        ]
    }),

    SETUP_ACTION: (action, details, user) => ({
        type: 'SETUP_ACTIONS',
        title: 'إجراء إعداد',
        description: `تم تنفيذ إجراء إعداد: **${action}**`,
        user,
        fields: [
            { name: ' الإجراء', value: action, inline: true },
            { name: ' التفاصيل', value: details, inline: false },
            { name: ' المسؤول', value: `<@${user.id}>`, inline: true }
        ]
    }),

    BOT_SETTING_CHANGED: (setting, oldValue, newValue, user) => ({
        type: 'BOT_SETTINGS',
        title: 'تم تغيير إعداد البوت',
        description: `تم تغيير إعداد: **${setting}**`,
        user,
        fields: [
            { name: ' الإعداد', value: setting, inline: true },
            { name: ' قبل القديمة', value: oldValue || 'غير محدد', inline: true },
            { name: ' بعد الجديدة', value: newValue, inline: true }
        ]
    }),

    ADMIN_CALLED: (reason, caller, user) => ({
        type: 'ADMIN_CALLS',
        title: 'تم استدعاء الإداريين',
        description: `تم استدعاء الإداريين للسبب: **${reason}**`,
        user,
        fields: [
            { name: 'السبب', value: reason, inline: true },
            { name: 'المستدعي', value: `<@${caller}>`, inline: true },
            { name: 'الوقت', value: new Date().toLocaleString('ar'), inline: true }
        ]
    }),

    ADMIN_CALLING_RESPONSIBLE: (responsibilityName, target, user) => ({
        type: 'ADMIN_CALLS',
        title: 'استدعاء مسؤول من قبل المشرف',
        description: `تم استدعاء مسؤول المسؤولية: **${responsibilityName}**`,
        user,
        fields: [
            { name: 'المسؤولية', value: responsibilityName, inline: true },
            { name: 'الهدف', value: target === 'all' ? 'جميع المسؤولين' : `<@${target}>`, inline: true },
            { name: 'المستدعي', value: `<@${user.id}>`, inline: true }
        ]
    }),

    ADMIN_CALL_REQUESTED: (responsibilityName, reason, target, user) => ({
        type: 'ADMIN_CALLS',
        title: 'طلب استدعاء مشرف',
        description: `تم طلب استدعاء مشرف للمسؤولية: **${responsibilityName}**`,
        user,
        fields: [
            { name: 'المسؤولية', value: responsibilityName, inline: true },
            { name: 'السبب', value: reason || 'لم يذكر سبب', inline: false },
            { name: 'الهدف', value: target === 'all' ? 'جميع المسؤولين' : `<@${target}>`, inline: true }
        ]
    }),

    REPORT_SUBMITTED: (claimer, requesterId, responsibilityName) => ({
        type: 'REPORT_SYSTEM',
        title: 'تم تقديم تقرير مهمة',
        description: `تقرير مقدم من أجل مهمة في مسؤولية **${responsibilityName}**`,
        user: claimer,
        fields: [
            { name: 'مقدم التقرير', value: `<@${claimer.id}>`, inline: true },
            { name: 'صاحب الطلب', value: `<@${requesterId}>`, inline: true }
        ]
    })
};

// Main logging function
async function logEvent(client, guild, eventData) {
    try {
        if (!client || !guild || !eventData) {
            console.log('⚠️ بيانات اللوق غير مكتملة');
            return;
        }

        const logConfig = client.logConfig;
        if (!logConfig || !logConfig.settings) {
            console.log('⚠️ تكوين اللوق غير موجود');
            return;
        }

        const eventType = eventData.type;
        const logSetting = logConfig.settings[eventType];

        if (!logSetting || !logSetting.enabled || !logSetting.channelId) {
            console.log(`⚠️ اللوق ${eventType} غير مفعل أو لا توجد قناة محددة`);
            return;
        }

        const logChannel = await client.channels.fetch(logSetting.channelId).catch(() => null);
        if (!logChannel) {
            console.log(`⚠️ قناة اللوق ${eventType} غير موجودة`);
            return;
        }

        const eventTypeConfig = EVENT_TYPES[eventType];
        if (!eventTypeConfig) {
            console.log(`⚠️ نوع الحدث ${eventType} غير معرف`);
            return;
        }

        const embed = colorManager.createEmbed()
            .setTitle(`${eventTypeConfig.emoji} ${eventData.title}`)
            .setDescription(eventData.description)
            .setTimestamp()
            .setFooter({ text: `نوع الحدث: ${eventTypeConfig.name}` });

        if (eventData.user) {
            embed.setAuthor({
                name: eventData.user.username,
                iconURL: eventData.user.displayAvatarURL()
            });
        }

        if (eventData.fields && Array.isArray(eventData.fields)) {
            embed.addFields(eventData.fields);
        }

        // إضافة الصورة المحددة لجميع اللوقات
        embed.setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400661744682139690/download__1_-removebg-preview.png?ex=688d7366&is=688c21e6&hm=5635fe92ec3d4896d9ca065b9bb8ee11a5923b9e5d75fe94b753046e7e8b24eb&');

        if (eventData.image) {
            embed.setImage(eventData.image);
        }

        await logChannel.send({ embeds: [embed] });
        console.log(`✅ تم تسجيل الحدث: ${eventTypeConfig.name} في قناة ${logChannel.name}`);

        // Update permissions if needed
        await updateLogChannelPermissions(logChannel, logConfig.logRoles || []);

    } catch (error) {
        console.error('❌ خطأ في تسجيل الحدث:', error);
    }
}

// Function to update log channel permissions
async function updateLogChannelPermissions(channel, logRoles) {
    try {
        if (!channel || !logRoles || logRoles.length === 0) {
            return;
        }

        const guild = channel.guild;
        let successCount = 0;

        // Hide channel from everyone
        await channel.permissionOverwrites.edit(guild.roles.everyone, {
            ViewChannel: false
        });

        // Give permissions to specified roles
        for (const roleId of logRoles) {
            const role = guild.roles.cache.get(roleId);
            if (role) {
                try {
                    await channel.permissionOverwrites.edit(role, {
                        ViewChannel: true,
                        SendMessages: false,
                        ReadMessageHistory: true
                    });
                    successCount++;
                } catch (err) {
                    console.log(`⚠️ خطأ في تحديث صلاحيات الرول ${role.name}:`, err.message);
                }
            } else {
                console.log(`⚠️ الرول غير موجود: ${roleId}`);
            }
        }

        console.log(`✅ تم تحديث صلاحيات القناة ${channel.name} لـ ${successCount} رول`);

    } catch (error) {
        console.error('❌ خطأ في تحديث صلاحيات اللوق:', error);
    }
}

// Function to update permissions for all log channels
async function updateAllLogPermissions(guild, logRoles) {
    console.log('🔄 بدء تحديث صلاحيات اللوق...');

    try {
        const category = guild.channels.cache.find(c => c.name === 'res-logs' && c.type === ChannelType.GuildCategory);

        if (category) {
            // تحديث صلاحيات الكاتوقري
            const permissionOverwrites = [
                {
                    id: guild.roles.everyone.id,
                    deny: [PermissionFlagsBits.ViewChannel]
                }
            ];

            // إضافة الرولات المحددة فقط
            if (logRoles && logRoles.length > 0) {
                for (const roleId of logRoles) {
                    const role = guild.roles.cache.get(roleId);
                    if (role) {
                        permissionOverwrites.push({
                            id: roleId,
                            allow: [
                                PermissionFlagsBits.ViewChannel,
                                PermissionFlagsBits.ReadMessageHistory
                            ],
                            deny: [PermissionFlagsBits.SendMessages]
                        });
                    }
                }
            }

            // مسح جميع الصلاحيات السابقة وتطبيق الجديدة
            await category.permissionOverwrites.set(permissionOverwrites);
            console.log(`✅ تم تحديث صلاحيات الكاتوقري: ${category.name}`);

            // تحديث صلاحيات جميع القنوات في الكاتوقري
            const channelsInCategory = guild.channels.cache.filter(c => c.parentId === category.id);
            let updatedChannels = 0;

            for (const channel of channelsInCategory.values()) {
                try {
                    // مسح جميع الصلاحيات السابقة وتطبيق الجديدة
                    await channel.permissionOverwrites.set(permissionOverwrites);
                    updatedChannels++;
                } catch (error) {
                    console.error(`❌ فشل في تحديث صلاحيات القناة ${channel.name}:`, error);
                }
            }

            console.log(`✅ تم تحديث صلاحيات ${updatedChannels} قناة لوق`);
        }

    } catch (error) {
        console.error('❌ خطأ في تحديث صلاحيات اللوق:', error);
    }
}

// Function to get log statistics
function getLogStats(client) {
    try {
        if (!client.logConfig || !client.logConfig.settings) {
            return { enabled: 0, disabled: 0, total: 0 };
        }

        const settings = client.logConfig.settings;
        const total = Object.keys(EVENT_TYPES).length;
        const enabled = Object.values(settings).filter(s => s.enabled).length;
        const disabled = total - enabled;

        return { enabled, disabled, total };
    } catch (error) {
        console.error('خطأ في حساب إحصائيات اللوق:', error);
        return { enabled: 0, disabled: 0, total: 0 };
    }
}

// Quick log functions for common events
const quickLog = {
    responsibilityCreated: (client, guild, responsibilityName, user) => 
        logEvent(client, guild, LOG_TEMPLATES.RESPONSIBILITY_CREATED(responsibilityName, user)),

    responsibilityDeleted: (client, guild, responsibilityName, user) => 
        logEvent(client, guild, LOG_TEMPLATES.RESPONSIBILITY_DELETED(responsibilityName, user)),

    memberAdded: (client, guild, responsibilityName, userId, user) => 
        logEvent(client, guild, LOG_TEMPLATES.MEMBER_ADDED(responsibilityName, userId, user)),

    memberRemoved: (client, guild, responsibilityName, userId, user) => 
        logEvent(client, guild, LOG_TEMPLATES.MEMBER_REMOVED(responsibilityName, userId, user)),

    taskRequested: (client, guild, responsibilityName, requester, target) => 
        logEvent(client, guild, LOG_TEMPLATES.TASK_REQUESTED(responsibilityName, requester, target)),

    taskClaimed: (client, guild, responsibilityName, claimedBy, requester, user) => 
        logEvent(client, guild, LOG_TEMPLATES.TASK_CLAIMED(responsibilityName, claimedBy, requester, user)),

    pointsAdded: (client, guild, responsibilityName, userId, points, user) => 
        logEvent(client, guild, LOG_TEMPLATES.POINTS_ADDED(responsibilityName, userId, points, user)),

    pointsRemoved: (client, guild, responsibilityName, userId, points, user) => 
        logEvent(client, guild, LOG_TEMPLATES.POINTS_REMOVED(responsibilityName, userId, points, user)),

    adminAction: (client, guild, action, details, user) => 
        logEvent(client, guild, LOG_TEMPLATES.ADMIN_ACTION(action, details, user)),

    notificationSent: (client, guild, type, target, user) => 
        logEvent(client, guild, LOG_TEMPLATES.NOTIFICATION_SENT(type, target, user)),

    cooldownUsed: (client, guild, command, duration, user) => 
        logEvent(client, guild, LOG_TEMPLATES.COOLDOWN_USED(command, duration, user)),

    setupAction: (client, guild, action, details, user) => 
        logEvent(client, guild, LOG_TEMPLATES.SETUP_ACTION(action, details, user)),

    botSettingChanged: (client, guild, setting, oldValue, newValue, user) => 
        logEvent(client, guild, LOG_TEMPLATES.BOT_SETTING_CHANGED(setting, oldValue, newValue, user)),

    adminCalled: (client, guild, reason, caller, user) => 
        logEvent(client, guild, LOG_TEMPLATES.ADMIN_CALLED(reason, caller, user)),

    adminCallingResponsible: (client, guild, responsibilityName, target, user) => 
        logEvent(client, guild, LOG_TEMPLATES.ADMIN_CALLING_RESPONSIBLE(responsibilityName, target, user)),

    adminCallRequested: (client, guild, responsibilityName, reason, target, user) => 
        logEvent(client, guild, LOG_TEMPLATES.ADMIN_CALL_REQUESTED(responsibilityName, reason, target, user)),

    reportSubmitted: (client, guild, claimer, requesterId, responsibilityName) =>
        logEvent(client, guild, LOG_TEMPLATES.REPORT_SUBMITTED(claimer, requesterId, responsibilityName))
};

module.exports = {
    EVENT_TYPES,
    LOG_TEMPLATES,
    logEvent,
    updateLogChannelPermissions,
    updateAllLogPermissions,
    getLogStats,
    quickLog
};
