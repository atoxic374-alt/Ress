const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, ChannelType } = require('discord.js');
const colorManager = require('../utils/colorManager.js');
const { EVENT_TYPES, logEvent } = require('../utils/logs_system.js');
const { isUserBlocked } = require('./block.js');

const name = 'log';

async function execute(message, args, { client, scheduleSave, BOT_OWNERS }) {
    // فحص البلوك أولاً
    if (isUserBlocked(message.author.id)) {
        const blockedEmbed = colorManager.createEmbed()
            .setDescription('**🚫 أنت محظور من استخدام أوامر البوت**\n**للاستفسار، تواصل مع إدارة السيرفر**')
            .setThumbnail(client.user.displayAvatarURL({ format: 'png', size: 128 }));

        await message.channel.send({ embeds: [blockedEmbed] });
        return;
    }

    const owners = Array.isArray(BOT_OWNERS) ? BOT_OWNERS : [];

    const isOwner = owners.includes(message.author.id) || message.guild.ownerId === message.author.id;
    if (!isOwner) {
        await message.react('❌');
        return;
    }

    await sendLogSettings(message.channel, client);
}

async function sendLogSettings(channel, client) {
    const logConfig = client.logConfig;

    const embed = colorManager.createEmbed()
        .setTitle('إعدادات نظام اللوق')
        
        .setDescription('** Log system.**')
        .setThumbnail('https://cdn.discordapp.com/attachments/1393840634149736508/1398105756800389283/images__3_-removebg-preview.png?ex=688426f3&is=6882d573&hm=045681f140e43e60026fe068aaca3da588784bd5d8a60112ef19444fc48857e9&');

    const arabicEventTypes = {
        'RESPONSIBILITY_MANAGEMENT': 'إدارة المسؤوليات',
        'RESPONSIBLE_MEMBERS': 'مساعدة الاعضاء', 
        'TASK_LOGS': 'المهام',
        'POINT_SYSTEM': 'نظام النقاط',
        'ADMIN_ACTIONS': 'إجراءات الإدارة',
        'NOTIFICATION_SYSTEM': 'نظام التنبيهات',
        'COOLDOWN_SYSTEM': 'نظام الكولداون',
        'SETUP_ACTIONS': 'إجراءات السيتب',
        'BOT_SETTINGS': 'إعدادات البوت',
        'ADMIN_CALLS': 'استدعاء الإداريين'
    };

    const fields = Object.keys(EVENT_TYPES).map(type => {
        const setting = logConfig.settings[type] || { enabled: false, channelId: null };
        const status = setting.enabled ? 'مفعل' : 'معطل';
        const channelMention = setting.channelId ? `<#${setting.channelId}>` : 'غير محدد';
        return {
            name: arabicEventTypes[type] || EVENT_TYPES[type].name,
            value: `الحالة: **${status}**\nالروم : ${channelMention}`,
            inline: true
        };
    });

    embed.addFields(fields);

    const menu = new StringSelectMenuBuilder()
        .setCustomId('log_type_select')
        .setPlaceholder('اختر نوع اللوق ')
        .addOptions(
            Object.keys(EVENT_TYPES).map(type => ({
                label: arabicEventTypes[type] || EVENT_TYPES[type].name,
                description: getArabicDescription(type),
                value: type
            }))
        );

    const row1 = new ActionRowBuilder().addComponents(menu);

    const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('auto_set_logs')
                        .setLabel('Auto setup')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('disable_all_logs')
                        .setLabel('Disable')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('manage_log_roles')
                        .setLabel('Roles')
                        .setStyle(ButtonStyle.Primary)
                );

    await channel.send({ embeds: [embed], components: [row1, row2] });
}

function getArabicDescription(type) {
    const descriptions = {
        'RESPONSIBILITY_MANAGEMENT': 'لوق إنشاء وحذف وتعديل المسؤوليات',
        'RESPONSIBLE_MEMBERS': 'لوق تعيين وإزالة المسؤولين',
        'TASK_LOGS': 'لوق طلب واستلام المهام',
        'POINT_SYSTEM': 'لوق إضافة وحذف النقاط',
        'ADMIN_ACTIONS': 'لوق إجراءات الإدارة العامة',
        'NOTIFICATION_SYSTEM': 'لوق التنبيهات',
        'COOLDOWN_SYSTEM': 'لوق استخدام الكولداون',
        'SETUP_ACTIONS': 'لوق إجراءات البوت',
        'BOT_SETTINGS': 'لوق إعدادات البوت',
        'ADMIN_CALLS': 'لوق استدعاء الإداريين'
    };
    return descriptions[type] || 'وصف غير متوفر';
}

async function handleInteraction(interaction, client, scheduleSave, BOT_OWNERS) {
    try {
        // Check interaction validity
        const now = Date.now();
        const interactionAge = now - interaction.createdTimestamp;
        
        if (interactionAge > 14 * 60 * 1000) {
            console.log('تم تجاهل تفاعل logs منتهي الصلاحية');
            return;
        }

        if (!interaction || !interaction.isRepliable() || interaction.replied || interaction.deferred) {
            console.log('تم تجاهل تفاعل logs غير صالح');
            return;
        }

        const { customId } = interaction;

        // Check if user is bot owner
        const isOwner = BOT_OWNERS.includes(interaction.user.id) || interaction.guild.ownerId === interaction.user.id;
        if (!isOwner) {
            await interaction.reply({ content: '❌ **أنت لا تملك صلاحية استخدام هذا الأمر!**', ephemeral: true });
            return;
        }

        if (customId === 'auto_set_logs') {
            await interaction.deferUpdate();

            try {
                const guild = interaction.guild;
                if (!guild) {
                    return interaction.followUp({ content: '**خطأ: لا يمكن الوصول لمعلومات السيرفر!**', ephemeral: true });
                }

                // Check if all logs are already enabled
                const allEnabled = Object.keys(EVENT_TYPES).every(type => {
                    const setting = client.logConfig.settings[type];
                    return setting && setting.enabled && setting.channelId;
                });

                if (allEnabled) {
                    return interaction.followUp({ 
                        content: '✅ **جميع اللوقات مفعلة بالفعل!**\nلا حاجة للإعداد التلقائي.', 
                        ephemeral: true 
                    });
                }

                // Check bot permissions
                if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
                    return interaction.followUp({ content: '**البوت يحتاج صلاحية Manage channels  لهذه العملية!**', ephemeral: true });
                }

                let category = guild.channels.cache.find(c => c.name === 'res-logs' && c.type === ChannelType.GuildCategory);

                if (!category) {
                    const categoryPermissions = [
                        {
                            id: guild.roles.everyone.id,
                            deny: [PermissionsBitField.Flags.ViewChannel]
                        }
                    ];

                    const logRoles = client.logConfig.logRoles || [];
                    for (const roleId of logRoles) {
                        const role = guild.roles.cache.get(roleId);
                        if (role) {
                            categoryPermissions.push({
                                id: roleId,
                                allow: [
                                    PermissionsBitField.Flags.ViewChannel,
                                    PermissionsBitField.Flags.ReadMessageHistory
                                ],
                                deny: [PermissionsBitField.Flags.SendMessages]
                            });
                        }
                    }

                    category = await guild.channels.create({
                        name: 'res-logs',
                        type: ChannelType.GuildCategory,
                        permissionOverwrites: categoryPermissions
                    });
                }

                let createdCount = 0;
                const channelNames = {
                    'RESPONSIBILITY_MANAGEMENT': 'Res',
                    'RESPONSIBLE_MEMBERS': 'Resb',
                    'TASK_LOGS': 'Task',
                    'POINT_SYSTEM': 'Points',
                    'ADMIN_ACTIONS': 'Admins',
                    'NOTIFICATION_SYSTEM': 'Notifications',
                    'COOLDOWN_SYSTEM': 'Cooldown',
                    'SETUP_ACTIONS': 'Setup',
                    'BOT_SETTINGS': 'Bot',
                    'ADMIN_CALLS': 'Calls'
                };

                const arabicEventTypes = {
                    'RESPONSIBILITY_MANAGEMENT': 'إدارة المسؤوليات',
                    'RESPONSIBLE_MEMBERS': 'مساعدة الاعضاء', 
                    'TASK_LOGS': 'المهام',
                    'POINT_SYSTEM': 'نظام النقاط',
                    'ADMIN_ACTIONS': 'إجراءات الإدارة',
                    'NOTIFICATION_SYSTEM': 'نظام التنبيهات',
                    'COOLDOWN_SYSTEM': 'نظام الكولداون',
                    'SETUP_ACTIONS': 'إجراءات السيتب',
                    'BOT_SETTINGS': 'إعدادات البوت',
                    'ADMIN_CALLS': 'استدعاء الإداريين'
                };

                for (const [type, setting] of Object.entries(client.logConfig.settings)) {
                    if (!setting.enabled || !setting.channelId) {
                        const channelName = channelNames[type] || type.toLowerCase();

                        const channelPermissions = [
                            {
                                id: guild.roles.everyone.id,
                                deny: [PermissionsBitField.Flags.ViewChannel]
                            }
                        ];

                        const logRoles = client.logConfig.logRoles || [];
                        for (const roleId of logRoles) {
                            const role = guild.roles.cache.get(roleId);
                            if (role) {
                                channelPermissions.push({
                                    id: roleId,
                                    allow: [
                                        PermissionsBitField.Flags.ViewChannel,
                                        PermissionsBitField.Flags.ReadMessageHistory
                                    ],
                                    deny: [PermissionsBitField.Flags.SendMessages]
                                });
                            }
                        }

                        const channel = await guild.channels.create({
                            name: channelName,
                            type: ChannelType.GuildText,
                            parent: category.id,
                            permissionOverwrites: channelPermissions
                        });

                        client.logConfig.settings[type] = {
                            enabled: true,
                            channelId: channel.id
                        };

                        createdCount++;
                    }
                }

                scheduleSave();

                // Update the same message instead of creating new one
                const embed = colorManager.createEmbed()
                    .setTitle('إعدادات نظام اللوقات')
                    .setDescription('**log system**')
                    .setThumbnail('https://cdn.discordapp.com/attachments/1393840634149736508/1398105756800389283/images__3_-removebg-preview.png?ex=688426f3&is=6882d573&hm=045681f140e43e60026fe068aaca3da588784bd5d8a60112ef19444fc48857e9&');

                const fields = Object.keys(EVENT_TYPES).map(type => {
                    const setting = client.logConfig.settings[type] || { enabled: false, channelId: null };
                    const status = setting.enabled ? 'مفعل' : 'معطل';
                    const channelMention = setting.channelId ? `<#${setting.channelId}>` : 'غير محدد';
                    return {
                        name: arabicEventTypes[type] || EVENT_TYPES[type].name,
                        value: `الحالة : **${status}**\nالروم : ${channelMention}`,
                        inline: true
                    };
                });

                embed.addFields(fields);

                const menu = new StringSelectMenuBuilder()
                    .setCustomId('log_type_select')
                    .setPlaceholder('اختر نوع اللوق')
                    .addOptions(
                        Object.keys(EVENT_TYPES).map(type => ({
                            label: arabicEventTypes[type] || EVENT_TYPES[type].name,
                            description: getArabicDescription(type),
                            value: type
                        }))
                    );

                const row1 = new ActionRowBuilder().addComponents(menu);

                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('auto_set_logs')
                        .setLabel('Auto Setup')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('disable_all_logs')
                        .setLabel('Disable')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('manage_log_roles')
                        .setLabel('Roles')
                        .setStyle(ButtonStyle.Primary)
                );

                await interaction.editReply({ embeds: [embed], components: [row1, row2] });

                if (createdCount === 0) {
                    return interaction.followUp({ 
                        content: '✅ **تم تفعيل جميع اللوقات!**\nجميع القنوات كانت موجودة مسبقاً.', 
                        ephemeral: true 
                    });
                } else {
                    return interaction.followUp({ 
                        content: `✅ **تم الإعداد التلقائي بنجاح!**\nتم إنشاء ${createdCount} روم جديدة`, 
                        ephemeral: true 
                    });
                }
            } catch (error) {
                console.error('خطأ في الإعداد التلقائي:', error);
                return interaction.followUp({ content: '**حدث خطأ أثناء الإعداد التلقائي!** تأكد من صلاحيات البوت.', ephemeral: true });
            }
        }

        if (customId === 'disable_all_logs') {
            await interaction.deferUpdate();

            try {
                const allDisabled = Object.keys(EVENT_TYPES).every(type => {
                    const setting = client.logConfig.settings[type];
                    return !setting || !setting.enabled || !setting.channelId;
                });

                if (allDisabled) {
                    return interaction.followUp({ 
                        content: '❌ **جميع اللوقات معطلة بالفعل!**\nلا حاجة لتعطيل إضافي.', 
                        ephemeral: true 
                    });
                }

                const guild = interaction.guild;
                let deletedChannels = 0;
                let deletedCategory = false;

                const category = guild.channels.cache.find(c => c.name === 'res-logs' && c.type === ChannelType.GuildCategory);

                if (category) {
                    const channelsInCategory = guild.channels.cache.filter(c => c.parentId === category.id);

                    for (const channel of channelsInCategory.values()) {
                        try {
                            await channel.delete('تعطيل جميع اللوقات');
                            deletedChannels++;
                            console.log(`تم حذف روم: ${channel.name}`);
                        } catch (error) {
                            console.error(`فشل في حذف القناة ${channel.name}:`, error);
                        }
                    }

                    try {
                        await category.delete('تعطيل جميع اللوقات');
                        deletedCategory = true;
                        console.log('تم حذف تصنيف res-logs');
                    } catch (error) {
                        console.error('فشل في حذف التصنيف:', error);
                    }
                }

                for (const type of Object.keys(EVENT_TYPES)) {
                    client.logConfig.settings[type] = { enabled: false, channelId: null };
                }

                scheduleSave();

                const arabicEventTypes = {
                    'RESPONSIBILITY_MANAGEMENT': 'إدارة المسؤوليات',
                    'RESPONSIBLE_MEMBERS': 'مساعدة الاعضاء', 
                    'TASK_LOGS': 'المهام',
                    'POINT_SYSTEM': 'نظام النقاط',
                    'ADMIN_ACTIONS': 'إجراءات الإدارة',
                    'NOTIFICATION_SYSTEM': 'نظام التنبيهات',
                    'COOLDOWN_SYSTEM': 'نظام الكولداون',
                    'SETUP_ACTIONS': 'إجراءات السيتب',
                    'BOT_SETTINGS': 'إعدادات البوت',
                    'ADMIN_CALLS': 'استدعاء الإداريين'
                };

                const embed = colorManager.createEmbed()
                    .setTitle('إعدادات نظام اللوقات')
                    .setDescription('**Log system.**')
                    .setThumbnail('https://cdn.discordapp.com/attachments/1393840634149736508/1398105756800389283/images__3_-removebg-preview.png?ex=688426f3&is=6882d573&hm=045681f140e43e60026fe068aaca3da588784bd5d8a60112ef19444fc48857e9&');

                const fields = Object.keys(EVENT_TYPES).map(type => {
                    const setting = client.logConfig.settings[type] || { enabled: false, channelId: null };
                    const status = setting.enabled ? 'مفعل' : 'معطل';
                    const channelMention = setting.channelId ? `<#${setting.channelId}>` : 'غير محدد';
                    return {
                        name: arabicEventTypes[type] || EVENT_TYPES[type].name,
                        value: `الحالة : **${status}**\nالروم : ${channelMention}`,
                        inline: true
                    };
                });

                embed.addFields(fields);

                const menu = new StringSelectMenuBuilder()
                    .setCustomId('log_type_select')
                    .setPlaceholder('اختر نوع اللوق')
                    .addOptions(
                        Object.keys(EVENT_TYPES).map(type => ({
                            label: arabicEventTypes[type] || EVENT_TYPES[type].name,
                            description: getArabicDescription(type),
                            value: type
                        }))
                    );

                const row1 = new ActionRowBuilder().addComponents(menu);

                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('auto_set_logs')
                        .setLabel('Auto setup')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('disable_all_logs')
                        .setLabel('Disable')
                        .setStyle(ButtonStyle.Danger),
                    new ButtonBuilder()
                        .setCustomId('manage_log_roles')
                        .setLabel('Roles')
                        .setStyle(ButtonStyle.Primary)
                );

                await interaction.editReply({ embeds: [embed], components: [row1, row2] });

                let resultMessage = '❌ **تم تعطيل جميع اللوقات!**\n';
                if (deletedChannels > 0) {
                    resultMessage += `** تم حذف __${deletedChannels}__ روم**`;
                }
                if (deletedCategory) {
                    resultMessage += '**\n تم حذف كاتوقري res-logs**';
                }

                return interaction.followUp({ 
                    content: resultMessage, 
                    ephemeral: true 
                });
            } catch (error) {
                console.error('Error disabling logs:', error);
                return interaction.followUp({ content: '**حدث خطأ أثناء تعطيل اللوقات!**', ephemeral: true });
            }
        }

        if (interaction.isStringSelectMenu() && customId === 'log_type_select') {
            const type = interaction.values[0];
            const logSetting = client.logConfig.settings[type] || { enabled: false, channelId: null };

            const arabicEventTypes = {
                'RESPONSIBILITY_MANAGEMENT': 'إدارة المسؤوليات',
                'RESPONSIBLE_MEMBERS': 'مساعدة الاعضاء', 
                'TASK_LOGS': 'المهام',
                'POINT_SYSTEM': 'نظام النقاط',
                'ADMIN_ACTIONS': 'إجراءات الإدارة',
                'NOTIFICATION_SYSTEM': 'نظام التنبيهات',
                'COOLDOWN_SYSTEM': 'نظام الكولداون',
                'SETUP_ACTIONS': 'إجراءات السيتب',
                'BOT_SETTINGS': 'إعدادات البوت',
                'ADMIN_CALLS': 'استدعاء الإداريين'
            };

            // إذا كان السجل مفعل والقناة موجودة، قم بتعطيله وحذف القناة إذا كانت من الإعداد التلقائي
            if (logSetting.enabled && logSetting.channelId) {
                await interaction.deferUpdate();

                try {
                    const channel = await interaction.guild.channels.fetch(logSetting.channelId).catch(() => null);
                    let channelDeleted = false;

                    if (channel) {
                        const category = channel.parent;
                        if (category && category.name === 'res-logs') {
                            try {
                                await channel.delete('تم حذف الروم وتوقف اللوق بنجاح');
                                channelDeleted = true;
                                console.log(`تم حذف الروم التلقائية: ${channel.name}`);
                            } catch (deleteError) {
                                console.error(`فشل في حذف الروم ${channel.name}:`, deleteError);
                            }
                        }
                    }

                    client.logConfig.settings[type] = { enabled: false, channelId: null };
                    scheduleSave();

                    // تحديث فوري للرسالة الأساسية
                    await updateLogMessage(interaction, client);

                    const deleteMessage = channelDeleted ? ' وحذف الروم التلقائية' : '';
                    await interaction.followUp({ 
                        content: `✅ تم تعطيل لوق **${arabicEventTypes[type]}**${deleteMessage}`, 
                        ephemeral: true 
                    });

                } catch (error) {
                    console.error('خطأ في تعطيل السجل:', error);
                    await interaction.followUp({ 
                        content: '❌ حدث خطأ أثناء تعطيل اللوق!', 
                        ephemeral: true 
                    });
                }
                return;
            }

            // إذا لم يكن السجل مفعل، اطلب من المستخدم منشن الروم
            await interaction.reply({ 
                content: `📝 **${arabicEventTypes[type] || EVENT_TYPES[type].name}**\n\nمنشن الروم التي تريد وضع اللوق فيها **`, 
                ephemeral: true 
            });

            // إنشاء collector لانتظار رد المستخدم
            const filter = (m) => m.author.id === interaction.user.id;
            const collector = interaction.channel.createMessageCollector({ filter, time: 60000, max: 1 });

            collector.on('collect', async (message) => {
                try {
                    // استخراج ID القناة من الرسالة
                    const channelMention = message.content.match(/<#(\d+)>/);
                    let channelId = null;

                    if (channelMention) {
                        channelId = channelMention[1];
                    } else if (/^\d+$/.test(message.content.trim())) {
                        channelId = message.content.trim();
                    }

                    if (!channelId) {
                        await message.reply('❌ **صيغة خاطئة!** منشن الروم أو اكتب ID الروم');
                        return;
                    }

                    const channel = interaction.guild.channels.cache.get(channelId);
                    if (!channel || channel.type !== ChannelType.GuildText) {
                        await message.reply('❌ **الروم غير موجودة أو ليست روم نصية!**');
                        return;
                    }

                    // تفعيل اللوق
                    if (!client.logConfig.settings[type]) {
                        client.logConfig.settings[type] = {};
                    }

                    client.logConfig.settings[type].enabled = true;
                    client.logConfig.settings[type].channelId = channelId;

                    scheduleSave();

                    // تطبيق الصلاحيات على القناة المختارة
                    const logRoles = client.logConfig.logRoles || [];

                    try {
                        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
                            ViewChannel: false
                        });

                        for (const roleId of logRoles) {
                            const role = interaction.guild.roles.cache.get(roleId);
                            if (role) {
                                await channel.permissionOverwrites.edit(role, {
                                    ViewChannel: true,
                                    SendMessages: false,
                                    ReadMessageHistory: true
                                });
                            }
                        }
                    } catch (error) {
                        console.error('خطأ في تحديث صلاحيات القناة:', error);
                    }

                    // تحديث فوري للرسالة الأساسية
                    await updateLogMessage(interaction, client);

                    await message.reply(`✅ **تم تفعيل ${arabicEventTypes[type] || EVENT_TYPES[type].name} في ${channel}**`);

                    // حذف رسالة المستخدم
                    try {
                        await message.delete();
                    } catch (error) {
                        console.log('لا يمكن حذف رسالة المستخدم');
                    }

                } catch (error) {
                    console.error('خطأ في معالجة رسالة المستخدم:', error);
                    await message.reply('❌ **حدث خطأ أثناء معالجة طلبك!**');
                }
            });

            collector.on('end', (collected) => {
                if (collected.size === 0) {
                    interaction.followUp({ 
                        content: '⏰ **انتهت مدة الانتظار!** استخدم الأمر مرة أخرى.', 
                        ephemeral: true 
                    });
                }
            });
        }

        if (customId === 'manage_log_roles') {
            await interaction.deferUpdate();
            await showLogRolesMenu(interaction, client);
        }

        if (customId === 'add_log_roles') {
            await interaction.deferUpdate();

            const embed = colorManager.createEmbed()
                .setTitle('إضافة رولات للوق')
                .setDescription('**منشن الرولات أو اكتب الآي دي**')
                
                .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400645490118234132/download__8_-removebg-preview.png?ex=688d6443&is=688c12c3&hm=217945651e6a5f649ede7719b4572da60d009a8aa461a507b72e2f82ea59a4cd&');

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('back_to_log_roles_menu')
                    .setLabel('Back')
                    .setStyle(ButtonStyle.Secondary)
            );

            await interaction.editReply({ embeds: [embed], components: [row] });

            // إنشاء collector لانتظار رد المستخدم
            const filter = (m) => m.author.id === interaction.user.id;
            const collector = interaction.channel.createMessageCollector({ filter, time: 60000, max: 1 });

            collector.on('collect', async (message) => {
                try {
                    // استخراج IDs الرولات من الرسالة
                    const roleInput = message.content.trim();
                    const roleMatches = roleInput.match(/<@&(\d+)>/g) || [];
                    const idMatches = roleInput.match(/\b\d{17,19}\b/g) || [];

                    const roleIds = [];

                    // إضافة الرولات من المنشن
                    roleMatches.forEach(match => {
                        const id = match.replace(/<@&(\d+)>/, '$1');
                        if (!roleIds.includes(id)) roleIds.push(id);
                    });

                    // إضافة الرولات من الآي دي
                    idMatches.forEach(id => {
                        if (!roleIds.includes(id)) roleIds.push(id);
                    });

                    if (roleIds.length === 0) {
                        await message.reply('**تأكد من منشن الرولات أو كتابة الآي دي بشكل صحيح**');
                        return;
                    }

                    const currentLogRoles = client.logConfig.logRoles || [];
                    const addedRoles = [];
                    const existingRoles = [];
                    const invalidRoles = [];

                    for (const roleId of roleIds) {
                        if (currentLogRoles.includes(roleId)) {
                            existingRoles.push(roleId);
                        } else {
                            const role = interaction.guild.roles.cache.get(roleId);
                            if (role && role.name !== '@everyone' && !role.managed) {
                                addedRoles.push(roleId);
                            } else {
                                invalidRoles.push(roleId);
                            }
                        }
                    }

                    if (addedRoles.length > 0) {
                        client.logConfig.logRoles = [...currentLogRoles, ...addedRoles];
                        scheduleSave();
                        await updateLogPermissions(interaction.guild, client.logConfig.logRoles);
                    }

                    // Create response embed
                    const responseEmbed = colorManager.createEmbed()
                        .setColor('#0099ff')
                        .setTitle('نتائج إضافة رولات اللوق')
                        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400645490118234132/download__8_-removebg-preview.png?ex=688d6443&is=688c12c3&hm=217945651e6a5f649ede7719b4572da60d009a8aa461a507b72e2f82ea59a4cd&');

                    const embedFields = [];

                    if (addedRoles.length > 0) {
                      embedFields.push({
                        name: '**✅ تم إضافة الرولات بنجاح**',
                        value: addedRoles.map(id => `<@&${id}>`).join('\n'),
                        inline: false
                      });
                    }

                    if (existingRoles.length > 0) {
                      embedFields.push({
                        name: '** رولات موجودة مسبقاً**',
                        value: existingRoles.map(id => `<@&${id}>`).join('\n'),
                        inline: false
                      });
                    }

                    if (invalidRoles.length > 0) {
                      // Get detailed error reasons
                      const detailedErrors = [];
                      for (const roleId of invalidRoles) {
                        try {
                          const role = await interaction.guild.roles.fetch(roleId);
                          if (!role) {
                            detailedErrors.push(` **الرول غير وجود**`);
                          }
                        } catch (error) {
                          if (error.code === 50013) {
                            detailedErrors.push(`**لا توجد صلاحيات للوصول للرول**`);
                          } else if (error.code === 10011) {
                            detailedErrors.push(`**الرول غير موجود أو محذوف**`);
                          } else {
                            detailedErrors.push(`خطأ غير معروف`);
                          }
                        }
                      }

                      embedFields.push({
                        name: '**❌ رولات غير صحيحة**',
                        value: detailedErrors.map((error, index) => `• ${error}`).join('\n') || '**رولات غير صالحة**',
                        inline: false
                      });
                    }

                    if (embedFields.length > 0) {
                      responseEmbed.addFields(embedFields);
                    } else {
                      responseEmbed.setDescription('**لم يتم إجراء أي تغييرات.**');
                    }

                    // إرسال رسالة مؤقتة تختفي بعد 5 ثوان
                    const tempMessage = await message.channel.send({ 
                        embeds: [responseEmbed]
                    });

                    // حذف الرسالة بعد 5 ثوان
                    setTimeout(async () => {
                        try {
                            await tempMessage.delete();
                        } catch (error) {
                            console.log('لا يمكن حذف الرسالة المؤقتة');
                        }
                    }, 5000);

                    // العودة لقائمة إدارة الرولات مع تحديث فوري
                    await showLogRolesMenu(interaction, client);

                    // حذف رسالة المستخدم
                    try {
                        await message.delete();
                    } catch (error) {
                        console.log('لا يمكن حذف رسالة المستخدم');
                    }

                } catch (error) {
                    console.error('خطأ في معالجة إضافة الرولات:', error);
                    await message.reply('❌ **حدث خطأ أثناء معالجة الرولات!**');
                }
            });

            collector.on('end', (collected) => {
                if (collected.size === 0) {
                    interaction.followUp({ 
                        content: '⏰ **انتهت مدة الانتظار!** استخدم الأمر مرة أخرى.', 
                        ephemeral: true 
                    });
                }
            });
        }

        if (customId === 'remove_log_roles') {
            const currentLogRoles = client.logConfig.logRoles || [];

            if (currentLogRoles.length === 0) {
                return interaction.reply({ content: '❌ **لا توجد رولات في قائمة اللوق لحذفها!**', ephemeral: true });
            }

            // إنشاء قائمة مرقمة للرولات
            let rolesList = '**اختر أرقام الرولات ل حذفها:**\n\n';
            for (let i = 0; i < currentLogRoles.length; i++) {
                const roleId = currentLogRoles[i];
                const role = interaction.guild.roles.cache.get(roleId);
                const roleName = role ? role.name : '**رول محذوف**';
                rolesList += `**${i + 1}.** ${role ? `*<@&${roleId}>*` : roleName}\n`;
            }
            rolesList += '**تأكد من المسافات بين الأرقام**';

            const removeEmbed = colorManager.createEmbed()
                .setTitle('Delete all')
                .setDescription(rolesList)
                
                .setFooter({ text: `إجمالي الرولات : ${currentLogRoles.length}` });

            await interaction.reply({ 
                embeds: [removeEmbed],
                ephemeral: true 
            });

            const messageFilter = m => m.author.id === interaction.user.id;
            const collector = interaction.channel.createMessageCollector({ 
                filter: messageFilter, 
                time: 60000, 
                max: 1 
            });

            collector.on('collect', async (message) => {
                try {
                    const numbersInput = message.content.trim();

                    if (!numbersInput) {
                        return message.reply('❌ **يجب إدخال أرقام صحيحة!**');
                    }

                    // استخراج الأرقام من النص
                    const inputNumbers = numbersInput.split(/\s+/)
                        .map(num => num.trim())
                        .filter(num => num !== '');

                    if (inputNumbers.length === 0) {
                        return message.reply('❌ **يجب إدخال أرقام! مثال: `1 2 3`**');
                    }

                    const numbers = [];
                    const invalidInputs = [];

                    for (const input of inputNumbers) {
                        const num = parseInt(input);
                        if (isNaN(num)) {
                            invalidInputs.push(input);
                        } else if (num < 1 || num > currentLogRoles.length) {
                            invalidInputs.push(`${num} (خارج النطاق 1-${currentLogRoles.length})`);
                        } else {
                            numbers.push(num);
                        }
                    }

                    if (invalidInputs.length > 0) {
                        return message.reply(`❌ **أرقام غير صحيحة:** ${invalidInputs.join(', ')}\n**النطاق المسموح:** 1-${currentLogRoles.length}`);
                    }

                    if (numbers.length === 0) {
                        return message.reply('❌ **لم يتم العثور على أرقام صحيحة!**');
                    }

                    // ترتيب الأرقام تنازلياً لتجنب مشاكل الفهرسة
                    numbers.sort((a, b) => b - a);

                    const rolesToRemove = [];
                    for (const num of numbers) {
                        const roleId = currentLogRoles[num - 1];
                        if (roleId && !rolesToRemove.includes(roleId)) {
                            rolesToRemove.push(roleId);
                        }
                    }

                    if (rolesToRemove.length === 0) {
                        return message.reply('❌ **لا توجد رولات صحيحة للحذف!**');
                    }

                    // إزالة الرولات من القائمة
                    client.logConfig.logRoles = currentLogRoles.filter(role => !rolesToRemove.includes(role));

                    // حفظ التحديثات
                    scheduleSave();

                    // إزالة الصلاحيات من القنوات
                    await removeLogPermissions(interaction.guild, rolesToRemove);

                    // إنشاء رد التأكيد
                    const removedRolesList = rolesToRemove.map(id => {
                        const role = interaction.guild.roles.cache.get(id);
                        return role ? `<@&${id}>` : `رول محذوف (${id})`;
                    }).join('\n');

                    const successEmbed = colorManager.createEmbed()
                        .setTitle('✅ ')
                        .setDescription(`**Comoletly Delete __${rolesToRemove.length}__**`)
                 
                        .setFooter({ text: `**By Ahmed **` });

                    // إرسال رسالة تأكيد مؤقتة
                    const tempMessage = await message.reply({ embeds: [successEmbed] });

                    // حذف الرسالة بعد 7 ثوان
                    setTimeout(async () => {
                        try {
                            await tempMessage.delete();
                        } catch (error) {
                            console.log('لا يمكن حذف الرسالة المؤقتة');
                        }
                    }, 7000);

                    // العودة لقائمة إدارة الرولات مع تحديث فوري
                    await showLogRolesMenu(interaction, client);

                    // حذف رسالة المستخدم
                    try {
                        await message.delete();
                    } catch (error) {
                        console.log('لا يمكن حذف رسالة المستخدم');
                    }

                } catch (error) {
                    console.error('خطأ في معالجة حذف الرولات:', error);
                    await message.reply('❌ **حدث خطأ أثناء معالجة الرولات!**');
                }
            });

            collector.on('end', (collected) => {
                if (collected.size === 0) {
                    interaction.followUp({ content: '⏰ **انتهت مهلة الانتظار!**', ephemeral: true }).catch(() => {});
                }
            });
        }

         if (interaction.isStringSelectMenu() && customId === 'select_roles_to_add_log') {
            await interaction.deferUpdate();

            const selectedRoles = interaction.values;
            const currentLogRoles = client.logConfig.logRoles || [];

            // إضافة الرولات الجديدة
            const newLogRoles = [...new Set([...currentLogRoles, ...selectedRoles])];
            client.logConfig.logRoles = newLogRoles;

            scheduleSave();

            // تحديث صلاحيات اللوق
            await updateLogPermissions(interaction.guild, newLogRoles);

            const addedRoleNames = selectedRoles.map(roleId => {
                const role = interaction.guild.roles.cache.get(roleId);
                return role ? role.name : roleId;
            }).join(', ');

            // العودة لقائمة إدارة الرولات مع تحديث فوري
            await showLogRolesMenu(interaction, client);

            await interaction.followUp({
                content: `✅ **Completily Add **\nالرولات المضافة : __${addedRoleNames}__`,
                ephemeral: true
            });
        }

         if (interaction.isStringSelectMenu() && customId.startsWith('select_roles_to_remove_log_')) {
            await interaction.deferUpdate();

            try {
                const selectedRoles = interaction.values;
                const currentLogRoles = client.logConfig.logRoles || [];

                if (selectedRoles.length === 0) {
                    const errorEmbed = colorManager.createEmbed()
                        .setDescription('❌ **لم يتم اختيار أي رولات للإزالة**')
                        .setColor('#ff0000');

                    return interaction.followUp({ 
                        embeds: [errorEmbed], 
                        ephemeral: true 
                    });
                }

                // التحقق من وجود الرولات المحددة
                const validRoles = selectedRoles.filter(roleId => currentLogRoles.includes(roleId));

                if (validRoles.length === 0) {
                    const errorEmbed = colorManager.createEmbed()
                        .setDescription('❌ **الرولات المحددة غير موجودة في قائمة اللوق!**')
                        .setColor('#ff0000');

                    return interaction.followUp({ 
                        embeds: [errorEmbed], 
                        ephemeral: true 
                    });
                }

                // إزالة الرولات المحددة
                const newLogRoles = currentLogRoles.filter(roleId => !validRoles.includes(roleId));
                client.logConfig.logRoles = newLogRoles;

                scheduleSave();

                // تحديث صلاحيات اللوق مع إزالة فعلية للصلاحيات
                await removeLogPermissions(interaction.guild, validRoles);
                await updateLogPermissions(interaction.guild, newLogRoles);

                const removedRoleNames = validRoles.map(roleId => {
                    const role = interaction.guild.roles.cache.get(roleId);
                    return role ? role.name : `رول محذوف (${roleId})`;
                }).join(', ');

                // العودة لقائمة إدارة الرولات مع تحديث فوري
                await showLogRolesMenu(interaction, client);

                const successEmbed = colorManager.createEmbed()
                    .setTitle('✅')
                    .setDescription(`** Completily delete : __${validRoles.length}__**`)
                    .addFields([
                        { name: ' الرولات المُزالة', value: removedRoleNames, inline: false }
                    ])
                    .setColor('#00ff00')
                    .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400645486272057364/download__7_-removebg-preview.png?ex=688d6442&is=688c12c2&hm=2375cd57724a3ffe3b0073bef7fa7d1aa08f3b79200e33f346cdce03cfd27e9a&');

                await interaction.followUp({
                    embeds: [successEmbed],
                    ephemeral: true
                });

            } catch (error) {
                console.error('خطأ في إزالة رولات اللوق:', error);

                const errorEmbed = colorManager.createEmbed()
                    .setDescription('❌ **حدث خطأ أثناء إزالة الرولات!**')
                    .setColor('#ff0000')
    .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390144795738175/download__2_-removebg-preview.png?ex=688d1f34&is=688bcdb4&hm=40da8d91a92062c95eb9d48f307697ec0010860aca64dd3f8c3c045f3c2aa13a&');
                await interaction.followUp({ 
                    embeds: [errorEmbed], 
                    ephemeral: true 
                });
            }
        }



        if (customId === 'back_to_main_logs') {
            await interaction.deferUpdate();
            await updateLogMessage(interaction, client);
        }

        if (customId === 'back_to_log_roles_menu') {
            await interaction.deferUpdate();
            await showLogRolesMenu(interaction, client);
        }

        if (customId === 'add_all_admin_roles_log') {
            await interaction.deferUpdate();

            try {
                function loadAdminRoles() {
                    const fs = require('fs');
                    const path = require('path');
                    const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');

                    try {
                        if (fs.existsSync(adminRolesPath)) {
                            const data = fs.readFileSync(adminRolesPath, 'utf8');
                            const adminRoles = JSON.parse(data);
                            return Array.isArray(adminRoles) ? adminRoles : [];
                        }
                        return [];
                    } catch (error) {
                        console.error('خطأ في قراءة adminRoles:', error);
                        return [];
                    }
                }

                const adminRoleIds = loadAdminRoles();
                const currentLogRoles = client.logConfig.logRoles || [];

                if (adminRoleIds.length === 0) {
                    const noAdminEmbed = colorManager.createEmbed()
                        .setDescription('❌ **لا توجد رولات إدارية محددة في النظام!**')
                        .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400637278900191312/images__7_-removebg-preview.png?ex=688d5c9d&is=688c0b1d&hm=8d5c6d761dcf9bda65af44b9de09a2817cbc273f061eb1e39cc8ac20de37cfc0&')
                        .setColor('#ff0000');

                    return interaction.followUp({ 
                        embeds: [noAdminEmbed], 
                        ephemeral: true 
                    });
                }

                const newRoles = adminRoleIds.filter(roleId => !currentLogRoles.includes(roleId));

                if (newRoles.length === 0) {
                    const alreadyAddedEmbed = colorManager.createEmbed()
                        .setDescription('✅ **جميع الرولات الإدارية مضافة بالفعل للوق!**')
                        .setColor('#00ff00')
.setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400390888416608286/download__3_-removebg-preview.png?ex=688d1fe5&is=688bce65&hm=55055a587668561ce27baf0665663f801e14662d4bf849351564a563b1e53b41&');
                    return interaction.followUp({ 
                        embeds: [alreadyAddedEmbed], 
                        ephemeral: true 
                    });
                }

                client.logConfig.logRoles = [...currentLogRoles, ...newRoles];
                scheduleSave();

                await updateLogPermissions(interaction.guild, client.logConfig.logRoles);

                const addedRoleNames = newRoles.map(roleId => {
                    const role = interaction.guild.roles.cache.get(roleId);
                    return role ? role.name : `رول محذوف (${roleId})`;
                }).join(', ');

                await showLogRolesMenu(interaction, client);

                const successEmbed = colorManager.createEmbed()
                    .setTitle('✅ تم إضافة الرولات الإدارية')
                    .setDescription(`**Completily Add ${newRoles.length} **`)
                    .addFields([
                        { name: 'الرولات المضافة', value: addedRoleNames, inline: false }
                    ])
                    .setColor('#00ff00')
                    .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400645490118234132/download__8_-removebg-preview.png?ex=688d6443&is=688c12c3&hm=217945651e6a5f649ede7719b4572da60d009a8aa461a507b72e2f82ea59a4cd&');

                await interaction.followUp({ 
                    embeds: [successEmbed], 
                    ephemeral: true 
                });

            } catch (error) {
                console.error('خطأ في إضافة الرولات الإدارية:', error);

                const errorEmbed = colorManager.createEmbed()
                    .setDescription('❌ **حدث خطأ أثناء إضافة الرولات الإدارية!**')
                    .setColor('#ff0000');

                await interaction.followUp({ 
                    embeds: [errorEmbed], 
                    ephemeral: true 
                });
            }
        }

        if (customId === 'remove_all_log_roles') {
            await interaction.deferUpdate();

            try {
                const currentLogRoles = client.logConfig.logRoles || [];

                if (currentLogRoles.length === 0) {
                    const noRolesEmbed = colorManager.createEmbed()
                        .setDescription('❌ **لا توجد رولات محددة للوق حالياً!**')
                        .setColor('#ff0000');

                    return interaction.followUp({ 
                        embeds: [noRolesEmbed], 
                        ephemeral: true 
                    });
                }

                const removedCount = currentLogRoles.length;
                const removedRoles = [...currentLogRoles];

                client.logConfig.logRoles = [];
                scheduleSave();

                // إزالة صلاحيات جميع الرولات
                await removeLogPermissions(interaction.guild, removedRoles);
                await updateLogPermissions(interaction.guild, []);

                await showLogRolesMenu(interaction, client);

                const successEmbed = colorManager.createEmbed()
                    .setTitle('✅ Delete all')
                    .setDescription(`**Completily Delete all**`)
                    .addFields([
                        { name: ' Roles', value: `${removedCount} رول`, inline: true },
                        { name: 'Perms', value: 'تم ازاله جميع البرمشنات', inline: false }
                    ])
                    .setColor('#00ff00')
                    .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400645486272057364/download__7_-removebg-preview.png?ex=688d6442&is=688c12c2&hm=2375cd57724a3ffe3b0073bef7fa7d1aa08f3b79200e33f346cdce03cfd27e9a&');

                await interaction.followUp({ 
                    embeds: [successEmbed], 
                    ephemeral: true 
                });

            } catch (error) {
                console.error('خطأ في إزالة جميع الرولات:', error);

                const errorEmbed = colorManager.createEmbed()
                    .setDescription('❌ **حدث خطأ أثناء إزالة جميع الرولات!**')
                    .setColor('#ff0000');

                await interaction.followUp({ 
                    embeds: [errorEmbed], 
                    ephemeral: true 
                });
            }
        }

    } catch (error) {
        console.error('خطأ في معالج تفاعلات السجلات:', error);

        const errorMessages = {
            10008: 'الرسالة غير موجودة أو تم حذفها',
            40060: 'التفاعل تم الرد عليه مسبقاً',
            10062: 'التفاعل غير معروف أو منتهي الصلاحية',
            50013: 'البوت لا يملك الصلاحيات المطلوبة',
            50001: 'البوت لا يملك حق الوصول'
        };

        const errorMessage = errorMessages[error.code] || 'حدث خطأ غير متوقع';

        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ 
                    content: `**خطأ:** ${errorMessage}`, 
                    ephemeral: true 
                });
            } else if (interaction.deferred) {
                await interaction.editReply(`**خطأ:** ${errorMessage}`);
            }
        } catch (replyError) {
            const ignoredCodes = [10008, 40060, 10062, 10003, 50013, 50001];
            if (!ignoredCodes.includes(replyError.code)) {
                console.error('خطأ في إرسال رد الخطأ:', replyError);
            }
        }
    }
}

// دالة تحديث الرسالة الأساسية
async function updateLogMessage(interaction, client) {
    try {
        const logConfig = client.logConfig;

        const embed = colorManager.createEmbed()
            .setTitle('إعدادات نظام اللوق')
            .setColor('#0099ff')
            .setDescription('** Log system.**')
            .setThumbnail('https://cdn.discordapp.com/attachments/1393840634149736508/1398105756800389283/images__3_-removebg-preview.png?ex=688426f3&is=6882d573&hm=045681f140e43e60026fe068aaca3da588784bd5d8a60112ef19444fc48857e9&');

        const arabicEventTypes = {
            'RESPONSIBILITY_MANAGEMENT': 'إدارة المسؤوليات',
            'RESPONSIBLE_MEMBERS': 'مساعدة الاعضاء', 
            'TASK_LOGS': 'المهام',
            'POINT_SYSTEM': 'نظام النقاط',
            'ADMIN_ACTIONS': 'إجراءات الإدارة',
            'NOTIFICATION_SYSTEM': 'نظام التنبيهات',
            'COOLDOWN_SYSTEM': 'نظام الكولداون',
            'SETUP_ACTIONS': 'إجراءات السيتب',
            'BOT_SETTINGS': 'إعدادات البوت',
            'ADMIN_CALLS': 'استدعاء الإداريين'
        };

        const fields = Object.keys(EVENT_TYPES).map(type => {
            const setting = logConfig.settings[type] || { enabled: false, channelId: null };
            const status = setting.enabled ? 'مفعل' : 'معطل';
            const channelMention = setting.channelId ? `<#${setting.channelId}>` : 'غير محدد';
            return {
                name: arabicEventTypes[type] || EVENT_TYPES[type].name,
                value: `الحالة: **${status}**\nالروم : ${channelMention}`,
                inline: true
            };
        });

        embed.addFields(fields);

        const menu = new StringSelectMenuBuilder()
            .setCustomId('log_type_select')
            .setPlaceholder('اختر نوع اللوق ')
            .addOptions(
                Object.keys(EVENT_TYPES).map(type => ({
                    label: arabicEventTypes[type] || EVENT_TYPES[type].name,
                    description: getArabicDescription(type),
                    value: type
                }))
            );

        const row1 = new ActionRowBuilder().addComponents(menu);

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('auto_set_logs')
                .setLabel('Setup all')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId('disable_all_logs')
                .setLabel('Disable all')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId('manage_log_roles')
                .setLabel('Roles')
                .setStyle(ButtonStyle.Primary)
        );

        await interaction.editReply({ embeds: [embed], components: [row1, row2] });
    } catch (error) {
        console.error('خطأ في تحديث رسالة اللوق:', error);
    }
}

// دالة عرض قائمة إدارة الرولات
async function showLogRolesMenu(interaction, client) {
    try {
        function loadAdminRoles() {
            const fs = require('fs');
            const path = require('path');
            const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');

            try {
                if (fs.existsSync(adminRolesPath)) {
                    const data = fs.readFileSync(adminRolesPath, 'utf8');
                    const adminRoles = JSON.parse(data);
                    return Array.isArray(adminRoles) ? adminRoles : [];
                }
                return [];
            } catch (error) {
                console.error('خطأ في قراءة adminRoles:', error);
                return [];
            }
        }

        const adminRoleIds = loadAdminRoles();
        const adminRoles = [];
        for (const roleId of adminRoleIds) {
            const role = interaction.guild.roles.cache.get(roleId);
            if (role) {
                adminRoles.push(role);
            }
        }

        const currentLogRoles = client.logConfig.logRoles || [];

        const embed = colorManager.createEmbed()
            .setTitle('Roles for logs')
            .setDescription('* اختر رولات اللوق *')
            .setColor('#0099ff')
            .setThumbnail('https://cdn.discordapp.com/attachments/1373799493111386243/1400652380726493264/1320524609342410792.png?ex=688d6aae&is=688c192e&hm=391503bd0a7f5d393d8fc79f5f430bc458cfe1747b44f8dd5053b80159653346&');

        if (currentLogRoles.length > 0) {
            let rolesText = '';
            currentLogRoles.forEach((roleId, index) => {
                const role = interaction.guild.roles.cache.get(roleId);
                if (role) {
                    const isAdmin = adminRoleIds.includes(roleId) ? ' ' : '';
                    rolesText += `${index + 1}. ${role.name}${isAdmin}\n`;
                }
            });
            embed.addFields({ name: 'Roles for now :', value: rolesText || 'No roles', inline: false });
        }

        if (adminRoles.length > 0) {
            let adminRolesText = '';
            adminRoles.forEach((role, index) => {
                const inLogRoles = currentLogRoles.includes(role.id) ? ' ✅' : '';
                adminRolesText += `${index + 1}. ${role.name}${inLogRoles}\n`;
            });
            embed.addFields({ name: 'Admin roles :', value: adminRolesText, inline: false });
        }

        const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('add_log_roles')
                .setLabel('add')
                .setStyle(ButtonStyle.Success)
                .setEmoji('➕'),
            new ButtonBuilder()
                .setCustomId('remove_log_roles')
                .setLabel('delete')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('➖')
        );

        const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('add_all_admin_roles_log')
                .setLabel('Add all admins')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('➕'),
            new ButtonBuilder()
                .setCustomId('remove_all_log_roles')
                .setLabel('Delete all')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('➖')
        );

        const row3 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('back_to_main_logs')
                .setLabel('Back to main')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('⬅️')
        );

        await interaction.editReply({ embeds: [embed], components: [row1, row2, row3] });
    } catch (error) {
        console.error('خطأ في عرض قائمة الرولات:', error);
    }
}

// دالة لإزالة صلاحيات رولات محددة من قنوات اللوق  
async function removeLogPermissions(guild, rolesToRemove) {
    try {
        if (!rolesToRemove || rolesToRemove.length === 0) {
            return;
        }

        console.log(`🔄 بدء إزالة صلاحيات ${rolesToRemove.length} رول من قنوات اللوق...`);

        const category = guild.channels.cache.find(c => c.name === 'res-logs' && c.type === ChannelType.GuildCategory);

        // إزالة صلاحيات من الكاتوقري
        if (category) {
            for (const roleId of rolesToRemove) {
                const role = guild.roles.cache.get(roleId);
                if (role) {
                    try {
                        await category.permissionOverwrites.delete(role);
                        console.log(`✅ تم إزالة صلاحيات الرول ${role.name} من كاتوقري ${category.name}`);
                    } catch (error) {
                        console.error(`❌ فشل في إزالة صلاحيات الرول ${role.name} من الكاتوقري:`, error);
                    }
                }
            }

            // إزالة صلاحيات من جميع قنوات الكاتوقري
            const channelsInCategory = guild.channels.cache.filter(c => c.parentId === category.id);
            for (const channel of channelsInCategory.values()) {
                for (const roleId of rolesToRemove) {
                    const role = guild.roles.cache.get(roleId);
                    if (role) {
                        try {
                            await channel.permissionOverwrites.delete(role);
                            console.log(`✅ تم إزالة صلاحيات الرول ${role.name} من القناة ${channel.name}`);
                        } catch (error) {
                            console.error(`❌ فشل في إزالة صلاحيات الرول ${role.name} من القناة ${channel.name}:`, error);
                        }
                    }
                }
            }
        }

        // إزالة صلاحيات من قنوات اللوق الفردية خارج الكاتوقري
        const client = guild.client;
        const logConfig = client.logConfig;

        if (logConfig && logConfig.settings) {
            for (const [eventType, setting] of Object.entries(logConfig.settings)) {
                if (setting.enabled && setting.channelId) {
                    try {
                        const logChannel = guild.channels.cache.get(setting.channelId);
                        if (logChannel && (!category || logChannel.parentId !== category.id)) {
                            for (const roleId of rolesToRemove) {
                                const role = guild.roles.cache.get(roleId);
                                if (role) {
                                    try {
                                        await logChannel.permissionOverwrites.delete(role);
                                        console.log(`✅ تم إزالة صلاحيات الرول ${role.name} من قناة اللوق ${logChannel.name}`);
                                    } catch (error) {
                                        console.error(`❌ فشل في إزالة صلاحيات الرول ${role.name} من قناة اللوق ${logChannel.name}:`, error);
                                    }
                                }
                            }
                        }
                    } catch (error) {
                        console.error(`❌ فشل في الوصول لقناة اللوق ${eventType}:`, error);
                    }
                }
            }
        }

        console.log('✅ تم إنهاء إزالة صلاحيات الرولات من قنوات اللوق');
    } catch (error) {
        console.error('❌ خطأ في إزالة صلاحيات اللوق:', error);
    }
}

// دالة تحديث صلاحيات اللوق
async function updateLogPermissions(guild, allowedRoles) {
    try {
        const { PermissionsBitField } = require('discord.js');

        if (!allowedRoles || allowedRoles.length === 0) {
            console.log('لا توجد رولات محددة - سيتم ترك الصلاحيات الافتراضية**');
            return;
        }

        const category = guild.channels.cache.find(c => c.name === 'res-logs' && c.type === ChannelType.GuildCategory);

        if (category) {
            const everyoneRole = guild.roles.everyone;

            const permissionOverwrites = [
                {
                    id: everyoneRole.id,
                    deny: [PermissionsBitField.Flags.ViewChannel]
                }
            ];

            for (const roleId of allowedRoles) {
                const role = guild.roles.cache.get(roleId);
                if (role) {
                    permissionOverwrites.push({
                        id: roleId,
                        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory],
                        deny: [PermissionsBitField.Flags.SendMessages]
                    });
                }
            }

            try {
                await category.permissionOverwrites.set(permissionOverwrites);
                console.log(`تم تحديث صلاحيات الكاتوقري: ${category.name}`);
            } catch (error) {
                console.error(`فشل في تحديث صلاحيات الكاتوقري:`, error);
            }

            const channelsInCategory = guild.channels.cache.filter(c => c.parentId === category.id);

            for (const channel of channelsInCategory.values()) {
                try {
                    await channel.permissionOverwrites.set(permissionOverwrites);
                    console.log(`تم تحديث صلاحيات القناة: ${channel.name}`);
                } catch (error) {
                    console.error(`فشل في تحديث صلاحيات القناة ${channel.name}:`, error);
                }
            }
        }

        const client = guild.client;
        const logConfig = client.logConfig;

        if (logConfig && logConfig.settings) {
            for (const [eventType, setting] of Object.entries(logConfig.settings)) {
                if (setting.enabled && setting.channelId) {
                    try {
                        const logChannel = guild.channels.cache.get(setting.channelId);
                        if (logChannel && (!category || logChannel.parentId !== category.id)) {
                            const channelPermissions = [
                                {
                                    id: guild.roles.everyone.id,
                                    deny: [PermissionsBitField.Flags.ViewChannel]
                                }
                            ];

                            for (const roleId of allowedRoles) {
                                const role = guild.roles.cache.get(roleId);
                                if (role) {
                                    channelPermissions.push({
                                        id: roleId,
                                        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory],
                                        deny: [PermissionsBitField.Flags.SendMessages]
                                    });
                                }
                            }

                            await logChannel.permissionOverwrites.set(channelPermissions);
                            console.log(`تم تحديث صلاحيات قناة اللوق الفردية: ${logChannel.name}`);
                        }
                    } catch (error) {
                        console.error(`فشل في تحديث صلاحيات قناة اللوق ${eventType}:`, error);
                    }
                }
            }
        }

        console.log('تم تحديث صلاحيات جميع قنوات اللوق بنجاح');
    } catch (error) {
        console.error('خطأ في تحديث صلاحيات اللوق:', error);
    }
}

module.exports = {
    name,
    execute,
    handleInteraction,
    updateLogPermissions,
    removeLogPermissions
};