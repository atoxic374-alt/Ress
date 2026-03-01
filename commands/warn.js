const { ButtonBuilder, ActionRowBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');
const colorManager = require('../utils/colorManager');
const warnManager = require('../utils/warnManager');

const name = 'warn';

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

// Check if initial setup is required
function needsSetup() {
    const settingsPath = path.join(__dirname, '..', 'data', 'warnSettings.json');
    const settings = readJson(settingsPath, {});

    return !settings.menuChannel || !settings.logChannel || !settings.allowedUsers?.type;
}

// Create setup status embed
function createSetupEmbed(step, settings = {}, client) {
    const embed = colorManager.createEmbed()
        .setTitle('Warn System Setup')
        .setDescription('يحتاج النظام للإعداد الأولي قبل الاستخدام')
        .setThumbnail(client?.user?.displayAvatarURL() || 'https://cdn.discordapp.com/attachments/1373799493111386243/1400677612304470086/images__5_-removebg-preview.png?ex=688d822e&is=688c30ae&hm=1ea7a63bb89b38bcd76c0f5668984d7fc919214096a3d3ee92f5d948497fcb51&')
        .setTimestamp();

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
        },
        {
            name: 'مسؤولي الداون',
            value: settings.downManagerUsers?.length > 0 ? 
                `${settings.downManagerUsers.length} مسؤول` :
                step === 4 ? 'جاري التحديد...' : 'لم يتم بعد (اختياري)',
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
        const channel = await client.channels.fetch(channelId);
        if (!channel) return false;

        const settings = warnManager.getSettings();
        const menuEmbed = colorManager.createEmbed()
            .setTitle('Warn Management System')
            .setDescription('منيو التحذيرات للمسؤولين')
            .addFields([
                { name: 'Warn', value: 'إعطاء تحذير لعضو', inline: false },
                { name: 'Records', value: 'عرض سجل التحذيرات للأعضاء', inline: false },
                { name: 'Statistics', value: 'عرض إحصائيات التحذيرات', inline: false }
            ])
            .setThumbnail(client?.user?.displayAvatarURL() || 'https://cdn.discordapp.com/attachments/1373799493111386243/1400677612304470086/images__5_-removebg-preview.png?ex=688d822e&is=688c30ae&hm=1ea7a63bb89b38bcd76c0f5668984d7fc919214096a3d3ee92f5d948497fcb51&')
            .setFooter({ text: 'Warn System' })
            .setTimestamp();

        const menuSelect = new StringSelectMenuBuilder()
            .setCustomId('warn_main_menu')
            .setPlaceholder('اختر الإجراء المطلوب...')
            .addOptions([
                {
                    label: 'Warn',
                    emoji: '<:emoji_56:1442587524265541745>',
                    value: 'give_warning',
                    description: 'إعطاء تحذير لعضو'
                },
                {
                    label: 'Records',
                    emoji: '<:emoji_57:1442587551021006898>',
                    value: 'view_records',
                    description: 'عرض سجل تحذيرات الأعضاء'
                },
                {
                    label: 'Statistics',
                    emoji: '<:emoji_55:1442587493596663911>',
                    value: 'view_statistics',
                    description: 'عرض إحصائيات التحذيرات'
                }
            ]);

        const settingsButton = new ButtonBuilder()
            .setCustomId('warn_settings_button')
            .setLabel('Settings')
            .setEmoji('<:emoji_73:1442588750579503224>')
            .setStyle(ButtonStyle.Secondary);

        const menuRow = new ActionRowBuilder().addComponents(menuSelect);
        const buttonRow = new ActionRowBuilder().addComponents(settingsButton);

        let message = null;

        if (settings.menuMessageId) {
            try {
                const existingMessage = await channel.messages.fetch(settings.menuMessageId);
                message = await existingMessage.edit({
                    embeds: [menuEmbed],
                    components: [menuRow, buttonRow]
                });
                console.log('تم تحديث منيو التحذيرات الموجود');
                return true;
            } catch (error) {
                console.log('Previous menu message not found, creating new one');
                settings.menuMessageId = null;
            }
        }

        try {
            message = await channel.send({
                embeds: [menuEmbed],
                components: [menuRow, buttonRow]
            });

            settings.menuMessageId = message.id;
            warnManager.updateSettings(settings);

            console.log(`تم إنشاء منيو التحذيرات برقم: ${message.id}`);
            return true;
        } catch (error) {
            console.error('خطأ في إنشاء منيو التحذيرات:', error);
            return false;
        }
    } catch (error) {
        console.error('خطأ في إنشاء المنيو الدائم:', error);
        return false;
    }
}

async function execute(message, args, context) {
    const { client, BOT_OWNERS } = context;

    // Check if user is owner
    if (!BOT_OWNERS.includes(message.author.id)) {
        const settingsPath = path.join(__dirname, '..', 'data', 'warnSettings.json');
        const settings = readJson(settingsPath, {});

        const noPermEmbed = colorManager.createEmbed()
            .setDescription('⛔ **مب لك هذي الاشياء.');

        if (settings.menuChannel) {
            noPermEmbed.addFields([
                { name: '📍 روم المنيو', value: `<#${settings.menuChannel}>`, inline: true }
            ]);
        }

        return message.reply({ embeds: [noPermEmbed] });
    }

    // Check if setup is needed
    if (needsSetup()) {
        const setupEmbed = createSetupEmbed(1, {}, client);

        const setupSelect = new StringSelectMenuBuilder()
            .setCustomId('warn_setup_permission')
            .setPlaceholder('اختر نوع المعتمدين...')
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

        const setupRow = new ActionRowBuilder().addComponents(setupSelect);

        return message.reply({
            embeds: [setupEmbed],
            components: [setupRow],
            content: '** إعداد نظام التحذيرات**\n\nيرجى اتباع الخطوات التالية لإكمال الإعداد:'
        });
    }

    // If setup is complete, show admin management menu
    const settingsPath = path.join(__dirname, '..', 'data', 'warnSettings.json');
    const settings = readJson(settingsPath, {});

    const adminEmbed = colorManager.createEmbed()
        .setTitle('Warn System Management')
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
            },
            {
                name: 'مسؤولي الداون',
                value: settings.downManagerUsers?.length > 0 ? 
                    `${settings.downManagerUsers.length} مسؤول` : 
                    'لم يتم تحديد',
                inline: true
            }
        ])
        .setThumbnail(client?.user?.displayAvatarURL() || 'https://cdn.discordapp.com/attachments/1373799493111386243/1400677612304470086/images__5_-removebg-preview.png?ex=688d822e&is=688c30ae&hm=1ea7a63bb89b38bcd76c0f5668984d7fc919214096a3d3ee92f5d948497fcb51&')
        .setTimestamp();

    const quickActionsSelect = new StringSelectMenuBuilder()
        .setCustomId('warn_quick_actions')
        .setPlaceholder('إجراءات سريعة...')
        .addOptions([
            {
                label: 'إعادة إرسال المنيو التفاعلي',
                value: 'resend_menu',
                description: 'إرسال المنيو التفاعلي مرة أخرى للقناة المحددة'
            },
            {
                label: 'تعديل الإعدادات',
                value: 'edit_settings',
                description: 'تعديل إعدادات النظام (المعتمدين، القنوات)'
            },
            {
                label: 'إدارة مسؤولي الداون',
                value: 'manage_down_managers',
                description: 'إضافة أو إزالة مسؤولي الداون'
            }
        ]);

    const actionRow = new ActionRowBuilder().addComponents(quickActionsSelect);

    await message.reply({ embeds: [adminEmbed], components: [actionRow] });
}

async function handleInteraction(interaction, context) {
    try {
        const { client, BOT_OWNERS } = context;

        if (interaction.replied || interaction.deferred) {
            return;
        }

        const customId = interaction.customId;

        // Handle setup interactions
        if (customId.startsWith('warn_setup_')) {
            await handleSetupStep(interaction, context);
            return;
        }

        // Handle quick admin actions
        if (customId === 'warn_quick_actions') {
            await handleQuickActions(interaction, context);
            return;
        }

        // Check permissions for main functionality
        const hasPermission = await warnManager.hasPermission(interaction, BOT_OWNERS);
        if (!hasPermission) {
            return interaction.reply({
                content: '⛔ **لا تسوي خوي!**',
                ephemeral: true
            });
        }

        // Handle main menu interactions
        if (customId === 'warn_main_menu') {
            await handleMainMenu(interaction, context);
            return;
        }

        // Handle settings button
        if (customId === 'warn_settings_button') {
            await handleSettingsButton(interaction, context);
            return;
        }

        // Handle other warn interactions
        await handleWarnInteractions(interaction, context);

    } catch (error) {
        console.error('خطأ في معالجة تفاعل warn:', error);

        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: '❌ **حدث خطأ أثناء المعالجة! يرجى المحاولة مرة أخرى.**',
                ephemeral: true
            }).catch(console.error);
        }
    }
}

async function handleSetupStep(interaction, context) {
    const { client, BOT_OWNERS } = context;
    const settingsPath = path.join(__dirname, '..', 'data', 'warnSettings.json');
    const settings = readJson(settingsPath, {
        menuChannel: null,
        logChannel: null,
        downManagerUsers: [],
        allowedUsers: { type: null, targets: [] }
    });

    if (interaction.customId === 'warn_setup_permission') {
        const selectedType = interaction.values[0];

        if (!settings.allowedUsers) {
            settings.allowedUsers = { type: null, targets: [] };
        }

        settings.allowedUsers.type = selectedType;

        if (selectedType === 'owners') {
            settings.allowedUsers.targets = BOT_OWNERS;
            saveJson(settingsPath, settings);

            const setupEmbed = createSetupEmbed(2, settings, client);

            const channelSelect = new ChannelSelectMenuBuilder()
                .setCustomId('warn_setup_log_channel')
                .setPlaceholder('📍 اختر روم السجلات...')
                .setChannelTypes([ChannelType.GuildText]);

            const channelRow = new ActionRowBuilder().addComponents(channelSelect);

            await interaction.update({
                embeds: [setupEmbed],
                components: [channelRow]
            });

        } else if (selectedType === 'roles') {
            settings.allowedUsers.targets = [];
            saveJson(settingsPath, settings);

            const setupEmbed = createSetupEmbed(1, settings, client);
            setupEmbed.setDescription('اختر الرولات المعتمدة لاستخدام نظام التحذيرات');

            const roleSelect = new RoleSelectMenuBuilder()
                .setCustomId('warn_setup_select_roles')
                .setPlaceholder(' اختر الرولات المعتمدة...')
                .setMaxValues(10);

            const roleRow = new ActionRowBuilder().addComponents(roleSelect);

            await interaction.update({
                embeds: [setupEmbed],
                components: [roleRow]
            });

        } else if (selectedType === 'responsibility') {
            settings.allowedUsers.targets = [];
            const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
            const responsibilities = readJson(responsibilitiesPath, {});

            if (Object.keys(responsibilities).length === 0) {
                const noRespEmbed = colorManager.createEmbed()
                    .setTitle(' لا توجد مسؤوليات')
                    .setDescription('لا توجد مسؤوليات معرّفة في النظام!\n\nيرجى استخدام أمر `settings` أولاً لإضافة مسؤوليات.')
                    .addFields([
                        { name: '💡 نصيحة', value: 'يمكنك اختيار "المالكين فقط" أو "رولات محددة" بدلاً من ذلك', inline: false }
                    ]);

                const backSelect = new StringSelectMenuBuilder()
                    .setCustomId('warn_setup_permission')
                    .setPlaceholder('🔙 اختر خياراً آخر...')
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
                        }
                    ]);

                const backRow = new ActionRowBuilder().addComponents(backSelect);

                await interaction.update({
                    embeds: [noRespEmbed],
                    components: [backRow]
                });
                return;
            }

            saveJson(settingsPath, settings);

            const setupEmbed = createSetupEmbed(1, settings, client);
            setupEmbed.setDescription('اختر المسؤوليات المعتمدة لاستخدام نظام التحذيرات');

            const respOptions = Object.keys(responsibilities).slice(0, 25).map(name => ({
                label: name,
                value: name,
                description: `السماح للمسؤولين عن ${name}`
            }));

            const respSelect = new StringSelectMenuBuilder()
                .setCustomId('warn_setup_select_responsibilities')
                .setPlaceholder(' اختر المسؤوليات المعتمدة...')
                .setMaxValues(Math.min(respOptions.length, 10))
                .addOptions(respOptions);

            const respRow = new ActionRowBuilder().addComponents(respSelect);

            await interaction.update({
                embeds: [setupEmbed],
                components: [respRow]
            });
        }
        return;
    }

    // Handle role selection for setup
    if (interaction.customId === 'warn_setup_select_roles') {
        settings.allowedUsers.targets = interaction.values;
        saveJson(settingsPath, settings);

        const setupEmbed = createSetupEmbed(2, settings, client);

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId('warn_setup_log_channel')
            .setPlaceholder('📍 اختر روم السجلات...')
            .setChannelTypes([ChannelType.GuildText]);

        const channelRow = new ActionRowBuilder().addComponents(channelSelect);

        await interaction.update({
            embeds: [setupEmbed],
            components: [channelRow]
        });
        return;
    }

    // Handle responsibility selection for setup
    if (interaction.customId === 'warn_setup_select_responsibilities') {
        settings.allowedUsers.targets = interaction.values;
        saveJson(settingsPath, settings);

        const setupEmbed = createSetupEmbed(2, settings, client);

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId('warn_setup_log_channel')
            .setPlaceholder('📍 اختر روم السجلات...')
            .setChannelTypes([ChannelType.GuildText]);

        const channelRow = new ActionRowBuilder().addComponents(channelSelect);

        await interaction.update({
            embeds: [setupEmbed],
            components: [channelRow]
        });
        return;
    }

    // Handle log channel selection
    if (interaction.customId === 'warn_setup_log_channel') {
        const logChannelId = interaction.values[0];
        settings.logChannel = logChannelId;
        saveJson(settingsPath, settings);

        const setupEmbed = createSetupEmbed(3, settings, client);

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId('warn_setup_menu_channel')
            .setPlaceholder('📍 اختر روم المنيو التفاعلي...')
            .setChannelTypes([ChannelType.GuildText]);

        const channelRow = new ActionRowBuilder().addComponents(channelSelect);

        await interaction.update({
            embeds: [setupEmbed],
            components: [channelRow]
        });
        return;
    }

    // Handle menu channel selection
    if (interaction.customId === 'warn_setup_menu_channel') {
        const menuChannelId = interaction.values[0];
        settings.menuChannel = menuChannelId;
        saveJson(settingsPath, settings);

        // Ask about down managers (optional step)
        const setupEmbed = createSetupEmbed(4, settings, client);
        setupEmbed.setDescription('اختياري: اختر المسؤولين المختصين بالداون (الذين سيتلقون طلبات الداون من التحذيرات)');

        const userSelect = new UserSelectMenuBuilder()
            .setCustomId('warn_setup_down_managers')
            .setPlaceholder(' اختر مسؤولي الداون (اختياري)...')
            .setMinValues(0)
            .setMaxValues(10);

        const skipButton = new ButtonBuilder()
            .setCustomId('warn_setup_skip_down_managers')
            .setLabel('Skip')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('<:emoji_31:1430330925304250591>');

        const userRow = new ActionRowBuilder().addComponents(userSelect);
        const buttonRow = new ActionRowBuilder().addComponents(skipButton);

        await interaction.update({
            embeds: [setupEmbed],
            components: [userRow, buttonRow]
        });
        return;
    }

    // Handle down managers selection
    if (interaction.customId === 'warn_setup_down_managers') {
        settings.downManagerUsers = interaction.values;
        saveJson(settingsPath, settings);

        await finishSetup(interaction, context, settings);
        return;
    }

    // Handle skip down managers
    if (interaction.customId === 'warn_setup_skip_down_managers') {
        settings.downManagerUsers = [];
        saveJson(settingsPath, settings);

        await finishSetup(interaction, context, settings);
        return;
    }
}

async function finishSetup(interaction, context, settings) {
    const { client } = context;

    const success = await createPermanentMenu(client, settings.menuChannel);

    const completeEmbed = colorManager.createEmbed()
        .setTitle('✅ Setup Complete Successfully')
        .setDescription('تم إكمال الإعداد بنجاح! يمكنك الآن استخدام نظام التحذيرات.')
        .addFields([
            { name: 'روم السجلات', value: `<#${settings.logChannel}>`, inline: true },
            { name: 'روم المنيو', value: `<#${settings.menuChannel}>`, inline: true },
            { name: 'المعتمدين', value: `${getPermissionTypeText(settings.allowedUsers.type)}`, inline: true },
            { name: 'مسؤولي الداون', value: settings.downManagerUsers.length > 0 ? `${settings.downManagerUsers.length} مسؤول` : 'لم يتم تحديد', inline: true }
        ])
        .setTimestamp();

    if (success) {
        completeEmbed.addFields([
            { name: '✅ تم إنشاء المنيو', value: `تم إرسال المنيو التفاعلي في <#${settings.menuChannel}>`, inline: false }
        ]);
    }

    await interaction.update({
        embeds: [completeEmbed],
        components: []
    });
}

async function handleQuickActions(interaction, context) {
    const { client, BOT_OWNERS } = context;

    if (!BOT_OWNERS.includes(interaction.user.id)) {
        return interaction.reply({
            content: '⛔ **لا تسوي خوي!**',
            ephemeral: true
        });
    }

    const action = interaction.values[0];
    const settingsPath = path.join(__dirname, '..', 'data', 'warnSettings.json');
    const settings = readJson(settingsPath, {});

    if (action === 'resend_menu') {
        if (!settings.menuChannel) {
            return interaction.reply({
                content: '❌ **لم يتم تحديد روم المنيو بعد!**',
                ephemeral: true
            });
        }

        const success = await createPermanentMenu(client, settings.menuChannel);

        if (success) {
            await interaction.reply({
                content: `✅ **تم إعادة إرسال المنيو في** <#${settings.menuChannel}>`,
                ephemeral: true
            });
        } else {
            await interaction.reply({
                content: '❌ **فشل في إعادة إرسال المنيو! تحقق من الصلاحيات.**',
                ephemeral: true
            });
        }
        return;
    }

    if (action === 'edit_settings') {
        const editEmbed = colorManager.createEmbed()
            .setTitle('Edit settings')
            .setDescription('اختر الإعداد الذي تريد تعديله:')
            .addFields([
                { name: 'المعتمدين الحاليين', value: settings.allowedUsers?.type ? getPermissionTypeText(settings.allowedUsers.type) : 'غير محدد', inline: true },
                { name: 'روم السجلات', value: settings.logChannel ? `<#${settings.logChannel}>` : 'غير محدد', inline: true },
                { name: 'روم المنيو', value: settings.menuChannel ? `<#${settings.menuChannel}>` : 'غير محدد', inline: true }
            ]);

        const editSelect = new StringSelectMenuBuilder()
            .setCustomId('warn_edit_setting')
            .setPlaceholder('اختر الإعداد...')
            .addOptions([
                {
                    label: 'تعديل المعتمدين',
                    value: 'edit_permissions',
                    description: 'تغيير من لديه صلاحية استخدام النظام'
                },
                {
                    label: 'تغيير روم السجلات',
                    value: 'edit_log_channel',
                    description: 'تغيير القناة المخصصة للسجلات'
                },
                {
                    label: 'تغيير روم المنيو',
                    value: 'edit_menu_channel',
                    description: 'تغيير القناة المخصصة للمنيو'
                }
            ]);

        const editRow = new ActionRowBuilder().addComponents(editSelect);

        await interaction.reply({
            embeds: [editEmbed],
            components: [editRow],
            ephemeral: true
        });
        return;
    }

    if (action === 'manage_down_managers') {
        const manageEmbed = colorManager.createEmbed()
            .setTitle('Manage down resp')
            .setDescription('اختر مسؤولي الداون الجدد (سيتم استبدال القائمة الحالية)')
            .addFields([
                { 
                    name: 'المسؤولين الحاليين', 
                    value: settings.downManagerUsers?.length > 0 ? 
                        settings.downManagerUsers.map(id => `<@${id}>`).join(', ') : 
                        'لا يوجد', 
                    inline: false 
                }
            ]);

        const userSelect = new UserSelectMenuBuilder()
            .setCustomId('warn_update_down_managers')
            .setPlaceholder('اختر مسؤولي الداون...')
            .setMinValues(0)
            .setMaxValues(10);

        const userRow = new ActionRowBuilder().addComponents(userSelect);

        await interaction.reply({
            embeds: [manageEmbed],
            components: [userRow],
            ephemeral: true
        });
        return;
    }
}

async function handleSettingsButton(interaction, context) {
    const { BOT_OWNERS } = context;

    if (!BOT_OWNERS.includes(interaction.user.id)) {
        return interaction.reply({
            content: '⛔ **لا تسوي خوي!**',
            ephemeral: true
        });
    }

    const settings = warnManager.getSettings();

    const settingsEmbed = colorManager.createEmbed()
        .setTitle('Warn System Settings')
        .setDescription('الاعدادات الحالية')
        .addFields([
            {
                name: ' المعتمدين',
                value: settings.allowedUsers?.type ?
                    `${getPermissionTypeText(settings.allowedUsers.type)} (${settings.allowedUsers.targets?.length || 0})` :
                    'غير محدد',
                inline: true
            },
            {
                name: 'روم السجلات',
                value: settings.logChannel ? `<#${settings.logChannel}>` : 'غير محدد',
                inline: true
            },
            {
                name: 'روم المنيو',
                value: settings.menuChannel ? `<#${settings.menuChannel}>` : 'غير محدد',
                inline: true
            },
            {
                name: 'مسؤولي الداون',
                value: settings.downManagerUsers?.length > 0 ?
                    settings.downManagerUsers.map(id => `<@${id}>`).join(', ') :
                    'لم يتم تحديد',
                inline: false
            }
        ])
        .setTimestamp();

    const editSelect = new StringSelectMenuBuilder()
        .setCustomId('warn_edit_setting')
        .setPlaceholder('تعديل إعداد...')
        .addOptions([
            {
                label: 'تعديل المعتمدين',
                value: 'edit_permissions',
                description: 'تغيير من لديه صلاحية استخدام النظام',
                emoji: '👥'
            },
            {
                label: 'تغيير روم السجلات',
                value: 'edit_log_channel',
                description: 'تغيير القناة المخصصة للسجلات',
                emoji: '📍'
            },
            {
                label: 'تغيير روم المنيو',
                value: 'edit_menu_channel',
                description: 'تغيير القناة المخصصة للمنيو',
                emoji: '📍'
            },
            {
                label: 'إدارة مسؤولي الداون',
                value: 'edit_down_managers',
                description: 'إضافة أو تعديل مسؤولي الداون',
                emoji: '👨‍💼'
            }
        ]);

    const editRow = new ActionRowBuilder().addComponents(editSelect);

    await interaction.reply({
        embeds: [settingsEmbed],
        components: [editRow],
        ephemeral: true
    });
}

async function handleMainMenu(interaction, context) {
    const action = interaction.values[0];

    if (action === 'give_warning') {
        const userSelect = new UserSelectMenuBuilder()
            .setCustomId('warn_select_user')
            .setPlaceholder(' اختر العضو للتحذير...')
            .setMaxValues(1);

        const userRow = new ActionRowBuilder().addComponents(userSelect);

        await interaction.reply({
            content: '**اختر العضو الذي تريد تحذيره:**',
            components: [userRow],
            ephemeral: true
        });

        // Refresh main menu after action
        try {
            const settings = warnManager.getSettings();
            if (settings.menuChannel) {
                await createPermanentMenu(context.client, settings.menuChannel);
            }
        } catch (error) {
            console.error('Error refreshing warn menu:', error);
        }
        return;
    }

    if (action === 'view_records') {
        const usersWithWarnings = warnManager.getUsersWithWarnings(interaction.guild.id);

        if (usersWithWarnings.length === 0) {
            const noWarningsEmbed = colorManager.createEmbed()
                .setTitle('Warn record')
                .setDescription('لا يوجد أي عضو لديه تحذيرات حالياً.')
                .setTimestamp();

            await interaction.reply({
                embeds: [noWarningsEmbed],
                ephemeral: true
            });

            // Refresh main menu after action
            try {
                const settings = warnManager.getSettings();
                if (settings.menuChannel) {
                    await createPermanentMenu(context.client, settings.menuChannel);
                }
            } catch (error) {
                console.error('Error refreshing warn menu:', error);
            }
            return;
        }

        // جلب أسماء الأعضاء
        const userOptionsPromises = usersWithWarnings.slice(0, 25).map(async user => {
            const member = await interaction.guild.members.fetch(user.userId).catch(() => null);
            const displayName = member ? member.displayName : 'عضو غير موجود';
            
            return {
                label: displayName.substring(0, 100),
                value: user.userId,
                description: `Warn count : ${user.count}`
            };
        });
        
        const userOptions = await Promise.all(userOptionsPromises);

        const userSelect = new StringSelectMenuBuilder()
            .setCustomId('warn_view_user_record')
            .setPlaceholder('اختر عضو لعرض تحذيراته...')
            .addOptions(userOptions);

        const userRow = new ActionRowBuilder().addComponents(userSelect);

        const recordsEmbed = colorManager.createEmbed()
            .setTitle('Warn list')
            .setDescription(`يوجد :**${usersWithWarnings.length}** عضو لديهم تحذيرات`)
            .setTimestamp();

        await interaction.reply({
            embeds: [recordsEmbed],
            components: [userRow],
            ephemeral: true
        });
        return;
    }

    if (action === 'view_statistics') {
        const stats = warnManager.getStatistics(interaction.guild.id);

        const statsEmbed = colorManager.createEmbed()
            .setTitle('Warn stats')
            .setDescription('إحصائيات شاملة لنظام التحذيرات')
            .addFields([
                {
                    name: 'All',
                    value: `**${stats.total.count}** تحذير${stats.total.topUser ? `\n الأكثر تحذيرا : <@${stats.total.topUser.userId}> (${stats.total.topUser.count})` : ''}`,
                    inline: false
                },
                {
                    name: 'Weekly',
                    value: `**${stats.weekly.count}** تحذير${stats.weekly.topUser ? `\n الأكثر تحذيرا : <@${stats.weekly.topUser.userId}> (${stats.weekly.topUser.count})` : ''}`,
                    inline: true
                },
                {
                    name: 'Daily',
                    value: `**${stats.daily.count}** تحذير${stats.daily.topUser ? `\n الأكثر تحذيرا : <@${stats.daily.topUser.userId}> (${stats.daily.topUser.count})` : ''}`,
                    inline: true
                }
            ])
            .setTimestamp();

        await interaction.reply({
            embeds: [statsEmbed],
            ephemeral: true
        });

        // Refresh main menu after action
        try {
            const settings = warnManager.getSettings();
            if (settings.menuChannel) {
                await createPermanentMenu(context.client, settings.menuChannel);
            }
        } catch (error) {
            console.error('Error refreshing warn menu:', error);
        }
        return;
    }
}

async function handleWarnInteractions(interaction, context) {
    const { client } = context;
    const customId = interaction.customId;

    // Handle user selection for warning
    if (interaction.isUserSelectMenu() && customId === 'warn_select_user') {
        const userId = interaction.values[0];
        const member = await interaction.guild.members.fetch(userId);

        const modal = new ModalBuilder()
            .setCustomId(`warn_reason_modal_${userId}`)
            .setTitle('تحذير عضو');

        const reasonInput = new TextInputBuilder()
            .setCustomId('warn_reason')
            .setLabel('سبب التحذير')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder('اذكر سبب التحذير بالتفصيل...');

        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));

        await interaction.showModal(modal);
        return;
    }

    // Handle warning reason modal
    if (interaction.isModalSubmit() && customId.startsWith('warn_reason_modal_')) {
        const userId = customId.replace('warn_reason_modal_', '');
        const reason = interaction.fields.getTextInputValue('warn_reason');

        try {
            const member = await interaction.guild.members.fetch(userId);

            // Create the warning
            const result = await warnManager.createWarning(
                interaction.guild,
                member,
                reason,
                interaction.user.id
            );

            if (!result.success) {
                await interaction.reply({
                    content: `❌ **فشل في إنشاء التحذير:** ${result.error}`,
                    ephemeral: true
                });
                return;
            }

            const warnId = result.warnId;
            const warnNumber = warnManager.getUserWarnings(userId, interaction.guild.id).length;

            // Ask if they want to request a down
            const downQuestionEmbed = colorManager.createEmbed()
                .setTitle('Down request')
                .setDescription(`تم إعطاء التحذير بنجاح!\n\n**هل تريد جعل الشخص يأخذ داون؟**`)
                .addFields([
                    { name: 'العضو', value: `<@${userId}>`, inline: true },
                    { name: 'رقم التحذير', value: `#${warnNumber}`, inline: true },
                    { name: 'السبب', value: reason, inline: false }
                ]);

            const yesButton = new ButtonBuilder()
                .setCustomId(`warn_request_down_yes_${warnId}`)
                .setLabel('Y')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('<:emoji_41:1430334120839479449>');

            const noButton = new ButtonBuilder()
                .setCustomId(`warn_request_down_no_${warnId}`)
                .setLabel('N')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('<:emoji_9:1429246586289918063>');

            const buttonRow = new ActionRowBuilder().addComponents(yesButton, noButton);

            const reply = await interaction.reply({
                embeds: [downQuestionEmbed],
                components: [buttonRow],
                ephemeral: true,
                fetchReply: true
            });

            // حفظ رسالة السؤال لتعطيل الأزرار لاحقاً
            if (!global.warnDownQuestions) global.warnDownQuestions = new Map();
            global.warnDownQuestions.set(warnId, reply.id);

        } catch (error) {
            console.error('خطأ في معالجة التحذير:', error);
            await interaction.reply({
                content: '❌ **حدث خطأ أثناء معالجة التحذير!**',
                ephemeral: true
            });
        }
        return;
    }

    // Handle down request - YES
    if (interaction.isButton() && customId.startsWith('warn_request_down_yes_')) {
        const warnId = customId.replace('warn_request_down_yes_', '');

        const activeWarns = warnManager.getActiveWarnings();
        const warnRecord = activeWarns[warnId];

        if (!warnRecord) {
            await interaction.reply({
                content: '❌ **التحذير غير موجود!**',
                ephemeral: true
            });
            return;
        }

        // طلب المدة عبر رسالة نصية
        const askDurationEmbed = colorManager.createEmbed()
            .setTitle('المدة المقترحه لمسؤولي الداون')
            .setDescription('**Time to Down **\n\n**أمثلة :**\n• **7d**\n• **12h**\n• **30m**\n• **2w**')
            .setTimestamp();

        await interaction.update({
            embeds: [askDurationEmbed],
            components: []
        });

        // انتظار رد المستخدم
        const filter = m => m.author.id === interaction.user.id;
        const collector = interaction.channel.createMessageCollector({ 
            filter, 
            max: 1, 
            time: 60000 // دقيقة واحدة
        });

        collector.on('collect', async (message) => {
            const duration = message.content.trim();
            
            // حذف رسالة المستخدم
            try {
                await message.delete();
            } catch (e) {
                console.log('تعذر حذف رسالة المستخدم');
            }

            // التحقق من صحة المدة
            const validDurationPattern = /^(\d+)([smhdw])$/i;
            const match = duration.match(validDurationPattern);

            if (!match) {
                const errorEmbed = colorManager.createEmbed()
                    .setTitle('❌ Error')
                    .setDescription('**صيغة المدة غير صحيحة!**\n\n**الصيغ الصحيحة:**\n• `30s` = 30 ثانية\n• `15m` = 15 دقيقة\n• `12h` = 12 ساعة\n• `7d` = 7 أيام\n• `2w` = أسبوعين')
                    .setTimestamp();

                await interaction.editReply({
                    embeds: [errorEmbed],
                    components: []
                });
                return;
            }

            // Update warning with down request
            await warnManager.updateWarningWithDown(warnId, duration);

            const warnNumber = warnManager.getUserWarnings(warnRecord.userId, interaction.guild.id).length;

            // Send log to channel
            await warnManager.sendLogMessage(interaction.guild, client, 'WARN_CREATED', {
                targetUser: await client.users.fetch(warnRecord.userId),
                byUser: await client.users.fetch(warnRecord.byUserId),
                reason: warnRecord.reason,
                warnNumber: warnNumber,
                downRequested: true
            });

            // Send notification to down managers
            const settings = warnManager.getSettings();
            if (settings.downManagerUsers && settings.downManagerUsers.length > 0) {
                const member = await client.users.fetch(warnRecord.userId);
                const downRequestEmbed = colorManager.createEmbed()
                    .setTitle('Down Request From Warn Resp')
                    .setDescription('يوجد طلب داون جديد من مسؤولي التحذيرات')
                    .addFields([
                        { name: 'العضو', value: `${member.username} (<@${warnRecord.userId}>)`, inline: true },
                        { name: 'رقم التحذير', value: `#${warnNumber}`, inline: true },
                        { name: 'المسؤول', value: `<@${warnRecord.byUserId}>`, inline: true },
                        { name: 'السبب', value: warnRecord.reason, inline: false },
                        { name: 'المدة المقترحة', value: duration, inline: true },
                        { name: 'الوقت', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ])
                    .setThumbnail(member.displayAvatarURL({ dynamic: true }))
                    .setTimestamp();

                let sentCount = 0;
                for (const managerId of settings.downManagerUsers) {
                    try {
                        const manager = await client.users.fetch(managerId);
                        await manager.send({ embeds: [downRequestEmbed] });
                        sentCount++;
                    } catch (error) {
                        console.log(`لا يمكن إرسال رسالة للمسؤول ${managerId}`);
                    }
                }
                
                if (sentCount > 0) {
                    console.log(`✅ تم إرسال طلب الداون إلى ${sentCount} مسؤول`);
                }
            }

            // Send DM to warned user
            try {
                const member = await interaction.guild.members.fetch(warnRecord.userId);
                const moderator = await client.users.fetch(interaction.user.id);
                const dmEmbed = colorManager.createEmbed()
                    .setTitle('Warn')
                    .setDescription(`تم إعطاؤك تحذير في سيرفر **${interaction.guild.name}**`)
                    .addFields([
                        { name: 'رقم التحذير', value: `#${warnNumber}`, inline: true },
                        { name: 'السبب', value: warnRecord.reason, inline: false },
                        { name: 'المسؤول', value: `<@${interaction.user.id}>`, inline: true },
                        { name: 'تم طلب داون', value: 'نعم', inline: true },
                        { name: 'الوقت', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                    ])
                    .setThumbnail(moderator.displayAvatarURL({ dynamic: true, size: 128 }))
                    .setTimestamp();

                await member.send({ embeds: [dmEmbed] });
            } catch (dmError) {
                console.log(`لا يمكن إرسال رسالة خاصة للعضو`);
            }

            // تحديث الرسالة - مثل زر N بالضبط
            const completeEmbed = colorManager.createEmbed()
                .setTitle('✅ Done ')
                .setDescription('تم إعطاء التحذير وإرسال طلب الداون لمسؤولي الداون وتسجيله في السجلات.')
                .addFields([
                { name: 'المدة المقترحة', value: duration, inline: true },
                { name: 'العضو', value: `<@${warnRecord.userId}>`, inline: true },
                { name: 'عدد المسؤولين', value: `${settings.downManagerUsers?.length || 0}`, inline: true }
            ])
                .setTimestamp();

            await interaction.editReply({
                embeds: [completeEmbed],
                components: []
            });
        });

        collector.on('end', (collected, reason) => {
            if (reason === 'time' && collected.size === 0) {
                const timeoutEmbed = colorManager.createEmbed()
                    .setTitle('⏰ انتهى الوقت')
                    .setDescription('انتهى وقت الانتظار. يرجى المحاولة مرة أخرى.')
                    .setTimestamp();

                interaction.editReply({
                    embeds: [timeoutEmbed],
                    components: []
                }).catch(console.error);
            }
        });
        
        return;
    }

    // Handle down request - NO
    if (interaction.isButton() && customId.startsWith('warn_request_down_no_')) {
        const warnId = customId.replace('warn_request_down_no_', '');

        const activeWarns = warnManager.getActiveWarnings();
        const warnRecord = activeWarns[warnId];

        if (!warnRecord) {
            await interaction.reply({
                content: '❌ **التحذير غير موجود!**',
                ephemeral: true
            });
            return;
        }

        const warnNumber = warnManager.getUserWarnings(warnRecord.userId, interaction.guild.id).length;

        // Send log to channel
        await warnManager.sendLogMessage(interaction.guild, client, 'WARN_CREATED', {
            targetUser: await client.users.fetch(warnRecord.userId),
            byUser: await client.users.fetch(warnRecord.byUserId),
            reason: warnRecord.reason,
            warnNumber: warnNumber,
            downRequested: false
        });

        // Send DM to warned user
        try {
            const member = await interaction.guild.members.fetch(warnRecord.userId);
            const moderator = await client.users.fetch(interaction.user.id);
            const dmEmbed = colorManager.createEmbed()
                .setTitle('Warn')
                .setDescription(`تم إعطاؤك تحذير في سيرفر **${interaction.guild.name}**`)
                .addFields([
                    { name: 'رقم التحذير', value: `#${warnNumber}`, inline: true },
                    { name: 'السبب', value: warnRecord.reason, inline: false },
                    { name: 'المسؤول', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'الوقت', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true }
                ])
                .setThumbnail(moderator.displayAvatarURL({ dynamic: true, size: 128 }))
                .setTimestamp();

            await member.send({ embeds: [dmEmbed] });
        } catch (dmError) {
            console.log(`لا يمكن إرسال رسالة خاصة للعضو`);
        }

        const completeEmbed = colorManager.createEmbed()
            .setTitle('✅ Done ')
            .setDescription('تم إعطاء التحذير بنجاح وتسجيله في السجلات.')
            .setTimestamp();

        // تحديث الرسالة الأصلية بدلاً من editReply
        await interaction.update({
            embeds: [completeEmbed],
            components: []
        });
        
        return;
    }

    // Handle view user warnings record
    if (interaction.isStringSelectMenu() && customId === 'warn_view_user_record') {
        const userId = interaction.values[0];
        const userWarnings = warnManager.getUserWarnings(userId, interaction.guild.id);

        if (userWarnings.length === 0) {
            await interaction.reply({
                content: '❌ **لا توجد تحذيرات لهذا العضو!**',
                ephemeral: true
            });
            return;
        }

        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        const memberName = member ? member.displayName : 'عضو غير موجود';

        // Create embed showing all warnings
        const recordEmbed = colorManager.createEmbed()
            .setTitle(`Warn list For ${memberName}`)
            .setDescription(`إجمالي التحذيرات : **${userWarnings.length}**`)
            .setTimestamp();

        for (const [index, warn] of userWarnings.entries()) {
            // الحصول على اسم المسؤول
            const moderator = await client.users.fetch(warn.byUserId).catch(() => null);
            const moderatorMention = moderator ? `<@${warn.byUserId}>` : 'مسؤول غير معروف';
            
            recordEmbed.addFields({
                name: `تحذير #${index + 1}`,
                value: `**السبب :** ${warn.reason}\n**المسؤول :** ${moderatorMention}\n**الوقت :** <t:${Math.floor(warn.timestamp / 1000)}:F>\n**طلب داون :** ${warn.downRequested ? `نعم (${warn.downDuration})` : 'لا'}`,
                inline: false
            });
        }

        // Create buttons for deleting warnings
        const deleteAllButton = new ButtonBuilder()
            .setCustomId(`warn_delete_all_${userId}`)
            .setLabel('Delete All')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('<:emoji_45:1430334556078211082>');

        const buttonRow = new ActionRowBuilder().addComponents(deleteAllButton);

        // Create select menu for individual deletion
        const warnOptions = userWarnings.map((warn, index) => ({
            label: `warn #${index + 1}`,
            value: warn.warnId,
            description: warn.reason.substring(0, 100)
        }));

        const warnSelect = new StringSelectMenuBuilder()
            .setCustomId('warn_delete_single')
            .setPlaceholder('اختر تحذير لحذفه...')
            .addOptions(warnOptions);

        const selectRow = new ActionRowBuilder().addComponents(warnSelect);

        await interaction.reply({
            embeds: [recordEmbed],
            components: [selectRow, buttonRow],
            ephemeral: true
        });
        return;
    }

    // Handle delete single warning
    if (interaction.isStringSelectMenu() && customId === 'warn_delete_single') {
        const warnId = interaction.values[0];

        const activeWarns = warnManager.getActiveWarnings();
        const warnRecord = activeWarns[warnId];

        if (!warnRecord) {
            await interaction.reply({
                content: '❌ **التحذير غير موجود!**',
                ephemeral: true
            });
            return;
        }

        const result = await warnManager.deleteWarning(warnId);

        if (result.success) {
            const warnNumber = Object.keys(activeWarns).indexOf(warnId) + 1;

            await warnManager.sendLogMessage(interaction.guild, client, 'WARN_DELETED', {
                targetUserId: warnRecord.userId,
                warnNumber: warnNumber,
                deletedBy: interaction.user.id
            });

            await interaction.update({
                content: '✅ **تم حذف التحذير بنجاح!**',
                components: [],
                embeds: []
            });
        } else {
            await interaction.reply({
                content: `❌ **فشل في حذف التحذير:** ${result.error}`,
                ephemeral: true
            });
        }
        return;
    }

    // Handle delete all warnings
    if (interaction.isButton() && customId.startsWith('warn_delete_all_')) {
        const userId = customId.replace('warn_delete_all_', '');

        const result = await warnManager.deleteAllUserWarnings(userId, interaction.guild.id);

        if (result.success) {
            await warnManager.sendLogMessage(interaction.guild, client, 'WARN_ALL_DELETED', {
                targetUserId: userId,
                count: result.count,
                deletedBy: interaction.user.id
            });

            await interaction.update({
                content: `✅ **تم حذف جميع التحذيرات (${result.count}) بنجاح!**`,
                components: [],
                embeds: []
            });
        } else {
            await interaction.reply({
                content: `❌ **فشل في حذف التحذيرات:** ${result.error}`,
                ephemeral: true
            });
        }
        return;
    }

    // Handle edit settings
    if (interaction.isStringSelectMenu() && customId === 'warn_edit_setting') {
        const setting = interaction.values[0];
        const settingsPath = path.join(__dirname, '..', 'data', 'warnSettings.json');
        const settings = readJson(settingsPath, {});

        if (setting === 'edit_permissions') {
            const permSelect = new StringSelectMenuBuilder()
                .setCustomId('warn_edit_permission_type')
                .setPlaceholder('اختر نوع المعتمدين...')
                .addOptions([
                    {
                        label: 'المالكين فقط',
                        value: 'owners',
                        description: 'السماح للمالكين فقط'
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

            const permRow = new ActionRowBuilder().addComponents(permSelect);

            await interaction.update({
                content: '👥 **اختر نوع المعتمدين الجديد:**',
                components: [permRow],
                embeds: []
            });
            return;
        }

        if (setting === 'edit_log_channel') {
            const channelSelect = new ChannelSelectMenuBuilder()
                .setCustomId('warn_edit_log_channel_select')
                .setPlaceholder('📍 اختر روم السجلات الجديد...')
                .setChannelTypes([ChannelType.GuildText]);

            const channelRow = new ActionRowBuilder().addComponents(channelSelect);

            await interaction.update({
                content: '📍 **اختر روم السجلات الجديد:**',
                components: [channelRow],
                embeds: []
            });
            return;
        }

        if (setting === 'edit_menu_channel') {
            const channelSelect = new ChannelSelectMenuBuilder()
                .setCustomId('warn_edit_menu_channel_select')
                .setPlaceholder('📍 اختر روم المنيو الجديد...')
                .setChannelTypes([ChannelType.GuildText]);

            const channelRow = new ActionRowBuilder().addComponents(channelSelect);

            await interaction.update({
                content: '📍 **اختر روم المنيو الجديد:**',
                components: [channelRow],
                embeds: []
            });
            return;
        }

        if (setting === 'edit_down_managers') {
            const userSelect = new UserSelectMenuBuilder()
                .setCustomId('warn_update_down_managers')
                .setPlaceholder('اختر مسؤولي الداون...')
                .setMinValues(0)
                .setMaxValues(10);

            const userRow = new ActionRowBuilder().addComponents(userSelect);

            await interaction.update({
                content: '**اختر مسؤولي الداون الجدد:**',
                components: [userRow],
                embeds: []
            });
            return;
        }
    }

    // Handle permission type edit
    if (interaction.isStringSelectMenu() && customId === 'warn_edit_permission_type') {
        const permType = interaction.values[0];
        const settingsPath = path.join(__dirname, '..', 'data', 'warnSettings.json');
        const settings = readJson(settingsPath, {});

        settings.allowedUsers.type = permType;

        if (permType === 'owners') {
            settings.allowedUsers.targets = context.BOT_OWNERS;
            saveJson(settingsPath, settings);

            await interaction.update({
                content: '✅ **تم تغيير المعتمدين إلى "المالكين فقط".**',
                components: []
            });
            return;
        }

        if (permType === 'roles') {
            const roleSelect = new RoleSelectMenuBuilder()
                .setCustomId('warn_edit_select_roles')
                .setPlaceholder(' اختر الرولات المعتمدة...')
                .setMaxValues(10);

            const roleRow = new ActionRowBuilder().addComponents(roleSelect);

            await interaction.update({
                content: '**اختر الرولات المعتمدة:**',
                components: [roleRow]
            });
            return;
        }

        if (permType === 'responsibility') {
            const responsibilitiesPath = path.join(__dirname, '..', 'data', 'responsibilities.json');
            const responsibilities = readJson(responsibilitiesPath, {});

            if (Object.keys(responsibilities).length === 0) {
                await interaction.update({
                    content: '**لا توجد مسؤوليات معرّفة!**',
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
                .setCustomId('warn_edit_select_responsibilities')
                .setPlaceholder(' اختر المسؤوليات المعتمدة...')
                .setMaxValues(Math.min(respOptions.length, 10))
                .addOptions(respOptions);

            const respRow = new ActionRowBuilder().addComponents(respSelect);

            await interaction.update({
                content: ' **اختر المسؤوليات المعتمدة:**',
                components: [respRow]
            });
            return;
        }
    }

    // Handle role selection for edit
    if (interaction.isRoleSelectMenu() && customId === 'warn_edit_select_roles') {
        const settingsPath = path.join(__dirname, '..', 'data', 'warnSettings.json');
        const settings = readJson(settingsPath, {});
        settings.allowedUsers.targets = interaction.values;
        saveJson(settingsPath, settings);

        await interaction.update({
            content: '✅ **تم تحديد الرولات المعتمدة بنجاح.**',
            components: []
        });
        return;
    }

    // Handle responsibility selection for edit
    if (interaction.isStringSelectMenu() && customId === 'warn_edit_select_responsibilities') {
        const settingsPath = path.join(__dirname, '..', 'data', 'warnSettings.json');
        const settings = readJson(settingsPath, {});
        settings.allowedUsers.targets = interaction.values;
        saveJson(settingsPath, settings);

        await interaction.update({
            content: '✅ **تم تحديد المسؤوليات المعتمدة بنجاح.**',
            components: []
        });
        return;
    }

    // Handle log channel edit
    if (interaction.isChannelSelectMenu() && customId === 'warn_edit_log_channel_select') {
        const settingsPath = path.join(__dirname, '..', 'data', 'warnSettings.json');
        const settings = readJson(settingsPath, {});
        settings.logChannel = interaction.values[0];
        saveJson(settingsPath, settings);

        await interaction.update({
            content: '✅ **تم تغيير روم السجلات بنجاح.**',
            components: []
        });
        return;
    }

    // Handle menu channel edit
    if (interaction.isChannelSelectMenu() && customId === 'warn_edit_menu_channel_select') {
        const settingsPath = path.join(__dirname, '..', 'data', 'warnSettings.json');
        const settings = readJson(settingsPath, {});
        settings.menuChannel = interaction.values[0];
        saveJson(settingsPath, settings);

        await createPermanentMenu(client, settings.menuChannel);

        await interaction.update({
            content: '✅ **تم تغيير روم المنيو وإرسال المنيو الجديد.**',
            components: []
        });
        return;
    }

    // Handle down managers update
    if (interaction.isUserSelectMenu() && customId === 'warn_update_down_managers') {
        const settingsPath = path.join(__dirname, '..', 'data', 'warnSettings.json');
        const settings = readJson(settingsPath, {});
        settings.downManagerUsers = interaction.values;
        saveJson(settingsPath, settings);

        await interaction.update({
            content: `✅ **تم تحديث مسؤولي الداون (${interaction.values.length}).**`,
            components: []
        });
        return;
    }
}

module.exports = {
    name,
    execute,
    handleInteraction,
    createPermanentMenu // Export for use in auto-refresh
};
