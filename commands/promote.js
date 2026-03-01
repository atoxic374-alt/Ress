const { ButtonBuilder, ActionRowBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const ms = require('ms');
const moment = require('moment-timezone');
const colorManager = require('../utils/colorManager');
const promoteManager = require('../utils/promoteManager');
const { collectUserStats, formatDuration } = require('../utils/userStatsCollector');
const { createPaginatedResponsibilityMenu, createPaginatedResponsibilityArray, handlePaginationInteraction } = require('../utils/responsibilityPagination');

const name = 'promote';

// Helper function to read JSON files
function readJson(filePath, defaultValue = {}) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error);
    }
    return defaultValue;
}

// Helper function to save JSON files
function saveJson(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error(`Error saving ${filePath}:`, error);
        return false;
    }
}

// Alias for saveJson (for compatibility)
function writeJson(filePath, data) {
    return saveJson(filePath, data);
}

// Check if initial setup is required
function needsSetup() {
    const settingsPath = path.join(__dirname, '..', 'data', 'promoteSettings.json');
    const settings = readJson(settingsPath, {});

    return !settings.menuChannel || !settings.logChannel || !settings.allowedUsers?.type;
}

// Create setup status embed
function createSetupEmbed(step, settings = {}, client) {
    const embed = colorManager.createEmbed()
        .setTitle('Promote System Setup')
        .setDescription('يحتاج النظام للإعداد الأولي قبل الاستخدام')
        .setThumbnail(client?.user?.displayAvatarURL() || 'https://cdn.discordapp.com/attachments/1373799493111386243/1400677612304470086/images__5_-removebg-preview.png?ex=688d822e&is=688c30ae&hm=1ea7a63bb89b38bcd76c0f5668984d7fc919214096a3d3ee92f5d948497fcb51&')
        .setTimestamp();

    // Add fields showing progress
    embed.addFields([
        {
            name: 'تحديد المعتمدين',
            value: settings.allowedUsers?.type ?
                `${getPermissionTypeText(settings.allowedUsers.type)} (${settings.allowedUsers.targets?.length || 0})` :
                step === 1 ? 'جاري التحديد...' : 'لم يتم بعد',
            inline: true
        },
        {
            name: 'روم السجلات',
            value: settings.logChannel ? `<#${settings.logChannel}>` :
                step === 2 ? 'جاري التحديد...' : 'لم يتم بعد',
            inline: true
        },
        {
            name: 'روم المنيو',
            value: settings.menuChannel ? `<#${settings.menuChannel}>` :
                step === 3 ? 'جاري التحديد...' : 'لم يتم بعد',
            inline: true
        }
    ]);

    return embed;
}

function getPermissionTypeText(type) {
    switch (type) {
        case 'owners': return 'المالكين فقط';
        case 'roles': return 'رولات محددة';
        case 'responsibility': return 'مسؤوليات محددة';
        default: return 'غير محدد';
    }
}

// Create permanent menu for the menu channel
async function createPermanentMenu(client, channelId) {
    try {
        console.log(`🔧 بدء إنشاء المنيو الدائم للقناة: ${channelId}`);

        const channel = await client.channels.fetch(channelId).catch(err => {
            console.error('❌ خطأ في جلب القناة:', err);
            return null;
        });

        if (!channel) {
            console.error('❌ القناة غير موجودة أو لا يمكن الوصول إليها');
            return false;
        }

        console.log(`✅ تم العثور على القناة: ${channel.name} (${channel.id})`);

        // التحقق من صلاحيات البوت
        const permissions = channel.permissionsFor(client.user);
        if (!permissions.has(['SendMessages', 'EmbedLinks'])) {
            console.error('❌ البوت لا يملك صلاحيات كافية في القناة');
            return false;
        }

        // إنشاء المنيو الرئيسي نفسه بدون تغييرات
        const settings = promoteManager.getSettings();
        const menuEmbed = colorManager.createEmbed()
            .setTitle('Promote Management System')
            .setDescription('** منيو الترقية للمسؤولين **\n\n')
            .addFields([
                { name: 'Up', value: 'ترقية اداري ', inline: false },
                { name: 'Up log', value: 'عرض الترقيات لإداري معين',  inline: false },
                { name: 'Block', value: 'منع عضو من الحصول على ترقيات',  inline: false },
                { name: 'Unblock', value: 'إزالة منع الترقية عن إداري', inline: false },
                { name: 'Admins active', value: 'فحص إحصائيات تفاعل الادارة قبل الترقية', inline: false }
            ])
            .setThumbnail(client?.user?.displayAvatarURL({ size: 128 }) || 'https://cdn.discordapp.com/attachments/1373799493111386243/1400677612304470086/images__5_-removebg-preview.png?ex=688d822e&is=688c30ae&hm=1ea7a63bb89b38bcd76c0f5668984d7fc919214096a3d3ee92f5d948497fcb51&')
            .setFooter({text :' By Ahmed'})  
            .setTimestamp();

        const menuSelect = new StringSelectMenuBuilder()
            .setCustomId('promote_main_menu')
            .setPlaceholder(' اختر الإجراء المطلوب...')
            .addOptions([
                {
                    label: 'Up',
                    value: 'promote_user_or_role',
                    description: 'ترقية لاداري وإعطاؤه رول إداري لمدة محددة أو نهائياً',
                    emoji: '<:emoji_65:1442588059890614383>',
                },
                {
                    label: 'Record',
                    value: 'promotion_records',
                    description: 'عرض تاريخ الترقيات لاداري معين',
                    emoji: '<:emoji_73:1442588719201648811>',
                },
                {
                    label: 'Block',
                    value: 'ban_from_promotion',
                    description: 'منع اداري من الحصول على ترقيات',
                    emoji: '<:emoji_74:1442588785266262228>',
                },
                {
                    label: 'Unblock',
                    value: 'unban_promotion',
                    description: 'إزالة حظر الترقية عن عضو',
                    emoji: '<:emoji_76:1442588839121260756>',
                },
                {
                    label: 'Check Admin',
                    value: 'check_admin_activity',
                    description: 'فحص إحصائيات تفاعل الادارة قبل الترقية',
                    emoji: '<:emoji_78:1442588950274510988>',
                }
            ]);

        const settingsButton = new ButtonBuilder()
            .setCustomId('promote_settings_button')
            .setLabel(' Settings')
.setEmoji('<:emoji_81:1442589104914305176>')
            .setStyle(ButtonStyle.Secondary);

        const menuRow = new ActionRowBuilder().addComponents(menuSelect);
        const buttonRow = new ActionRowBuilder().addComponents(settingsButton);

        let message = null;

        // حذف الرسالة القديمة إن وجدت
        if (settings.menuMessageId) {
            console.log(`🔄 محاولة حذف المنيو القديم: ${settings.menuMessageId}`);
            try {
                const existingMessage = await channel.messages.fetch(settings.menuMessageId);
                if (existingMessage) {
                    await existingMessage.delete();
                    console.log('🗑️ تم حذف المنيو القديم');
                }
            } catch (error) {
                console.log('⚠️ لم يتم العثور على الرسالة القديمة أو تم حذفها مسبقاً');
            }

            // مسح معرف الرسالة القديمة
            settings.menuMessageId = null;
            promoteManager.updateSettings(settings);
        }

        // انتظار قصير بين الحذف والإنشاء
        await new Promise(resolve => setTimeout(resolve, 1000));

        // إنشاء المنيو الجديد
        console.log('🆕 إنشاء منيو جديد...');
        try {
            message = await channel.send({
                embeds: [menuEmbed],
                components: [menuRow, buttonRow]
            });

            if (!message) {
                console.error('❌ فشل في إنشاء الرسالة - الاستجابة فارغة');
                return false;
            }

            // حفظ معرف الرسالة الجديدة
            settings.menuMessageId = message.id;
            const saveResult = promoteManager.updateSettings(settings);

            if (!saveResult) {
                console.error('⚠️ فشل في حفظ معرف الرسالة الجديد');
            }

            console.log(`✅ تم إنشاء منيو جديد بنجاح - معرف الرسالة: ${message.id}`);
            console.log(`📍 تم إرسال المنيو إلى القناة: ${channel.name} (${channel.id})`);
            return true;
        } catch (error) {
            console.error('❌ خطأ في إنشاء المنيو الجديد:', error);

            // إضافة تفاصيل أكثر عن نوع الخطأ
            if (error.code === 50013) {
                console.error('❌ البوت لا يملك صلاحية إرسال الرسائل في هذه القناة');
            } else if (error.code === 50001) {
                console.error('❌ البوت لا يملك صلاحية الوصول لهذه القناة');
            } else if (error.code === 10003) {
                console.error('❌ القناة غير موجودة');
            }

            return false;
        }
    } catch (error) {
        console.error('❌ خطأ عام في إنشاء المنيو الدائم:', error);
        return false;
    }
}

// دالة مضافة لتحديث المنيو الدائم
async function updatePermanentMenu(client, message) {
    try {
        const menuEmbed = colorManager.createEmbed()
            .setTitle('Promote Management System')
            .setDescription('** منيو الترقية للمسؤولين **\n\n')
            .addFields([
                { name: 'Up', value: 'ترقية اداري ', inline: false },
                { name: 'Up log', value: 'عرض الترقيات لإداري معين',  inline: false },
                { name: 'Block', value: 'منع عضو من الحصول على ترقيات',  inline: false },
                { name: 'Unblock', value: 'إزالة منع الترقية عن إداري', inline: false },
                { name: 'Admins active', value: 'فحص إحصائيات تفاعل الادارة قبل الترقية', inline: false }
            ])
            .setThumbnail(client?.user?.displayAvatarURL({ size: 128 }) || 'https://cdn.discordapp.com/attachments/1373799493111386243/1400677612304470086/images__5_-removebg-preview.png?ex=688d822e&is=688c30ae&hm=1ea7a63bb89b38bcd76c0f5668984d7fc919214096a3d3ee92f5d948497fcb51&')
            .setFooter({text :' يتم التحديث تلقائياً كل 30 ثانية | By Ahmed'})  
            .setTimestamp();

        const menuSelect = new StringSelectMenuBuilder()
            .setCustomId('promote_main_menu')
            .setPlaceholder(' اختر الإجراء المطلوب...')
            .addOptions([
                { label: 'Up', value: 'promote_user_or_role', emoji: '<:emoji_65:1442588059890614383>' },
                { label: 'Record', value: 'promotion_records', emoji: '<:emoji_73:1442588719201648811>' },
                { label: 'Block', value: 'ban_from_promotion', emoji: '<:emoji_74:1442588785266262228>' },
                { label: 'Unblock', value: 'unban_promotion', emoji: '<:emoji_76:1442588839121260756>' },
                { label: 'Check Admin', value: 'check_admin_activity', emoji: '<:emoji_78:1442588950274510988>' }
            ]);

        const settingsButton = new ButtonBuilder()
            .setCustomId('promote_settings_button')
            .setLabel(' Settings')
            .setEmoji('<:emoji_81:1442589104914305176>')
            .setStyle(ButtonStyle.Secondary);

        const menuRow = new ActionRowBuilder().addComponents(menuSelect);
        const buttonRow = new ActionRowBuilder().addComponents(settingsButton);

        await message.edit({
            embeds: [menuEmbed],
            components: [menuRow, buttonRow]
        }).catch(err => console.error('Error editing permanent menu:', err));
    } catch (error) {
        console.error('Error updating permanent menu:', error);
    }
}

async function execute(message, args, context) {
    const { client, BOT_OWNERS } = context;

    // Check if user is owner
    if (!BOT_OWNERS.includes(message.author.id)) {
        const settingsPath = path.join(__dirname, '..', 'data', 'promoteSettings.json');
        const settings = readJson(settingsPath, {});

        const noPermEmbed = colorManager.createEmbed()
            .setDescription(' **هذا الأمر مخصص للاونرز فقط!**');

        if (settings.menuChannel) {
            noPermEmbed.addFields([
                { name: ' روم المنيو', value: `<#${settings.menuChannel}>`, inline: true }
            ]);
        }

        return message.reply({ embeds: [noPermEmbed] });
    }

    // Check if initial setup is required
    const needsSetup = () => {
        const settingsPath = path.join(__dirname, '..', 'data', 'promoteSettings.json');
        const settings = readJson(settingsPath, {});
        return !settings.menuChannel || !settings.logChannel || !settings.allowedUsers?.type;
    };

    if (needsSetup()) {
        const settingsPath = path.join(__dirname, '..', 'data', 'promoteSettings.json');
        const settings = readJson(settingsPath, {});
        const setupEmbed = createSetupEmbed(1, settings, client);

        const setupSelect = new StringSelectMenuBuilder()
            .setCustomId('promote_setup_permission')
            .setPlaceholder('اختر نوع المعتمدين لنظام الترقيات...')
            .addOptions([
                {
                    label: 'المالكين فقط',
                    value: 'owners',
                    description: 'السماح للمالكين فقط باستخدام نظام الترقيات',
                },
                {
                    label: 'رولات محددة',
                    value: 'roles',
                    description: 'السماح لحاملي رولات معينة باستخدام نظام الترقيات',
                },
                {
                    label: 'مسؤوليات محددة',
                    value: 'responsibility',
                    description: 'السماح للمسؤولين عن مسؤوليات معينة باستخدام نظام الترقيات',
                }
            ]);

        const setupRow = new ActionRowBuilder().addComponents(setupSelect);

        return message.reply({
            embeds: [setupEmbed],
            components: [setupRow],
            content: '**مرحباً بك في إعداد نظام الترقيات المستقل!**\n\nهذا الإعداد خاص بنظام الترقيات فقط ولا يؤثر على الأنظمة الأخرى.'
        });
    }

    // If setup is complete, show admin management menu
    const settingsPath = path.join(__dirname, '..', 'data', 'promoteSettings.json');
    const settings = readJson(settingsPath, {});

    const adminEmbed = colorManager.createEmbed()
        .setTitle('Promote System Management')
        .setDescription('النظام مُعد ويعمل! يمكنك إدارته من هنا أو استخدام المنيو التفاعلي.')
        .addFields([
            {
                name: 'المنيو التفاعلي',
                value: settings.menuChannel ? `<#${settings.menuChannel}>` : 'غير محدد',
                inline: true
            },
            {
                name: 'روم السجلات',
                value: settings.logChannel ? `<#${settings.logChannel}>` : 'غير محدد',
                inline: true
            },
            {
                name: 'المعتمدين',
                value: settings.allowedUsers?.type ?
                    `${getPermissionTypeText(settings.allowedUsers.type)} (${settings.allowedUsers.targets?.length || 0})` :
                    'غير محدد',
                inline: true
            }
        ])
        .setThumbnail(client?.user?.displayAvatarURL() || 'https://cdn.discordapp.com/attachments/1373799493111386243/1400677612304470086/images__5_-removebg-preview.png?ex=688d822e&is=688c30ae&hm=1ea7a63bb89b38bcd76c0f5668984d7fc919214096a3d3ee92f5d948497fcb51&')
        .setTimestamp();

    const quickActionsSelect = new StringSelectMenuBuilder()
        .setCustomId('promote_quick_actions')
        .setPlaceholder('إجراءات سريعة...')
        .addOptions([
            {
                label: 'إعادة إرسال المنيو التفاعلي',
                value: 'resend_menu',
                description: 'إرسال المنيو التفاعلي مرة أخرى للقناة المحددة',

            },
            {
                label: 'تعديل الإعدادات',
                value: 'edit_settings',
                description: 'تعديل إعدادات النظام (المعتمدين، القنوات)',
            },
            {
                label: 'إحصائيات النظام',
                value: 'system_stats',
                description: 'عرض إحصائيات الترقيات والاستخدام',
            }
        ]);

    const actionRow = new ActionRowBuilder().addComponents(quickActionsSelect);

    const sentMessage = await message.reply({ embeds: [adminEmbed], components: [actionRow] });

    // Auto-refresh interval (every 30 seconds)
    if (!client.promoteIntervals) client.promoteIntervals = new Map();
    if (client.promoteIntervals.has(message.channel.id)) {
        clearInterval(client.promoteIntervals.get(message.channel.id));
    }

    const intervalId = setInterval(async () => {
        try {
            const currentSettings = promoteManager.getSettings();
            if (sentMessage.id === currentSettings.menuMessageId) {
                await updatePermanentMenu(client, sentMessage);
            } else {
                const refreshedEmbed = colorManager.createEmbed()
                    .setTitle('Promote System Management (Auto-refreshed)')
                    .setDescription('النظام مُعد ويعمل! يتم التحديث تلقائياً كل 30 ثانية.')
                    .addFields([
                        {
                            name: 'المنيو التفاعلي',
                            value: currentSettings.menuChannel ? `<#${currentSettings.menuChannel}>` : 'غير محدد',
                            inline: true
                        },
                        {
                            name: 'روم السجلات',
                            value: currentSettings.logChannel ? `<#${currentSettings.logChannel}>` : 'غير محدد',
                            inline: true
                        },
                        {
                            name: 'المعتمدين',
                            value: currentSettings.allowedUsers?.type ?
                                `${getPermissionTypeText(currentSettings.allowedUsers.type)} (${currentSettings.allowedUsers.targets?.length || 0})` :
                                'غير محدد',
                            inline: true
                        }
                    ])
                    .setThumbnail(client?.user?.displayAvatarURL() || 'https://cdn.discordapp.com/attachments/1373799493111386243/1400677612304470086/images__5_-removebg-preview.png?ex=688d822e&is=688c30ae&hm=1ea7a63bb89b38bcd76c0f5668984d7fc919214096a3d3ee92f5d948497fcb51&')
                    .setTimestamp();

                await sentMessage.edit({ embeds: [refreshedEmbed], components: [actionRow] }).catch(() => {
                    clearInterval(intervalId);
                    client.promoteIntervals.delete(message.channel.id);
                });
            }
        } catch (error) {
            console.error('Error refreshing promote menu:', error);
        }
    }, 30000);

    client.promoteIntervals.set(message.channel.id, intervalId);
}

async function handleInteraction(interaction, context) {
    try {
        const { client, BOT_OWNERS } = context;

        // Check interaction validity
        if (interaction.replied || interaction.deferred) {
            console.log('تم تجاهل تفاعل متكرر في promote');
            return;
        }

        const customId = interaction.customId;
        console.log(`معالجة تفاعل promote: ${customId}`);

        // Handle setup interactions
        if (customId.startsWith('promote_setup_')) {
            await handleSetupStep(interaction, context);
            // Refresh embed after setup step
            try {
                const settingsPath = path.join(__dirname, '..', 'data', 'promoteSettings.json');
                const settings = readJson(settingsPath, {});
                const currentEmbed = interaction.message.embeds[0];
                if (currentEmbed && currentEmbed.title === 'Promote System Setup') {
                    const updatedEmbed = createSetupEmbed(1, settings, client); // Approximate step
                    await interaction.editReply({ embeds: [updatedEmbed] }).catch(() => {});
                }
            } catch (e) {}
            return;
        }

        // Handle quick admin actions
        if (customId === 'promote_quick_actions') {
            await handleQuickActions(interaction, context);
            return;
        }

        // Check permissions for main functionality
        const hasPermission = await promoteManager.hasPermission(interaction, BOT_OWNERS);
        if (!hasPermission) {
            return interaction.reply({
                content: ' **ليس لديك صلاحية لاستخدام هذا النظام!**',
                flags: MessageFlags.Ephemeral
            });
        }

        // Handle main menu interactions
        if (customId === 'promote_main_menu') {
            await handleMainMenu(interaction, context);
            return;
        }

        // Handle settings button
        if (customId === 'promote_settings_button') {
            await handleSettingsButton(interaction, context);
            // تحديث المنيو بعد تغيير الإعدادات
            const settings = promoteManager.getSettings();
            if (interaction.message.id === settings.menuMessageId) {
                await updatePermanentMenu(client, interaction.message);
            }
            return;
        }

        const settings = promoteManager.getSettings();
        if (interaction.message.id === settings.menuMessageId) {
            if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate().catch(() => {});
            await updatePermanentMenu(client, interaction.message);
        } else {
            // For other messages (like the one from /promote command)
            try {
                const currentEmbed = interaction.message.embeds[0];
                if (currentEmbed) {
                    const updatedEmbed = colorManager.createEmbed()
                        .setTitle(currentEmbed.title)
                        .setDescription(currentEmbed.description)
                        .setThumbnail(currentEmbed.thumbnail?.url)
                        .setFooter({ text: 'تم التحديث بعد التفاعل | By Ahmed' })
                        .setTimestamp();

                    if (currentEmbed.fields && currentEmbed.fields.length > 0) {
                        updatedEmbed.addFields(currentEmbed.fields);
                    }
                    await interaction.editReply({ embeds: [updatedEmbed] }).catch(() => {});
                }
            } catch (e) {}
        }

        // Handle other promote interactions
        await handlePromoteInteractions(interaction, context);

    } catch (error) {
        console.error('خطأ في معالجة تفاعل promote:', error);

        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: ' **حدث خطأ أثناء المعالجة! يرجى المحاولة مرة أخرى.**',
                flags: MessageFlags.Ephemeral
            }).catch(console.error);
        }
    }
}

async function handleSetupStep(interaction, context) {
    const { client, BOT_OWNERS } = context;
    const settingsPath = path.join(__dirname, '..', 'data', 'promoteSettings.json');
    const settings = readJson(settingsPath, {
        menuChannel: null,
        logChannel: null,
        allowedUsers: { type: null, targets: [] }
    });

    if (interaction.customId === 'promote_setup_permission') {
        const selectedType = interaction.values[0];

        // Ensure allowedUsers object exists
        if (!settings.allowedUsers) {
            settings.allowedUsers = { type: null, targets: [] };
        }

        settings.allowedUsers.type = selectedType;

        if (selectedType === 'owners') {
            // Owners selected - move to next step
            settings.allowedUsers.targets = BOT_OWNERS;
            saveJson(settingsPath, settings);

            const setupEmbed = createSetupEmbed(2, settings, client);

            const channelSelect = new ChannelSelectMenuBuilder()
                .setCustomId('promote_setup_log_channel')
                .setPlaceholder(' اختر روم السجلات...')
                .setChannelTypes([ChannelType.GuildText]);

            const channelRow = new ActionRowBuilder().addComponents(channelSelect);

            await interaction.update({
                embeds: [setupEmbed],
                components: [channelRow]
            });

        } else if (selectedType === 'roles') {
            // Roles selected - show role selector
            settings.allowedUsers.targets = []; // Reset targets for new selection
            saveJson(settingsPath, settings);

            const setupEmbed = createSetupEmbed(1, settings, client);
            setupEmbed.setDescription('اختر الرولات المعتمدة لاستخدام نظام الترقيات');

            const roleSelect = new RoleSelectMenuBuilder()
                .setCustomId('promote_setup_select_roles')
                .setPlaceholder(' اختر الرولات المعتمدة...')
                .setMaxValues(10);

            const roleRow = new ActionRowBuilder().addComponents(roleSelect);

            await interaction.update({
                embeds: [setupEmbed],
                components: [roleRow]
            });

        } else if (selectedType === 'responsibility') {
            // Responsibility selected - show available responsibilities
            settings.allowedUsers.targets = []; // Reset targets for new selection
            const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
            const responsibilities = readJson(responsibilitiesPath, {});

            if (Object.keys(responsibilities).length === 0) {
                const noRespEmbed = colorManager.createEmbed()
                    .setTitle('لا توجد مسؤوليات')
                    .setDescription('لا توجد مسؤوليات معرّفة في النظام!\n\nيرجى استخدام أمر `settings` أولاً لإضافة مسؤوليات.')
                    .addFields([
                        { name: 'نصيحة', value: 'يمكنك اختيار "المالكين فقط" أو "رولات محددة" بدلاً من ذلك', inline: false }
                    ]);

                const backSelect = new StringSelectMenuBuilder()
                    .setCustomId('promote_setup_permission')
                    .setPlaceholder('🔙 اختر خياراً آخر...')
                    .addOptions([
                        {
                            label: 'المالكين فقط',
                            value: 'owners',
                            description: 'السماح للمالكين فقط باستخدام النظام',

                        },
                        {
                            label: 'رولات محددة',
                            value: 'roles',
                            description: 'السماح لحاملي رولات معينة',

                        }
                    ]);

                const backRow = new ActionRowBuilder().addComponents(backSelect);

                await interaction.update({
                    embeds: [noRespEmbed],
                    components: [backRow]
                });
                return;
            }

            // Use pagination for responsibilities
            const { components } = createPaginatedResponsibilityMenu(
                responsibilities, 
                0, 
                'promote_setup_select_responsibilities', 
                'اختر المسؤوليات المعتمدة...'
            );
            
            // Set max values for the menu in the first component
            if (components[0] && components[0].components[0]) {
                components[0].components[0].setMaxValues(Math.min(Object.keys(responsibilities).length, 10));
            }

            const setupEmbed = createSetupEmbed(1, settings, client);
            setupEmbed.setDescription('اختر المسؤوليات المعتمدة لاستخدام نظام الترقيات');

            await interaction.update({
                embeds: [setupEmbed],
                components: components
            });
        }
        return;
    }

    // Handle pagination for promote setup select responsibilities
    if (interaction.isButton() && (interaction.customId.startsWith('promote_setup_select_responsibilities_prev_page') || interaction.customId.startsWith('promote_setup_select_responsibilities_next_page'))) {
        
        const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
        const responsibilities = readJson(responsibilitiesPath, {});
        
        let currentPage = parseInt(interaction.message.components[1].components[1].label.split('/')[0]) - 1;
        if (interaction.customId.includes('prev')) currentPage--;
        else currentPage++;

        const { components } = createPaginatedResponsibilityMenu(
            responsibilities,
            currentPage,
            'promote_setup_select_responsibilities',
            'اختر المسؤوليات المعتمدة...'
        );

        if (components[0] && components[0].components[0]) {
            components[0].components[0].setMaxValues(Math.min(Object.keys(responsibilities).length, 10));
        }

        await interaction.update({ components });
        return;
    }

    // Handle pagination for promote_check_select_role
    if (interaction.isButton() && (interaction.customId.startsWith('promote_check_select_role_prev_page') || interaction.customId.startsWith('promote_check_select_role_next_page'))) {
        
        const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
        const adminRoles = readJson(adminRolesPath, []);
        
        const roleOptions = adminRoles.map(roleId => {
            const role = interaction.guild.roles.cache.get(roleId);
            return role ? {
                name: role.name,
                value: roleId,
                description: `أعضاء: ${role.members.size}`
            } : null;
        }).filter(Boolean);

        let currentPage = parseInt(interaction.message.components[1].components[1].label.match(/\d+/)[0]) - 1;
        if (interaction.customId.includes('prev')) currentPage--;
        else currentPage++;

        const { components } = createPaginatedResponsibilityArray(
            roleOptions,
            currentPage,
            'promote_check_select_role',
            'اختر الرول لعرض إحصائيات أعضائه...'
        );

        const backButton = new ButtonBuilder()
            .setCustomId('promote_check_back_to_menu')
            .setLabel('🔙 العودة للمنيو الرئيسي')
            .setStyle(ButtonStyle.Secondary);

        const backRow = new ActionRowBuilder().addComponents(backButton);

        await interaction.update({ components: [...components, backRow] });
        return;
    }

    // Handle pagination for promote_select_source_role
    if (interaction.isButton() && (interaction.customId.startsWith('promote_select_source_role_prev_page') || interaction.customId.startsWith('promote_select_source_role_next_page'))) {
        
        const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
        const adminRoles = readJson(adminRolesPath, []);
        
        const availableRoles = adminRoles.map(roleId => {
            const role = interaction.guild.roles.cache.get(roleId);
            return role ? {
                name: role.name,
                value: roleId,
                description: `ترقية جميع أعضاء ${role.name}`
            } : null;
        }).filter(Boolean);

        let currentPage = parseInt(interaction.message.components[1].components[1].label.match(/\d+/)[0]) - 1;
        if (interaction.customId.includes('prev')) currentPage--;
        else currentPage++;

        const { components } = createPaginatedResponsibilityArray(
            availableRoles,
            currentPage,
            'promote_select_source_role',
            'اختر الرول الذي تريد ترقية أعضائه...'
        );

        await interaction.update({ components });
        return;
    }

    // Handle pagination for promote_unban_select_user_eligible
    if (interaction.isButton() && (interaction.customId.startsWith('promote_unban_select_user_eligible_prev_page') || interaction.customId.startsWith('promote_unban_select_user_eligible_next_page'))) {
        // This is more complex because it depends on filtered userOptions
        // For simplicity, we'll re-run the filtering logic
        const promoteBansPath = path.join(__dirname, '..', 'data', 'promoteBans.json');
        const promoteBans = readJson(promoteBansPath, {});
        const { BOT_OWNERS } = context;

        const eligibleBans = [];
        for (const [banKey, banData] of Object.entries(promoteBans)) {
            const [userId, guildId] = banKey.split('_');
            if (guildId !== interaction.guild.id) continue;
            if (banData.endTime && banData.endTime <= Date.now()) continue;
            if (BOT_OWNERS.includes(interaction.user.id) || banData.byUserId === interaction.user.id) {
                eligibleBans.push({ userId, banKey, ...banData });
            }
        }

        const userOptions = await Promise.all(eligibleBans.map(async (ban) => {
            try {
                const member = await interaction.guild.members.fetch(ban.userId);
                return {
                    name: member.displayName,
                    value: ban.userId,
                    description: `محظور ${ban.endTime ? 'مؤقت' : 'نهائي'}`
                };
            } catch (error) {
                return {
                    name: `مستخدم غير موجود (${ban.userId})`,
                    value: ban.userId,
                    description: `محظور ${ban.endTime ? 'مؤقت' : 'نهائي'}`
                };
            }
        }));

        
        let currentPage = parseInt(interaction.message.components[1].components[1].label.match(/\d+/)[0]) - 1;
        if (interaction.customId.includes('prev')) currentPage--;
        else currentPage++;

        const { components } = createPaginatedResponsibilityArray(
            userOptions,
            currentPage,
            'promote_unban_select_user_eligible',
            'اختر العضو المحظور لفك الحظر عنه...'
        );

        await interaction.update({ components });
        return;
    }

    // Handle pagination for promote_role_
    if (interaction.isButton() && (interaction.customId.includes('_prev_page') || interaction.customId.includes('_next_page'))) {
        const parts = interaction.customId.split('_');
        if (parts[1] === 'role' && parts.length >= 4) {
            const targetId = parts[2];
            // Re-run filtering logic based on chosen type (must be in content or embed)
            const type = interaction.message.content.includes('ظواهر') ? 'type_phenomena' : 'type_letter';
            
            const guild = interaction.guild;
            const targetMember = await guild.members.fetch(targetId);
            const adminRoles = promoteManager.getAdminRoles();
            const guildRoles = await guild.roles.fetch();
            
            const targetMemberAdminRoles = targetMember.roles.cache.filter(role => adminRoles.includes(role.id));
            const highestRole = targetMemberAdminRoles
                .filter(role => type === 'type_phenomena' ? role.name.length >= 3 : role.name.length <= 2)
                .sort((a, b) => b.position - a.position)
                .first();
            const minPosition = highestRole ? highestRole.position : -1;

            const filteredRoles = adminRoles.filter(roleId => {
                const role = guildRoles.get(roleId);
                return role && (type === 'type_phenomena' ? role.name.length >= 3 : role.name.length <= 2) && role.position > minPosition;
            });

            const roleOptions = await Promise.all(filteredRoles.map(async roleId => {
                const role = await guild.roles.fetch(roleId);
                return {
                    name: role ? role.name : `رول غير معروف (${roleId})`,
                    value: roleId,
                    description: `ID: ${roleId}`
                };
            }));

            
            let currentPage = parseInt(interaction.message.components[1].components[1].label.match(/\d+/)[0]) - 1;
            if (interaction.customId.includes('prev')) currentPage--;
            else currentPage++;

            const { components } = createPaginatedResponsibilityArray(
                roleOptions,
                currentPage,
                `promote_role_${targetId}`,
                'اختر الرول المطلوب للترقية...'
            );

            await interaction.update({ components });
            return;
        }
    }

    // Handle role selection for setup
    if (interaction.customId === 'promote_setup_select_roles') {
        settings.allowedUsers.targets = interaction.values;
        saveJson(settingsPath, settings);

        // Move to log channel selection
        const setupEmbed = createSetupEmbed(2, settings, client);

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId('promote_setup_log_channel')
            .setPlaceholder(' اختر روم السجلات...')
            .setChannelTypes([ChannelType.GuildText]);

        const channelRow = new ActionRowBuilder().addComponents(channelSelect);

        await interaction.update({
            embeds: [setupEmbed],
            components: [channelRow]
        });
        return;
    }

    // Handle responsibility selection for setup
    if (interaction.customId === 'promote_setup_select_responsibilities') {
        settings.allowedUsers.targets = interaction.values;
        saveJson(settingsPath, settings);

        // Move to log channel selection
        const setupEmbed = createSetupEmbed(2, settings, client);

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId('promote_setup_log_channel')
            .setPlaceholder(' اختر روم السجلات...')
            .setChannelTypes([ChannelType.GuildText]);

        const channelRow = new ActionRowBuilder().addComponents(channelSelect);

        await interaction.update({
            embeds: [setupEmbed],
            components: [channelRow]
        });
        return;
    }

    // Handle log channel selection
    if (interaction.customId === 'promote_setup_log_channel') {
        const logChannelId = interaction.values[0];
        settings.logChannel = logChannelId;
        saveJson(settingsPath, settings);

        // Move to menu channel selection
        const setupEmbed = createSetupEmbed(3, settings, client);

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId('promote_setup_menu_channel')
            .setPlaceholder(' اختر روم المنيو التفاعلي...')
            .setChannelTypes([ChannelType.GuildText]);

        const channelRow = new ActionRowBuilder().addComponents(channelSelect);

        await interaction.update({
            embeds: [setupEmbed],
            components: [channelRow]
        });
        return;
    }

    // Handle menu channel selection - final step
    if (interaction.customId === 'promote_setup_menu_channel') {
        try {
            console.log('📋 بدء معالجة اختيار قناة المنيو...');

            const menuChannelId = interaction.values[0];
            settings.menuChannel = menuChannelId;

            console.log(`📋 حفظ قناة المنيو الجديدة: ${menuChannelId}`);
            const saveResult = saveJson(settingsPath, settings);

            if (!saveResult) {
                console.error('❌ فشل في حفظ الإعدادات');
                return interaction.reply({
                    content: '❌ **فشل في حفظ الإعدادات! يرجى المحاولة مرة أخرى.**',
                    flags: MessageFlags.Ephemeral
                });
            }

            // إرسال رسالة تأكيد أولاً
            console.log('📋 إرسال رسالة التأكيد...');
            await interaction.reply({
                content: '⏳ **جاري إكمال الإعداد وإنشاء المنيو التفاعلي...**',
                flags: MessageFlags.Ephemeral
            });

            // تأخير قصير للتأكد من معالجة الرد
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Setup complete - create permanent menu
            console.log('📋 إنشاء المنيو الدائم...');
            const success = await createPermanentMenu(client, menuChannelId);

            const completeEmbed = colorManager.createEmbed()
                .setTitle('Setup Complete Successfully')
                .setDescription('تم إكمال إعداد نظام الترقيات بنجاح!')
                .addFields([
                    { name: '✅ المعتمدين', value: `${getPermissionTypeText(settings.allowedUsers.type)} (${settings.allowedUsers.targets?.length || 0})`, inline: true },
                    { name: '✅ روم السجلات', value: `<#${settings.logChannel}>`, inline: true },
                    { name: '✅ روم المنيو', value: `<#${settings.menuChannel}>`, inline: true }
                ])
                .setThumbnail(client?.user?.displayAvatarURL())
                .setTimestamp();

            if (success) {
                completeEmbed.addFields([
                    { name: 'الحالة', value: 'النظام جاهز للاستخدام! تم إرسال المنيو التفاعلي للروم المحددة.', inline: false }
                ]);
                console.log('✅ تم إنشاء المنيو الدائم بنجاح');
            } else {
                completeEmbed.addFields([
                    { name: ' تحذير', value: 'تم الإعداد ولكن فشل في إرسال المنيو. يمكنك استخدام "إعادة إرسال المنيو" من الإعدادات.', inline: false }
                ]);
                console.log('⚠️ فشل في إنشاء المنيو الدائم');
            }

            // تحديث الرسالة بالنتيجة النهائية
            await interaction.editReply({
                content: success ? '✅ **تم إكمال الإعداد بنجاح!**' : '⚠️ **تم الإعداد مع تحذيرات**',
                embeds: [completeEmbed]
            });

            console.log('📋 تم إكمال معالجة اختيار قناة المنيو');
        } catch (error) {
            console.error('❌ خطأ في معالجة اختيار قناة المنيو:', error);

            try {
                if (interaction.replied) {
                    await interaction.editReply({
                        content: '❌ **حدث خطأ أثناء إكمال الإعداد! يرجى المحاولة مرة أخرى.**'
                    });
                } else {
                    await interaction.reply({
                        content: '❌ **حدث خطأ أثناء إكمال الإعداد! يرجى المحاولة مرة أخرى.**',
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (replyError) {
                console.error('❌ خطأ في الرد على خطأ اختيار قناة المنيو:', replyError);
            }
        }
        return;
    }
}

async function handleQuickActions(interaction, context) {
    const selectedAction = interaction.values[0];

    switch (selectedAction) {
        case 'resend_menu':
            await handleResendMenu(interaction, context);
            break;
        case 'edit_settings':
            await handleEditSettings(interaction, context);
            break;
        case 'system_stats':
            await handleSystemStats(interaction, context);
            break;
    }
}

async function handleResendMenu(interaction, context) {
    try {
        console.log('🔄 بدء معالجة إعادة إرسال المنيو...');

        const { client } = context;
        const settingsPath = path.join(__dirname, '..', 'data', 'promoteSettings.json');
        const settings = readJson(settingsPath, {});

        if (!settings.menuChannel) {
            console.log('⚠️ قناة المنيو غير محددة');
            await interaction.reply({
                content: '⚠️ **لم يتم تحديد روم المنيو! يرجى تعديل الإعدادات أولاً.**',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // التحقق من وجود القناة
        let targetChannel;
        try {
            targetChannel = await client.channels.fetch(settings.menuChannel);
            if (!targetChannel) {
                throw new Error('الروم غير موجودة');
            }
        } catch (channelError) {
            console.error('❌ خطأ في العثور على القناة:', channelError);
            await interaction.reply({
                content: '❌ **الروم المحددة للمنيو غير موجودة أو لا يمكن الوصول إليها!**',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        // إرسال رسالة تأكيد أولاً
        console.log('🔄 إرسال رسالة التأكيد...');
        await interaction.reply({
            content: '⏳ **جاري إعادة إرسال المنيو التفاعلي...**',
            flags: MessageFlags.Ephemeral
        });

        // تأخير قصير للتأكد من معالجة الرد
        await new Promise(resolve => setTimeout(resolve, 500));

        // حذف الرسالة القديمة إذا كانت موجودة
        if (settings.menuMessageId) {
            try {
                console.log('🗑️ محاولة حذف الرسالة القديمة...');
                const oldMessage = await targetChannel.messages.fetch(settings.menuMessageId);
                if (oldMessage) {
                    await oldMessage.delete();
                    console.log('✅ تم حذف الرسالة القديمة');
                }
            } catch (deleteError) {
                console.log('⚠️ لم يتم العثور على الرسالة القديمة أو تم حذفها مسبقاً');
            }

            // تنظيف معرف الرسالة القديمة
            settings.menuMessageId = null;
            saveJson(settingsPath, settings);
        }

        // تأخير إضافي بين حذف الرسالة القديمة وإنشاء الجديدة
        await new Promise(resolve => setTimeout(resolve, 1000));

        // إنشاء المنيو الجديد
        console.log('🔄 إنشاء المنيو الجديد...');
        const success = await createPermanentMenu(client, settings.menuChannel);

        if (success) {
            console.log('✅ تم إعادة إرسال المنيو بنجاح');
            await interaction.editReply({
                content: '✅ **تم إعادة إرسال المنيو التفاعلي بنجاح!**\n\n' +
                        `**الروم :** <#${settings.menuChannel}>\n` +
                        ` **الوقت :** <t:${Math.floor(Date.now() / 1000)}:F>`
            });
        } else {
            console.log('❌ فشل في إعادة إرسال المنيو');
            await interaction.editReply({
                content: '❌ **فشل في إعادة إرسال المنيو!**\n\n' +
                        '**الأسباب المحتملة:**\n' +
                        '• عدم وجود صلاحيات كافية للبوت في الروم\n' +
                        '• الروم محذوفة أو غير متاحة\n' +
                        '• خطأ في الاتصال\n\n' +
                        '**يرجى التحقق من الصلاحيات والمحاولة مرة أخرى.**'
            });
        }

        console.log('🔄 تم إكمال معالجة إعادة إرسال المنيو');

    } catch (error) {
        console.error('❌ خطأ في معالجة إعادة إرسال المنيو:', error);

        try {
            if (interaction.replied) {
                await interaction.editReply({
                    content: '❌ **حدث خطأ أثناء إعادة إرسال المنيو!**\n\n' +
                            `**تفاصيل الخطأ:** ${error.message || 'خطأ غير معروف'}\n\n` +
                            '**يرجى المحاولة مرة أخرى أو الاتصال بالدعم.**'
                });
            } else {
                await interaction.reply({
                    content: '❌ **حدث خطأ أثناء إعادة إرسال المنيو! يرجى المحاولة مرة أخرى.**',
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (replyError) {
            console.error('❌ خطأ في الرد على خطأ إعادة إرسال المنيو:', replyError);
        }
    }
}

async function handleSystemStats(interaction, context) {
    // Create quick stats or detailed stats menu
    const statsSelect = new StringSelectMenuBuilder()
        .setCustomId('promote_stats_menu')
        .setPlaceholder('اختر نوع الإحصائيات...')
        .addOptions([
            {
                label: 'إحصائيات سريعة',
                value: 'quick_stats',
                description: 'عرض نظرة عامة سريعة على النظام'
            },
            {
                label: 'إحصائيات مفصلة',
                value: 'detailed_stats',
                description: 'عرض إحصائيات شاملة ومفصلة'
            },
            {
                label: 'إعادة تعيين النظام',
                value: 'reset_system',
                description: 'إعادة تعيين جميع البيانات والإعدادات'
            }
        ]);

    const statsRow = new ActionRowBuilder().addComponents(statsSelect);

    await interaction.reply({
        content: ' **اختر نوع الإحصائيات المطلوبة:**',
        components: [statsRow],
        flags: MessageFlags.Ephemeral
    });
}

async function createSystemStats() {
    const settingsPath = path.join(__dirname, '..', 'data', 'promoteSettings.json');
    const settings = readJson(settingsPath, {});
    const activePromotesPath = path.join(__dirname, '..', 'data', 'activePromotes.json');
    const activePromotes = readJson(activePromotesPath, {});
    const promoteLogsPath = path.join(__dirname, '..', 'data', 'promoteLogs.json');
    const promoteLogs = readJson(promoteLogsPath, []);

    const totalActivePromotes = Object.keys(activePromotes).length;
    const totalPromoteLogs = promoteLogs.length;

    const embed = colorManager.createEmbed()
        .setTitle('Promote System Statistics')
        .setDescription('إحصائيات شاملة عن نظام الترقيات')
        .addFields([
            { name: ' الترقيات النشطة', value: totalActivePromotes.toString(), inline: true },
            { name: ' إجمالي السجلات', value: totalPromoteLogs.toString(), inline: true },
            { name: ' المعتمدين', value: settings.allowedUsers?.type ? `${getPermissionTypeText(settings.allowedUsers.type)}` : 'غير محدد', inline: true },
            { name: ' روم السجلات', value: settings.logChannel ? `<#${settings.logChannel}>` : 'غير محدد', inline: true },
            { name: ' روم المنيو', value: settings.menuChannel ? `<#${settings.menuChannel}>` : 'غير محدد', inline: true },
            { name: ' حالة النظام', value: needsSetup() ? 'يحتاج إعداد' : 'جاهز', inline: true }
        ])
        .setTimestamp();

    return embed;
}

async function handleMainMenu(interaction, context) {
    const selectedOption = interaction.values[0];

    switch (selectedOption) {
        case 'promote_user_or_role':
            await handlePromoteUserOrRole(interaction, context);
            break;
        case 'promotion_records':
            await handlePromotionRecords(interaction, context);
            break;
        case 'ban_from_promotion':
            await handleBanFromPromotion(interaction, context);
            break;
        case 'unban_promotion':
            await handleUnbanPromotion(interaction, context);
            break;
        case 'check_admin_activity':
            await handleCheckAdminActivity(interaction, context);
            break;
    }
}

async function handlePromoteUserOrRole(interaction, context) {
    // إنشاء قائمة خيارات للترقية
    const optionSelect = new StringSelectMenuBuilder()
        .setCustomId('promote_user_or_role_option')
        .setPlaceholder('اختر طريقة الترقية...')
        .addOptions([
            {
                label: 'ترقية شخص محدد',
                value: 'promote_specific_user',
                description: 'ترقية عضو معين إلى رول إداري'
            },
            {
                label: 'ترقية من رول محدد',
                value: 'promote_from_role',
                description: 'ترقية جميع أعضاء رول معين إلى رول أعلى'
            }
        ]);

    const optionRow = new ActionRowBuilder().addComponents(optionSelect);

    await interaction.reply({
        content: ' **اختر طريقة الترقية المطلوبة:**',
        components: [optionRow],
        flags: MessageFlags.Ephemeral
    });
}

async function handlePromotionRecords(interaction, context) {
    // إنشاء قائمة خيارات لسجلات الترقيات
    const optionSelect = new StringSelectMenuBuilder()
        .setCustomId('promote_records_option')
        .setPlaceholder('اختر نوع السجلات...')
        .addOptions([
            {
                label: 'سجل شخص محدد',
                value: 'records_specific_user',
                description: 'عرض سجلات ترقيات عضو معين'
            },
            {
                label: 'سجل رول محدد',
                value: 'records_specific_role',
                description: 'عرض سجلات جميع ترقيات رول معين'
            }
        ]);

    const optionRow = new ActionRowBuilder().addComponents(optionSelect);

    await interaction.reply({
        content: ' **اختر نوع السجلات المطلوب عرضها:**',
        components: [optionRow],
        flags: MessageFlags.Ephemeral
    });
}

async function handleBanFromPromotion(interaction, context) {
    const userSelect = new UserSelectMenuBuilder()
        .setCustomId('promote_ban_select_user')
        .setPlaceholder(' اختر العضو لحظره من الترقيات...')
        .setMaxValues(1);

    const userRow = new ActionRowBuilder().addComponents(userSelect);

    await interaction.reply({
        content: ' **اختر العضو لحظره من الترقيات:**',
        components: [userRow],
        flags: MessageFlags.Ephemeral
    });
}

async function handleUnbanPromotion(interaction, context) {
    // Get banned users that this moderator can unban
    const promoteBansPath = path.join(__dirname, '..', 'data', 'promoteBans.json');
    const promoteBans = readJson(promoteBansPath, {});
    const { BOT_OWNERS } = context;

    // Filter bans: owners can unban anyone, others only their own bans
    const eligibleBans = [];
    for (const [banKey, banData] of Object.entries(promoteBans)) {
        const [userId, guildId] = banKey.split('_');

        // Skip if different guild
        if (guildId !== interaction.guild.id) continue;

        // Skip if ban has expired
        if (banData.endTime && banData.endTime <= Date.now()) continue;

        // Check permissions: owners can unban anyone, others only their own bans
        if (BOT_OWNERS.includes(interaction.user.id) || banData.byUserId === interaction.user.id) {
            eligibleBans.push({
                userId: userId,
                banKey: banKey,
                ...banData
            });
        }
    }

    if (eligibleBans.length === 0) {
        const noEligibleEmbed = colorManager.createEmbed()
            .setDescription('**لا يوجد أعضاء محظورين مؤهلين لفك الحظر عنهم.**\n\n' +
                           '**يمكنك فك الحظر عن:**\n' +
                           '• الأعضاء الذين قمت بحظرهم بنفسك\n' +
                           (BOT_OWNERS.includes(interaction.user.id) ? '• جميع الأعضاء المحظورين (كونك مالك)' : ''));

        await interaction.reply({
            embeds: [noEligibleEmbed],
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Create user options with ban details
    const userOptions = await Promise.all(eligibleBans.map(async (ban) => {
        try {
            const member = await interaction.guild.members.fetch(ban.userId);
            const banEndText = ban.endTime ? 
                `ينتهي <t:${Math.floor(ban.endTime / 1000)}:R>` : 
                'نهائي';

            return {
                label: member.displayName.substring(0, 100),
                value: ban.userId,
                description: `محظور ${banEndText} - بواسطة <@${ban.byUserId}>`.substring(0, 100)
            };
        } catch (error) {
            return {
                label: `مستخدم غير موجود (${ban.userId})`.substring(0, 100),
                value: ban.userId,
                description: `محظور ${ban.endTime ? 'مؤقت' : 'نهائي'} - بواسطة <@${ban.byUserId}>`.substring(0, 100)
            };
        }
    }));

    // Use pagination for unban list
    const { components } = createPaginatedResponsibilityArray(
        userOptions.map(opt => ({ name: opt.label, value: opt.value, description: opt.description })),
        0,
        'promote_unban_select_user_eligible',
        'اختر العضو المحظور لفك الحظر عنه...'
    );

    const eligibleEmbed = colorManager.createEmbed()
        .setTitle('Eligible Banned Users')
        .setDescription(`**الأعضاء المحظورين المؤهلين لفك الحظر عنهم:** **${eligibleBans.length}** عضو\n\n` +
                       'يمكنك فك الحظر عن الأعضاء الذين تم حظرهم بواسطتك أو كونك مالك.')
        .addFields([
            { name: ' إجمالي المحظورين', value: Object.keys(promoteBans).length.toString(), inline: true },
            { name: ' مؤهلين لك', value: eligibleBans.length.toString(), inline: true },
            { name: ' الصلاحية', value: BOT_OWNERS.includes(interaction.user.id) ? 'مالك (الكل)' : 'محدودة', inline: true }]);

    await interaction.reply({
        embeds: [eligibleEmbed],
        components: components,
        flags: MessageFlags.Ephemeral
    });
}

// دالة لإنشاء embed إحصائيات الرول
async function createRoleStatsEmbed(role, membersArray, period = 'weekly') {
    const { getDatabase } = require('../utils/database');
    const dbManager = getDatabase();

    // جمع الإحصائيات لجميع الأعضاء
    const stats = [];
    
    for (const member of membersArray) {
        if (member.user.bot) continue;

        try {
            const userStats = await dbManager.getUserStats(member.id);
            const weeklyStats = await dbManager.getWeeklyStats(member.id);

            const messages = period === 'weekly' ? (weeklyStats.weeklyMessages || 0) : (userStats.totalMessages || 0);
            const voiceTime = period === 'weekly' ? (weeklyStats.weeklyTime || 0) : (userStats.totalVoiceTime || 0);
            const voiceJoins = period === 'weekly' ? (weeklyStats.weeklyVoiceJoins || 0) : (userStats.totalVoiceJoins || 0);
            const reactions = period === 'weekly' ? (weeklyStats.weeklyReactions || 0) : (userStats.totalReactions || 0);

            // حساب النشاط الإجمالي (مجموع كل الأنشطة)
            const totalActivity = messages + Math.floor(voiceTime / 60000) + voiceJoins + reactions;

            stats.push({
                member,
                messages,
                voiceTime,
                voiceJoins,
                reactions,
                totalActivity
            });
        } catch (error) {
            console.error(`خطأ في جلب إحصائيات ${member.displayName}:`, error);
        }
    }

    // ترتيب حسب كل فئة
    const topMessages = [...stats].sort((a, b) => b.messages - a.messages).slice(0, 1);
    const topVoiceTime = [...stats].sort((a, b) => b.voiceTime - a.voiceTime).slice(0, 1);
    const topVoiceJoins = [...stats].sort((a, b) => b.voiceJoins - a.voiceJoins).slice(0, 1);
    const topReactions = [...stats].sort((a, b) => b.reactions - a.reactions).slice(0, 1);
    const topActivity = [...stats].sort((a, b) => b.totalActivity - a.totalActivity).slice(0, 1);

    // تنسيق وقت الفويس
    function formatVoiceTime(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const days = Math.floor(totalSeconds / 86400);
        const hours = Math.floor((totalSeconds % 86400) / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);

        const parts = [];
        if (days > 0) parts.push(`${days} يوم`);
        if (hours > 0) parts.push(`${hours} ساعة`);
        if (minutes > 0) parts.push(`${minutes} دقيقة`);

        return parts.length > 0 ? parts.join(' و ') : 'لا يوجد';
    }

    const embed = colorManager.createEmbed()
        .setTitle(`📊 إحصائيات: ${role.name}`)
        .setDescription(`**الفترة:** ${period === 'weekly' ? 'الأسبوع الحالي' : 'الإجمالي'}\n**عدد الأعضاء:** ${stats.length}`)
        .setThumbnail(role.iconURL() || 'https://cdn.discordapp.com/emojis/1365249109149089813.png?v=1')
        .setFooter({ text: 'By Ahmed' })
        .setTimestamp();

    // إضافة الحقول
    if (topMessages[0]) {
        embed.addFields({
            name: '📬 أعلى من أرسل رسائل',
            value: `<@${topMessages[0].member.id}>\n**${topMessages[0].messages.toLocaleString()}** رسالة`,
            inline: true
        });
    }

    if (topVoiceTime[0]) {
        embed.addFields({
            name: '🎤 أعلى من جلس بالفويسات',
            value: `<@${topVoiceTime[0].member.id}>\n${formatVoiceTime(topVoiceTime[0].voiceTime)}`,
            inline: true
        });
    }

    if (topVoiceJoins[0]) {
        embed.addFields({
            name: '🔗 أكثر من انضم لفويسات',
            value: `<@${topVoiceJoins[0].member.id}>\n**${topVoiceJoins[0].voiceJoins.toLocaleString()}** انضمام`,
            inline: true
        });
    }

    if (topReactions[0]) {
        embed.addFields({
            name: '⭐ أكثر من وضع تفاعل',
            value: `<@${topReactions[0].member.id}>\n**${topReactions[0].reactions.toLocaleString()}** تفاعل`,
            inline: true
        });
    }

    if (topActivity[0]) {
        embed.addFields({
            name: '🏆 أكثر نشاط من كل النواحي',
            value: `<@${topActivity[0].member.id}>\n**نقاط النشاط:** ${topActivity[0].totalActivity.toLocaleString()}`,
            inline: true
        });
    }

    if (stats.length === 0) {
        embed.setDescription('**لا توجد بيانات متاحة للأعضاء في هذا الرول**');
    }

    return embed;
}

async function handleCheckAdminActivity(interaction, context) {
    // جلب الرولات الإدارية
    const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
    const adminRoles = readJson(adminRolesPath, []);

    if (adminRoles.length === 0) {
        return interaction.reply({
            content: '⚠️ **لا توجد رولات إدارية محددة! يرجى إضافة رولات إدارية أولاً.**',
            flags: MessageFlags.Ephemeral
        });
    }

    // إنشاء قائمة الرولات
    const roleOptions = adminRoles.map(roleId => {
        const role = interaction.guild.roles.cache.get(roleId);
        return role ? {
            label: role.name.substring(0, 100),
            value: roleId,
            description: `أعضاء: ${role.members.size}`
        } : null;
    }).filter(Boolean);

    if (roleOptions.length === 0) {
        return interaction.reply({
            content: '⚠️ **لا توجد رولات صالحة!**',
            flags: MessageFlags.Ephemeral
        });
    }

    // Use pagination for roles if more than 25
    
    const { components } = createPaginatedResponsibilityArray(
        roleOptions,
        0,
        'promote_check_select_role',
        'اختر الرول لعرض إحصائيات أعضائه...'
    );

    const checkEmbed = colorManager.createEmbed()
        .setTitle('📊 إحصائيات الأدوار الإدارية')
        .setDescription(`**اختر رول لعرض إحصائيات أعضائه**\n\n**الإحصائيات المتاحة:**\n• أعلى من أرسل رسائل\n• أعلى من جلس بالفويسات\n• أكثر من انضم لفويسات\n• أكثر من وضع تفاعل\n• أكثر نشاط من كل النواحي`)
        .setThumbnail(context.client.user.displayAvatarURL())
        .setFooter({ text: 'By Ahmed' });

    const backButton = new ButtonBuilder()
        .setCustomId('promote_check_back_to_menu')
        .setLabel('🔙 العودة للمنيو الرئيسي')
        .setStyle(ButtonStyle.Secondary);

    const backRow = new ActionRowBuilder().addComponents(backButton);

    await interaction.reply({
        embeds: [checkEmbed],
        components: [...components, backRow],
        flags: MessageFlags.Ephemeral
    });
}

async function handleSettingsButton(interaction, context) {
    const settingsEmbed = colorManager.createEmbed()
        .setTitle('Promote System Settings')
        .setDescription('إدارة إعدادات نظام الترقيات')
        .addFields([
            { name: ' تعديل الإعدادات', value: 'تغيير المعتمدين، الرومات، أو إعدادات أخرى', inline: false },
            { name: ' إعادة إرسال المنيو', value: 'إعادة إرسال المنيو التفاعلي للروم المحددة', inline: false },
            { name: ' إحصائيات النظام', value: 'عرض إحصائيات شاملة عن الاستخدام', inline: false }
        ]);

    const settingsSelect = new StringSelectMenuBuilder()
        .setCustomId('promote_settings_menu')
        .setPlaceholder('اختر الإعداد المطلوب...')
        .addOptions([
            {
                label: 'تعديل المعتمدين',
                value: 'edit_permissions',
                description: 'تغيير من يحق له استخدام النظام'
            },
            {
                label: 'تعديل روم السجلات',
                value: 'edit_log_channel',
                description: 'تغيير قناة حفظ سجلات الترقيات'
            },
            {
                label: 'تعديل الروم المنيو',
                value: 'edit_menu_channel',
                description: 'تغيير قناة المنيو التفاعلي'
            },
            {
                label: 'إعادة إرسال المنيو',
                value: 'resend_menu',
                description: 'إعادة إرسال المنيو التفاعلي'
            },
            {
                label: 'إحصائيات مفصلة',
                value: 'detailed_stats',
                description: 'عرض إحصائيات شاملة عن النظام'
            },
            {
                label: 'إعادة تعيين النظام',
                value: 'reset_system',
                description: 'حذف جميع البيانات والإعدادات'
            }
        ]);

    const settingsRow = new ActionRowBuilder().addComponents(settingsSelect);

    await interaction.reply({
        embeds: [settingsEmbed],
        components: [settingsRow],
        flags: MessageFlags.Ephemeral
    });
}

async function handlePromoteInteractions(interaction, context) {
    const customId = interaction.customId;

    // Handle main menu selection
    if (interaction.isStringSelectMenu() && customId === 'promote_main_menu') {
        // Reset selection immediately by updating the message components
        const currentSelect = interaction.message.components[0].components[0];
        const updatedOptions = currentSelect.options.map(opt => {
            const optData = opt.toJSON ? opt.toJSON() : opt;
            return {
                ...optData,
                default: false
            };
        });
        
        const updatedSelect = new StringSelectMenuBuilder()
            .setCustomId(currentSelect.customId)
            .setPlaceholder(currentSelect.placeholder)
            .addOptions(updatedOptions);
            
        const updatedRow = new ActionRowBuilder().addComponents(updatedSelect);
        
        // Use followUp or separate update if needed, but first process the logic
        await handleMainMenu(interaction, context);
        
        // Then ensure the original menu is reset
        try {
            await interaction.message.edit({
                components: [updatedRow, ...interaction.message.components.slice(1)]
            });
        } catch (error) {
            console.log('فشل في إعادة ضبط القائمة الرئيسية:', error.message);
        }
        return;
    }

    // Handle settings menu
    if (interaction.isStringSelectMenu() && customId === 'promote_settings_menu') {
        const selectedOption = interaction.values[0];
        switch (selectedOption) {
            case 'edit_permissions':
                await handleEditPermissions(interaction, context);
                break;
            case 'edit_log_channel':
                await handleEditLogChannel(interaction, context);
                break;
            case 'edit_menu_channel':
                await handleEditMenuChannel(interaction, context);
                break;
            case 'resend_menu':
                await handleResendMenu(interaction, context);
                break;
            case 'detailed_stats':
                await handleDetailedStats(interaction, context);
                break;
            case 'reset_system':
                await handleResetSystem(interaction, context);
                break;
        }
        return;
    }

    // Handle stats menu
    if (interaction.isStringSelectMenu() && customId === 'promote_stats_menu') {
        const selectedOption = interaction.values[0];
        switch (selectedOption) {
            case 'quick_stats':
                const quickStats = await createSystemStats();
                await interaction.update({
                    embeds: [quickStats],
                    components: []
                });
                break;
            case 'detailed_stats':
                await handleDetailedStats(interaction, context);
                break;
            case 'reset_system':
                await handleResetSystem(interaction, context);
                break;
        }
        return;
    }

    // Handle promote user or role option selection
    if (interaction.isStringSelectMenu() && customId === 'promote_user_or_role_option') {
        const selectedOption = interaction.values[0];

        if (selectedOption === 'promote_specific_user') {
            const userSelect = new UserSelectMenuBuilder()
                .setCustomId('promote_select_user')
                .setPlaceholder(' اختر العضو للترقية...')
                .setMaxValues(1);

            const userRow = new ActionRowBuilder().addComponents(userSelect);

            await interaction.update({
                content: ' **اختر العضو الذي تريد ترقيته:**',
                components: [userRow]
            });
        } else if (selectedOption === 'promote_from_role') {
            const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
            const adminRoles = readJson(adminRolesPath, []);

            if (adminRoles.length === 0) {
                await interaction.update({
                    content: '⚠️ **لا توجد رولات إدارية محددة! يرجى إضافة رولات إدارية أولاً.**',
                    components: []
                });
                return;
            }

            const availableRoles = adminRoles.map(roleId => {
                const role = interaction.guild.roles.cache.get(roleId);
                return role ? {
                    label: role.name.substring(0, 100),
                    value: roleId,
                    description: `ترقية جميع أعضاء ${role.name}`
                } : {
                    label: `رول غير معروف (${roleId})`,
                    value: roleId,
                    description: `رول غير موجود في السيرفر`
                };
            });

            // Use pagination for roles if more than 25
            
            const { components } = createPaginatedResponsibilityArray(
                availableRoles,
                0,
                'promote_select_source_role',
                'اختر الرول الذي تريد ترقية أعضائه...'
            );

            await interaction.update({
                content: ' **اختر الرول الذي تريد ترقية أعضائه:**',
                components: components
            });
        }
        return;
    }

    // Handle source role selection for bulk promotion
    if (interaction.isStringSelectMenu() && customId === 'promote_select_source_role') {
        const sourceRoleId = interaction.values[0];
        const sourceRole = interaction.guild.roles.cache.get(sourceRoleId);

        if (!sourceRole) {
            await interaction.update({
                content: ' **لم يتم العثور على الرول المصدر!**',
                components: []
            });
            return;
        }

        // Get members with this role and show stats
        const membersWithRole = sourceRole.members;

        console.log(`فحص الرول ${sourceRole.name}: يحتوي على ${membersWithRole.size} عضو`);

        if (membersWithRole.size === 0) {
            console.log(`الرول ${sourceRole.name} لا يحتوي على أعضاء`);
            await interaction.update({
                content: ` **الرول** <@&${sourceRoleId}> **لا يحتوي على أي أعضاء!**`,
                components: []
            });
            return;
        }

        // Get target role for checking if members already have it
        const targetRoleId = interaction.customId.split('_')[4]; // This will be set later, for now we'll get it from the next step

        // Get database stats for all members
        const database = context.database;
        let statsText = '';
        let validMembers = 0;
        let excludedMembers = [];

        // Check bans and collect stats
        const promoteBansPath = path.join(__dirname, '..', 'data', 'promoteBans.json');
        const promoteBans = readJson(promoteBansPath, {});
        let bannedMembers = [];
        let membersWithTargetRole = [];

        console.log(`بدء فحص ${membersWithRole.size} عضو في الرول ${sourceRole.name}`);

        for (const [userId, member] of membersWithRole) {
            const banKey = `${userId}_${interaction.guild.id}`;

            console.log(`فحص العضو: ${member.displayName} (${userId})`);

            // تجاهل البوتات
            if (member.user.bot) {
                excludedMembers.push({
                    name: member.displayName,
                    reason: 'بوت'
                });
                console.log(`العضو ${member.displayName} بوت - تم تجاهله`);
                continue;
            }

            // Check if banned from promotions
            if (promoteBans[banKey]) {
                const banData = promoteBans[banKey];
                const banEndTime = banData.endTime;

                if (!banEndTime || banEndTime > Date.now()) {
                    bannedMembers.push(`<@${userId}>`);
                    excludedMembers.push({
                        name: member.displayName,
                        reason: 'محظور من الترقيات'
                    });
                    console.log(`العضو ${member.displayName} محظور من الترقيات`);
                    continue;
                }
            }

            // Get stats from database with better error handling
            const databaseModule = require('../utils/database');
            let database = null;
            try {
                database = databaseModule.getDatabase();
            } catch (error) {
                console.log(`قاعدة البيانات غير متاحة للعضو ${member.displayName}`);
            }

            let memberIsValid = true;

            if (database) {
                try {
                    const userStats = await database.get(
                        'SELECT total_voice_time, total_messages, total_voice_joins FROM user_totals WHERE user_id = ?',
                        [userId]
                    );

                    const voiceMinutes = userStats ? Math.floor(userStats.total_voice_time / 60000) : 0;
                    const messages = userStats ? userStats.total_messages : 0;
                    const voiceJoins = userStats ? userStats.total_voice_joins : 0;

                    // Get member join date
                    const joinedDate = member.joinedTimestamp ? 
                        `<t:${Math.floor(member.joinedTimestamp / 1000)}:d>` : 'غير معروف';

                    // تنسيق منظم للمعلومات
                    statsText += `**${member.displayName}** <@${userId}>\n`;
                    statsText += `├─ 📅 **انضم :** ${joinedDate}\n`;
                    statsText += `├─ 💬 **الرسائل :** ${messages.toLocaleString()}\n`;
                    statsText += `├─ 🎤 **الوقت بالفويسات :** ${voiceMinutes.toLocaleString()} دقيقة\n`;
                    statsText += `└─ 🔗 **انضمام فويس :** ${voiceJoins.toLocaleString()}\n\n`;

                } catch (dbError) {
                    console.error(`خطأ في قراءة إحصائيات العضو ${userId}:`, dbError);
                    // لا نستبعد العضو بسبب خطأ في قاعدة البيانات، بل نعرض بيانات أساسية
                    const joinedDate = member.joinedTimestamp ? 
                        `<t:${Math.floor(member.joinedTimestamp / 1000)}:d>` : 'غير معروف';

                    statsText += `**${member.displayName}** <@${userId}>\n`;
                    statsText += `├─ 📅 **انضم :** ${joinedDate}\n`;
                    statsText += `└─ ⚠️ خطأ في قراءة البيانات (سيتم المتابعة)\n\n`;
                }
            } else {
                // قاعدة البيانات غير متاحة - نعرض بيانات أساسية
                const joinedDate = member.joinedTimestamp ? 
                    `<t:${Math.floor(member.joinedTimestamp / 1000)}:d>` : 'غير معروف';

                statsText += `**${member.displayName}** <@${userId}>\n`;
                statsText += `├─ 📅 **انضم :** ${joinedDate}\n`;
                statsText += `└─ ⚠️ بيانات غير متاحة\n\n`;
            }

            if (memberIsValid) {
                validMembers++;
                console.log(`العضو ${member.displayName} مؤهل للترقية`);
            }
        }

        console.log(`تم فحص جميع الأعضاء: ${validMembers} مؤهل، ${bannedMembers.length} محظور، ${excludedMembers.length} مستبعد`);

        // Create embed with stats
        const statsEmbed = colorManager.createEmbed()
            .setTitle('Bulk Promotion Preview')
            .setDescription(`**معاينة ترقية أعضاء الرول** <@&${sourceRoleId}>\n\n**الأعضاء المؤهلين للترقية:**\n${statsText}`)
            .addFields([
                { name: ' إجمالي الأعضاء', value: membersWithRole.size.toString(), inline: true },
                { name: ' مؤهلين للترقية', value: validMembers.toString(), inline: true },
                { name: ' مستبعدين', value: (excludedMembers.length + bannedMembers.length).toString(), inline: true }
            ]);

        // إضافة تفاصيل الأعضاء المستبعدين
        if (excludedMembers.length > 0 || bannedMembers.length > 0) {
            let excludedText = '';

            // الأعضاء المحظورين
            if (bannedMembers.length > 0) {
                excludedText += `**محظورين من الترقيات (${bannedMembers.length}):**\n`;
                excludedText += bannedMembers.slice(0, 5).join(', ');
                if (bannedMembers.length > 5) excludedText += `\n*+${bannedMembers.length - 5} محظور إضافي*`;
                excludedText += '\n\n';
            }

            // الأعضاء المستبعدين لأسباب أخرى
            if (excludedMembers.length > 0) {
                excludedText += `**مستبعدين لأسباب أخرى (${excludedMembers.length}):**\n`;
                const otherExcluded = excludedMembers.slice(0, 5);
                for (const excluded of otherExcluded) {
                    excludedText += `• ${excluded.name} - ${excluded.reason}\n`;
                }
                if (excludedMembers.length > 5) {
                    excludedText += `*+${excludedMembers.length - 5} مستبعد إضافي*\n`;
                }
            }

            if (excludedText) {
                statsEmbed.addFields([
                    { name: ' الأعضاء المستبعدين', value: excludedText.trim(), inline: false }
                ]);
            }
        }

        if (validMembers === 0) {
            statsEmbed.addFields([
                { name: '⚠️ **ملاحظة مهمة**', value: 'لا يوجد أعضاء مؤهلين للترقية! جميع الأعضاء إما محظورين أو لديهم مشاكل في البيانات', inline: false }
            ]);
            await interaction.update({
                embeds: [statsEmbed],
                content: ' **لا يوجد أعضاء مؤهلين للترقية!**',
                components: []
            });
            return;
        }

        // إضافة ملاحظة توضيحية إذا كان هناك أعضاء مستبعدين
        if (excludedMembers.length > 0 || bannedMembers.length > 0) {
            statsEmbed.addFields([
                { name: '📋 **ملاحظة**', value: `يتم عرض ${validMembers} من أصل ${membersWithRole.size} عضو. الباقي مستبعد للأسباب المذكورة أعلاه.`, inline: false }
            ]);
        }

        // Show admin roles for selection - only higher roles
        const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
        const adminRoles = readJson(adminRolesPath, []);
        const currentSourceRole = interaction.guild.roles.cache.get(sourceRoleId);

        // إضافة مرحلة اختيار النوع (ظواهر أو حرف) للترقية الجماعية
        const typeSelect = new StringSelectMenuBuilder()
            .setCustomId(`promote_bulk_type_select_${sourceRoleId}`)
            .setPlaceholder('اختر نوع الترقية (ظواهر / حرف)...')
            .addOptions([
                {
                    label: 'ظواهر',
                    value: 'type_phenomena',
                    description: 'عرض الرولات الإدارية التي تتكون من 3 حروف فأكثر',
                    emoji: '🌟'
                },
                {
                    label: 'حرف إداري',
                    value: 'type_letter',
                    description: 'عرض الرولات الإدارية التي تتكون من حرف أو حرفين فقط',
                    emoji: '🔤'
                }
            ]);

        const typeRow = new ActionRowBuilder().addComponents(typeSelect);

        await interaction.update({
            embeds: [statsEmbed],
            content: ' **يرجى اختيار نوع الترقية لعرض الرولات الجماعية المناسبة:**',
            components: [typeRow]
        });
        return;
    }

    // Handle bulk type selection
    if (interaction.isStringSelectMenu() && customId.startsWith('promote_bulk_type_select_')) {
        const sourceRoleId = customId.split('_')[4];
        const type = interaction.values[0];
        
        // Update selection in current message components to keep it visual
        const currentSelect = interaction.message.components[0].components[0];
        const updatedOptions = currentSelect.options.map(opt => {
            const optData = opt.toJSON ? opt.toJSON() : opt;
            return {
                ...optData,
                default: false
            };
        });
        
        const updatedSelect = new StringSelectMenuBuilder()
            .setCustomId(currentSelect.customId)
            .setPlaceholder(currentSelect.placeholder)
            .addOptions(updatedOptions);
        
        const updatedRow = new ActionRowBuilder().addComponents(updatedSelect);
        
        const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
        const adminRoles = readJson(adminRolesPath, []);
        const currentSourceRole = interaction.guild.roles.cache.get(sourceRoleId);

        const availableTargetRoles = adminRoles.filter(roleId => {
            if (roleId === sourceRoleId) return false;
            const targetRole = interaction.guild.roles.cache.get(roleId);
            
            // فلترة حسب النوع (ظواهر أو حرف) والوضعية (أعلى فقط)
            if (!targetRole || !currentSourceRole || targetRole.position <= currentSourceRole.position) return false;
            
            if (type === 'type_phenomena') {
                return targetRole.name.length >= 3;
            } else {
                return targetRole.name.length <= 2;
            }
        }).map(roleId => {
            const role = interaction.guild.roles.cache.get(roleId);
            return role ? {
                name: role.name,
                value: `${sourceRoleId}_${roleId}`,
                description: `ترقية إلى ${role.name} (${type === 'type_phenomena' ? 'ظواهر' : 'حرف'})`
            } : {
                name: `رول غير معروف (${roleId})`,
                value: `${sourceRoleId}_${roleId}`,
                description: `رول غير موجود في السيرفر`
            };
        }).filter(Boolean);

        if (availableTargetRoles.length === 0) {
            await interaction.update({
                content: `⚠️ **لا توجد رولات ${type === 'type_phenomena' ? 'ظواهر' : 'حرف'} متاحة للترقية إليها وموضعية أعلى من الرول الحالي!**`,
                components: [updatedRow]
            });
            return;
        }

        // Use pagination for bulk roles
        
        const { components } = createPaginatedResponsibilityArray(
            availableTargetRoles,
            0,
            'promote_bulk_role_target',
            'اختر الرول المستهدف للترقية...'
        );

        await interaction.update({
            content: `**الرول الحالي:** <@&${sourceRoleId}>\n**النوع المختار:** ${type === 'type_phenomena' ? 'ظواهر' : 'حرف'}\nاختر الرول المستهدف:`,
            components: [updatedRow, ...components]
        });
        return;
    }

    // Handle pagination for promote_bulk_role_target
    if (interaction.isButton() && (interaction.customId.startsWith('promote_bulk_role_target_prev_page') || interaction.customId.startsWith('promote_bulk_role_target_next_page'))) {
        
        const parts = interaction.message.content.match(/<@&(\d+)>/);
        const sourceRoleId = parts ? parts[1] : null;
        const type = interaction.message.content.includes('ظواهر') ? 'type_phenomena' : 'type_letter';
        
        const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
        const adminRoles = readJson(adminRolesPath, []);
        const currentSourceRole = interaction.guild.roles.cache.get(sourceRoleId);

        const availableTargetRoles = adminRoles.filter(roleId => {
            if (roleId === sourceRoleId) return false;
            const targetRole = interaction.guild.roles.cache.get(roleId);
            if (!targetRole || !currentSourceRole || targetRole.position <= currentSourceRole.position) return false;
            return type === 'type_phenomena' ? targetRole.name.length >= 3 : targetRole.name.length <= 2;
        }).map(roleId => {
            const role = interaction.guild.roles.cache.get(roleId);
            return role ? {
                name: role.name,
                value: `${sourceRoleId}_${roleId}`,
                description: `ترقية إلى ${role.name}`
            } : {
                name: `رول غير معروف (${roleId})`,
                value: `${sourceRoleId}_${roleId}`,
                description: `رول غير موجود في السيرفر`
            };
        }).filter(Boolean);

        let currentPage = parseInt(interaction.message.components[1].components[1].label.match(/\d+/)[0]) - 1;
        if (interaction.customId.includes('prev')) currentPage--;
        else currentPage++;

        const { components } = createPaginatedResponsibilityArray(
            availableTargetRoles,
            currentPage,
            'promote_bulk_role_target',
            'اختر الرول المستهدف للترقية...'
        );

        await interaction.update({ components });
        return;
    }

    // Handle bulk promotion target role selection
    if (interaction.isStringSelectMenu() && customId === 'promote_bulk_role_target') {
        const [sourceRoleId, targetRoleId] = interaction.values[0].split('_');
        const sourceRole = interaction.guild.roles.cache.get(sourceRoleId);
        const targetRole = interaction.guild.roles.cache.get(targetRoleId);

        if (!sourceRole || !targetRole) {
            await interaction.reply({
                content: '❌ **لم يتم العثور على أحد الرولات!**',
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        const members = sourceRole.members.filter(m => !m.user.bot);
        const memberOptions = members.map(m => ({
            name: m.displayName,
            value: m.id,
            description: `استبعاد ${m.displayName} من الترقية`
        }));

        // Pagination logic for member exclusion
        
        const { components } = createPaginatedResponsibilityArray(
            memberOptions,
            0,
            `promote_bulk_exclude_${sourceRoleId}_${targetRoleId}`,
            'استبعاد أعضاء من الترقية الجماعية...',
            memberOptions.length
        );

        if (memberOptions.length === 0) {
            await showBulkModal(interaction, sourceRoleId, targetRoleId, []);
        } else {
            await interaction.update({
                content: `**الرول المستهدف:** ${targetRole.name}\n**حدد الأعضاء المراد استبعادهم من الترقية الجماعية:**`,
                components: components
            });
        }
        return;
    }

    // Handle navigation and exclusion selection
    if (interaction.isButton() && (customId.startsWith('promote_bulk_exclude_') && (customId.includes('_prev_page') || customId.includes('_next_page')))) {
        
        const parts = customId.split('_');
        const sourceRoleId = parts[3];
        const targetRoleId = parts[4];
        
        const sourceRole = interaction.guild.roles.cache.get(sourceRoleId);
        const members = sourceRole.members.filter(m => !m.user.bot);
        const memberOptions = members.map(m => ({
            name: m.displayName,
            value: m.id,
            description: `استبعاد ${m.displayName} من الترقية`
        }));

        // Get current page from button label or info button
        const pageInfoLabel = interaction.message.components[1].components[1].label;
        let currentPage = parseInt(pageInfoLabel.match(/\d+/)[0]) - 1;
        
        if (customId.includes('prev_page')) currentPage--;
        else if (customId.includes('next_page')) currentPage++;

        const { components } = createPaginatedResponsibilityArray(
            memberOptions,
            currentPage,
            `promote_bulk_exclude_${sourceRoleId}_${targetRoleId}`,
            'استبعاد أعضاء من الترقية الجماعية...',
            memberOptions.length
        );

        await interaction.update({ components });
        return;
    }

    // Handle navigation for individual role selection
    if (interaction.isButton() && (customId.startsWith('promote_role_') && (customId.includes('_prev_page') || customId.includes('_next_page')))) {
        const userId = customId.split('_')[2];
        
        // We need to re-filter roles based on the type (phenomena or letter)
        // Since we don't know the type here, we can try to infer it or just use all admin roles
        // A better way is to check the current message content/embed
        const isPhenomena = interaction.message.content.includes('ظواهر');
        const adminRoles = promoteManager.getAdminRoles();
        const guildRoles = await interaction.guild.roles.fetch();
        const targetMember = await interaction.guild.members.fetch(userId);
        const targetMemberAdminRoles = targetMember.roles.cache.filter(role => adminRoles.includes(role.id));

        let filteredRoles = [];
        if (isPhenomena) {
            const highestPhenomenaRole = targetMemberAdminRoles
                .filter(role => role.name.length >= 3)
                .sort((a, b) => b.position - a.position)
                .first();
            const minPosition = highestPhenomenaRole ? highestPhenomenaRole.position : -1;
            filteredRoles = adminRoles.filter(roleId => {
                const role = guildRoles.get(roleId);
                return role && role.name.length >= 3 && role.position > minPosition;
            });
        } else {
            const highestLetterRole = targetMemberAdminRoles
                .filter(role => role.name.length <= 2)
                .sort((a, b) => b.position - a.position)
                .first();
            const minPosition = highestLetterRole ? highestLetterRole.position : -1;
            filteredRoles = adminRoles.filter(roleId => {
                const role = guildRoles.get(roleId);
                return role && role.name.length <= 2 && role.position > minPosition;
            });
        }

        const roleOptions = filteredRoles.map(roleId => {
            const role = guildRoles.get(roleId);
            return {
                name: role ? role.name : `رول غير معروف (${roleId})`,
                value: roleId,
                description: `ID: ${roleId}`
            };
        });

        const pageInfoLabel = interaction.message.components[1].components[1].label;
        let currentPage = parseInt(pageInfoLabel.match(/\d+/)[0]) - 1;
        
        if (customId.includes('prev_page')) currentPage--;
        else if (customId.includes('next_page')) currentPage++;

        const { components } = createPaginatedResponsibilityArray(
            roleOptions,
            currentPage,
            `promote_role_${userId}`,
            'اختر الرول المطلوب للترقية...'
        );

        await interaction.update({ components: [interaction.message.components[0], ...components] });
        return;
    }

    if (interaction.isButton() && customId.startsWith('promote_bulk_skip_exclude_')) {
        const parts = customId.split('_');
        const sourceRoleId = parts[4];
        const targetRoleId = parts[5];
        await showBulkModal(interaction, sourceRoleId, targetRoleId, []);
        return;
    }

    if (interaction.isStringSelectMenu() && customId.startsWith('promote_bulk_exclude_')) {
        const parts = customId.split('_');
        const sourceRoleId = parts[3];
        const targetRoleId = parts[4];
        const excludedIds = interaction.values;
        await showBulkModal(interaction, sourceRoleId, targetRoleId, excludedIds);
        return;
    }

    async function showBulkModal(interaction, sourceRoleId, targetRoleId, excludedIds = []) {
        // Use a temporary storage for excluded IDs if they are too many
        let excludedKey = excludedIds.join(',');
        if (excludedKey.length > 50) {
            const tempKey = `bulk_${Date.now()}`;
            if (!global.bulkPromoteCache) global.bulkPromoteCache = new Map();
            global.bulkPromoteCache.set(tempKey, excludedIds);
            excludedKey = `cache_${tempKey}`;
        }

        const modal = new ModalBuilder()
            .setCustomId(`promote_bulk_modal_${sourceRoleId}_${targetRoleId}_${excludedKey}`)
            .setTitle('تفاصيل الترقية الجماعية');

        const durationInput = new TextInputBuilder()
            .setCustomId('promote_duration')
            .setLabel('المدة (مثلاً: 7d أو نهائي)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue('نهائي');

        const reasonInput = new TextInputBuilder()
            .setCustomId('promote_reason')
            .setLabel('السبب')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(durationInput),
            new ActionRowBuilder().addComponents(reasonInput)
        );

        await interaction.showModal(modal);
    }

    // Handle user selection for promotion
    if (interaction.isUserSelectMenu() && customId === 'promote_select_user') {
        const targetId = interaction.values[0];
        
        const promoSelect = new StringSelectMenuBuilder()
            .setCustomId('promote_select_type')
            .setPlaceholder('اختر نوع الترقية (ظواهر / حرف)...')
            .addOptions([
                {
                    label: 'ظواهر )',
                    value: 'type_phenomena',
                    description: 'عرض الرولات الإدارية التي تتكون من 3 حروف فأكثر',
                    emoji: '🌟'
                },
                {
                    label: 'حرف أداري',
                    value: 'type_letter',
                    description: 'عرض الرولات الإدارية التي تتكون من حرف أو حرفين فقط',
                    emoji: '🔤'
                }
            ]);

        const row = new ActionRowBuilder().addComponents(promoSelect);

        // جمع إحصائيات المستخدم
        const member = await interaction.guild.members.fetch(targetId);
        const userStats = await collectUserStats(member);

        // حساب الوقت في الفويس بالأيام والساعات
        const voiceTimeInMs = userStats.realVoiceTime || 0;
        const days = Math.floor(voiceTimeInMs / (1000 * 60 * 60 * 24));
        const hours = Math.floor((voiceTimeInMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((voiceTimeInMs % (1000 * 60 * 60)) / (1000 * 60));
        const voiceTimeFormatted = days > 0 ? `${days} يوم، ${hours} ساعة` : hours > 0 ? `${hours} ساعة، ${minutes} دقيقة` : `${minutes} دقيقة`;

        const statsEmbed = colorManager.createEmbed()
            .setTitle('📊 إحصائيات العضو المختار')
            .setDescription(`**العضو:** <@${targetId}>\n\n` +
                          `🎤 **الوقت في الفويس:** ${voiceTimeFormatted}\n` +
                          `💬 **الرسائل:** ${userStats.realMessages || 0}\n` +
                          `⭐ **التفاعلات:** ${userStats.reactionsGiven || 0}\n` +
                          `🔊 **الانضمام للفويس:** ${userStats.joinedChannels || 0} مرة`)
            .setThumbnail(member.user.displayAvatarURL({ dynamic: true }));

        await interaction.update({
            content: `**العضو المحدد:** <@${targetId}>\nيرجى اختيار نوع الترقية لعرض الرولات المناسبة:`,
            components: [row],
            embeds: [statsEmbed]
        });
        return;
    }

    if (interaction.customId === 'promote_select_type') {
        const type = interaction.values[0];
        
        // Find targetId from message content or embed description
        const contentMatch = interaction.message.content.match(/<@!?(\d+)>/);
        const embedMatch = interaction.message.embeds[0]?.description?.match(/<@!?(\d+)>/);
        const targetId = (contentMatch ? contentMatch[1] : null) || (embedMatch ? embedMatch[1] : null);
        
        if (!targetId) {
            console.error('❌ Promote Error: targetId not found in message content or embed');
            console.log('Message Content:', interaction.message.content);
            if (interaction.message.embeds[0]) console.log('Embed Description:', interaction.message.embeds[0].description);
            
            return interaction.reply({
                content: '❌ **حدث خطأ: لم يتم العثور على العضو المستهدف.**',
                flags: MessageFlags.Ephemeral
            });
        }
        
        // Update selection in current message components to keep it visual
        const currentSelect = interaction.message.components[0].components[0];
        const updatedOptions = currentSelect.options.map(opt => {
            const optData = opt.toJSON ? opt.toJSON() : opt;
            return {
                ...optData,
                default: false
            };
        });
        
        const updatedSelect = new StringSelectMenuBuilder()
            .setCustomId(currentSelect.customId)
            .setPlaceholder(currentSelect.placeholder)
            .addOptions(updatedOptions);
        
        const updatedRow = new ActionRowBuilder().addComponents(updatedSelect);
        
        const guild = interaction.guild;
        const targetMember = await guild.members.fetch(targetId);
        const adminRoles = promoteManager.getAdminRoles();
        
        let filteredRoles = [];
        const guildRoles = await guild.roles.fetch();
        
        if (type === 'type_phenomena') {
            // ظواهر: 3 حروف أو أكثر وأعلى من أعلى رول ظواهر مع الشخص (بغض النظر عن الهرمية العامة)
            const targetMemberAdminRoles = targetMember.roles.cache.filter(role => adminRoles.includes(role.id));
            const highestPhenomenaRole = targetMemberAdminRoles
                .filter(role => role.name.length >= 3)
                .sort((a, b) => b.position - a.position)
                .first();

            // الفلترة بناءً على أعلى رول ظواهر فقط
            const minPosition = highestPhenomenaRole ? highestPhenomenaRole.position : -1;

            filteredRoles = adminRoles.filter(roleId => {
                const role = guildRoles.get(roleId);
                return role && role.name.length >= 3 && role.position > minPosition;
            });
        } else {
            // حرف: أعلى من أعلى رول "حرف" مع الشخص (بغض النظر عن الهرمية العامة)
            const targetMemberAdminRoles = targetMember.roles.cache.filter(role => adminRoles.includes(role.id));
            const highestLetterRole = targetMemberAdminRoles
                .filter(role => role.name.length <= 2)
                .sort((a, b) => b.position - a.position)
                .first();

            // الفلترة بناءً على أعلى رول حرف فقط
            const minPosition = highestLetterRole ? highestLetterRole.position : -1;

            filteredRoles = adminRoles.filter(roleId => {
                const role = guildRoles.get(roleId);
                // رولات الحرف هي 1 أو 2 حرف
                return role && role.name.length <= 2 && role.position > minPosition;
            });
        }

        if (filteredRoles.length === 0) {
            return interaction.update({
                content: '⚠️ لم يتم العثور على رولات إدارية مناسبة لهذا العضو بناءً على الاختيار.',
                components: [updatedRow],
                flags: MessageFlags.Ephemeral
            });
        }

        const roleOptions = await Promise.all(filteredRoles.map(async roleId => {
            try {
                const role = await guild.roles.fetch(roleId);
                return {
                    name: role ? role.name : `رول غير معروف (${roleId})`,
                    value: roleId,
                    description: `ID: ${roleId}`
                };
            } catch (error) {
                return {
                    name: `رول غير موجود (${roleId})`,
                    value: roleId,
                    description: `ID: ${roleId}`
                };
            }
        }));

        // Use pagination for individual role selection
        
        const { components } = createPaginatedResponsibilityArray(
            roleOptions,
            0,
            `promote_role_${targetId}`,
            'اختر الرول المطلوب للترقية...'
        );

        await interaction.update({
            content: `**العضو المحدد:** <@${targetId}>\nتمت تصفية الرولات بناءً على اختيارك (${type === 'type_phenomena' ? 'ظواهر' : 'حرف'}):`,
            components: [updatedRow, ...components]
        });
        return;
    }

    // Handle role selection for promotion - محسن لدعم الاختيار المتعدد
    if (interaction.isStringSelectMenu() && customId.startsWith('promote_role_')) {
        const userId = customId.split('_')[2];
        const selectedRoleIds = interaction.values; // دعم الاختيار المتعدد
        const isMultipleRoles = selectedRoleIds.length > 1;

        // إنشاء embed لعرض المختارات قبل إظهار المودال
        const selectedRoles = selectedRoleIds.map(roleId => {
            const role = interaction.guild.roles.cache.get(roleId);
            return role ? role.name : 'رول غير معروف';
        });

        const confirmationEmbed = colorManager.createEmbed()
            .setTitle(isMultipleRoles ? '🎯 ترقية متعددة مختارة' : '🎯 ترقية فردية مختارة')
            .setDescription(`**العضو:** <@${userId}>\n**عدد الرولات المختارة:** ${selectedRoleIds.length}`)
            .addFields([
                {
                    name: isMultipleRoles ? '🏷️ **الرولات المختارة**' : '🏷️ **الرول المختار**',
                    value: selectedRoles.map((roleName, index) => `${index + 1}. **${roleName}**`).join('\n'),
                    inline: false
                },
                {
                    name: '⏭️ **الخطوة التالية**',
                    value: 'سيتم فتح نافذة لإدخال المدة والسبب',
                    inline: false
                }
            ])
            .setTimestamp();

        // Join roleIds with comma for modal customId
        let roleIdsString = selectedRoleIds.join(',');
        if (roleIdsString.length > 60) {
            const tempKey = `roles_${Date.now()}`;
            if (!global.promoteRolesCache) global.promoteRolesCache = new Map();
            global.promoteRolesCache.set(tempKey, selectedRoleIds);
            roleIdsString = `cache_${tempKey}`;
        }

        // Create modal for duration and reason
        const modal = new ModalBuilder()
            .setCustomId(`promote_modal_${userId}_${roleIdsString}`)
            .setTitle(isMultipleRoles ? 'تفاصيل الترقية المتعددة' : 'تفاصيل الترقية');

        const durationInput = new TextInputBuilder()
            .setCustomId('promote_duration')
            .setLabel('المدة (مثل: 7d أو 12h أو نهائي)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('7d, 12h, 30m, نهائي')
            .setValue('نهائي'); // قيمة افتراضية

        const reasonInput = new TextInputBuilder()
            .setCustomId('promote_reason')
            .setLabel('السبب')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder(isMultipleRoles ? 
                'اذكر سبب الترقية المتعددة...' : 
                'اذكر سبب الترقية...');

        modal.addComponents(
            new ActionRowBuilder().addComponents(durationInput),
            new ActionRowBuilder().addComponents(reasonInput)
        );

        // إظهار المودال مباشرة مع معلومات توضيحية في العنوان
        await interaction.showModal(modal);

        // إرسال رسالة توضيحية منفصلة
        setTimeout(async () => {
            try {
                await interaction.followUp({
                    embeds: [confirmationEmbed],
                    flags: MessageFlags.Ephemeral
                });
            } catch (error) {
                console.log('تم إغلاق التفاعل أو انتهت صلاحيته');
            }
        }, 2000);

        return;
    }

    // Handle promotion records option selection
    if (interaction.isStringSelectMenu() && customId === 'promote_records_option') {
        const selectedOption = interaction.values[0];

        // Update selection in current message components to keep it visual
        const currentSelect = interaction.message.components[0].components[0];
        const updatedOptions = currentSelect.options.map(opt => {
            const optData = opt.toJSON ? opt.toJSON() : opt;
            return {
                ...optData,
                default: false
            };
        });
        
        const updatedSelect = new StringSelectMenuBuilder()
            .setCustomId(currentSelect.customId)
            .setPlaceholder(currentSelect.placeholder)
            .addOptions(updatedOptions);
        
        const updatedRow = new ActionRowBuilder().addComponents(updatedSelect);

        if (selectedOption === 'records_specific_user') {
            const userSelect = new UserSelectMenuBuilder()
                .setCustomId('promote_records_select_user')
                .setPlaceholder(' اختر العضو لعرض سجلات ترقياته...')
                .setMaxValues(1);

            const userRow = new ActionRowBuilder().addComponents(userSelect);

            await interaction.update({
                content: ' **اختر العضو لعرض سجلات ترقياته:**',
                components: [updatedRow, userRow]
            });
        } else if (selectedOption === 'records_specific_role') {
            const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
            const adminRoles = readJson(adminRolesPath, []);

            if (adminRoles.length === 0) {
                await interaction.update({
                    content: '⚠️ **لا توجد رولات إدارية محددة! يرجى إضافة رولات إدارية أولاً.**',
                    components: [updatedRow]
                });
                return;
            }

        const availableRoles = adminRoles.map(roleId => {
            const role = interaction.guild.roles.cache.get(roleId);
            return role ? {
                name: role.name,
                value: roleId,
                description: `عرض سجلات ترقيات ${role.name}`
            } : {
                name: `رول غير معروف (${roleId})`,
                value: roleId,
                description: `رول غير موجود في السيرفر`
            };
        });

            const { components } = createPaginatedResponsibilityArray(
                availableRoles,
                0,
                'promote_records_select_role',
                'اختر الرول لعرض سجلات ترقياته...'
            );

            await interaction.update({
                content: ' **اختر الرول لعرض سجلات ترقياته:**',
                components: [updatedRow, ...components]
            });
        }
        return;
    }

    // Handle pagination for promote_records_select_role
    if (interaction.isButton() && (customId.startsWith('promote_records_select_role_prev_page') || customId.startsWith('promote_records_select_role_next_page'))) {
        const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
        const adminRoles = readJson(adminRolesPath, []);
        
        const availableRoles = adminRoles.map(roleId => {
            const role = interaction.guild.roles.cache.get(roleId);
            return role ? {
                name: role.name,
                value: roleId,
                description: `عرض سجلات ترقيات ${role.name}`
            } : {
                name: `رول غير معروف (${roleId})`,
                value: roleId,
                description: `رول غير موجود في السيرفر`
            };
        });

        let currentPage = parseInt(interaction.message.components[1].components[1].label.match(/\d+/)[0]) - 1;
        if (customId.includes('prev')) currentPage--;
        else currentPage++;

        const { components } = createPaginatedResponsibilityArray(
            availableRoles,
            currentPage,
            'promote_records_select_role',
            'اختر الرول لعرض سجلات ترقياته...'
        );

        await interaction.update({ components: [interaction.message.components[0], ...components] });
        return;
    }

    // Handle role selection for records
    if (interaction.isStringSelectMenu() && customId === 'promote_records_select_role') {
        const selectedRoleId = interaction.values[0];
        const role = interaction.guild.roles.cache.get(selectedRoleId);

        if (!role) {
            await interaction.update({
                content: ' **لم يتم العثور على الرول!**',
                components: []
            });
            return;
        }

        // Get promotion records from promoteLogs.json with improved filtering
        const promoteLogsPath = path.join(__dirname, '..', 'data', 'promoteLogs.json');
        const promoteLogs = readJson(promoteLogsPath, []);

        // تحسين فلترة السجلات لتشمل جميع أنواع الترقيات المتعلقة بالرول
        let roleRecords = promoteLogs.filter(log => {
            if (!log.data) return false;

            // فلترة بناءً على أنواع مختلفة من الترقيات
            if (log.type === 'BULK_PROMOTION') {
                // للترقية الجماعية، تحقق من الرول المصدر أو المستهدف
                return log.data.targetRoleId === selectedRoleId || log.data.sourceRoleId === selectedRoleId;
            } else if (log.type === 'PROMOTION_APPLIED' || log.type === 'PROMOTION_ENDED') {
                // للترقية الفردية، تحقق من الرول المستهدف
                return log.data.roleId === selectedRoleId || log.data.role?.id === selectedRoleId;
            } else if (log.type === 'MULTI_PROMOTION_APPLIED') {
                // للترقية المتعددة، تحقق من قائمة الرولات
                return log.data.roleIds && log.data.roleIds.includes(selectedRoleId);
            }

            // فلترة إضافية بناءً على معرف الرول
            return log.data.roleId === selectedRoleId;
        });

        // تجميع السجلات المتعددة بـ Transaction ID
        const groupedRecords = {};
        const standaloneRecords = [];

        roleRecords.forEach(record => {
            if (record.data && record.data.transactionId && record.type === 'PROMOTION_APPLIED') {
                const txId = record.data.transactionId;
                if (!groupedRecords[txId]) {
                    groupedRecords[txId] = {
                        transactionId: txId,
                        type: 'MULTI_PROMOTION_GROUP',
                        timestamp: record.timestamp,
                        records: [],
                        targetUserId: record.data.targetUserId,
                        reason: record.data.reason,
                        duration: record.data.duration,
                        byUserId: record.data.byUserId
                    };
                }
                groupedRecords[txId].records.push(record);
            } else {
                standaloneRecords.push(record);
            }
        });

        // دمج السجلات المجمّعة مع المفردة
        roleRecords = [
            ...Object.values(groupedRecords),
            ...standaloneRecords
        ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        if (roleRecords.length === 0) {
            // تحسين رسالة عدم وجود سجلات
            const backButton = new ButtonBuilder()
                .setCustomId('promote_records_back')
                .setLabel('العودة لقائمة الرولات')
                .setStyle(ButtonStyle.Secondary);

            const backRow = new ActionRowBuilder().addComponents(backButton);

            await interaction.update({
                content: `📋 **الرول** <@&${selectedRoleId}> **ليس لديه أي سجلات ترقيات مسجلة.**\n\n` +
                        `هذا يعني أنه لم يتم تسجيل أي عمليات ترقية من/إلى هذا الرول منذ تفعيل نظام التسجيل.`,
                components: [backRow]
            });
            return;
        }

        // نظام pagination محسّن: كل سجل في صفحة منفصلة
        let currentPage = 0;
        const totalRecords = roleRecords.length;

        function createSingleRecordEmbed(recordIndex) {
            const record = roleRecords[recordIndex];
            const recordDate = new Date(record.timestamp || Date.now());
            const timestamp = Math.floor(recordDate.getTime() / 1000);

            // البيانات الأساسية
            const moderatorId = record.data?.byUserId || record.data?.moderatorId || 'غير معروف';
            const targetUserId = record.data?.targetUserId || record.data?.userId;
            const duration = record.data?.duration || 'نهائي';
            const reason = record.data?.reason || 'لم يتم تحديد سبب';

            // معالجة خاصة للترقيات المجمّعة
            if (record.type === 'MULTI_PROMOTION_GROUP') {
                const rolesCount = record.records.length;
                const roleNames = record.records.map(r => {
                    const roleObj = interaction.guild.roles.cache.get(r.data.roleId);
                    return roleObj ? roleObj.name : 'رول محذوف';
                });

                const isTemporary = duration !== 'نهائي';

                const embed = colorManager.createEmbed()
                    .setTitle(`📋 سجل ترقية - الرول ${role.name}`)
                    .setDescription(
                        `**رقم السجل:** ${recordIndex + 1} من ${totalRecords}\n\n` +
                        `✅ **تم ترقية العضو** <@${targetUserId}> **لعدة رولات**\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `👥 **الإدارة الذين تأثروا:**\n<@${targetUserId}>\n\n` +
                        `🎖️ **الرولات المطبقة:**\n${roleNames.map((name, i) => `${i + 1}. **${name}**`).join('\n')}\n\n` +
                        `📝 **السبب:**\n${reason}\n\n` +
                        `📅 **الوقت:**\n<t:${timestamp}:F>\n\n` +
                        `⏰ **منذ:**\n<t:${timestamp}:R>\n\n` +
                        `👤 **بواسطة:**\n<@${moderatorId}>\n\n` +
                        (isTemporary ? `⏱️ **ترقية مؤقتة** - المدة: ${duration}` : '')
                    )
                    .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
                    .setFooter({ text: `معرف السجل: ${record.transactionId || record.timestamp}` })
                    .setTimestamp();

                return embed;
            }

            // تحديد نوع السجل ومعالجته
            let descriptionText = '';
            let affectedMembers = '';

            if (record.type === 'BULK_PROMOTION') {
                // ترقية جماعية
                const sourceRoleId = record.data?.sourceRoleId;
                const targetRoleId = record.data?.targetRoleId;
                const sourceRoleObj = sourceRoleId ? interaction.guild.roles.cache.get(sourceRoleId) : null;
                const targetRoleObj = targetRoleId ? interaction.guild.roles.cache.get(targetRoleId) : null;

                const sourceRoleName = sourceRoleObj ? sourceRoleObj.name : (record.data?.sourceRoleName || 'رول محذوف');
                const targetRoleName = targetRoleObj ? targetRoleObj.name : (record.data?.targetRoleName || 'رول محذوف');

                // تحديد إذا كان الرول المحدد هو المصدر أو الهدف
                if (sourceRoleId === selectedRoleId) {
                    descriptionText = `✅ **من هذا الرول:** ${sourceRoleName} **إلى الرول:** ${targetRoleName}`;
                } else {
                    descriptionText = `✅ **من الرول:** ${sourceRoleName} **إلى هذا الرول:** ${targetRoleName}`;
                }

                // قائمة الأعضاء المتأثرين
                if (record.data?.successfulMembers && record.data.successfulMembers.length > 0) {
                    const memberMentions = record.data.successfulMembers.map(m => {
                        // التحقق من البنية المختلفة للبيانات
                        if (typeof m === 'object' && m.id) {
                            return `<@${m.id}>`;
                        } else if (typeof m === 'string') {
                            return `<@${m}>`;
                        } else if (m.user && m.user.id) {
                            return `<@${m.user.id}>`;
                        } else if (m.member && m.member.id) {
                            return `<@${m.member.id}>`;
                        }
                        return null;
                    }).filter(Boolean);

                    if (memberMentions.length > 0) {
                        if (memberMentions.length <= 10) {
                            affectedMembers = memberMentions.join(' ');
                        } else {
                            affectedMembers = memberMentions.slice(0, 10).join(' ') + `\n**و ${memberMentions.length - 10} عضو آخر**`;
                        }
                    } else {
                        affectedMembers = 'خطأ في تحليل بيانات الأعضاء';
                    }
                } else if (record.data?.successCount && record.data.successCount > 0) {
                    affectedMembers = `تم ترقية ${record.data.successCount} عضو بنجاح`;
                } else {
                    affectedMembers = 'لا توجد معلومات';
                }

            } else if (record.type === 'PROMOTION_APPLIED') {
                // ترقية فردية فقط (الترقيات الجماعية لا تظهر كسجلات فردية)
                const previousRoleName = record.data?.previousRole?.name || 'بدون رول سابق';
                const currentRoleId = record.data?.roleId;
                const currentRoleObj = currentRoleId ? interaction.guild.roles.cache.get(currentRoleId) : null;
                const currentRoleName = currentRoleObj ? currentRoleObj.name : 'رول محذوف';

                descriptionText = `✅ **من الرول:** ${previousRoleName} **إلى الرول:** ${currentRoleName}`;
                affectedMembers = `<@${targetUserId}>`;

            } else if (record.type === 'BULK_PROMOTION') {
                // ترقية جماعية - عرضها بشكل خاص
                const sourceRoleId = record.data?.sourceRoleId;
                const targetRoleId = record.data?.targetRoleId;
                const sourceRoleObj = sourceRoleId ? interaction.guild.roles.cache.get(sourceRoleId) : null;
                const targetRoleObj = targetRoleId ? interaction.guild.roles.cache.get(targetRoleId) : null;

                const sourceRoleName = sourceRoleObj ? sourceRoleObj.name : (record.data?.sourceRoleName || 'رول محذوف');
                const targetRoleName = targetRoleObj ? targetRoleObj.name : (record.data?.targetRoleName || 'رول محذوف');

                descriptionText = `✅ **ترقية جماعية - من الرول:** ${sourceRoleName} **إلى الرول:** ${targetRoleName}`;
                affectedMembers = `<@${targetUserId}> (ضمن ${record.data?.successCount || 0} عضو)`;

            } else if (record.type === 'PROMOTION_ENDED') {
                // انتهاء ترقية
                const roleIdRecord = record.data?.roleId;
                const roleObj = roleIdRecord ? interaction.guild.roles.cache.get(roleIdRecord) : null;
                const roleName = roleObj ? roleObj.name : 'رول محذوف';

                descriptionText = `⏱️ **انتهت مدة الترقية للرول:** ${roleName}`;
                affectedMembers = `<@${targetUserId}>`;
            } else {
                descriptionText = `ℹ️ **سجل غير معروف**`;
                affectedMembers = targetUserId ? `<@${targetUserId}>` : 'غير محدد';
            }

            const isTemporary = duration !== 'نهائي';

            const embed = colorManager.createEmbed()
                .setTitle(`📋 سجل ترقية - الرول ${role.name}`)
                .setDescription(
                    `**رقم السجل:** ${recordIndex + 1} من ${totalRecords}\n\n` +
                    `${descriptionText}\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `👥 **الإدارة الذين تأثروا:**\n${affectedMembers}\n\n` +
                    `📝 **السبب:**\n${reason}\n\n` +
                    `📅 **الوقت:**\n<t:${timestamp}:F>\n\n` +
                    `⏰ **منذ:**\n<t:${timestamp}:R>\n\n` +
                    `👤 **بواسطة:**\n<@${moderatorId}>\n\n` +
                    (isTemporary ? `⏱️ **ترقية مؤقتة** - المدة: ${duration}` : '')
                )
                .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
                .setFooter({ text: `معرف السجل: ${record.timestamp || 'غير محدد'}` })
                .setTimestamp();

            return embed;
        }

        const embed = createSingleRecordEmbed(currentPage);

        // أزرار التنقل والإدارة
        const components = [];

        // صف التنقل
        const navigationRow = new ActionRowBuilder();

        const prevButton = new ButtonBuilder()
            .setCustomId(`role_record_prev_${selectedRoleId}_${currentPage}`)
            .setLabel('السابق')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage === 0);

        const pageButton = new ButtonBuilder()
            .setCustomId(`role_record_page`)
            .setLabel(`${currentPage + 1} / ${totalRecords}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true);

        const nextButton = new ButtonBuilder()
            .setCustomId(`role_record_next_${selectedRoleId}_${currentPage}`)
            .setLabel('التالي')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage === totalRecords - 1);

        navigationRow.addComponents(prevButton, pageButton, nextButton);
        components.push(navigationRow);

        // صف إدارة السجلات
        const manageRow = new ActionRowBuilder();

        const deleteRecordButton = new ButtonBuilder()
            .setCustomId(`delete_record_${selectedRoleId}_${currentPage}`)
            .setLabel('حذف هذا السجل')
            .setStyle(ButtonStyle.Danger);

        const deleteAllButton = new ButtonBuilder()
            .setCustomId(`delete_all_records_${selectedRoleId}`)
            .setLabel('حذف جميع السجلات')
            .setStyle(ButtonStyle.Danger);

        const backButton = new ButtonBuilder()
            .setCustomId('promote_records_back')
            .setLabel('العودة')
            .setStyle(ButtonStyle.Primary);

        manageRow.addComponents(deleteRecordButton, deleteAllButton, backButton);
        components.push(manageRow);

        await interaction.update({
            embeds: [embed],
            content: '',
            components: components
        });
        return;
    }

    // Handle user selection for records
    if (interaction.isUserSelectMenu() && customId === 'promote_records_select_user') {
        const selectedUserId = interaction.values[0];
        const records = await promoteManager.getUserPromotionRecords(selectedUserId, interaction.guild.id);

        if (records.length === 0) {
            await interaction.update({
                content: ` **العضو** <@${selectedUserId}> **ليس لديه أي سجلات ترقيات.**`,
                embeds: [],
                components: []
            });
            return;
        }

        await displayUserRecord(interaction, selectedUserId, 0, records);
        return;
    }

    // معالجات حذف السجلات
    if (interaction.isButton() && customId.startsWith('delete_record_')) {
        const parts = customId.split('_');
        const roleId = parts[2];
        const recordIndex = parseInt(parts[3]);

        try {
            await handleDeleteSingleRecord(interaction, roleId, recordIndex);
        } catch (error) {
            console.error('خطأ في حذف السجل:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ حدث خطأ أثناء حذف السجل.',
                    flags: MessageFlags.Ephemeral
                });
            }
        }
        return;
    }

    if (interaction.isButton() && customId.startsWith('delete_all_records_')) {
        const roleId = customId.split('_')[3];

        // طلب تأكيد قبل الحذف
        const confirmEmbed = colorManager.createEmbed()
            .setTitle('تأكيد حذف جميع السجلات')
            .setDescription(
                `هل أنت متأكد من حذف جميع سجلات الرول <@&${roleId}>؟\n\n` +
                `**تحذير:** هذا الإجراء لا يمكن التراجع عنه!`
            )
            .setTimestamp();

        const confirmButton = new ButtonBuilder()
            .setCustomId(`confirm_delete_all_${roleId}`)
            .setLabel('تأكيد الحذف')
            .setStyle(ButtonStyle.Danger);

        const cancelButton = new ButtonBuilder()
            .setCustomId(`cancel_delete_all`)
            .setLabel('إلغاء')
            .setStyle(ButtonStyle.Secondary);

        const buttonRow = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

        await interaction.update({
            embeds: [confirmEmbed],
            components: [buttonRow]
        });
        return;
    }

    if (interaction.isButton() && customId.startsWith('confirm_delete_all_')) {
        const roleId = customId.split('_')[3];
        await handleDeleteAllRecords(interaction, roleId);
        return;
    }

    if (interaction.isButton() && customId === 'cancel_delete_all') {
        await interaction.update({
            content: 'تم إلغاء عملية الحذف',
            embeds: [],
            components: []
        });
        return;
    }

    // Handle user selection for banning
    if (interaction.isUserSelectMenu() && customId === 'promote_ban_select_user') {
        const selectedUserId = interaction.values[0];

        try {
            // التحقق من أن المستخدم ليس محظوراً بالفعل
            const promoteBansPath = path.join(__dirname, '..', 'data', 'promoteBans.json');
            const promoteBans = readJson(promoteBansPath, {});
            const banKey = `${selectedUserId}_${interaction.guild.id}`;

            if (promoteBans[banKey]) {
                const banData = promoteBans[banKey];
                const banEndTime = banData.endTime;
                const banEndText = banEndTime ? 
                    `<t:${Math.floor(banEndTime / 1000)}:R>` : 
                    'نهائي';

                await interaction.reply({
                    content: ` **العضو** <@${selectedUserId}> **محظور بالفعل من الترقيات.**\n**ينتهي الحظر:** ${banEndText}`,
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            const modal = new ModalBuilder()
                .setCustomId(`promote_ban_modal_${selectedUserId}`)
                .setTitle('حظر من الترقيات');

            const durationInput = new TextInputBuilder()
                .setCustomId('ban_duration')
                .setLabel('مدة الحظر (مثل: 30d أو نهائي)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('30d, 7d, نهائي');

            const reasonInput = new TextInputBuilder()
                .setCustomId('ban_reason')
                .setLabel('سبب الحظر')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setPlaceholder('اذكر سبب منع الترقية...');

            modal.addComponents(
                new ActionRowBuilder().addComponents(durationInput),
                new ActionRowBuilder().addComponents(reasonInput)
            );

            await interaction.showModal(modal);
        } catch (error) {
            console.error('خطأ في معالجة اختيار المستخدم للحظر:', error);
            await interaction.reply({
                content: '❌ **حدث خطأ أثناء معالجة الطلب.**',
                flags: MessageFlags.Ephemeral
            });
        }
        return;
    }

    // Handle eligible user selection for unbanning
    if (interaction.isStringSelectMenu() && customId === 'promote_unban_select_user_eligible') {
        const selectedUserId = interaction.values[0];

        const result = await promoteManager.unbanFromPromotions(selectedUserId, interaction.guild.id, interaction.user);

        if (result.success) {
            const successEmbed = colorManager.createEmbed()
                .setTitle('User Unbanned from Promotions')
                .setDescription(`**تم فك حظر الترقية بنجاح عن العضو** <@${selectedUserId}>`)
                .addFields([
                    { name: ' العضو', value: `<@${selectedUserId}>`, inline: true },
                    { name: ' تم فك الحظر بواسطة', value: `<@${interaction.user.id}>`, inline: true },
                    { name: ' التاريخ', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
                ])
                .setTimestamp();

            await interaction.update({
                embeds: [successEmbed],
                components: []
            });

            // Send DM notification to unbanned user
            try {
                const member = await interaction.guild.members.fetch(selectedUserId);
                const dmEmbed = colorManager.createEmbed()
                    .setTitle('Promotion Ban Lifted')
                    .setDescription(`**تم فك حظر الترقية عنك من قبل الإدارة.**`)
                    .addFields([
                        { name: ' تم فك الحظر بواسطة', value: `${interaction.user.username}`, inline: true },
                        { name: ' التاريخ', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ])
                    .setTimestamp();

                await member.send({ embeds: [dmEmbed] });
            } catch (dmError) {
                console.log(`لا يمكن إرسال رسالة خاصة إلى ${selectedUserId} - قد تكون الرسائل الخاصة مغلقة`);
            }
        } else {
            await interaction.update({
                content: ` **فشل في فك الحظر:** ${result.error}`,
                components: []
            });
        }
        return;
    }

    // Handle role selection for check admin stats
    if (interaction.isStringSelectMenu() && customId === 'promote_check_select_role') {
        const roleId = interaction.values[0];
        const role = interaction.guild.roles.cache.get(roleId);

        if (!role) {
            return interaction.update({
                content: '⚠️ **لم يتم العثور على الرول!**',
                components: []
            });
        }

        await interaction.deferUpdate();

        const membersArray = Array.from(role.members.values());

        if (membersArray.length === 0) {
            const noMembersEmbed = colorManager.createEmbed()
                .setTitle(`📊 إحصائيات: ${role.name}`)
                .setDescription('**لا يوجد أعضاء في هذا الرول**');

            const backButton = new ButtonBuilder()
                .setCustomId('promote_check_back_to_roles')
                .setLabel('🔙 العودة لقائمة الرولات')
                .setStyle(ButtonStyle.Secondary);

            const backRow = new ActionRowBuilder().addComponents(backButton);

            return await interaction.editReply({
                embeds: [noMembersEmbed],
                components: [backRow]
            });
        }

        const weeklyButton = new ButtonBuilder()
            .setCustomId(`promote_check_weekly_${roleId}`)
            .setLabel('الأسبوع')
            .setStyle(ButtonStyle.Success)
            .setEmoji('📅');

        const totalButton = new ButtonBuilder()
            .setCustomId(`promote_check_total_${roleId}`)
            .setLabel('الإجمالي')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📊');

        const membersButton = new ButtonBuilder()
            .setCustomId(`promote_check_members_${roleId}`)
            .setLabel('بحث عن عضو')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🔍');

        const periodRow = new ActionRowBuilder().addComponents(weeklyButton, totalButton, membersButton);

        const backButton = new ButtonBuilder()
            .setCustomId('promote_check_back_to_roles')
            .setLabel('🔙 العودة')
            .setStyle(ButtonStyle.Secondary);

        const backRow = new ActionRowBuilder().addComponents(backButton);

        const statsEmbed = await createRoleStatsEmbed(role, membersArray, 'weekly');

        await interaction.editReply({
            embeds: [statsEmbed],
            components: [periodRow, backRow]
        });
        return;
    }

    // Handle period change for check admin
    if (interaction.isButton() && (customId.startsWith('promote_check_weekly_') || customId.startsWith('promote_check_total_'))) {
        const roleId = customId.split('_')[3];
        const period = customId.startsWith('promote_check_weekly_') ? 'weekly' : 'total';
        const role = interaction.guild.roles.cache.get(roleId);

        if (!role) {
            return interaction.update({
                content: '⚠️ **لم يتم العثور على الرول!**',
                components: []
            });
        }

        await interaction.deferUpdate();

        const membersArray = Array.from(role.members.values());
        const statsEmbed = await createRoleStatsEmbed(role, membersArray, period);

        const weeklyButton = new ButtonBuilder()
            .setCustomId(`promote_check_weekly_${roleId}`)
            .setLabel('الأسبوع')
            .setStyle(period === 'weekly' ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setEmoji('📅');

        const totalButton = new ButtonBuilder()
            .setCustomId(`promote_check_total_${roleId}`)
            .setLabel('الإجمالي')
            .setStyle(period === 'total' ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setEmoji('📊');

        const membersButton = new ButtonBuilder()
            .setCustomId(`promote_check_members_${roleId}`)
            .setLabel('بحث عن عضو')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🔍');

        const periodRow = new ActionRowBuilder().addComponents(weeklyButton, totalButton, membersButton);

        const backButton = new ButtonBuilder()
            .setCustomId('promote_check_back_to_roles')
            .setLabel('🔙 العودة')
            .setStyle(ButtonStyle.Secondary);

        const backRow = new ActionRowBuilder().addComponents(backButton);

        await interaction.editReply({
            embeds: [statsEmbed],
            components: [periodRow, backRow]
        });
        return;
    }

    // Handle member search for check admin
    if (interaction.isButton() && customId.startsWith('promote_check_members_')) {
        const roleId = customId.split('_')[3];
        const role = interaction.guild.roles.cache.get(roleId);

        if (!role) {
            return interaction.reply({
                content: '⚠️ **لم يتم العثور على الرول!**',
                flags: MessageFlags.Ephemeral
            });
        }

        const membersArray = Array.from(role.members.values()).filter(m => !m.user.bot);

        if (membersArray.length === 0) {
            return interaction.reply({
                content: '**لا يوجد أعضاء في هذا الرول**',
                flags: MessageFlags.Ephemeral
            });
        }

        const membersPerPage = 25;
        const currentPage = 0;
        const start = currentPage * membersPerPage;
        const end = Math.min(start + membersPerPage, membersArray.length);
        const pageMembers = membersArray.slice(start, end);

        const memberOptions = pageMembers.map((member, index) => ({
            label: `${start + index + 1}. ${member.displayName}`,
            value: member.id,
            description: `@${member.user.username}`
        }));

        const memberSelectMenu = new StringSelectMenuBuilder()
            .setCustomId(`promote_check_select_member_${roleId}`)
            .setPlaceholder('اختر عضو لعرض إحصائياته...')
            .setMinValues(1)
            .setMaxValues(Math.min(5, memberOptions.length))
            .addOptions(memberOptions);

        const selectRow = new ActionRowBuilder().addComponents(memberSelectMenu);

        const memberEmbed = colorManager.createEmbed()
            .setTitle(`🔍 بحث الأعضاء: ${role.name}`)
            .setDescription(`**اختر عضو أو أكثر (حتى 5) لعرض إحصائياتهم**\n\n**إجمالي الأعضاء:** ${membersArray.length}`)
            .setThumbnail(role.iconURL() || 'https://cdn.discordapp.com/emojis/1365249109149089813.png?v=1');

        const backButton = new ButtonBuilder()
            .setCustomId(`promote_check_members_back_${roleId}`)
            .setLabel('🔙 العودة لإحصائيات الرول')
            .setStyle(ButtonStyle.Secondary);

        const backRow = new ActionRowBuilder().addComponents(backButton);

        await interaction.reply({
            embeds: [memberEmbed],
            components: [selectRow, backRow],
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Handle back button to menu from check admin
    if (interaction.isButton() && customId === 'promote_check_back_to_menu') {
        return interaction.update({
            content: '**تم العودة. يمكنك استخدام المنيو من القناة الرئيسية.**',
            embeds: [],
            components: []
        });
    }

    // Handle back button to roles list from check admin
    if (interaction.isButton() && customId === 'promote_check_back_to_roles') {
        const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
        const adminRoles = readJson(adminRolesPath, []);

        if (adminRoles.length === 0) {
            return interaction.update({
                content: '⚠️ **لا توجد رولات إدارية محددة! يرجى إضافة رولات إدارية أولاً.**',
                embeds: [],
                components: []
            });
        }

        const roleOptions = adminRoles.map(roleId => {
            const role = interaction.guild.roles.cache.get(roleId);
            return role ? {
                label: role.name,
                value: roleId,
                description: `أعضاء: ${role.members.size}`
            } : null;
        }).filter(Boolean);

        if (roleOptions.length === 0) {
            return interaction.update({
                content: '⚠️ **لا توجد رولات صالحة!**',
                embeds: [],
                components: []
            });
        }

        
        const { components } = createPaginatedResponsibilityArray(
            roleOptions,
            0,
            'promote_check_select_role',
            'اختر الرول لعرض إحصائيات أعضائه...'
        );

        const checkEmbed = colorManager.createEmbed()
            .setTitle('📊 إحصائيات الأدوار الإدارية')
            .setDescription(`**اختر رول لعرض إحصائيات أعضائه**\n\n**الإحصائيات المتاحة:**\n• أعلى من أرسل رسائل\n• أعلى من جلس بالفويسات\n• أكثر من انضم لفويسات\n• أكثر من وضع تفاعل\n• أكثر نشاط من كل النواحي`)
            .setThumbnail(context.client.user.displayAvatarURL())
            .setFooter({ text: 'By Ahmed' });

        const backButton = new ButtonBuilder()
            .setCustomId('promote_check_back_to_menu')
            .setLabel('🔙 العودة للمنيو الرئيسي')
            .setStyle(ButtonStyle.Secondary);

        const backRow = new ActionRowBuilder().addComponents(backButton);

        return interaction.update({
            embeds: [checkEmbed],
            components: [...components, backRow]
        });
    }

    // Handle navigation for roles list in check admin
    if (interaction.isButton() && (customId.startsWith('promote_check_select_role') && (customId.includes('_prev_page') || customId.includes('_next_page')))) {
        const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
        const adminRoles = readJson(adminRolesPath, []);
        const roleOptions = adminRoles.map(roleId => {
            const role = interaction.guild.roles.cache.get(roleId);
            return role ? {
                label: role.name,
                value: roleId,
                description: `أعضاء: ${role.members.size}`
            } : null;
        }).filter(Boolean);

        let currentPage = parseInt(interaction.message.components[1].components[1].label.match(/\d+/)[0]) - 1;
        if (customId.includes('prev')) currentPage--;
        else currentPage++;

        
        const { components } = createPaginatedResponsibilityArray(
            roleOptions,
            currentPage,
            'promote_check_select_role',
            'اختر الرول لعرض إحصائيات أعضائه...'
        );

        await interaction.update({ components: [...components, interaction.message.components[interaction.message.components.length - 1]] });
        return;
    }

    // Handle back button from member search to role stats
    if (interaction.isButton() && customId.startsWith('promote_check_members_back_')) {
        const roleId = customId.split('_')[4];
        const role = interaction.guild.roles.cache.get(roleId);

        if (!role) {
            return interaction.update({
                content: '⚠️ **لم يتم العثور على الرول!**',
                components: []
            });
        }

        const membersArray = Array.from(role.members.values());
        const statsEmbed = await createRoleStatsEmbed(role, membersArray, 'weekly');

        const weeklyButton = new ButtonBuilder()
            .setCustomId(`promote_check_weekly_${roleId}`)
            .setLabel('الأسبوع')
            .setStyle(ButtonStyle.Success)
            .setEmoji('📅');

        const totalButton = new ButtonBuilder()
            .setCustomId(`promote_check_total_${roleId}`)
            .setLabel('الإجمالي')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📊');

        const membersButton = new ButtonBuilder()
            .setCustomId(`promote_check_members_${roleId}`)
            .setLabel('بحث عن عضو')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🔍');

        const periodRow = new ActionRowBuilder().addComponents(weeklyButton, totalButton, membersButton);

        const backButton = new ButtonBuilder()
            .setCustomId('promote_check_back_to_roles')
            .setLabel('🔙 العودة')
            .setStyle(ButtonStyle.Secondary);

        const backRow = new ActionRowBuilder().addComponents(backButton);

        return interaction.update({
            embeds: [statsEmbed],
            components: [periodRow, backRow]
        });
    }

    // Handle member selection
    if (interaction.isStringSelectMenu() && customId.startsWith('promote_check_select_member_')) {
        const selectedMemberIds = interaction.values;

        try {
            await interaction.deferReply({ ephemeral: true });

            const { getDatabase } = require('../utils/database');
            const dbManager = getDatabase();

            for (const memberId of selectedMemberIds) {
                const member = await interaction.guild.members.fetch(memberId);
                if (!member) continue;

                const userStats = await dbManager.getUserStats(memberId);
                const weeklyStats = await dbManager.getWeeklyStats(memberId);

                function formatVoiceTime(ms) {
                    const totalSeconds = Math.floor(ms / 1000);
                    const days = Math.floor(totalSeconds / 86400);
                    const hours = Math.floor((totalSeconds % 86400) / 3600);
                    const minutes = Math.floor((totalSeconds % 3600) / 60);

                    const parts = [];
                    if (days > 0) parts.push(`${days} يوم`);
                    if (hours > 0) parts.push(`${hours} ساعة`);
                    if (minutes > 0) parts.push(`${minutes} دقيقة`);

                    return parts.length > 0 ? parts.join(' و ') : 'لا يوجد';
                }

                const memberEmbed = colorManager.createEmbed()
                    .setTitle(`📊 إحصائيات: ${member.displayName}`)
                    .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 128 }))
                    .addFields(
                        {
                            name: '📬 **الرسائل**',
                            value: `**الأسبوع:** ${weeklyStats.weeklyMessages || 0}\n**الإجمالي:** ${userStats.totalMessages || 0}`,
                            inline: true
                        },
                        {
                            name: '🎤 **وقت الفويس**',
                            value: `**الأسبوع:** ${formatVoiceTime(weeklyStats.weeklyTime || 0)}\n**الإجمالي:** ${formatVoiceTime(userStats.totalVoiceTime || 0)}`,
                            inline: true
                        },
                        {
                            name: '🔗 **انضمامات الفويس**',
                            value: `**الأسبوع:** ${weeklyStats.weeklyVoiceJoins || 0}\n**الإجمالي:** ${userStats.totalVoiceJoins || 0}`,
                            inline: true
                        },
                        {
                            name: '⭐ **التفاعلات**',
                            value: `**الأسبوع:** ${weeklyStats.weeklyReactions || 0}\n**الإجمالي:** ${userStats.totalReactions || 0}`,
                            inline: true
                        },
                        {
                            name: '🎯 **إجمالي الجلسات الصوتية**',
                            value: `${userStats.totalSessions || 0}`,
                            inline: true
                        },
                        {
                            name: '📅 **آخر نشاط**',
                            value: userStats.lastActivity ? new Date(userStats.lastActivity).toLocaleString('ar-EG') : 'غير معروف',
                            inline: true
                        }
                    )
                    .setFooter({ text: `معرف العضو: ${memberId}` })
                    .setTimestamp();

                await interaction.followUp({ embeds: [memberEmbed], ephemeral: true });
            }

        } catch (error) {
            console.error('خطأ في عرض إحصائيات الأعضاء:', error);
            await interaction.followUp({ content: '**حدث خطأ أثناء عرض الإحصائيات.**', ephemeral: true });
        }
        return;
    }

    // Handle admin activity option selection
    if (interaction.isStringSelectMenu() && customId === 'promote_activity_option') {
        const selectedOption = interaction.values[0];

        if (selectedOption === 'activity_specific_user') {
            const userSelect = new UserSelectMenuBuilder()
                .setCustomId('promote_activity_select_user')
                .setPlaceholder(' اختر العضو لفحص تفاعله...')
                .setMaxValues(1);

            const userRow = new ActionRowBuilder().addComponents(userSelect);

            await interaction.update({
                content: ' **اختر العضو لفحص إحصائيات تفاعله:**',
                components: [userRow]
            });
        } else if (selectedOption === 'activity_specific_role') {
            const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
            const adminRoles = readJson(adminRolesPath, []);

            if (adminRoles.length === 0) {
                await interaction.update({
                    content: '⚠️ **لا توجد رولات إدارية محددة! يرجى إضافة رولات إدارية أولاً.**',
                    components: []
                });
                return;
            }

            const availableRoles = adminRoles.map(roleId => {
                const role = interaction.guild.roles.cache.get(roleId);
                return role ? {
                    label: role.name,
                    value: roleId,
                    description: `فحص تفاعل أعضاء ${role.name}`
                } : null;
            }).filter(Boolean).slice(0, 25);

            const roleSelect = new StringSelectMenuBuilder()
                .setCustomId('promote_activity_select_role')
                .setPlaceholder('اختر الرول لفحص تفاعل أعضائه...')
                .addOptions(availableRoles);

            const roleRow = new ActionRowBuilder().addComponents(roleSelect);

            await interaction.update({
                content: ' **اختر الرول لفحص إحصائيات تفاعل أعضائه:**',
                components: [roleRow]
            });
        }
        return;
    }

    // Handle role selection for activity check
    if (interaction.isStringSelectMenu() && customId === 'promote_activity_select_role') {
        const selectedRoleId = interaction.values[0];
        const role = interaction.guild.roles.cache.get(selectedRoleId);

        if (!role) {
            await interaction.update({
                content: ' **لم يتم العثور على الرول!**',
                components: []
            });
            return;
        }

        // Create period selection
        const periodSelect = new StringSelectMenuBuilder()
            .setCustomId(`promote_activity_period_role_${selectedRoleId}`)
            .setPlaceholder('اختر فترة الفحص...')
            .addOptions([
                {
                    label: 'أسبوعي (آخر 7 أيام)',
                    value: 'weekly',
                    description: 'إحصائيات آخر أسبوع فقط'
                },
                {
                    label: 'إجمالي (كل الوقت)',
                    value: 'total',
                    description: 'جميع الإحصائيات منذ البداية'
                }
            ]);

        const periodRow = new ActionRowBuilder().addComponents(periodSelect);

        await interaction.update({
            content: ` **اختر فترة فحص التفاعل للرول** <@&${selectedRoleId}>**:**`,
            components: [periodRow]
        });
        return;
    }

    // Handle period selection for role activity check
    if (interaction.isStringSelectMenu() && customId.startsWith('promote_activity_period_role_')) {
        const roleId = customId.replace('promote_activity_period_role_', '');
        const period = interaction.values[0];
        const role = interaction.guild.roles.cache.get(roleId);

        if (!role) {
            await interaction.update({
                content: ' **لم يتم العثور على الرول!**',
                components: []
            });
            return;
        }

        const membersWithRole = role.members;
        if (membersWithRole.size === 0) {
            await interaction.update({
                content: ` **الرول** <@&${roleId}> **لا يحتوي على أي أعضاء!**`,
                components: []
            });
            return;
        }

        // Get database stats for all members
        const database = context.database;
        let totalVoiceTime = 0;
        let totalMessages = 0;
        let totalReactions = 0;
        let totalVoiceJoins = 0;
        const memberStats = [];

        // حساب بداية الأسبوع (السبت) أو 0 للإجمالي
        const weekStart = period === 'weekly' ? moment().tz('Asia/Riyadh').startOf('week') : null;

        for (const [userId, member] of membersWithRole) {
            if (database) {
                let userStats;
                if (period === 'weekly') {
                    // Get weekly stats
                    const weeklyData = await database.all(
                        `SELECT SUM(voice_time) as voice_time, SUM(messages) as messages, SUM(voice_joins) as voice_joins, SUM(reactions) as reactions FROM daily_activity WHERE user_id = ? AND date >= ?`,
                        [userId, weekStart.format('YYYY-MM-DD')]
                    );
                    userStats = weeklyData[0] || { voice_time: 0, messages: 0, voice_joins: 0, reactions: 0 };
                } else {
                    // Get total stats
                    userStats = await database.get(
                        'SELECT total_voice_time as voice_time, total_messages as messages, total_voice_joins as voice_joins, total_reactions as reactions FROM user_totals WHERE user_id = ?',
                        [userId]
                    );
                }

                const voiceTime = userStats ? (userStats.voice_time || 0) : 0;
                const voiceMinutes = Math.floor(voiceTime / 60000);
                const messages = userStats ? (userStats.messages || 0) : 0;
                const reactions = userStats ? (userStats.reactions || 0) : 0;
                const voiceJoins = userStats ? (userStats.voice_joins || 0) : 0;

                totalVoiceTime += voiceTime;
                totalMessages += messages;
                totalReactions += reactions;
                totalVoiceJoins += voiceJoins;

                // Create object for activity rating
                const memberStatObj = {
                    totalVoiceTime: voiceTime,
                    totalMessages: messages,
                    totalReactions: reactions,
                    totalVoiceJoins: voiceJoins,
                    activeDays: period === 'weekly' ? 7 : 30
                };

                // Get member activity rating
                const rating = await getActivityRating(memberStatObj, context);

                memberStats.push({
                    member: member,
                    voiceTime: voiceTime,
                    voiceMinutes: voiceMinutes,
                    messages: messages,
                    reactions: reactions,
                    voiceJoins: voiceJoins,
                    rating: rating,
                    score: rating.score || rating.percentage || 0
                });
            }
        }

        // Sort by activity score
        memberStats.sort((a, b) => b.score - a.score);

        // Calculate averages
        const avgVoiceMinutes = Math.round((totalVoiceTime / 60000) / membersWithRole.size);
        const avgMessages = Math.round(totalMessages / membersWithRole.size);
        const avgReactions = Math.round(totalReactions / membersWithRole.size);
        const avgVoiceJoins = Math.round(totalVoiceJoins / membersWithRole.size);

        // Classify members by rating
        const excellentMembers = memberStats.filter(s => s.score >= 80 || s.score >= 150).length;
        const goodMembers = memberStats.filter(s => (s.score >= 50 && s.score < 80) || (s.score >= 90 && s.score < 150)).length;
        const weakMembers = memberStats.filter(s => s.score < 50 || s.score < 90).length;

        // Create detailed embed
        const activityEmbed = colorManager.createEmbed()
            .setTitle('📊 **إحصائيات نشاط الرول**')
            .setDescription(`**إحصائيات تفاعل أعضاء الرول** <@&${roleId}>\n` +
                            `**الفترة:** ${period === 'weekly' ? 'أسبوعي (آخر 7 أيام)' : 'إجمالي (كل الوقت)'}`)
            .addFields([
                { name: '👥 **إجمالي الأعضاء**', value: membersWithRole.size.toString(), inline: true },
                { name: '🌟 **ممتازين**', value: excellentMembers.toString(), inline: true },
                { name: '✅ **جيدين**', value: goodMembers.toString(), inline: true },
                { name: '⚠️ **ضعفاء**', value: weakMembers.toString(), inline: true },
                { name: '📈 **متوسط الرسائل**', value: avgMessages.toLocaleString(), inline: true },
                { name: '🎤 **متوسط الصوت**', value: `${avgVoiceMinutes} دقيقة`, inline: true },
                { name: '👍 **متوسط التفاعلات**', value: avgReactions.toLocaleString(), inline: true },
                { name: '🔗 **متوسط انضمام الصوت**', value: avgVoiceJoins.toLocaleString(), inline: true }
            ]);

        // Add top performers with their ratings
        const topPerformers = memberStats.slice(0, 8).map((stat, index) => {
            const voiceHours = Math.floor(stat.voiceMinutes / 60);
            const voiceMinutesRem = stat.voiceMinutes % 60;
            const timeText = voiceHours > 0 ? `${voiceHours}ساعة ${voiceMinutesRem}د` : `${voiceMinutesRem}د`;

            return `**${index + 1}.** ${stat.member.displayName} ${stat.rating.emoji}\n` +
                   `├─ 🎤 ${timeText} | 💬 ${stat.messages} | 👍 ${stat.reactions}\n` +
                   `└─ ${stat.rating.rating}`;
        }).join('\n\n');

        if (topPerformers) {
            activityEmbed.addFields([
                { name: '🏆 **أعلى المتفاعلين**', value: topPerformers, inline: false }
            ]);
        }

        // Add ملاحظة عن نظام التقييم
        const guildAverages = await calculateGuildAverages(context);
        const ratingMethod = guildAverages ? 'مقارنة بمتوسط السيرفر' : 'نظام النقاط المرن';

        activityEmbed.addFields([
            { name: '📋 **نظام التقييم**', value: `يتم حساب التقييم بناءً على: ${ratingMethod}`, inline: false }
        ]);

        await interaction.update({
            embeds: [activityEmbed],
            content: '',
            components: []
        });
        return;
    }

    // Handle user selection for activity check with period
    if (interaction.isUserSelectMenu() && customId === 'promote_activity_select_user') {
        const selectedUserId = interaction.values[0];

        // Create period selection
        const periodSelect = new StringSelectMenuBuilder()
            .setCustomId(`promote_activity_period_user_${selectedUserId}`)
            .setPlaceholder('اختر فترة الفحص...')
            .addOptions([
                {
                    label: 'أسبوعي (آخر 7 أيام)',
                    value: 'weekly',
                    description: 'إحصائيات آخر أسبوع فقط'
                },
                {
                    label: 'إجمالي (كل الوقت)',
                    value: 'total',
                    description: 'جميع الإحصائيات منذ البداية'
                }
            ]);

        const periodRow = new ActionRowBuilder().addComponents(periodSelect);

        await interaction.update({
            content: ` **اختر فترة فحص التفاعل للعضو** <@${selectedUserId}>**:**`,
            components: [periodRow]
        });
        return;
    }

    // Handle period selection for user activity check
    if (interaction.isStringSelectMenu() && customId.startsWith('promote_activity_period_user_')) {
        const userId = customId.replace('promote_activity_period_user_', '');
        const period = interaction.values[0];

        const database = context.database;
        let userStats = { 
            totalVoiceTime: 0, 
            totalMessages: 0, 
            totalReactions: 0, 
            totalVoiceJoins: 0,
            activeDays: 0
        };

        if (database) {
            if (period === 'weekly') {
                // Get weekly stats - بداية الأسبوع (السبت)
                const weekStart = moment().tz('Asia/Riyadh').startOf('week');
                const weeklyData = await database.all(
                    `SELECT SUM(voice_time) as voice_time, SUM(messages) as messages, SUM(voice_joins) as voice_joins, SUM(reactions) as reactions FROM daily_activity WHERE user_id = ? AND date >= ?`,
                    [userId, weekStart.format('YYYY-MM-DD')]
                );
                const weeklyStats = weeklyData[0] || {};
                userStats = {
                    totalVoiceTime: weeklyStats.voice_time || 0,
                    totalMessages: weeklyStats.messages || 0,
                    totalReactions: weeklyStats.reactions || 0,
                    totalVoiceJoins: weeklyStats.voice_joins || 0,
                    activeDays: 7 // أسبوع كامل
                };
            } else {
                // Get total stats
                const totalData = await database.get(
                    'SELECT total_voice_time, total_messages, total_reactions, total_voice_joins FROM user_totals WHERE user_id = ?',
                    [userId]
                );
                if (totalData) {
                    userStats = {
                        totalVoiceTime: totalData.total_voice_time || 0,
                        totalMessages: totalData.total_messages || 0,
                        totalReactions: totalData.total_reactions || 0,
                        totalVoiceJoins: totalData.total_voice_joins || 0,
                        activeDays: 30 // تقدير لشهر
                    };
                }
            }
        }

        // استخدام نظام التقييم الجديد
        const activityRating = await getActivityRating(userStats, context);

        const voiceMinutes = Math.floor(userStats.totalVoiceTime / 60000);
        const voiceHours = Math.floor(voiceMinutes / 60);

        const activityEmbed = colorManager.createEmbed()
            .setTitle('📊 **فحص نشاط الإداري**')
            .setDescription(`**إحصائيات تفاعل العضو** <@${userId}>\n` +
                            `**الفترة:** ${period === 'weekly' ? 'أسبوعي (آخر 7 أيام)' : 'إجمالي (كل الوقت)'}`)
            .addFields([
                { name: '🎤 **وقت الصوت**', value: `${voiceHours} ساعة و ${voiceMinutes % 60} دقيقة`, inline: true },
                { name: '💬 **إجمالي الرسائل**', value: userStats.totalMessages.toLocaleString(), inline: true },
                { name: '👍 **التفاعلات**', value: userStats.totalReactions.toLocaleString(), inline: true },
                { name: '🔗 **انضمامات الصوت**', value: userStats.totalVoiceJoins.toLocaleString(), inline: true },
                { name: '📅 **الأيام النشطة**', value: userStats.activeDays.toString(), inline: true },
                { name: '📊 **تقييم التفاعل**', value: activityRating.rating, inline: true }
            ])
            .setTimestamp();

        // إضافة تفاصيل التقييم إذا كانت متاحة
        if (activityRating.details) {
            let detailsText = '';
            if (activityRating.method === 'flexible') {
                detailsText = `**النقاط:** ${activityRating.score}/100\n**التفاصيل:** الصوت: ${activityRating.details.voice}ساعة، الرسائل: ${activityRating.details.messages}، التفاعلات: ${activityRating.details.reactions}`;
            } else {
                detailsText = `**النسبة الإجمالية:** ${activityRating.percentage}% من المتوسط\n**التفاصيل:**\n• الصوت: ${activityRating.details.voice}%\n• الرسائل: ${activityRating.details.messages}%\n• التفاعلات: ${activityRating.details.reactions}%`;
            }

            activityEmbed.addFields([
                { name: '📈 **تفاصيل التقييم**', value: activityRating.description, inline: false },
                { name: '🔍 **تحليل مفصل**', value: detailsText, inline: false }
            ]);
        }

        await interaction.update({
            embeds: [activityEmbed],
            content: '',
            components: []
        });
        return;
    }

    // Handle old user selection for unbanning (kept for backward compatibility)
    if (interaction.isUserSelectMenu() && customId === 'promote_unban_select_user') {
        const selectedUserId = interaction.values[0];

        const result = await promoteManager.unbanFromPromotions(selectedUserId, interaction.guild.id, interaction.user);

        if (result.success) {
            await interaction.reply({
                content: ` **تم فك حظر الترقية بنجاح عن العضو** <@${selectedUserId}>`,
                flags: MessageFlags.Ephemeral
            });
        } else {
            await interaction.reply({
                content: ` **فشل في فك الحظر:** ${result.error}`,
                flags: MessageFlags.Ephemeral
            });
        }
        return;
    }

    // Handle user selection for activity check
    if (interaction.isUserSelectMenu() && customId === 'promote_activity_select_user') {
        const selectedUserId = interaction.values[0];

        const stats = await promoteManager.getUserInteractionStats(selectedUserId);

        const activityEmbed = colorManager.createEmbed()
            .setTitle('Admin Activity Check')
            .setDescription(`إحصائيات تفاعل العضو <@${selectedUserId}>`)
            .addFields([
                { name: ' وقت الصوت الإجمالي', value: `${Math.floor(stats.totalVoiceTime / 60)} دقيقة`, inline: true },
                { name: ' إجمالي الرسائل', value: stats.totalMessages.toString(), inline: true },
                { name: ' إجمالي التفاعلات', value: stats.totalReactions.toString(), inline: true },
                { name: ' جلسات الصوت', value: stats.totalSessions.toString(), inline: true },
                { name: ' الأيام النشطة', value: stats.activeDays.toString(), inline: true },
                { name: ' تقييم التفاعل', value: getActivityRating(stats), inline: true }
            ])
            .setTimestamp();

        await interaction.reply({
            embeds: [activityEmbed],
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    // Handle modal submission for bulk promotion
    if (interaction.isModalSubmit() && customId.startsWith('promote_bulk_modal_')) {
        const parts = customId.split('_');
        const sourceRoleId = parts[3];
        const targetRoleId = parts[4];
        let excludedIds = [];
        
        const excludedPart = parts.slice(5).join('_');
        if (excludedPart.startsWith('cache_bulk_')) {
            const tempKey = excludedPart.replace('cache_', '');
            excludedIds = global.bulkPromoteCache?.get(tempKey) || [];
            global.bulkPromoteCache?.delete(tempKey); // Clean up
        } else {
            excludedIds = excludedPart ? excludedPart.split(',') : [];
        }
        const duration = interaction.fields.getTextInputValue('promote_duration');
        const reason = interaction.fields.getTextInputValue('promote_reason');

        try {
            // إرجاء الرد فوراً لتجنب انتهاء صلاحية التفاعل
            await interaction.deferReply({ ephemeral: true });

            const bulkSourceRole = interaction.guild.roles.cache.get(sourceRoleId);
            const targetRole = interaction.guild.roles.cache.get(targetRoleId);

            if (!bulkSourceRole || !targetRole) {
                await interaction.editReply({
                    content: ' **لم يتم العثور على أحد الرولات!**'
                });
                return;
            }

            const membersWithRole = bulkSourceRole.members;
            const promoteBansPath = path.join(__dirname, '..', 'data', 'promoteBans.json');
            const promoteBans = readJson(promoteBansPath, {});

            let successCount = 0;
            let failedCount = 0;
            let bannedCount = 0;
            let excludedCount = 0;
            let results = [];
            let successfulMembers = [];
            let failedMembers = [];
            let bannedMembers = [];

            // إرسال رسالة تحديث للمستخدم
            await interaction.editReply({
                content: `⏳ **جاري معالجة الترقية الجماعية...**\n**الأعضاء المستهدفين:** ${membersWithRole.size}\n**المستبعدين:** ${excludedIds.length}\n**من:** ${bulkSourceRole.name}\n**إلى:** ${targetRole.name}`
            });

            // Process each member
            for (const [userId, member] of membersWithRole) {
                // تجاهل البوتات
                if (member.user.bot) continue;

                // Check if excluded manually
                if (excludedIds.includes(userId)) {
                    excludedCount++;
                    results.push(`🚫 ${member.displayName}: مستبعد يدوياً`);
                    continue;
                }

                const banKey = `${userId}_${interaction.guild.id}`;

                // Check if banned
                if (promoteBans[banKey]) {
                    const banData = promoteBans[banKey];
                    const banEndTime = banData.endTime;

                    if (!banEndTime || banEndTime > Date.now()) {
                        bannedCount++;
                        bannedMembers.push({
                            member: member,
                            reason: 'محظور من الترقيات'
                        });
                        results.push(`🚫 ${member.displayName}: محظور من الترقيات`);
                        continue;
                    }
                }

                // Validate role hierarchy
                const validation = await promoteManager.validateRoleHierarchy(
                    interaction.guild, 
                    userId, 
                    targetRoleId, 
                    interaction.user.id
                );

                if (!validation.valid) {
                    failedCount++;
                    failedMembers.push({
                        member: member,
                        reason: validation.error
                    });
                    results.push(`❌ ${member.displayName}: ${validation.error}`);
                    continue;
                }

                // Process promotion (mark as bulk operation)
                const result = await promoteManager.createBulkPromotion(
                    interaction.guild,
                    context.client,
                    userId,
                    sourceRoleId,
                    targetRoleId,
                    duration,
                    reason,
                    interaction.user.id
                );

                if (result.success) {
                    successCount++;
                    successfulMembers.push(member);
                    results.push(`✅ ${member.displayName}: تم ترقيته بنجاح`);
                } else {
                    failedCount++;
                    failedMembers.push({
                        member: member,
                        reason: result.error
                    });
                    results.push(`❌ ${member.displayName}: ${result.error}`);
                }
            }

            // إرسال رسائل DM للأعضاء الذين تم ترقيتهم بنجاح (رسالة جماعية موحدة)
            if (successfulMembers.length > 0) {
                const dmEmbed = colorManager.createEmbed()
                    .setTitle('**ترقية جماعية - تهانينا!**')
                    .setDescription(`**تم ترقيتك ضمن ترقية جماعية**`)
                    .addFields([
                        { name: '**نوع الترقية**', value: 'ترقية جماعية لجميع أعضاء الرول', inline: false },
                        { name: '**من الرول**', value: `${bulkSourceRole.name}`, inline: true },
                        { name: '**إلى الرول**', value: `**${targetRole.name}**`, inline: true },
                        { name: '**المدة**', value: duration === 'نهائي' || !duration ? 'نهائي' : duration, inline: true },
                        { name: '**السبب**', value: reason, inline: false },
                        { name: '**تم بواسطة**', value: `${interaction.user.username}`, inline: true },
                        { name: '**التاريخ**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                        { name: '**العدد الإجمالي**', value: `${successCount} عضو تم ترقيتهم`, inline: true }
                    ])
                    .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
                    .setTimestamp()
                    .setFooter({ text: `خادم ${interaction.guild.name}`, iconURL: interaction.guild.iconURL({ dynamic: true }) });

                let dmSuccessCount = 0;
                let dmFailCount = 0;

                for (const member of successfulMembers) {
                    try {
                        await member.send({ embeds: [dmEmbed] });
                        dmSuccessCount++;
                    } catch (dmError) {
                        dmFailCount++;
                        console.log(`لا يمكن إرسال رسالة خاصة إلى ${member.displayName}`);
                    }
                }

                console.log(`تم إرسال ${dmSuccessCount} رسالة خاصة من أصل ${successfulMembers.length} عضو`);
            }

            // Create summary embed
            const summaryEmbed = colorManager.createEmbed()
                .setTitle('**نتائج الترقية الجماعية**')
                .setDescription(`**تم تطبيق ترقية جماعية من الرول** **${bulkSourceRole.name}** **إلى** **${targetRole.name}**`)
                .addFields([
                    { name: '**نجح**', value: successCount.toString(), inline: true },
                    { name: '**فشل**', value: failedCount.toString(), inline: true },
                    { name: '**محظورين**', value: bannedCount.toString(), inline: true },
                    { name: '**مستبعدين يدوياً**', value: excludedCount.toString(), inline: true },
                    { name: '**إجمالي الأعضاء**', value: membersWithRole.size.toString(), inline: true },
                    { name: '**المدة**', value: duration === 'نهائي' || !duration ? 'نهائي' : duration, inline: true },
                    { name: '**التاريخ**', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
                    { name: '**السبب**', value: reason, inline: false }
                ])
                .setTimestamp();

            // Add results if there are failures or bans
            if (failedCount > 0 || bannedCount > 0) {
                const problemResults = results.filter(r => r.startsWith('❌') || r.startsWith('🚫')).slice(0, 15);
                if (problemResults.length > 0) {
                    summaryEmbed.addFields([
                        { name: '⚠️ **تفاصيل المشاكل**', value: problemResults.join('\n'), inline: false }
                    ]);
                }
            }

            if (successCount > 0) {
                summaryEmbed.addFields([
                    { name: '✅ **ملاحظة**', value: `تم إرسال إشعارات خاصة لجميع الأعضاء الذين تم ترقيتهم بنجاح`, inline: false }
                ]);
            }

            await interaction.editReply({ embeds: [summaryEmbed] });

            // Log bulk promotion with unified logging - حفظ سجل جماعي واحد فقط
            promoteManager.logAction('BULK_PROMOTION', {
                sourceRoleId,
                sourceRoleName: bulkSourceRole.name,
                targetRoleId,
                targetRoleName: targetRole.name,
                moderatorId: interaction.user.id,
                duration,
                reason,
                successCount,
                failedCount,
                bannedCount,
                excludedCount,
                totalMembers: membersWithRole.size,
                guildId: interaction.guild.id,
                successfulMembers: successfulMembers.map(m => m.id), // حفظ معرفات الأعضاء الناجحين
                timestamp: Date.now()
            });

            // إرسال سجل موحد بدلاً من سجلات فردية
            await promoteManager.sendLogMessage(interaction.guild, context.client, 'BULK_PROMOTION', {
                sourceRoleId: sourceRoleId,
                sourceRoleName: bulkSourceRole.name,
                targetRoleId: targetRoleId,
                targetRoleName: targetRole.name,
                moderatorId: interaction.user.id,
                moderatorUser: interaction.user,
                duration: duration || 'نهائي',
                reason,
                successCount,
                failedCount: failedMembers.length,
                bannedCount: bannedMembers.length,
                excludedCount: excludedCount,
                totalMembers: membersWithRole.size,
                successfulMembers: successfulMembers,
                failedMembers: failedMembers,
                bannedMembers: bannedMembers
            });

        } catch (error) {
            console.error('خطأ في معالجة الترقية الجماعية:', error);
            try {
                if (interaction.deferred) {
                    await interaction.editReply({
                        content: ' **حدث خطأ أثناء معالجة الترقية الجماعية!**'
                    });
                } else {
                    await interaction.reply({
                        content: ' **حدث خطأ أثناء معالجة الترقية الجماعية!**',
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (replyError) {
                console.error('خطأ في الرد على خطأ الترقية الجماعية:', replyError);
            }
        }
        return;
    }

    // Handle modal submission for promotion
    if (interaction.isModalSubmit() && customId.startsWith('promote_modal_')) {
        const parts = customId.split('_');
        const userId = parts[2];
        const roleIdsPart = parts.slice(3).join('_');
        let roleIds = [];

        if (roleIdsPart.startsWith('cache_roles_')) {
            const tempKey = roleIdsPart.replace('cache_', '');
            roleIds = global.promoteRolesCache?.get(tempKey) || [];
            global.promoteRolesCache?.delete(tempKey);
        } else {
            roleIds = roleIdsPart.split(',');
        }
        const duration = interaction.fields.getTextInputValue('promote_duration').trim();
        const reason = interaction.fields.getTextInputValue('promote_reason').trim();

        // Normalize duration input - تحسين معالجة المدة
        if (!duration || duration.trim() === '') {
            duration = null; // empty input means permanent
        } else if (duration.toLowerCase() === 'نهائي' || duration.toLowerCase() === 'permanent' || duration.toLowerCase() === 'دائم') {
            duration = null; // null for permanent promotions
        } else {
            // تنظيف المدة وإضافة دعم للغة العربية
            duration = duration.trim()
                .replace('ايام', 'd').replace('ايام', 'd').replace('يوم', 'd')
                .replace('ساعات', 'h').replace('ساعة', 'h')
                .replace('دقائق', 'm').replace('دقيقة', 'm');
        }

        try {
            const member = await interaction.guild.members.fetch(userId);
            if (!member) {
                await interaction.reply({
                    content: '❌ **لم يتم العثور على العضو!**',
                    flags: MessageFlags.Ephemeral
                });
                return;
            }

            // Validate duration with better error handling
            if (duration && duration !== null) {
                try {
                    const durationMs = ms(duration);
                    if (!durationMs || durationMs <= 0) {
                        await interaction.reply({
                            content: '❌ **صيغة المدة غير صحيحة!**\n\n**أمثلة صحيحة:**\n• `7d` أو `7 ايام` - لسبعة أيام\n• `12h` أو `12 ساعات` - لاثني عشر ساعة\n• `30m` أو `30 دقائق` - لثلاثين دقيقة\n• `نهائي` أو `دائم` - للترقية الدائمة',
                            flags: MessageFlags.Ephemeral
                        });
                        return;
                    }
                } catch (durationError) {
                    console.error('خطأ في تحليل المدة:', durationError);
                    await interaction.reply({
                        content: '❌ **خطأ في تحليل المدة المدخلة!**\n\nيرجى التأكد من الصيغة الصحيحة.',
                        flags: MessageFlags.Ephemeral
                    });
                    return;
                }
            }

            const results = [];
            const failedPromotions = [];
            let successCount = 0;
            let allRemovedOldRoles = [];

            // إنشاء Transaction ID موحد للترقية المتعددة
            const transactionId = `multi_${userId}_${Date.now()}`;

            // احفظ الرولات الإدارية الحالية قبل الترقية المتعددة
            const initialAdminRoles = member.roles.cache.filter(r => 
                r.name !== '@everyone' && 
                promoteManager.isAdminRole && promoteManager.isAdminRole(r.id)
            );

            // Process each role - disable DM and logging for individual roles
            for (const roleId of roleIds) {
                const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
                if (!role) {
                    failedPromotions.push(`Role ID ${roleId}: الرول غير موجود`);
                    continue;
                }

                // Process the promotion without individual DM or log messages
                const result = await promoteManager.createPromotion(
                    interaction.guild,
                    context.client,
                    userId,
                    roleId,
                    duration,
                    reason,
                    interaction.user.id,
                    false, // not bulk operation
                    false, // disable DM for individual roles
                    true,  // is multi-promotion - disable individual logging
                    transactionId // Transaction ID للربط
                );

                if (result.success) {
                    successCount++;
                    results.push({
                        roleId: roleId,
                        roleName: role.name,
                        success: true,
                        duration: result.duration,
                        endTime: result.endTime,
                        removedOldRoles: result.removedOldRoles || [],
                        previousRoleName: result.previousRoleName
                    });
                } else {
                    failedPromotions.push(`${role.name}: ${result.error}`);
                    results.push({
                        roleId: roleId,
                        roleName: role.name,
                        success: false,
                        error: result.error
                    });
                }
            }

            // معالجة إزالة الرولات القديمة بعد إضافة جميع الرولات الجديدة (للترقيات النهائية فقط)
            const isPermanentPromotion = !duration || duration === null || duration === undefined || duration === 'نهائي';
            if (isPermanentPromotion && successCount > 0 && initialAdminRoles.size > 0) {
                const newRoleIds = results.filter(r => r.success).map(r => r.roleId);

                for (const [oldRoleId, oldRole] of initialAdminRoles) {
                    try {
                        // تأكد من أن الرول ليس من الرولات الجديدة المضافة
                        if (!newRoleIds.includes(oldRoleId) && member.roles.cache.has(oldRoleId)) {
                            // إزالة الرولات القديمة بناءً على قاعدة الـ 3 أحرف الذكية (مكررة للتأكد في حالة الترقية المتعددة)
                            const isNewRoleRank = role.name.length <= 2;
                            const isOldRoleRank = oldRole.name.length <= 2;

                            if (isNewRoleRank === isOldRoleRank) {
                                await member.roles.remove(oldRoleId, `إزالة الرول الإداري القديم بعد الترقية المتعددة النهائية: ${reason}`);
                                console.log(`[Multi-Smart Logic] تم إزالة ${oldRole.name} لأن الرول الجديد ${role.name} من نفس النوع`);
                                allRemovedOldRoles.push(oldRole.name);
                            } else {
                                console.log(`[Multi-Smart Logic] تم الإبقاء على ${oldRole.name} لأن الرول الجديد ${role.name} من نوع مختلف`);
                            }
                            console.log(`تم إزالة الرول القديم ${oldRole.name} من ${member.displayName} بعد الترقية المتعددة النهائية`);
                        }
                    } catch (removeError) {
                        console.error(`خطأ في إزالة الرول القديم ${oldRole.name}:`, removeError);
                    }
                }
            }

            // إرسال رسالة لوج موحدة للترقية المتعددة
            if (successCount > 0) {
                const member = await interaction.guild.members.fetch(userId);
                const successfulRoles = results.filter(r => r.success);

                // تسجيل الترقية المتعددة
                promoteManager.logAction('MULTI_PROMOTION_APPLIED', {
                    targetUserId: userId,
                    roleIds: successfulRoles.map(r => r.roleId),
                    roleNames: successfulRoles.map(r => r.roleName),
                    guildId: interaction.guild.id,
                    duration: duration || 'نهائي',
                    reason,
                    byUserId: interaction.user.id,
                    successCount,
                    failedCount: failedPromotions.length,
                    transactionId,
                    removedRoles: [...new Set(allRemovedOldRoles)],
                    timestamp: Date.now()
                });

                // إرسال رسالة لوج موحدة
                await promoteManager.sendLogMessage(interaction.guild, context.client, 'MULTI_PROMOTION_APPLIED', {
                    targetUser: member.user,
                    roles: successfulRoles.map(r => ({ id: r.roleId, name: r.roleName })),
                    previousRoleName: successfulRoles[0]?.previousRoleName || 'لا يوجد رول سابق',
                    duration: duration || 'نهائي',
                    reason,
                    byUser: interaction.user,
                    successCount,
                    failedCount: failedPromotions.length,
                    removedOldRoles: [...new Set(allRemovedOldRoles)], // إزالة التكرارات
                    isMultiPromotion: true
                });
            }

            // Create response embed
            const isMultipleRoles = roleIds.length > 1;
            const successEmbed = colorManager.createEmbed()
                .setTitle(isMultipleRoles ? '👥 **نتائج الترقية المتعددة**' : '✅ **تم تطبيق الترقية بنجاح**')
                .setDescription(isMultipleRoles ? 
                    `**العضو:** <@${userId}>\n**تمت معالجة ${roleIds.length} رول` : 
                    `تم ترقية العضو وإعطاؤه الرول كما هو مطلوب`)
                .addFields([
                    { name: '👤 **العضو**', value: `<@${userId}>`, inline: true },
                    { name: '✅ **نجح**', value: successCount.toString(), inline: true },
                    { name: '❌ **فشل**', value: failedPromotions.length.toString(), inline: true },
                    { name: '⏰ **المدة**', value: duration || 'نهائي', inline: true },
                    { name: '📝 **السبب**', value: reason, inline: false },
                    { name: '👤 **بواسطة**', value: `<@${interaction.user.id}>`, inline: true }
                ])
                .setTimestamp();

            // Add successful promotions list
            if (successCount > 0) {
                const successfulRoles = results.filter(r => r.success).map(r => 
                    `• <@&${r.roleId}> - ينتهي: ${r.endTime ? `<t:${Math.floor(Number(r.endTime) / 1000)}:R>` : 'نهائي'}`
                ).join('\n');

                successEmbed.addFields([
                    { name: '🎉 **الرولات المضافة بنجاح**', value: successfulRoles, inline: false }
                ]);
            }

            // Add failed promotions if any
            if (failedPromotions.length > 0) {
                successEmbed.addFields([
                    { name: '⚠️ **الرولات التي فشلت**', value: failedPromotions.join('\n'), inline: false }
                ]);
            }

            await interaction.reply({ embeds: [successEmbed], ephemeral: true });

            // Send unified DM notification for all successful promotions
            if (successCount > 0) {
                try {
                    const member = await interaction.guild.members.fetch(userId);
                    const successfulRolesList = results.filter(r => r.success);
                    const dmEmbed = colorManager.createEmbed()
                        .setTitle(isMultipleRoles ? '🎉 **تم ترقيتك (رولات متعددة)**' : '🎉 **تم ترقيتك**')
                        .setDescription(isMultipleRoles ? 
                            `تم ترقيتك وإعطاؤك ${successCount} رول إداري جديد من قبل الإدارة.` :
                            `تم ترقيتك وإعطاؤك رول **${successfulRolesList[0].roleName}** من قبل الإدارة.`)
                        .addFields([
                            { name: '👤 **تمت الترقية بواسطة**', value: `${interaction.user.username}`, inline: true },
                            { name: '⏰ **المدة**', value: duration || 'نهائي', inline: true },
                            { name: '📝 **السبب**', value: reason, inline: false }
                        ])
                        .setTimestamp()
                        .setFooter({ text: `سيرفر ${interaction.guild.name}`, iconURL: interaction.guild.iconURL({ dynamic: true }) });

                    // Add roles list for multiple or single promotions
                    const rolesText = successfulRolesList.map(r => 
                        `• **${r.roleName}** - ينتهي: ${r.endTime ? `<t:${Math.floor(Number(r.endTime) / 1000)}:R>` : 'نهائي'}`
                    ).join('\n');

                    dmEmbed.addFields([
                        { name: isMultipleRoles ? '🏷️ **الرولات الجديدة**' : '🏷️ **الرول الجديد**', value: rolesText, inline: false }
                    ]);

                    // إضافة معلومات الرولات المُزالة إذا وجدت (فقط للترقيات النهائية)
                    if (allRemovedOldRoles.length > 0 && (!duration || duration === null || duration === 'نهائي')) {
                        const uniqueRemovedRoles = [...new Set(allRemovedOldRoles)];
                        const removedRolesText = uniqueRemovedRoles.length === 1 ? 
                            `تم إزالة الرول السابق **${uniqueRemovedRoles[0]}**` :
                            `تم إزالة الرولات السابقة: **${uniqueRemovedRoles.join('**, **')}**`;

                        dmEmbed.addFields([
                            { name: '⚠️ **ملاحظة مهمة**', value: `${removedRolesText} لأن الترقية نهائية`, inline: false }
                        ]);
                    }

                    await member.send({ embeds: [dmEmbed] });
                } catch (dmError) {
                    console.log(`لا يمكن إرسال رسالة خاصة إلى العضو ${userId}`);
                }
            }

        } catch (error) {
            console.error('Error in promotion modal submission:', error);
            await interaction.reply({
                content: '❌ **حدث خطأ أثناء معالجة الترقية!**\n\n' +
                        `**تفاصيل الخطأ:** ${error.message || 'خطأ غير معروف'}`,
                flags: MessageFlags.Ephemeral
            });
        }
        return;
    }

    // Handle permission type selection for editing
    if (interaction.isStringSelectMenu() && customId === 'promote_edit_permission_type') {
        const permissionType = interaction.values[0];
        const settingsPath = path.join(__dirname, '..', 'data', 'promoteSettings.json');
        const settings = readJson(settingsPath, {});

        settings.allowedUsers.type = permissionType;
        settings.allowedUsers.targets = []; // Clear existing targets

        if (permissionType === 'owners') {
            settings.allowedUsers.targets = context.BOT_OWNERS;
            saveJson(settingsPath, settings);
            await interaction.update({
                content: ' **تم تغيير صلاحيات المعتمدين إلى "المالكين فقط".**',
                components: []
            });
        } else if (permissionType === 'roles') {
            const roleSelect = new RoleSelectMenuBuilder()
                .setCustomId('promote_edit_select_roles')
                .setPlaceholder(' اختر الرولات المعتمدة...')
                .setMaxValues(10);

            const roleRow = new ActionRowBuilder().addComponents(roleSelect);

            await interaction.update({
                content: ' **اختر الرولات المعتمدة لاستخدام النظام:**',
                components: [roleRow]
            });
        } else if (permissionType === 'responsibility') {
            const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
            const responsibilities = readJson(responsibilitiesPath, {});

            if (Object.keys(responsibilities).length === 0) {
                await interaction.update({
                    content: '⚠️ **لا توجد مسؤوليات معرّفة! يرجى إضافتها أولاً.**',
                    components: []
                });
                return;
            }

            const respOptions = Object.keys(responsibilities).slice(0, 25).map(name => ({
                label: name,
                value: name,
                description: `السماح للمسؤولين عن ${name}`
            }));

            const respSelect = new StringSelectMenuBuilder()
                .setCustomId('promote_edit_select_responsibilities')
                .setPlaceholder(' اختر المسؤوليات المعتمدة...')
                .setMaxValues(Math.min(respOptions.length, 10))
                .addOptions(respOptions);

            const respRow = new ActionRowBuilder().addComponents(respSelect);

            await interaction.update({
                content: ' **اختر المسؤوليات المعتمدة لاستخدام النظام:**',
                components: [respRow]
            });
        }
        return;
    }

    // Handle role selection for editing permissions
    if (interaction.isRoleSelectMenu() && customId === 'promote_edit_select_roles') {
        const settingsPath = path.join(__dirname, '..', 'data', 'promoteSettings.json');
        const settings = readJson(settingsPath, {});
        settings.allowedUsers.targets = interaction.values;
        saveJson(settingsPath, settings);

        await interaction.update({
            content: ' **تم تحديد الرولات المعتمدة بنجاح.**',
            components: []
        });
        return;
    }

    // Handle responsibility selection for editing permissions
    if (interaction.isStringSelectMenu() && customId === 'promote_edit_select_responsibilities') {
        const settingsPath = path.join(__dirname, '..', 'data', 'promoteSettings.json');
        const settings = readJson(settingsPath, {});
        settings.allowedUsers.targets = interaction.values;
        saveJson(settingsPath, settings);

        await interaction.update({
            content: ' **تم تحديد المسؤوليات المعتمدة بنجاح.**',
            components: []
        });
        return;
    }

    // Handle log channel selection for editing
    if (interaction.isChannelSelectMenu() && customId === 'promote_edit_log_channel_select') {
        const settingsPath = path.join(__dirname, '..', 'data', 'promoteSettings.json');
        const settings = readJson(settingsPath, {});
        settings.logChannel = interaction.values[0];
        saveJson(settingsPath, settings);

        await interaction.update({
            content: ' **تم تغيير قناة السجلات بنجاح.**',
            components: []
        });
        return;
    }

    // Handle menu channel selection for editing
    if (interaction.isChannelSelectMenu() && customId === 'promote_edit_menu_channel_select') {
        const settingsPath = path.join(__dirname, '..', 'data', 'promoteSettings.json');
        const settings = readJson(settingsPath, {});
        settings.menuChannel = interaction.values[0];
        saveJson(settingsPath, settings);

        // Re-send the menu to the new channel
        await createPermanentMenu(context.client, settings.menuChannel);

        await interaction.update({
            content: ' **تم تغيير روم المنيو وإعادة إرسال المنيو بنجاح.**',
            components: []
        });
        return;
    }

    // Handle reset confirmation buttons
    if (interaction.isButton() && (customId === 'promote_confirm_reset' || customId === 'promote_cancel_reset')) {
        if (customId === 'promote_cancel_reset') {
            await interaction.update({
                content: ' **تم إلغاء إعادة التعيين.**',
                embeds: [],
                components: []
            });
            return;
        }

        // Confirm reset - clear all data
        const dataFiles = [
            path.join(__dirname, '..', 'data', 'promoteSettings.json'),
            path.join(__dirname, '..', 'data', 'activePromotes.json'),
            path.join(__dirname, '..', 'data', 'promoteLogs.json'),
            path.join(__dirname, '..', 'data', 'leftMembersPromotes.json'),
            path.join(__dirname, '..', 'data', 'promoteBans.json')
        ];

        for (const filePath of dataFiles) {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch (error) {
                console.error(`Error deleting ${filePath}:`, error);
            }
        }

        await interaction.update({
            content: ' **تم إعادة تعيين النظام بنجاح! جميع البيانات والإعدادات تم حذفها.**',
            embeds: [],
            components: []
        });
        return;
    }

    // معالجات التنقل الجديدة للسجلات
    if (interaction.isButton() && (customId.startsWith('role_record_prev_') || customId.startsWith('role_record_next_'))) {
        const parts = customId.split('_');
        const direction = parts[2]; // prev or next
        const selectedRoleId = parts[3];
        let currentPage = parseInt(parts[4]) || 0;

        // تحديث الصفحة الحالية
        if (direction === 'prev') {
            currentPage = Math.max(0, currentPage - 1);
        } else if (direction === 'next') {
            currentPage = currentPage + 1;
        }

        // جلب السجلات
        const promoteLogsPath = path.join(__dirname, '..', 'data', 'promoteLogs.json');
        const promoteLogs = readJson(promoteLogsPath, []);

        const roleRecords = promoteLogs.filter(log => {
            if (!log.data) return false;
            if (log.type === 'BULK_PROMOTION') {
                return log.data.targetRoleId === selectedRoleId || log.data.sourceRoleId === selectedRoleId;
            } else if (log.type === 'PROMOTION_APPLIED' || log.type === 'PROMOTION_ENDED') {
                return log.data.roleId === selectedRoleId || log.data.role?.id === selectedRoleId;
            }

            return log.data.roleId === selectedRoleId;
        }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        const totalRecords = roleRecords.length;

        const roleObj = interaction.guild.roles.cache.get(selectedRoleId);
        if (!roleObj) {
            await interaction.update({
                content: 'لم يتم العثور على الرول!',
                components: []
            });
            return;
        }

        // التحقق من وجود سجلات
        if (totalRecords === 0) {
            const noRecordsEmbed = colorManager.createEmbed()
                .setTitle(`سجلات الترقيات - الرول ${roleObj.name}`)
                .setDescription(
                    `لا توجد سجلات ترقيات لهذا الرول\n\n` +
                    `الرول: <@&${selectedRoleId}>`
                )
                .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
                .setTimestamp();

            const backButton = new ButtonBuilder()
                .setCustomId('promote_records_back')
                .setLabel('العودة')
                .setStyle(ButtonStyle.Primary);

            const backRow = new ActionRowBuilder().addComponents(backButton);

            await interaction.update({
                embeds: [noRecordsEmbed],
                content: '',
                components: [backRow]
            });
            return;
        }

        currentPage = Math.max(0, Math.min(currentPage, totalRecords - 1));

        // إنشاء embed للسجل الحالي باستخدام نفس المنطق المبسط
        const record = roleRecords[currentPage];
        const recordDate = new Date(record.timestamp || Date.now());
        const timestamp = Math.floor(recordDate.getTime() / 1000);

        // البيانات الأساسية
        const moderatorId = record.data?.byUserId || record.data?.moderatorId || 'غير معروف';
        const targetUserId = record.data?.targetUserId || record.data?.userId;
        const duration = record.data?.duration || 'نهائي';
        const reason = record.data?.reason || 'لم يتم تحديد سبب';

        // تحديد نوع السجل ومعالجته
        let descriptionText = '';
        let affectedMembers = '';

        if (record.type === 'MULTI_PROMOTION_GROUP') {
            // Handling multi-promotion group logs correctly
            const rolesCount = record.records.length;
            const roleNames = record.records.map(r => {
                const roleObj = interaction.guild.roles.cache.get(r.data.roleId);
                return roleObj ? roleObj.name : 'رول محذوف';
            });

            const isTemporary = duration !== 'نهائي';

            const embed = colorManager.createEmbed()
                .setTitle(`📋 سجل ترقية - الرول ${role.name}`)
                .setDescription(
                    `**رقم السجل:** ${currentPage + 1} من ${totalRecords}\n\n` +
                    `✅ **تم ترقية العضو** <@${targetUserId}> **لعدة رولات**\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                    `👥 **الإدارة الذين تأثروا:**\n<@${targetUserId}>\n\n` +
                    `🎖️ **الرولات المطبقة:**\n${roleNames.map((name, i) => `${i + 1}. **${name}**`).join('\n')}\n\n` +
                    `📝 **السبب:**\n${reason}\n\n` +
                    `📅 **الوقت:**\n<t:${timestamp}:F>\n\n` +
                    `⏰ **منذ:**\n<t:${timestamp}:R>\n\n` +
                    `👤 **بواسطة:**\n<@${moderatorId}>\n\n` +
                    (isTemporary ? `⏱️ **ترقية مؤقتة** - المدة: ${duration}` : '')
                )
                .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
                .setFooter({ text: `معرف السجل: ${record.transactionId || record.timestamp}` })
                .setTimestamp();

            return embed;
        } else if (record.type === 'BULK_PROMOTION') {
            // ترقية جماعية
            const sourceRoleId = record.data?.sourceRoleId;
            const targetRoleId = record.data?.targetRoleId;
            const sourceRoleObjNav = sourceRoleId ? interaction.guild.roles.cache.get(sourceRoleId) : null;
            const targetRoleObjNav = targetRoleId ? interaction.guild.roles.cache.get(targetRoleId) : null;

            const sourceRoleName = sourceRoleObjNav ? sourceRoleObjNav.name : (record.data?.sourceRoleName || 'رول محذوف');
            const targetRoleName = targetRoleObjNav ? targetRoleObjNav.name : (record.data?.targetRoleName || 'رول محذوف');

            // تحديد إذا كان الرول المحدد هو المصدر أو الهدف
            if (sourceRoleId === selectedRoleId) {
                descriptionText = `✅ **من هذا الرول:** ${sourceRoleName} **إلى الرول:** ${targetRoleName}`;
            } else {
                descriptionText = `✅ **من الرول:** ${sourceRoleName} **إلى هذا الرول:** ${targetRoleName}`;
            }

            // قائمة الأعضاء المتأثرين
            if (record.data?.successfulMembers && record.data.successfulMembers.length > 0) {
                const memberMentions = record.data.successfulMembers.map(m => {
                    // التحقق من البنية المختلفة للبيانات
                    if (typeof m === 'object' && m.id) {
                        return `<@${m.id}>`;
                    } else if (typeof m === 'string') {
                        return `<@${m}>`;
                    } else if (m.user && m.user.id) {
                        return `<@${m.user.id}>`;
                    } else if (m.member && m.member.id) {
                        return `<@${m.member.id}>`;
                    }
                    return null;
                }).filter(Boolean);

                if (memberMentions.length > 0) {
                    if (memberMentions.length <= 10) {
                        affectedMembers = memberMentions.join(' ');
                    } else {
                        affectedMembers = memberMentions.slice(0, 10).join(' ') + `\n**و ${memberMentions.length - 10} عضو آخر**`;
                    }
                } else {
                    affectedMembers = 'خطأ في تحليل بيانات الأعضاء';
                }
            } else if (record.data?.successCount && record.data.successCount > 0) {
                affectedMembers = `تم ترقية ${record.data.successCount} عضو بنجاح`;
            } else {
                affectedMembers = 'لا توجد معلومات';
            }

        } else if (record.type === 'PROMOTION_APPLIED') {
            // ترقية فردية
            const previousRoleName = record.data?.previousRole?.name || 'بدون رول سابق';
            const currentRoleId = record.data?.roleId;
            const currentRoleObjNav = currentRoleId ? interaction.guild.roles.cache.get(currentRoleId) : null;
            const currentRoleName = currentRoleObjNav ? currentRoleObjNav.name : 'رول محذوف';

            descriptionText = `✅ **من الرول:** ${previousRoleName} **إلى الرول:** ${currentRoleName}`;
            affectedMembers = `<@${targetUserId}>`;

        } else if (record.type === 'PROMOTION_ENDED') {
            // انتهاء ترقية
            const roleIdRecord = record.data?.roleId;
            const roleObjNav = roleIdRecord ? interaction.guild.roles.cache.get(roleIdRecord) : null;
            const roleName = roleObjNav ? roleObjNav.name : 'رول محذوف';

            descriptionText = `⏱️ **انتهت مدة الترقية للرول:** ${roleName}`;
            affectedMembers = `<@${targetUserId}>`;
        } else {
            descriptionText = `ℹ️ **سجل غير معروف**`;
            affectedMembers = targetUserId ? `<@${targetUserId}>` : 'غير محدد';
        }

        const isTemporary = duration !== 'نهائي';

        const embed = colorManager.createEmbed()
            .setTitle(`📋 سجل ترقية - الرول ${role.name}`)
            .setDescription(
                `**رقم السجل:** ${currentPage + 1} من ${totalRecords}\n\n` +
                `${descriptionText}\n\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `👥 **الإدارة الذين تأثروا:**\n${affectedMembers}\n\n` +
                `📝 **السبب:**\n${reason}\n\n` +
                `📅 **الوقت:**\n<t:${timestamp}:F>\n\n` +
                `⏰ **منذ:**\n<t:${timestamp}:R>\n\n` +
                `👤 **بواسطة:**\n<@${moderatorId}>\n\n` +
                (isTemporary ? `⏱️ **ترقية مؤقتة** - المدة: ${duration}` : '')
            )
            .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
            .setFooter({ text: `معرف السجل: ${record.timestamp || 'غير محدد'}` })
            .setTimestamp();

        // أزرار التنقل والإدارة
        const components = [];

        // صف التنقل
        const navigationRow = new ActionRowBuilder();

        const prevButton = new ButtonBuilder()
            .setCustomId(`role_record_prev_${selectedRoleId}_${currentPage}`)
            .setLabel('السابق')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage === 0);

        const pageButton = new ButtonBuilder()
            .setCustomId(`role_record_page`)
            .setLabel(`${currentPage + 1} / ${totalRecords}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true);

        const nextButton = new ButtonBuilder()
            .setCustomId(`role_record_next_${selectedRoleId}_${currentPage}`)
            .setLabel('التالي')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(currentPage === totalRecords - 1);

        navigationRow.addComponents(prevButton, pageButton, nextButton);
        components.push(navigationRow);

        // صف إدارة السجلات
        const manageRow = new ActionRowBuilder();

        const deleteRecordButton = new ButtonBuilder()
            .setCustomId(`delete_record_${selectedRoleId}_${currentPage}`)
            .setLabel('حذف هذا السجل')
            .setStyle(ButtonStyle.Danger);

        const deleteAllButton = new ButtonBuilder()
            .setCustomId(`delete_all_records_${selectedRoleId}`)
            .setLabel('حذف جميع السجلات')
            .setStyle(ButtonStyle.Danger);

        const backButton = new ButtonBuilder()
            .setCustomId('promote_records_back')
            .setLabel('العودة')
            .setStyle(ButtonStyle.Primary);

        manageRow.addComponents(deleteRecordButton, deleteAllButton, backButton);
        components.push(manageRow);

        await interaction.update({
            embeds: [embed],
            content: '',
            components: components
        });
        return;
    }

    // Handle back to roles list button
    if (interaction.isButton() && customId === 'promote_records_back') {
        // إعادة توجيه إلى قائمة الرولات
        const adminRolesPath = path.join(__dirname, '..', 'data', 'adminRoles.json');
        const adminRoles = readJson(adminRolesPath, []);

        if (adminRoles.length === 0) {
            await interaction.update({
                content: 'لا توجد رولات إدارية محددة!',
                components: []
            });
            return;
        }

        const availableRoles = adminRoles.map(roleId => {
            const role = interaction.guild.roles.cache.get(roleId);
            return role ? {
                label: role.name,
                value: roleId,
                description: `عرض سجلات ترقيات ${role.name}`
            } : null;
        }).filter(Boolean).slice(0, 25);

        const roleSelect = new StringSelectMenuBuilder()
            .setCustomId('promote_records_select_role')
            .setPlaceholder('اختر الرول لعرض سجلات ترقياته...')
            .addOptions(availableRoles);

        const roleRow = new ActionRowBuilder().addComponents(roleSelect);

        await interaction.update({
            content: 'اختر الرول لعرض سجلات ترقياته:',
            components: [roleRow]
        });
        return;
    }

    // معالج مودال حظر الترقيات
    if (interaction.isModalSubmit() && customId.startsWith('promote_ban_modal_')) {
        try {
            const userId = customId.split('_')[3];
            let duration = interaction.fields.getTextInputValue('ban_duration').trim();
            const reason = interaction.fields.getTextInputValue('ban_reason').trim();

            // Normalize duration input
            if (!duration || duration === '') {
                duration = 'نهائي';
            }

            const result = await promoteManager.addPromotionBan(
                interaction.guild,
                context.client,
                userId,
                duration,
                reason,
                interaction.user.id
            );

            if (result.success) {
                const member = await interaction.guild.members.fetch(userId).catch(() => null);
                const displayName = member ? member.displayName : `User ${userId}`;

                let banEndText;
                if (result.endTime && !isNaN(result.endTime) && result.endTime > 0) {
                    banEndText = `<t:${Math.floor(result.endTime / 1000)}:R>`;
                } else {
                    banEndText = 'نهائي';
                }

                await interaction.reply({
                    content: ` **تم حظر العضو** ${displayName} **من الترقيات بنجاح.**\n**المدة:** ${duration}\n**ينتهي:** ${banEndText}\n**السبب:** ${reason}`,
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.reply({
                    content: ` **فشل في حظر العضو:** ${result.error}`,
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (error) {
            console.error('خطأ في معالجة حظر العضو:', error);
            await interaction.reply({
                content: '❌ **حدث خطأ أثناء معالجة الحظر!**',
                flags: MessageFlags.Ephemeral
            }).catch(console.error);
        }
        return;
    }

    // معالجات سجلات المستخدم مع pagination
    if (interaction.isUserSelectMenu() && customId === 'promote_records_select_user') {
        const selectedUserId = interaction.values[0];
        const records = await promoteManager.getUserPromotionRecords(selectedUserId, interaction.guild.id);

        if (records.length === 0) {
            await interaction.update({
                content: 'العضو <@${selectedUserId}> ليس لديه سجلات ترقيات.',
                embeds: [],
                components: []
            });
            return;
        }

        await displayUserRecord(interaction, selectedUserId, 0, records);
        return;
    }

    // أزرار التنقل لسجلات المستخدم
    if (interaction.isButton() && customId.startsWith('promote_user_record_prev_')) {
        const parts = customId.split('_');
        const userId = parts[4];
        const currentPage = parseInt(parts[5]);
        const records = await promoteManager.getUserPromotionRecords(userId, interaction.guild.id);
        await displayUserRecord(interaction, userId, currentPage - 1, records);
        return;
    }

    if (interaction.isButton() && customId.startsWith('promote_user_record_next_')) {
        const parts = customId.split('_');
        const userId = parts[4];
        const currentPage = parseInt(parts[5]);
        const records = await promoteManager.getUserPromotionRecords(userId, interaction.guild.id);
        await displayUserRecord(interaction, userId, currentPage + 1, records);
        return;
    }

    // حذف سجل واحد للمستخدم
    if (interaction.isButton() && customId.startsWith('promote_delete_user_record_')) {
        const parts = customId.split('_');
        const userId = parts[4];
        const recordIndex = parseInt(parts[5]);
        await handleDeleteUserRecord(interaction, userId, recordIndex);
        return;
    }

    // حذف جميع سجلات المستخدم
    if (interaction.isButton() && customId.startsWith('promote_delete_all_user_records_')) {
        const userId = customId.split('_')[5];

        const confirmEmbed = colorManager.createEmbed()
            .setTitle('تأكيد حذف جميع السجلات')
            .setDescription(`هل أنت متأكد من حذف جميع سجلات <@${userId}>؟\n\n**تحذير:** هذا الإجراء لا يمكن التراجع عنه!`)
            .setTimestamp();

        const confirmButton = new ButtonBuilder()
            .setCustomId(`promote_confirm_delete_all_user_${userId}`)
            .setLabel('تأكيد الحذف')
            .setStyle(ButtonStyle.Danger);

        const cancelButton = new ButtonBuilder()
            .setCustomId(`promote_cancel_delete_user`)
            .setLabel('إلغاء')
            .setStyle(ButtonStyle.Secondary);

        const buttonRow = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

        await interaction.update({
            embeds: [confirmEmbed],
            components: [buttonRow]
        });
        return;
    }

    if (interaction.isButton() && customId.startsWith('promote_confirm_delete_all_user_')) {
        const userId = customId.split('_')[5];
        await handleDeleteAllUserRecords(interaction, userId);
        return;
    }

    if (interaction.isButton() && customId === 'promote_cancel_delete_user') {
        await interaction.update({
            content: 'تم إلغاء عملية الحذف',
            embeds: [],
            components: []
        });
        return;
    }

    if (interaction.isButton() && customId === 'promote_user_records_back') {
        const userSelect = new UserSelectMenuBuilder()
            .setCustomId('promote_records_select_user')
            .setPlaceholder('اختر المستخدم لعرض سجلاته...')
            .setMaxValues(1);

        const userRow = new ActionRowBuilder().addComponents(userSelect);

        await interaction.update({
            content: 'اختر المستخدم لعرض سجلات ترقياته:',
            components: [userRow]
        });
        return;
    }
}

async function getActivityRating(userStats, context) {
    try {
        // الحصول على إحصائيات جميع الأعضاء للمقارنة
        const guildAverages = await calculateGuildAverages(context);

        if (!guildAverages) {
            // في حالة عدم توفر البيانات، استخدام نظام النسب المرن
            return getFlexibleRating(userStats);
        }

        // حساب النسب المئوية مقارنة بالمتوسط
        const voicePercentage = guildAverages.avgVoiceTime > 0 ? 
            (userStats.totalVoiceTime / guildAverages.avgVoiceTime) * 100 : 0;

        const messagesPercentage = guildAverages.avgMessages > 0 ? 
            (userStats.totalMessages / guildAverages.avgMessages) * 100 : 0;

        const reactionsPercentage = guildAverages.avgReactions > 0 ? 
            (userStats.totalReactions / guildAverages.avgReactions) * 100 : 0;

        const activeDaysPercentage = guildAverages.avgActiveDays > 0 ? 
            (userStats.activeDays / guildAverages.avgActiveDays) * 100 : 0;

        // حساب المتوسط الإجمالي للنسب
        const overallPercentage = (voicePercentage + messagesPercentage + reactionsPercentage + activeDaysPercentage) / 4;

        // تحديد التقييم بناءً على النسبة المئوية مقارنة بالمتوسط
        let rating, emoji, description;

        if (overallPercentage >= 150) {
            rating = '🌟 **ممتاز جداً**';
            emoji = '🌟';
            description = `أداء استثنائي (${Math.round(overallPercentage)}% من المتوسط)`;
        } else if (overallPercentage >= 120) {
            rating = '⭐ **ممتاز**';
            emoji = '⭐';
            description = `أداء ممتاز (${Math.round(overallPercentage)}% من المتوسط)`;
        } else if (overallPercentage >= 90) {
            rating = '✅ **جيد جداً**';
            emoji = '✅';
            description = `أداء جيد جداً (${Math.round(overallPercentage)}% من المتوسط)`;
        } else if (overallPercentage >= 70) {
            rating = '🟡 **جيد**';
            emoji = '🟡';
            description = `أداء جيد (${Math.round(overallPercentage)}% من المتوسط)`;
        } else if (overallPercentage >= 50) {
            rating = '🔸 **متوسط**';
            emoji = '🔸';
            description = `أداء متوسط (${Math.round(overallPercentage)}% من المتوسط)`;
        } else if (overallPercentage >= 30) {
            rating = '⚠️ **ضعيف**';
            emoji = '⚠️';
            description = `أداء ضعيف (${Math.round(overallPercentage)}% من المتوسط)`;
        } else {
            rating = '❌ **ضعيف جداً**';
            emoji = '❌';
            description = `أداء ضعيف جداً (${Math.round(overallPercentage)}% من المتوسط)`;
        }

        return {
            rating,
            emoji,
            description,
            percentage: Math.round(overallPercentage),
            details: {
                voice: Math.round(voicePercentage),
                messages: Math.round(messagesPercentage),
                reactions: Math.round(reactionsPercentage),
                activeDays: Math.round(activeDaysPercentage)
            },
            averages: guildAverages
        };

    } catch (error) {
        console.error('خطأ في حساب تقييم النشاط:', error);
        return getFlexibleRating(userStats);
    }
}

// حساب متوسطات السيرفر
async function calculateGuildAverages(context) {
    try {
        const database = context.database;
        if (!database) {
            console.log('قاعدة البيانات غير متاحة لحساب المتوسطات');
            return null;
        }

        // حساب متوسطات النشاط من قاعدة البيانات
        const averages = await database.get(`
            SELECT 
                AVG(total_voice_time) as avgVoiceTime,
                AVG(total_messages) as avgMessages,
                AVG(total_reactions) as avgReactions,
                COUNT(*) as totalUsers
            FROM user_totals 
            WHERE total_messages > 0 OR total_voice_time > 0
        `);

        if (!averages || averages.totalUsers === 0) {
            return null;
        }

        // حساب متوسط الأيام النشطة (تقدير معقول)
        const avgActiveDays = Math.max(7, averages.totalUsers > 50 ? 14 : 10);

        return {
            avgVoiceTime: averages.avgVoiceTime || 0,
            avgMessages: averages.avgMessages || 0,
            avgReactions: averages.avgReactions || 0,
            avgActiveDays: avgActiveDays,
            totalUsers: averages.totalUsers,
            lastUpdated: Date.now()
        };

    } catch (error) {
        console.error('خطأ في حساب متوسطات السيرفر:', error);
        return null;
    }
}

// نظام التقييم المرن (في حالة عدم توفر بيانات المقارنة)
function getFlexibleRating(userStats) {
    // حساب نقاط مرنة بناءً على النشاط العام
    let score = 0;

    // نقاط الوقت الصوتي (0-30 نقطة)
    const voiceHours = userStats.totalVoiceTime / 3600000; // تحويل من milliseconds إلى ساعات
    if (voiceHours >= 50) score += 30;
    else if (voiceHours >= 25) score += 25;
    else if (voiceHours >= 10) score += 20;
    else if (voiceHours >= 5) score += 15;
    else if (voiceHours >= 1) score += 10;

    // نقاط الرسائل (0-25 نقطة)
    if (userStats.totalMessages >= 500) score += 25;
    else if (userStats.totalMessages >= 250) score += 20;
    else if (userStats.totalMessages >= 100) score += 15;
    else if (userStats.totalMessages >= 50) score += 10;
    else if (userStats.totalMessages >= 10) score += 5;

    // نقاط التفاعلات (0-20 نقطة)
    if (userStats.totalReactions >= 100) score += 20;
    else if (userStats.totalReactions >= 50) score += 15;
    else if (userStats.totalReactions >= 25) score += 10;
    else if (userStats.totalReactions >= 10) score += 5;

    // نقاط الأيام النشطة (0-25 نقطة)
    if (userStats.activeDays >= 20) score += 25;
    else if (userStats.activeDays >= 15) score += 20;
    else if (userStats.activeDays >= 10) score += 15;
    else if (userStats.activeDays >= 7) score += 10;
    else if (userStats.activeDays >= 3) score += 5;

    // تحديد التقييم بناءً على النقاط
    let rating, emoji, description;

    if (score >= 80) {
        rating = '🌟 **ممتاز**';
        emoji = '🌟';
        description = `نشاط ممتاز (${score}/100 نقطة)`;
    } else if (score >= 65) {
        rating = '⭐ **جيد جداً**';
        emoji = '⭐';
        description = `نشاط جيد جداً (${score}/100 نقطة)`;
    } else if (score >= 50) {
        rating = '✅ **جيد**';
        emoji = '✅';
        description = `نشاط جيد (${score}/100 نقطة)`;
    } else if (score >= 35) {
        rating = '🟡 **متوسط**';
        emoji = '🟡';
        description = `نشاط متوسط (${score}/100 نقطة)`;
    } else if (score >= 20) {
        rating = '⚠️ **ضعيف**';
        emoji = '⚠️';
        description = `نشاط ضعيف (${score}/100 نقطة)`;
    } else {
        rating = '❌ **ضعيف جداً**';
        emoji = '❌';
        description = `نشاط ضعيف جداً (${score}/100 نقطة)`;
    }

    return {
        rating,
        emoji,
        description,
        score,
        details: {
            voice: Math.round(voiceHours * 10) / 10,
            messages: userStats.totalMessages,
            reactions: userStats.totalReactions,
            activeDays: userStats.activeDays
        },
        method: 'flexible'
    };
}

async function handleEditSettings(interaction, context) {
    const settingsPath = path.join(__dirname, '..', 'data', 'promoteSettings.json');
    const settings = readJson(settingsPath, {});

    const editEmbed = colorManager.createEmbed()
        .setTitle('Edit System Settings')
        .setDescription('اختر الإعداد الذي تريد تعديله')
        .addFields([
            { name: ' المعتمدين الحاليين', value: settings.allowedUsers?.type ? `${getPermissionTypeText(settings.allowedUsers.type)} (${settings.allowedUsers.targets?.length || 0})` : 'غير محدد', inline: true },
            { name: ' روم السجلات', value: settings.logChannel ? `<#${settings.logChannel}>` : 'غير محدد', inline: true },
            { name: ' روم المنيو', value: settings.menuChannel ? `<#${settings.menuChannel}>` : 'غير محدد', inline: true }
        ]);

    const editSelect = new StringSelectMenuBuilder()
        .setCustomId('promote_edit_settings_menu')
        .setPlaceholder('اختر الإعداد للتعديل...')
        .addOptions([
            {
                label: 'تعديل المعتمدين',
                value: 'edit_permissions',
                description: 'تغيير من يحق له استخدام النظام'
            },
            {
                label: 'تعديل روم السجلات',
                value: 'edit_log_channel',
                description: 'تغيير قناة حفظ سجلات الترقيات'
            },
            {
                label: 'تعديل روم المنيو',
                value: 'edit_menu_channel',
                description: 'تغيير قناة المنيو التفاعلي'
            }
        ]);

    const editRow = new ActionRowBuilder().addComponents(editSelect);

    await interaction.update({
        embeds: [editEmbed],
        components: [editRow]
    });
}

async function handleEditPermissions(interaction, context) {
    const permissionSelect = new StringSelectMenuBuilder()
        .setCustomId('promote_edit_permission_type')
        .setPlaceholder(' اختر نوع المعتمدين الجديد...')
        .addOptions([
            {
                label: 'المالكين فقط',
                value: 'owners',
                description: 'السماح للمالكين فقط باستخدام النظام'
            },
            {
                label: 'رولات محددة',
                value: 'roles',
                description: 'السماح لحاملي رولات معينة'
            },
            {
                label: 'مسؤوليات محددة',
                value: 'responsibility',
                description: 'السماح للمسؤولين عن مسؤوليات معينة'
            }
        ]);

    const permissionRow = new ActionRowBuilder().addComponents(permissionSelect);

    await interaction.update({
        content: ' **اختر نوع المعتمدين الجديد:**',
        components: [permissionRow]
    });
}

async function handleEditLogChannel(interaction, context) {
    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('promote_edit_log_channel_select')
        .setPlaceholder(' اختر روم السجلات الجديدة...')
        .setChannelTypes([ChannelType.GuildText]);

    const channelRow = new ActionRowBuilder().addComponents(channelSelect);

    await interaction.update({
        content: ' **اختر روم السجلات الجديدة:**',
        components: [channelRow]
    });
}

async function handleEditMenuChannel(interaction, context) {
    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId('promote_edit_menu_channel_select')
        .setPlaceholder(' اختر روم المنيو الجديدة...')
        .setChannelTypes([ChannelType.GuildText]);

    const channelRow = new ActionRowBuilder().addComponents(channelSelect);

    await interaction.update({
        content: ' **اختر روم المنيو الجديدة:**',
        components: [channelRow]
    });
}

async function createSystemStats() {
    const stats = promoteManager.getSystemStats();
    const activePromotes = promoteManager.getActivePromotes();
    const totalPromotes = Object.keys(activePromotes).length;
    const bans = promoteManager.getPromotionBans();
    const totalBans = Object.keys(bans).length;

    const embed = colorManager.createEmbed()
        .setTitle('📊 **إحصائيات نظام الترقيات**')
        .setDescription('ملخص شامل لحالة النظام')
        .addFields([
            { name: '🎖️ **الترقيات النشطة**', value: `${totalPromotes}`, inline: true },
            { name: '🚫 **المحظورين**', value: `${totalBans}`, inline: true },
            { name: '📈 **إجمالي الترقيات**', value: `${stats?.totalPromotions || 0}`, inline: true },
            { name: '⏰ **النظام يعمل منذ**', value: `<t:${Math.floor((stats?.systemStartTime || Date.now()) / 1000)}:R>`, inline: false }
        ])
        .setTimestamp();

    return embed;
}

async function handleDetailedStats(interaction, context) {
    const statsEmbed = await createSystemStats();
    await interaction.update({
        embeds: [statsEmbed],
        components: []
    });
}

async function handleResetSystem(interaction, context) {
    const confirmEmbed = colorManager.createEmbed()
        .setTitle('Reset Confirmation')
        .setDescription('هل أنت متأكد من أنك تريد إعادة تعيين جميع إعدادات النظام؟')
        .addFields([
            { name: '🔄 سيتم حذف:', value: '• جميع الإعدادات\n• الترقيات النشطة\n• السجلات', inline: false },
            { name: '⚠️ تحذير:', value: 'هذا الإجراء لا يمكن التراجع عنه!', inline: false }
        ]);

    const confirmButton = new ButtonBuilder()
        .setCustomId('promote_confirm_reset')
        .setLabel(' تأكيد الإعادة')
        .setStyle(ButtonStyle.Danger);

    const cancelButton = new ButtonBuilder()
        .setCustomId('promote_cancel_reset')
        .setLabel(' إلغاء')
        .setStyle(ButtonStyle.Secondary);

    const buttonRow = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

    await interaction.update({
        embeds: [confirmEmbed],
        components: [buttonRow]
    });
}

// معالجات حذف السجلات
async function handleDeleteSingleRecord(interaction, roleId, recordIndex) {
    try {
        // التحقق من صحة التفاعل أولاً
        if (interaction.replied || interaction.deferred) {
            console.log('التفاعل تم الرد عليه مسبقاً');
            return;
        }

        const promoteLogsPath = path.join(__dirname, '..', 'data', 'promoteLogs.json');
        const promoteLogs = readJson(promoteLogsPath, []);

        // Filter records for the specific role
        let roleRecords = promoteLogs.filter(log => {
            if (!log.data) return false;

            if (log.type === 'BULK_PROMOTION') {
                return log.data.targetRoleId === roleId || log.data.sourceRoleId === roleId;
            } else if (log.type === 'PROMOTION_APPLIED' || log.type === 'PROMOTION_ENDED') {
                return log.data.roleId === roleId || log.data.role?.id === roleId;
            } else if (log.type === 'MULTI_PROMOTION_APPLIED') {
                return log.data.roleIds && log.data.roleIds.includes(roleId);
            }

            return log.data.roleId === roleId;
        });

        if (recordIndex >= roleRecords.length) {
            await interaction.update({
                content: 'السجل المحدد غير موجود!',
                embeds: [],
                components: []
            });
            return;
        }

        const recordToDelete = roleRecords[recordIndex];

        // Find and remove the record from the main logs array
        const mainIndex = promoteLogs.findIndex(log => 
            log.timestamp === recordToDelete.timestamp && 
            log.type === recordToDelete.type &&
            JSON.stringify(log.data) === JSON.stringify(recordToDelete.data)
        );

        if (mainIndex !== -1) {
            promoteLogs.splice(mainIndex, 1);
            saveJson(promoteLogsPath, promoteLogs);
        }

        // تحديث القائمة بعد الحذف
        roleRecords = promoteLogs.filter(log => {
            if (!log.data) return false;

            if (log.type === 'BULK_PROMOTION') {
                return log.data.targetRoleId === roleId || log.data.sourceRoleId === roleId;
            } else if (log.type === 'PROMOTION_APPLIED' || log.type === 'PROMOTION_ENDED') {
                return log.data.roleId === roleId || log.data.role?.id === roleId;
            } else if (log.type === 'MULTI_PROMOTION_APPLIED') {
                return log.data.roleIds && log.data.roleIds.includes(roleId);
            }

            return log.data.roleId === roleId;
        });

        const successEmbed = colorManager.createEmbed()
            .setTitle('✅ تم حذف السجل')
            .setDescription('تم حذف السجل بنجاح من قاعدة البيانات')
            .addFields([
                { name: 'السجلات المتبقية', value: roleRecords.length.toString(), inline: true },
                { name: 'تم الحذف', value: 'نعم', inline: true }
            ])
            .setTimestamp();

        if (roleRecords.length === 0) {
            await interaction.update({
                embeds: [successEmbed],
                content: `✅ تم حذف السجل. لا توجد المزيد من السجلات للرول <@&${roleId}>`,
                components: []
            });
        } else {
            // العودة لقائمة السجلات
            const backButton = new ButtonBuilder()
                .setCustomId('promote_records_back')
                .setLabel('عودة لقائمة الرولات')
                .setStyle(ButtonStyle.Primary);

            const backRow = new ActionRowBuilder().addComponents(backButton);

            await interaction.update({
                embeds: [successEmbed],
                content: `✅ تم حذف السجل. المتبقي ${roleRecords.length} سجل للرول <@&${roleId}>`,
                components: [backRow]
            });
        }

    } catch (error) {
        console.error('خطأ في حذف السجل:', error);

        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ حدث خطأ أثناء حذف السجل.',
                    flags: MessageFlags.Ephemeral
                });
            } else {
                await interaction.followUp({
                    content: '❌ حدث خطأ أثناء حذف السجل.',
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (replyError) {
            console.error('خطأ في الرد على خطأ حذف السجل:', replyError);
        }
    }
}

async function handleDeleteAllRecords(interaction, roleId) {
    try {
        const promoteLogsPath = path.join(__dirname, '..', 'data', 'promoteLogs.json');
        const promoteLogs = readJson(promoteLogsPath, []);

        // حذف جميع السجلات للرول المحدد
        const updatedLogs = promoteLogs.filter(log => {
            if (!log.data) return true;
            if (log.type === 'BULK_PROMOTION') {
                return !(log.data.targetRoleId === roleId || log.data.sourceRoleId === roleId);
            } else if (log.type === 'PROMOTION_APPLIED' || log.type === 'PROMOTION_ENDED') {
                return !(log.data.roleId === roleId || log.data.role?.id === roleId);
            }
            return log.data.roleId !== roleId;
        });

        const deletedCount = promoteLogs.length - updatedLogs.length;
        saveJson(promoteLogsPath, updatedLogs);

        const successEmbed = colorManager.createEmbed()
            .setTitle('تم حذف جميع السجلات')
            .setDescription(
                `تم حذف جميع سجلات الرول بنجاح\n\n` +
                `الرول: <@&${roleId}>\n` +
                `عدد السجلات المحذوفة: ${deletedCount}\n` +
                `تم الحذف بواسطة: <@${interaction.user.id}>`
            )
            .setTimestamp();

        await interaction.reply({
            embeds: [successEmbed],
            flags: MessageFlags.Ephemeral
        });

        // تحديث الرسالة الأصلية
        await interaction.message.edit({
            content: `تم حذف جميع السجلات للرول <@&${roleId}>`,
            embeds: [],
            components: []
        });

    } catch (error) {
        console.error('خطأ في حذف جميع السجلات:', error);
        await interaction.reply({
            content: 'حدث خطأ أثناء حذف السجلات!',
            flags: MessageFlags.Ephemeral
        });
    }
}

async function displayUserRecord(interaction, userId, currentPage, records) {
    const totalRecords = records.length;
    currentPage = Math.max(0, Math.min(currentPage, totalRecords - 1));
    const record = records[currentPage];

    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    const memberName = member ? member.displayName : 'العضو';

    const recordDate = new Date(record.timestamp || Date.now());
    const timestamp = Math.floor(recordDate.getTime() / 1000);
    const duration = record.data?.duration || record.duration || 'نهائي';
    const reason = record.data?.reason || record.reason || 'لم يتم تحديد سبب';
    const moderatorId = record.data?.byUserId || record.data?.moderatorId || 'غير معروف';

    let actionType = '';
    let rolesInfo = '';

    if (record.type === 'BULK_PROMOTION') {
        actionType = '👥 ترقية جماعية';
        const sourceRoleId = record.data?.sourceRoleId;
        const targetRoleId = record.data?.targetRoleId;
        const sourceRoleObj = sourceRoleId ? interaction.guild.roles.cache.get(sourceRoleId) : null;
        const targetRoleObj = targetRoleId ? interaction.guild.roles.cache.get(targetRoleId) : null;

        const sourceRole = sourceRoleObj ? sourceRoleObj.name : (record.data?.sourceRoleName || 'رول غير معروف');
        const targetRole = targetRoleObj ? targetRoleObj.name : (record.data?.targetRoleName || record.roleName || 'رول غير معروف');

        if (sourceRole && targetRole) {
            rolesInfo = `**من:**\n🔽 ${sourceRole}\n\n**إلى:**\n🔼 ${targetRole}`;
        } else if (targetRole) {
            rolesInfo = `**الرول المضاف:**\n🔼 ${targetRole}`;
        } else {
            rolesInfo = '⚠️ **معلومات الرولات غير متوفرة**';
        }
    } else if (record.type === 'PROMOTION_APPLIED') {
        const isBulk = record.data?.isBulkOperation === true;
        actionType = isBulk ? '👥 ترقية جماعية' : '⬆️ ترقية فردية';

        let addedRolesList = [];
        let removedRolesList = [];

        // جمع الرولات المضافة
        if (record.data?.addedRoles && record.data.addedRoles.length > 0) {
            addedRolesList = record.data.addedRoles.map(r => {
                if (typeof r === 'object' && r.name) return r.name;
                if (typeof r === 'string') {
                    const roleObj = interaction.guild.roles.cache.get(r);
                    return roleObj ? roleObj.name : r;
                }
                return 'رول غير معروف';
            });
        } else if (record.data?.roleId) {
            // ترقية فردية عادية
            const roleObj = interaction.guild.roles.cache.get(record.data.roleId);
            const roleName = roleObj ? roleObj.name : (record.roleName || 'رول محذوف');
            addedRolesList = [roleName];
        }

        // جمع الرولات المزالة
        if (record.data?.removedRoles && record.data.removedRoles.length > 0) {
            removedRolesList = record.data.removedRoles.map(r => {
                if (typeof r === 'object' && r.name) return r.name;
                if (typeof r === 'string') {
                    const roleObj = interaction.guild.roles.cache.get(r);
                    return roleObj ? roleObj.name : r;
                }
                return 'رول غير معروف';
            });
        } else if (record.data?.previousRole) {
            // الرول السابق الذي تم إزالته
            const previousRoleName = record.data.previousRole.name || 'بدون رول سابق';
            if (previousRoleName !== 'بدون رول سابق' && previousRoleName !== 'لا يوجد رول') {
                removedRolesList = [previousRoleName];
            }
        }

        // بناء النص بتنسيق "من ... إلى ..." للترقيات الجماعية
        if (isBulk && removedRolesList.length > 0 && addedRolesList.length > 0) {
            rolesInfo = `**من:**\n🔽 ${removedRolesList[0]}\n\n**إلى:**\n🔼 ${addedRolesList[0]}`;
        } else {
            // التنسيق العادي للترقيات الفردية
            if (removedRolesList.length > 0) {
                rolesInfo = `🔽 **الرولات المزالة:**\n${removedRolesList.map(r => `▫️ ${r}`).join('\n')}`;
            }

            if (addedRolesList.length > 0) {
                if (rolesInfo) rolesInfo += '\n\n';
                rolesInfo += `🔼 **الرولات المضافة:**\n${addedRolesList.map(r => `▫️ ${r}`).join('\n')}`;
            }
        }

        if (!rolesInfo) {
            rolesInfo = '⚠️ **لا توجد تفاصيل متاحة عن الرولات**';
        }
    } else if (record.type === 'MULTI_PROMOTION_APPLIED') {
        actionType = '🎯 ترقية متعددة';

        let addedRolesList = [];
        let removedRolesList = [];

        // جمع الرولات المضافة
        if (record.data?.roleIds && record.data.roleIds.length > 0) {
            addedRolesList = record.data.roleIds.map(roleId => {
                const roleObj = interaction.guild.roles.cache.get(roleId);
                return roleObj ? roleObj.name : 'رول محذوف';
            });
        } else if (record.data?.roles && record.data.roles.length > 0) {
            addedRolesList = record.data.roles.map(r => r.name || 'رول غير معروف');
        } else if (record.data?.addedRoles && record.data.addedRoles.length > 0) {
            addedRolesList = record.data.addedRoles.map(r => {
                if (typeof r === 'object' && r.name) return r.name;
                if (typeof r === 'string') {
                    const roleObj = interaction.guild.roles.cache.get(r);
                    return roleObj ? roleObj.name : r;
                }
                return 'رول غير معروف';
            });
        }

        // جمع الرولات المزالة
        if (record.data?.removedRoles && record.data.removedRoles.length > 0) {
            removedRolesList = record.data.removedRoles.map(r => {
                if (typeof r === 'object' && r.name) return r.name;
                if (typeof r === 'string') {
                    const roleObj = interaction.guild.roles.cache.get(r);
                    return roleObj ? roleObj.name : r;
                }
                return 'رول غير معروف';
            });
        }

        // بناء النص
        if (removedRolesList.length > 0) {
            rolesInfo = `🔽 **الرولات المزالة:**\n${removedRolesList.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
        }

        if (addedRolesList.length > 0) {
            if (rolesInfo) rolesInfo += '\n\n';
            rolesInfo += `🔼 **الرولات المضافة:**\n${addedRolesList.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
        }

        if (!rolesInfo) {
            rolesInfo = '⚠️ **لا توجد معلومات عن الرولات**';
        }
    } else if (record.type === 'PROMOTION_ENDED') {
        actionType = '⏰ انتهاء ترقية';
        const endedRoleId = record.data?.roleId;
        const endedRoleObj = endedRoleId ? interaction.guild.roles.cache.get(endedRoleId) : null;
        const endedRole = endedRoleObj ? endedRoleObj.name : (record.roleName || 'رول محذوف');
        rolesInfo = `🔽 **الرول الذي انتهت مدته:**\n▫️ ${endedRole}`;
    } else {
        actionType = '❓ نوع غير معروف';
        rolesInfo = '⚠️ **لا توجد معلومات متاحة**';
    }

    let statusInfo = '';
    if (record.type === 'PROMOTION_APPLIED' && duration !== 'نهائي') {
        const endTime = record.data?.endTime;
        if (endTime) {
            const isExpired = Date.now() > endTime;
            statusInfo = isExpired ? '\n🔴 **الحالة:** منتهية' : '\n🟢 **الحالة:** نشطة';
        }
    }

    const embed = colorManager.createEmbed()
        .setTitle(`📋 سجل ترقية - ${memberName}`)
        .setDescription(
            `**رقم السجل:** ${currentPage + 1} من ${totalRecords}\n\n` +
            `${actionType}\n\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `📝 **تفاصيل الرولات:**\n${rolesInfo}\n\n` +
            `💬 **السبب:**\n${reason}\n\n` +
            `⏱️ **المدة:** ${duration}\n\n` +
            `📅 **التاريخ:** <t:${timestamp}:F>\n` +
            `⏰ **منذ:** <t:${timestamp}:R>\n\n` +
            `👤 **بواسطة:** <@${moderatorId}>` +
            statusInfo
        )
        .setThumbnail(member?.displayAvatarURL({ dynamic: true }) || interaction.guild.iconURL({ dynamic: true }))
        .setFooter({ text: `معرف السجل: ${record.timestamp}` })
        .setTimestamp();

    const navigationRow = new ActionRowBuilder();

    const prevButton = new ButtonBuilder()
        .setCustomId(`promote_user_record_prev_${userId}_${currentPage}`)
        .setLabel('السابق')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0);

    const pageButton = new ButtonBuilder()
        .setCustomId(`promote_user_record_page`)
        .setLabel(`${currentPage + 1} / ${totalRecords}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true);

    const nextButton = new ButtonBuilder()
        .setCustomId(`promote_user_record_next_${userId}_${currentPage}`)
        .setLabel('التالي')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === totalRecords - 1);

    navigationRow.addComponents(prevButton, pageButton, nextButton);

    const manageRow = new ActionRowBuilder();

    const deleteRecordButton = new ButtonBuilder()
        .setCustomId(`promote_delete_user_record_${userId}_${currentPage}`)
        .setLabel('حذف هذا السجل')
        .setStyle(ButtonStyle.Danger);

    const deleteAllButton = new ButtonBuilder()
        .setCustomId(`promote_delete_all_user_records_${userId}`)
        .setLabel('حذف جميع السجلات')
        .setStyle(ButtonStyle.Danger);

    const backButton = new ButtonBuilder()
        .setCustomId('promote_user_records_back')
        .setLabel('العودة')
        .setStyle(ButtonStyle.Primary);

    manageRow.addComponents(deleteRecordButton, deleteAllButton, backButton);

    const updateMethod = interaction.replied || interaction.deferred ? 'editReply' : 'update';
    await interaction[updateMethod]({
        embeds: [embed],
        components: [navigationRow, manageRow]
    });
}

async function handleDeleteUserRecord(interaction, userId, recordIndex) {
    try {
        const promoteLogsPath = path.join(__dirname, '..', 'data', 'promoteLogs.json');
        const promoteLogs = readJson(promoteLogsPath, []);

        const userRecords = promoteLogs.filter(log => {
            const targetUserId = log.data?.targetUserId || log.data?.userId;
            return targetUserId === userId;
        });

        if (recordIndex >= userRecords.length) {
            await interaction.update({
                content: 'السجل المحدد غير موجود!',
                embeds: [],
                components: []
            });
            return;
        }

        const recordToDelete = userRecords[recordIndex];
        const mainIndex = promoteLogs.findIndex(log => 
            log.timestamp === recordToDelete.timestamp && 
            log.type === recordToDelete.type &&
            JSON.stringify(log.data) === JSON.stringify(recordToDelete.data)
        );

        if (mainIndex !== -1) {
            promoteLogs.splice(mainIndex, 1);
            saveJson(promoteLogsPath, promoteLogs);
        }

        const successEmbed = colorManager.createEmbed()
            .setTitle('✅ تم حذف السجل')
            .setDescription('تم حذف السجل بنجاح')
            .addFields([
                { name: 'تم الحذف بواسطة', value: `<@${interaction.user.id}>`, inline: true }
            ])
            .setTimestamp();

        await interaction.update({
            embeds: [successEmbed],
            components: []
        });
    } catch (error) {
        console.error('خطأ في حذف سجل المستخدم:', error);
        await interaction.reply({
            content: '❌ حدث خطأ أثناء حذف السجل.',
            flags: MessageFlags.Ephemeral
        });
    }
}

async function handleDeleteAllUserRecords(interaction, userId) {
    try {
        const promoteLogsPath = path.join(__dirname, '..', 'data', 'promoteLogs.json');
        const promoteLogs = readJson(promoteLogsPath, []);

        const updatedLogs = promoteLogs.filter(log => {
            const targetUserId = log.data?.targetUserId || log.data?.userId;
            return targetUserId !== userId;
        });

        const deletedCount = promoteLogs.length - updatedLogs.length;
        saveJson(promoteLogsPath, updatedLogs);

        const successEmbed = colorManager.createEmbed()
            .setTitle('تم حذف جميع السجلات')
            .setDescription(
                `تم حذف جميع سجلات المستخدم بنجاح\n\n` +
                `المستخدم: <@${userId}>\n` +
                `عدد السجلات المحذوفة: ${deletedCount}\n` +
                `تم الحذف بواسطة: <@${interaction.user.id}>`
            )
            .setTimestamp();

        await interaction.update({
            embeds: [successEmbed],
            components: []
        });
    } catch (error) {
        console.error('خطأ في حذف جميع سجلات المستخدم:', error);
        await interaction.reply({
            content: 'حدث خطأ أثناء حذف السجلات!',
            flags: MessageFlags.Ephemeral
        });
    }
}

module.exports = { 
    name, 
    execute, 
    handleInteraction, 
    createPermanentMenu, 
    updatePermanentMenu,
    handleDeleteSingleRecord, 
    handleDeleteAllUserRecords 
};